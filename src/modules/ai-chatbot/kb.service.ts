// ═══════════════════════════════════════════════════════════════
// KB Service — Knowledge Base + Document CRUD
// ═══════════════════════════════════════════════════════════════

import { randomUUID } from 'crypto';
import { getClient, query } from '../../config/database.js';
import { cacheKey } from '../../config/cache.js';
import { invalidateTenantAiCaches } from '../../config/cache-invalidation.js';
import { uploadFile, buildStoragePath, buildFileName, deleteFile } from '../../config/storage.js';
import { publish, QUEUES } from '../../config/rabbitmq/index.js';
import { getRedisClient } from '../../config/redis.js';
import type { CreateKbInput, UpdateKbInput, CreateArticleInput, UpdateArticleInput } from './kb.validator.js';
import * as XLSX from 'xlsx';
import fs from 'fs/promises';
import path from 'path';
import { env } from '../../config/env.js';
import {
  deleteFileSearchStoreIfExists,
  deleteFromStore,
  getGeminiApiKeyFingerprint,
  getGeminiClient,
  getOptionalGeminiApiKeyFingerprint,
  isGeminiPermissionDeniedError,
  markKbGeminiStoreRemoteProblem,
} from './gemini.service.js';

const LOCAL_SOURCE_CONTENT_EXTENSIONS = new Set(['.txt', '.md', '.csv']);
const MAX_STORED_SOURCE_CONTENT_CHARS = 200_000;
const KB_RESTORE_LOCK_TTL_SECONDS = 6 * 60 * 60;
const ACTIVE_RESTORE_STATES = new Set(['queued', 'restoring', 'uploading']);
const RESTORE_REQUIRED_STORE_STATUSES = new Set(['key_changed', 'permission_denied', 'not_found']);

function extractLocalSourceContent(ext: string, buffer: Buffer): string | null {
  if (!LOCAL_SOURCE_CONTENT_EXTENSIONS.has(ext)) return null;
  const text = buffer.toString('utf8').replace(/\u0000/g, '').trim();
  return text ? text.slice(0, MAX_STORED_SOURCE_CONTENT_CHARS) : null;
}

// ── Types ──
export interface Knowledgebase {
  id: string;
  tenant_id: string;
  name: string;
  description: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  document_count?: number;
  restore_state?: KbRestoreState;
  active_restore_job_id?: string | null;
  restore_error_reason?: string | null;
  restore_started_at?: string | null;
  restore_finished_at?: string | null;
  restore_required?: boolean;
  restore_reason?: string | null;
  restore_progress?: KbRestoreProgress | null;
}

type KbRestoreState = 'idle' | 'queued' | 'restoring' | 'uploading' | 'completed' | 'failed';

interface KbRestoreProgress {
  total_docs: number;
  enqueued_docs: number;
  learned_docs: number;
  failed_docs: number;
  skipped_docs: number;
}

