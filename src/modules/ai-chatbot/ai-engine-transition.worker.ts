// ═══════════════════════════════════════════════════════════════
// AI engine transition worker
// Moves a tenant between Gemini File Search and self-built RAG without
// switching the active engine until the target index is ready.
// ═══════════════════════════════════════════════════════════════

import fs from 'fs/promises';
import { env } from '../../config/env.js';
import { getClient, query } from '../../config/database.js';
import { downloadToTempFile } from '../../config/storage.js';
import { invalidateTenantAiCaches } from '../../config/cache-invalidation.js';
import {
  deleteFromStore,
  ensureStore,
  getGeminiApiKeyFingerprint,
  getGeminiClient,
  uploadToStore,
} from './gemini.service.js';
import type { AiEngine } from './ai-engine.types.js';
import { getTenantAiRuntimeSettings } from './ai-settings.service.js';
import { deleteKbGeminiRemoteResources, linkDocumentGemini } from './kb.service.js';
import {
  estimateTokensFromText,
  finalizeTenantAiTokens,
  normalizeAiUsage,
  releaseTenantAiTokenReservation,
  reserveTenantAiTokens,
} from './ai-token-quota.service.js';
import { indexRagDocument } from './ai-rag-client.service.js';

interface AiEngineTransitionJob {
  id: string;
  tenant_id: string;
  from_engine: AiEngine;
  to_engine: AiEngine;
  status: 'queued' | 'running' | 'failed' | 'completed' | 'cancelled';
  phase: 'index_target' | 'switch_engine' | 'cleanup_source' | 'completed';
  attempt_count: number;
  lease_token: string | null;
  lease_expires_at: string | null;
}

interface TransitionDocumentRow {
  id: string;
  tenant_id: string;
  kb_id: string;
  name: string;
  content: string | null;
  file_path: string | null;
  source_info: Record<string, unknown> | null;
}

