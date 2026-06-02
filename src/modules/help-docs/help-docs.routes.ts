import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize, checkPermission } from '../../middleware/authorize.js';
import { tenantContext } from '../../middleware/tenant-context.js';
import {
  listFoldersController, createFolderController, updateFolderController,
  deleteFolderController, reorderFoldersController,
  listPagesController, getPageController, createPageController,
  updatePageController, deletePageController, reorderPagesController,
  uploadImageController,
} from './help-docs.controller.js';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB for images
});

router.use(authenticate, tenantContext, authorize('staff', 'superuser', 'superadmin'));

// Folders
router.get('/folders', checkPermission('help_docs', 'can_view'), listFoldersController);
router.post('/folders', checkPermission('help_docs', 'can_add'), createFolderController);
router.patch('/folders/:id', checkPermission('help_docs', 'can_edit'), updateFolderController);
router.delete('/folders/:id', checkPermission('help_docs', 'can_delete'), deleteFolderController);
router.patch('/folders/reorder', checkPermission('help_docs', 'can_edit'), reorderFoldersController);

// Pages
router.get('/pages', checkPermission('help_docs', 'can_view'), listPagesController);
router.get('/pages/:id', checkPermission('help_docs', 'can_view'), getPageController);
router.post('/pages', checkPermission('help_docs', 'can_add'), createPageController);
router.patch('/pages/:id', checkPermission('help_docs', 'can_edit'), updatePageController);
router.delete('/pages/:id', checkPermission('help_docs', 'can_delete'), deletePageController);
router.patch('/pages/reorder', checkPermission('help_docs', 'can_edit'), reorderPagesController);

// Image upload
router.post('/upload-image', checkPermission('help_docs', 'can_edit'), upload.single('image'), uploadImageController);

export default router;