export interface KbDocument {
  id: string;
  tenant_id: string;
  kb_id: string;
  type: string;
  name: string;
  status: string;
  error_reason: string | null;
  source_info: Record<string, unknown>;
  file_path: string | null;
  content: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

interface KbGeminiStore {
  id: string;
  store_name: string;
  api_key_fingerprint: string | null;
  remote_status: string;
  remote_error_code: string | null;
  remote_error_reason: string | null;
}

interface KbGeminiMapping {
  gemini_path: string;
}

export interface RestoreKnowledgebaseResult {
  restored: number;
  enqueued: number;
  failed_to_enqueue: number;
  skipped_no_file: number;
  deleted_stores: number;
  deleted_mappings: number;
  orphaned_stores: number;
  upload_publish_failed: boolean;
}

export interface EnqueueRestoreKnowledgebaseResult {
  queued: true;
  job_id: string;
  kb_id: string;
  lock_ttl_seconds: number;
}

async function getKbGeminiStores(kbId: string): Promise<KbGeminiStore[]> {
  const stores = await query<KbGeminiStore>(
    `SELECT id, store_name, api_key_fingerprint, remote_status, remote_error_code, remote_error_reason
     FROM kb_google_store
     WHERE kb_id = $1`,
    [kbId],
  );
  return stores.rows;
}

async function getKbGeminiMappings(kbId: string, tenantId: string): Promise<KbGeminiMapping[]> {
  const mappings = await query<KbGeminiMapping>(
    `SELECT m.gemini_path FROM kb_doc_gemini_mapping m
     JOIN kb_documents d ON d.id = m.document_id
     WHERE d.kb_id = $1 AND d.tenant_id = $2`,
    [kbId, tenantId],
  );
  return mappings.rows;
}

async function deleteKbGeminiRemoteResources(
  kbId: string,
  tenantId: string,
): Promise<{ deletedStores: number; deletedMappings: number }> {
  const [stores, mappings] = await Promise.all([
    getKbGeminiStores(kbId),
    getKbGeminiMappings(kbId, tenantId),
  ]);

  if (stores.length === 0 && mappings.length === 0) {
    return { deletedStores: 0, deletedMappings: 0 };
  }

  const aiClient = await getGeminiClient(tenantId);
  if (stores.length > 0) {
    for (const store of stores) {
      await deleteFileSearchStoreIfExists(store.store_name, aiClient);
    }
  } else if (mappings.length > 0) {
    await deleteFromStore(mappings.map(m => m.gemini_path), aiClient);
  }

  return { deletedStores: stores.length, deletedMappings: mappings.length };
}

async function deleteDocumentGeminiMappingsStrict(
  docIds: string[],
  tenantId: string,
): Promise<number> {
  if (docIds.length === 0) return 0;

  const mappings = await query<KbGeminiMapping>(
    `SELECT m.gemini_path FROM kb_doc_gemini_mapping m
     JOIN kb_documents d ON d.id = m.document_id
     WHERE d.id = ANY($1) AND d.tenant_id = $2`,
    [docIds, tenantId],
  );

  if (!mappings.rowCount || mappings.rowCount === 0) return 0;
  const aiClient = await getGeminiClient(tenantId);
  await deleteFromStore(mappings.rows.map(r => r.gemini_path), aiClient);
  return mappings.rows.length;
}

function kbRestoreLockKey(tenantId: string, kbId: string): string {
  return cacheKey('ai-chatbot', 'kb-restore-lock', tenantId, kbId);
}

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

function isRestoreActiveState(state?: string | null): boolean {
  return ACTIVE_RESTORE_STATES.has(state || '');
}

function getRestoreReasonFromStore(
  store: Pick<KbGeminiStore, 'api_key_fingerprint' | 'remote_status' | 'remote_error_reason'> | null | undefined,
  currentFingerprint: string | null,
): string | null {
  if (!store) return null;
  if (RESTORE_REQUIRED_STORE_STATUSES.has(store.remote_status)) {
    return store.remote_error_reason || store.remote_status;
  }
  if (store.remote_status !== 'active') return null;
  if (!currentFingerprint) return 'Gemini API key is missing. Configure a key before restoring this KB.';
  if (store.api_key_fingerprint && store.api_key_fingerprint !== currentFingerprint) return 'Gemini API key was changed.';
  return null;
}

function restoreRequiredSql(currentFingerprintParam: string): string {
  return `(
    kgs.id IS NOT NULL
    AND (
      kgs.remote_status IN ('key_changed', 'permission_denied', 'not_found')
      OR (
        kgs.remote_status = 'active'
        AND kgs.api_key_fingerprint IS NOT NULL
        AND ${currentFingerprintParam}::text IS NOT NULL
        AND kgs.api_key_fingerprint <> ${currentFingerprintParam}::text
      )
    )
  )`;
}

function mapKnowledgebaseRow<T extends Record<string, any>>(row: T): Knowledgebase {
  const {
    full_count,
    total_docs,
    enqueued_docs,
    learned_docs,
    failed_docs,
    skipped_docs,
    ...rest
  } = row;
  const progress =
    total_docs !== undefined && total_docs !== null
      ? {
          total_docs: Number(total_docs) || 0,
          enqueued_docs: Number(enqueued_docs) || 0,
          learned_docs: Number(learned_docs) || 0,
          failed_docs: Number(failed_docs) || 0,
          skipped_docs: Number(skipped_docs) || 0,
        }
      : null;
  return {
    ...(rest as Knowledgebase),
    restore_required: Boolean(rest.restore_required),
    restore_reason: rest.restore_reason ?? null,
    restore_progress: progress,
  };
}

async function assertKnowledgebaseMutable(
  kbId: string,
  tenantId: string,
  actionLabel = 'thay doi tai lieu',
): Promise<void> {
  const currentFingerprint = await getOptionalGeminiApiKeyFingerprint(tenantId);
  const result = await query<{
    id: string;
    restore_state: string | null;
    api_key_fingerprint: string | null;
    remote_status: string | null;
    remote_error_reason: string | null;
  }>(
    `SELECT kb.id, kb.restore_state,
            kgs.api_key_fingerprint, kgs.remote_status, kgs.remote_error_reason
     FROM knowledgebases kb
     LEFT JOIN kb_google_store kgs ON kgs.kb_id = kb.id
     WHERE kb.id = $1 AND kb.tenant_id = $2
     LIMIT 1`,
    [kbId, tenantId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Knowledge Base khong ton tai');
  if (isRestoreActiveState(row.restore_state)) {
    throw new Error(`Kho tri thuc dang khoi phuc, tam thoi khong the ${actionLabel}.`);
  }
  const reason = getRestoreReasonFromStore(
    row.remote_status
      ? {
          api_key_fingerprint: row.api_key_fingerprint,
          remote_status: row.remote_status,
          remote_error_reason: row.remote_error_reason,
        }
      : null,
    currentFingerprint,
  );
  if (reason) {
    throw new Error(`Kho tri thuc can khoi phuc truoc khi ${actionLabel}. Ly do: ${reason}`);
  }
}

// ═══════════════════════════════════════
// Knowledge Base CRUD
// ═══════════════════════════════════════

export async function listKnowledgebases(
  tenantId: string,
  opts: { page?: number; pageSize?: number; search?: string } = {},
): Promise<{ data: Knowledgebase[]; total: number }> {
  const { page = 1, pageSize = 10, search } = opts;
  const offset = (page - 1) * pageSize;
  const currentFingerprint = await getOptionalGeminiApiKeyFingerprint(tenantId);

  const conditions: string[] = ['kb.tenant_id = $1'];
  const params: unknown[] = [tenantId, currentFingerprint];
  let idx = 3;

  if (search?.trim()) {
    conditions.push(`kb.name ILIKE $${idx++}`);
    params.push(`%${search.trim()}%`);
  }

  const where = conditions.join(' AND ');
  params.push(pageSize, offset);

  const result = await query<Record<string, any>>(
    `SELECT kb.*, COALESCE(dc.cnt, 0)::int AS document_count,
            ${restoreRequiredSql('$2')} AS restore_required,
            CASE
              WHEN ${restoreRequiredSql('$2')} THEN
                COALESCE(kgs.remote_error_reason, 'Gemini API key changed or cannot access the current store.')
              ELSE NULL
            END AS restore_reason,
            j.total_docs, j.enqueued_docs, j.learned_docs, j.failed_docs, j.skipped_docs,
            COUNT(*) OVER() AS full_count
     FROM knowledgebases kb
     LEFT JOIN kb_google_store kgs ON kgs.kb_id = kb.id
     LEFT JOIN (
       SELECT kb_id, COUNT(*)::int AS cnt FROM kb_documents GROUP BY kb_id
     ) dc ON dc.kb_id = kb.id
     LEFT JOIN kb_restore_jobs j ON j.id = kb.active_restore_job_id
     WHERE ${where}
     ORDER BY kb.created_at DESC
     LIMIT $${idx++} OFFSET $${idx++}`,
    params,
  );

  const total = parseInt(result.rows[0]?.full_count ?? '0');
  const data = result.rows.map(mapKnowledgebaseRow);

  return { data, total };
}

export async function getKnowledgebase(id: string, tenantId: string): Promise<Knowledgebase | null> {
  const currentFingerprint = await getOptionalGeminiApiKeyFingerprint(tenantId);
  const result = await query<Record<string, any>>(
    `SELECT kb.*, COALESCE(dc.cnt, 0)::int AS document_count,
            ${restoreRequiredSql('$3')} AS restore_required,
            CASE
              WHEN ${restoreRequiredSql('$3')} THEN
                COALESCE(kgs.remote_error_reason, 'Gemini API key changed or cannot access the current store.')
              ELSE NULL
            END AS restore_reason,
            j.total_docs, j.enqueued_docs, j.learned_docs, j.failed_docs, j.skipped_docs
     FROM knowledgebases kb
     LEFT JOIN kb_google_store kgs ON kgs.kb_id = kb.id
     LEFT JOIN (
       SELECT kb_id, COUNT(*)::int AS cnt FROM kb_documents GROUP BY kb_id
     ) dc ON dc.kb_id = kb.id
     LEFT JOIN kb_restore_jobs j ON j.id = kb.active_restore_job_id
     WHERE kb.id = $1 AND kb.tenant_id = $2
     LIMIT 1`,
    [id, tenantId, currentFingerprint],
  );
  return result.rows[0] ? mapKnowledgebaseRow(result.rows[0]) : null;
}

export async function createKnowledgebase(tenantId: string, input: CreateKbInput, userId: string): Promise<Knowledgebase> {
  const result = await query<Knowledgebase>(
    `INSERT INTO knowledgebases (tenant_id, name, description, created_by)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [tenantId, input.name, input.description || '', userId],
  );
  await invalidateTenantAiCaches(tenantId);
  return result.rows[0];
}

export async function updateKnowledgebase(id: string, tenantId: string, input: UpdateKbInput): Promise<Knowledgebase | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (input.name !== undefined) { sets.push(`name = $${idx++}`); params.push(input.name); }
  if (input.description !== undefined) { sets.push(`description = $${idx++}`); params.push(input.description); }
  sets.push(`updated_at = now()`);

  if (sets.length <= 1) return getKnowledgebase(id, tenantId); // nothing to update

  params.push(id, tenantId);
  const result = await query<Knowledgebase>(
    `UPDATE knowledgebases SET ${sets.join(', ')} WHERE id = $${idx++} AND tenant_id = $${idx++} RETURNING *`,
    params,
  );
  if (result.rows[0]) await invalidateTenantAiCaches(tenantId);
  return result.rows[0] || null;
}

export async function deleteKnowledgebase(id: string, tenantId: string): Promise<boolean> {
  // Check if any bot references this KB
  const botCheck = await query<{ cnt: number }>(
    `SELECT COUNT(*)::int AS cnt FROM chatbots WHERE kb_id = $1 AND tenant_id = $2`,
    [id, tenantId],
  );
  if (botCheck.rows[0]?.cnt > 0) {
    throw new Error(`Không thể xoá KB — đang có ${botCheck.rows[0].cnt} bot sử dụng`);
  }

  const assignmentCheck = await query<{ cnt: number }>(
    `SELECT COUNT(*)::int AS cnt FROM tenant_kb_assignments WHERE kb_id = $1 AND tenant_id = $2`,
    [id, tenantId],
  );
  if ((assignmentCheck.rows[0]?.cnt ?? 0) > 0) {
    throw new Error('Khong the xoa KB dang duoc gan cho chuyen gia bai hoc');
  }

  // Get all document file paths to cleanup storage
  const docs = await query<{ file_path: string | null }>(
    `SELECT file_path FROM kb_documents WHERE kb_id = $1 AND tenant_id = $2`,
    [id, tenantId],
  );

  // 1. Delete from Gemini FIRST. If this fails, keep DB/storage intact so no
  // File Search document is left without DB ownership.
  await deleteKbGeminiRemoteResources(id, tenantId);

  // 2. Delete KB from DB (CASCADE → kb_documents → kb_doc_gemini_mapping + kb_google_store)
  const result = await query(
    `DELETE FROM knowledgebases WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId],
  );

  // 3. Cleanup storage files (non-critical)
  for (const doc of docs.rows) {
    if (doc.file_path) {
      try { await deleteFile(doc.file_path); } catch { /* ignore */ }
    }
  }

  if ((result.rowCount || 0) > 0) await invalidateTenantAiCaches(tenantId);
  return (result.rowCount || 0) > 0;
}

// ═══════════════════════════════════════
// Document CRUD
// ═══════════════════════════════════════

interface ListDocumentsOptions {
  kbId: string;
  tenantId: string;
  page?: number;
  pageSize?: number;
  search?: string;
  status?: string;
  type?: string;
}

export async function listDocuments(opts: ListDocumentsOptions): Promise<{ data: KbDocument[]; total: number }> {
  const { kbId, tenantId, page = 1, pageSize = 20, search, status, type } = opts;
  const offset = (page - 1) * pageSize;

  // Build WHERE dynamically — always filter by kb_id + tenant_id
  const conditions: string[] = ['kb_id = $1', 'tenant_id = $2'];
  const params: unknown[] = [kbId, tenantId];
  let idx = 3;

  if (search?.trim()) {
    conditions.push(`name ILIKE $${idx++}`);
    params.push(`%${search.trim()}%`);
  }
  if (status?.trim()) {
    conditions.push(`status = $${idx++}`);
    params.push(status.trim());
  }
  if (type?.trim()) {
    conditions.push(`type = $${idx++}`);
    params.push(type.trim());
  }

  const where = conditions.join(' AND ');

  // Single query with window function COUNT(*) OVER() — more efficient than 2 queries
  params.push(pageSize, offset);
  const result = await query<KbDocument & { full_count: string }>(
    `SELECT *, COUNT(*) OVER() AS full_count
     FROM kb_documents
     WHERE ${where}
     ORDER BY created_at DESC
     LIMIT $${idx++} OFFSET $${idx++}`,
    params,
  );

  const total = parseInt(result.rows[0]?.full_count ?? '0');
  const data = result.rows.map(r => {
    const { full_count, ...rest } = r;
    return rest as unknown as KbDocument;
  });

  return { data, total };
}

export async function getDocument(docId: string, tenantId: string): Promise<KbDocument | null> {
  const result = await query<KbDocument>(
    `SELECT * FROM kb_documents WHERE id = $1 AND tenant_id = $2`,
    [docId, tenantId],
  );
  return result.rows[0] || null;
}

/**
 * Upload a document file: insert record → upload to storage → enqueue Gemini job.
 */
export async function uploadDocument(
  kbId: string,
  tenantId: string,
  userId: string,
  file: { buffer: Buffer; originalname: string; mimetype: string; size: number },
): Promise<KbDocument> {
  await assertKnowledgebaseMutable(kbId, tenantId, 'upload tai lieu moi');
  const ext = file.originalname.substring(file.originalname.lastIndexOf('.')).toLowerCase();

  // 1. Insert document record (status=draft)
  const sourceInfo = {
    name: file.originalname,
    size: file.size,
    extension: ext,
    mime_type: file.mimetype,
  };
  const localContent = extractLocalSourceContent(ext, file.buffer);

  const insertResult = await query<KbDocument>(
    `INSERT INTO kb_documents (tenant_id, kb_id, type, name, status, source_info, content, created_by)
     VALUES ($1, $2, 'file', $3, 'draft', $4, $5, $6)
     RETURNING *`,
    [tenantId, kbId, file.originalname, JSON.stringify(sourceInfo), localContent, userId],
  );
  const doc = insertResult.rows[0];

  // 2. Upload to Supabase Storage
  const dateFolder = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const safeFileName = buildFileName(file.originalname);
  const storagePath = buildStoragePath(tenantId, 'kb-files', safeFileName, dateFolder);

  await uploadFile(storagePath, file.buffer, file.mimetype);

  // 3. Update document with file_path + status=learning
  await query(
    `UPDATE kb_documents SET file_path = $1, status = 'learning', updated_at = now() WHERE id = $2`,
    [storagePath, doc.id],
  );

  // 4. Enqueue Gemini upload job
  await publish(QUEUES.GEMINI_UPLOAD, {
    documentId: doc.id,
    kbId,
    tenantId,
    mode: 'file',
  });

  await invalidateTenantAiCaches(tenantId);
  return { ...doc, file_path: storagePath, status: 'learning' };
}

/**
 * Delete a single document.
 * Order: Gemini → DB → Storage (prevents orphan docs on Gemini)
 */
export async function deleteDocument(docId: string, kbId: string, tenantId: string): Promise<boolean> {
  // 1. Get gemini mappings + doc info BEFORE deleting anything
  const doc = await getDocument(docId, tenantId);
  if (!doc) return false;
  if (doc.kb_id !== kbId) return false;
  await assertKnowledgebaseMutable(kbId, tenantId, 'xoa tai lieu');
  if (doc.status === 'learning') throw new Error('Không thể xoá tài liệu đang được huấn luyện');

  // 2. Delete from Gemini FIRST (synchronous, not queue)
  await deleteDocumentGeminiMappingsStrict([docId], tenantId);

  // 3. Delete from DB (CASCADE handles mapping table)
  const result = await query(
    `DELETE FROM kb_documents WHERE id = $1 AND kb_id = $2 AND tenant_id = $3`,
    [docId, kbId, tenantId],
  );

  // 4. Cleanup storage (non-critical)
  if (doc.file_path) {
    try { await deleteFile(doc.file_path); } catch { /* ignore */ }
  }

  if ((result.rowCount || 0) > 0) await invalidateTenantAiCaches(tenantId);
  return (result.rowCount || 0) > 0;
}

/**
 * Bulk delete multiple documents in one operation.
 * Order: Gemini → DB → Storage (prevents orphan docs on Gemini)
 */
export async function bulkDeleteDocuments(
  docIds: string[],
  kbId: string,
  tenantId: string,
): Promise<{ deleted: number }> {
  if (docIds.length === 0) return { deleted: 0 };
  await assertKnowledgebaseMutable(kbId, tenantId, 'xoa tai lieu');

  // Filter out docs that are currently learning
  const statusCheck = await query<{ id: string; status: string }>(
    `SELECT id, status FROM kb_documents WHERE id = ANY($1) AND kb_id = $2 AND tenant_id = $3`,
    [docIds, kbId, tenantId],
  );
  const learningIds = statusCheck.rows.filter(r => r.status === 'learning').map(r => r.id);
  const foundIds = statusCheck.rows.map(r => r.id);
  const safeIds = foundIds.filter(id => !learningIds.includes(id));
  if (safeIds.length === 0) {
    if (learningIds.length > 0) throw new Error('Tất cả tài liệu đang được huấn luyện, không thể xoá');
    return { deleted: 0 };
  }

  // 2. Get all file paths in a single query
  const filePaths = await query<{ id: string; file_path: string | null }>(
    `SELECT id, file_path FROM kb_documents WHERE id = ANY($1) AND kb_id = $2 AND tenant_id = $3`,
    [safeIds, kbId, tenantId],
  );

  // 3. Delete from Gemini FIRST. If this fails, do not delete DB/storage.
  await deleteDocumentGeminiMappingsStrict(safeIds, tenantId);

  // 4. Bulk delete from DB
  const result = await query(
    `DELETE FROM kb_documents WHERE id = ANY($1) AND kb_id = $2 AND tenant_id = $3`,
    [safeIds, kbId, tenantId],
  );

  // 5. Cleanup storage files (non-critical)
  for (const f of filePaths.rows) {
    if (f.file_path) {
      try { await deleteFile(f.file_path); } catch { /* ignore */ }
    }
  }

  if ((result.rowCount || 0) > 0) await invalidateTenantAiCaches(tenantId);
  return { deleted: result.rowCount || 0 };
}

/**
 * Retry failed documents — reset to 'learning' and re-enqueue Gemini upload.
 * Only retries documents with status = 'error' that still have file_path.
 */
export async function retryDocuments(
  docIds: string[],
  kbId: string,
  tenantId: string,
): Promise<{ retried: number }> {
  if (docIds.length === 0) return { retried: 0 };
  await assertKnowledgebaseMutable(kbId, tenantId, 'retry tai lieu');

  // 1. Find eligible docs (status=error, has file_path)
  const eligible = await query<{ id: string; file_path: string }>(
    `SELECT id, file_path FROM kb_documents
     WHERE id = ANY($1) AND kb_id = $2 AND tenant_id = $3
       AND status = 'error' AND file_path IS NOT NULL`,
    [docIds, kbId, tenantId],
  );

  if (!eligible.rowCount || eligible.rowCount === 0) return { retried: 0 };

  const eligibleIds = eligible.rows.map(r => r.id);

  // 2. Delete old Gemini docs before clearing mappings.
  await deleteDocumentGeminiMappingsStrict(eligibleIds, tenantId);

  // 3. Clear old gemini mappings (if any partial uploads)
  await query(
    `DELETE FROM kb_doc_gemini_mapping WHERE document_id = ANY($1)`,
    [eligibleIds],
  );

  // 4. Reset status to 'learning', clear error
  await query(
    `UPDATE kb_documents SET status = 'learning', error_reason = NULL, updated_at = now()
     WHERE id = ANY($1)`,
    [eligibleIds],
  );

  // 5. Enqueue each doc individually (worker processes 1 at a time via prefetch)
  for (const doc of eligible.rows) {
    await publish(QUEUES.GEMINI_UPLOAD, {
      documentId: doc.id,
      kbId,
      tenantId,
      mode: 'file',
    });
  }

  await invalidateTenantAiCaches(tenantId);
  return { retried: eligibleIds.length };
}

async function failKnowledgebaseRestoreJob(
  jobId: string,
  kbId: string,
  tenantId: string,
  errorReason: string,
): Promise<void> {
  const safeReason = errorReason.slice(0, 1000);
  await query(
    `UPDATE kb_restore_jobs
     SET status = 'failed',
         error_reason = $4,
         finished_at = COALESCE(finished_at, now()),
         updated_at = now()
     WHERE id = $1 AND kb_id = $2 AND tenant_id = $3 AND status <> 'completed'`,
    [jobId, kbId, tenantId, safeReason],
  );
  await query(
    `UPDATE knowledgebases
     SET restore_state = 'failed',
         restore_error_reason = $3,
         restore_finished_at = now(),
         updated_at = now()
     WHERE id = $1 AND tenant_id = $2 AND active_restore_job_id = $4`,
    [kbId, tenantId, safeReason, jobId],
  );
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
  await query(
    `UPDATE kb_restore_jobs
     SET new_store_name = COALESCE(new_store_name, $4),
         updated_at = now()
     WHERE id = $1 AND kb_id = $2 AND tenant_id = $3`,
    [jobId, kbId, tenantId, storeName],
  );
}

export async function claimRestoreDocumentForUpload(
  jobId: string,
  documentId: string,
  kbId: string,
  tenantId: string,
): Promise<boolean> {
  const result = await query(
    `UPDATE kb_restore_job_documents
     SET status = 'uploading',
         updated_at = now()
     WHERE job_id = $1
       AND document_id = $2
       AND kb_id = $3
       AND tenant_id = $4
       AND status = 'queued'`,
    [jobId, documentId, kbId, tenantId],
  );
  return (result.rowCount || 0) > 0;
}

export async function resetRestoreDocumentForRetry(
  jobId: string,
  documentId: string,
  kbId: string,
  tenantId: string,
  errorReason: string,
): Promise<void> {
  await query(
    `UPDATE kb_restore_job_documents
     SET status = 'queued',
         error_reason = $5,
         updated_at = now()
     WHERE job_id = $1
       AND document_id = $2
       AND kb_id = $3
       AND tenant_id = $4
       AND status = 'uploading'`,
    [jobId, documentId, kbId, tenantId, errorReason.slice(0, 1000)],
  );
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
  try {
    await client.query('BEGIN');
    const docUpdate = await client.query(
      `UPDATE kb_restore_job_documents
       SET status = $5,
           error_reason = $6,
           finished_at = now(),
           updated_at = now()
       WHERE job_id = $1
         AND document_id = $2
         AND kb_id = $3
         AND tenant_id = $4
         AND status IN ('queued', 'uploading')
       RETURNING document_id`,
      [jobId, documentId, kbId, tenantId, success ? 'learned' : 'failed', errorReason?.slice(0, 1000) ?? null],
    );

    if ((docUpdate.rowCount || 0) === 0) {
      await client.query('COMMIT');
      return;
    }

    const jobUpdate = await client.query<{
      total_docs: number;
      learned_docs: number;
      failed_docs: number;
      skipped_docs: number;
    }>(
      `UPDATE kb_restore_jobs
       SET learned_docs = learned_docs + $4,
           failed_docs = failed_docs + $5,
           updated_at = now()
       WHERE id = $1 AND kb_id = $2 AND tenant_id = $3
       RETURNING total_docs, learned_docs, failed_docs, skipped_docs`,
      [jobId, kbId, tenantId, success ? 1 : 0, success ? 0 : 1],
    );
    const job = jobUpdate.rows[0];
    if (job && Number(job.learned_docs) + Number(job.failed_docs) + Number(job.skipped_docs) >= Number(job.total_docs)) {
      const finalStatus = Number(job.failed_docs) > 0 ? 'failed' : 'completed';
      await client.query(
        `UPDATE kb_restore_jobs
         SET status = $4,
             finished_at = now(),
             updated_at = now()
         WHERE id = $1 AND kb_id = $2 AND tenant_id = $3`,
        [jobId, kbId, tenantId, finalStatus],
      );
      await client.query(
        `UPDATE knowledgebases
         SET restore_state = $4,
             restore_error_reason = CASE WHEN $4 = 'failed' THEN 'Mot so tai lieu khoi phuc that bai. Kiem tra danh sach tai lieu loi.' ELSE NULL END,
             restore_finished_at = now(),
             updated_at = now()
         WHERE id = $1 AND tenant_id = $2 AND active_restore_job_id = $3`,
        [kbId, tenantId, jobId, finalStatus],
      );
    }
    await client.query('COMMIT');
    await invalidateTenantAiCaches(tenantId);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
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
  const result = await query(
    `UPDATE kb_restore_job_documents
     SET enqueued_at = COALESCE(enqueued_at, now()),
         updated_at = now()
     WHERE job_id = $1
       AND document_id = $2
       AND kb_id = $3
       AND tenant_id = $4
       AND status = 'queued'
       AND enqueued_at IS NULL`,
    [jobId, documentId, kbId, tenantId],
  );
  if ((result.rowCount || 0) > 0) {
    await query(
      `UPDATE kb_restore_jobs
       SET enqueued_docs = enqueued_docs + 1,
           updated_at = now()
       WHERE id = $1 AND kb_id = $2 AND tenant_id = $3`,
      [jobId, kbId, tenantId],
    );
  }
}

async function publishQueuedRestoreDocuments(
  jobId: string,
  kbId: string,
  tenantId: string,
): Promise<{ enqueued: number }> {
  const batchSize = 500;
  let enqueued = 0;

  for (;;) {
    const docs = await query<{ document_id: string }>(
      `SELECT document_id
       FROM kb_restore_job_documents
       WHERE job_id = $1
         AND kb_id = $2
         AND tenant_id = $3
         AND status = 'queued'
         AND enqueued_at IS NULL
       ORDER BY document_id
       LIMIT $4`,
      [jobId, kbId, tenantId, batchSize],
    );
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
  let restoreDocs = 0;
  let skippedNoFile = 0;
  let deletedMappings = 0;
  let orphanedStores = 0;

  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`kb-restore:${tenantId}:${kbId}`]);

    const jobResult = await client.query<{ status: string }>(
      `SELECT status
       FROM kb_restore_jobs
       WHERE id = $1 AND kb_id = $2 AND tenant_id = $3
       FOR UPDATE`,
      [jobId, kbId, tenantId],
    );
    const job = jobResult.rows[0];
    if (!job) throw new Error('Restore job khong ton tai');
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

    if (job.status !== 'uploading') {
      await client.query(
        `UPDATE kb_restore_jobs
         SET status = 'restoring',
             started_at = COALESCE(started_at, now()),
             new_key_fingerprint = $4,
             updated_at = now()
         WHERE id = $1 AND kb_id = $2 AND tenant_id = $3`,
        [jobId, kbId, tenantId, currentFingerprint],
      );
      await client.query(
        `UPDATE knowledgebases
         SET restore_state = 'restoring',
             restore_error_reason = NULL,
             restore_started_at = COALESCE(restore_started_at, now()),
             restore_finished_at = NULL,
             updated_at = now()
         WHERE id = $1 AND tenant_id = $2 AND active_restore_job_id = $3`,
        [kbId, tenantId, jobId],
      );

      const busyDocs = await client.query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt
         FROM kb_documents
         WHERE kb_id = $1 AND tenant_id = $2 AND status IN ('learning', 'deleting')`,
        [kbId, tenantId],
      );
      if ((busyDocs.rows[0]?.cnt ?? 0) > 0) {
        throw new Error('Kho tri thuc dang co tai lieu dang xu ly. Vui long cho xong roi khoi phuc lai.');
      }

      const stores = await client.query<KbGeminiStore>(
        `SELECT id, store_name, api_key_fingerprint, remote_status, remote_error_code, remote_error_reason
         FROM kb_google_store
         WHERE kb_id = $1
         FOR UPDATE`,
        [kbId],
      );
      const primaryStore = stores.rows[0] ?? null;
      const restoreReason = getRestoreReasonFromStore(primaryStore, currentFingerprint);
      if (!restoreReason) {
        throw new Error('Kho tri thuc nay chua can khoi phuc theo key Gemini hien tai.');
      }

      const counts = await client.query<{ total_docs: number; restore_docs: number; skipped_docs: number }>(
        `SELECT COUNT(*)::int AS total_docs,
                COUNT(*) FILTER (WHERE file_path IS NOT NULL)::int AS restore_docs,
                COUNT(*) FILTER (WHERE file_path IS NULL)::int AS skipped_docs
         FROM kb_documents
         WHERE kb_id = $1 AND tenant_id = $2`,
        [kbId, tenantId],
      );
      restoreDocs = Number(counts.rows[0]?.restore_docs ?? 0);
      skippedNoFile = Number(counts.rows[0]?.skipped_docs ?? 0);

      for (const store of stores.rows) {
        await client.query(
          `INSERT INTO kb_gemini_orphaned_stores (
             tenant_id, kb_id, store_name, api_key_fingerprint, reason, error_code, error_reason
           )
           VALUES ($1, $2, $3, $4, 'key_changed_restore_skip_remote_delete', $5, $6)`,
          [
            tenantId,
            kbId,
            store.store_name,
            store.api_key_fingerprint,
            store.remote_error_code || 'KEY_CHANGED',
            store.remote_error_reason || restoreReason,
          ],
        );
      }
      orphanedStores = stores.rowCount || 0;

      const mappingDelete = await client.query(
        `DELETE FROM kb_doc_gemini_mapping m
         USING kb_documents d
         WHERE d.id = m.document_id
           AND d.kb_id = $1
           AND d.tenant_id = $2`,
        [kbId, tenantId],
      );
      deletedMappings = mappingDelete.rowCount || 0;

      await client.query(`DELETE FROM kb_google_store WHERE kb_id = $1`, [kbId]);

      await client.query(
        `INSERT INTO kb_restore_job_documents (
           job_id, document_id, tenant_id, kb_id, status, error_reason, finished_at
         )
         SELECT $1, id, tenant_id, kb_id,
                CASE WHEN file_path IS NULL THEN 'skipped' ELSE 'queued' END,
                CASE WHEN file_path IS NULL THEN 'Khong co file goc de khoi phuc lai kho tri thuc' ELSE NULL END,
                CASE WHEN file_path IS NULL THEN now() ELSE NULL END
         FROM kb_documents
         WHERE kb_id = $2 AND tenant_id = $3
         ON CONFLICT (job_id, document_id) DO NOTHING`,
        [jobId, kbId, tenantId],
      );

      await client.query(
        `UPDATE kb_documents
         SET status = 'learning',
             error_reason = NULL,
             updated_at = now()
         WHERE kb_id = $1 AND tenant_id = $2 AND file_path IS NOT NULL`,
        [kbId, tenantId],
      );
      await client.query(
        `UPDATE kb_documents
         SET status = 'error',
             error_reason = 'Khong co file goc de khoi phuc lai kho tri thuc',
             updated_at = now()
         WHERE kb_id = $1 AND tenant_id = $2 AND file_path IS NULL AND status <> 'draft'`,
        [kbId, tenantId],
      );

      const nextStatus = restoreDocs > 0 ? 'uploading' : 'completed';
      await client.query(
        `UPDATE kb_restore_jobs
         SET status = $4,
             total_docs = $5,
             skipped_docs = $6,
             finished_at = CASE WHEN $4 = 'completed' THEN now() ELSE finished_at END,
             updated_at = now()
         WHERE id = $1 AND kb_id = $2 AND tenant_id = $3`,
        [jobId, kbId, tenantId, nextStatus, Number(counts.rows[0]?.total_docs ?? 0), skippedNoFile],
      );
      await client.query(
        `UPDATE knowledgebases
         SET restore_state = $4,
             restore_error_reason = NULL,
             restore_finished_at = CASE WHEN $4 = 'completed' THEN now() ELSE NULL END,
             updated_at = now()
         WHERE id = $1 AND tenant_id = $2 AND active_restore_job_id = $3`,
        [kbId, tenantId, jobId, nextStatus],
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }

  const publishResult = await publishQueuedRestoreDocuments(jobId, kbId, tenantId);
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

  const redis = getRedisClient();
  if (!redis) {
    throw new Error('Redis chua san sang de khoa job khoi phuc KB. Vui long thu lai sau.');
  }

  const jobId = randomUUID();
  const lockKey = kbRestoreLockKey(tenantId, kbId);
  let locked: string | null;
  try {
    locked = await redis.set(lockKey, jobId, { NX: true, EX: KB_RESTORE_LOCK_TTL_SECONDS });
  } catch (err) {
    if (isRedisPermissionError(err)) {
      throw new Error('Redis chua cho phep truy cap key lock khoi phuc KB. Kiem tra lai ACL/prefix Redis cho backend.');
    }
    throw err;
  }
  if (locked !== 'OK') {
    throw new Error('Kho tri thuc dang duoc khoi phuc. Vui long cho job hien tai hoan tat.');
  }

  try {
    const client = await getClient();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`kb-restore:${tenantId}:${kbId}`]);

      const kbResult = await client.query<{
        id: string;
        restore_state: string | null;
        store_id: string | null;
        store_name: string | null;
        api_key_fingerprint: string | null;
        remote_status: string | null;
        remote_error_reason: string | null;
      }>(
        `SELECT kb.id, kb.restore_state,
                kgs.id AS store_id, kgs.store_name, kgs.api_key_fingerprint, kgs.remote_status, kgs.remote_error_reason
         FROM knowledgebases kb
         LEFT JOIN kb_google_store kgs ON kgs.kb_id = kb.id
         WHERE kb.id = $1 AND kb.tenant_id = $2
         LIMIT 1
         FOR UPDATE OF kb`,
        [kbId, tenantId],
      );
      const row = kbResult.rows[0];
      if (!row) throw new Error('Knowledge Base khong ton tai');
      if (isRestoreActiveState(row.restore_state)) {
        throw new Error('Kho tri thuc dang duoc khoi phuc. Vui long cho job hien tai hoan tat.');
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
        throw new Error('Kho tri thuc nay chua can khoi phuc theo key Gemini hien tai.');
      }

      const activeDocs = await client.query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt
         FROM kb_documents
         WHERE kb_id = $1 AND tenant_id = $2 AND status IN ('learning', 'deleting')`,
        [kbId, tenantId],
      );
      if ((activeDocs.rows[0]?.cnt ?? 0) > 0) {
        throw new Error('Kho tri thuc dang co tai lieu dang xu ly. Vui long cho xong roi khoi phuc lai.');
      }

      await client.query(
        `INSERT INTO kb_restore_jobs (
           id, tenant_id, kb_id, status, reason, old_store_name,
           old_key_fingerprint, new_key_fingerprint, started_at
         )
         VALUES ($1, $2, $3, 'queued', 'key_changed', $4, $5, $6, now())`,
        [jobId, tenantId, kbId, row.store_name, row.api_key_fingerprint, currentFingerprint],
      );
      await client.query(
        `UPDATE knowledgebases
         SET restore_state = 'queued',
             active_restore_job_id = $3,
             restore_error_reason = NULL,
             restore_started_at = now(),
             restore_finished_at = NULL,
             updated_at = now()
         WHERE id = $1 AND tenant_id = $2`,
        [kbId, tenantId, jobId],
      );
      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    } finally {
      client.release();
    }

    await publish(QUEUES.GEMINI_RESTORE, {
      jobId,
      kbId,
      tenantId,
      lockKey,
      lockToken: jobId,
    });
  } catch (err) {
    await failKnowledgebaseRestoreJob(jobId, kbId, tenantId, err instanceof Error ? err.message : String(err));
    await releaseKnowledgebaseRestoreLock(lockKey, jobId);
    throw err;
  }