let drainInFlight = false;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sourceSize(sourceInfo: Record<string, unknown> | null): number {
  const value = sourceInfo?.size;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function estimateDocumentIndexTokens(doc: TransitionDocumentRow): number {
  const contentEstimate = estimateTokensFromText(doc.content, doc.name);
  const fileEstimate = Math.ceil(sourceSize(doc.source_info) / 8);
  return Math.max(env.AI_INDEX_TOKEN_RESERVE_ESTIMATE, contentEstimate, fileEstimate);
}

async function claimDueAiEngineTransitionJobs(): Promise<AiEngineTransitionJob[]> {
  const claimed = await query<AiEngineTransitionJob>(
    `WITH candidates AS (
       SELECT id
       FROM ai_engine_transition_jobs
       WHERE (status = 'queued' AND next_attempt_at <= now())
          OR (
            status = 'queued'
            AND to_engine = 'self_built_rag'
            AND (
              last_error ILIKE '%text-embedding-004%'
              OR last_error ILIKE '%EmbedContentConfig%'
              OR last_error ILIKE '%rag_chunks_index_id_content_hash_key%'
              OR (phase = 'cleanup_source' AND last_error ILIKE '%File Search store%')
              OR (phase = 'cleanup_source' AND last_error ILIKE '%PERMISSION_DENIED%')
            )
          )
          OR (status = 'running' AND lease_expires_at <= now())
       ORDER BY updated_at ASC, id ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE ai_engine_transition_jobs job
     SET status = 'running',
         attempt_count = job.attempt_count + 1,
         lease_token = gen_random_uuid(),
         lease_expires_at = now() + ($2::int * interval '1 second'),
         started_at = COALESCE(started_at, now()),
         last_error = NULL,
         updated_at = now()
     FROM candidates
     WHERE job.id = candidates.id
     RETURNING job.id::text, job.tenant_id::text, job.from_engine, job.to_engine,
               job.status, job.phase, job.attempt_count,
               job.lease_token::text, job.lease_expires_at::text`,
    [env.AI_ENGINE_TRANSITION_WORKER_BATCH_SIZE, env.AI_ENGINE_TRANSITION_WORKER_LEASE_SECONDS],
  );
  return claimed.rows;
}

async function renewTransitionLease(job: AiEngineTransitionJob): Promise<boolean> {
  if (!job.lease_token) return false;
  const renewed = await query(
    `UPDATE ai_engine_transition_jobs
     SET lease_expires_at = now() + ($3::int * interval '1 second'),
         updated_at = now()
     WHERE id = $1
       AND status = 'running'
       AND lease_token = $2::uuid
       AND lease_expires_at > now()`,
    [job.id, job.lease_token, env.AI_ENGINE_TRANSITION_WORKER_LEASE_SECONDS],
  );
  return (renewed.rowCount || 0) === 1;
}

async function assertTransitionLease(job: AiEngineTransitionJob): Promise<void> {
  if (!(await renewTransitionLease(job))) {
    throw new Error(`AI engine transition lease lost: ${job.id}`);
  }
}

async function yieldTransitionJob(job: AiEngineTransitionJob): Promise<void> {
  if (!job.lease_token) return;
  await query(
    `UPDATE ai_engine_transition_jobs
     SET status = 'queued',
         next_attempt_at = now(),
         lease_token = NULL,
         lease_expires_at = NULL,
         updated_at = now()
     WHERE id = $1
       AND status = 'running'
       AND lease_token = $2::uuid
       AND lease_expires_at > now()`,
    [job.id, job.lease_token],
  );
}

async function failTransitionJob(job: AiEngineTransitionJob, error: unknown): Promise<void> {
  if (!job.lease_token) return;
  const terminal = job.attempt_count >= env.AI_ENGINE_TRANSITION_WORKER_MAX_ATTEMPTS;
  const reason = errorMessage(error).slice(0, 1000);
  const backoffSeconds = Math.min(
    env.AI_ENGINE_TRANSITION_WORKER_RETRY_MAX_SECONDS,
    env.AI_ENGINE_TRANSITION_WORKER_RETRY_BASE_SECONDS * (2 ** Math.min(Math.max(job.attempt_count - 1, 0), 10)),
  );
  await query(
    `UPDATE ai_engine_transition_jobs
     SET status = CASE WHEN $3::boolean THEN 'failed' ELSE 'queued' END,
         next_attempt_at = CASE WHEN $3::boolean THEN next_attempt_at ELSE now() + ($4::int * interval '1 second') END,
         lease_token = NULL,
         lease_expires_at = NULL,
         last_error = $5,
         updated_at = now()
     WHERE id = $1
       AND status = 'running'
       AND lease_token = $2::uuid`,
    [job.id, job.lease_token, terminal, backoffSeconds, reason],
  );
  if (terminal) {
    await query(
      `UPDATE tenant_ai_settings
       SET transition_state = CASE WHEN active_engine = $3 THEN 'idle' ELSE 'failed' END,
           active_transition_job_id = CASE WHEN active_engine = $3 THEN NULL ELSE active_transition_job_id END,
           updated_at = now()
       WHERE tenant_id = $1
         AND active_transition_job_id = $2::uuid`,
      [job.tenant_id, job.id, job.to_engine],
    );
    await invalidateTenantAiCaches(job.tenant_id);
  }
}

async function countEligibleDocuments(tenantId: string): Promise<number> {
  const result = await query<{ total: string }>(
    `SELECT COUNT(*)::bigint::text AS total
     FROM kb_documents
     WHERE tenant_id = $1
       AND status = 'learned'
       AND file_path IS NOT NULL`,
    [tenantId],
  );
  return Number(result.rows[0]?.total ?? 0);
}

async function assertNoBusyDocuments(tenantId: string): Promise<void> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*)::bigint::text AS count
     FROM kb_documents
     WHERE tenant_id = $1
       AND status IN ('learning', 'deleting')`,
    [tenantId],
  );
  if (Number(result.rows[0]?.count ?? 0) > 0) {
    throw new Error('Tenant đang có tài liệu Knowledge Base đang xử lý. Vui lòng đợi xong rồi chuyển loại AI.');
  }
}

async function initializeTransition(job: AiEngineTransitionJob): Promise<void> {
  await assertTransitionLease(job);
  await assertNoBusyDocuments(job.tenant_id);
  const totalDocuments = await countEligibleDocuments(job.tenant_id);
  await query(
    `UPDATE ai_engine_transition_jobs
     SET total_documents = $3::bigint,
         phase = CASE WHEN phase = 'completed' THEN phase ELSE phase END,
         updated_at = now()
     WHERE id = $1
       AND status = 'running'
       AND lease_token = $2::uuid`,
    [job.id, job.lease_token, totalDocuments],
  );
  const settings = await query<{ active_engine: AiEngine; active_transition_job_id: string | null }>(
    `UPDATE tenant_ai_settings
     SET transition_state = 'running',
         updated_at = now()
     WHERE tenant_id = $1
       AND active_transition_job_id = $2::uuid
     RETURNING active_engine, active_transition_job_id::text`,
    [job.tenant_id, job.id],
  );
  const current = settings.rows[0];
  if (!current) throw new Error('Không tìm thấy cấu hình AI đang chuyển đổi cho tenant.');
  if (current.active_engine === job.to_engine) {
    await query(
      `UPDATE ai_engine_transition_jobs
       SET phase = 'cleanup_source',
           updated_at = now()
       WHERE id = $1 AND lease_token = $2::uuid`,
      [job.id, job.lease_token],
    );
    job.phase = 'cleanup_source';
  } else if (current.active_engine !== job.from_engine) {
    throw new Error(`Active engine hiện tại không khớp job chuyển đổi: ${current.active_engine}`);
  }
}

async function selectMissingRagDocuments(tenantId: string, limit: number): Promise<TransitionDocumentRow[]> {
  const result = await query<TransitionDocumentRow>(
    `SELECT d.id::text, d.tenant_id::text, d.kb_id::text, d.name, d.content,
            d.file_path, d.source_info
     FROM kb_documents d
     WHERE d.tenant_id = $1
       AND d.status = 'learned'
       AND d.file_path IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
         FROM rag_document_indexes r
         WHERE r.document_id = d.id
           AND r.engine = 'self_built_rag'
           AND r.status = 'learned'
           AND r.is_active = true
       )
     ORDER BY d.created_at ASC, d.id ASC
     LIMIT $2`,
    [tenantId, limit],
  );
  return result.rows;
}

async function countReadyRagDocuments(tenantId: string): Promise<number> {
  const result = await query<{ total: string }>(
    `SELECT COUNT(*)::bigint::text AS total
     FROM kb_documents d
     WHERE d.tenant_id = $1
       AND d.status = 'learned'
       AND d.file_path IS NOT NULL
       AND EXISTS (
         SELECT 1
         FROM rag_document_indexes r
         WHERE r.document_id = d.id
           AND r.engine = 'self_built_rag'
           AND r.status = 'learned'
           AND r.is_active = true
       )`,
    [tenantId],
  );
  return Number(result.rows[0]?.total ?? 0);
}

async function indexDocumentToRag(job: AiEngineTransitionJob, doc: TransitionDocumentRow): Promise<void> {
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
    const result = await indexRagDocument({
      tenantId: job.tenant_id,
      kbId: doc.kb_id,
      documentId: doc.id,
      embeddingModel: settings.embeddingModel,
      embeddingDimensions: settings.embeddingDimensions,
    });
    if (result.status !== 'learned') {
      throw new Error(result.error_reason || `Không thể index RAG cho tài liệu ${doc.id}`);
    }
    await finalizeTenantAiTokens({
      reservationId,
      tenantId: job.tenant_id,
      embeddingModel: settings.embeddingModel,
      usage: normalizeAiUsage(result.usage ?? { embeddingTokens: estimateDocumentIndexTokens(doc) }),
      source: { transition_job_id: job.id, kb_id: doc.kb_id, document_id: doc.id },
      metadata: { transition: true, engine: 'self_built_rag', chunk_count: result.chunk_count },
    });
  } catch (error) {
    await releaseTenantAiTokenReservation(reservationId, job.tenant_id).catch(() => undefined);
    throw error;
  }
}

async function selectMissingGeminiDocuments(tenantId: string, limit: number): Promise<TransitionDocumentRow[]> {
  const result = await query<TransitionDocumentRow>(
    `SELECT d.id::text, d.tenant_id::text, d.kb_id::text, d.name, d.content,
            d.file_path, d.source_info
     FROM kb_documents d
     WHERE d.tenant_id = $1
       AND d.status = 'learned'
       AND d.file_path IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM kb_doc_gemini_mapping m WHERE m.document_id = d.id
       )
     ORDER BY d.created_at ASC, d.id ASC
     LIMIT $2`,
    [tenantId, limit],
  );
  return result.rows;
}

async function countReadyGeminiDocuments(tenantId: string): Promise<number> {
  const result = await query<{ total: string }>(
    `SELECT COUNT(*)::bigint::text AS total
     FROM kb_documents d
     WHERE d.tenant_id = $1
       AND d.status = 'learned'
       AND d.file_path IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM kb_doc_gemini_mapping m WHERE m.document_id = d.id
       )`,
    [tenantId],
  );
  return Number(result.rows[0]?.total ?? 0);
}

async function countReadyTargetDocuments(job: AiEngineTransitionJob): Promise<number> {
  return job.to_engine === 'self_built_rag'
    ? countReadyRagDocuments(job.tenant_id)
    : countReadyGeminiDocuments(job.tenant_id);
}

async function updateIndexTargetProgress(
  job: AiEngineTransitionJob,
  totalDocuments: number,
): Promise<number> {
  const readyDocuments = await countReadyTargetDocuments(job);
  await query(
    `UPDATE ai_engine_transition_jobs
     SET total_documents = $3::bigint,
         processed_documents = $4::bigint,
         updated_at = now()
     WHERE id = $1
       AND status = 'running'
       AND lease_token = $2::uuid`,
    [job.id, job.lease_token, totalDocuments, readyDocuments],
  );
  return readyDocuments;
}

async function uploadDocumentToGemini(job: AiEngineTransitionJob, doc: TransitionDocumentRow): Promise<void> {
  if (!doc.file_path) throw new Error(`Tài liệu ${doc.id} không có file_path.`);
  const settings = await getTenantAiRuntimeSettings(job.tenant_id);
  let reservationId: string | null = null;
  let tempPath: string | null = null;
  try {
    const reservation = await reserveTenantAiTokens({
      tenantId: job.tenant_id,
      userId: null,
      conversationId: null,
      target: 'admin',
      engine: 'gemini_file_search',
      provider: settings.provider,
      model: settings.embeddingModel,
      operation: 'indexing',
      estimatedTokens: estimateDocumentIndexTokens(doc),
    });
    reservationId = reservation.id;
    tempPath = await downloadToTempFile(doc.file_path, env.GEMINI_TEMP_DIR);
    const [aiClient, apiKeyFingerprint] = await Promise.all([
      getGeminiClient(job.tenant_id),
      getGeminiApiKeyFingerprint(job.tenant_id),
    ]);
    const { storeId, storeName } = await ensureStore(doc.kb_id, aiClient, apiKeyFingerprint);
    const geminiPath = await uploadToStore(storeName, tempPath, doc.name || `doc-${doc.id}`, aiClient);
    try {
      const linked = await linkDocumentGemini(doc.id, storeId, geminiPath);
      if (!linked) await deleteFromStore([geminiPath], aiClient);
    } catch (error) {
      await deleteFromStore([geminiPath], aiClient).catch(() => undefined);
      throw error;
    }
    await finalizeTenantAiTokens({
      reservationId,
      tenantId: job.tenant_id,
      embeddingModel: settings.embeddingModel,
      usage: normalizeAiUsage({ embeddingTokens: estimateDocumentIndexTokens(doc) }),
      source: { transition_job_id: job.id, kb_id: doc.kb_id, document_id: doc.id },
      metadata: { transition: true, engine: 'gemini_file_search' },
    });
  } catch (error) {
    await releaseTenantAiTokenReservation(reservationId, job.tenant_id).catch(() => undefined);
    throw error;
  } finally {
    if (tempPath) await fs.unlink(tempPath).catch(() => undefined);
  }
}

async function processIndexTarget(job: AiEngineTransitionJob): Promise<boolean> {
  const totalDocuments = await countEligibleDocuments(job.tenant_id);
  const docs = job.to_engine === 'self_built_rag'
    ? await selectMissingRagDocuments(job.tenant_id, env.AI_ENGINE_TRANSITION_WORKER_BATCH_SIZE)
    : await selectMissingGeminiDocuments(job.tenant_id, env.AI_ENGINE_TRANSITION_WORKER_BATCH_SIZE);

  for (const doc of docs) {
    await assertTransitionLease(job);
    console.log(`[AiEngineTransitionWorker] Indexing document ${doc.id} for job ${job.id}`);
    if (job.to_engine === 'self_built_rag') {
      await indexDocumentToRag(job, doc);
    } else {
      await uploadDocumentToGemini(job, doc);
    }
    const readyDocuments = await updateIndexTargetProgress(job, totalDocuments);
    console.log(`[AiEngineTransitionWorker] Job ${job.id} indexed ${readyDocuments}/${totalDocuments} documents`);
  }

  const readyDocuments = await updateIndexTargetProgress(job, totalDocuments);
  return readyDocuments >= totalDocuments;
}

async function switchTenantEngine(job: AiEngineTransitionJob): Promise<void> {
  await assertTransitionLease(job);
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const updated = await client.query(
      `UPDATE tenant_ai_settings
       SET active_engine = $3,
           transition_state = 'running',
           updated_at = now()
       WHERE tenant_id = $1
         AND active_transition_job_id = $2::uuid
       RETURNING tenant_id`,
      [job.tenant_id, job.id, job.to_engine],
    );
    if ((updated.rowCount || 0) !== 1) throw new Error('Không thể cập nhật active engine cho tenant.');
    await client.query(
      `UPDATE ai_engine_transition_jobs
       SET phase = 'cleanup_source',
           updated_at = now()
       WHERE id = $1
         AND status = 'running'
         AND lease_token = $2::uuid`,
      [job.id, job.lease_token],
    );
    await client.query('COMMIT');
    job.phase = 'cleanup_source';
    await invalidateTenantAiCaches(job.tenant_id);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function cleanupGeminiDataForTenant(job: AiEngineTransitionJob): Promise<boolean> {
  const candidate = await query<{ kb_id: string }>(
    `SELECT kb.id::text AS kb_id
     FROM knowledgebases kb
     WHERE kb.tenant_id = $1
       AND (
         EXISTS (SELECT 1 FROM kb_google_store store WHERE store.kb_id = kb.id)
         OR EXISTS (
           SELECT 1
           FROM kb_doc_gemini_mapping mapping
           JOIN kb_documents doc ON doc.id = mapping.document_id
           WHERE doc.kb_id = kb.id
         )
       )
     ORDER BY kb.created_at ASC, kb.id ASC
     LIMIT 1`,
    [job.tenant_id],
  );
  const kbId = candidate.rows[0]?.kb_id;
  if (!kbId) return true;

  try {
    await deleteKbGeminiRemoteResources(kbId, job.tenant_id);
  } catch (error) {
    console.warn(
      `[AiEngineTransitionWorker] File Search remote cleanup skipped for kb ${kbId}: ${errorMessage(error)}`,
    );
  }
  await query(
    `WITH doomed AS (
       SELECT mapping.ctid
       FROM kb_doc_gemini_mapping mapping
       JOIN kb_documents doc ON doc.id = mapping.document_id
       WHERE doc.kb_id = $1
         AND doc.tenant_id = $2
       LIMIT 5000
     )
     DELETE FROM kb_doc_gemini_mapping mapping
     USING doomed
     WHERE mapping.ctid = doomed.ctid`,
    [kbId, job.tenant_id],
  );
  const remainingMappings = await query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM kb_doc_gemini_mapping mapping
       JOIN kb_documents doc ON doc.id = mapping.document_id
       WHERE doc.kb_id = $1
         AND doc.tenant_id = $2
     ) AS exists`,
    [kbId, job.tenant_id],
  );
  if (remainingMappings.rows[0]?.exists) return false;
  await query(`DELETE FROM kb_google_store WHERE kb_id = $1`, [kbId]);
  return false;
}

