// ═══════════════════════════════════════════════════════════════
// Tenant Context Middleware — Kiểm tra tenant active
// Đảm bảo user thuộc tenant hợp lệ trước khi xử lý request
//
// Superadmin flow:
//   1. Đọc X-Tenant-Id header → inject vào req.user.tenantId
//   2. Nếu không có header → lấy tenant đầu tiên (fallback)
//   3. Validate tenant tồn tại + active
// ═══════════════════════════════════════════════════════════════

import type { Request, Response, NextFunction } from 'express';
import { sendError } from '../utils/response.js';
import { query } from '../config/database.js';

/**
 * Middleware kiểm tra tenant context.
 * - superadmin: đọc X-Tenant-Id header, inject vào req.user.tenantId
 * - Các role khác: phải có tenant_id + tenant phải is_active=true
 */
export async function tenantContext(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!req.user) {
    sendError(res, 'Chưa xác thực', 401);
    return;
  }

  // ── Superadmin: inject tenant từ header hoặc fallback ──
  if (req.user.role === 'superadmin') {
    const headerTenantId = req.headers['x-tenant-id'] as string | undefined;

    if (headerTenantId) {
      // Validate tenant tồn tại + active
      const result = await query<{ is_active: boolean }>(
        'SELECT is_active FROM tenants WHERE id = $1',
        [headerTenantId],
      );

      if (result.rowCount === 0) {
        sendError(res, 'Tenant không tồn tại', 404);
        return;
      }

      if (!result.rows[0].is_active) {
        sendError(res, 'Tenant đã bị vô hiệu hóa', 403);
        return;
      }

      // Inject tenant vào request context
      req.user.tenantId = headerTenantId;
    } else {
      // Fallback: lấy tenant đầu tiên (active)
      const fallback = await query<{ id: string }>(
        'SELECT id FROM tenants WHERE is_active = true ORDER BY created_at ASC LIMIT 1',
      );

      if (fallback.rowCount && fallback.rowCount > 0) {
        req.user.tenantId = fallback.rows[0].id;
      }
      // Nếu không có tenant nào → tenantId vẫn undefined, cho phép superadmin quản lý system-level
    }

    next();
    return;
  }

  // ── Các role khác (superuser, staff, learner): phải dùng tenant_id từ JWT ──
  // Superuser toàn quyền trong 1 tenant duy nhất, KHÔNG switch tenant.
  const { tenantId } = req.user;

  if (!tenantId) {
    sendError(res, 'User không thuộc tenant nào', 403);
    return;
  }

  try {
    const result = await query<{ is_active: boolean }>(
      'SELECT is_active FROM tenants WHERE id = $1',
      [tenantId],
    );

    if (result.rowCount === 0) {
      sendError(res, 'Tenant không tồn tại', 404);
      return;
    }

    if (!result.rows[0].is_active) {
      sendError(res, 'Tenant đã bị vô hiệu hóa', 403);
      return;
    }

    next();
  } catch (err) {
    console.error('[TenantContext] Error:', err);
    sendError(res, 'Lỗi kiểm tra tenant', 500);
  }
}
