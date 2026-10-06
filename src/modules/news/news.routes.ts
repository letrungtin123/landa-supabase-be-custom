import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../../middleware/authenticate.js';
import type { Request, Response, NextFunction } from 'express';
import { authorize, checkPermission, hasPermission } from '../../middleware/authorize.js';
import { requireTenantModule } from '../../middleware/require-tenant-module.js';
import { tenantContext } from '../../middleware/tenant-context.js';
import * as controller from './news.controller.js';

const router = Router();
const imageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
const allAuthenticatedRoles = authorize('learner', 'learner_plus', 'staff', 'superuser', 'superadmin');
const learnerFeatureGate = requireTenantModule('news');
const managerFeatureGate = requireTenantModule('news', { superadminBypass: true });

function managers(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) { res.status(401).json({ success: false, message: 'Chưa xác thực' }); return; }
  if (!['staff', 'superuser', 'superadmin'].includes(req.user.role)) {
    res.status(403).json({ success: false, message: 'Không có quyền quản lý Bảng tin' });
    return;
  }
  next();
}

async function checkNewsAssetWritePermission(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!req.user) { res.status(401).json({ success: false, message: 'Chưa xác thực' }); return; }
  try {
    const subject = { id: req.user.id, tenantId: req.user.tenantId, role: req.user.role };
    if (await hasPermission(subject, 'news', 'can_add') || await hasPermission(subject, 'news', 'can_edit')) {
      next();
      return;
    }
    res.status(403).json({ success: false, message: 'Không có quyền tải ảnh Bảng tin' });
  } catch (error) { next(error); }
}

router.use(authenticate, tenantContext);

router.get('/manage', managers, managerFeatureGate, checkPermission('news', 'can_view'), controller.listManaged);
router.get('/manage/:id', managers, managerFeatureGate, checkPermission('news', 'can_view'), controller.getManaged);
router.post('/images', managers, managerFeatureGate, checkNewsAssetWritePermission, imageUpload.single('image'), controller.uploadImage);
router.post('/images/import', managers, managerFeatureGate, checkNewsAssetWritePermission, controller.importImage);
router.delete('/images', managers, managerFeatureGate, checkNewsAssetWritePermission, controller.deleteImage);
router.post('/', managers, managerFeatureGate, checkPermission('news', 'can_add'), controller.create);
router.patch('/:id', managers, managerFeatureGate, checkPermission('news', 'can_edit'), controller.update);
router.post('/:id/archive', managers, managerFeatureGate, checkPermission('news', 'can_delete'), controller.archive);
router.post('/:id/restore', managers, managerFeatureGate, checkPermission('news', 'can_delete'), controller.restore);

router.get('/', allAuthenticatedRoles, learnerFeatureGate, controller.listPublished);
router.get('/:id', allAuthenticatedRoles, learnerFeatureGate, controller.getPublished);

export default router;
