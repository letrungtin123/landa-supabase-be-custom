// ═══════════════════════════════════════════════════════════════
// Knowledge base restore: rebuilds a knowledge base's Gemini store after the
// tenant's key changed. A restore job is queued (inside the caller's audited
// transaction), dispatched after commit (with database-backed recovery),
// run under the KB's transaction lock (old store orphaned, mappings dropped,
// documents re-queued), and its documents are uploaded and counted by the
// upload worker. SQL lives in kb-restore.repository.ts; moved from
// kb.service.ts, which still re-exports every entry point.
// ═══════════════════════════════════════════════════════════════

import { randomUUID } from 'crypto';
import { getClient, query } from '../../../config/database.js';
import { invalidateTenantAiCaches } from '../../../config/cache-invalidation.js';
import { publish, QUEUES } from '../../../config/rabbitmq/index.js';
import { getRedisClient } from '../../../config/redis.js';
import { AppError } from '../../../middleware/error-handler.js';
import { getGeminiApiKeyFingerprint, getGeminiClient } from '../ai-platform/gemini.service.js';
import { createKbRestoreRepository } from './kb-restore.repository.js';
import { getRestoreReasonFromStore, isRestoreActiveState } from './kb-restore.logic.js';
import type { EnqueueRestoreKnowledgebaseResult, RestoreKnowledgebaseResult } from './kb.types.js';

const KB_RESTORE_LOCK_TTL_SECONDS = 6 * 60 * 60;

const restoreRepository = createKbRestoreRepository({ query });

function isRedisPermissionError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /NOPERM|No permissions to access a key/i.test(message);
}

export async function releaseKnowledgebaseRestoreLock(lockKey: string, lockToken: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;

  try {
    const current = await redis.get(lockKey);
    if (current === lockToken) await redis.del(lockKey);
  } catch (err) {
    if (isRedisPermissionError(err)) {
      console.warn('[AI Chatbot] Redis ACL blocked KB restore lock cleanup. Check cache key prefix permissions.');
    }
    // Lock cleanup is best-effort; TTL is the fallback.
  }
}

async function failKnowledgebaseRestoreJob(
  jobId: string,
  kbId: string,
  tenantId: string,
  errorReason: string,
): Promise<void> {
  const safeReason = errorReason.slice(0, 1000);
  await restoreRepository.failRestoreJob(jobId, kbId, tenantId, safeReason);
  await restoreRepository.failKnowledgebaseRestore(kbId, tenantId, safeReason, jobId);
  await invalidateTenantAiCaches(tenantId);
}

export async function markKnowledgebaseRestoreFailed(
  jobId: string,
  kbId: string,
  tenantId: string,
  errorReason: string,
): Promise<void> {
  await failKnowledgebaseRestoreJob(jobId, kbId, tenantId, errorReason);
}

export async function setRestoreJobNewStore(
  jobId: string,
  kbId: string,
  tenantId: string,
  storeName: string,
): Promise<void> {
  await restoreRepository.setJobNewStore(jobId, kbId, tenantId, storeName);
}

export async function claimRestoreDocumentForUpload(
  jobId: string,
  documentId: string,
  kbId: string,
  tenantId: string,
): Promise<boolean> {
  return (await restoreRepository.claimDocumentForUpload(jobId, documentId, kbId, tenantId)) > 0;
}

export async function resetRestoreDocumentForRetry(
  jobId: string,
  documentId: string,
  kbId: string,
  tenantId: string,
  errorReason: string,
): Promise<void> {
  await restoreRepository.resetDocumentForRetry(jobId, documentId, kbId, tenantId, errorReason.slice(0, 1000));
}

export async function recordRestoreDocumentFinished(
  jobId: string,
  documentId: string,
  kbId: string,
  tenantId: string,
  success: boolean,
  errorReason?: string,
): Promise<void> {
  const client = await getClient();
  const repository = createKbRestoreRepository(client);
  try {
    await client.query('BEGIN');
    const finished = await repository.finishDocument(
      jobId, documentId, kbId, tenantId, success ? 'learned' : 'failed', errorReason?.slice(0, 1000) ?? null,
    );

    if (finished === 0) {
      await client.query('COMMIT');
      return;
    }

    const job = await repository.addDocumentResult(jobId, kbId, tenantId, success ? 1 : 0, success ? 0 : 1);
    if (job && Number(job.learned_docs) + Number(job.failed_docs) + Number(job.skipped_docs) >= Number(job.total_docs)) {
      const finalStatus = Number(job.failed_docs) > 0 ? 'failed' : 'completed';
      await repository.finishJob(jobId, kbId, tenantId, finalStatus);
      await repository.finishKnowledgebaseRestore(kbId, tenantId, jobId, finalStatus);
    }
    await client.query('COMMIT');
    await invalidateTenantAiCaches(tenantId);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* fails only on a broken connection, which pg-pool discards */ }
    throw err;
  } finally {
    client.release();
  }
}

