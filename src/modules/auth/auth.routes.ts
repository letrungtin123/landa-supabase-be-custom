// ═══════════════════════════════════════════════════════════════
// Auth Routes — /api/auth/*
// ═══════════════════════════════════════════════════════════════

import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import {
  loginController,
  refreshController,
  logoutController,
  getMeController,
  changePasswordController,
  updateProfileController,
} from './auth.controller.js';

const router = Router();

// Public endpoints
router.post('/login', loginController);
router.post('/refresh', refreshController);

// Protected endpoints
router.post('/logout', authenticate, logoutController);
router.get('/me', authenticate, getMeController);
router.post('/change-password', authenticate, changePasswordController);
router.patch('/profile', authenticate, updateProfileController);

export default router;

