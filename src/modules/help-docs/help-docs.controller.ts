import type { Request, Response, NextFunction } from 'express';
import * as svc from './help-docs.service.js';
import { sendSuccess, sendError } from '../../utils/response.js';
import { createTransactionalAuditEntry, runAuditedTransaction } from '../../middleware/audit-log.js';
import { uploadFile, buildFileName, buildStoragePath, fixMulterFilename, deleteFile } from '../../config/storage.js';

async function deleteStoragePaths(paths: string[]): Promise<void> {
  await Promise.allSettled(paths.map((path) => deleteFile(path)));
}

// ═══ Folders ═══

export async function listFoldersController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id là bắt buộc', 400); return; }
    sendSuccess(res, await svc.listFolders(tenantId));
  } catch (err) { next(err); }
}

export async function createFolderController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id là bắt buộc', 400); return; }
    const result = await runAuditedTransaction(
      () => svc.createFolder(tenantId, req.body),
      (created) => createTransactionalAuditEntry(req, 'CREATE', 'help_folder', { code: 'help_folder.created' }, created.id, created.title),
    );
    sendSuccess(res, result, 'Tạo folder thành công', 201);
  } catch (err) { next(err); }
}

export async function updateFolderController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id là bắt buộc', 400); return; }
    const folder = await runAuditedTransaction(
      () => svc.updateFolder(req.params.id, tenantId, req.body),
      (updated) => createTransactionalAuditEntry(
        req,
        'UPDATE',
        'help_folder',
        {
          code: 'help_folder.updated',
          changes: updated.previousTitle !== updated.title
            ? [{ field: 'title', before: updated.previousTitle, after: updated.title }]
            : [],
        },
        updated.id,
        updated.title,
      ),
    );
    sendSuccess(res, { success: true });
  } catch (err) { next(err); }
}

export async function deleteFolderController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id là bắt buộc', 400); return; }
    const deleted = await runAuditedTransaction(
      () => svc.deleteFolder(req.params.id, tenantId),
      (result) => createTransactionalAuditEntry(req, 'DELETE', 'help_folder', { code: 'help_folder.deleted', context: { affected_count: result.storagePathsToDelete.length } }, result.id, result.title),
    );
    await deleteStoragePaths(deleted.storagePathsToDelete);
    sendSuccess(res, { success: true, deleted_images: deleted.storagePathsToDelete.length });
  } catch (err) { next(err); }
}

export async function reorderFoldersController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id là bắt buộc', 400); return; }
    const { ordered_ids } = req.body;
    if (!Array.isArray(ordered_ids)) { sendError(res, 'ordered_ids phải là mảng', 400); return; }
    await runAuditedTransaction(
      () => svc.reorderFolders(tenantId, ordered_ids),
      () => createTransactionalAuditEntry(req, 'UPDATE', 'help_folder', { code: 'help_folder.reordered', context: { affected_count: ordered_ids.length } }),
    );
    sendSuccess(res, { success: true });
  } catch (err) { next(err); }
}

// ═══ Pages ═══

export async function listPagesController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id là bắt buộc', 400); return; }
    sendSuccess(res, await svc.listPages(tenantId, req.query.folder_id as string | undefined));
  } catch (err) { next(err); }
}

export async function getPageController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id là bắt buộc', 400); return; }
    sendSuccess(res, await svc.getPage(req.params.id, tenantId));
  } catch (err) { next(err); }
}

export async function createPageController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id là bắt buộc', 400); return; }
    const folder = (await svc.listFolders(tenantId)).folders.find((item: { id: string; title: string }) => item.id === req.body?.folder_id);
    const result = await runAuditedTransaction(
      () => svc.createPage(tenantId, req.body, req.user!.id),
      (created) => createTransactionalAuditEntry(req, 'CREATE', 'help_page', { code: 'help_page.created', context: { parent_name: folder?.title } }, created.id, created.title),
    );
    sendSuccess(res, result, 'Tạo trang thành công', 201);
  } catch (err) { next(err); }
}

