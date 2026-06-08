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
import { fixMulterFilename } from '../../config/storage.js';
import { auditFromReq } from '../../middleware/audit-log.js';

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

  const kb = await kbService.createKnowledgebase(tenantId, parsed.data, req.user!.id);
  auditFromReq(req, 'CREATE', 'knowledgebase', kb.id, kb.name);
  sendSuccess(res, kb, undefined, 201);
}

export async function updateKb(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenantId!;
  const parsed = updateKbSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, parsed.error.errors[0].message, 400); return; }

  const kb = await kbService.updateKnowledgebase(req.params.id, tenantId, parsed.data);
  if (!kb) { sendError(res, 'Knowledge Base không tồn tại', 404); return; }
  auditFromReq(req, 'UPDATE', 'knowledgebase', kb.id, kb.name);
  sendSuccess(res, kb);
}

export async function deleteKb(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenantId!;
  try {
    // Fetch name before deleting for audit log
    const kb = await kbService.getKnowledgebase(req.params.id, tenantId);
    if (!kb) { sendError(res, 'Knowledge Base không tồn tại', 404); return; }
    const deleted = await kbService.deleteKnowledgebase(req.params.id, tenantId);
    if (!deleted) { sendError(res, 'Lỗi xoá KB', 500); return; }
    auditFromReq(req, 'DELETE', 'knowledgebase', req.params.id, kb.name);
    sendSuccess(res, { deleted: true });
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}

// ── Document CRUD (Files tab) ──

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

    try {
      const doc = await kbService.uploadDocument(kbId, tenantId, req.user!.id, file);
      results.push({ file: file.originalname, success: true, data: doc });
    } catch (err: any) {
      results.push({ file: file.originalname, success: false, error: err.message });
    }
  }

  const successCount = results.filter(r => r.success).length;
  if (successCount > 0) auditFromReq(req, 'CREATE', 'kb_document', kbId, undefined, `Upload ${successCount} files`);
  sendSuccess(res, { results, uploaded: successCount, failed: files.length - successCount }, undefined, 201);
}

export async function deleteDocument(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenantId!;
  const { kbId, docId } = req.params;
  // Fetch doc name before deleting for audit
  const doc = await kbService.getDocument(docId, tenantId);
  const deleted = await kbService.deleteDocument(docId, kbId, tenantId);
  if (!deleted) { sendError(res, 'Document không tồn tại', 404); return; }
  auditFromReq(req, 'DELETE', 'kb_document', docId, doc?.name || docId);
  sendSuccess(res, { deleted: true });
}

export async function bulkDeleteDocuments(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenantId!;
  const kbId = req.params.kbId;
  const docIds: string[] = req.body?.doc_ids;

  if (!Array.isArray(docIds) || docIds.length === 0) { sendError(res, 'doc_ids phải là mảng UUID không rỗng', 400); return; }
  if (docIds.length > 500) { sendError(res, 'Tối đa 500 tài liệu mỗi lần xoá', 400); return; }

  try {
    const result = await kbService.bulkDeleteDocuments(docIds, kbId, tenantId);
    auditFromReq(req, 'DELETE', 'kb_document', kbId, undefined, `Bulk delete ${result.deleted} docs`);
    sendSuccess(res, result);
  } catch (err: any) { sendError(res, err.message, 500); }
}

export async function retryDocuments(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenantId!;
  const kbId = req.params.kbId;
  const docIds: string[] = req.body?.doc_ids;

  if (!Array.isArray(docIds) || docIds.length === 0) { sendError(res, 'doc_ids phải là mảng UUID không rỗng', 400); return; }
  if (docIds.length > 100) { sendError(res, 'Tối đa 100 tài liệu mỗi lần retry', 400); return; }

  try {
    const result = await kbService.retryDocuments(docIds, kbId, tenantId);
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
    const doc = await kbService.uploadFaqDocument(kbId, tenantId, req.user!.id, file);
    auditFromReq(req, 'CREATE', 'kb_document', doc.id, doc.name, 'FAQ upload');
    sendSuccess(res, doc, undefined, 201);
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

  try {
    const doc = await kbService.uploadArticle(kbId, tenantId, req.user!.id, parsed.data);
    auditFromReq(req, 'CREATE', 'kb_document', doc.id, doc.name, 'Article create');
    sendSuccess(res, doc, undefined, 201);
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

export async function updateArticle(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenantId!;
  const { kbId, docId } = req.params;
  const parsed = updateArticleSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, parsed.error.errors[0].message, 400); return; }

  try {
    const doc = await kbService.updateArticle(docId, kbId, tenantId, parsed.data);
    if (!doc) { sendError(res, 'Article không tồn tại', 404); return; }
    auditFromReq(req, 'UPDATE', 'kb_document', docId, doc.name, 'Article update');
    sendSuccess(res, doc);
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

export async function getArticle(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenantId!;
  const doc = await kbService.getDocument(req.params.docId, tenantId);
  if (!doc || doc.type !== 'article') { sendError(res, 'Article không tồn tại', 404); return; }
  sendSuccess(res, doc);
}
