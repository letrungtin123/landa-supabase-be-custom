// ═══════════════════════════════════════════════════════════════
// Durable knowledge base document operations: the only KB mutation helpers
// the HTTP controller uses. They split a Storage staging step from the
// database mutation, so the caller can make the document / job / Audit Log
// one transaction and compensate a staged object if that transaction rolls
// back. Also marks the Lesson Author blueprints and transcript jobs a source
// change makes stale. SQL lives in kb.repository.ts; moved from
// kb.service.ts, which still re-exports every entry point.
// ═══════════════════════════════════════════════════════════════

import { randomUUID } from 'crypto';
import { query } from '../../../config/database.js';
import { uploadFile, uploadFileFromPath, buildStoragePath, buildFileName, deleteFile } from '../../../config/storage.js';
import { extractLocalSourceContentFromFile } from './kb-local-source-content.js';
import { readFaqSheetSummary } from './kb-faq-sheet.service.js';
import { AppError } from '../../../middleware/error-handler.js';
import { normalizeKbDocumentDisplayName, type CreateArticleInput, type UpdateArticleInput } from './kb.validator.js';
import { enqueueKbOperation } from './kb-operation.service.js';
import { logSwallowedError } from '../../../utils/best-effort.js';
import { createKbRepository } from './kb.repository.js';
import { assertKnowledgebaseMutable, assertNoActiveAiEngineTransition } from './kb-mutability.service.js';
import { isRestoreActiveState } from './kb-restore.logic.js';
import type { KbDocument } from './kb.types.js';
import { KbDocumentInUseByAiIdError, KbInUseByAiIdError } from './kb-document-deletion.logic.js';
import {
  findSourceDocumentsInActiveRuns, knowledgebaseHasActiveRuns,
} from '../ai-id/sources/lesson-author-source-in-use.repository.js';

const kbRepository = createKbRepository({ query });

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

export interface StagedKbSource {
  /** Text-backed sources intentionally have no public Storage object. */
  storagePath: string | null;
  sourceInfo: Record<string, unknown>;
  content: string | null;
  name: string;
  type: 'file' | 'faq' | 'article';
}

/** An uploaded source as multer's disk storage delivers it (kb-upload-storage.ts). */
export interface KbUploadedTempFile {
  path: string;
  originalname: string;
  mimetype: string;
  size: number;
}

/** Streams the uploaded temp file to Storage (never read whole into the heap). */
async function stageKbSource(
  tenantId: string,
  folder: Parameters<typeof buildStoragePath>[1],
  name: string,
  mimetype: string,
  filePath: string,
  sourceInfo: Record<string, unknown>,
  type: StagedKbSource['type'],
  content: string | null = null,
  suffix?: string,
): Promise<StagedKbSource> {
  const dateFolder = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const safeName = suffix || buildFileName(name);
  const storagePath = buildStoragePath(tenantId, folder, safeName, dateFolder);
  await uploadFileFromPath(storagePath, filePath, mimetype);
  return { storagePath, sourceInfo, content, name, type };
}

export async function discardStagedKbSource(staged: Pick<StagedKbSource, 'storagePath'> | null | undefined): Promise<void> {
  if (!staged?.storagePath) return;
  try { await deleteFile(staged.storagePath); } catch (error) { logSwallowedError('kb.storage_cleanup', error); /* reconciliation is the fail-safe */ }
}

/**
 * Create a KB file source from server-generated text. This is used for
 * reviewed artifacts such as a lesson-author video transcript. Keeping the
 * content in the tenant-scoped document row avoids copying the artifact to
 * the public asset bucket before it has been indexed.
 */
export async function stageTextBackedDocumentSource(
  kbId: string,
  tenantId: string,
  input: { name: string; content: string; sourceInfo: Record<string, unknown> },
): Promise<StagedKbSource> {
  await assertKnowledgebaseMutable(kbId, tenantId, 'luu ban chep loi');
  return {
    storagePath: null,
    sourceInfo: input.sourceInfo,
    content: input.content,
    name: input.name,
    type: 'file',
  };
}

export async function stageDocumentSource(
  kbId: string,
  tenantId: string,
  file: KbUploadedTempFile,
): Promise<StagedKbSource> {
  await assertKnowledgebaseMutable(kbId, tenantId, 'tai tai lieu moi');
  const displayName = normalizeKbDocumentDisplayName(file.originalname);
  const ext = displayName.substring(displayName.lastIndexOf('.')).toLowerCase();
  const localContent = await extractLocalSourceContentFromFile(ext, file.path);
  return stageKbSource(
    tenantId,
    'kb-files',
    displayName,
    file.mimetype,
    file.path,
    { name: displayName, size: file.size, extension: ext, mime_type: file.mimetype },
    'file',
    localContent,
  );
}

