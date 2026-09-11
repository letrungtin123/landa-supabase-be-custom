// ═══════════════════════════════════════════════════════════════
// Knowledge Base durable-operation worker
// ═══════════════════════════════════════════════════════════════

import fs from 'fs/promises';
import { env } from '../../config/env.js';
import { getClient, query } from '../../config/database.js';
import { deleteFile, downloadToTempFile } from '../../config/storage.js';
import { deleteFromStore, ensureStore, getGeminiApiKeyFingerprint, getGeminiClient, uploadToStore } from './gemini.service.js';
import { getTenantAiRuntimeSettings, getGoogleAiStudioApiKey } from './ai-settings.service.js';
import { deleteRagDocument, deleteRagKnowledgebase, indexRagDocument } from './ai-rag-client.service.js';
import {
  estimateTokensFromText,
  finalizeTenantAiTokens,
  releaseTenantAiTokenReservation,
  reserveTenantAiTokens,
} from './ai-token-quota.service.js';
import {
  completeKbOperation,
  claimDueKbOperations,
  failKbOperation,
  renewKbOperationLease,
  type KbOperationJob,
} from './kb-operation.service.js';
import {
  deleteDocumentGeminiMappingsStrict,
  deleteKbGeminiRemoteResources,
  getDocument,
  linkDocumentGemini,
  updateDocumentStatus,
} from './kb.service.js';
import { invalidateTenantAiCaches } from '../../config/cache-invalidation.js';
import { invalidateGeminiStoreNameCache } from './chat.service.js';

let drainInFlight = false;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function previousFilePath(job: KbOperationJob): string | null {
  const value = job.payload?.previous_file_path;
  return typeof value === 'string' && value.trim() ? value : null;
}

