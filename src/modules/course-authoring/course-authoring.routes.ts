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

function uploadSingleCourseAsset(req: Request, res: Response, next: NextFunction): void {
  upload.single('file')(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      sendError(res, `File quá lớn. Giới hạn tối đa ${COURSE_ASSET_MAX_UPLOAD_LABEL}.`, 413);
      return;
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
