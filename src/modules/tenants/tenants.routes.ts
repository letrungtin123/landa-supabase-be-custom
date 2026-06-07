// ═══════════════════════════════════════════════════════════════
// Tenants Routes — /api/tenants/* (superadmin only)
// ═══════════════════════════════════════════════════════════════

import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import {
  listController,
  getByIdController,
  createController,
  updateController,
  deleteController,
  getModulesController,
  updateModulesController,
  getQuotaController,
  listSimpleController,
  getUserTenantsController,
  setUserTenantsController,
} from './tenants.controller.js';

const router = Router();

// Tất cả routes yêu cầu auth
router.use(authenticate);

// ── Simple list — superadmin + superuser (cho dropdown filter) ──
router.get('/simple', listSimpleController);

// ── CRUD + modules — superadmin only ──
router.get('/', authorize('superadmin'), listController);
router.post('/', authorize('superadmin'), createController);
router.get('/:id', authorize('superadmin'), getByIdController);
router.put('/:id', authorize('superadmin'), updateController);
router.delete('/:id', authorize('superadmin'), deleteController);
router.get('/:id/modules', authorize('superadmin'), getModulesController);
router.put('/:id/modules', authorize('superadmin'), updateModulesController);
router.get('/:id/quota', authorize('superadmin'), getQuotaController);

// ── User-Tenants — superadmin only ──
router.get('/user-tenants/:userId', authorize('superadmin'), getUserTenantsController);
router.put('/user-tenants/:userId', authorize('superadmin'), setUserTenantsController);

export default router;
