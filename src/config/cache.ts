import { createHash } from 'crypto';
import { env } from './env.js';
import { getRedisClient, isRedisConfigured, withRedisDeadline } from './redis.js';
import { clusterBus } from './cluster-bus.js';

const CACHE_SCHEMA_VERSION = 'v1';
const DEFAULT_JITTER_RATIO = 0.1;

type CacheHit<T> = { hit: true; value: T } | { hit: false; value?: undefined };

// Coalesce concurrent misses in one Node process to protect the database from request bursts.
const inFlightCacheLoads = new Map<string, Promise<unknown>>();

// Cache invalidations (version bumps) that could not reach Redis. A cached
// value may predate the write that wanted to invalidate it, so this process
// reads no cached value until every one of them has been replayed. Past the
// limit they are dropped and reads stay off for the longest cache lifetime
// this process wrote instead, after which every older value has expired.
const PENDING_INVALIDATION_LIMIT = 10_000;
const pendingInvalidations = new Map<string, { segments: readonly unknown[] }>();
let invalidationsDropped = false;
let readsPausedUntil = 0;
let longestTtlSeconds = 0;
let replayInFlight: Promise<void> | null = null;

function normalizeForHash(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeForHash);
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        const item = (value as Record<string, unknown>)[key];
        if (item !== undefined) acc[key] = normalizeForHash(item);
        return acc;
      }, {});
  }
  return value;
}

export function stableHash(value: unknown): string {
  const normalized = JSON.stringify(normalizeForHash(value));
  return createHash('sha1').update(normalized).digest('hex').slice(0, 20);
}

export function cacheSegment(value: unknown): string {
  const raw = String(value ?? 'null').trim() || 'empty';
  const encoded = encodeURIComponent(raw);
  return encoded.length <= 120 ? encoded : `h_${stableHash(raw)}`;
}

function cachePrefix(kind: 'data' | 'ver'): string {
  return ['landa-backend', cacheSegment(env.NODE_ENV), kind, CACHE_SCHEMA_VERSION].join(':');
}

export function cacheKey(...segments: readonly unknown[]): string {
  return [cachePrefix('data'), ...segments.map(cacheSegment)].join(':');
}

export function cacheVersionKey(...segments: readonly unknown[]): string {
  return [cachePrefix('ver'), ...segments.map(cacheSegment)].join(':');
}

function ttlWithJitter(ttlSeconds: number): number {
  const base = Math.max(1, Math.floor(ttlSeconds));
  const spread = Math.max(1, Math.floor(base * DEFAULT_JITTER_RATIO));
  return base + Math.floor(Math.random() * spread);
}

// ── Several processes ──
// A bump that missed Redis here (this process's breaker is open, e.g. after
// an event-loop stall) is relayed to the other processes, which bump the same
// version key; otherwise they would keep serving the old cached value. A
// process that cannot bump either remembers it and pauses its own cached
// reads, as above. Relays are batched so an outage sends few messages.
const RELAY_EVENT = 'cache.bump';
const RELAY_FLUSH_MS = 200;
const RELAY_MESSAGE_MAX_CHARS = 6_000;
const RELAY_RECEIVE_MAX_ENTRIES = 1_000;
let relayQueue: (readonly unknown[])[] = [];
let relayTimer: NodeJS.Timeout | null = null;

function flushInvalidationRelay(): void {
  relayTimer = null;
  const batch = relayQueue;
  relayQueue = [];
  let chunk: (readonly unknown[])[] = [];
  let chars = 0;
  for (const segments of batch) {
    const size = JSON.stringify(segments).length + 1;
    if (chunk.length > 0 && chars + size > RELAY_MESSAGE_MAX_CHARS) {
      void clusterBus.publish(RELAY_EVENT, { segments: chunk }, { immediate: true });
      chunk = [];
      chars = 0;
    }
    chunk.push(segments);
    chars += size;
  }
  if (chunk.length > 0) void clusterBus.publish(RELAY_EVENT, { segments: chunk }, { immediate: true });
}

function relayInvalidation(segments: readonly unknown[]): void {
  if (!clusterBus.enabled || !isRedisConfigured()) return;
  relayQueue.push(segments);
  if (relayTimer) return;
  relayTimer = setTimeout(flushInvalidationRelay, RELAY_FLUSH_MS);
  relayTimer.unref();
}

clusterBus.on(RELAY_EVENT, async (payload) => {
  if (!Array.isArray(payload.segments)) return;
  const list = (payload.segments as unknown[]).filter((segments): segments is unknown[] => Array.isArray(segments));
  await Promise.all(list.slice(0, RELAY_RECEIVE_MAX_ENTRIES).map((segments) => bumpVersion(segments, false)));
});

