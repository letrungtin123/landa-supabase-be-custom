// ═══════════════════════════════════════════════════════════════
// Users Service — CRUD users (tenant-scoped)
// Tối ưu: parameterized queries, index trên tenant_id + role
// ═══════════════════════════════════════════════════════════════

import { query, getClient } from '../../config/database.js';
import { hashPassword } from '../../utils/password.js';
import { AppError } from '../../middleware/error-handler.js';
import { parsePagination, calcOffset, calcTotalPages } from '../../utils/query-helpers.js';
import { blacklistUser } from '../../middleware/authenticate.js';
import type { CreateUserInput, UpdateUserInput } from './users.validator.js';
import { isLearnerRole } from '../../types/index.js';
import { removeUserFromDemoLogin } from '../demo-login/demo-login.service.js';
import { assertUserNotActiveDemoIframeAccount, getActiveDemoIframeUserIds } from '../demo-login/demo-iframe.service.js';

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

  // Filter role (supports comma-separated: 'learner,learner_plus')
  const roleFilter = queryParams.role as string;
  if (roleFilter && roleFilter !== 'all') {
    if (roleFilter.includes(',')) {
      const roles = roleFilter.split(',').map(r => r.trim()).filter(Boolean);
      params.push(roles);
      conditions.push(`u.role = ANY($${params.length}::user_role[])`);
    } else {
      params.push(roleFilter);
      conditions.push(`u.role = $${params.length}`);
    }
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
              t.name AS tenant_name,
              pg.id AS permission_group_id,
              pg.name AS permission_group_name
       FROM users u
       LEFT JOIN tenants t ON t.id = u.tenant_id
       LEFT JOIN user_permission_groups upg ON upg.user_id = u.id
       LEFT JOIN permission_groups pg ON pg.id = upg.permission_group_id
       ${where}
       ORDER BY u.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset],
    ),
  ]);

  const total = parseInt(countResult.rows[0].count, 10);
  const activeDemoIframeUserIds = await getActiveDemoIframeUserIds(dataResult.rows.map((row: any) => row.id));

  return {
    data: dataResult.rows.map((row: any) => ({
      ...row,
      is_demo_iframe_active: activeDemoIframeUserIds.has(row.id),
    })),
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

  const activeDemoIframeUserIds = await getActiveDemoIframeUserIds([userId]);

  return {
    ...userResult.rows[0],
    is_demo_iframe_active: activeDemoIframeUserIds.has(userId),
    permission_groups: groupsResult.rows,
  };
}

/**
 * Tạo user mới — hash password + kiểm tra unique + kiểm tra quota.
 */
export async function createUser(input: CreateUserInput, callerTenantId: string | null) {
  // Determine tenant: superadmin có thể chỉ định, user khác dùng tenant mình
  const tenantId = input.tenant_id || callerTenantId;

  // ── Kiểm tra quota user cho tenant ──
  if (tenantId) {
    const { checkQuota } = await import('../tenants/tenants.service.js');
    await checkQuota(tenantId, 'users');
  }

  // Kiểm tra username/email unique (global — không phân theo tenant)
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
  await assertUserNotActiveDemoIframeAccount(userId, 'Tài khoản learner demo iframe đang được khóa, không thể cập nhật');

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

  // If role changed FROM learner/learner_plus → non-learner: remove from teams + permission groups
  if (isLearnerRole(input.role!) && oldRole && !isLearnerRole(oldRole)) {
    await query('DELETE FROM team_members WHERE user_id = $1', [userId]);
    await query('DELETE FROM user_permission_groups WHERE user_id = $1', [userId]);
  } else if (oldRole && isLearnerRole(oldRole) && !isLearnerRole(input.role!)) {
    // From learner/learner_plus → staff/superuser: remove from teams
    await query('DELETE FROM team_members WHERE user_id = $1', [userId]);
  }

  // ── CRITICAL: Revoke ALL refresh tokens khi role thay đổi ──
  // JWT cũ vẫn chứa role cũ → nếu không revoke, user tiếp tục dùng
  // token với role cũ nhưng team_members đã bị xóa → API trả rỗng.
  // Force re-login để nhận JWT với role mới.
  if ((oldRole === 'learner' && input.role !== undefined && input.role !== 'learner') || input.is_active === false) {
    await removeUserFromDemoLogin(userId);
  }

  if (input.role !== undefined && oldRole && input.role !== oldRole) {
    await query('UPDATE refresh_tokens SET revoked = true WHERE user_id = $1', [userId]);
    // Blacklist user ngay lập tức — access token cũ bị reject TỨC THÌ
    blacklistUser(userId);
  }

  return result.rows[0];
}

/**
 * Hard delete user — CASCADE xóa sạch 14+ bảng.
 * Role hierarchy:
 *   - KHÔNG cho xóa chính mình
 *   - staff: KHÔNG xóa superadmin, superuser, staff khác
 *   - superuser: xóa superuser khác, staff, learner (trong tenant)
 *   - superadmin: xóa tất cả (trừ chính mình)
 */