  await invalidateTenantAiCaches(tenantId);
  return {
    queued: true,
    job_id: jobId,
    kb_id: kbId,
    lock_ttl_seconds: KB_RESTORE_LOCK_TTL_SECONDS,
  };
}

/**
 * Restore a whole KB against the tenant's current Gemini key.
 * Remote File Search cleanup is completed before DB mappings are removed.
 */
export async function restoreKnowledgebase(
  kbId: string,
  tenantId: string,
  jobId?: string,
): Promise<RestoreKnowledgebaseResult> {
  if (!jobId) throw new Error('Restore job id is required');
  return restoreKnowledgebaseTracked(kbId, tenantId, jobId);

  const kb = await getKnowledgebase(kbId, tenantId);
  if (!kb) throw new Error('Knowledge Base khÃ´ng tá»“n táº¡i');

  // Fail early if the tenant has no usable Gemini key.
  await getGeminiClient(tenantId);

  const activeLearning = await query<{ cnt: number }>(
    `SELECT COUNT(*)::int AS cnt
     FROM kb_documents
     WHERE kb_id = $1 AND tenant_id = $2 AND status = 'learning'`,
    [kbId, tenantId],
  );
  if ((activeLearning.rows[0]?.cnt ?? 0) > 0) {
    throw new Error('Kho tri thá»©c Ä‘ang cÃ³ tÃ i liá»‡u Ä‘ang há»c. Vui lÃ²ng chá» xong rá»“i khÃ´i phá»¥c láº¡i.');
  }

  const remoteCleanup = await deleteKbGeminiRemoteResources(kbId, tenantId);

  const client = await getClient();
  let restoreIds: string[] = [];
  let skippedNoFile = 0;

  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`kb-restore:${tenantId}:${kbId}`]);

    const docs = await client.query<{ id: string; file_path: string | null; status: string }>(
      `SELECT id, file_path, status
       FROM kb_documents
       WHERE kb_id = $1 AND tenant_id = $2
       FOR UPDATE`,
      [kbId, tenantId],
    );

    if (docs.rows.some(doc => doc.status === 'learning')) {
      throw new Error('Kho tri thá»©c vá»«a phÃ¡t sinh tÃ i liá»‡u Ä‘ang há»c. Vui lÃ²ng thá»­ láº¡i sau.');
    }

    const docIds = docs.rows.map(doc => doc.id);
    restoreIds = docs.rows.filter(doc => Boolean(doc.file_path)).map(doc => doc.id);
    const skippedIds = docs.rows.filter(doc => !doc.file_path).map(doc => doc.id);
    skippedNoFile = skippedIds.length;

    if (docIds.length > 0) {
      await client.query(
        `DELETE FROM kb_doc_gemini_mapping WHERE document_id = ANY($1)`,
        [docIds],
      );
    }

    await client.query(
      `DELETE FROM kb_google_store WHERE kb_id = $1`,
      [kbId],
    );

    if (restoreIds.length > 0) {
      await client.query(
        `UPDATE kb_documents
         SET status = 'learning', error_reason = NULL, updated_at = now()
         WHERE id = ANY($1)`,
        [restoreIds],
      );
    }

    if (skippedIds.length > 0) {
      await client.query(
        `UPDATE kb_documents
         SET status = 'error',
             error_reason = 'KhÃ´ng cÃ³ file gá»‘c Ä‘á»ƒ khÃ´i phá»¥c láº¡i kho tri thá»©c',
             updated_at = now()
         WHERE id = ANY($1) AND status <> 'draft'`,
        [skippedIds],
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }

  const enqueuedIds: string[] = [];
  let uploadPublishFailed = false;
  try {
    for (const documentId of restoreIds) {
      await publish(QUEUES.GEMINI_UPLOAD, {
        documentId,
        kbId,
        tenantId,
        mode: 'file',
      });
      enqueuedIds.push(documentId);
    }
  } catch (err) {
    const notEnqueuedIds = restoreIds.filter(id => !enqueuedIds.includes(id));
    if (notEnqueuedIds.length > 0) {
      await query(
        `UPDATE kb_documents
         SET status = 'error',
             error_reason = 'KhÃ´ng thá»ƒ Ä‘Æ°a tÃ i liá»‡u vÃ o hÃ ng Ä‘á»£i há»c láº¡i',
             updated_at = now()
         WHERE id = ANY($1)`,
        [notEnqueuedIds],
      );
    }
      await invalidateTenantAiCaches(tenantId);
    uploadPublishFailed = true;
    console.error('[KB Restore] Failed to publish some upload jobs:', err instanceof Error ? err.message : String(err));
  }

  await invalidateTenantAiCaches(tenantId);
  return {
    restored: restoreIds.length,
    enqueued: enqueuedIds.length,
    failed_to_enqueue: restoreIds.length - enqueuedIds.length,
    skipped_no_file: skippedNoFile,
    deleted_stores: remoteCleanup.deletedStores,
    deleted_mappings: remoteCleanup.deletedMappings,
    orphaned_stores: 0,
    upload_publish_failed: uploadPublishFailed,
  };
}