async function markRestoreDocumentEnqueued(
  jobId: string,
  documentId: string,
  kbId: string,
  tenantId: string,
): Promise<void> {
  if ((await restoreRepository.markDocumentEnqueued(jobId, documentId, kbId, tenantId)) > 0) {
    await restoreRepository.incrementEnqueuedDocs(jobId, kbId, tenantId);
  }
}

async function publishQueuedRestoreDocuments(
  jobId: string,
  kbId: string,
  tenantId: string,
  includeAlreadyEnqueued = false,
): Promise<{ enqueued: number }> {
  const batchSize = 500;
  let enqueued = 0;
  let afterDocumentId: string | null = null;

  for (;;) {
    const docs = await restoreRepository.selectQueuedDocuments(jobId, kbId, tenantId, batchSize, includeAlreadyEnqueued, afterDocumentId);
    if (!docs.rowCount || docs.rowCount === 0) break;

    for (const doc of docs.rows) {
      await publish(QUEUES.GEMINI_UPLOAD, {
        documentId: doc.document_id,
        kbId,
        tenantId,
        mode: 'file',
        restoreJobId: jobId,
      });
      await markRestoreDocumentEnqueued(jobId, doc.document_id, kbId, tenantId);
      enqueued++;
      afterDocumentId = doc.document_id;
    }
  }

  return { enqueued };
}

async function restoreKnowledgebaseTracked(
  kbId: string,
  tenantId: string,
  jobId: string,
): Promise<RestoreKnowledgebaseResult> {
  await getGeminiClient(tenantId);
  const currentFingerprint = await getGeminiApiKeyFingerprint(tenantId);

  const client = await getClient();
  const repository = createKbRestoreRepository(client);
  let restoreDocs = 0;
  let skippedNoFile = 0;
  let deletedMappings = 0;
  let orphanedStores = 0;
  let resumeQueuedDocuments = false;

  try {
    await client.query('BEGIN');
    await repository.lockKnowledgebaseRestore(tenantId, kbId);

    const job = await repository.lockRestoreJob(jobId, kbId, tenantId);
    if (!job) throw new AppError('Restore job khong ton tai', 404);
    if (job.status === 'completed' || job.status === 'failed') {
      await client.query('COMMIT');
      return {
        restored: 0,
        enqueued: 0,
        failed_to_enqueue: 0,
        skipped_no_file: 0,
        deleted_stores: 0,
        deleted_mappings: 0,
        orphaned_stores: 0,
        upload_publish_failed: false,
      };
    }

    resumeQueuedDocuments = job.status === 'uploading';

    if (job.status !== 'uploading') {
      await repository.startRestoreJob(jobId, kbId, tenantId, currentFingerprint);
      await repository.startKnowledgebaseRestore(kbId, tenantId, jobId);

      if (((await repository.countBusyDocuments(kbId, tenantId))?.cnt ?? 0) > 0) {
        throw new AppError('Kho tri thuc dang co tai lieu dang xu ly. Vui long cho xong roi khoi phuc lai.', 409);
      }

      const stores = await repository.lockGeminiStores(kbId);
      const primaryStore = stores.rows[0] ?? null;
      const restoreReason = getRestoreReasonFromStore(primaryStore, currentFingerprint);
      if (!restoreReason) {
        throw new AppError('Kho tri thuc nay chua can khoi phuc theo key Gemini hien tai.', 409);
      }

      const counts = await repository.countRestoreDocuments(kbId, tenantId);
      restoreDocs = Number(counts?.restore_docs ?? 0);
      skippedNoFile = Number(counts?.skipped_docs ?? 0);

      for (const store of stores.rows) {
        await repository.insertOrphanedStore(tenantId, kbId, store, restoreReason);
      }
      orphanedStores = stores.rowCount || 0;

      deletedMappings = await repository.deleteKbGeminiMappings(kbId, tenantId);

      await repository.deleteGeminiStores(kbId);

      await repository.insertJobDocuments(jobId, kbId, tenantId);

      await repository.markFileDocumentsLearning(kbId, tenantId);
      await repository.markFilelessDocumentsError(kbId, tenantId);

      const nextStatus = restoreDocs > 0 ? 'uploading' : 'completed';
      await repository.setRestoreJobProgress(jobId, kbId, tenantId, nextStatus, Number(counts?.total_docs ?? 0), skippedNoFile);
      await repository.setKnowledgebaseRestoreState(kbId, tenantId, jobId, nextStatus);
    }

    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* fails only on a broken connection, which pg-pool discards */ }
    throw err;
  } finally {
    client.release();
  }

  const publishResult = await publishQueuedRestoreDocuments(jobId, kbId, tenantId, resumeQueuedDocuments);
  await invalidateTenantAiCaches(tenantId);

  return {
    restored: restoreDocs,
    enqueued: publishResult.enqueued,
    failed_to_enqueue: 0,
    skipped_no_file: skippedNoFile,
    deleted_stores: 0,
    deleted_mappings: deletedMappings,
    orphaned_stores: orphanedStores,
    upload_publish_failed: false,
  };
}

