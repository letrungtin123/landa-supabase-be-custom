// ═══════════════════════════════════════════════════════════════
// Refresh handoffs: a committed rotation whose answer never left the server
//
// refresh() commits the rotation (old token revoked, successor inserted)
// before it reads the session context. When that read still fails after its
// retries, the client keeps the old token and never received the successor;
// it retries (5xx is transient for both frontends) within the reuse grace
// period. The handoff records "the successor of this old token was never
// delivered" for that period, so the retry rotates the successor instead of
// being refused as a reused token. It holds only token hashes (the DB's
// token_hash values, hashed again for the key): no usable token is stored.
// The database stays the source of truth: the retry re-checks the grace
// period and the successor's row under the row locks.
//
// With several API processes the handoff lives in Redis; the DEL that removes
// it decides which retry uses it. Without Redis (not configured, failing or
// slow) it is kept by this process only, and a retry that reaches another
// process is refused as a reused token (the behavior without handoffs).
// With one API process it is kept in memory.
// ═══════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';
import { cacheKey } from '../../config/cache.js';
import { getRedisClient, withRedisDeadline } from '../../config/redis.js';

/** The Redis commands the store uses (injectable for tests). */
export interface RefreshHandoffRedisClient {
  set(key: string, value: string, options: { PX: number }): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
}

export interface RefreshHandoffStore {
  /** Records that `successorHash` (the rotation of `tokenHash`) was never delivered. */
  offer(tokenHash: string, successorHash: string): Promise<void>;
  /** Removes and returns the undelivered successor of `tokenHash`, or null. */
  take(tokenHash: string): Promise<string | null>;
}

export interface RefreshHandoffStoreOptions {
  /** How long a handoff lives: the reuse grace period of refresh(). */
  ttlMs: number;
  /** Several API processes: keep handoffs in Redis. */
  shared: boolean;
  getClient?: () => RefreshHandoffRedisClient | null;
  deadline?: <T>(label: string, work: Promise<T>) => Promise<T>;
  now?: () => number;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

function handoffKey(tokenHash: string): string {
  return cacheKey('auth-refresh-handoff', createHash('sha256').update(`refresh-handoff:${tokenHash}`).digest('hex'));
}

export function createRefreshHandoffStore(options: RefreshHandoffStoreOptions): RefreshHandoffStore {
  const getClient = options.getClient ?? (() => getRedisClient() as unknown as RefreshHandoffRedisClient | null);
  const deadline = options.deadline ?? (<T>(label: string, work: Promise<T>) => withRedisDeadline(label, work));
  const now = options.now ?? (() => Date.now());
  const local = new Map<string, { successorHash: string; expiresAt: number }>();

  function sweepLocal(at: number): void {
    for (const [tokenHash, entry] of local) {
      if (at >= entry.expiresAt) local.delete(tokenHash);
    }
  }

  return {
    async offer(tokenHash, successorHash) {
      const client = options.shared ? getClient() : null;
      if (client) {
        try {
          await deadline('refresh handoff write', client.set(handoffKey(tokenHash), successorHash, { PX: options.ttlMs }));
          return;
        } catch {
          // Kept by this process instead (the Redis breaker is open now).
        }
      }
      const at = now();
      sweepLocal(at);
      local.set(tokenHash, { successorHash, expiresAt: at + options.ttlMs });
    },
    async take(tokenHash) {
      const client = options.shared ? getClient() : null;
      if (client) {
        try {
          const key = handoffKey(tokenHash);
          const raw = await deadline('refresh handoff read', client.get(key));
          if (raw !== null) {
            // Only the retry whose DEL removed the key may use the handoff.
            const removed = await deadline('refresh handoff use', client.del(key));
            return removed === 1 && SHA256_HEX.test(raw) ? raw : null;
          }
        } catch {
          // Only a handoff kept by this process can be found now.
        }
      }
      const at = now();
      sweepLocal(at);
      const entry = local.get(tokenHash);
      if (!entry) return null;
      local.delete(tokenHash);
      return entry.successorHash;
    },
  };
}
