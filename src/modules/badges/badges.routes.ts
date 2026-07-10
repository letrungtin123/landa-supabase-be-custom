import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../../middleware/authenticate.js';
import * as ctrl from './badges.controller.js';

const router = Router();

// Tất cả routes yêu cầu xác thực
router.use(authenticate);

// Multer — memory storage cho upload ảnh badge
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
});

// Admin / Superadmin quản lý badges theo tenant
router.get('/tenants/:tenantId', ctrl.getTenantBadges);
router.patch('/tenants/:tenantId', ctrl.updateTenantBadges);

// Upload badge images (superadmin only)
router.post('/tenants/:tenantId/:badgeId/card-image', upload.single('file'), ctrl.uploadCardImage);
router.post('/tenants/:tenantId/:badgeId/icon-image', upload.single('file'), ctrl.uploadIconImage);
router.post('/tenants/:tenantId/:badgeId/mobile-card-image', upload.single('file'), ctrl.uploadMobileCardImage);

export default router;