export async function stageFaqSource(
  kbId: string,
  tenantId: string,
  file: KbUploadedTempFile,
): Promise<StagedKbSource> {
  await assertKnowledgebaseMutable(kbId, tenantId, 'tai FAQ');
  const displayName = normalizeKbDocumentDisplayName(file.originalname);
  // Parsed in a worker thread (kb-faq-sheet.service.ts), never on the event loop.
  const sheet = await readFaqSheetSummary(file.path);
  if (sheet.kind === 'no_sheet') throw new AppError('File xlsx không có sheet nào', 400);
  if (sheet.kind === 'empty') throw new AppError('File xlsx trống, không có dữ liệu', 400);
  if (sheet.kind === 'bad_template') {
    throw new AppError(`File không đúng template. Cần có 2 cột "Question" và "Answer". Cột hiện tại: ${sheet.headers.join(', ')}`, 400);
  }
  const { rowCount, emptyRows } = sheet;
  return stageKbSource(
    tenantId,
    'kb-faqs',
    displayName,
    file.mimetype,
    file.path,
    {
      name: displayName,
      size: file.size,
      extension: '.xlsx',
      mime_type: file.mimetype,
      row_count: rowCount,
      valid_rows: rowCount - emptyRows,
    },
    'faq',
  );
}

export async function stageArticleSource(
  kbId: string,
  tenantId: string,
  input: Pick<CreateArticleInput, 'title' | 'content'>,
  documentId: string = randomUUID(),
): Promise<StagedKbSource> {
  await assertKnowledgebaseMutable(kbId, tenantId, 'tao bai viet');
  const markdown = Buffer.from(`# ${input.title}\n\n${htmlToMarkdown(input.content)}\n`, 'utf8');
  const dateFolder = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const slug = input.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50) || 'article';
  // A replacement must never overwrite the source currently used by Gemini;
  // the worker removes that previous object only after its re-upload succeeds.
  const storagePath = buildStoragePath(
    tenantId,
    'kb-articles',
    `${slug}-${documentId.slice(0, 8)}-${randomUUID().slice(0, 8)}.md`,
    dateFolder,
  );
  await uploadFile(storagePath, markdown, 'text/markdown');
  return {
    storagePath,
    sourceInfo: { title: input.title, content_length: input.content.length },
    content: input.content,
    name: input.title,
    type: 'article',
  };
}

export async function createQueuedDocumentFromStagedSource(
  kbId: string,
  tenantId: string,
  userId: string,
  staged: StagedKbSource,
): Promise<KbDocument> {
  await assertKnowledgebaseMutable(kbId, tenantId, 'luu tai lieu moi');
  const document = await kbRepository.insertLearningDocument(tenantId, kbId, staged, userId);
  await enqueueKbOperation({
    tenantId,
    kbId,
    documentId: document.id,
    operation: 'document_upload',
  });
  return document;
}

const BLUEPRINT_SOURCE_CHANGED_REASON = 'Tài liệu nguồn trong Kho tri thức đã thay đổi hoặc bị xóa. Vui lòng tạo lại bản thiết kế khóa học.';

export type QueuedDocumentDeletion = {
  document: KbDocument;
  detachedTranscriptJobIds: string[];
};

export type QueuedBulkDocumentDeletion = {
  deleted: number;
  documents: KbDocument[];
  detachedTranscriptJobIds: string[];
};

function isLessonAuthorBlueprintSchemaUnavailable(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : '';
  return code === '42P01';
}

/**
 * A Blueprint is a review snapshot, not a live course specification.  Mark it
 * stale before a source mutation commits so an old source can never be used to
 * generate a later chapter. Empty source_documents means the Blueprint used
 * the whole KB, so every document mutation invalidates it deliberately.
 */
export async function supersedeLessonAuthorBlueprintsForDocuments(
  tenantId: string,
  kbId: string,
  documentIds: readonly string[],
): Promise<void> {
  if (documentIds.length === 0) return;
  try {
    await kbRepository.supersedeBlueprintsForDocuments(tenantId, kbId, documentIds, BLUEPRINT_SOURCE_CHANGED_REASON);
  } catch (error) {
    // Safe rolling deployment: old database nodes do not have this additive
    // table yet. All other database failures must stop the source mutation.
    if (isLessonAuthorBlueprintSchemaUnavailable(error)) return;
    throw error;
  }
}

