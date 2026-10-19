// ═══════════════════════════════════════════════════════════════
// Email outbox delivery: one batch of a worker tick. Claims due jobs (and
// stale 'sending' leases), re-checks each recipient right before SMTP,
// sends one SMTP session per tenant group and per SESSION_MAX_MESSAGES, and
// moves each job to 'sent', back to 'pending' with a backoff, or to
// 'failed'. A tenant whose SMTP keeps failing gets a cooldown (per-process
// circuit). Also the sent retention under its session advisory lock. SQL
// lives in email-outbox.repository.ts; moved from email-outbox.service.ts,
// which keeps the worker loop and its timers.
// ═══════════════════════════════════════════════════════════════

import { getClient, getSessionClient, query } from '../../config/database.js';
import { decryptSecret } from '../../utils/secret-crypto.js';
import { sendSmtpMailBatch, type SmtpBatchMail, type SmtpConfig } from '../../utils/smtp-client.js';
import { getTenantSmtpConfigForSend } from '../tenants/tenant-smtp.service.js';
import { cleanEmailBody } from './email-outbox-body.logic.js';
import {
  EMAIL_OUTBOX_CLAIM_BATCH_SIZE,
  EMAIL_OUTBOX_RETENTION_BATCH_SIZE,
  EMAIL_OUTBOX_RETENTION_LOCK_KEY,
  EMAIL_OUTBOX_SENT_RETENTION_DAYS,
  EMAIL_OUTBOX_SESSION_MAX_MESSAGES,
  EMAIL_OUTBOX_STALE_SENDING_MINUTES,
  EMAIL_OUTBOX_TENANT_CONCURRENCY,
  EMAIL_OUTBOX_TENANT_COOLDOWN_MS,
  EMAIL_OUTBOX_TENANT_FAILURE_THRESHOLD,
  EMAIL_OUTBOX_TENANT_MAX_COOLDOWN_MS,
} from './email-outbox.config.js';
import { createEmailOutboxRepository, type ClaimedEmailOutboxJob } from './email-outbox.repository.js';

const outboxRepository = createEmailOutboxRepository({ query });

async function claimEmailOutboxJobs(tenantId: string | undefined, limit: number): Promise<ClaimedEmailOutboxJob[]> {
  const client = await getClient();
  try {
    const jobs = [...(await outboxRepository.claimRunnableJobs(client, limit, tenantId))];
    const remaining = limit - jobs.length;
    if (remaining <= 0) return jobs;

    const stale = await outboxRepository.claimStaleSendingJobs(client, remaining, EMAIL_OUTBOX_STALE_SENDING_MINUTES, tenantId);
    if (stale.rowCount) {
      console.warn(`[EmailOutbox] Reclaiming ${stale.rowCount} stale sending job(s)`);
      jobs.push(...stale.rows);
    }
    return jobs;
  } finally {
    client.release();
  }
}

export interface EmailOutboxBatchStats {
  claimed: number;
  reclaimed: number;
  sent: number;
  retried: number;
  failed: number;
  errors: number;
  cooldownSkipped: number;
  circuitOpened: number;
}

export function createEmailOutboxBatchStats(): EmailOutboxBatchStats {
  return {
    claimed: 0,
    reclaimed: 0,
    sent: 0,
    retried: 0,
    failed: 0,
    errors: 0,
    cooldownSkipped: 0,
    circuitOpened: 0,
  };
}

export function mergeEmailOutboxBatchStats(target: EmailOutboxBatchStats, source: EmailOutboxBatchStats): void {
  target.claimed += source.claimed;
  target.reclaimed += source.reclaimed;
  target.sent += source.sent;
  target.retried += source.retried;
  target.failed += source.failed;
  target.errors += source.errors;
  target.cooldownSkipped += source.cooldownSkipped;
  target.circuitOpened += source.circuitOpened;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

interface TenantSmtpCircuitState {
  failures: number;
  cooldownUntil: number;
  cooldownMs: number;
  lastError: string;
}

const tenantSmtpCircuits = new Map<string, TenantSmtpCircuitState>();

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTenantSmtpInfrastructureError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return [
    'timeout',
    'connection',
    'socket',
    'auth',
    'starttls',
    'certificate',
    'econnrefused',
    'econnreset',
    'enotfound',
    'etimedout',
    'smtp config',
  ].some(token => message.includes(token));
}

