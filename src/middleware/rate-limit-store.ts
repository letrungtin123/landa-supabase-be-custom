// ═══════════════════════════════════════════════════════════════
// Shared rate-limit store — Redis counters with an in-memory fallback
//
// Counters live in Redis so every API process shares one budget. When Redis
// is not configured, not ready, failing or slower than the deadline, the call
// falls back to a per-process MemoryStore: the limit then applies per process,
// which is still a limit (never an outage and never "no limit").
//
// Only plain keyspace commands are used (INCR, PEXPIRE, PTTL, DECR, DEL): the
// production Redis ACL allows `~landa-backend:*` keys with @read/@write/
// @keyspace and does not allow MULTI or Lua scripts.
// ═══════════════════════════════════════════════════════════════

import { MemoryStore, type ClientRateLimitInfo, type Options, type Store } from 'express-rate-limit';
import { cacheKey } from '../config/cache.js';
import { getRedisClient } from '../config/redis.js';

const REDIS_DEADLINE_MS = 500;
const FALLBACK_LOG_INTERVAL_MS = 60_000;

/** The subset of the Redis client this store needs (injectable for tests). */
export interface RateLimitCounterClient {
  incr(key: string): Promise<number>;
  pExpire(key: string, milliseconds: number): Promise<unknown>;
  pTTL(key: string): Promise<number>;
  decr(key: string): Promise<number>;
  del(key: string): Promise<unknown>;
}

export interface SharedRateLimitStoreOptions {
  /** Namespace of this limiter; part of every Redis key. */
  prefix: string;
  /** Defaults to the shared backend Redis client. */
  getClient?: () => RateLimitCounterClient | null;
  deadlineMs?: number;
  log?: (event: Record<string, unknown>) => void;
}

function withDeadline<T>(work: Promise<T>, deadlineMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('rate_limit_store_timeout')), deadlineMs);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

export class SharedRateLimitStore implements Store {
  readonly prefix: string;
  readonly localKeys = false;
  private windowMs = 60_000;
  private readonly memory = new MemoryStore();
  private readonly getClient: () => RateLimitCounterClient | null;
  private readonly deadlineMs: number;
  private readonly log: (event: Record<string, unknown>) => void;
  private lastFallbackLogAt = 0;

  constructor(options: SharedRateLimitStoreOptions) {
    this.prefix = options.prefix;
    this.getClient = options.getClient
      ?? (() => getRedisClient() as unknown as RateLimitCounterClient | null);
    this.deadlineMs = options.deadlineMs ?? REDIS_DEADLINE_MS;
    this.log = options.log ?? ((event) => console.warn('[RateLimit] ' + JSON.stringify(event)));
  }

  init(options: Options): void {
    this.windowMs = options.windowMs;
    this.memory.init(options);
  }

  private redisKey(key: string): string {
    return cacheKey('rate-limit', this.prefix, key);
  }

  private reportFallback(reason: string): void {
    const now = Date.now();
    if (now - this.lastFallbackLogAt < FALLBACK_LOG_INTERVAL_MS) return;
    this.lastFallbackLogAt = now;
    this.log({ event: 'rate_limit_store_fallback', limiter: this.prefix, reason });
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const client = this.getClient();
    if (client) {
      try {
        return await withDeadline(this.incrementInRedis(client, this.redisKey(key)), this.deadlineMs);
      } catch (error) {
        this.reportFallback(error instanceof Error ? error.message : 'error');
      }
    }
    return this.memory.increment(key);
  }

  private async incrementInRedis(client: RateLimitCounterClient, redisKey: string): Promise<ClientRateLimitInfo> {
    const totalHits = await client.incr(redisKey);
    let ttl = totalHits === 1 ? -1 : await client.pTTL(redisKey);
    // A counter without expiry (first hit, or a crash between INCR and
    // PEXPIRE) gets the window now so it can never block forever.
    if (ttl < 0) {
      await client.pExpire(redisKey, this.windowMs);
      ttl = this.windowMs;
    }
    return { totalHits, resetTime: new Date(Date.now() + ttl) };
  }

  async decrement(key: string): Promise<void> {
    const client = this.getClient();
    if (client) {
      try {
        await withDeadline((async () => {
          const redisKey = this.redisKey(key);
          // DECR on an expired key would create a counter without expiry.
          if (await client.decr(redisKey) <= 0) await client.del(redisKey);
        })(), this.deadlineMs);
        return;
      } catch (error) {
        this.reportFallback(error instanceof Error ? error.message : 'error');
      }
    }
    this.memory.decrement(key);
  }

  async resetKey(key: string): Promise<void> {
    const client = this.getClient();
    if (client) {
      try {
        await withDeadline(client.del(this.redisKey(key)), this.deadlineMs);
      } catch (error) {
        this.reportFallback(error instanceof Error ? error.message : 'error');
      }
    }
    this.memory.resetKey(key);
  }

  shutdown(): void {
    this.memory.shutdown();
  }
}
