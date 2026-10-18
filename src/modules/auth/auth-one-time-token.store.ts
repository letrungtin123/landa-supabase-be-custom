// ═══════════════════════════════════════════════════════════════
// One-time sign-in tokens (cross-app SSO, demo login)
//
// A token is issued by one request and used by the next one, which may reach
// another API process. With several API processes the token lives in Redis
// (key = hash of the token, so the token itself is never a Redis key); the
// DEL that removes it decides who used it, so it works once even when two
// processes read it at the same time. Without Redis (not configured, failing
// or slow) a token issued then is kept by the issuing process only.
// With one API process it is kept in memory, as before.
// ═══════════════════════════════════════════════════════════════

import { createHash, randomUUID } from 'node:crypto';
import { cacheKey } from '../../config/cache.js';
import { getRedisClient, withRedisDeadline } from '../../config/redis.js';

export interface OneTimeTokenEntry {
  userId: string;
  expiresAt: number;
}

/** The Redis commands the store uses (injectable for tests). */
export interface OneTimeTokenRedisClient {
  set(key: string, value: string, options: { PX: number }): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
}

export interface OneTimeTokenStore {
  issue(userId: string): Promise<string>;
  /** Removes and returns the token's entry (one use), or null when it is unknown. The caller checks expiresAt. */
  take(token: string): Promise<OneTimeTokenEntry | null>;
  /** Forgets expired in-memory entries. */
  sweep(): void;
}

export interface OneTimeTokenStoreOptions {
  ttlMs: number;
  /** Several API processes: keep tokens in Redis. */
  shared: boolean;
  /** How long Redis keeps a used-up token's key after it expired (so "expired" is told apart from "unknown"). */
  expiredGraceMs?: number;
  getClient?: () => OneTimeTokenRedisClient | null;
  deadline?: <T>(label: string, work: Promise<T>) => Promise<T>;
  now?: () => number;
  newToken?: () => string;
}

function tokenKey(token: string): string {
  return cacheKey('auth-one-time-token', createHash('sha256').update(token).digest('hex'));
}

function parseEntry(raw: string): OneTimeTokenEntry | null {
  try {
    const value = JSON.parse(raw) as Partial<OneTimeTokenEntry>;
    return typeof value.userId === 'string' && typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt)
      ? { userId: value.userId, expiresAt: value.expiresAt }
      : null;
  } catch {
    return null;
  }
}

export function createOneTimeTokenStore(options: OneTimeTokenStoreOptions): OneTimeTokenStore {
  const getClient = options.getClient ?? (() => getRedisClient() as unknown as OneTimeTokenRedisClient | null);
  const deadline = options.deadline ?? (<T>(label: string, work: Promise<T>) => withRedisDeadline(label, work));
  const now = options.now ?? (() => Date.now());
  const newToken = options.newToken ?? (() => randomUUID());
  const expiredGraceMs = options.expiredGraceMs ?? 60_000;
  const local = new Map<string, OneTimeTokenEntry>();

  return {
    async issue(userId) {
      const token = newToken();
      const entry = { userId, expiresAt: now() + options.ttlMs };
      const client = options.shared ? getClient() : null;
      if (client) {
        try {
          await deadline('one-time token write', client.set(tokenKey(token), JSON.stringify(entry), { PX: options.ttlMs + expiredGraceMs }));
          return token;
        } catch {
          // Kept by this process instead (the Redis breaker is open now).
        }
      }
      local.set(token, entry);
      return token;
    },
    async take(token) {
      const client = options.shared ? getClient() : null;
      if (client) {
        try {
          const key = tokenKey(token);
          const raw = await deadline('one-time token read', client.get(key));
          if (raw !== null) {
            // Only the request whose DEL removed the key may use the token.
            const removed = await deadline('one-time token use', client.del(key));
            return removed === 1 ? parseEntry(raw) : null;
          }
        } catch {
          // Only a token issued by this process can be checked now.
        }
      }
      const entry = local.get(token);
      if (!entry) return null;
      local.delete(token);
      return entry;
    },
    sweep() {
      const at = now();
      for (const [token, entry] of local) {
        if (at > entry.expiresAt) local.delete(token);
      }
    },
  };
}