function getTenantCircuitCooldownUntil(tenantId: string): number {
  const state = tenantSmtpCircuits.get(tenantId);
  if (!state) return 0;
  if (state.cooldownUntil <= Date.now()) return 0;
  return state.cooldownUntil;
}

function markTenantSmtpSuccess(tenantId: string): void {
  const state = tenantSmtpCircuits.get(tenantId);
  if (!state) return;
  tenantSmtpCircuits.delete(tenantId);
  console.log(`[EmailOutbox] SMTP circuit recovered tenant=${tenantId}`);
}

function markTenantSmtpFailure(tenantId: string, error: unknown, stats: EmailOutboxBatchStats): void {
  if (!isTenantSmtpInfrastructureError(error)) return;

  const now = Date.now();
  const current = tenantSmtpCircuits.get(tenantId);
  const failures = (current?.failures || 0) + 1;
  const previousCooldownMs = current?.cooldownMs || EMAIL_OUTBOX_TENANT_COOLDOWN_MS;
  const shouldOpen = failures >= EMAIL_OUTBOX_TENANT_FAILURE_THRESHOLD;
  const cooldownMs = shouldOpen
    ? Math.min(
        current?.cooldownUntil && current.cooldownUntil > now
          ? previousCooldownMs * 2
          : previousCooldownMs,
        EMAIL_OUTBOX_TENANT_MAX_COOLDOWN_MS,
      )
    : previousCooldownMs;
  const cooldownUntil = shouldOpen ? now + cooldownMs : 0;

  tenantSmtpCircuits.set(tenantId, {
    failures,
    cooldownUntil,
    cooldownMs,
    lastError: getErrorMessage(error).slice(0, 300),
  });

  if (shouldOpen) {
    stats.circuitOpened += 1;
    console.warn(
      `[EmailOutbox] SMTP circuit open tenant=${tenantId} failures=${failures} cooldown_ms=${cooldownMs} error=${getErrorMessage(error).slice(0, 200)}`,
    );
  }
}