export async function hardDeleteUser(
  targetId: string,
  callerId: string,
  callerRole: string,
  callerTenantId: string | null,
) {
  // Guard 1: không xóa chính mình
  if (targetId === callerId) throw new AppError('Không thể xóa chính mình', 403);

  // Lấy thông tin target user
  const targetResult = await query<{ id: string; username: string; email: string; role: string; tenant_id: string | null; avatar_url: string | null }>(
    'SELECT id, username, email, role, tenant_id, avatar_url FROM users WHERE id = $1',
    [targetId],
  );
  if (targetResult.rowCount === 0) throw new AppError('User không tồn tại', 404);
  const target = targetResult.rows[0];
  await assertUserNotActiveDemoIframeAccount(targetId, 'Tài khoản learner demo iframe đang được khóa, không thể xóa');

  // Guard 2: tenant isolation (trừ superadmin)
  if (callerRole !== 'superadmin' && callerTenantId && target.tenant_id !== callerTenantId) {
    throw new AppError('Không có quyền xóa user ngoài tenant', 403);
  }

  // Guard 3: role hierarchy
  const ROLE_LEVEL: Record<string, number> = { learner: 0, learner_plus: 0, staff: 1, superuser: 2, superadmin: 3 };
  const callerLevel = ROLE_LEVEL[callerRole] ?? 0;
  const targetLevel = ROLE_LEVEL[target.role] ?? 0;

  // superadmin (3) có thể xóa tất cả (trừ chính mình — đã check)
  // superuser (2) có thể xóa: superuser khác (2), staff (1), learner (0)
  // staff (1) chỉ có thể xóa: learner (0)
  if (callerLevel <= targetLevel && callerRole !== 'superadmin') {
    throw new AppError(`Không có quyền xóa ${target.role}`, 403);
  }
  // Đặc biệt: superadmin mới xóa được superadmin khác
  if (target.role === 'superadmin' && callerRole !== 'superadmin') {
    throw new AppError('Chỉ superadmin mới xóa được superadmin', 403);
  }

  // DELETE — CASCADE xóa sạch: enrollments, course_progress, block_completions,
  //   refresh_tokens, team_members, user_permission_groups, user_tenants,
  //   user_badges, study_sessions, notification_recipients,
  //   course_modal_states, section_modal_shown
  //   SET NULL: audit_logs.actor_id, course_assets.uploaded_by,
  //   documents.uploaded_by, notifications.sent_by, help_pages.created_by/updated_by
  const result = await query('DELETE FROM users WHERE id = $1 RETURNING id', [targetId]);
  if (result.rowCount === 0) throw new AppError('Xóa user thất bại', 500);

  return { avatarUrl: target.avatar_url, deletedUserName: target.username || target.email || target.id };
}

/**
 * Gán user vào permission groups (replace toàn bộ).
 */
export async function assignPermissionGroups(userId: string, groupIds: string[]) {
  await assertUserNotActiveDemoIframeAccount(userId, 'Tài khoản learner demo iframe đang được khóa, không thể cập nhật quyền');

  // Enforce max 1 group per staff/superuser
  if (groupIds.length > 1) {
    throw new AppError('Mỗi staff chỉ được gán tối đa 1 nhóm quyền', 400);
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');

    // Xóa tất cả gán cũ
    await client.query('DELETE FROM user_permission_groups WHERE user_id = $1', [userId]);

    // Gán mới (max 1)
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
  await assertUserNotActiveDemoIframeAccount(userId, 'Tài khoản learner demo iframe đang được khóa, không thể cập nhật hồ sơ');

  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (input.name !== undefined) { sets.push(`full_name = $${idx++}`); params.push(input.name); }
  if (input.bio !== undefined) { sets.push(`bio = $${idx++}`); params.push(input.bio); }
  if (input.gender !== undefined) {
    const validGenders = ['male', 'female', 'other', ''];
    if (!validGenders.includes(input.gender)) {
      throw new AppError(`Giới tính không hợp lệ: "${input.gender}". Chỉ chấp nhận: male, female, other`, 400);
    }
    if (input.gender === '') {
      sets.push(`gender = $${idx++}`); params.push(null);
    } else {
      sets.push(`gender = $${idx++}`); params.push(input.gender);
    }
  }
  if (input.country !== undefined) { sets.push(`country = $${idx++}`); params.push(input.country); }
  if (input.level_of_education !== undefined) {
    const validEdu = ['primary', 'junior_high', 'high_school', 'associate', 'bachelor', 'master', 'doctorate', 'other', 'none', ''];
    if (!validEdu.includes(input.level_of_education)) {
      throw new AppError(`Trình độ học vấn không hợp lệ: "${input.level_of_education}"`, 400);
    }
    if (input.level_of_education === '') {
      sets.push(`level_of_education = $${idx++}`); params.push(null);
    } else {
      sets.push(`level_of_education = $${idx++}`); params.push(input.level_of_education);
    }
  }
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
  await assertUserNotActiveDemoIframeAccount(userId, 'Tài khoản learner demo iframe đang được khóa, không thể cập nhật avatar');
  await query('UPDATE users SET avatar_url = $1 WHERE id = $2', [avatarUrl, userId]);
}

/**
 * Change password — verify current password first.
 */
export async function changePassword(userId: string, currentPassword: string, newPassword: string) {
  await assertUserNotActiveDemoIframeAccount(userId, 'Tài khoản learner demo iframe đang được khóa, không thể đổi mật khẩu');

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
