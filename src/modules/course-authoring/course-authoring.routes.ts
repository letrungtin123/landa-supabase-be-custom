// ═══════════════════════════════════════════════════════════════
// Course Authoring Routes
// ═══════════════════════════════════════════════════════════════

import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { authenticate } from '../../middleware/authenticate.js';
import { tenantContext } from '../../middleware/tenant-context.js';
import { checkPermission } from '../../middleware/authorize.js';
import { COURSE_ASSET_MAX_UPLOAD_BYTES, COURSE_ASSET_MAX_UPLOAD_LABEL } from '../../config/upload-limits.js';
import { sendError } from '../../utils/response.js';
import * as ctrl from './course-authoring.controller.js';

const router = Router();
const courseAssetTempDir = path.join(process.cwd(), 'tmp', 'course-assets');

function cleanupStaleCourseAssetTempFiles(): void {
  try {
    fs.mkdirSync(courseAssetTempDir, { recursive: true });
    const entries = fs.readdirSync(courseAssetTempDir, { withFileTypes: true });
    let deleted = 0;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      fs.unlinkSync(path.join(courseAssetTempDir, entry.name));
      deleted += 1;
    }
    if (deleted > 0) {
      console.log(`[CourseAssets] Removed ${deleted} stale temp upload file(s)`);
    }
  } catch (err) {
    console.warn('[CourseAssets] Failed to cleanup stale temp upload files:', err);
  }
}

cleanupStaleCourseAssetTempFiles();

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdirSync(courseAssetTempDir, { recursive: true });
      cb(null, courseAssetTempDir);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '');
      cb(null, `${Date.now()}-${randomUUID()}${ext || '.upload'}`);
    },
  }),
  limits: { fileSize: COURSE_ASSET_MAX_UPLOAD_BYTES },
});

function isClientUploadAbort(req: Request, err: unknown): boolean {
  const error = err as { code?: string; message?: string } | undefined;
  return Boolean(
    req.aborted ||
    req.destroyed ||
    error?.message === 'Request aborted' ||
    error?.code === 'ECONNRESET' ||
    error?.code === 'ECONNABORTED'
  );
}

function uploadSingleCourseAsset(req: Request, res: Response, next: NextFunction): void {
  const startedAt = Date.now();
  const declaredBytes = Number(req.headers['content-length'] || 0);
  console.info('[CourseAssets] upload request received', {
    course_id: req.params.courseId,
    declared_bytes: Number.isFinite(declaredBytes) && declaredBytes > 0 ? declaredBytes : null,
  });

  req.once('aborted', () => {
    console.warn('[CourseAssets] upload request aborted by client', {
      course_id: req.params.courseId,
      duration_ms: Date.now() - startedAt,
    });
  });

  upload.single('file')(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      console.warn('[CourseAssets] multipart upload exceeded size limit', {
        course_id: req.params.courseId,
        duration_ms: Date.now() - startedAt,
      });
      sendError(res, `File quá lớn. Giới hạn tối đa ${COURSE_ASSET_MAX_UPLOAD_LABEL}.`, 413);
      return;
    }

    if (err && isClientUploadAbort(req, err)) {
      console.warn('[CourseAssets] multipart upload aborted by client', {
        course_id: req.params.courseId,
        duration_ms: Date.now() - startedAt,
      });
      if (!res.headersSent && !res.writableEnded && !req.destroyed) {
        sendError(res, 'Upload đã bị hủy bởi client.', 400);
      }
      return;
    }

    if (err) {
      console.error('[CourseAssets] multipart upload failed', {
        course_id: req.params.courseId,
        duration_ms: Date.now() - startedAt,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
      next(err);
      return;
    }

    if (req.file) {
      console.info('[CourseAssets] multipart upload received', {
        course_id: req.params.courseId,
        bytes: req.file.size,
        duration_ms: Date.now() - startedAt,
      });
    }
    next(err);
  });
}

// All routes require auth + tenant + courses permission
router.use(authenticate, tenantContext);

// Course creation
router.post('/courses', checkPermission('courses', 'can_edit'), ctrl.createCourse);

// Outline
router.get('/outline/:courseId', checkPermission('courses', 'can_view'), ctrl.getOutline);
router.get('/component-permissions', checkPermission('courses', 'can_view'), ctrl.getComponentPermissions);

// Cross-course outline operations are intentionally separate from normal
// component CRUD. The controller applies the superuser/superadmin-only gate.
router.get('/transfer-targets', checkPermission('courses', 'can_edit'), ctrl.getTransferTargets);
router.get('/transfer-destination-options', checkPermission('courses', 'can_edit'), ctrl.getTransferDestinationOptions);
router.get('/transfer-destination-parents', checkPermission('courses', 'can_edit'), ctrl.getTransferDestinationParents);
router.post('/transfers', checkPermission('courses', 'can_edit'), ctrl.createOutlineTransfer);
router.get('/transfers/:jobId', checkPermission('courses', 'can_view'), ctrl.getOutlineTransfer);

// Blocks CRUD
router.get('/blocks/:blockId', checkPermission('courses', 'can_view'), ctrl.getBlock);
router.post('/blocks', checkPermission('courses', 'can_edit'), ctrl.createBlock);
router.patch('/blocks/:blockId', checkPermission('courses', 'can_edit'), ctrl.updateBlock);
router.delete('/blocks/:blockId', checkPermission('courses', 'can_delete'), ctrl.deleteBlock);

// Reorder
router.post('/blocks/:blockId/reorder', checkPermission('courses', 'can_edit'), ctrl.reorderChildren);

// Unit children
router.get('/units/:unitId/children', checkPermission('courses', 'can_view'), ctrl.getUnitChildren);

// Custom XBlock handler
router.post('/blocks/:blockId/handler/studio_submit', checkPermission('courses', 'can_edit'), ctrl.studioSubmit);

// Assets
router.get('/assets/:courseId', checkPermission('courses', 'can_view'), ctrl.getAssets);
router.post('/assets/:courseId', checkPermission('courses', 'can_edit'), uploadSingleCourseAsset, ctrl.uploadAsset);
router.post('/assets/:courseId/delete-by-path', checkPermission('courses', 'can_edit'), ctrl.deleteAssetByPath);
router.patch('/assets/:courseId/reference', checkPermission('courses', 'can_edit'), ctrl.updateAssetReference);
router.delete('/assets/:courseId/:assetId', checkPermission('courses', 'can_delete'), ctrl.deleteAsset);

export default router;