export async function updatePageController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id là bắt buộc', 400); return; }
    const current = await svc.getPage(req.params.id, tenantId);
    const page = await runAuditedTransaction(
      () => svc.updatePage(req.params.id, tenantId, req.body, req.user!.id),
      (updated) => createTransactionalAuditEntry(
        req,
        'UPDATE',
        'help_page',
        {
          code: 'help_page.updated',
          context: { parent_name: current.folder_title },
          changes: [
            ...(updated.previousTitle !== updated.title ? [{ field: 'title', before: updated.previousTitle || null, after: updated.title }] : []),
            ...(req.body.is_published !== undefined && updated.previousPublished !== req.body.is_published
              ? [{ field: 'is_published', before: updated.previousPublished ?? null, after: req.body.is_published }]
              : []),
          ],
        },
        updated.id,
        updated.title,
      ),
    );
    await deleteStoragePaths(page.storagePathsToDelete);
    sendSuccess(res, { success: true, deleted_images: page.storagePathsToDelete.length });
  } catch (err) { next(err); }
}

export async function deletePageController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id là bắt buộc', 400); return; }
    const current = await svc.getPage(req.params.id, tenantId);
    const deleted = await runAuditedTransaction(
      () => svc.deletePage(req.params.id, tenantId),
      (result) => createTransactionalAuditEntry(req, 'DELETE', 'help_page', { code: 'help_page.deleted', context: { parent_name: current.folder_title, affected_count: result.storagePathsToDelete.length } }, result.id, result.title),
    );
    await deleteStoragePaths(deleted.storagePathsToDelete);
    sendSuccess(res, { success: true, deleted_images: deleted.storagePathsToDelete.length });
  } catch (err) { next(err); }
}

export async function reorderPagesController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id là bắt buộc', 400); return; }
    const { folder_id, ordered_ids } = req.body;
    if (!folder_id || !Array.isArray(ordered_ids)) { sendError(res, 'folder_id và ordered_ids bắt buộc', 400); return; }
    const folder = (await svc.listFolders(tenantId)).folders.find((item: { id: string; title: string }) => item.id === folder_id);
    await runAuditedTransaction(
      () => svc.reorderPages(tenantId, folder_id, ordered_ids),
      () => createTransactionalAuditEntry(req, 'UPDATE', 'help_page', { code: 'help_page.reordered', context: { parent_name: folder?.title, affected_count: ordered_ids.length } }, folder_id, folder?.title),
    );
    sendSuccess(res, { success: true });
  } catch (err) { next(err); }
}

// ═══ Image Upload ═══

/** POST /api/help-docs/upload-image */
export async function uploadImageController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id là bắt buộc', 400); return; }
    if (!req.file) { sendError(res, 'No file uploaded', 400); return; }

    const file = req.file;
    if (!file.mimetype.startsWith('image/')) {
      sendError(res, 'File upload phải là ảnh', 400);
      return;
    }

    const originalName = fixMulterFilename(file.originalname);
    const fileName = buildFileName(originalName);
    const storagePath = buildStoragePath(tenantId, 'help-docs', fileName);

    const path = await uploadFile(storagePath, file.buffer, file.mimetype);
    try {
      await runAuditedTransaction(
        () => Promise.resolve(path),
        () => createTransactionalAuditEntry(req, 'CREATE', 'help_doc', { code: 'help_doc.image.uploaded', context: { file_name: originalName, file_size_bytes: file.size } }, path, originalName),
      );
    } catch (error) {
      await deleteFile(path).catch(() => undefined);
      throw error;
    }
    sendSuccess(res, { url: path, filename: originalName, size: file.size });
  } catch (err) { next(err); }
}

/** POST /api/help-docs/delete-image */
export async function deleteImageController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id là bắt buộc', 400); return; }

    const storagePath = typeof req.body?.storage_path === 'string'
      ? req.body.storage_path.trim()
      : typeof req.body?.path === 'string'
        ? req.body.path.trim()
        : '';
    if (!storagePath) { sendError(res, 'storage_path là bắt buộc', 400); return; }

    const result = await runAuditedTransaction(
      () => svc.deleteImage(tenantId, storagePath),
      (deleted) => createTransactionalAuditEntry(req, 'DELETE', 'help_doc', { code: 'help_doc.image.deleted', context: { file_name: deleted.title, affected_count: deleted.storagePathsToDelete.length } }, deleted.id, deleted.title),
    );
    await deleteStoragePaths(result.storagePathsToDelete);
    sendSuccess(res, { success: true, deleted_images: result.storagePathsToDelete.length });
  } catch (err) { next(err); }
}
