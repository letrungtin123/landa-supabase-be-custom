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

    if (!allowedRoles.includes(req.user.role)) {
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

/** Xóa permission cache (gọi khi update quyền) */
export function invalidatePermissionCache(userId?: string) {
  if (!userId) { permCache.clear(); return; }
  for (const key of permCache.keys()) {
    if (key.startsWith(userId + ':')) permCache.delete(key);
  }
}

export function checkPermission(moduleCode: string, action: PermissionAction) {
  return async function permissionMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (!req.user) {
      sendError(res, 'Chưa xác thực', 401);
      return;
    }

    const { role, id: userId, tenantId } = req.user;

    // Runtime whitelist — TypeScript types are erased, must validate at runtime
    const ALLOWED_ACTIONS = ['can_view', 'can_add', 'can_edit', 'can_delete'] as const;
    if (!ALLOWED_ACTIONS.includes(action as any)) {
      sendError(res, 'Action không hợp lệ', 400);
      return;
    }

    // superadmin & superuser bypass
    if (role === 'superadmin' || role === 'superuser') {
      next();
      return;
    }

    try {
      // Check cache first
      const cacheKey = `${userId}:${tenantId}:${moduleCode}:${action}`;
      const cached = permCache.get(cacheKey);
      if (cached && cached.expires > Date.now()) {
        if (!cached.allowed) {
          sendError(res, `Không có quyền ${action} trên module ${moduleCode}`, 403);
          return;
        }
        next();
        return;
      }

      // Query ma trận quyền: UNION tất cả groups user thuộc về
      const result = await query<Record<string, boolean>>(
        `SELECT bool_or(pgm.${action}) AS allowed
         FROM user_permission_groups upg
         JOIN permission_group_modules pgm ON pgm.permission_group_id = upg.permission_group_id
         JOIN modules m ON m.id = pgm.module_id
         JOIN permission_groups pg ON pg.id = upg.permission_group_id
         WHERE upg.user_id = $1
           AND m.code = $2
           AND pg.tenant_id = $3`,
        [userId, moduleCode, tenantId],
      );

      const allowed = result.rows[0]?.allowed === true;

      // Cache result
      permCache.set(cacheKey, { allowed, expires: Date.now() + PERM_CACHE_TTL });

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
