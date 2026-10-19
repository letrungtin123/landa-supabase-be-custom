// ═══════════════════════════════════════════════════════════════
// Chat "1 message per RATE_LIMIT_MS (3 s) per user" across API processes
//
// A turn is checked when it starts and marked once it is accepted, as
// before: a refused turn does not use up the user's window. With one API
// process the marks stay in this process's Map. With several (the in-app
// cluster's workers, or PM2 instances) each mark is also kept in Redis, so a
// message accepted by one worker holds back the next one on another:
//
//   mark   SET <backend prefix>:ai-chat-rate-limit:<userId> 1 NX PX <window>
//   check  EXISTS <same key> (after the local Map)
//
// One plain command each, under the backend key prefix: the production
// Redis ACL allows @read/@write/@keyspace on `landa-backend:*` only, and no
// MULTI or Lua. Without Redis (not configured, breaker open, a command
// failing or slower than the Redis deadline) the local Map decides, as with
// one process. Two turns of one user checked at the same moment on two
// workers can both pass, as two turns could in one process before (the mark
// follows the check).
// ═══════════════════════════════════════════════════════════════

import { cacheKey } from '../../../config/cache.js';
import { getRedisClient, withRedisDeadline } from '../../../config/redis.js';
import { AppError } from '../../../middleware/error-handler.js';

const TOO_FAST_MESSAGE = 'Bạn gửi tin nhắn quá nhanh. Vui lòng đợi vài giây.';

/** The Redis commands the limiter uses (injectable for tests). */
export interface ChatRateLimitRedis {
  set(key: string, value: string, options: { NX: true; PX: number }): Promise<string | null>;
  exists(key: string): Promise<number>;
}

export interface ChatRateLimiter {
  /** Rejects with the 429 "too fast" AppError when the user's last accepted message is within the window. */
  check(userId: string): Promise<void>;
  /** Records an accepted message: in the local Map at once, then in Redis when shared. Never rejects. */
  mark(userId: string): Promise<void>;
}

export interface ChatRateLimiterOptions {
  windowMs: number;
  /** Several API processes: keep the marks in Redis too. */
  shared: boolean;
  /** This process's marks (user id -> time of the last accepted message). */
  local: Map<string, number>;
  getClient?: () => ChatRateLimitRedis | null;
  deadline?: <T>(label: string, work: Promise<T>) => Promise<T>;
  now?: () => number;
}

export function chatRateLimitKey(userId: string): string {
  return cacheKey('ai-chat-rate-limit', userId);
}

export function createChatRateLimiter(options: ChatRateLimiterOptions): ChatRateLimiter {
  const getClient = options.getClient ?? (() => getRedisClient() as unknown as ChatRateLimitRedis | null);
  const deadline = options.deadline ?? (<T>(label: string, work: Promise<T>) => withRedisDeadline(label, work));
  const now = options.now ?? (() => Date.now());
  const { local, windowMs } = options;
  const tooFast = () => new AppError(TOO_FAST_MESSAGE, 429);

  return {
    async check(userId) {
      const lastSent = local.get(userId);
      if (lastSent && now() - lastSent < windowMs) throw tooFast();
      const client = options.shared ? getClient() : null;
      if (!client) return;
      let markedElsewhere: boolean;
      try {
        markedElsewhere = (await deadline('chat rate limit check', client.exists(chatRateLimitKey(userId)))) > 0;
      } catch {
        return; // Redis unavailable: the local Map decided (the Redis breaker records the failure)
      }
      if (markedElsewhere) throw tooFast();
    },
    async mark(userId) {
      local.set(userId, now());
      const client = options.shared ? getClient() : null;
      if (!client) return;
      try {
        await deadline('chat rate limit mark', client.set(chatRateLimitKey(userId), '1', { NX: true, PX: windowMs }));
      } catch {
        // Redis unavailable: this process's Map keeps the mark.
      }
    },
  };
}
