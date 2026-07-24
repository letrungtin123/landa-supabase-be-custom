// ═══════════════════════════════════════════════════════════════
// Users Routes — /api/users/* (staff+ with tenant scope)
// ═══════════════════════════════════════════════════════════════

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize, checkPermission } from '../../middleware/authorize.js';
import { tenantContext } from '../../middleware/tenant-context.js';
import { sendError } from '../../utils/response.js';
import { isDemoIframeSession } from '../demo-login/demo-iframe.service.js';
import {
  listController,
  getByIdController,
  createController,
  updateController,
  deleteController,
  assignGroupsController,
  getProfileController,
  updateProfileController,
  uploadAvatarController,
  changePasswordController,
} from './users.controller.js';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1 * 1024 * 1024 }, // 1MB max for avatars
});

// ── Profile routes (any authenticated user, self-service) ──
// MUST be before /:id routes to avoid conflict
function blockDemoIframeAvatarUpload(req: Request, res: Response, next: NextFunction): void {
  if (isDemoIframeSession(req.user)) {
    sendError(res, 'Phiên demo iframe không thể cập nhật avatar', 403);
    return;
  }
  next();
}

router.get('/profile/:username', authenticate, getProfileController);
router.patch('/profile', authenticate, updateProfileController);
router.post('/profile/avatar', authenticate, blockDemoIframeAvatarUpload, upload.single('file'), uploadAvatarController);
router.post('/profile/change-password', authenticate, changePasswordController);

// ── Admin CRUD (staff+ with tenant scope + permission check) ──
router.use(authenticate, tenantContext, authorize('staff', 'superuser', 'superadmin'));

router.get('/', checkPermission('account', 'can_view'), listController);
router.post('/', checkPermission('account', 'can_add'), createController);
router.get('/:id', checkPermission('account', 'can_view'), getByIdController);
router.put('/:id', checkPermission('account', 'can_edit'), updateController);
router.delete('/:id', checkPermission('account', 'can_delete'), deleteController);
router.put('/:id/permission-groups', checkPermission('account', 'can_edit'), assignGroupsController);

export default router;
