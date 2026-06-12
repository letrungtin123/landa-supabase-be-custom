import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import * as ctrl from './badges.controller.js';

const router = Router();

// Tất cả routes yêu cầu xác thực
router.use(authenticate);

// Admin / Superadmin quản lý badges theo tenant
router.get('/tenants/:tenantId', ctrl.getTenantBadges);
router.patch('/tenants/:tenantId', ctrl.updateTenantBadges);

export default router;