async function cleanupRagDataForTenant(job: AiEngineTransitionJob): Promise<boolean> {
  const deletedChunks = await query(
    `WITH doomed AS (
       SELECT ctid
       FROM rag_chunks
       WHERE tenant_id = $1
       LIMIT 5000
     )
     DELETE FROM rag_chunks chunk
     USING doomed
     WHERE chunk.ctid = doomed.ctid`,
    [job.tenant_id],
  );
  if ((deletedChunks.rowCount || 0) > 0) return false;

  const deletedIndexes = await query(
    `WITH doomed AS (
       SELECT ctid
       FROM rag_document_indexes
       WHERE tenant_id = $1
       LIMIT 1000
     )
     DELETE FROM rag_document_indexes index_row
     USING doomed
     WHERE index_row.ctid = doomed.ctid`,
    [job.tenant_id],
  );
  return (deletedIndexes.rowCount || 0) === 0;
}

async function completeTransitionJob(job: AiEngineTransitionJob): Promise<void> {
  await assertTransitionLease(job);
  await query(
    `UPDATE tenant_ai_settings
     SET transition_state = 'idle',
         active_transition_job_id = NULL,
         updated_at = now()
     WHERE tenant_id = $1
       AND active_transition_job_id = $2::uuid
       AND active_engine = $3`,
    [job.tenant_id, job.id, job.to_engine],
  );
  await query(
    `UPDATE ai_engine_transition_jobs
     SET status = 'completed',
         phase = 'completed',
         lease_token = NULL,
         lease_expires_at = NULL,
         completed_at = now(),
         updated_at = now()
     WHERE id = $1
       AND status = 'running'
       AND lease_token = $2::uuid`,
    [job.id, job.lease_token],
  );
  await invalidateTenantAiCaches(job.tenant_id);
}

