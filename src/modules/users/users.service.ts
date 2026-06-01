// ═══════════════════════════════════════════════════════════════
// Users Service — CRUD users (tenant-scoped)
// Tối ưu: parameterized queries, index trên tenant_id + role
// ═══════════════════════════════════════════════════════════════

import { query, getClient } from '../../config/database.js';
import { hashPassword } from '../../utils/password.js';
import { AppError } from '../../middleware/error-handler.js';
import { parsePagination, calcOffset, calcTotalPages } from '../../utils/query-helpers.js';
import type { CreateUserInput, UpdateUserInput } from './users.validator.js';

/**
 * Danh sách users — phân trang, search, filter role.
 * Tenant-scoped: staff/superuser chỉ thấy user trong tenant mình.
 * superadmin thấy tất cả (tenantId = null).
 */
export async function listUsers(tenantId: string | null, queryParams: Record<string, unknown>) {
  const { page, pageSize, search } = parsePagination(queryParams);
  const offset = calcOffset(page, pageSize);

  const params: unknown[] = [];
  const conditions: string[] = [];

  // Tenant scope (trừ superadmin)
  if (tenantId) {
    params.push(tenantId);
    conditions.push(`u.tenant_id = $${params.length}`);
  }

  // Search
  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(u.username ILIKE $${params.length} OR u.email ILIKE $${params.length} OR u.full_name ILIKE $${params.length})`);
  }

  // Filter role
  const roleFilter = queryParams.role as string;
  if (roleFilter && roleFilter !== 'all') {
    params.push(roleFilter);
    conditions.push(`u.role = $${params.length}`);
  }

  // Filter is_active (server-side)
  const statusFilter = queryParams.is_active as string;
  if (statusFilter === 'true') {
    conditions.push('u.is_active = true');
  } else if (statusFilter === 'false') {
    conditions.push('u.is_active = false');
  }

  // Filter by permission group
  const permGroupFilter = queryParams.permission_group_id as string;
  if (permGroupFilter) {
    params.push(permGroupFilter);
    conditions.push(`EXISTS (SELECT 1 FROM user_permission_groups upg WHERE upg.user_id = u.id AND upg.permission_group_id = $${params.length})`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const [countResult, dataResult] = await Promise.all([
    query<{ count: string }>(`SELECT COUNT(*) AS count FROM users u ${where}`, params),
    query(
      `SELECT u.id, u.username, u.email, u.full_name, u.phone, u.avatar_url,
              u.role, u.is_active, u.tenant_id, u.last_login_at, u.created_at,
              t.name AS tenant_name
       FROM users u
       LEFT JOIN tenants t ON t.id = u.tenant_id
       ${where}
       ORDER BY u.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset],
    ),
  ]);

  const total = parseInt(countResult.rows[0].count, 10);

  return {
    data: dataResult.rows,
    total,
    page,
    pageSize,
    totalPages: calcTotalPages(total, pageSize),
  };
}

/**
 * Chi tiết user + danh sách permission groups đã gán.
 */
export async function getUserById(userId: string) {
  const [userResult, groupsResult] = await Promise.all([
    query(
      `SELECT u.id, u.username, u.email, u.full_name, u.phone, u.avatar_url,
              u.role, u.is_active, u.tenant_id, u.last_login_at, u.created_at,
              t.name AS tenant_name
       FROM users u
       LEFT JOIN tenants t ON t.id = u.tenant_id
       WHERE u.id = $1`,
      [userId],
    ),
    query(
      `SELECT pg.id, pg.name
       FROM user_permission_groups upg
       JOIN permission_groups pg ON pg.id = upg.permission_group_id
       WHERE upg.user_id = $1
       ORDER BY pg.name`,
      [userId],
    ),
  ]);

  if (userResult.rowCount === 0) throw new AppError('User không tồn tại', 404);

  return {
    ...userResult.rows[0],
    permission_groups: groupsResult.rows,
  };
}

/**
 * Tạo user mới — hash password + kiểm tra unique.
 */
export async function createUser(input: CreateUserInput, callerTenantId: string | null) {
  // Determine tenant: superadmin có thể chỉ định, user khác dùng tenant mình
  const tenantId = input.tenant_id || callerTenantId;

  // Kiểm tra username/email unique
  const existing = await query(
    'SELECT id FROM users WHERE username = $1 OR email = $2 LIMIT 1',
    [input.username, input.email],
  );
  if (existing.rowCount! > 0) {
    throw new AppError('Username hoặc email đã tồn tại', 409);
  }

  const passwordHash = await hashPassword(input.password);

  const result = await query(
    `INSERT INTO users (username, email, password_hash, full_name, phone, role, tenant_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, username, email, full_name, role, tenant_id`,
    [input.username, input.email, passwordHash, input.full_name || '', input.phone || '', input.role, tenantId],
  );

  return result.rows[0];
}

/**
 * Cập nhật user — partial update.
 */
