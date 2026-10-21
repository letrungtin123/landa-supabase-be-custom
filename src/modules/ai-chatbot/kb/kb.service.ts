// ═══════════════════════════════════════════════════════════════
// KB Service — Knowledge Base + Document CRUD
//
// The other knowledge base entry points, by concern (all re-exported here):
// - kb-document-operations.service.ts: staged sources and the durable
//   document operations the HTTP controller uses;
// - kb-restore.service.ts: the restore job after a Gemini key change;
// - kb-mutability.service.ts: when a document change is refused.
// SQL lives in kb.repository.ts and kb-restore.repository.ts.
// ═══════════════════════════════════════════════════════════════

import { getClient, query } from '../../../config/database.js';
import { invalidateTenantAiCaches } from '../../../config/cache-invalidation.js';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { deleteFile, STORAGE_BUCKET } from '../../../config/storage.js';
import { signKbDocumentSourceUrl } from './kb-source-download-url.logic.js';
import { AppError } from '../../../middleware/error-handler.js';
import { type CreateKbInput, type UpdateKbInput } from './kb.validator.js';
import * as XLSX from 'xlsx';
import { env } from '../../../config/env.js';
import {
  deleteFileSearchStoreIfExists,
  deleteFromStore,
  getGeminiClient,
  getOptionalGeminiApiKeyFingerprint,
} from '../ai-platform/gemini.service.js';
import { logSwallowedError } from '../../../utils/best-effort.js';
import { createKbRepository } from './kb.repository.js';
import { assertKnowledgebaseMutable } from './kb-mutability.service.js';
import { assertDocumentsNotInUseByAiId, supersedeLessonAuthorBlueprintsForDocuments } from './kb-document-operations.service.js';
import type { KbDocument, Knowledgebase } from './kb.types.js';

export type {
  EnqueueRestoreKnowledgebaseResult,
  KbDocument,
  Knowledgebase,
  RestoreKnowledgebaseResult,
} from './kb.types.js';
export {
  claimRestoreDocumentForUpload,
  dispatchKnowledgebaseRestore,
  enqueueKnowledgebaseRestore,
  markKnowledgebaseRestoreFailed,
  recordRestoreDocumentFinished,
  redispatchRecoverableKnowledgebaseRestores,
  releaseKnowledgebaseRestoreLock,
  resetRestoreDocumentForRetry,
  restoreKnowledgebase,
  setRestoreJobNewStore,
  type RestoreDispatchTarget,
} from './kb-restore.service.js';
export {
  createQueuedDocumentFromStagedSource,
  discardStagedKbSource,
  queueBulkDocumentDeletion,
  queueDocumentDeletion,
  queueDocumentRetry,
  queueKnowledgebaseDeletion,
  stageArticleSource,
  stageDocumentSource,
  stageFaqSource,
  stageTextBackedDocumentSource,
  updateArticleFromStagedSource,
  type KbUploadedTempFile,
  type QueuedBulkDocumentDeletion,
  type QueuedDocumentDeletion,
  type StagedKbSource,
} from './kb-document-operations.service.js';

const kbRepository = createKbRepository({ query });

