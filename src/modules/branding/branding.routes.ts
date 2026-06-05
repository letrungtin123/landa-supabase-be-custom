// ═══════════════════════════════════════════════════════════════
// Branding Routes — /api/branding/*
// Public: GET by domain (no auth)
// Protected: GET/upload/delete (staff+ with tenant scope)
// ═══════════════════════════════════════════════════════════════

import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { tenantContext } from '../../middleware/tenant-context.js';
import {
  getByDomainController,
  getByTenantController,
  uploadController,
  deleteController,
} from './branding.controller.js';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
});

// ── Public — FE 5173 gọi trước login ──
router.get('/by-domain/:domain', getByDomainController);

// ── Protected — admin dashboard (staff+) ──
router.use(authenticate, tenantContext, authorize('staff', 'superuser', 'superadmin'));
router.get('/', getByTenantController);
router.post('/upload', upload.single('file'), uploadController);
router.delete('/:imageKey', deleteController);

export default router;
