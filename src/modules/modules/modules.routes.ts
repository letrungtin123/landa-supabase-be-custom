// ═══════════════════════════════════════════════════════════════
// Modules Routes — /api/modules/*
// GET: any authenticated user | POST/PUT: superadmin only
// ═══════════════════════════════════════════════════════════════

import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { listController, createController, updateController } from './modules.controller.js';

const router = Router();

// List modules — bất kỳ user đã auth
router.get('/', authenticate, listController);

// Create/Update — chỉ superadmin
router.post('/', authenticate, authorize('superadmin'), createController);
router.put('/:id', authenticate, authorize('superadmin'), updateController);

export default router;
