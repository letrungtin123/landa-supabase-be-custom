import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize, checkPermission } from '../../middleware/authorize.js';
import { tenantContext } from '../../middleware/tenant-context.js';
import {
  listController, exportMarkdownController, createController, updateController, bulkActionController,
  getMentorController, listMentorCandidatesController, updateMentorController, listMentorHistoryController,
  getMentorSectionController, updateMentorSectionController,
  uploadMentorSectionLogoController, deleteMentorSectionLogoController,
  getModalConfigController, updateModalConfigController,
  getSectionModalController, updateSectionModalController,
  hardDeleteController,
} from './courses.controller.js';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

router.use(authenticate, tenantContext, authorize('staff', 'superuser', 'superadmin'));

router.get('/', checkPermission('courses', 'can_view'), listController);
router.get('/:id/export-markdown', checkPermission('courses', 'can_view'), exportMarkdownController);
router.post('/', checkPermission('courses', 'can_add'), createController);
router.patch('/:id', checkPermission('courses', 'can_edit'), updateController);
router.post('/bulk', checkPermission('courses', 'can_edit'), bulkActionController);
router.get('/:id/mentor', checkPermission('courses', 'can_view'), getMentorController);
router.patch('/:id/mentor', checkPermission('courses', 'can_edit'), updateMentorController);
router.get('/:id/mentor-candidates', checkPermission('courses', 'can_edit'), listMentorCandidatesController);
router.get('/:id/mentor-history', checkPermission('courses', 'can_edit'), listMentorHistoryController);
router.get('/:id/mentor-section', checkPermission('courses', 'can_view'), getMentorSectionController);
router.put('/:id/mentor-section', checkPermission('courses', 'can_edit'), updateMentorSectionController);
router.post('/:id/mentor-section/logo', checkPermission('courses', 'can_edit'), upload.single('file'), uploadMentorSectionLogoController);
router.delete('/:id/mentor-section/logo/:mode', checkPermission('courses', 'can_edit'), deleteMentorSectionLogoController);
router.get('/:id/modal-config', checkPermission('courses', 'can_view'), getModalConfigController);
router.put('/:id/modal-config', checkPermission('courses', 'can_edit'), updateModalConfigController);
router.get('/:id/section-modal-config', checkPermission('courses', 'can_view'), getSectionModalController);
router.put('/:id/section-modal-config', checkPermission('courses', 'can_edit'), updateSectionModalController);
router.delete('/:id', checkPermission('courses', 'can_delete'), hardDeleteController);

export default router;