async function supersedeLessonAuthorBlueprintsForKnowledgebase(
  tenantId: string,
  kbId: string,
): Promise<void> {
  try {
    await kbRepository.supersedeBlueprintsForKnowledgebase(tenantId, kbId, BLUEPRINT_SOURCE_CHANGED_REASON);
  } catch (error) {
    if (isLessonAuthorBlueprintSchemaUnavailable(error)) return;
    throw error;
  }
}

async function detachTranscriptJobsForKnowledgebaseDocuments(
  tenantId: string,
  kbId: string,
  documentIds: readonly string[],
): Promise<string[]> {
  if (documentIds.length === 0) return [];
  try {
    return await kbRepository.detachTranscriptJobs(tenantId, kbId, documentIds);
  } catch (error) {
    if (isLessonAuthorBlueprintSchemaUnavailable(error)) return [];
    throw error;
  }
}

/**
 * A document that is the source of an AI ID workspace with an active V2 run is not deleted (409
 * KB_DOCUMENT_IN_USE_BY_AI_ID). The callers lock the document rows FOR UPDATE first, which closes the
 * race with a run admission (it locks them FOR SHARE).
 */
export async function assertDocumentsNotInUseByAiId(tenantId: string, kbId: string, documentIds: readonly string[]): Promise<void> {
  const inUse = await findSourceDocumentsInActiveRuns({ query }, { tenantId, kbId, documentIds });
  if (inUse.length > 0) throw new KbDocumentInUseByAiIdError(inUse);
}

export async function queueDocumentDeletion(docId: string, kbId: string, tenantId: string): Promise<QueuedDocumentDeletion | null> {
  await assertKnowledgebaseMutable(kbId, tenantId, 'xoa tai lieu');
  const document = (await kbRepository.lockDocument(docId, kbId, tenantId)) || null;
  if (!document) return null;
  if (document.status === 'learning') {
    throw new AppError('Không thể xoá tài liệu đang được huấn luyện', 409, 'KB_DOCUMENT_LEARNING');
  }
  await assertDocumentsNotInUseByAiId(tenantId, kbId, [docId]);
  const mappings = await kbRepository.selectDocumentMappingPaths(docId);
  const detachedTranscriptJobIds = await detachTranscriptJobsForKnowledgebaseDocuments(tenantId, kbId, [docId]);
  await supersedeLessonAuthorBlueprintsForDocuments(tenantId, kbId, [docId]);
  // Delete the tenant row before adding the small outbox/audit rows. At a hard
  // quota boundary this preserves the customer's ability to free space while
  // still rolling everything back if the outbox or Audit Log cannot be saved.
  if ((await kbRepository.deleteDocument(docId, kbId, tenantId)) !== 1) return null;
  await enqueueKbOperation({
    tenantId,
    kbId,
    documentId: null,
    targetDocumentId: docId,
    operation: 'document_delete',
    payload: { file_path: document.file_path, gemini_paths: mappings.map(row => row.gemini_path) },
  });
  return { document, detachedTranscriptJobIds };
}

export async function queueBulkDocumentDeletion(
  docIds: string[],
  kbId: string,
  tenantId: string,
): Promise<QueuedBulkDocumentDeletion> {
  if (docIds.length === 0) return { deleted: 0, documents: [], detachedTranscriptJobIds: [] };
  await assertKnowledgebaseMutable(kbId, tenantId, 'xoa tai lieu');
  const documents = await kbRepository.lockDeletableDocuments(docIds, kbId, tenantId);
  if (documents.length === 0) return { deleted: 0, documents: [], detachedTranscriptJobIds: [] };
  // All or nothing: one document AI ID still uses refuses the whole request (the UI names it).
  await assertDocumentsNotInUseByAiId(tenantId, kbId, documents.map(document => document.id));
  const mappings = await kbRepository.selectMappingPathsOfDocuments(documents.map(document => document.id));
  const pathsByDocument = new Map<string, string[]>();
  for (const mapping of mappings) {
    const paths = pathsByDocument.get(mapping.document_id) || [];
    paths.push(mapping.gemini_path);
    pathsByDocument.set(mapping.document_id, paths);
  }
  const detachedTranscriptJobIds = await detachTranscriptJobsForKnowledgebaseDocuments(
    tenantId,
    kbId,
    documents.map((document) => document.id),
  );
  await supersedeLessonAuthorBlueprintsForDocuments(
    tenantId,
    kbId,
    documents.map((document) => document.id),
  );
  for (const document of documents) {
    if ((await kbRepository.deleteDocument(document.id, kbId, tenantId)) !== 1) {
      throw new AppError('Không thể đưa tài liệu vào hàng đợi xoá', 409);
    }
    await enqueueKbOperation({
      tenantId,
      kbId,
      documentId: null,
      targetDocumentId: document.id,
      operation: 'document_delete',
      payload: { file_path: document.file_path, gemini_paths: pathsByDocument.get(document.id) || [] },
    });
  }
  return { deleted: documents.length, documents, detachedTranscriptJobIds };
}

