import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import {
  buildFileName,
  buildStoragePath,
  deleteFile,
  fixMulterFilename,
  uploadFile,
} from '../../config/storage.js';
import { createTransactionalAuditEntry, runAuditedTransaction } from '../../middleware/audit-log.js';
import { sendError, sendSuccess } from '../../utils/response.js';
import * as service from './news.service.js';
import { detectNewsImage, downloadRemoteNewsImage } from './news-remote-image.logic.js';
import {
  createNewsSchema,
  deleteNewsImageSchema,
  importNewsImageSchema,
  listNewsSchema,
  updateNewsSchema,
  uploadNewsImageSchema,
} from './news.validator.js';

function requireTenantId(req: Request, res: Response): string | null {
  const tenantId = req.user?.tenantId || null;
  if (!tenantId) sendError(res, 'tenant_id là bắt buộc', 400);
  return tenantId;
}

function validationError(res: Response, error: { errors: Array<{ message: string }> }): void {
  sendError(res, error.errors[0]?.message || 'Dữ liệu không hợp lệ', 400);
}

async function cleanupStoragePaths(paths: string[]): Promise<void> {
  const deleted: string[] = [];
  for (const path of [...new Set(paths)]) {
    try {
      await deleteFile(path);
      deleted.push(path);
    } catch (error) {
      console.warn(`[News] Deferred storage delete for ${path}:`, error instanceof Error ? error.message : String(error));
    }
  }
  await service.completeNewsAssetDeletes(deleted);
}

export async function listPublished(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = requireTenantId(req, res); if (!tenantId) return;
    const parsed = listNewsSchema.safeParse({ ...req.query, status: 'active' });
    if (!parsed.success) { validationError(res, parsed.error); return; }
    sendSuccess(res, await service.listPublishedNews(tenantId, parsed.data));
  } catch (error) { next(error); }
}

export async function getPublished(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = requireTenantId(req, res); if (!tenantId) return;
    sendSuccess(res, await service.getNewsPost(tenantId, req.params.id, false));
  } catch (error) { next(error); }
}

export async function listManaged(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = requireTenantId(req, res); if (!tenantId) return;
    const parsed = listNewsSchema.safeParse(req.query);
    if (!parsed.success) { validationError(res, parsed.error); return; }
    sendSuccess(res, await service.listManagedNews(tenantId, parsed.data));
  } catch (error) { next(error); }
}

export async function getManaged(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = requireTenantId(req, res); if (!tenantId) return;
    sendSuccess(res, await service.getNewsPost(tenantId, req.params.id, true));
  } catch (error) { next(error); }
}

export async function create(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = requireTenantId(req, res); if (!tenantId) return;
    const parsed = createNewsSchema.safeParse(req.body);
    if (!parsed.success) { validationError(res, parsed.error); return; }
    const result = await runAuditedTransaction(
      () => service.createNewsPost(tenantId, req.user!.id, parsed.data),
      (created) => createTransactionalAuditEntry(req, 'CREATE', 'news_post', { code: 'news.created' }, created.post.id, created.post.title),
    );
    await cleanupStoragePaths(result.storagePathsToDelete);
    sendSuccess(res, result.post, 'Tạo bài viết thành công', 201);
  } catch (error) { next(error); }
}

export async function update(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = requireTenantId(req, res); if (!tenantId) return;
    const parsed = updateNewsSchema.safeParse(req.body);
    if (!parsed.success) { validationError(res, parsed.error); return; }
    const result = await runAuditedTransaction(
      () => service.updateNewsPost(tenantId, req.params.id, req.user!.id, parsed.data),
      (updated) => createTransactionalAuditEntry(req, 'UPDATE', 'news_post', {
        code: 'news.updated',
        changes: updated.previousTitle !== updated.post.title
          ? [{ field: 'title', before: updated.previousTitle || null, after: updated.post.title }]
          : [],
      }, updated.post.id, updated.post.title),
    );
    await cleanupStoragePaths(result.storagePathsToDelete);
    sendSuccess(res, result.post, 'Cập nhật bài viết thành công');
  } catch (error) { next(error); }
}

export async function archive(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = requireTenantId(req, res); if (!tenantId) return;
    const post = await runAuditedTransaction(
      () => service.archiveNewsPost(tenantId, req.params.id, req.user!.id),
      (archived) => createTransactionalAuditEntry(req, 'DELETE', 'news_post', { code: 'news.archived' }, archived.id, archived.title),
    );
    sendSuccess(res, post, 'Đã lưu trữ bài viết');
  } catch (error) { next(error); }
}

