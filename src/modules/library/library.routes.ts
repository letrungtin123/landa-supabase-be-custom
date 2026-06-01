// ═══════════════════════════════════════════════════════════════
// Library Routes — /api/library/*
// ═══════════════════════════════════════════════════════════════

import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize, checkPermission } from '../../middleware/authorize.js';
import { tenantContext } from '../../middleware/tenant-context.js';
import {
  listCategoriesController, createCategoryController, updateCategoryController,
  deleteCategoryController, bulkDeleteCategoriesController,
  listDocumentsController, createDocumentController, updateDocumentController,
  deleteDocumentController, bulkDocumentActionController,
} from './library.controller.js';

const router = Router();
router.use(authenticate, tenantContext, authorize('staff', 'superuser', 'superadmin'));

// Categories
router.get('/categories', checkPermission('library', 'can_view'), listCategoriesController);
router.post('/categories', checkPermission('library', 'can_add'), createCategoryController);
router.patch('/categories/:id', checkPermission('library', 'can_edit'), updateCategoryController);
router.delete('/categories/:id', checkPermission('library', 'can_delete'), deleteCategoryController);
router.post('/categories/bulk', checkPermission('library', 'can_delete'), bulkDeleteCategoriesController);

// Documents
router.get('/documents', checkPermission('library', 'can_view'), listDocumentsController);
router.post('/documents', checkPermission('library', 'can_add'), createDocumentController);
router.patch('/documents/:id', checkPermission('library', 'can_edit'), updateDocumentController);
router.delete('/documents/:id', checkPermission('library', 'can_delete'), deleteDocumentController);
router.post('/documents/bulk', checkPermission('library', 'can_delete'), bulkDocumentActionController);

export default router;
