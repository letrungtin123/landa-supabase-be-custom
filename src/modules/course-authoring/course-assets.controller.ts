// ═══════════════════════════════════════════════════════════════
// Course assets controller: list, upload, delete and mark as reference the
// files of a course. Moved unchanged from course-authoring.controller.ts,
// which still re-exports every handler.
// ═══════════════════════════════════════════════════════════════

import type { Request, Response } from 'express';
import fs from 'fs/promises';
import { createTransactionalAuditEntry, runAuditedTransaction } from '../../middleware/audit-log.js';
import { sendSuccess, sendError } from '../../utils/response.js';
import { sendClientError } from '../../utils/client-error.js';
import * as svc from './course-authoring.service.js';
import {
  uploadFile,
  uploadCourseAssetFileFromPath,
  deleteFile,
  buildFileName,
  buildStoragePath,
  fixMulterFilename,
} from '../../config/storage.js';
import { COURSE_ASSET_MAX_UPLOAD_BYTES, COURSE_ASSET_MAX_UPLOAD_LABEL } from '../../config/upload-limits.js';
import { AppError } from '../../utils/errors.js';
import { isUuid } from '../../utils/uuid.js';
import { swallowAndLog } from '../../utils/best-effort.js';
import { isSafeCourseAssetPath } from './course-block-input.logic.js';

const COURSE_ASSET_STORAGE_SIZE_LIMIT_CODE = 'COURSE_ASSET_STORAGE_SIZE_LIMIT';

function isStorageObjectSizeLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';
  return /(?:object exceeded the maximum allowed size|maximum allowed size|file size limit)/i.test(message);
}

async function cleanupTempUpload(file: Express.Multer.File): Promise<void> {
  if (!file.path) return;
  await fs.unlink(file.path).catch(() => {}); // a leftover is removed by cleanupStaleCourseAssetTempFiles
}

/** GET /api/course-authoring/assets/:courseId */
export async function getAssets(req: Request, res: Response) {
  const { courseId } = req.params;
  const tenantId = req.user!.tenantId!;
  const rawPage = parseInt(req.query.page as string, 10);
  const rawPageSize = parseInt(req.query.page_size as string, 10);
  const page = Number.isFinite(rawPage) ? Math.max(0, rawPage) : 0;
  const pageSize = Number.isFinite(rawPageSize) ? Math.min(Math.max(rawPageSize, 1), 100) : 50;
  const textSearch = typeof req.query.text_search === 'string' ? req.query.text_search : '';
  const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : null;
  const pagination = typeof req.query.pagination === 'string' ? req.query.pagination : '';
  const cursorPagination = pagination === 'cursor' || req.query.cursor_pagination === '1' || Boolean(cursor);

  const result = await svc.getCourseAssets(courseId, tenantId, page, pageSize, textSearch, {
    cursor,
    cursorPagination,
  });
  sendSuccess(res, result);
}

/** POST /api/course-authoring/assets/:courseId — Upload file */
export async function uploadAsset(req: Request, res: Response) {
  const { courseId } = req.params;
  const tenantId = req.user!.tenantId!;
  const userId = req.user!.id;

  if (!req.file) return sendError(res, 'No file uploaded', 400);

  const file = req.file;
  let storagePath = '';
  let storageUploaded = false;
  const startedAt = Date.now();

  try {
    if (file.size > COURSE_ASSET_MAX_UPLOAD_BYTES) {
      return sendError(res, `File quá lớn (${(file.size / 1024 / 1024).toFixed(1)}MB). Giới hạn tối đa ${COURSE_ASSET_MAX_UPLOAD_LABEL}.`, 413);
    }

    // Nothing is stored for a course outside the caller's tenant.
    await svc.assertCourseInTenant(courseId, tenantId);

    const originalName = fixMulterFilename(file.originalname);
    const fileName = buildFileName(originalName);
    storagePath = buildStoragePath(tenantId, 'courses', fileName, courseId);

    console.info('[CourseAssets] storage upload started', {
      course_id: courseId,
      bytes: file.size,
      content_type: file.mimetype,
    });

    // Stream from Multer's temp file so a large course video is never copied
    // wholesale into the API process heap.
    if (file.path) {
      await uploadCourseAssetFileFromPath(storagePath, file.path, file.mimetype);
    } else if (file.buffer) {
      await uploadFile(storagePath, file.buffer, file.mimetype);
    } else {
      return sendError(res, 'Uploaded file is not readable', 400);
    }
    storageUploaded = true;

    // DB lưu storagePath cho cả storage_path VÀ url columns
    const { asset } = await runAuditedTransaction(
      async () => {
        const created = await svc.createAssetRecord(
          courseId, tenantId, originalName, file.mimetype,
          file.size, storagePath, storagePath, userId,
        );
        const course = await svc.getCourseAuditContext(courseId);
        return { asset: created, course };
      },
      ({ asset, course }) => createTransactionalAuditEntry(
        req,
        'CREATE',
        'course_asset',
        {
          code: 'course.asset.uploaded',
          context: {
            ...course,
            file_name: asset.display_name,
            file_size_bytes: file.size,
          },
        },
        asset.id,
        asset.display_name,
      ),
    );
    console.info('[CourseAssets] storage upload completed', {
      course_id: courseId,
      bytes: file.size,
      duration_ms: Date.now() - startedAt,
    });
    sendSuccess(res, asset, undefined, 201);
  } catch (err) {
    if (storageUploaded && storagePath) {
      await deleteFile(storagePath).catch(swallowAndLog('course_assets.storage_cleanup'));
    }
    console.error('[CourseAssets] storage upload failed', {
      course_id: courseId,
      bytes: file.size,
      duration_ms: Date.now() - startedAt,
      error: err instanceof Error ? err.message : 'Unknown error',
    });
    if (isStorageObjectSizeLimitError(err)) {
      throw new AppError(
        `Tệp vượt dung lượng lưu trữ cho phép. Vui lòng chọn tệp không quá ${COURSE_ASSET_MAX_UPLOAD_LABEL}.`,
        413,
        COURSE_ASSET_STORAGE_SIZE_LIMIT_CODE,
      );
    }
    throw err;
  } finally {
    await cleanupTempUpload(file);
  }
}