function rememberPendingInvalidation(segments: readonly unknown[]): void {
  if (!isRedisConfigured() || invalidationsDropped) return;
  const key = cacheVersionKey(...segments);
  if (!pendingInvalidations.has(key) && pendingInvalidations.size >= PENDING_INVALIDATION_LIMIT) {
    pendingInvalidations.clear();
    invalidationsDropped = true;
    console.warn('[Cache] Too many invalidations missed Redis; cached reads stay off for the longest cache lifetime once Redis is back.');
    return;
  }
  // A new object per failure: a replay only removes the entry it replayed.
  pendingInvalidations.set(key, { segments });
}

const REPLAY_BATCH_SIZE = 50;
const REPLAY_MIN_INTERVAL_MS = 1_000;
let lastReplayAt = 0;

/**
 * Whether cached values may be read: no invalidation is waiting to be
 * replayed and no read pause is running. Starts the replay when needed.
 */
function cachedReadsAllowed(client: NonNullable<ReturnType<typeof getRedisClient>>): boolean {
  if (invalidationsDropped) {
    invalidationsDropped = false;
    readsPausedUntil = Date.now() + longestTtlSeconds * 1000;
  }
  if (pendingInvalidations.size === 0) return Date.now() >= readsPausedUntil;
  const now = Date.now();
  // A clock that moved backwards (NTP) never blocks the replay.
  if (!replayInFlight && (now < lastReplayAt || now - lastReplayAt >= REPLAY_MIN_INTERVAL_MS)) {
    lastReplayAt = now;
    replayInFlight = (async () => {
      const entries = [...pendingInvalidations];
      for (let index = 0; index < entries.length; index += REPLAY_BATCH_SIZE) {
        await Promise.all(entries.slice(index, index + REPLAY_BATCH_SIZE).map(async ([key, entry]) => {
          await withRedisDeadline('cache invalidation replay', client.incr(key));
          if (pendingInvalidations.get(key) === entry) pendingInvalidations.delete(key);
        }));
      }
    })().catch(() => undefined).finally(() => { replayInFlight = null; });
  }
  return false;
}

/** Number of invalidations waiting for Redis (diagnostics and tests). */
export function pendingCacheInvalidationCount(): number {
  return pendingInvalidations.size;
}

export async function getCacheJson<T>(key: string): Promise<CacheHit<T>> {
  const client = getRedisClient();
  if (!client || !cachedReadsAllowed(client)) return { hit: false };

  let raw: string | null;
  try {
    raw = await withRedisDeadline('cache read', client.get(key));
  } catch {
    // A failed or slow read opened the Redis breaker; the database answers.
    return { hit: false };
  }
  if (!raw) return { hit: false };
  try {
    const parsed = JSON.parse(raw) as { value: T };
    return { hit: true, value: parsed.value };
  } catch {
    return { hit: false };
  }
}

export async function setCacheJson<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
  const client = getRedisClient();
  if (!client) return;

  const ttl = ttlWithJitter(ttlSeconds);
  longestTtlSeconds = Math.max(longestTtlSeconds, ttl);
  try {
    await withRedisDeadline('cache write', client.set(key, JSON.stringify({ value }), { EX: ttl }));
  } catch {
    // Redis is an optimization layer; DB remains the source of truth.
  }
}

export async function cacheJson<T>(
  key: string,
  ttlSeconds: number,
  loader: () => Promise<T>,
): Promise<T> {
  const cached = await getCacheJson<T>(key);
  if (cached.hit) return cached.value;

  const inFlight = inFlightCacheLoads.get(key) as Promise<T> | undefined;
  if (inFlight) return inFlight;

  const load = (async () => {
    const value = await loader();
    await setCacheJson(key, value, ttlSeconds);
    return value;
  })();
  inFlightCacheLoads.set(key, load);

  try {
    return await load;
  } finally {
    inFlightCacheLoads.delete(key);
  }
}

export async function getCacheVersion(...segments: readonly unknown[]): Promise<string> {
  const client = getRedisClient();
  if (!client) return '0';

  try {
    const version = await withRedisDeadline('cache version read', client.get(cacheVersionKey(...segments)));
    return version || '0';
  } catch {
    // The breaker is now open, so no cached value is read with this version.
    return '0';
  }
}

export async function bumpCacheVersion(...segments: readonly unknown[]): Promise<void> {
  await bumpVersion(segments, true);
}

/** `relay`: tell the other processes when the bump missed Redis (never for a relayed bump). */
async function bumpVersion(segments: readonly unknown[], relay: boolean): Promise<void> {
  const client = getRedisClient();
  if (!client) {
    rememberPendingInvalidation(segments);
    if (relay) relayInvalidation(segments);
    return;
  }

  try {
    await withRedisDeadline('cache invalidation', client.incr(cacheVersionKey(...segments)));
  } catch {
    // Replayed once Redis answers again (a replayed bump is only an extra miss).
    rememberPendingInvalidation(segments);
    if (relay) relayInvalidation(segments);
  }
}

export async function bumpCacheVersions(namespaces: readonly (readonly unknown[])[]): Promise<void> {
  const seen = new Set<string>();
  const unique = namespaces.filter((segments) => {
    const key = JSON.stringify(segments);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  await Promise.all(unique.map((segments) => bumpCacheVersion(...segments)));
}
