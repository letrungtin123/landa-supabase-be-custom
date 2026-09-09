// ═══════════════════════════════════════════════════════════════
// KB Controller — HTTP handlers for Knowledge Base + Documents
// ═══════════════════════════════════════════════════════════════

import type { Request, Response } from 'express';
import { sendSuccess, sendError } from '../../utils/response.js';
import {
  createKbSchema, updateKbSchema, createArticleSchema, updateArticleSchema,
  ALLOWED_KB_EXTENSIONS, MAX_KB_FILE_SIZE,
  ALLOWED_FAQ_EXTENSIONS, MAX_FAQ_FILE_SIZE,
} from './kb.validator.js';
import * as kbService from './kb.service.js';
import { getGeminiApiKey } from './gemini.service.js';
import { invalidateGeminiStoreNameCache } from './chat.service.js';
import { fixMulterFilename } from '../../config/storage.js';
import { createTransactionalAuditEntry, runAuditedTransaction } from '../../middleware/audit-log.js';

// ── KB CRUD ──

export async function listKbs(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenantId!;
  const page = parseInt(req.query.page as string) || 1;
  const pageSize = ([5, 10, 20].includes(parseInt(req.query.page_size as string)) ? parseInt(req.query.page_size as string) : 10);
  const search = req.query.search as string;

  const result = await kbService.listKnowledgebases(tenantId, { page, pageSize, search });
  sendSuccess(res, result);
}

export async function getKb(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenantId!;
  const kb = await kbService.getKnowledgebase(req.params.id, tenantId);
  if (!kb) { sendError(res, 'Knowledge Base không tồn tại', 404); return; }
  sendSuccess(res, kb);
}

export async function createKb(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenantId!;
  const parsed = createKbSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, parsed.error.errors[0].message, 400); return; }

  const kb = await runAuditedTransaction(
    () => kbService.createKnowledgebase(tenantId, parsed.data, req.user!.id),
    (created) => createTransactionalAuditEntry(req, 'CREATE', 'knowledgebase', { code: 'knowledgebase.created' }, created.id, created.name),
  );
  sendSuccess(res, kb, undefined, 201);
}

export async function updateKb(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenantId!;
  const parsed = updateKbSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, parsed.error.errors[0].message, 400); return; }

  let previous: Awaited<ReturnType<typeof kbService.getKnowledgebase>> | undefined;
  const kb = await runAuditedTransaction(
    async () => {
      // Audit snapshots must be read from the same transaction as the write.
      previous = await kbService.getKnowledgebase(req.params.id, tenantId);
      return kbService.updateKnowledgebase(req.params.id, tenantId, parsed.data);
    },
    (updated) => updated ? createTransactionalAuditEntry(
      req, 'UPDATE', 'knowledgebase',
      { code: 'knowledgebase.updated', changes: previous && previous.name !== updated.name ? [{ field: 'name', before: previous.name, after: updated.name }] : [] },
      updated.id, updated.name,
    ) : null,
  );
  if (!kb) { sendError(res, 'Knowledge Base không tồn tại', 404); return; }
  sendSuccess(res, kb);
}

