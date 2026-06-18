import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize, checkPermission } from '../../middleware/authorize.js';
import { tenantContext } from '../../middleware/tenant-context.js';
import {
  listController, createController, updateController, bulkActionController,
  getMentorController, listMentorCandidatesController, updateMentorController,
  getModalConfigController, updateModalConfigController,
  getSectionModalController, updateSectionModalController,
  hardDeleteController,
} from './courses.controller.js';

const router = Router();
router.use(authenticate, tenantContext, authorize('staff', 'superuser', 'superadmin'));

router.get('/', checkPermission('courses', 'can_view'), listController);
router.post('/', checkPermission('courses', 'can_add'), createController);
router.patch('/:id', checkPermission('courses', 'can_edit'), updateController);
router.post('/bulk', checkPermission('courses', 'can_edit'), bulkActionController);
router.get('/:id/mentor', checkPermission('courses', 'can_view'), getMentorController);
router.patch('/:id/mentor', checkPermission('courses', 'can_edit'), updateMentorController);
router.get('/:id/mentor-candidates', checkPermission('courses', 'can_edit'), listMentorCandidatesController);
router.get('/:id/modal-config', checkPermission('courses', 'can_view'), getModalConfigController);
router.put('/:id/modal-config', checkPermission('courses', 'can_edit'), updateModalConfigController);
router.get('/:id/section-modal-config', checkPermission('courses', 'can_view'), getSectionModalController);
router.put('/:id/section-modal-config', checkPermission('courses', 'can_edit'), updateSectionModalController);
router.delete('/:id', checkPermission('courses', 'can_delete'), hardDeleteController);

export default router;