function sourceSize(sourceInfo: Record<string, unknown> | null | undefined): number {
  const value = sourceInfo?.size;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function estimateDocumentIndexTokens(doc: { content: string | null; name: string; source_info: Record<string, unknown> | null }): number {
  const extractedContentEstimate = estimateTokensFromText(doc.content, doc.name);
  // A source file may not have extracted text in kb_documents yet. Keep the
  // same conservative byte-based guard used by the transition worker.
  const sourceFileEstimate = Math.ceil(sourceSize(doc.source_info) / 8);
  return Math.max(env.AI_INDEX_TOKEN_RESERVE_ESTIMATE, extractedContentEstimate, sourceFileEstimate);
}

async function assertLease(job: KbOperationJob): Promise<void> {
  if (!job.lease_token || !(await renewKbOperationLease(job.id, job.lease_token))) {
    throw new Error(`KB operation lease lost: ${job.id}`);
  }
}

async function uploadDocumentToGemini(job: KbOperationJob): Promise<void> {
  if (!job.document_id) throw new Error('KB document operation is missing document_id');
  const doc = await getDocument(job.document_id, job.tenant_id);
  if (!doc) return;
  if (!doc.file_path) throw new Error('Document has no file_path');

  if (job.operation === 'document_reupload') {
    // Remote cleanup happens only after the re-train request and Audit Log are
    // durable. Both Gemini deletion and a missing mapping are idempotent.
    await deleteDocumentGeminiMappingsStrict([doc.id], job.tenant_id);
    await assertLease(job);
    await query(`DELETE FROM kb_doc_gemini_mapping WHERE document_id = $1`, [doc.id]);
    const previous = previousFilePath(job);
    if (previous && previous !== doc.file_path) await deleteFile(previous);
  }

  const existingMapping = await query<{ id: string }>(
    `SELECT id FROM kb_doc_gemini_mapping WHERE document_id = $1 LIMIT 1`,
    [doc.id],
  );
  if (existingMapping.rows[0]) {
    await assertLease(job);
    await updateDocumentStatus(doc.id, 'learned');
    return;
  }

  let tempPath: string | null = null;
  try {
    tempPath = await downloadToTempFile(doc.file_path, env.GEMINI_TEMP_DIR);
    const [aiClient, apiKeyFingerprint] = await Promise.all([
      getGeminiClient(job.tenant_id),
      getGeminiApiKeyFingerprint(job.tenant_id),
    ]);
    const { storeId, storeName } = await ensureStore(job.kb_id, aiClient, apiKeyFingerprint);
    const geminiPath = await uploadToStore(storeName, tempPath, doc.name || `doc-${doc.id}`, aiClient);
    try {
      await assertLease(job);
      const linked = await linkDocumentGemini(doc.id, storeId, geminiPath);
      if (!linked) await deleteFromStore([geminiPath], aiClient);
    } catch (error) {
      await deleteFromStore([geminiPath], aiClient).catch(() => undefined);
      throw error;
    }
    await assertLease(job);
    await updateDocumentStatus(doc.id, 'learned');
  } finally {
    if (tempPath) await fs.unlink(tempPath).catch(() => undefined);
  }
}

async function uploadDocumentToRag(job: KbOperationJob): Promise<void> {
  if (!job.document_id) throw new Error('KB document operation is missing document_id');
  const doc = await getDocument(job.document_id, job.tenant_id);
  if (!doc) return;
  if (!doc.file_path) throw new Error('Document has no file_path');

  const settings = await getTenantAiRuntimeSettings(job.tenant_id);
  let reservationId: string | null = null;
  try {
    const reservation = await reserveTenantAiTokens({
      tenantId: job.tenant_id,
      userId: null,
      conversationId: null,
      target: 'admin',
      engine: 'self_built_rag',
      provider: settings.provider,
      model: settings.embeddingModel,
      operation: 'indexing',
      estimatedTokens: estimateDocumentIndexTokens(doc),
    });
    reservationId = reservation.id;
    await assertLease(job);
    const result = await indexRagDocument({
      tenantId: job.tenant_id,
      kbId: job.kb_id,
      documentId: doc.id,
      embeddingModel: settings.embeddingModel,
      embeddingDimensions: settings.embeddingDimensions,
    });
    if (result.status !== 'learned') {
      throw new Error(result.error_reason || 'AI RAG không thể học tài liệu này');
    }
    await assertLease(job);
    await finalizeTenantAiTokens({
      reservationId,
      tenantId: job.tenant_id,
      embeddingModel: settings.embeddingModel,
      usage: {
        inputTokens: result.usage?.inputTokens ?? 0,
        outputTokens: result.usage?.outputTokens ?? 0,
        embeddingTokens: result.usage?.embeddingTokens ?? 0,
        totalTokens: result.usage?.totalTokens ?? result.usage?.embeddingTokens ?? 0,
      },
      source: { kb_id: job.kb_id, document_id: doc.id, operation_id: job.id },
      metadata: { chunk_count: result.chunk_count, engine: 'self_built_rag' },
    });
    const previous = previousFilePath(job);
    if (job.operation === 'document_reupload' && previous && previous !== doc.file_path) {
      await deleteFile(previous);
    }
    await updateDocumentStatus(doc.id, 'learned');
  } catch (error) {
    await releaseTenantAiTokenReservation(reservationId, job.tenant_id).catch(() => undefined);
    throw error;
  }
}

async function deleteDocumentResources(job: KbOperationJob): Promise<void> {
  const paths = Array.isArray(job.payload?.gemini_paths)
    ? job.payload.gemini_paths.filter((value): value is string => typeof value === 'string' && value.length > 0)
    : [];
  if (paths.length > 0) {
    const aiClient = await getGeminiClient(job.tenant_id);
    await deleteFromStore(paths, aiClient);
  }
  const filePath = typeof job.payload?.file_path === 'string' ? job.payload.file_path : null;
  if (filePath) await deleteFile(filePath);
  if (job.target_document_id) {
    await deleteRagDocument({
      tenantId: job.tenant_id,
      kbId: job.kb_id,
      documentId: job.target_document_id,
    }).catch((error) => {
      console.warn(`[KbOperationWorker] RAG document cache cleanup skipped for ${job.target_document_id}: ${errorMessage(error)}`);
    });
  }
  await assertLease(job);
  await invalidateTenantAiCaches(job.tenant_id);
}

async function deleteKnowledgebaseResources(job: KbOperationJob): Promise<void> {
  const documents = await query<{ file_path: string | null }>(
    `SELECT file_path FROM kb_documents WHERE kb_id = $1 AND tenant_id = $2`,
    [job.kb_id, job.tenant_id],
  );
  await deleteKbGeminiRemoteResources(job.kb_id, job.tenant_id);
  await deleteRagKnowledgebase({ tenantId: job.tenant_id, kbId: job.kb_id }).catch((error) => {
    console.warn(`[KbOperationWorker] RAG KB cache cleanup skipped for ${job.kb_id}: ${errorMessage(error)}`);
  });
  for (const document of documents.rows) {
    if (document.file_path) await deleteFile(document.file_path);
  }
  await assertLease(job);
  const removed = await query(
    `DELETE FROM knowledgebases kb
     WHERE kb.id = $1 AND kb.tenant_id = $2
       AND EXISTS (
         SELECT 1 FROM kb_operation_jobs job
         WHERE job.id = $3 AND job.status = 'running' AND job.lease_token = $4
           AND job.lease_expires_at > now()
       )`,
    [job.kb_id, job.tenant_id, job.id, job.lease_token],
  );
  if ((removed.rowCount || 0) !== 1) throw new Error(`Knowledge Base deletion lease lost: ${job.id}`);
  invalidateGeminiStoreNameCache(job.kb_id);
  await invalidateTenantAiCaches(job.tenant_id);
}

async function runKbOperation(job: KbOperationJob): Promise<void> {
  if (!job.lease_token) return;
  const renewEveryMs = Math.max(1_000, Math.floor((env.KB_OPERATION_WORKER_LEASE_SECONDS * 1000) / 3));
  let leaseLost = false;
  const heartbeat = setInterval(() => {
    renewKbOperationLease(job.id, job.lease_token!)
      .then((renewed) => { if (!renewed) leaseLost = true; })
      .catch(() => { leaseLost = true; });
  }, renewEveryMs);
  heartbeat.unref();

  // Keep a session-level per-KB lock across remote calls. Document jobs share
  // it; a whole-KB delete is exclusive. This prevents a late Gemini upload
  // from recreating remote state after a delete worker has started.
  let lockClient: Awaited<ReturnType<typeof getClient>> | null = null;
  const lockFunction = job.operation === 'knowledgebase_delete'
    ? 'pg_advisory_lock'
    : 'pg_advisory_lock_shared';
  const unlockFunction = job.operation === 'knowledgebase_delete'
    ? 'pg_advisory_unlock'
    : 'pg_advisory_unlock_shared';

  try {
    lockClient = await getClient();
    await lockClient.query(`SELECT ${lockFunction}(hashtextextended($1, 20260909))`, [`kb-operation:${job.kb_id}`]);
    await assertLease(job);
    if (job.operation === 'document_upload' || job.operation === 'document_reupload') {
      const settings = await getTenantAiRuntimeSettings(job.tenant_id);
      await getGoogleAiStudioApiKey(job.tenant_id);
      if (settings.activeEngine === 'self_built_rag') {
        await uploadDocumentToRag(job);
      } else {
        await uploadDocumentToGemini(job);
      }
    } else if (job.operation === 'document_delete') {
      await deleteDocumentResources(job);
    } else {
      await deleteKnowledgebaseResources(job);
    }
    // Whole-KB deletion cascades its own outbox row through the foreign key.
    const isCascadeCompletion = job.operation === 'knowledgebase_delete';
    if (leaseLost || (!isCascadeCompletion && !(await completeKbOperation(job.id, job.lease_token)))) {
      throw new Error(`KB operation lease lost before completion: ${job.id}`);
    }
  } catch (error) {
    const outcome = await failKbOperation(job, error).catch(() => ({ terminal: false, updated: false }));
    if (outcome.terminal && outcome.updated && job.document_id) {
      const message = job.operation === 'document_delete'
        ? `Không thể hoàn tất việc xoá tài liệu: ${errorMessage(error)}`
        : errorMessage(error);
      await updateDocumentStatus(job.document_id, 'error', message).catch(() => undefined);
    }
    console.error(`[KbOperationWorker] ${job.operation} ${job.id} failed: ${errorMessage(error)}`);
  } finally {
    if (lockClient) {
      try {
        await lockClient.query(`SELECT ${unlockFunction}(hashtextextended($1, 20260909))`, [`kb-operation:${job.kb_id}`]);
      } catch { /* connection cleanup releases a session lock if needed */ }
      lockClient.release();
    }
    clearInterval(heartbeat);
  }
}

async function runWithConcurrency(jobs: KbOperationJob[]): Promise<void> {
  const workers = Math.min(env.KB_OPERATION_WORKER_CONCURRENCY, jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: workers }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      await runKbOperation(job);
    }
  }));
}

async function drainDueKbOperations(): Promise<void> {
  if (drainInFlight) return;
  drainInFlight = true;
  try {
    const jobs = await claimDueKbOperations();
    if (jobs.length > 0) await runWithConcurrency(jobs);
  } catch (error) {
    console.error('[KbOperationWorker] Failed to claim due operations:', errorMessage(error));
  } finally {
    drainInFlight = false;
  }
}

export async function startKbOperationWorker(): Promise<void> {
  if (!env.KB_OPERATION_WORKER_ENABLED) {
    console.log('[KbOperationWorker] Disabled by KB_OPERATION_WORKER_ENABLED=false');
    return;
  }
  await drainDueKbOperations();
  setInterval(() => {
    void drainDueKbOperations();
  }, env.KB_OPERATION_WORKER_POLL_INTERVAL_MS).unref();
  console.log('[KbOperationWorker] Durable KB operation recovery started');
}