/** A status write, tried 3 times (200 ms, then 400 ms apart). */
async function writeOutboxStatusWithRetry(write: () => Promise<void>, label: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await write();
      return;
    } catch (err) {
      lastError = err;
      if (attempt < 3) await sleep(200 * attempt);
    }
  }

  throw new Error(`${label} failed after retries: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function markEmailOutboxJobSent(job: ClaimedEmailOutboxJob, stats: EmailOutboxBatchStats): Promise<void> {
  await writeOutboxStatusWithRetry(() => outboxRepository.markJobSent(job.id), 'mark email outbox sent');
  stats.sent += 1;
}

async function markEmailOutboxJobRetry(
  job: ClaimedEmailOutboxJob,
  error: unknown,
  stats: EmailOutboxBatchStats,
): Promise<void> {
  const message = getErrorMessage(error);
  const nextAttempts = job.attempts + 1;
  const nextStatus = nextAttempts >= job.max_attempts ? 'failed' : 'pending';
  await writeOutboxStatusWithRetry(
    () => outboxRepository.markJobRetry(job.id, nextStatus, message.slice(0, 2000), nextAttempts),
    'mark email outbox retry',
  );
  if (nextStatus === 'failed') {
    stats.failed += 1;
  } else {
    stats.retried += 1;
  }
}

async function releaseEmailOutboxJobForCooldown(
  job: ClaimedEmailOutboxJob,
  cooldownUntil: number,
  reason: string,
  stats: EmailOutboxBatchStats,
): Promise<void> {
  await writeOutboxStatusWithRetry(
    () => outboxRepository.releaseJobUntil(job.id, reason.slice(0, 2000), cooldownUntil),
    'release email outbox cooldown',
  );
  stats.cooldownSkipped += 1;
}

function toSmtpBatchMail(job: ClaimedEmailOutboxJob): SmtpBatchMail {
  return {
    id: job.id,
    to: job.recipient_email,
    subject: job.subject,
    html: cleanEmailBody(job.html_body),
    text: cleanEmailBody(job.text_body),
  };
}

/**
 * A job can be claimed just before a permanent deletion request commits. Check
 * its durable recipient state immediately before touching SMTP, and discard any
 * now-deleted outbox rows rather than delivering stale personal data.
 */
async function filterDeliverableOutboxJobs(jobs: ClaimedEmailOutboxJob[]): Promise<ClaimedEmailOutboxJob[]> {
  if (jobs.length === 0) return jobs;
  const rows = await outboxRepository.selectDeliverableJobIds(jobs.map((job) => job.id));
  const deliverableIds = new Set(rows.map((row) => row.id));
  const cancelledIds = jobs.filter((job) => !deliverableIds.has(job.id)).map((job) => job.id);
  if (cancelledIds.length > 0) {
    await outboxRepository.deleteSendingJobs(cancelledIds);
  }
  return jobs.filter((job) => deliverableIds.has(job.id));
}

async function getTenantSmtpConfigOrThrow(tenantId: string): Promise<SmtpConfig> {
  const smtp = await getTenantSmtpConfigForSend(tenantId);
  if (!smtp || !smtp.password_ciphertext || !smtp.password_iv || !smtp.password_auth_tag) {
    throw new Error('SMTP config is disabled or missing password');
  }

  const password = decryptSecret({
    ciphertext: smtp.password_ciphertext,
    iv: smtp.password_iv,
    authTag: smtp.password_auth_tag,
  });

  return {
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    username: smtp.username,
    password,
    fromEmail: smtp.from_email,
    fromName: smtp.from_name,
    replyToEmail: smtp.reply_to_email,
  };
}

async function sendClaimedEmailOutboxTenantGroup(
  jobs: ClaimedEmailOutboxJob[],
  stats: EmailOutboxBatchStats,
): Promise<void> {
  if (jobs.length === 0) return;
  const tenantId = jobs[0].tenant_id;
  const cooldownUntil = getTenantCircuitCooldownUntil(tenantId);
  if (cooldownUntil > Date.now()) {
    const waitMs = cooldownUntil - Date.now();
    const reason = `SMTP tenant is cooling down; retry in ${Math.ceil(waitMs / 1000)}s`;
    await Promise.all(jobs.map(job => releaseEmailOutboxJobForCooldown(job, cooldownUntil, reason, stats)));
    return;
  }

  let smtpConfig: SmtpConfig;
  try {
    smtpConfig = await getTenantSmtpConfigOrThrow(tenantId);
  } catch (err) {
    markTenantSmtpFailure(tenantId, err, stats);
    for (const job of jobs) await markEmailOutboxJobRetry(job, err, stats);
    return;
  }

  const jobMap = new Map(jobs.map(job => [job.id, job]));
  for (let start = 0; start < jobs.length; start += EMAIL_OUTBOX_SESSION_MAX_MESSAGES) {
    const claimedSlice = jobs.slice(start, start + EMAIL_OUTBOX_SESSION_MAX_MESSAGES);
    const slice = await filterDeliverableOutboxJobs(claimedSlice);
    if (slice.length === 0) continue;
    const seen = new Set<string>();
    let sliceSuccessCount = 0;
    let sliceInfrastructureError: unknown = null;
    const markResult = async (result: { id: string; ok: boolean; error?: string }): Promise<void> => {
      if (seen.has(result.id)) return;
      const job = jobMap.get(result.id);
      if (!job) return;
      if (result.ok) {
        await markEmailOutboxJobSent(job, stats);
        sliceSuccessCount += 1;
      } else {
        if (isTenantSmtpInfrastructureError(result.error || 'SMTP send failed')) {
          sliceInfrastructureError = result.error || 'SMTP send failed';
        }
        await markEmailOutboxJobRetry(job, result.error || 'SMTP send failed', stats);
      }
      seen.add(result.id);
    };
    const markUnseenRetry = async (error: unknown): Promise<void> => {
      for (const job of slice) {
        if (!seen.has(job.id)) await markEmailOutboxJobRetry(job, error, stats);
      }
    };

    try {
      await sendSmtpMailBatch(
        smtpConfig,
        slice.map(toSmtpBatchMail),
        EMAIL_OUTBOX_SESSION_MAX_MESSAGES,
        markResult,
      );
      await markUnseenRetry('SMTP send did not return a result');
    } catch (err) {
      sliceInfrastructureError = err;
      await markUnseenRetry(err);
    }

    if (sliceSuccessCount > 0) {
      markTenantSmtpSuccess(tenantId);
    } else if (sliceInfrastructureError) {
      markTenantSmtpFailure(tenantId, sliceInfrastructureError, stats);
    }
  }
}

/** One claim of at most `limit` jobs (capped by the claim batch size), sent by tenant group, before the deadline. */
export async function processEmailOutboxBatchStats(
  tenantId: string | undefined,
  limit: number,
  concurrency: number,
  deadlineMs: number,
): Promise<EmailOutboxBatchStats> {
  const stats = createEmailOutboxBatchStats();
  if (Date.now() >= deadlineMs) return stats;

  let jobs: ClaimedEmailOutboxJob[] = [];
  try {
    jobs = await claimEmailOutboxJobs(
      tenantId,
      Math.min(Math.max(1, limit), EMAIL_OUTBOX_CLAIM_BATCH_SIZE),
    );
  } catch (err) {
    stats.errors += 1;
    console.error('[EmailOutbox] Claim error:', err instanceof Error ? err.message : err);
    return stats;
  }

  stats.claimed += jobs.length;
  stats.reclaimed += jobs.filter(job => job.previous_status === 'sending').length;
  if (jobs.length === 0) return stats;

  const groups = new Map<string, ClaimedEmailOutboxJob[]>();
  for (const job of jobs) {
    const group = groups.get(job.tenant_id) || [];
    group.push(job);
    groups.set(job.tenant_id, group);
  }

  const groupQueue = Array.from(groups.values());
  let cursor = 0;
  const groupConcurrency = Math.max(1, Math.min(concurrency, EMAIL_OUTBOX_TENANT_CONCURRENCY, groupQueue.length));
  const worker = async () => {
    while (cursor < groupQueue.length && Date.now() < deadlineMs) {
      const group = groupQueue[cursor];
      cursor += 1;
      try {
        await sendClaimedEmailOutboxTenantGroup(group, stats);
      } catch (err) {
        stats.errors += 1;
        console.error('[EmailOutbox] Group error:', err instanceof Error ? err.message : err);
      }
    }
  };

  await Promise.all(Array.from({ length: groupConcurrency }, () => worker()));

  return stats;
}

export async function cleanupSentEmailOutboxBatch(): Promise<number> {
  if (EMAIL_OUTBOX_SENT_RETENTION_DAYS <= 0) return 0;
  return outboxRepository.deleteSentBefore(EMAIL_OUTBOX_SENT_RETENTION_DAYS, EMAIL_OUTBOX_RETENTION_BATCH_SIZE);
}

export async function withEmailOutboxRetentionLock(fn: () => Promise<void>): Promise<boolean> {
  // Session advisory lock: a direct session (getSessionClient), never a pooled one.
  const client = await getSessionClient();
  try {
    if (!(await outboxRepository.tryAdvisoryLock(client, EMAIL_OUTBOX_RETENTION_LOCK_KEY))) return false;

    try {
      await fn();
    } finally {
      // Fails only with a broken connection, whose session (and so the lock) ends with it.
      await outboxRepository.advisoryUnlock(client, EMAIL_OUTBOX_RETENTION_LOCK_KEY)
        .catch(() => undefined);
    }
    return true;
  } finally {
    client.release();
  }
}