export async function restore(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = requireTenantId(req, res); if (!tenantId) return;
    const post = await runAuditedTransaction(
      () => service.restoreNewsPost(tenantId, req.params.id, req.user!.id),
      (restored) => createTransactionalAuditEntry(req, 'UPDATE', 'news_post', { code: 'news.restored' }, restored.id, restored.title),
    );
    sendSuccess(res, post, 'Đã khôi phục bài viết');
  } catch (error) { next(error); }
}

export async function uploadImage(req: Request, res: Response, next: NextFunction): Promise<void> {
  let uploadedPath: string | null = null;
  try {
    const tenantId = requireTenantId(req, res); if (!tenantId) return;
    const parsed = uploadNewsImageSchema.safeParse(req.body);
    if (!parsed.success) { validationError(res, parsed.error); return; }
    if (!req.file) { sendError(res, 'Chưa chọn ảnh tải lên', 400); return; }
    const detected = detectNewsImage(req.file.buffer);
    if (!detected) { sendError(res, 'Chỉ hỗ trợ ảnh JPEG, PNG, WebP hoặc GIF', 400); return; }

    const originalName = fixMulterFilename(req.file.originalname).slice(0, 255);
    const safeName = buildFileName(`${randomUUID()}${detected.extension}`);
    uploadedPath = await uploadFile(buildStoragePath(tenantId, 'news', safeName), req.file.buffer, detected.mime);
    const asset = await runAuditedTransaction(
      () => service.registerNewsAsset({
        tenantId,
        actorId: req.user!.id,
        uploadSessionId: parsed.data.upload_session_id,
        kind: parsed.data.kind,
        storagePath: uploadedPath!,
        originalName,
        contentType: detected.mime,
        sizeBytes: req.file!.size,
      }),
      () => createTransactionalAuditEntry(req, 'CREATE', 'news_asset', {
        code: 'news.image.uploaded', context: { file_name: originalName, file_size_bytes: req.file!.size },
      }, uploadedPath!, originalName),
    );
    sendSuccess(res, { storage_path: asset.storage_path, filename: originalName, size: req.file.size }, 'Tải ảnh thành công', 201);
  } catch (error) {
    if (uploadedPath) await deleteFile(uploadedPath).catch(() => undefined);
    next(error);
  }
}

export async function importImage(req: Request, res: Response, next: NextFunction): Promise<void> {
  let uploadedPath: string | null = null;
  try {
    const tenantId = requireTenantId(req, res); if (!tenantId) return;
    const parsed = importNewsImageSchema.safeParse(req.body);
    if (!parsed.success) { validationError(res, parsed.error); return; }

    const downloaded = await downloadRemoteNewsImage(parsed.data.source_url);
    const safeName = buildFileName(`${randomUUID()}${downloaded.extension}`);
    uploadedPath = await uploadFile(
      buildStoragePath(tenantId, 'news', safeName),
      downloaded.buffer,
      downloaded.mime,
    );
    const asset = await runAuditedTransaction(
      () => service.registerNewsAsset({
        tenantId,
        actorId: req.user!.id,
        uploadSessionId: parsed.data.upload_session_id,
        kind: 'inline',
        storagePath: uploadedPath!,
        originalName: downloaded.originalName,
        contentType: downloaded.mime,
        sizeBytes: downloaded.buffer.byteLength,
      }),
      () => createTransactionalAuditEntry(req, 'CREATE', 'news_asset', {
        code: 'news.image.uploaded',
        context: { file_name: downloaded.originalName, file_size_bytes: downloaded.buffer.byteLength },
      }, uploadedPath!, downloaded.originalName),
    );
    sendSuccess(res, {
      storage_path: asset.storage_path,
      filename: downloaded.originalName,
      size: downloaded.buffer.byteLength,
    }, 'Đã nhập ảnh vào Bảng tin', 201);
  } catch (error) {
    if (uploadedPath) await deleteFile(uploadedPath).catch(() => undefined);
    next(error);
  }
}

export async function deleteImage(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = requireTenantId(req, res); if (!tenantId) return;
    const parsed = deleteNewsImageSchema.safeParse(req.body);
    if (!parsed.success) { validationError(res, parsed.error); return; }
    if (!parsed.data.upload_session_id) { sendError(res, 'upload_session_id là bắt buộc', 400); return; }
    const queued = await runAuditedTransaction(
      () => service.queuePendingNewsAssetDelete(tenantId, parsed.data.upload_session_id!, parsed.data.storage_path),
      (asset) => createTransactionalAuditEntry(req, 'DELETE', 'news_asset', {
        code: 'news.image.deleted', context: { file_name: asset.storage_path.split('/').pop(), affected_count: 1 },
      }, asset.id, asset.storage_path.split('/').pop()),
    );
    await cleanupStoragePaths([queued.storage_path]);
    sendSuccess(res, { deleted: true }, 'Đã xóa ảnh');
  } catch (error) { next(error); }
}
