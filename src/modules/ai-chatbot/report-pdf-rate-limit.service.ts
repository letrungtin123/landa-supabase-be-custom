// Per-user and per-tenant fixed-window limits for starting report PDF exports.
// Counters live in Redis so every API instance shares them. Redis is required
// in production; when it is unavailable the limiter fails open (logged) and
// the renderer's bounded queue still protects the host.
import { env } from '../../config/env.js';
import { getRedisClient } from '../../config/redis.js';
import { buildReportPdfRateLimitKeys } from './report-pdf-export.logic.js';

export interface ReportPdfRateLimitDecision { allowed: boolean; scope: 'user' | 'tenant' | null; retryAfterSeconds: number }

export interface ReportPdfRateLimitCounter {
  /** Increments both keys (with expiry) and returns the new counts, or null when unavailable. */
  incrementPair(userKey: string, tenantKey: string, ttlSeconds: number): Promise<[number, number] | null>;
}

const redisCounter: ReportPdfRateLimitCounter = {
  async incrementPair(userKey, tenantKey, ttlSeconds) {
    const client = getRedisClient();
    if (!client) return null;
    const replies = await client.multi()
      .incr(userKey).expire(userKey, ttlSeconds)
      .incr(tenantKey).expire(tenantKey, ttlSeconds)
      .exec();
    return [Number(replies[0]), Number(replies[2])];
  },
};

export async function consumeReportPdfExportAllowance(
  actor: { tenantId: string; userId: string },
  options: {
    counter?: ReportPdfRateLimitCounter;
    nowMs?: number;
    windowSeconds?: number;
    userLimit?: number;
    tenantLimit?: number;
    log?: (event: Record<string, unknown>) => void;
  } = {},
): Promise<ReportPdfRateLimitDecision> {
  const windowSeconds = options.windowSeconds ?? env.REPORT_PDF_RATE_LIMIT_WINDOW_SECONDS;
  const keys = buildReportPdfRateLimitKeys({ tenantId: actor.tenantId, userId: actor.userId, nowMs: options.nowMs ?? Date.now(), windowSeconds });
  let counts: [number, number] | null = null;
  try {
    counts = await (options.counter ?? redisCounter).incrementPair(keys.user, keys.tenant, windowSeconds + 5);
  } catch {
    counts = null;
  }
  if (!counts) {
    options.log?.({ event: 'report_pdf_rate_limit_unavailable', tenant_id: actor.tenantId });
    return { allowed: true, scope: null, retryAfterSeconds: 0 };
  }
  const [userCount, tenantCount] = counts;
  if (userCount > (options.userLimit ?? env.REPORT_PDF_USER_EXPORTS_PER_WINDOW)) return { allowed: false, scope: 'user', retryAfterSeconds: keys.retryAfterSeconds };
  if (tenantCount > (options.tenantLimit ?? env.REPORT_PDF_TENANT_EXPORTS_PER_WINDOW)) return { allowed: false, scope: 'tenant', retryAfterSeconds: keys.retryAfterSeconds };
  return { allowed: true, scope: null, retryAfterSeconds: 0 };
}