export async function deleteKb(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenantId!;
  try {
    // Fetch name before deleting for audit log
    const kb = await kbService.getKnowledgebase(req.params.id, tenantId);
    if (!kb) { sendError(res, 'Knowledge Base không tồn tại', 404); return; }
    const queued = await runAuditedTransaction(
      () => kbService.queueKnowledgebaseDeletion(req.params.id, tenantId),
      (didQueue) => didQueue ? createTransactionalAuditEntry(req, 'DELETE', 'knowledgebase', { code: 'knowledgebase.deleted' }, kb.id, kb.name) : null,
    );
    if (!queued) { sendError(res, 'Knowledge Base không tồn tại', 404); return; }
    sendSuccess(res, { queued: true }, 'Đã đưa Kho tri thức vào hàng đợi xoá an toàn', 202);
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}

// ── Document CRUD (Files tab) ──

export async function restoreKb(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenantId!;
  const kbId = req.params.kbId;

  try {
    const kb = await kbService.getKnowledgebase(kbId, tenantId);
    if (!kb) { sendError(res, 'Knowledge Base khong ton tai', 404); return; }

    const result = await runAuditedTransaction(
      () => kbService.enqueueKnowledgebaseRestore(kbId, tenantId),
      () => createTransactionalAuditEntry(req, 'UPDATE', 'knowledgebase', { code: 'knowledgebase.restore.queued' }, kbId, kb.name),
    );
    // This runs only after the Audit transaction committed. If RabbitMQ is
    // unavailable, kb_restore_jobs remains the durable recovery source.
    await kbService.dispatchKnowledgebaseRestore({ jobId: result.job_id, kbId, tenantId });
    invalidateGeminiStoreNameCache(kbId);
    sendSuccess(res, result, 'Da dua kho tri thuc vao hang doi khoi phuc', 202);
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}

export async function listDocuments(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenantId!;
  const page = parseInt(req.query.page as string) || 1;
  const pageSize = ([5, 10, 20].includes(parseInt(req.query.page_size as string)) ? parseInt(req.query.page_size as string) : 10);

  const result = await kbService.listDocuments({
    kbId: req.params.kbId,
    tenantId,
    page,
    pageSize,
    search: req.query.search as string,
    status: req.query.status as string,
    type: req.query.type as string,
  });
  sendSuccess(res, result);
}

/**
 * Multi-file upload (Files tab) — up to 20 files.
 */
export async function uploadDocuments(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenantId!;
  const kbId = req.params.kbId;
  const files = req.files as Express.Multer.File[];
  if (!files || files.length === 0) { sendError(res, 'Không có file upload', 400); return; }
  if (files.length > 20) { sendError(res, 'Tối đa 20 file mỗi lần upload', 400); return; }

  try { await getGeminiApiKey(tenantId); } catch (err: any) { sendError(res, err.message, 400); return; }

  const kb = await kbService.getKnowledgebase(kbId, tenantId);
  if (!kb) { sendError(res, 'Knowledge Base không tồn tại', 404); return; }

  const results: { file: string; success: boolean; data?: any; error?: string }[] = [];

  for (const file of files) {
    file.originalname = fixMulterFilename(file.originalname);
    const ext = file.originalname.substring(file.originalname.lastIndexOf('.')).toLowerCase();

    if (!ALLOWED_KB_EXTENSIONS.includes(ext)) {
      results.push({ file: file.originalname, success: false, error: `Định dạng ${ext} không hỗ trợ` });
      continue;
    }
    if (file.size > MAX_KB_FILE_SIZE) {
      results.push({ file: file.originalname, success: false, error: `Quá lớn (${(file.size / 1024 / 1024).toFixed(1)}MB)` });
      continue;
    }

    let staged: kbService.StagedKbSource | null = null;
    try {
      staged = await kbService.stageDocumentSource(kbId, tenantId, file);
      const doc = await runAuditedTransaction(
        () => kbService.createQueuedDocumentFromStagedSource(kbId, tenantId, req.user!.id, staged!),
        (created) => createTransactionalAuditEntry(req, 'CREATE', 'kb_document', { code: 'knowledgebase.document.created', context: { parent_name: kb.name, file_name: created.name, file_size_bytes: file.size } }, created.id, created.name),
      );
      results.push({ file: file.originalname, success: true, data: doc });
    } catch (err: any) {
      await kbService.discardStagedKbSource(staged);
      results.push({ file: file.originalname, success: false, error: err.message });
    }
  }

  const successCount = results.filter(r => r.success).length;
  sendSuccess(res, { results, uploaded: successCount, failed: files.length - successCount }, undefined, 201);
}

export async function deleteDocument(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenantId!;
  const { kbId, docId } = req.params;
  try {
    // Fetch doc name before deleting for audit
    const doc = await kbService.getDocument(docId, tenantId);
    const kb = await kbService.getKnowledgebase(kbId, tenantId);
    if (!doc) { sendError(res, 'Document không tồn tại', 404); return; }
    if (doc.status === 'learning') { sendError(res, 'Không thể xoá tài liệu đang được huấn luyện', 400); return; }
    const queued = await runAuditedTransaction(
      () => kbService.queueDocumentDeletion(docId, kbId, tenantId),
      (queuedDocument) => queuedDocument ? createTransactionalAuditEntry(req, 'DELETE', 'kb_document', { code: 'knowledgebase.document.deleted', context: { parent_name: kb?.name } }, docId, queuedDocument.name) : null,
    );
    if (!queued) { sendError(res, 'Không thể đưa tài liệu vào hàng đợi xoá', 400); return; }
    sendSuccess(res, { queued: true }, 'Đã đưa tài liệu vào hàng đợi xoá an toàn', 202);
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}

export async function bulkDeleteDocuments(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenantId!;
  const kbId = req.params.kbId;
  const docIds: string[] = req.body?.doc_ids;

  if (!Array.isArray(docIds) || docIds.length === 0) { sendError(res, 'doc_ids phải là mảng UUID không rỗng', 400); return; }
  if (docIds.length > 500) { sendError(res, 'Tối đa 500 tài liệu mỗi lần xoá', 400); return; }

  try {
    const kb = await kbService.getKnowledgebase(kbId, tenantId);
    const result = await runAuditedTransaction(
      () => kbService.queueBulkDocumentDeletion(docIds, kbId, tenantId),
      (deleted) => deleted.deleted > 0 ? createTransactionalAuditEntry(req, 'DELETE', 'kb_document', { code: 'knowledgebase.document.bulk_deleted', context: { parent_name: kb?.name, affected_count: deleted.deleted } }, kbId, kb?.name) : null,
    );
    sendSuccess(res, { deleted: result.deleted, queued: result.deleted }, undefined, 202);
  } catch (err: any) { sendError(res, err.message, 500); }
}

export async function retryDocuments(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenantId!;
  const kbId = req.params.kbId;
  const docIds: string[] = req.body?.doc_ids;

  if (!Array.isArray(docIds) || docIds.length === 0) { sendError(res, 'doc_ids phải là mảng UUID không rỗng', 400); return; }
  if (docIds.length > 100) { sendError(res, 'Tối đa 100 tài liệu mỗi lần retry', 400); return; }

  try {
    const kb = await kbService.getKnowledgebase(kbId, tenantId);
    const result = await runAuditedTransaction(
      () => kbService.queueDocumentRetry(docIds, kbId, tenantId),
      (retried) => retried.retried > 0 ? createTransactionalAuditEntry(
        req,
        'UPDATE',
        'kb_document',
        { code: 'knowledgebase.document.retry_queued', context: { parent_name: kb?.name, affected_count: retried.retried } },
        kbId,
        kb?.name,
      ) : null,
    );
    sendSuccess(res, result);
  } catch (err: any) { sendError(res, err.message, 500); }
}

// ── FAQ Upload ──

/**
 * Upload FAQ xlsx file — validate template → enqueue Gemini.
 */
export async function uploadFaqDocument(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenantId!;
  const kbId = req.params.kbId;

  const file = req.file;
  if (!file) { sendError(res, 'Không có file upload', 400); return; }

  file.originalname = fixMulterFilename(file.originalname);
  const ext = file.originalname.substring(file.originalname.lastIndexOf('.')).toLowerCase();

  if (!ALLOWED_FAQ_EXTENSIONS.includes(ext)) {
    sendError(res, `Chỉ hỗ trợ file ${ALLOWED_FAQ_EXTENSIONS.join(', ')}`, 400);
    return;
  }
  if (file.size > MAX_FAQ_FILE_SIZE) {
    sendError(res, `File quá lớn (tối đa ${MAX_FAQ_FILE_SIZE / 1024 / 1024}MB)`, 400);
    return;
  }

  try { await getGeminiApiKey(tenantId); } catch (err: any) { sendError(res, err.message, 400); return; }

  const kb = await kbService.getKnowledgebase(kbId, tenantId);
  if (!kb) { sendError(res, 'Knowledge Base không tồn tại', 404); return; }

  try {
    let staged: kbService.StagedKbSource | null = null;
    try {
      staged = await kbService.stageFaqSource(kbId, tenantId, file);
      const doc = await runAuditedTransaction(
        () => kbService.createQueuedDocumentFromStagedSource(kbId, tenantId, req.user!.id, staged!),
      (created) => createTransactionalAuditEntry(req, 'CREATE', 'kb_document', { code: 'knowledgebase.document.created', context: { parent_name: kb.name, file_name: created.name, file_size_bytes: file.size } }, created.id, created.name),
      );
      sendSuccess(res, doc, undefined, 201);
    } catch (err: any) {
      await kbService.discardStagedKbSource(staged);
      throw err;
    }
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}

/**
 * Download FAQ template xlsx.
 */
export async function downloadFaqTemplate(_req: Request, res: Response): Promise<void> {
  try {
    const buffer = kbService.generateFaqTemplate();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="faq_template.xlsx"');
    res.send(buffer);
  } catch (err: any) {
    sendError(res, 'Lỗi tạo template', 500);
  }
}

// ── Article CRUD ──

export async function createArticle(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenantId!;
  const kbId = req.params.kbId;
  const parsed = createArticleSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, parsed.error.errors[0].message, 400); return; }

  try { await getGeminiApiKey(tenantId); } catch (err: any) { sendError(res, err.message, 400); return; }

  const kb = await kbService.getKnowledgebase(kbId, tenantId);
  if (!kb) { sendError(res, 'Knowledge Base không tồn tại', 404); return; }

  let staged: kbService.StagedKbSource | null = null;
  try {
    staged = await kbService.stageArticleSource(kbId, tenantId, parsed.data);
    const doc = await runAuditedTransaction(
      () => kbService.createQueuedDocumentFromStagedSource(kbId, tenantId, req.user!.id, staged!),
      (created) => createTransactionalAuditEntry(req, 'CREATE', 'kb_document', { code: 'knowledgebase.document.created', context: { parent_name: kb.name } }, created.id, created.name),
    );
    sendSuccess(res, doc, undefined, 201);
  } catch (err: any) {
    await kbService.discardStagedKbSource(staged);
    sendError(res, err.message, 500);
  }
}

export async function updateArticle(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenantId!;
  const { kbId, docId } = req.params;
  const parsed = updateArticleSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, parsed.error.errors[0].message, 400); return; }

  let staged: kbService.StagedKbSource | null = null;
  let committed = false;
  try {
    const previous = await kbService.getDocument(docId, tenantId);
    if (!previous || previous.type !== 'article' || previous.kb_id !== kbId) { sendError(res, 'Article không tồn tại', 404); return; }
    const kb = await kbService.getKnowledgebase(kbId, tenantId);
    staged = await kbService.stageArticleSource(
      kbId,
      tenantId,
      { title: parsed.data.title ?? previous.name, content: parsed.data.content ?? previous.content ?? '' },
      docId,
    );
    const doc = await runAuditedTransaction(
      () => kbService.updateArticleFromStagedSource(docId, kbId, tenantId, parsed.data, staged!),
      (updated) => updated ? createTransactionalAuditEntry(
        req, 'UPDATE', 'kb_document',
        { code: 'knowledgebase.document.updated', context: { parent_name: kb?.name }, changes: updated.previousName !== updated.document.name ? [{ field: 'name', before: updated.previousName, after: updated.document.name }] : [] },
        docId, updated.document.name,
      ) : null,
    );
    if (!doc) { await kbService.discardStagedKbSource(staged); sendError(res, 'Article không tồn tại', 404); return; }
    committed = true;
    sendSuccess(res, doc.document);
  } catch (err: any) {
    if (!committed) await kbService.discardStagedKbSource(staged);
    sendError(res, err.message, 500);
  }
}

export async function getArticle(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenantId!;
  const doc = await kbService.getDocument(req.params.docId, tenantId);
  if (!doc || doc.type !== 'article') { sendError(res, 'Article không tồn tại', 404); return; }
  sendSuccess(res, doc);
}
