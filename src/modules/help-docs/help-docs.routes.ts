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
  uploadImageController, deleteImageController,
} from './help-docs.controller.js';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB for images
});

router.use(authenticate, tenantContext, authorize('staff', 'superuser', 'superadmin'));
const requireSuperadmin = authorize('superadmin');

// Folders
router.get('/folders', checkPermission('help_docs', 'can_view'), listFoldersController);
router.post('/folders', requireSuperadmin, createFolderController);
router.patch('/folders/reorder', requireSuperadmin, reorderFoldersController);
router.patch('/folders/:id', requireSuperadmin, updateFolderController);
router.delete('/folders/:id', requireSuperadmin, deleteFolderController);

// Pages
router.get('/pages', checkPermission('help_docs', 'can_view'), listPagesController);
router.post('/pages', requireSuperadmin, createPageController);
router.patch('/pages/reorder', requireSuperadmin, reorderPagesController);
router.get('/pages/:id', checkPermission('help_docs', 'can_view'), getPageController);
router.patch('/pages/:id', requireSuperadmin, updatePageController);
router.delete('/pages/:id', requireSuperadmin, deletePageController);

// Image upload
router.post('/upload-image', requireSuperadmin, upload.single('image'), uploadImageController);
router.post('/delete-image', requireSuperadmin, deleteImageController);

export default router;
