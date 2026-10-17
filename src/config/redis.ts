// ═══════════════════════════════════════════════════════════════
// Redis — cache, access-revocation fast path, shared rate-limit counters
//
// Redis is an accelerator; the database stays the source of truth. One error
// never disables Redis for the life of the process:
// - the client reconnects forever, with jittered exponential backoff;
// - a failing or slow command opens a time-boxed breaker: while it is open
//   getRedisClient() returns null and every caller uses its database fallback;
// - commands run through withRedisDeadline() never wait longer than the
//   command deadline, so a hung Redis cannot stall requests.
// A reply error (e.g. NOPERM from the ACL) proves Redis is up: it fails that
// command only and does not open the breaker.
// ═══════════════════════════════════════════════════════════════

import { createClient, ErrorReply, type RedisClientType } from '@redis/client';
import { env } from './env.js';

export const REDIS_RECONNECT_BASE_MS = 100;
export const REDIS_RECONNECT_MAX_MS = 10_000;
export const REDIS_BREAKER_OPEN_MS = 30_000;
export const REDIS_COMMAND_TIMEOUT_MS = 300;
/** How long startup waits for the first connection before continuing on the database fallback. */
const REDIS_STARTUP_WAIT_MS = 10_000;
const REDIS_CLOSE_WAIT_MS = 2_000;
const ERROR_LOG_INTERVAL_MS = 30_000;

export class RedisDeadlineError extends Error {
  constructor(label: string, deadlineMs: number) {
    super(`${label} took longer than ${deadlineMs} ms`);
    this.name = 'RedisDeadlineError';
  }
}

/** Delay before reconnect attempt `retries`: exponential, capped, with "equal jitter" (half fixed, half random). */
export function redisReconnectDelayMs(retries: number, random: () => number = Math.random): number {
  const ceiling = Math.min(REDIS_RECONNECT_MAX_MS, REDIS_RECONNECT_BASE_MS * 2 ** Math.min(Math.max(0, retries), 16));
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

/** Whether a command failure says something about Redis health (not a reply error from a healthy server). */
export function isRedisHealthFailure(error: unknown): boolean {
  return !(error instanceof ErrorReply);
}

export interface RedisBreaker {
  /** True while callers must use their database fallback. */
  isOpen(): boolean;
  /** Opens (or extends) the breaker; logs once per unhealthy period. */
  trip(reason: string): void;
  reset(): void;
}

export function createRedisBreaker(options: {
  openMs?: number;
  now?: () => number;
  log?: (message: string) => void;
} = {}): RedisBreaker {
  const openMs = options.openMs ?? REDIS_BREAKER_OPEN_MS;
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? ((message) => console.warn(message));
  let openUntil = 0;
  return {
    isOpen: () => now() < openUntil,
    trip(reason) {
      const wasOpen = now() < openUntil;
      openUntil = now() + openMs;
      if (!wasOpen) log(`[Redis] Unhealthy; database fallback for at least ${Math.round(openMs / 1000)} s. Reason: ${reason}`);
    },
    reset() { openUntil = 0; },
  };
}

const breaker = createRedisBreaker();
let redisClient: RedisClientType | null = null;
let lastErrorLogAt = 0;
// Changes whenever a connection becomes ready: Redis may have restarted and
// lost keys, so copies that must be complete (access revocations) are redone.
let connectionEpoch = 0;

/** Increases on every new ready connection (and client install). */
export function redisConnectionEpoch(): number {
  return connectionEpoch;
}

function maskRedisUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    return '<invalid redis url>';
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Whether this deployment uses Redis at all (REDIS_URL is set). */
export function isRedisConfigured(): boolean {
  return Boolean(env.REDIS_URL);
}

/**
 * Runs one Redis command within the command deadline. A timeout or a
 * connection failure opens the breaker and rejects; the caller falls back.
 */
export function withRedisDeadline<T>(
  label: string,
  work: Promise<T>,
  deadlineMs: number = REDIS_COMMAND_TIMEOUT_MS,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new RedisDeadlineError(label, deadlineMs)), deadlineMs);
  });
  // The losing command may still settle later; it must never become an unhandled rejection.
  work.catch(() => undefined);
  return Promise.race([work, deadline])
    .catch((error: unknown) => {
      if (isRedisHealthFailure(error)) breaker.trip(`${label}: ${errorText(error)}`);
      throw error;
    })
    .finally(() => clearTimeout(timer));
}

/** Opens the breaker after a failure seen outside withRedisDeadline(). */
export function markRedisUnhealthy(reason: string): void {
  breaker.trip(reason);
}

/** The connected client, or null while Redis is not configured, not ready or the breaker is open. */
export function getRedisClient(): RedisClientType | null {
  if (!redisClient || !redisClient.isOpen || !redisClient.isReady) return null;
  if (breaker.isOpen()) return null;
  return redisClient;
}

/**
 * Makes `client` the process client and starts with a closed breaker. Used
 * by connectRedis(); tests install a fake client the same way.
 */
export function installRedisClient(client: RedisClientType | null): void {
  redisClient = client;
  connectionEpoch += 1;
  breaker.reset();
}

export async function connectRedis(): Promise<void> {
  if (!env.REDIS_URL) {
    console.log('[Redis] Disabled: REDIS_URL is not configured');
    return;
  }
  if (redisClient) return;

  const client = createClient({
    url: env.REDIS_URL,
    database: env.REDIS_DATABASE,
    // Fail fast while disconnected instead of queueing commands behind a reconnect.
    disableOfflineQueue: true,
    socket: {
      connectTimeout: env.REDIS_CONNECT_TIMEOUT_MS,
      // Never give up: a long outage ends with Redis in use again, not with a
      // process that silently stays on the database fallback until restart.
      reconnectStrategy: (retries) => redisReconnectDelayMs(retries),
    },
  }) as RedisClientType;

  client.on('error', (err) => {
    breaker.trip(`connection error: ${errorText(err)}`);
    const now = Date.now();
    if (now - lastErrorLogAt < ERROR_LOG_INTERVAL_MS) return;
    lastErrorLogAt = now;
    console.warn('[Redis] Runtime error:', errorText(err));
  });
  client.on('reconnecting', () => breaker.trip('reconnecting'));
  client.on('ready', () => {
    if (redisClient !== client) return;
    connectionEpoch += 1;
    console.log('[Redis] Ready (callers return to Redis once the breaker closes)');
  });

  installRedisClient(client);
  const connected = client.connect().then(() => withRedisDeadline('startup ping', client.ping(), REDIS_STARTUP_WAIT_MS));
  try {
    await withRedisDeadline('startup connect', connected, REDIS_STARTUP_WAIT_MS);
    breaker.reset();
    console.log(`[Redis] Connected: ${maskRedisUrl(env.REDIS_URL)} database=${env.REDIS_DATABASE}`);
  } catch (err) {
    // The client keeps reconnecting in the background; until then every
    // caller uses the database fallback.
    console.warn('[Redis] Not reachable at startup; using the database fallback and reconnecting in the background:', errorText(err));
  }
}

export async function closeRedis(): Promise<void> {
  if (!redisClient) return;
  const client = redisClient;
  redisClient = null;
  if (!client.isOpen) return;
  try {
    await withRedisDeadline('quit', client.quit(), REDIS_CLOSE_WAIT_MS);
  } catch {
    client.destroy();
  }
}
