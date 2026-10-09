// ═══════════════════════════════════════════════════════════════
// Auth Routes — /api/auth/*
// ═══════════════════════════════════════════════════════════════

import { Router } from 'express';
import { authenticate, optionalAuth } from '../../middleware/authenticate.js';
import { tenantContext } from '../../middleware/tenant-context.js';
import {
  accountActionLimiter,
  loginAccountLimiter,
  loginIpLimiter,
  passwordChangeLimiter,
  refreshTokenLimiter,
} from '../../middleware/auth-rate-limit.js';
import {
  loginController,
  refreshController,
  logoutController,
  getMeController,
  getGroupLabelsController,
  getRoleLabelsController,
  changePasswordController,
  updateProfileController,
  generateOTTController,
  exchangeOTTController,
} from './auth.controller.js';

const router = Router();

// Public endpoints
// Sign-in: the per-IP limit, then failed attempts per typed account.
router.post('/login', loginIpLimiter, loginAccountLimiter, loginController);
// Refresh has its own budget per refresh token (never the sign-in bucket).
router.post('/refresh', refreshTokenLimiter, refreshController);
router.post('/ott/exchange', accountActionLimiter, exchangeOTTController);

// Logout revokes the refresh token in the body even when the access token is
// missing or expired (a bearer, when valid, is still used for the audit row).
router.post('/logout', optionalAuth, logoutController);

// Protected endpoints
router.get('/me', authenticate, getMeController);
router.get('/role-labels', authenticate, tenantContext, getRoleLabelsController);
router.get('/group-labels', authenticate, tenantContext, getGroupLabelsController);
router.post('/change-password', authenticate, passwordChangeLimiter, changePasswordController);
router.patch('/profile', authenticate, accountActionLimiter, updateProfileController);
router.post('/ott/generate', authenticate, accountActionLimiter, generateOTTController);

export default router;
