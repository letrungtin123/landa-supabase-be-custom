import { createHash } from 'crypto';
import { env } from './env.js';
import { disableRedisForProcess, getRedisClient } from './redis.js';

const CACHE_SCHEMA_VERSION = 'v1';
const DEFAULT_JITTER_RATIO = 0.1;

type CacheHit<T> = { hit: true; value: T } | { hit: false; value?: undefined };

// Coalesce concurrent misses in one Node process to protect the database from request bursts.
const inFlightCacheLoads = new Map<string, Promise<unknown>>();

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

export async function getCacheJson<T>(key: string): Promise<CacheHit<T>> {
  const client = getRedisClient();
  if (!client) return { hit: false };

  try {
    const raw = await client.get(key);
    if (!raw) return { hit: false };
    const parsed = JSON.parse(raw) as { value: T };
    return { hit: true, value: parsed.value };
  } catch (err) {
    disableRedisForProcess(err instanceof Error ? `cache read failed: ${err.message}` : 'cache read failed');
    return { hit: false };
  }
}

export async function setCacheJson<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
  const client = getRedisClient();
  if (!client) return;

  try {
    await client.set(key, JSON.stringify({ value }), { EX: ttlWithJitter(ttlSeconds) });
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
    const version = await client.get(cacheVersionKey(...segments));
    return version || '0';
  } catch (err) {
    disableRedisForProcess(err instanceof Error ? `cache version read failed: ${err.message}` : 'cache version read failed');
    return '0';
  }
}

export async function bumpCacheVersion(...segments: readonly unknown[]): Promise<void> {
  const client = getRedisClient();
  if (!client) return;

  try {
    await client.incr(cacheVersionKey(...segments));
  } catch (err) {
    disableRedisForProcess(err instanceof Error ? `cache invalidation failed: ${err.message}` : 'cache invalidation failed');
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