/** DELETE /api/course-authoring/assets/:courseId/:assetId */
export async function deleteAsset(req: Request, res: Response) {
  const { courseId, assetId } = req.params;
  const tenantId = req.user!.tenantId!;
  const result = await runAuditedTransaction(
    async () => {
      const deleted = await svc.deleteAsset(assetId, courseId, tenantId);
      const course = deleted?.deleted ? await svc.getCourseAuditContext(courseId) : null;
      return { deleted, course };
    },
    ({ deleted, course }) => {
      if (!deleted?.deleted || !course) return null;
      const asset = deleted.asset;
      return createTransactionalAuditEntry(
        req,
        'DELETE',
        'course_asset',
        {
          code: 'course.asset.deleted',
          context: {
            ...course,
            file_name: asset?.display_name || assetId,
            file_size_bytes: Number(asset?.file_size) || 0,
          },
        },
        assetId,
        asset?.display_name,
      );
    },
  );
  if (!result.deleted) return sendError(res, 'Asset not found', 404);

  await Promise.allSettled(result.deleted.storagePathsToDelete.map((path) => deleteFile(path)));

  sendSuccess(res, {
    success: true,
    deleted: result.deleted.deleted ? 1 : 0,
    pending_delete: result.deleted.pendingPublishedReferences,
    published_reference_count: result.deleted.publishedReferenceCount,
  });
}

/** POST /api/course-authoring/assets/:courseId/delete-by-path */
export async function deleteAssetByPath(req: Request, res: Response) {
  const { courseId } = req.params;
  const tenantId = req.user!.tenantId!;
  const storagePath = typeof req.body?.storage_path === 'string'
    ? req.body.storage_path.trim()
    : typeof req.body?.storagePath === 'string'
      ? req.body.storagePath.trim()
      : '';

  if (!isSafeCourseAssetPath(storagePath)) {
    return sendError(res, 'Invalid storage path', 400);
  }

  const result = await runAuditedTransaction(
    async () => {
      const deleted = await svc.deleteAssetByStoragePath(courseId, tenantId, storagePath);
      const course = deleted.deletedRows.length > 0 ? await svc.getCourseAuditContext(courseId) : null;
      return { deleted, course };
    },
    ({ deleted, course }) => {
      if (!course || deleted.deletedRows.length === 0) return null;
      const first = deleted.deletedRows[0];
      return createTransactionalAuditEntry(
        req,
        'DELETE',
        'course_asset',
        {
          code: 'course.asset.deleted',
          context: {
            ...course,
            file_name: first.display_name || first.storage_path,
            affected_count: deleted.deletedRows.length,
          },
        },
        first.storage_path,
        first.display_name || first.storage_path,
      );
    },
  );
  await Promise.allSettled(result.deleted.storagePathsToDelete.map((path) => deleteFile(path)));

  sendSuccess(res, {
    success: true,
    deleted: result.deleted.deletedRows.length,
    pending_delete: result.deleted.pendingPublishedReferences,
    published_reference_count: result.deleted.publishedReferenceCount,
  });
}

export async function updateAssetReference(req: Request, res: Response) {
  try {
    const tenantId = req.user!.tenantId;
    if (!tenantId) return sendError(res, 'tenant_id is required', 400);
    const { assetIds, is_reference } = req.body;
    if (!Array.isArray(assetIds)) return sendError(res, 'assetIds must be an array', 400);
    if (assetIds.length > 500 || !assetIds.every(isUuid)) return sendError(res, 'Danh sách tệp không hợp lệ.', 400);
    
    if (assetIds.length > 0) {
      await runAuditedTransaction(
        async () => {
          await svc.updateCourseAssetReference(req.params.courseId, assetIds, Boolean(is_reference), tenantId);
          return svc.getCourseAuditContext(req.params.courseId);
        },
        (course) => createTransactionalAuditEntry(
          req,
          'UPDATE',
          'course_asset',
          {
            code: 'course.asset.references.updated',
            context: { ...course, affected_count: assetIds.length },
          },
          req.params.courseId,
          course.course_name,
        ),
      );
    }
    sendSuccess(res, { success: true });
  } catch (err) {
    sendClientError(req, res, err, 'CourseAuthoring');
  }
}
