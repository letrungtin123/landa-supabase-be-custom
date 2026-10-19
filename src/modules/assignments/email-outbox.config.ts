// ═══════════════════════════════════════════════════════════════
// Email outbox config: batch sizes, concurrency, timers, retention and the
// tenant SMTP circuit, read once from env. Moved unchanged from
// email-outbox.service.ts.
// ═══════════════════════════════════════════════════════════════

import { env } from '../../config/env.js';

export const EMAIL_OUTBOX_STALE_SENDING_MINUTES = 5;
export const EMAIL_OUTBOX_INTERVAL_MS = Math.max(5_000, env.EMAIL_OUTBOX_INTERVAL_MS);
export const EMAIL_OUTBOX_BATCH_SIZE = Math.max(1, env.EMAIL_OUTBOX_BATCH_SIZE);
export const EMAIL_OUTBOX_CLAIM_BATCH_SIZE = Math.max(1, Math.min(env.EMAIL_OUTBOX_CLAIM_BATCH_SIZE, EMAIL_OUTBOX_BATCH_SIZE));
export const EMAIL_OUTBOX_CONCURRENCY = Math.max(1, Math.min(env.EMAIL_OUTBOX_CONCURRENCY, EMAIL_OUTBOX_BATCH_SIZE));
export const EMAIL_OUTBOX_TENANT_CONCURRENCY = Math.max(1, Math.min(env.EMAIL_OUTBOX_TENANT_CONCURRENCY, EMAIL_OUTBOX_CONCURRENCY));
export const EMAIL_OUTBOX_TICK_BUDGET_MS = Math.max(10_000, env.EMAIL_OUTBOX_TICK_BUDGET_MS);
export const EMAIL_OUTBOX_SESSION_MAX_MESSAGES = Math.max(1, env.EMAIL_OUTBOX_SESSION_MAX_MESSAGES);
export const EMAIL_OUTBOX_SENT_RETENTION_DAYS = Math.max(0, env.EMAIL_OUTBOX_SENT_RETENTION_DAYS);
export const EMAIL_OUTBOX_RETENTION_BATCH_SIZE = Math.max(1, env.EMAIL_OUTBOX_RETENTION_BATCH_SIZE);
export const EMAIL_OUTBOX_WAKE_DEBOUNCE_MS = Math.max(0, env.EMAIL_OUTBOX_WAKE_DEBOUNCE_MS);
export const EMAIL_OUTBOX_RABBIT_PREFETCH = Math.max(1, env.EMAIL_OUTBOX_RABBIT_PREFETCH);
export const EMAIL_OUTBOX_TENANT_FAILURE_THRESHOLD = Math.max(1, env.EMAIL_OUTBOX_TENANT_FAILURE_THRESHOLD);
export const EMAIL_OUTBOX_TENANT_COOLDOWN_MS = Math.max(1_000, env.EMAIL_OUTBOX_TENANT_COOLDOWN_MS);
export const EMAIL_OUTBOX_TENANT_MAX_COOLDOWN_MS = Math.max(EMAIL_OUTBOX_TENANT_COOLDOWN_MS, env.EMAIL_OUTBOX_TENANT_MAX_COOLDOWN_MS);
export const EMAIL_OUTBOX_RETENTION_LOCK_KEY = 'landa:email-outbox-retention:v1';
export const EMAIL_OUTBOX_RETENTION_INTERVAL_MS = 60 * 60 * 1000;
