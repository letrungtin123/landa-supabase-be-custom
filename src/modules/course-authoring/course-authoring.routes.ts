// ═══════════════════════════════════════════════════════════════
// Course Authoring Routes
// ═══════════════════════════════════════════════════════════════

import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../../middleware/authenticate.js';
import { tenantContext } from '../../middleware/tenant-context.js';
import { checkPermission } from '../../middleware/authorize.js';
import * as ctrl from './course-authoring.controller.js';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
});

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
router.post('/assets/:courseId', checkPermission('courses', 'can_edit'), upload.single('file'), ctrl.uploadAsset);
router.delete('/assets/:courseId/:assetId', checkPermission('courses', 'can_delete'), ctrl.deleteAsset);

export default router;
