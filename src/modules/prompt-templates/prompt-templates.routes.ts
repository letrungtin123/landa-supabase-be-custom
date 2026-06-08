// ═══════════════════════════════════════════════════════════════
// Prompt Templates Routes — superadmin only (except /active)
// ═══════════════════════════════════════════════════════════════

import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import * as ctrl from './prompt-templates.controller.js';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

// All routes require auth
router.use(authenticate);

// Active templates — any authenticated user can list (for bot creation flow)
router.get('/active', ctrl.listActiveTemplates);

// Below: superadmin only
router.get('/', authorize('superadmin'), ctrl.listTemplates);
router.get('/:id', authorize('superadmin'), ctrl.getTemplate);
router.post('/', authorize('superadmin'), ctrl.createTemplate);
router.put('/:id', authorize('superadmin'), ctrl.updateTemplate);
router.delete('/:id', authorize('superadmin'), ctrl.deleteTemplate);
router.post('/:id/avatar', authorize('superadmin'), upload.single('avatar'), ctrl.uploadAvatar);
router.post('/:id/fullbody', authorize('superadmin'), upload.single('fullbody'), ctrl.uploadFullbody);

export default router;
