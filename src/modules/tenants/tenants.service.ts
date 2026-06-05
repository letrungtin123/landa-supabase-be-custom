// ═══════════════════════════════════════════════════════════════
// Tenants Service — CRUD tenants + toggle modules
// Chỉ superadmin mới gọi được
// ═══════════════════════════════════════════════════════════════

import { query, getClient } from '../../config/database.js';
import { AppError } from '../../middleware/error-handler.js';
import { parsePagination, calcOffset, calcTotalPages } from '../../utils/query-helpers.js';
import type { CreateTenantInput, UpdateTenantInput } from './tenants.validator.js';

/**
 * Danh sách tenants — phân trang + search.
 */
export async function listTenants(queryParams: Record<string, unknown>) {
  const { page, pageSize, search } = parsePagination(queryParams);
  const offset = calcOffset(page, pageSize);
  const params: unknown[] = [];
  let where = '';

  if (search) {
    params.push(`%${search}%`);
    where = `WHERE name ILIKE $${params.length} OR slug ILIKE $${params.length} OR domain ILIKE $${params.length}`;
  }

  params.push(pageSize, offset);
  const result = await query<any>(
    `SELECT id, name, slug, domain, is_active, settings, created_at, updated_at,
            COUNT(*) OVER() AS full_count
     FROM tenants ${where}
     ORDER BY created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  const total = parseInt(result.rows[0]?.full_count ?? '0');

  return {
    data: result.rows.map((r: any) => {
      const { full_count, ...rest } = r;
      return rest;
    }),
    total,
    page,
    pageSize,
    totalPages: calcTotalPages(total, pageSize),
  };
}

/**
 * Chi tiết tenant theo ID.
 */
export async function getTenantById(id: string) {
  const result = await query(
    'SELECT id, name, slug, domain, is_active, settings, created_at, updated_at FROM tenants WHERE id = $1',
    [id],
  );
  if (result.rowCount === 0) throw new AppError('Tenant không tồn tại', 404);
  return result.rows[0];
}

/**
 * Tạo tenant mới + tự động bật tất cả modules (trừ tenant_management).
 */
export async function createTenant(input: CreateTenantInput) {
  // Kiểm tra slug trùng
  const existing = await query('SELECT id FROM tenants WHERE slug = $1', [input.slug]);
  if (existing.rowCount! > 0) throw new AppError('Slug đã tồn tại', 409);

  const client = await getClient();
  try {
    await client.query('BEGIN');

    const result = await client.query(
      `INSERT INTO tenants (name, slug, domain, settings)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, slug, domain`,
      [input.name, input.slug, input.domain ?? null, JSON.stringify(input.settings || {})],
    );
    const tenant = result.rows[0];

    // Tự động bật tất cả modules (trừ tenant_management)
    await client.query(
      `INSERT INTO tenant_modules (tenant_id, module_id, is_enabled)
       SELECT $1, id, true FROM modules WHERE code != 'tenant_management' AND is_active = true`,
      [tenant.id],
    );

    await client.query('COMMIT');
    return tenant;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Cập nhật tenant.
 */
export async function updateTenant(id: string, input: UpdateTenantInput) {
  // Build SET clause động
  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (input.name !== undefined) { sets.push(`name = $${idx++}`); params.push(input.name); }
  if (input.slug !== undefined) { sets.push(`slug = $${idx++}`); params.push(input.slug); }
  if (input.domain !== undefined) { sets.push(`domain = $${idx++}`); params.push(input.domain); }
  if (input.is_active !== undefined) { sets.push(`is_active = $${idx++}`); params.push(input.is_active); }
  if (input.settings !== undefined) { sets.push(`settings = $${idx++}`); params.push(JSON.stringify(input.settings)); }

  if (sets.length === 0) throw new AppError('Không có dữ liệu cần cập nhật', 400);

  params.push(id);
  const result = await query(
    `UPDATE tenants SET ${sets.join(', ')} WHERE id = $${idx} RETURNING id, name, slug, domain, is_active`,
    params,
  );

  if (result.rowCount === 0) throw new AppError('Tenant không tồn tại', 404);
  return result.rows[0];
}

/**
 * Xóa tenant.
 */
export async function deleteTenant(id: string) {
  const result = await query('DELETE FROM tenants WHERE id = $1 RETURNING id', [id]);
  if (result.rowCount === 0) throw new AppError('Tenant không tồn tại', 404);
}

/**
 * Lấy cấu hình modules của tenant (ma trận bật/tắt).
 */
export async function getTenantModules(tenantId: string) {
  const result = await query(
    `SELECT m.id AS module_id, m.code, m.name, m.icon, m.sort_order,
            COALESCE(tm.is_enabled, false) AS is_enabled
     FROM modules m
     LEFT JOIN tenant_modules tm ON tm.module_id = m.id AND tm.tenant_id = $1
     WHERE m.is_active = true
     ORDER BY m.sort_order`,
    [tenantId],
  );
  return result.rows;
}

/**
 * Cập nhật ma trận modules cho tenant (bulk upsert).
 */
export async function updateTenantModules(tenantId: string, modules: { module_id: string; is_enabled: boolean }[]) {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    for (const mod of modules) {
      await client.query(
        `INSERT INTO tenant_modules (tenant_id, module_id, is_enabled)
         VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, module_id) DO UPDATE SET is_enabled = $3`,
        [tenantId, mod.module_id, mod.is_enabled],
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Danh sách tenant nhẹ (chỉ id + name) — dùng cho dropdown filter.
 * Trả ALL tenants cho superadmin, chỉ assigned tenants cho superuser.
 */
export async function listSimpleTenants(userId: string, role: string) {
  if (role === 'superadmin') {
    const result = await query<{ id: string; name: string }>(
      'SELECT id, name FROM tenants WHERE is_active = true ORDER BY name ASC',
    );
    return result.rows;
  }

  // superuser: chỉ lấy tenants được phân quyền qua user_tenants
  const result = await query<{ id: string; name: string }>(
    `SELECT t.id, t.name
     FROM user_tenants ut
     JOIN tenants t ON t.id = ut.tenant_id
     WHERE ut.user_id = $1 AND t.is_active = true
     ORDER BY t.name ASC`,
    [userId],
  );
  return result.rows;
}

/**
 * Lấy danh sách tenant IDs mà user được quản lý.
 */
export async function getUserTenants(userId: string) {
  const result = await query<{ tenant_id: string; tenant_name: string }>(
    `SELECT ut.tenant_id, t.name AS tenant_name
     FROM user_tenants ut
     JOIN tenants t ON t.id = ut.tenant_id
     WHERE ut.user_id = $1
     ORDER BY t.name ASC`,
    [userId],
  );
  return result.rows;
}

/**
 * Gán user quản lý nhiều tenants (superadmin gọi).
 * Thay thế toàn bộ — xóa cũ + insert mới.
 */
export async function setUserTenants(userId: string, tenantIds: string[]) {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    // Xóa tất cả assign cũ
    await client.query('DELETE FROM user_tenants WHERE user_id = $1', [userId]);

    // Insert mới
    for (const tid of tenantIds) {
      await client.query(
        'INSERT INTO user_tenants (user_id, tenant_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [userId, tid],
      );
    }

    await client.query('COMMIT');
    return { updated: tenantIds.length };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

