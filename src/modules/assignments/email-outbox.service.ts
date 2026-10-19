// Email outbox: the worker loop (timers, wakes, the RabbitMQ consumer) that
// fans out course notifications and delivers due emails, plus the public
// entry points of the outbox, by concern:
// - email-outbox-enqueue.service.ts: the emails other modules enqueue;
// - email-notification-fanout.service.ts: course-notification fan-out;
// - email-outbox-delivery.service.ts: one delivery batch (claim, SMTP,
//   sent / retry / failed, tenant circuit, retention);
// - email-outbox-templates.service.ts: the email contents.
// SQL lives in email-outbox.repository.ts and email-outbox-enqueue.repository.ts,
// the env-derived settings in email-outbox.config.ts.
import { env } from '../../config/env.js';
import { consume, publish, QUEUES } from '../../config/rabbitmq/index.js';
import {
  EMAIL_OUTBOX_BATCH_SIZE,
  EMAIL_OUTBOX_CLAIM_BATCH_SIZE,
  EMAIL_OUTBOX_CONCURRENCY,
  EMAIL_OUTBOX_INTERVAL_MS,
  EMAIL_OUTBOX_RABBIT_PREFETCH,
  EMAIL_OUTBOX_RETENTION_INTERVAL_MS,
  EMAIL_OUTBOX_SENT_RETENTION_DAYS,
  EMAIL_OUTBOX_SESSION_MAX_MESSAGES,
  EMAIL_OUTBOX_TENANT_CONCURRENCY,
  EMAIL_OUTBOX_TENANT_COOLDOWN_MS,
  EMAIL_OUTBOX_TENANT_FAILURE_THRESHOLD,
  EMAIL_OUTBOX_TICK_BUDGET_MS,
  EMAIL_OUTBOX_WAKE_DEBOUNCE_MS,
} from './email-outbox.config.js';
import {
  cleanupSentEmailOutboxBatch,
  createEmailOutboxBatchStats,
  mergeEmailOutboxBatchStats,
  processEmailOutboxBatchStats,
  withEmailOutboxRetentionLock,
} from './email-outbox-delivery.service.js';
import { processCourseNotificationEmailFanoutBatch } from './email-notification-fanout.service.js';

export {
  enqueueAssignmentCreatedEmails,
  enqueueCourseNotificationEmailJob,
  enqueueFeedbackEmails,
  enqueueTeamMemberAddedEmails,
} from './email-outbox-enqueue.service.js';
export { processCourseNotificationEmailFanoutBatch } from './email-notification-fanout.service.js';

let workerStarted = false;
let workerRunning = false;
let workerWakePending = false;
let workerWakeTimer: NodeJS.Timeout | null = null;
let workerImmediateScheduled = false;
let pendingWakeReason = 'manual';
let workerInterval: NodeJS.Timeout | null = null;
let nextRetentionCleanupAt = 0;
let emailOutboxRabbitConsumerStarted = false;

async function drainEmailOutboxWorker(reason: string): Promise<void> {
  const startedAt = Date.now();
  const deadlineMs = startedAt + EMAIL_OUTBOX_TICK_BUDGET_MS;
  const totalStats = createEmailOutboxBatchStats();
  let fanoutQueued = 0;
  let retentionDeleted = 0;
  let loops = 0;

  while (Date.now() < deadlineMs) {
    loops += 1;
    let queued = 0;
    try {
      queued = await processCourseNotificationEmailFanoutBatch();
      fanoutQueued += queued;
    } catch (err) {
      totalStats.errors += 1;
      console.error('[EmailOutbox] Fanout error:', err instanceof Error ? err.message : err);
    }

    const batchStats = await processEmailOutboxBatchStats(
      undefined,
      EMAIL_OUTBOX_BATCH_SIZE,
      EMAIL_OUTBOX_CONCURRENCY,
      deadlineMs,
    );
    mergeEmailOutboxBatchStats(totalStats, batchStats);

    if (queued === 0 && batchStats.claimed === 0) {
      break;
    }
  }

  if (Date.now() >= nextRetentionCleanupAt) {
    nextRetentionCleanupAt = Date.now() + EMAIL_OUTBOX_RETENTION_INTERVAL_MS;
    try {
      await withEmailOutboxRetentionLock(async () => {
        retentionDeleted = await cleanupSentEmailOutboxBatch();
      });
    } catch (err) {
      totalStats.errors += 1;
      console.error('[EmailOutbox] Retention cleanup error:', err instanceof Error ? err.message : err);
    }
  }

  const elapsedMs = Date.now() - startedAt;
  const hasActivity = fanoutQueued > 0
    || totalStats.claimed > 0
    || totalStats.reclaimed > 0
    || totalStats.sent > 0
    || totalStats.retried > 0
    || totalStats.failed > 0
    || totalStats.cooldownSkipped > 0
    || totalStats.circuitOpened > 0
    || retentionDeleted > 0
    || totalStats.errors > 0;
  const shouldLogIdleTick = reason === 'startup'
    || reason.startsWith('rabbitmq')
    || reason.startsWith('pending-wake');

  if (hasActivity || shouldLogIdleTick) {
    console.log(
      `[EmailOutbox] tick done reason=${reason} loops=${loops} fanout_queued=${fanoutQueued} claimed=${totalStats.claimed} reclaimed=${totalStats.reclaimed} sent=${totalStats.sent} retried=${totalStats.retried} failed=${totalStats.failed} cooldown_skipped=${totalStats.cooldownSkipped} circuit_opened=${totalStats.circuitOpened} retention_deleted=${retentionDeleted} errors=${totalStats.errors} elapsed_ms=${elapsedMs}`,
    );
  }
}