async function runTransitionJob(job: AiEngineTransitionJob): Promise<void> {
  let leaseLost = false;
  const heartbeat = setInterval(() => {
    renewTransitionLease(job)
      .then((renewed) => { if (!renewed) leaseLost = true; })
      .catch(() => { leaseLost = true; });
  }, Math.max(1_000, Math.floor((env.AI_ENGINE_TRANSITION_WORKER_LEASE_SECONDS * 1000) / 3)));
  heartbeat.unref();

  try {
    await initializeTransition(job);
    if (job.phase === 'index_target') {
      const ready = await processIndexTarget(job);
      if (!ready) {
        await yieldTransitionJob(job);
        return;
      }
      await query(
        `UPDATE ai_engine_transition_jobs
         SET phase = 'switch_engine',
             updated_at = now()
         WHERE id = $1
           AND status = 'running'
           AND lease_token = $2::uuid`,
        [job.id, job.lease_token],
      );
      job.phase = 'switch_engine';
    }
    if (job.phase === 'switch_engine') {
      await switchTenantEngine(job);
    }
    if (job.phase === 'cleanup_source') {
      const cleanupDone = job.from_engine === 'gemini_file_search'
        ? await cleanupGeminiDataForTenant(job)
        : await cleanupRagDataForTenant(job);
      if (!cleanupDone) {
        await query(
          `UPDATE ai_engine_transition_jobs
           SET cleanup_processed_documents = cleanup_processed_documents + 1,
               updated_at = now()
           WHERE id = $1
             AND status = 'running'
             AND lease_token = $2::uuid`,
          [job.id, job.lease_token],
        );
        await yieldTransitionJob(job);
        return;
      }
    }
    if (leaseLost) throw new Error(`AI engine transition lease lost before completion: ${job.id}`);
    await completeTransitionJob(job);
  } catch (error) {
    await failTransitionJob(job, error).catch((failError) => {
      console.error(`[AiEngineTransitionWorker] Failed to mark job ${job.id} failed: ${errorMessage(failError)}`);
    });
    console.error(`[AiEngineTransitionWorker] Job ${job.id} failed: ${errorMessage(error)}`);
  } finally {
    clearInterval(heartbeat);
  }
}

async function drainDueTransitions(): Promise<void> {
  if (drainInFlight) return;
  drainInFlight = true;
  try {
    const jobs = await claimDueAiEngineTransitionJobs();
    for (const job of jobs) {
      await runTransitionJob(job);
    }
  } catch (error) {
    console.error('[AiEngineTransitionWorker] Failed to claim due jobs:', errorMessage(error));
  } finally {
    drainInFlight = false;
  }
}

export async function startAiEngineTransitionWorker(): Promise<void> {
  if (!env.AI_ENGINE_TRANSITION_WORKER_ENABLED) {
    console.log('[AiEngineTransitionWorker] Disabled by AI_ENGINE_TRANSITION_WORKER_ENABLED=false');
    return;
  }
  await drainDueTransitions();
  setInterval(() => {
    void drainDueTransitions();
  }, env.AI_ENGINE_TRANSITION_WORKER_POLL_INTERVAL_MS).unref();
  console.log('[AiEngineTransitionWorker] Durable AI engine transition worker started');
}
