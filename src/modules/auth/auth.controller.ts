// ═══════════════════════════════════════════════════════════════
// Auth Controller — Handler cho login, refresh, logout, me
// ═══════════════════════════════════════════════════════════════

import type { Request, Response, NextFunction } from 'express';
import * as authService from './auth.service.js';
import { loginSchema, refreshSchema } from './auth.validator.js';
import { sendSuccess, sendError } from '../../utils/response.js';

/**
 * POST /api/auth/login
 * Đăng nhập bằng username/email + password.
 */
export async function loginController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, parsed.error.errors[0].message, 400);
      return;
    }

    // Lấy origin từ body (FE gửi) hoặc fallback từ Origin header
    const origin = parsed.data.origin || (req.headers.origin as string | undefined);

    const result = await authService.login(parsed.data.username, parsed.data.password, parsed.data.client_app, origin);

    sendSuccess(res, result, 'Đăng nhập thành công');
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/auth/refresh
 * Refresh access token — token rotation.
 */
export async function refreshController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = refreshSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, parsed.error.errors[0].message, 400);
      return;
    }

    const result = await authService.refresh(parsed.data.refresh_token, parsed.data.tenant_id);
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/auth/logout
 * Revoke refresh token.
 */
export async function logoutController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = refreshSchema.safeParse(req.body);
    if (parsed.success && parsed.data.refresh_token) {
      await authService.logout(parsed.data.refresh_token);
    }

    sendSuccess(res, null, 'Đăng xuất thành công');
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/auth/me
 * Lấy thông tin user hiện tại + permissions.
 */
export async function getMeController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      sendError(res, 'Chưa xác thực', 401);
      return;
    }

    const result = await authService.getMe(req.user.id, req.user.tenantId);
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/auth/role-labels
 * Lay ten hien thi role theo tenant context hien tai.
 */
export async function getRoleLabelsController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      sendError(res, 'ChÆ°a xÃ¡c thá»±c', 401);
      return;
    }

    const result = await authService.getRoleLabelsForTenant(req.user.tenantId);
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/auth/change-password
 * Đổi mật khẩu — verify mật khẩu cũ.
 */
export async function changePasswordController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) { sendError(res, 'Chưa xác thực', 401); return; }

    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) {
      sendError(res, 'Thiếu current_password hoặc new_password', 400);
      return;
    }

    await authService.changePassword(req.user.id, current_password, new_password);
    sendSuccess(res, null, 'Đổi mật khẩu thành công');
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/auth/profile
 * Cập nhật thông tin cá nhân.
 */
export async function updateProfileController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) { sendError(res, 'Chưa xác thực', 401); return; }

    const result = await authService.updateProfile(req.user.id, req.body);
    sendSuccess(res, result, 'Cập nhật thông tin thành công');
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/auth/ott/generate
 * Tạo One-Time Token cho cross-app SSO.
 * User phải đã authenticated. OTT sống 30 giây, dùng 1 lần.
 */
export async function generateOTTController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) { sendError(res, 'Chưa xác thực', 401); return; }

    // Chỉ staff/superuser/superadmin mới cần SSO sang admin dashboard
    if (req.user.role === 'learner') {
      sendError(res, 'Không có quyền truy cập', 403);
      return;
    }

    const token = authService.generateOTT(req.user.id);
    sendSuccess(res, { ott: token, expires_in: 30 });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/auth/ott/exchange
 * Exchange OTT → full auth session.
 * Public endpoint (không cần auth header — OTT là auth).
 */
export async function exchangeOTTController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { ott } = req.body;
    if (!ott || typeof ott !== 'string') {
      sendError(res, 'Thiếu ott', 400);
      return;
    }

    const result = await authService.exchangeOTT(ott);
    sendSuccess(res, result, 'Đăng nhập thành công');
  } catch (err) {
    next(err);
  }
}