async function runEmailOutboxWorkerTick(reason: string): Promise<void> {
  if (!workerStarted || !env.EMAIL_OUTBOX_WORKER_ENABLED) return;
  if (workerRunning) {
    workerWakePending = true;
    return;
  }

  workerRunning = true;
  try {
    do {
      workerWakePending = false;
      await drainEmailOutboxWorker(reason);
      reason = pendingWakeReason === 'manual' ? 'pending-wake' : `pending-wake:${pendingWakeReason}`;
      pendingWakeReason = 'manual';
    } while (workerWakePending);
  } finally {
    workerRunning = false;
  }
}

async function publishEmailOutboxWake(reason: string): Promise<void> {
  try {
    await publish(QUEUES.EMAIL_OUTBOX, {
      type: 'email_outbox_wake',
      reason,
      emittedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.warn('[EmailOutbox] RabbitMQ wake publish failed; DB polling fallback remains active:', err instanceof Error ? err.message : err);
  }
}

export function wakeEmailOutboxWorker(reason = 'manual'): void {
  triggerEmailOutboxWorker(reason);
  publishEmailOutboxWake(reason).catch(err => {
    console.warn('[EmailOutbox] RabbitMQ wake publish failed; DB polling fallback remains active:', err instanceof Error ? err.message : err);
  });
}

export function triggerEmailOutboxWorker(reason = 'manual'): void {
  if (!workerStarted || !env.EMAIL_OUTBOX_WORKER_ENABLED) return;
  pendingWakeReason = reason;
  if (workerRunning) {
    workerWakePending = true;
    return;
  }
  if (workerWakeTimer) return;
  if (workerImmediateScheduled) return;

  const run = () => {
    workerWakeTimer = null;
    workerImmediateScheduled = false;
    const runReason = pendingWakeReason;
    pendingWakeReason = 'manual';
    runEmailOutboxWorkerTick(runReason).catch(err => {
      console.error('[EmailOutbox] Worker error:', err instanceof Error ? err.message : err);
    });
  };

  if (EMAIL_OUTBOX_WAKE_DEBOUNCE_MS > 0) {
    workerWakeTimer = setTimeout(run, EMAIL_OUTBOX_WAKE_DEBOUNCE_MS);
    workerWakeTimer.unref();
  } else {
    workerImmediateScheduled = true;
    setImmediate(run);
  }
}

export async function startEmailOutboxRabbitConsumer(): Promise<void> {
  if (emailOutboxRabbitConsumerStarted) return;
  emailOutboxRabbitConsumerStarted = true;
  await consume(
    QUEUES.EMAIL_OUTBOX,
    async function processEmailWake(data: Record<string, any>) {
      const reason = typeof data.reason === 'string' && data.reason.trim()
        ? `rabbitmq:${data.reason.trim()}`
        : 'rabbitmq';
      triggerEmailOutboxWorker(reason);
    },
    async function onMaxRetry(_queue: string, rawMessage: string) {
      console.error('[EmailOutbox] RabbitMQ wake max retries reached; DB polling fallback remains active:', rawMessage.substring(0, 200));
    },
    { prefetch: EMAIL_OUTBOX_RABBIT_PREFETCH, isolatedChannel: true },
  );
}

export function startEmailOutboxWorker(options: { keepAlive?: boolean; source?: string } = {}): void {
  if (workerStarted) return;
  if (!env.EMAIL_OUTBOX_WORKER_ENABLED) {
    console.log('[EmailOutbox] Worker disabled by EMAIL_OUTBOX_WORKER_ENABLED=false');
    return;
  }
  workerStarted = true;
  console.log(
    `[EmailOutbox] Worker started source=${options.source || 'default'} interval_ms=${EMAIL_OUTBOX_INTERVAL_MS} batch_size=${EMAIL_OUTBOX_BATCH_SIZE} claim_batch_size=${EMAIL_OUTBOX_CLAIM_BATCH_SIZE} concurrency=${EMAIL_OUTBOX_CONCURRENCY} tenant_concurrency=${EMAIL_OUTBOX_TENANT_CONCURRENCY} session_max_messages=${EMAIL_OUTBOX_SESSION_MAX_MESSAGES} retention_days=${EMAIL_OUTBOX_SENT_RETENTION_DAYS} tick_budget_ms=${EMAIL_OUTBOX_TICK_BUDGET_MS} wake_debounce_ms=${EMAIL_OUTBOX_WAKE_DEBOUNCE_MS} rabbit_prefetch=${EMAIL_OUTBOX_RABBIT_PREFETCH} tenant_failure_threshold=${EMAIL_OUTBOX_TENANT_FAILURE_THRESHOLD} tenant_cooldown_ms=${EMAIL_OUTBOX_TENANT_COOLDOWN_MS}`,
  );
  triggerEmailOutboxWorker('startup');
  workerInterval = setInterval(() => {
    triggerEmailOutboxWorker('interval');
  }, EMAIL_OUTBOX_INTERVAL_MS);
  if (!options.keepAlive) workerInterval.unref();
}

export function stopEmailOutboxWorker(): void {
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
  }
  if (workerWakeTimer) {
    clearTimeout(workerWakeTimer);
    workerWakeTimer = null;
  }
  workerImmediateScheduled = false;
  workerStarted = false;
}
