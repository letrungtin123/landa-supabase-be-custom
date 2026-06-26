// ═══════════════════════════════════════════════════════════════
// Auth Routes — /api/auth/*
// ═══════════════════════════════════════════════════════════════

import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { tenantContext } from '../../middleware/tenant-context.js';
import {
  loginController,
  refreshController,
  logoutController,
  getMeController,
  getRoleLabelsController,
  changePasswordController,
  updateProfileController,
  generateOTTController,
  exchangeOTTController,
} from './auth.controller.js';

const router = Router();

// Public endpoints
router.post('/login', loginController);
router.post('/refresh', refreshController);
router.post('/ott/exchange', exchangeOTTController);

// Protected endpoints
router.post('/logout', authenticate, logoutController);
router.get('/me', authenticate, getMeController);
router.get('/role-labels', authenticate, tenantContext, getRoleLabelsController);
router.post('/change-password', authenticate, changePasswordController);
router.patch('/profile', authenticate, updateProfileController);
router.post('/ott/generate', authenticate, generateOTTController);

export default router;