export async function updateUser(userId: string, input: UpdateUserInput) {
  // Check if role is changing FROM learner → remove from teams
  let oldRole: string | null = null;
  if (input.role !== undefined) {
    const current = await query<{ role: string }>('SELECT role FROM users WHERE id = $1', [userId]);
    if (current.rowCount) oldRole = current.rows[0].role;
  }

  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (input.username !== undefined) { sets.push(`username = $${idx++}`); params.push(input.username); }
  if (input.email !== undefined) { sets.push(`email = $${idx++}`); params.push(input.email); }
  if (input.full_name !== undefined) { sets.push(`full_name = $${idx++}`); params.push(input.full_name); }
  if (input.phone !== undefined) { sets.push(`phone = $${idx++}`); params.push(input.phone); }
  if (input.avatar_url !== undefined) { sets.push(`avatar_url = $${idx++}`); params.push(input.avatar_url); }
  if (input.role !== undefined) { sets.push(`role = $${idx++}`); params.push(input.role); }
  if (input.is_active !== undefined) { sets.push(`is_active = $${idx++}`); params.push(input.is_active); }

  // Password — hash trước khi lưu
  if (input.password) {
    const hash = await hashPassword(input.password);
    sets.push(`password_hash = $${idx++}`);
    params.push(hash);
  }

  if (sets.length === 0) throw new AppError('Không có dữ liệu cần cập nhật', 400);

  params.push(userId);
  const result = await query(
    `UPDATE users SET ${sets.join(', ')} WHERE id = $${idx}
     RETURNING id, username, email, full_name, role, is_active`,
    params,
  );

  if (result.rowCount === 0) throw new AppError('User không tồn tại', 404);

  // If role changed FROM learner → remove from all teams
  if (oldRole === 'learner' && input.role !== 'learner') {
    await query('DELETE FROM team_members WHERE user_id = $1', [userId]);
  }

  return result.rows[0];
}

/**
 * Xóa user (hard delete).
 */
export async function deleteUser(userId: string) {
  const result = await query('DELETE FROM users WHERE id = $1 RETURNING id', [userId]);
  if (result.rowCount === 0) throw new AppError('User không tồn tại', 404);
}

/**
 * Gán user vào permission groups (replace toàn bộ).
 */
export async function assignPermissionGroups(userId: string, groupIds: string[]) {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    // Xóa tất cả gán cũ
    await client.query('DELETE FROM user_permission_groups WHERE user_id = $1', [userId]);

    // Gán mới
    for (const groupId of groupIds) {
      await client.query(
        'INSERT INTO user_permission_groups (user_id, permission_group_id) VALUES ($1, $2)',
        [userId, groupId],
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

// ══════════════════════════════════════════════════════════════
// Profile Management — Self-service endpoints (user = caller)
// ══════════════════════════════════════════════════════════════

/**
 * Get user's own profile by username.
 */
export async function getProfile(username: string) {
  const result = await query(
    `SELECT u.id, u.username, u.email, u.full_name, u.phone, u.avatar_url,
            u.role, u.is_active, u.tenant_id, u.created_at,
            u.bio, u.gender, u.country, u.language, u.level_of_education,
            u.year_of_birth, u.phone AS phone_number
     FROM users u
     WHERE u.username = $1`,
    [username],
  );
  if (result.rowCount === 0) throw new AppError('User không tồn tại', 404);
  return result.rows[0];
}

/**
 * Update user's own profile (limited fields).
 */
export async function updateProfile(
  userId: string,
  input: {
    name?: string;
    bio?: string;
    gender?: string;
    country?: string;
    level_of_education?: string;
    language?: string;
    year_of_birth?: number | null;
    phone_number?: string;
  },
) {
  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (input.name !== undefined) { sets.push(`full_name = $${idx++}`); params.push(input.name); }
  if (input.bio !== undefined) { sets.push(`bio = $${idx++}`); params.push(input.bio); }
  if (input.gender !== undefined) { sets.push(`gender = $${idx++}`); params.push(input.gender); }
  if (input.country !== undefined) { sets.push(`country = $${idx++}`); params.push(input.country); }
  if (input.level_of_education !== undefined) { sets.push(`level_of_education = $${idx++}`); params.push(input.level_of_education); }
  if (input.language !== undefined) { sets.push(`language = $${idx++}`); params.push(input.language); }
  if (input.year_of_birth !== undefined) { sets.push(`year_of_birth = $${idx++}`); params.push(input.year_of_birth); }
  if (input.phone_number !== undefined) { sets.push(`phone = $${idx++}`); params.push(input.phone_number); }

  if (sets.length === 0) throw new AppError('Không có dữ liệu cần cập nhật', 400);

  params.push(userId);
  const result = await query(
    `UPDATE users SET ${sets.join(', ')} WHERE id = $${idx}
     RETURNING id, username, email, full_name, role`,
    params,
  );
  if (result.rowCount === 0) throw new AppError('User không tồn tại', 404);
  return result.rows[0];
}

/**
 * Update avatar URL.
 */
export async function updateAvatar(userId: string, avatarUrl: string) {
  await query('UPDATE users SET avatar_url = $1 WHERE id = $2', [avatarUrl, userId]);
}

/**
 * Change password — verify current password first.
 */
export async function changePassword(userId: string, currentPassword: string, newPassword: string) {
  const { comparePassword } = await import('../../utils/password.js');

  const result = await query<{ password_hash: string }>(
    'SELECT password_hash FROM users WHERE id = $1',
    [userId],
  );
  if (result.rowCount === 0) throw new AppError('User không tồn tại', 404);

  const isValid = await comparePassword(currentPassword, result.rows[0].password_hash);
  if (!isValid) throw new AppError('Mật khẩu hiện tại không đúng', 400);

  const newHash = await hashPassword(newPassword);
  await query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, userId]);
}