/**
 * Update document status (used by workers).
 */
export async function updateDocumentStatus(
  docId: string,
  status: 'draft' | 'learning' | 'learned' | 'error',
  errorReason?: string,
): Promise<void> {
  const result = await query<{ tenant_id: string }>(
    `UPDATE kb_documents SET status = $1, error_reason = $2, updated_at = now() WHERE id = $3 RETURNING tenant_id`,
    [status, errorReason || null, docId],
  );
  const tenantId = result.rows[0]?.tenant_id;
  if (tenantId) await invalidateTenantAiCaches(tenantId);
}

/**
 * Link a document with its Gemini file search mapping.
 */
export async function linkDocumentGemini(
  documentId: string,
  storeId: string,
  geminiPath: string,
): Promise<boolean> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`kb-doc-gemini-mapping:${documentId}`]);

    const existing = await client.query<{ id: string }>(
      `SELECT id FROM kb_doc_gemini_mapping WHERE document_id = $1 LIMIT 1`,
      [documentId],
    );
    if (existing.rowCount && existing.rowCount > 0) {
      await client.query('COMMIT');
      return false;
    }

    await client.query(
      `INSERT INTO kb_doc_gemini_mapping (document_id, store_id, gemini_path) VALUES ($1, $2, $3)`,
      [documentId, storeId, geminiPath],
    );
    await client.query('COMMIT');
    return true;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

