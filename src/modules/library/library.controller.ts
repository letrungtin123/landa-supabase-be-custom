// ═══════════════════════════════════════════════════════════════
// Library Controller — Documents + Categories endpoints
// ═══════════════════════════════════════════════════════════════

import type { Request, Response, NextFunction } from 'express';
import * as libService from './library.service.js';
import { sendSuccess, sendError } from '../../utils/response.js';
import { auditFromReq } from '../../middleware/audit-log.js';

// ── Document Categories ──

export async function listCategoriesController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    const result = await libService.listDocCategories(tenantId, req.query as Record<string, unknown>);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

export async function createCategoryController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id là bắt buộc', 400); return; }
    if (!req.body.name) { sendError(res, 'name là bắt buộc', 400); return; }
    const cat = await libService.createDocCategory(tenantId, req.body);
    auditFromReq(req, 'CREATE', 'document_category', cat.id, cat.name);
    sendSuccess(res, cat, 'Tạo danh mục thành công', 201);
  } catch (err) { next(err); }
}

export async function updateCategoryController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const cat = await libService.updateDocCategory(req.params.id, req.body);
    auditFromReq(req, 'UPDATE', 'document_category', cat.id, cat.name);
    sendSuccess(res, cat);
  } catch (err) { next(err); }
}

export async function deleteCategoryController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await libService.deleteDocCategory(req.params.id);
    auditFromReq(req, 'DELETE', 'document_category', req.params.id);
    sendSuccess(res, null, 'Xóa thành công');
  } catch (err) { next(err); }
}

export async function bulkDeleteCategoriesController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids)) { sendError(res, 'ids phải là mảng', 400); return; }
    const result = await libService.bulkDeleteDocCategories(ids);
    auditFromReq(req, 'DELETE', 'document_category', '', '', `Xóa ${result.deleted} danh mục`);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

// ── Documents ──

export async function listDocumentsController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    const result = await libService.listDocuments(tenantId, req.query as Record<string, unknown>);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

export async function createDocumentController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id là bắt buộc', 400); return; }
    const doc = await libService.createDocument(tenantId, req.body, req.user!.id);
    auditFromReq(req, 'CREATE', 'document', doc.id, doc.title);
    sendSuccess(res, doc, 'Tạo tài liệu thành công', 201);
  } catch (err) { next(err); }
}

export async function updateDocumentController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const doc = await libService.updateDocument(req.params.id, req.body);
    auditFromReq(req, 'UPDATE', 'document', doc.id);
    sendSuccess(res, doc);
  } catch (err) { next(err); }
}

export async function deleteDocumentController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await libService.deleteDocument(req.params.id);
    auditFromReq(req, 'DELETE', 'document', req.params.id);
    sendSuccess(res, null, 'Xóa thành công');
  } catch (err) { next(err); }
}

export async function bulkDocumentActionController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { ids, action, category_id } = req.body;
    if (!Array.isArray(ids) || !action) { sendError(res, 'ids và action là bắt buộc', 400); return; }
    const result = await libService.bulkDocumentAction(ids, action, category_id);
    auditFromReq(req, 'UPDATE', 'document', '', '', `Bulk ${action}: ${result.updated} documents`);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}
