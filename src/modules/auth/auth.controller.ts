// ═══════════════════════════════════════════════════════════════
// Auth Controller — Handler cho login, refresh, logout, me
// ═══════════════════════════════════════════════════════════════

import type { Request, Response, NextFunction } from 'express';
import * as authService from './auth.service.js';
import { loginSchema, refreshSchema } from './auth.validator.js';
import { sendSuccess, sendError } from '../../utils/response.js';
import { withDatabaseTransaction } from '../../config/database.js';
import { appendAuditLog, getClientIp, type TransactionalAuditEntry } from '../../middleware/audit-log.js';

/**
 * Authentication availability must not depend on tenant quota. We record only
 * operator sessions (staff+) and deliberately do not fail login/logout when
 * the audit write is rejected; the failure remains visible to operations.
 */
async function appendBestEffortOperatorAuthAudit(
  req: Request,
  actor: { id: string; username: string; role: string; tenant_id: string | null },
  action: 'LOGIN' | 'LOGOUT',
): Promise<void> {
  if (!['staff', 'superuser', 'superadmin'].includes(actor.role)) return;
  const isPlatformEvent = actor.role === 'superadmin' || !actor.tenant_id;
  const entry: TransactionalAuditEntry = {
    tenantId: isPlatformEvent ? null : actor.tenant_id,
    platformEvent: isPlatformEvent,
    actorId: actor.id,
    actorUsername: actor.username,
    action,
    entityType: 'user',
    entityId: actor.id,
    entityName: actor.username,
    ipAddress: getClientIp(req),
    event: { code: action === 'LOGIN' ? 'auth.login.succeeded' : 'auth.logout.succeeded' },
  };
  try {
    await withDatabaseTransaction((client) => appendAuditLog(client, entry));
  } catch (error) {
    console.error(`[Audit] Could not record ${action.toLowerCase()} event for ${actor.id}:`, error);
  }
}

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
    await appendBestEffortOperatorAuthAudit(req, result.user, 'LOGIN');

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

    if (req.user) {
      await appendBestEffortOperatorAuthAudit(req, {
        id: req.user.id,
        username: req.user.username,
        role: req.user.role,
        tenant_id: req.user.role === 'superadmin' ? null : req.user.tenantId,
      }, 'LOGOUT');
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
    (result as { session_mode?: string }).session_mode = req.user.sessionMode;
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
 * GET /api/auth/group-labels
 * Lay ten hien thi cau truc nhom theo tenant context hien tai.
 */
export async function getGroupLabelsController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      sendError(res, 'Chưa xác thực', 401);
      return;
    }

    const result = await authService.getGroupLabelsForTenant(req.user.tenantId);
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

    if (req.user.sessionMode === 'demo_iframe') {
      sendError(res, 'Phiên demo iframe không thể đổi mật khẩu', 403);
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

    if (req.user.sessionMode === 'demo_iframe') {
      sendError(res, 'Phiên demo iframe không thể cập nhật hồ sơ', 403);
      return;
    }

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