export async function deleteKbGeminiRemoteResources(
  kbId: string,
  tenantId: string,
): Promise<{ deletedStores: number; deletedMappings: number }> {
  const [stores, mappings] = await Promise.all([
    kbRepository.selectGeminiStores(kbId),
    kbRepository.selectKbGeminiMappings(kbId, tenantId),
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

export async function deleteDocumentGeminiMappingsStrict(
  docIds: string[],
  tenantId: string,
): Promise<number> {
  if (docIds.length === 0) return 0;

  const mappings = await kbRepository.selectDocumentGeminiMappings(docIds, tenantId);

  if (!mappings.rowCount || mappings.rowCount === 0) return 0;
  const aiClient = await getGeminiClient(tenantId);
  await deleteFromStore(mappings.rows.map(r => r.gemini_path), aiClient);
  return mappings.rows.length;
}

function mapKnowledgebaseRow<T extends Record<string, any>>(row: T): Knowledgebase {
  const {
    full_count,
    total_docs,
    enqueued_docs,
    learned_docs,
    failed_docs,
    skipped_docs,
    ai_transition_phase,
    ai_transition_total_documents,
    ai_transition_processed_documents,
    ai_transition_cleanup_processed_documents,
    ai_transition_last_error,
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
  const aiTransitionProgress =
    ai_transition_total_documents !== undefined && ai_transition_total_documents !== null
      ? {
          phase: ai_transition_phase ?? null,
          total_documents: Number(ai_transition_total_documents) || 0,
          processed_documents: Number(ai_transition_processed_documents) || 0,
          cleanup_processed_documents: Number(ai_transition_cleanup_processed_documents) || 0,
          last_error: ai_transition_last_error ?? null,
        }
      : null;
  return {
    ...(rest as unknown as Knowledgebase),
    restore_required: Boolean(rest.restore_required),
    restore_reason: rest.restore_reason ?? null,
    restore_progress: progress,
    ai_transition_progress: aiTransitionProgress,
  };
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

  const rows = await kbRepository.selectKnowledgebasePage(tenantId, currentFingerprint, search, pageSize, offset);

  const total = parseInt(rows[0]?.full_count ?? '0');
  const data = rows.map(mapKnowledgebaseRow);

  return { data, total };
}

export async function getKnowledgebase(id: string, tenantId: string): Promise<Knowledgebase | null> {
  const currentFingerprint = await getOptionalGeminiApiKeyFingerprint(tenantId);
  const row = await kbRepository.selectKnowledgebase(id, tenantId, currentFingerprint);
  return row ? mapKnowledgebaseRow(row) : null;
}

export async function createKnowledgebase(tenantId: string, input: CreateKbInput, userId: string): Promise<Knowledgebase> {
  const created = await kbRepository.insertKnowledgebase(tenantId, input.name, input.description || '', userId);
  await invalidateTenantAiCaches(tenantId);
  return created as unknown as Knowledgebase;
}

export async function updateKnowledgebase(id: string, tenantId: string, input: UpdateKbInput): Promise<Knowledgebase | null> {
  // Nothing to update: only updated_at would change.
  if (input.name === undefined && input.description === undefined) return getKnowledgebase(id, tenantId);

  const updated = await kbRepository.updateKnowledgebase(id, tenantId, input);
  if (updated) await invalidateTenantAiCaches(tenantId);
  return (updated as unknown as Knowledgebase) || null;
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

  const rows = await kbRepository.selectDocumentPage({ kbId, tenantId, search, status, type }, pageSize, offset);

  const total = parseInt(rows[0]?.full_count ?? '0');
  const data = rows.map(r => {
    const { full_count: _fullCount, ...rest } = r;
    return rest as unknown as KbDocument;
  });

  return { data, total };
}

export async function getDocument(docId: string, tenantId: string): Promise<KbDocument | null> {
  return (await kbRepository.selectDocument(docId, tenantId)) || null;
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
  if (doc.status === 'learning') throw new AppError('Không thể xoá tài liệu đang được huấn luyện', 409);
  await assertDocumentsNotInUseByAiId(tenantId, kbId, [docId]);

  // 2. Delete from Gemini FIRST (synchronous, not queue)
  await deleteDocumentGeminiMappingsStrict([docId], tenantId);
  await supersedeLessonAuthorBlueprintsForDocuments(tenantId, kbId, [docId]);

  // 3. Delete from DB (CASCADE handles mapping table)
  const deleted = await kbRepository.deleteDocument(docId, kbId, tenantId);

  // 4. Cleanup storage (non-critical)
  if (doc.file_path) {
    try { await deleteFile(doc.file_path); } catch (error) { logSwallowedError('kb.storage_cleanup', error); }
  }

  if (deleted > 0) await invalidateTenantAiCaches(tenantId);
  return deleted > 0;
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
  const statuses = await kbRepository.selectDocumentStatuses(docIds, kbId, tenantId);
  const learningIds = statuses.filter(r => r.status === 'learning').map(r => r.id);
  const foundIds = statuses.map(r => r.id);
  const safeIds = foundIds.filter(id => !learningIds.includes(id));
  if (safeIds.length === 0) {
    if (learningIds.length > 0) throw new AppError('Tất cả tài liệu đang được huấn luyện, không thể xoá', 409);
    return { deleted: 0 };
  }
  await assertDocumentsNotInUseByAiId(tenantId, kbId, safeIds);

  // 2. Get all file paths in a single query
  const filePaths = await kbRepository.selectDocumentFilePaths(safeIds, kbId, tenantId);

  // 3. Delete from Gemini FIRST. If this fails, do not delete DB/storage.
  await deleteDocumentGeminiMappingsStrict(safeIds, tenantId);
  await supersedeLessonAuthorBlueprintsForDocuments(tenantId, kbId, safeIds);

  // 4. Bulk delete from DB
  const deleted = await kbRepository.deleteDocuments(safeIds, kbId, tenantId);

  // 5. Cleanup storage files (non-critical)
  for (const f of filePaths) {
    if (f.file_path) {
      try { await deleteFile(f.file_path); } catch (error) { logSwallowedError('kb.storage_cleanup', error); }
    }
  }

  if (deleted > 0) await invalidateTenantAiCaches(tenantId);
  return { deleted };
}

/**
 * Update document status (used by workers).
 */
export async function updateDocumentStatus(
  docId: string,
  status: 'draft' | 'learning' | 'learned' | 'error',
  errorReason?: string,
): Promise<void> {
  const tenantId = await kbRepository.updateDocumentStatus(docId, status, errorReason || null);
  if (tenantId) await invalidateTenantAiCaches(tenantId);
}

let sourceUrlSigningClient: SupabaseClient | null = null;

/**
 * SEP-1: signed URL (TTL AI_RAG_STORAGE_SIGNED_URL_TTL_SECONDS) the AI service downloads one KB
 * source through, instead of holding the storage service key. The URL is a bearer credential:
 * pass it straight to the index request and never log or persist it.
 */
export async function createKbDocumentSourceDownloadUrl(filePath: string, tenantId: string): Promise<string> {
  return signKbDocumentSourceUrl({
    filePath,
    tenantId,
    bucket: STORAGE_BUCKET,
    ttlSeconds: env.AI_RAG_STORAGE_SIGNED_URL_TTL_SECONDS,
    origin: env.AI_RAG_STORAGE_SIGNED_URL_ORIGIN,
    sign: async (bucket, objectPath, ttlSeconds) => {
      sourceUrlSigningClient ??= createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { data, error } = await sourceUrlSigningClient.storage.from(bucket).createSignedUrl(objectPath, ttlSeconds);
      if (error || !data?.signedUrl) throw new Error('KB_SOURCE_SIGNED_URL_FAILED');
      return data.signedUrl;
    },
  });
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
  const repository = createKbRepository(client);
  try {
    await client.query('BEGIN');
    await repository.lockDocumentGeminiMapping(documentId);

    if (await repository.hasDocumentGeminiMapping(documentId)) {
      await client.query('COMMIT');
      return false;
    }

    await repository.insertDocumentGeminiMapping(documentId, storeId, geminiPath);
    await client.query('COMMIT');
    return true;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* fails only on a broken connection, which pg-pool discards */ }
    throw err;
  } finally {
    client.release();
  }
}

// ═══════════════════════════════════════
// FAQ Upload
// ═══════════════════════════════════════

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
