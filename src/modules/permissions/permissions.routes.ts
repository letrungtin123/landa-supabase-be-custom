// ═══════════════════════════════════════════════════════════════
// Permissions Routes — /api/permission-groups/* (staff+)
// ═══════════════════════════════════════════════════════════════

import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize, checkPermission } from '../../middleware/authorize.js';
import { tenantContext } from '../../middleware/tenant-context.js';
import {
  listController,
  getByIdController,
  createController,
  updateController,
  deleteController,
  updateMatrixController,
  addMembersController,
  removeMemberController,
} from './permissions.controller.js';

const router = Router();

router.use(authenticate, tenantContext, authorize('staff', 'superuser', 'superadmin'));

router.get('/', checkPermission('permission_groups', 'can_view'), listController);
router.post('/', checkPermission('permission_groups', 'can_add'), createController);
router.get('/:id', checkPermission('permission_groups', 'can_view'), getByIdController);
router.put('/:id', checkPermission('permission_groups', 'can_edit'), updateController);
router.delete('/:id', checkPermission('permission_groups', 'can_delete'), deleteController);
router.put('/:id/permissions', checkPermission('permission_groups', 'can_edit'), updateMatrixController);
router.post('/:id/members', checkPermission('permission_groups', 'can_edit'), addMembersController);
router.delete('/:id/members/:userId', checkPermission('permission_groups', 'can_edit'), removeMemberController);

export default router;
