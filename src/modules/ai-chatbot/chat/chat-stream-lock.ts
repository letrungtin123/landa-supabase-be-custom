// ═══════════════════════════════════════════════════════════════
// AI chat conversation lock across API processes
//
// One answer (or one lesson-author admission) per conversation at a time,
// whichever API process receives the request; the per-process Set in
// chat.service.ts stays the first, local guard.
//
// Plain keyspace commands only, on a key under the backend prefix
// (cacheKey(): `landa-backend:<env>:data:v1:...`). The production Redis ACL
// allows @read/@write/@keyspace on `landa-backend:*` and refuses Lua (EVAL),
// MULTI and every other prefix; the former lock (`landa:ai-chat:stream:*`,
// released with EVAL) was refused there, so it only ever had the local lock.
//
//   acquire  SET key token NX PX ttl
//   renew    every ttl/3 while held: GET, then SET key token XX PX ttl only
//            when GET still returned this token
//   release  GET, then DEL only when it still holds this token
//
// Race windows (no compare-and-set without Lua): if the key expires and
// another process takes it between our GET and our SET XX (renew) or DEL
// (release), we overwrite or delete that new owner's lock. Both need our key
// to expire under us first, i.e. a renewal later than 2/3 of the short TTL
// (a stalled process or an unreachable Redis). That is acceptable here: the
// lock only prevents a duplicate stream for one conversation, it guards no
// data. The short TTL also bounds a lock left by a crashed process.
// ═══════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';
import { cacheKey } from '../../../config/cache.js';
import { getRedisClient, withRedisDeadline } from '../../../config/redis.js';
import { AppError } from '../../../middleware/error-handler.js';

/** Lifetime of a held lock without renewal (a lock of a crashed process is gone after this). */
export const CHAT_STREAM_LOCK_TTL_MS = 60_000;
/** A held lock is renewed this often (three renewals per TTL). */
export const CHAT_STREAM_LOCK_RENEW_INTERVAL_MS = CHAT_STREAM_LOCK_TTL_MS / 3;
const UNAVAILABLE_LOG_INTERVAL_MS = 60_000;

export const GENERATION_LOCK_UNAVAILABLE_CODE = 'GENERATION_LOCK_UNAVAILABLE';
const GENERATION_LOCK_UNAVAILABLE_MESSAGE = 'Dịch vụ khóa tác vụ chưa sẵn sàng.';

/** The plain commands the lock uses (injectable for tests). */
export interface ChatStreamLockRedis {
  set(key: string, value: string, options: { NX?: true; XX?: true; PX: number }): Promise<string | null>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
}

export interface DistributedStreamLock {
  release: () => Promise<void>;
}

export interface ChatStreamLocks {
  /**
   * The conversation's lock; null when another holder has it. Without Redis
   * (not configured, unhealthy, or a command fails) the lock is a no-op and
   * only the per-process lock applies, unless `requireDistributedFence`:
   * then it is an AppError 503 GENERATION_LOCK_UNAVAILABLE.
   */
  acquire(conversationId: string, requireDistributedFence?: boolean): Promise<DistributedStreamLock | null>;
}

export function chatStreamLockKey(conversationId: string): string {
  return cacheKey('ai-chat-stream-lock', conversationId);
}

const NO_OP_LOCK: DistributedStreamLock = { release: async () => {} };

export function createChatStreamLocks(options: {
  getClient?: () => ChatStreamLockRedis | null;
  ttlMs?: number;
  renewIntervalMs?: number;
  /** Bounds every command (defaults to the shared Redis command deadline and breaker). */
  deadline?: <T>(label: string, work: Promise<T>) => Promise<T>;
  log?: (event: Record<string, unknown>) => void;
} = {}): ChatStreamLocks {
  const getClient = options.getClient ?? (() => getRedisClient() as unknown as ChatStreamLockRedis | null);
  const ttlMs = options.ttlMs ?? CHAT_STREAM_LOCK_TTL_MS;
  const renewIntervalMs = options.renewIntervalMs ?? CHAT_STREAM_LOCK_RENEW_INTERVAL_MS;
  const deadline = options.deadline ?? (<T>(label: string, work: Promise<T>) => withRedisDeadline(label, work));
  const log = options.log ?? ((event) => console.warn('[ChatStreamLock] ' + JSON.stringify(event)));
  let lastUnavailableLogAt = 0;

  function unavailable(requireDistributedFence: boolean, reason: string): DistributedStreamLock {
    const now = Date.now();
    if (now - lastUnavailableLogAt >= UNAVAILABLE_LOG_INTERVAL_MS) {
      lastUnavailableLogAt = now;
      log({ event: 'chat_stream_lock_unavailable', reason, fence_required: requireDistributedFence });
    }
    if (requireDistributedFence) {
      throw new AppError(GENERATION_LOCK_UNAVAILABLE_MESSAGE, 503, GENERATION_LOCK_UNAVAILABLE_CODE);
    }
    // Redis must never turn an otherwise healthy chat request into an outage.
    return NO_OP_LOCK;
  }

  function heldLock(client: ChatStreamLockRedis, key: string, token: string, conversationId: string): DistributedStreamLock {
    let released = false;
    let renewing = false;
    const timer = setInterval(() => {
      if (released || renewing) return;
      renewing = true;
      void renew().finally(() => { renewing = false; });
    }, renewIntervalMs);
    timer.unref();

    async function renew(): Promise<void> {
      try {
        const holder = await deadline('chat stream lock check', client.get(key));
        if (released) return;
        const renewed = holder === token
          ? await deadline('chat stream lock renew', client.set(key, token, { XX: true, PX: ttlMs }))
          : null;
        if (renewed !== 'OK' && !released) {
          released = true;
          clearInterval(timer);
          log({ event: 'chat_stream_lock_lost', conversation_id: conversationId });
        }
      } catch {
        // Redis unreachable: the next interval tries again; the TTL bounds the lock.
      }
    }

    return {
      release: async () => {
        if (released) return;
        released = true;
        clearInterval(timer);
        try {
          const holder = await deadline('chat stream lock check', client.get(key));
          if (holder === token) await deadline('chat stream lock release', client.del(key));
        } catch {
          // A TTL bounds stale locks if Redis cannot be reached during cleanup.
        }
      },
    };
  }

  return {
    async acquire(conversationId, requireDistributedFence = false) {
      const client = getClient();
      if (!client) return unavailable(requireDistributedFence, 'redis_unavailable');
      const key = chatStreamLockKey(conversationId);
      const token = randomUUID();
      try {
        const acquired = await deadline('chat stream lock acquire', client.set(key, token, { NX: true, PX: ttlMs }));
        if (acquired !== 'OK') return null;
      } catch (error) {
        return unavailable(requireDistributedFence, error instanceof Error ? error.message.slice(0, 120) : 'error');
      }
      return heldLock(client, key, token, conversationId);
    },
  };
}

/** The process's conversation locks on the shared backend Redis client. */
export const chatStreamLocks = createChatStreamLocks();
