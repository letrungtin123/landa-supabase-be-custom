// ═══════════════════════════════════════════════════════════════
// Tenants Service — CRUD tenants + toggle modules
// Chỉ superadmin mới gọi được
// ═══════════════════════════════════════════════════════════════

import { query, getClient } from '../../config/database.js';
import { cacheJson, bumpCacheVersion, getCacheVersion } from '../../config/cache.js';
import { CACHE_TTL, cacheKeys, cacheVersions } from '../../config/cache-keys.js';
import {
  invalidatePublicDomainCachesForDomains,
  invalidateUserMembershipCaches,
} from '../../config/cache-invalidation.js';
import { AppError } from '../../middleware/error-handler.js';
import { parsePagination, calcOffset, calcTotalPages } from '../../utils/query-helpers.js';
import type { CreateTenantInput, UpdateTenantInput } from './tenants.validator.js';

const TENANT_PUBLIC_CACHE_RESOURCES = ['branding', 'dashboard-content', 'sso-public', 'demo-login'] as const;

async function getTenantPublicDomains(tenantId: string): Promise<string[]> {
  const result = await query<{ domain_admin: string | null; domain_learner: string | null }>(
    'SELECT domain_admin, domain_learner FROM tenants WHERE id = $1',
    [tenantId],
  );
  const row = result.rows[0];
  return [row?.domain_admin ?? null, row?.domain_learner ?? null].filter((domain): domain is string => !!domain);
}

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
    where = `WHERE name ILIKE $${params.length} OR slug ILIKE $${params.length} OR domain_learner ILIKE $${params.length} OR domain_admin ILIKE $${params.length}`;
  }

  params.push(pageSize, offset);
  const result = await query<any>(
    `SELECT id, name, slug, domain_learner, domain_admin, is_active, settings, max_users, max_courses, created_at, updated_at,
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
    'SELECT id, name, slug, domain_learner, domain_admin, is_active, settings, max_users, max_courses, created_at, updated_at FROM tenants WHERE id = $1',
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
      `INSERT INTO tenants (name, slug, domain_learner, domain_admin, max_users, max_courses, settings)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, name, slug, domain_learner, domain_admin, max_users, max_courses`,
      [input.name, input.slug, input.domain_learner ?? null, input.domain_admin ?? null, input.max_users ?? null, input.max_courses ?? null, JSON.stringify(input.settings || {})],
    );
    const tenant = result.rows[0];

    // Tự động bật tất cả modules (trừ tenant_management)
    await client.query(
      `INSERT INTO tenant_modules (tenant_id, module_id, is_enabled)
       SELECT $1, id, true FROM modules WHERE code != 'tenant_management' AND is_active = true`,
      [tenant.id],
    );

    await client.query('COMMIT');
    await Promise.all([
      bumpCacheVersion(...cacheVersions.tenantResource('system', 'tenants-simple')),
      invalidatePublicDomainCachesForDomains(
        [tenant.domain_admin, tenant.domain_learner],
        TENANT_PUBLIC_CACHE_RESOURCES,
      ),
    ]);
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
  const oldDomains = await getTenantPublicDomains(id);
  const tenant = await updateTenantFromDb(id, input);
  await Promise.all([
    bumpCacheVersion(...cacheVersions.tenantResource('system', 'tenants-simple')),
    bumpCacheVersion(...cacheVersions.tenantResource(id, 'branding')),
    bumpCacheVersion(...cacheVersions.tenantResource(id, 'dashboard-content')),
    invalidatePublicDomainCachesForDomains(
      [...oldDomains, tenant.domain_admin, tenant.domain_learner],
      TENANT_PUBLIC_CACHE_RESOURCES,
    ),
  ]);
  return tenant;
}

async function updateTenantFromDb(id: string, input: UpdateTenantInput) {
  // Build SET clause động
  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (input.name !== undefined) { sets.push(`name = $${idx++}`); params.push(input.name); }
  if (input.slug !== undefined) { sets.push(`slug = $${idx++}`); params.push(input.slug); }
  if (input.domain_learner !== undefined) { sets.push(`domain_learner = $${idx++}`); params.push(input.domain_learner); }
  if (input.domain_admin !== undefined) { sets.push(`domain_admin = $${idx++}`); params.push(input.domain_admin); }
  if (input.max_users !== undefined) { sets.push(`max_users = $${idx++}`); params.push(input.max_users); }
  if (input.max_courses !== undefined) { sets.push(`max_courses = $${idx++}`); params.push(input.max_courses); }
  if (input.is_active !== undefined) { sets.push(`is_active = $${idx++}`); params.push(input.is_active); }
  if (input.settings !== undefined) { sets.push(`settings = $${idx++}`); params.push(JSON.stringify(input.settings)); }

  if (sets.length === 0) throw new AppError('Không có dữ liệu cần cập nhật', 400);

  params.push(id);
  const result = await query(
    `UPDATE tenants SET ${sets.join(', ')} WHERE id = $${idx} RETURNING id, name, slug, domain_learner, domain_admin, max_users, max_courses, is_active`,
    params,
  );

  if (result.rowCount === 0) throw new AppError('Tenant không tồn tại', 404);
  return result.rows[0];
}

/**
 * Xóa tenant.
 */
export async function deleteTenant(id: string) {
  const oldDomains = await getTenantPublicDomains(id);
  await deleteTenantFromDb(id);
  await Promise.all([
    bumpCacheVersion(...cacheVersions.tenantResource('system', 'tenants-simple')),
    invalidatePublicDomainCachesForDomains(oldDomains, TENANT_PUBLIC_CACHE_RESOURCES),
  ]);
}

async function deleteTenantFromDb(id: string) {
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
  const [systemVersion, userVersion] = await Promise.all([
    getCacheVersion(...cacheVersions.tenantResource('system', 'tenants-simple')),
    getCacheVersion(...cacheVersions.userMembership(userId)),
  ]);
  return cacheJson(
    cacheKeys.tenantResource('system', 'tenants-simple', `${systemVersion}:${userVersion}`, { userId, role }),
    CACHE_TTL.tenantList,
    () => listSimpleTenantsFromDb(userId, role),
  );
}

async function listSimpleTenantsFromDb(userId: string, role: string) {
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
    await invalidateUserMembershipCaches([userId]);
    return { updated: tenantIds.length };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Lấy quota usage hiện tại của tenant — dùng cho UI hiển thị.
 */
export async function getTenantQuotaUsage(tenantId: string) {
  const result = await query<{
    max_users: number | null;
    max_courses: number | null;
    current_users: string;
    current_courses: string;
  }>(
    `SELECT t.max_users, t.max_courses,
            (SELECT COUNT(*)::text FROM users WHERE tenant_id = $1) AS current_users,
            (SELECT COUNT(*)::text FROM courses WHERE tenant_id = $1) AS current_courses
     FROM tenants t WHERE t.id = $1`,
    [tenantId],
  );
  if (result.rowCount === 0) throw new AppError('Tenant không tồn tại', 404);
  const row = result.rows[0];
  return {
    max_users: row.max_users,
    max_courses: row.max_courses,
    current_users: parseInt(row.current_users, 10),
    current_courses: parseInt(row.current_courses, 10),
  };
}

/**
 * Kiểm tra quota trước khi tạo user/course — race-condition safe.
 * Dùng SELECT FOR UPDATE để lock row tenant trong transaction.
 * @throws AppError nếu vượt quota
 */
export async function checkQuota(
  tenantId: string,
  resource: 'users' | 'courses',
  client?: import('pg').PoolClient,
): Promise<void> {
  const col = resource === 'users' ? 'max_users' : 'max_courses';
  const table = resource === 'users' ? 'users' : 'courses';

  // Dùng subquery atomic — không cần lock nếu không truyền client
  const q = client || { query: (sql: string, p: unknown[]) => query(sql, p) };
  const result = await q.query(
    `SELECT ${col} AS quota,
            (SELECT COUNT(*) FROM ${table} WHERE tenant_id = $1) AS current_count
     FROM tenants
     WHERE id = $1
     ${client ? 'FOR UPDATE' : ''}`,
    [tenantId],
  );

  if (result.rows.length === 0) throw new AppError('Tenant không tồn tại', 404);

  const { quota, current_count } = result.rows[0] as { quota: number | null; current_count: string };
  if (quota !== null && parseInt(current_count, 10) >= quota) {
    const label = resource === 'users' ? 'user' : 'course';
    throw new AppError(`Đã đạt mức giới hạn của ${label}`, 403);
  }
}
