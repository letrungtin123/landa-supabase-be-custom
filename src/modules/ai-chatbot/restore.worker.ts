// ═══════════════════════════════════════════════════════════════
// Restore Worker — Consume KB restore jobs from RabbitMQ
// ═══════════════════════════════════════════════════════════════

import { consume, QUEUES } from '../../config/rabbitmq/index.js';
import {
  releaseKnowledgebaseRestoreLock,
  restoreKnowledgebase,
} from './kb.service.js';
import { invalidateGeminiStoreNameCache } from './chat.service.js';

interface RestoreJob {
  jobId: string;
  kbId: string;
  tenantId: string;
  lockKey: string;
  lockToken: string;
}

function parseRestoreJob(data: Record<string, any>): RestoreJob | null {
  const { jobId, kbId, tenantId, lockKey, lockToken } = data;
  if (
    typeof jobId !== 'string' ||
    typeof kbId !== 'string' ||
    typeof tenantId !== 'string' ||
    typeof lockKey !== 'string' ||
    typeof lockToken !== 'string'
  ) {
    return null;
  }

  return { jobId, kbId, tenantId, lockKey, lockToken };
}

async function processRestoreJob(data: Record<string, any>): Promise<void> {
  const job = parseRestoreJob(data);
  if (!job) {
    console.warn('[RestoreWorker] Invalid restore job payload, skipping');
    return;
  }

  console.log(`[RestoreWorker] Restoring KB ${job.kbId} for tenant ${job.tenantId}`);
  try {
    const result = await restoreKnowledgebase(job.kbId, job.tenantId);
    invalidateGeminiStoreNameCache(job.kbId);
    console.log(
      `[RestoreWorker] KB ${job.kbId} restored: enqueued=${result.enqueued}, failed_to_enqueue=${result.failed_to_enqueue}, stores=${result.deleted_stores}, mappings=${result.deleted_mappings}`,
    );
    await releaseKnowledgebaseRestoreLock(job.lockKey, job.lockToken);
  } catch (err: any) {
    console.error(`[RestoreWorker] Restore failed for KB ${job.kbId}:`, err?.message || String(err));
    throw err;
  }
}

/**
 * Start the restore consumer.
 */
export async function startRestoreWorker(): Promise<void> {
  await consume(
    QUEUES.GEMINI_RESTORE,
    processRestoreJob,
    async function onMaxRetry(_queue: string, rawMessage: string) {
      try {
        const data = JSON.parse(rawMessage);
        const job = parseRestoreJob(data);
        if (job) {
          await releaseKnowledgebaseRestoreLock(job.lockKey, job.lockToken);
          console.error(`[RestoreWorker] Max retries reached for KB ${job.kbId}, lock released`);
        }
      } catch (err: any) {
        console.error('[RestoreWorker] Failed to parse failed restore job:', err?.message || String(err));
      }
    },
    { prefetch: 1 },
  );
}