// ═══════════════════════════════════════
// FAQ Upload
// ═══════════════════════════════════════

/**
 * Validate & upload an FAQ xlsx file.
 * Checks template: Sheet 1 must have headers "Question" and "Answer".
 */
export async function uploadFaqDocument(
  kbId: string,
  tenantId: string,
  userId: string,
  file: { buffer: Buffer; originalname: string; mimetype: string; size: number },
): Promise<KbDocument> {
  await assertKnowledgebaseMutable(kbId, tenantId, 'upload FAQ');
  // 1. Parse xlsx
  const workbook = XLSX.read(file.buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('File xlsx không có sheet nào');

  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet);

  // 2. Validate headers
  if (rows.length === 0) throw new Error('File xlsx trống, không có dữ liệu');

  const firstRow = rows[0];
  const headers = Object.keys(firstRow);
  const hasQuestion = headers.some(h => h.trim().toLowerCase() === 'question');
  const hasAnswer = headers.some(h => h.trim().toLowerCase() === 'answer');

  if (!hasQuestion || !hasAnswer) {
    throw new Error(
      `File không đúng template. Cần có 2 cột "Question" và "Answer". ` +
      `Cột hiện tại: ${headers.join(', ')}. Vui lòng tải template mẫu.`
    );
  }

  // 3. Validate rows — each must have both Q and A
  const qKey = headers.find(h => h.trim().toLowerCase() === 'question')!;
  const aKey = headers.find(h => h.trim().toLowerCase() === 'answer')!;
  let emptyRows = 0;
  for (let i = 0; i < rows.length; i++) {
    const q = String(rows[i][qKey] || '').trim();
    const a = String(rows[i][aKey] || '').trim();
    if (!q || !a) emptyRows++;
  }
  if (emptyRows > 0) {
    console.warn(`[FAQ] ${emptyRows} rows có Question hoặc Answer trống, sẽ bị bỏ qua khi train`);
  }

  // 4. Insert document record
  const sourceInfo = {
    name: file.originalname,
    size: file.size,
    extension: '.xlsx',
    mime_type: file.mimetype,
    row_count: rows.length,
    valid_rows: rows.length - emptyRows,
  };

  const insertResult = await query<KbDocument>(
    `INSERT INTO kb_documents (tenant_id, kb_id, type, name, status, source_info, created_by)
     VALUES ($1, $2, 'faq', $3, 'draft', $4, $5)
     RETURNING *`,
    [tenantId, kbId, file.originalname, JSON.stringify(sourceInfo), userId],
  );
  const doc = insertResult.rows[0];

  // 5. Upload xlsx to Supabase Storage
  const dateFolder = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const safeFileName = buildFileName(file.originalname);
  const storagePath = buildStoragePath(tenantId, 'kb-faqs', safeFileName, dateFolder);
  await uploadFile(storagePath, file.buffer, file.mimetype);

  // 6. Update status + file_path
  await query(
    `UPDATE kb_documents SET file_path = $1, status = 'learning', updated_at = now() WHERE id = $2`,
    [storagePath, doc.id],
  );

  // 7. Enqueue Gemini upload
  await publish(QUEUES.GEMINI_UPLOAD, {
    documentId: doc.id,
    kbId,
    tenantId,
    mode: 'faq',
  });

  await invalidateTenantAiCaches(tenantId);
  return { ...doc, file_path: storagePath, status: 'learning' };
}

