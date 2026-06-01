import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize, checkPermission } from '../../middleware/authorize.js';
import { tenantContext } from '../../middleware/tenant-context.js';
import {
  listController, createController, updateController, bulkActionController,
  getModalConfigController, updateModalConfigController,
  getSectionModalController, updateSectionModalController,
} from './courses.controller.js';

const router = Router();
router.use(authenticate, tenantContext, authorize('staff', 'superuser', 'superadmin'));

router.get('/', checkPermission('courses', 'can_view'), listController);
router.post('/', checkPermission('courses', 'can_add'), createController);
router.patch('/:id', checkPermission('courses', 'can_edit'), updateController);
router.post('/bulk', checkPermission('courses', 'can_edit'), bulkActionController);
router.get('/:id/modal-config', checkPermission('courses', 'can_view'), getModalConfigController);
router.put('/:id/modal-config', checkPermission('courses', 'can_edit'), updateModalConfigController);
router.get('/:id/section-modal-config', checkPermission('courses', 'can_view'), getSectionModalController);
router.put('/:id/section-modal-config', checkPermission('courses', 'can_edit'), updateSectionModalController);

export default router;
