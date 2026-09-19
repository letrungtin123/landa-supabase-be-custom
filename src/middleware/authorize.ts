// ═══════════════════════════════════════════════════════════════
// Authorize Middleware — Kiểm tra role + permission
// superadmin bypass tất cả, superuser toàn quyền trong tenant
// ═══════════════════════════════════════════════════════════════

import type { Request, Response, NextFunction } from 'express';
import { sendError } from '../utils/response.js';
import { query } from '../config/database.js';
import type { UserRole, PermissionAction } from '../types/index.js';

/**
 * Middleware kiểm tra role tối thiểu.
 * Ví dụ: authorize('staff', 'superuser', 'superadmin')
 * → chỉ cho phép staff trở lên.
 */
export function authorize(...allowedRoles: UserRole[]) {
  // learner_plus có cùng quyền truy cập route như staff
  // (scope dữ liệu riêng xử lý ở controller/service, vd: report summary)
  const effectiveRoles = allowedRoles.includes('staff' as UserRole) && !allowedRoles.includes('learner_plus' as UserRole)
    ? [...allowedRoles, 'learner_plus' as UserRole]
    : allowedRoles;

  return function authorizeMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (!req.user) {
      sendError(res, 'Chưa xác thực', 401);
      return;
    }

    // superadmin luôn bypass
    if (req.user.role === 'superadmin') {
      next();
      return;
    }

    if (!effectiveRoles.includes(req.user.role)) {
      sendError(res, 'Không có quyền truy cập', 403);
      return;
    }

    next();
  };
}

/**
 * Middleware kiểm tra quyền cụ thể trên module.
 * Dùng kết hợp với authenticate: authenticate → checkPermission('library', 'can_edit')
 *
 * Logic:
 * - superadmin: bypass
 * - superuser: toàn quyền trong tenant
 * - staff/learner: kiểm tra permission_group_modules (UNION tất cả groups)
 */
// ── Permission Cache — tránh query ma trận quyền mỗi request ──
const permCache = new Map<string, { allowed: boolean; expires: number }>();
const PERM_CACHE_TTL = 5 * 60_000; // 5 phút
const ALLOWED_PERMISSION_ACTIONS = ['can_view', 'can_add', 'can_edit', 'can_delete'] as const;

export interface PermissionSubject {
  id: string;
  tenantId: string | null;
  role: UserRole;
}

/** Xóa permission cache (gọi khi update quyền) */
export function invalidatePermissionCache(userId?: string) {
  if (!userId) { permCache.clear(); return; }
  for (const key of permCache.keys()) {
    if (key.startsWith(userId + ':')) permCache.delete(key);
  }
}

/**
 * Reusable server-side permission check for service flows that cannot use an
 * Express middleware. Keep this as the single implementation behind
 * checkPermission so chat and HTTP routes apply the same tenant permission
 * matrix and cache semantics.
 */
export async function hasPermission(
  subject: PermissionSubject,
  moduleCode: string,
  action: PermissionAction,
): Promise<boolean> {
  if (!ALLOWED_PERMISSION_ACTIONS.includes(action as typeof ALLOWED_PERMISSION_ACTIONS[number])) {
    throw new Error('Action không hợp lệ');
  }

  if (subject.role === 'superadmin' || subject.role === 'superuser') return true;

  const cacheKey = `${subject.id}:${subject.tenantId}:${moduleCode}:${action}`;
  const cached = permCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.allowed;

  const result = await query<Record<string, boolean>>(
    `SELECT bool_or(pgm.${action}) AS allowed
     FROM user_permission_groups upg
     JOIN permission_group_modules pgm
       ON pgm.permission_group_id = upg.permission_group_id
      AND pgm.tenant_id = upg.tenant_id
     JOIN modules m ON m.id = pgm.module_id
     JOIN permission_groups pg ON pg.id = upg.permission_group_id
     WHERE upg.user_id = $1
       AND upg.tenant_id = $3
       AND m.code = $2
       AND pg.tenant_id = $3`,
    [subject.id, moduleCode, subject.tenantId],
  );
  const allowed = result.rows[0]?.allowed === true;
  permCache.set(cacheKey, { allowed, expires: Date.now() + PERM_CACHE_TTL });
  return allowed;
}

export function checkPermission(moduleCode: string, action: PermissionAction) {
  return async function permissionMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (!req.user) {
      sendError(res, 'Chưa xác thực', 401);
      return;
    }

    const { role, id: userId, tenantId } = req.user;

    if (!ALLOWED_PERMISSION_ACTIONS.includes(action as any)) {
      sendError(res, 'Action không hợp lệ', 400);
      return;
    }

    try {
      const allowed = await hasPermission({ id: userId, tenantId, role }, moduleCode, action);

      if (!allowed) {
        sendError(res, `Không có quyền ${action} trên module ${moduleCode}`, 403);
        return;
      }

      next();
    } catch (err) {
      console.error('[Authorize] Permission check error:', err);
      sendError(res, 'Lỗi kiểm tra quyền', 500);
    }
  };
}