/**
 * Generate FAQ template xlsx buffer (in-memory).
 */
export function generateFaqTemplate(): Buffer {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['Question', 'Answer'],
    ['Sản phẩm này giá bao nhiêu?', 'Sản phẩm có giá 500.000 VNĐ.'],
    ['Thời gian giao hàng bao lâu?', 'Giao hàng từ 3-5 ngày làm việc.'],
  ]);
  // Set column widths
  ws['!cols'] = [{ wch: 40 }, { wch: 60 }];
  XLSX.utils.book_append_sheet(wb, ws, 'FAQs');
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}

// ═══════════════════════════════════════
// Article CRUD
// ═══════════════════════════════════════

/**
 * Simple HTML → Markdown converter.
 * Strips images (Gemini can't learn from images), keeps text structure.
 */
function htmlToMarkdown(html: string): string {
  let md = html;
  // Remove images (Gemini can't learn from them)
  md = md.replace(/<img[^>]*>/gi, '');
  // Headings
  md = md.replace(/<h1[^>]*>(.*?)<\/h1>/gi, '# $1\n');
  md = md.replace(/<h2[^>]*>(.*?)<\/h2>/gi, '## $1\n');
  md = md.replace(/<h3[^>]*>(.*?)<\/h3>/gi, '### $1\n');
  // Bold / Italic
  md = md.replace(/<(strong|b)>(.*?)<\/\1>/gi, '**$2**');
  md = md.replace(/<(em|i)>(.*?)<\/\1>/gi, '*$2*');
  // Lists
  md = md.replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1\n');
  md = md.replace(/<\/?[uo]l[^>]*>/gi, '\n');
  // Links
  md = md.replace(/<a[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)');
  // Paragraphs / breaks
  md = md.replace(/<br\s*\/?>/gi, '\n');
  md = md.replace(/<\/p>/gi, '\n\n');
  md = md.replace(/<p[^>]*>/gi, '');
  // Strip remaining tags
  md = md.replace(/<[^>]+>/g, '');
  // Decode entities
  md = md.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  // Collapse whitespace
  md = md.replace(/\n{3,}/g, '\n\n').trim();
  return md;
}

/**
 * Create an article: convert HTML → .md → upload to Storage → enqueue Gemini.
 */
export async function uploadArticle(
  kbId: string,
  tenantId: string,
  userId: string,
  input: CreateArticleInput,
): Promise<KbDocument> {
  await assertKnowledgebaseMutable(kbId, tenantId, 'tao bai viet');
  const markdown = `# ${input.title}\n\n${htmlToMarkdown(input.content)}\n`;

  // 1. Insert document record
  const insertResult = await query<KbDocument>(
    `INSERT INTO kb_documents (tenant_id, kb_id, type, name, status, content, source_info, created_by)
     VALUES ($1, $2, 'article', $3, 'draft', $4, $5, $6)
     RETURNING *`,
    [
      tenantId, kbId, input.title, input.content,
      JSON.stringify({ title: input.title, content_length: input.content.length }),
      userId,
    ],
  );
  const doc = insertResult.rows[0];

  // 2. Write .md to temp, upload to Storage
  const tempDir = env.GEMINI_TEMP_DIR || path.join(process.cwd(), 'tmp');
  await fs.mkdir(tempDir, { recursive: true });
  const tempPath = path.join(tempDir, `article-${doc.id}.md`);
  await fs.writeFile(tempPath, markdown, 'utf8');

  try {
    const dateFolder = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const slug = input.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50);
    const storagePath = buildStoragePath(tenantId, 'kb-articles', `${slug}-${doc.id.slice(0, 8)}.md`, dateFolder);
    const buffer = await fs.readFile(tempPath);
    await uploadFile(storagePath, buffer, 'text/markdown');

    // 3. Update document
    await query(
      `UPDATE kb_documents SET file_path = $1, status = 'learning', updated_at = now() WHERE id = $2`,
      [storagePath, doc.id],
    );

    // 4. Enqueue Gemini upload
    await publish(QUEUES.GEMINI_UPLOAD, {
      documentId: doc.id,
      kbId,
      tenantId,
      mode: 'article',
    });

    await invalidateTenantAiCaches(tenantId);
    return { ...doc, file_path: storagePath, status: 'learning' };
  } finally {
    try { await fs.unlink(tempPath); } catch { /* ignore */ }
  }
}

