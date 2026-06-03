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

// ── Tenant Status Cache — tránh query DB mỗi request ──
const tenantCache = new Map<string, { active: boolean; expires: number }>();
const CACHE_TTL = 60_000; // 60s

async function getTenantStatus(tenantId: string): Promise<boolean | null> {
  const cached = tenantCache.get(tenantId);
  if (cached && cached.expires > Date.now()) return cached.active;

  const result = await query<{ is_active: boolean }>(
    'SELECT is_active FROM tenants WHERE id = $1',
    [tenantId],
  );
  if (result.rowCount === 0) {
    tenantCache.delete(tenantId);
    return null; // tenant không tồn tại
  }

  tenantCache.set(tenantId, { active: result.rows[0].is_active, expires: Date.now() + CACHE_TTL });
  return result.rows[0].is_active;
}

/** Xóa cache khi tenant bị update (gọi từ tenants controller) */
export function invalidateTenantCache(tenantId?: string) {
  if (tenantId) tenantCache.delete(tenantId);
  else tenantCache.clear();
}

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
      const status = await getTenantStatus(headerTenantId);
      if (status === null) { sendError(res, 'Tenant không tồn tại', 404); return; }
      if (!status) { sendError(res, 'Tenant đã bị vô hiệu hóa', 403); return; }
      req.user.tenantId = headerTenantId;
    } else {
      // Fallback: lấy tenant đầu tiên (active) — không cache vì hiếm khi gọi
      const fallback = await query<{ id: string }>(
        'SELECT id FROM tenants WHERE is_active = true ORDER BY created_at ASC LIMIT 1',
      );
      if (fallback.rowCount && fallback.rowCount > 0) {
        req.user.tenantId = fallback.rows[0].id;
      }
    }

    next();
    return;
  }

  // ── Các role khác: phải dùng tenant_id từ JWT ──
  const { tenantId } = req.user;

  if (!tenantId) {
    sendError(res, 'User không thuộc tenant nào', 403);
    return;
  }

  try {
    const status = await getTenantStatus(tenantId);
    if (status === null) { sendError(res, 'Tenant không tồn tại', 404); return; }
    if (!status) { sendError(res, 'Tenant đã bị vô hiệu hóa', 403); return; }
    next();
  } catch (err) {
    console.error('[TenantContext] Error:', err);
    sendError(res, 'Lỗi kiểm tra tenant', 500);
  }
}