export async function queueDocumentRetry(docIds: string[], kbId: string, tenantId: string): Promise<{ retried: number }> {
  if (docIds.length === 0) return { retried: 0 };
  await assertKnowledgebaseMutable(kbId, tenantId, 'thu lai tai lieu');
  const updated = await kbRepository.markDocumentsForRetry(docIds, kbId, tenantId);
  // A first-upload failure is retried through the re-upload workflow so it can
  // also clean up a partial Gemini mapping. Remove only terminal leftovers;
  // active jobs are excluded by the status/error transition above.
  if (updated.length > 0) {
    await kbRepository.deleteFailedUploadJobs(updated.map(document => document.id));
  }
  for (const document of updated) {
    await enqueueKbOperation({ tenantId, kbId, documentId: document.id, operation: 'document_reupload' });
  }
  return { retried: updated.length };
}

export async function queueKnowledgebaseDeletion(id: string, tenantId: string): Promise<boolean> {
  const kb = await kbRepository.lockKnowledgebase(id, tenantId);
  if (!kb) return false;
  await assertNoActiveAiEngineTransition(tenantId, 'xoa Kho tri thuc');
  if (isRestoreActiveState(kb.restore_state)) {
    throw new AppError('Không thể xoá Kho tri thức đang được khôi phục', 409);
  }
  const bots = await kbRepository.countChatbotsUsingKb(id, tenantId);
  const assignments = await kbRepository.countKbAssignments(id, tenantId);
  if ((bots?.cnt || 0) > 0) throw new AppError(`Không thể xoá KB — đang có ${bots!.cnt} bot sử dụng`, 409);
  if ((assignments?.cnt || 0) > 0) throw new AppError('Không thể xoá KB đang được gán cho chuyên gia bài học', 409);
  // C4 for the whole knowledge base: an active AI ID run designs from its documents (e.g. the AI ID knowledge base
  // was reassigned while the run was writing). Checked under the knowledge base row lock.
  if (await knowledgebaseHasActiveRuns({ query }, { tenantId, kbId: id })) throw new KbInUseByAiIdError();
  await supersedeLessonAuthorBlueprintsForKnowledgebase(tenantId, id);
  await enqueueKbOperation({ tenantId, kbId: id, operation: 'knowledgebase_delete' });
  return true;
}

export async function updateArticleFromStagedSource(
  docId: string,
  kbId: string,
  tenantId: string,
  input: UpdateArticleInput,
  staged: StagedKbSource,
): Promise<{ document: KbDocument; previousName: string } | null> {
  await assertKnowledgebaseMutable(kbId, tenantId, 'sua bai viet');
  const existing = await kbRepository.lockArticle(docId, kbId, tenantId);
  if (!existing) return null;
  if (existing.status === 'learning' || existing.status === 'deleting') {
    throw new AppError('Không thể sửa bài viết đang được xử lý', 409);
  }
  if (input.expected_updated_at && existing.updated_at
      && new Date(input.expected_updated_at).getTime() !== new Date(existing.updated_at).getTime()) {
    throw new AppError('Bài viết đã được người khác chỉnh sửa. Vui lòng tải lại trang và thử lại.', 409);
  }
  const document = (await kbRepository.updateArticleSource(docId, kbId, tenantId, staged)) || null;
  if (!document) return null;
  await supersedeLessonAuthorBlueprintsForDocuments(tenantId, kbId, [docId]);
  await enqueueKbOperation({
    tenantId,
    kbId,
    documentId: docId,
    operation: 'document_reupload',
    payload: { previous_file_path: existing.file_path },
  });
  return { document, previousName: existing.name };
}