export async function enqueueKnowledgebaseRestore(
  kbId: string,
  tenantId: string,
): Promise<EnqueueRestoreKnowledgebaseResult> {
  await getGeminiClient(tenantId);
  const currentFingerprint = await getGeminiApiKeyFingerprint(tenantId);
  const jobId = randomUUID();
  // query() joins runAuditedTransaction through AsyncLocalStorage. The DB
  // active-job constraint/advisory lock is authoritative; a Redis lock could
  // outlive a later Audit rollback and falsely block the next request.
  await restoreRepository.lockKnowledgebaseRestore(tenantId, kbId);

  const row = await restoreRepository.lockKnowledgebaseForRestore(kbId, tenantId);
  if (!row) throw new AppError('Knowledge Base khong ton tai', 404);
  if (isRestoreActiveState(row.restore_state)) {
    throw new AppError('Kho tri thuc dang duoc khoi phuc. Vui long cho job hien tai hoan tat.', 409);
  }

  const restoreReason = getRestoreReasonFromStore(
        row.store_id
          ? {
              api_key_fingerprint: row.api_key_fingerprint,
              remote_status: row.remote_status || 'active',
              remote_error_reason: row.remote_error_reason,
            }
          : null,
        currentFingerprint,
  );
  if (!restoreReason) {
    throw new AppError('Kho tri thuc nay chua can khoi phuc theo key Gemini hien tai.', 409);
  }

  if (((await restoreRepository.countBusyDocuments(kbId, tenantId))?.cnt ?? 0) > 0) {
    throw new AppError('Kho tri thuc dang co tai lieu dang xu ly. Vui long cho xong roi khoi phuc lai.', 409);
  }

  await restoreRepository.insertRestoreJob(jobId, tenantId, kbId, row.store_name, row.api_key_fingerprint, currentFingerprint);
  await restoreRepository.queueKnowledgebaseRestore(kbId, tenantId, jobId);
  return {
    queued: true,
    job_id: jobId,
    kb_id: kbId,
    lock_ttl_seconds: KB_RESTORE_LOCK_TTL_SECONDS,
  };
}

export interface RestoreDispatchTarget {
  jobId: string;
  kbId: string;
  tenantId: string;
}

async function recordRestoreDispatchAttempt(target: RestoreDispatchTarget, confirmed: boolean): Promise<void> {
  await restoreRepository.recordDispatchAttempt(target, confirmed);
}

/** Dispatch after the audited transaction committed; recovery handles broker outages. */
export async function dispatchKnowledgebaseRestore(target: RestoreDispatchTarget): Promise<boolean> {
  try {
    await publish(QUEUES.GEMINI_RESTORE, {
      jobId: target.jobId,
      kbId: target.kbId,
      tenantId: target.tenantId,
    });
    await recordRestoreDispatchAttempt(target, true);
    return true;
  } catch (error) {
    await recordRestoreDispatchAttempt(target, false).catch((recordError) => {
      console.error(`[KB restore] Failed to record deferred dispatch for job ${target.jobId}:`, recordError);
    });
    console.error(`[KB restore] Broker dispatch deferred for job ${target.jobId}:`, error);
    return false;
  }
}

/** Database-backed recovery for a message lost after the Audit transaction committed. */
export async function redispatchRecoverableKnowledgebaseRestores(limit = 50): Promise<number> {
  const safeLimit = Math.max(1, Math.min(limit, 200));
  const jobs = await restoreRepository.selectRecoverableJobs(safeLimit);
  let dispatched = 0;
  for (const job of jobs) {
    if (await dispatchKnowledgebaseRestore(job)) dispatched += 1;
  }
  return dispatched;
}

/**
 * Restore a KB through the tracked restore job flow.
 */
export async function restoreKnowledgebase(
  kbId: string,
  tenantId: string,
  jobId: string,
): Promise<RestoreKnowledgebaseResult> {
  return restoreKnowledgebaseTracked(kbId, tenantId, jobId);
}
