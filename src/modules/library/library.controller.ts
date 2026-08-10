// ═══════════════════════════════════════════════════════════════
// Library Controller — Documents + Categories endpoints
// ═══════════════════════════════════════════════════════════════

import fs from 'fs/promises';
import type { Request, Response, NextFunction } from 'express';
import * as libService from './library.service.js';
import { sendSuccess, sendError } from '../../utils/response.js';
import { auditFromReq } from '../../middleware/audit-log.js';
import {
  uploadFileFromPath,
  buildFileName,
  buildStoragePath,
  deleteFile,
  deleteFileByUrl,
  fixMulterFilename,
} from '../../config/storage.js';
import { LIBRARY_DOCUMENT_MAX_UPLOAD_BYTES, LIBRARY_DOCUMENT_MAX_UPLOAD_LABEL } from '../../config/upload-limits.js';

function formatUploadSizeMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error';
}

async function cleanupTempUpload(file: Express.Multer.File): Promise<void> {
  if (!file.path) return;
  await fs.unlink(file.path).catch(() => {});
}
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
    const cat = await libService.deleteDocCategory(req.params.id);
    auditFromReq(req, 'DELETE', 'document_category', req.params.id, cat?.name);
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
    auditFromReq(req, 'UPDATE', 'document', doc.id, doc.title);
    sendSuccess(res, doc);
  } catch (err) { next(err); }
}

export async function deleteDocumentController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const doc = await libService.deleteDocument(req.params.id);
    // Cleanup storage
    await deleteFileByUrl(doc.file_url).catch(() => {});
    auditFromReq(req, 'DELETE', 'document', req.params.id, doc.title);
    sendSuccess(res, null, 'Xóa thành công');
  } catch (err) { next(err); }
}

export async function bulkDocumentActionController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { ids, action, category_id } = req.body;
    if (!Array.isArray(ids) || !action) { sendError(res, 'ids và action là bắt buộc', 400); return; }

    // If bulk delete — fetch file_urls first, then delete from DB + storage
    if (action === 'delete') {
      const { rows } = await (await import('../../config/database.js')).query<{ id: string; file_url: string | null }>(
        'DELETE FROM documents WHERE id = ANY($1) RETURNING id, file_url', [ids]
      );
      // Cleanup storage in background
      const deletePromises = rows
        .filter(r => r.file_url)
        .map(r => deleteFileByUrl(r.file_url).catch(() => {}));
      await Promise.all(deletePromises);
      auditFromReq(req, 'DELETE', 'document', '', '', `Bulk delete: ${rows.length} documents`);
      sendSuccess(res, { deleted: rows.length });
      return;
    }

    const result = await libService.bulkDocumentAction(ids, action, category_id);
    auditFromReq(req, 'UPDATE', 'document', '', '', `Bulk ${action}: ${result.updated} documents`);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

/** POST /api/library/documents/upload — Upload multiple files to Supabase Storage + create records */
export async function uploadDocumentController(req: Request, res: Response, next: NextFunction): Promise<void> {
  const tempFiles = (req.files as Express.Multer.File[] | undefined) ?? [];

  try {
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id là bắt buộc', 400); return; }
    if (tempFiles.length === 0) { sendError(res, 'Chưa có file upload', 400); return; }

    const docs: any[] = [];
    const errors: string[] = [];

    for (const file of tempFiles) {
      const originalName = fixMulterFilename(file.originalname);
      let storagePath = '';
      let storageUploaded = false;

      try {
        if (file.size > LIBRARY_DOCUMENT_MAX_UPLOAD_BYTES) {
          throw new Error(`quá giới hạn upload ${LIBRARY_DOCUMENT_MAX_UPLOAD_LABEL}. Dung lượng hiện tại: ${formatUploadSizeMb(file.size)}.`);
        }

        if (!file.path) {
          throw new Error('không đọc được file từ vùng tạm upload.');
        }

        const fileName = buildFileName(originalName);
        storagePath = buildStoragePath(tenantId, 'library', fileName);

        await uploadFileFromPath(storagePath, file.path, file.mimetype || 'application/octet-stream');
        storageUploaded = true;

        const ext = originalName.split('.').pop()?.toLowerCase() || '';
        const doc = await libService.createDocument(tenantId, {
          title: req.body.title || originalName,
          file_url: storagePath,
          file_size: file.size,
          extension: ext,
          category_id: req.body.category_id || null,
          is_visible: req.body.is_visible !== 'false',
        }, req.user!.id, { invalidateCache: false });

        auditFromReq(req, 'CREATE', 'document', doc.id, doc.title);
        docs.push(doc);
      } catch (err) {
        if (storageUploaded && storagePath) {
          await deleteFile(storagePath).catch(() => {});
        }
        errors.push(`${originalName}: ${getErrorMessage(err)}`);
      } finally {
        await cleanupTempUpload(file);
      }
    }

    if (docs.length > 0) {
      await libService.invalidateLibraryCache(tenantId);
    }

    const uploaded = docs.length;
    const failed = tempFiles.length - uploaded;
    sendSuccess(res, { uploaded, failed, documents: docs, errors }, `Upload ${uploaded}/${tempFiles.length} tài liệu thành công`, 201);
  } catch (err) {
    await Promise.all(tempFiles.map(cleanupTempUpload));
    next(err);
  }
}
