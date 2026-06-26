// ═══════════════════════════════════════════════════════════════
// Dashboard Content Routes — /api/dashboard-content/*
// Public: GET by domain (no auth)
// Protected: GET/PUT (staff+ with tenant scope)
// ═══════════════════════════════════════════════════════════════

import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { tenantContext } from '../../middleware/tenant-context.js';
import {
  getByDomainController,
  getByTenantController,
  upsertController,
} from './dashboard-content.controller.js';

const router = Router();

// ── Public — FE 5173 gọi (không cần auth) ──
router.get('/by-domain/:domain', getByDomainController);

// ── Protected — admin dashboard (staff+) ──
router.use(authenticate, tenantContext, authorize('staff', 'superuser', 'superadmin'));
router.get('/', getByTenantController);
router.put('/', upsertController);

export default router;