/**
 * Update an article: update content, delete old Gemini mapping, re-upload.
 */
export async function updateArticle(
  docId: string,
  kbId: string,
  tenantId: string,
  input: UpdateArticleInput,
): Promise<KbDocument | null> {
  // 1. Get existing
  const existing = await getDocument(docId, tenantId);
  if (!existing || existing.type !== 'article' || existing.kb_id !== kbId) return null;
  await assertKnowledgebaseMutable(kbId, tenantId, 'sua bai viet');
  if (existing.status === 'learning') throw new Error('Không thể sửa bài viết đang được huấn luyện');

  // Optimistic locking: reject if another admin has modified this doc since it was loaded
  if (input.expected_updated_at && existing.updated_at) {
    const expected = new Date(input.expected_updated_at).getTime();
    const actual = new Date(existing.updated_at).getTime();
    if (expected !== actual) {
      throw new Error('Bài viết đã được người khác chỉnh sửa. Vui lòng tải lại trang và thử lại.');
    }
  }

  const title = input.title ?? existing.name;
  const content = input.content ?? existing.content ?? '';
  const markdown = `# ${title}\n\n${htmlToMarkdown(content)}\n`;

  // 3. Write new .md
  const tempDir = env.GEMINI_TEMP_DIR || path.join(process.cwd(), 'tmp');
  await fs.mkdir(tempDir, { recursive: true });
  const tempPath = path.join(tempDir, `article-${docId}.md`);
  await fs.writeFile(tempPath, markdown, 'utf8');

  let uploadedStoragePath: string | null = null;
  let dbUpdated = false;

  try {
    const dateFolder = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50);
    const storagePath = buildStoragePath(tenantId, 'kb-articles', `${slug}-${docId.slice(0, 8)}.md`, dateFolder);
    const buffer = await fs.readFile(tempPath);

    await uploadFile(storagePath, buffer, 'text/markdown');
    uploadedStoragePath = storagePath;

    // Delete old Gemini mapping before DB state changes. If Gemini cleanup
    // fails, leave DB and old storage intact.
    await deleteDocumentGeminiMappingsStrict([docId], tenantId);

    const client = await getClient();
    try {
      await client.query('BEGIN');
      await client.query(
        `DELETE FROM kb_doc_gemini_mapping WHERE document_id = $1`,
        [docId],
      );
      await client.query(
        `UPDATE kb_documents SET name = $1, content = $2, file_path = $3, status = 'learning',
         source_info = $4, error_reason = NULL, updated_at = now()
         WHERE id = $5 AND kb_id = $6 AND tenant_id = $7`,
        [title, content, storagePath, JSON.stringify({ title, content_length: content.length }), docId, kbId, tenantId],
      );
      await client.query('COMMIT');
      dbUpdated = true;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      try { await deleteFile(storagePath); } catch { /* ignore */ }
      throw err;
    } finally {
      client.release();
    }

    if (existing.file_path && existing.file_path !== storagePath) {
      try { await deleteFile(existing.file_path); } catch { /* ignore */ }
    }

    try {
      await publish(QUEUES.GEMINI_UPLOAD, {
        documentId: docId,
        kbId,
        tenantId,
        mode: 'article',
      });
    } catch (err) {
      await query(
        `UPDATE kb_documents
         SET status = 'error',
             error_reason = 'Khong the dua bai viet vao hang doi hoc lai',
             updated_at = now()
         WHERE id = $1 AND tenant_id = $2`,
        [docId, tenantId],
      );
      await invalidateTenantAiCaches(tenantId);
      throw err;
    }

    await invalidateTenantAiCaches(tenantId);
    return { ...existing, name: title, content, file_path: storagePath, status: 'learning' };
  } catch (err) {
    if (!dbUpdated && uploadedStoragePath) {
      try { await deleteFile(uploadedStoragePath); } catch { /* ignore */ }
    }
    throw err;
  } finally {
    try { await fs.unlink(tempPath); } catch { /* ignore */ }
  }
}
