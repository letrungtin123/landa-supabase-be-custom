// ═══════════════════════════════════════════════════════════════
// Permissions Routes — only superuser/superadmin may manage groups.
// ═══════════════════════════════════════════════════════════════

import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
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
  saveConfigurationController,
  listHistoryController,
  getHistoryDetailController,
} from './permissions.controller.js';

const router = Router();

router.use(authenticate, tenantContext, authorize('superuser', 'superadmin'));

router.get('/', listController);
router.post('/', createController);
router.get('/history', listHistoryController);
router.get('/history/:historyId', getHistoryDetailController);
router.get('/:id', getByIdController);
router.put('/:id', updateController);
router.delete('/:id', deleteController);
router.put('/:id/configuration', saveConfigurationController);
// Compatibility endpoints: retained but now use the same role gate, validation
// and separate permission-group history. They cannot bypass the new controls.
router.put('/:id/permissions', updateMatrixController);
router.post('/:id/members', addMembersController);
router.delete('/:id/members/:userId', removeMemberController);

export default router;
