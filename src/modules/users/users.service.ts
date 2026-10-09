// ═══════════════════════════════════════════════════════════════
// Users Service — CRUD users (tenant-scoped)
// Tối ưu: parameterized queries, index trên tenant_id + role
// ═══════════════════════════════════════════════════════════════

import { query, withDatabaseTransaction } from '../../config/database.js';
import { hashPassword } from '../../utils/password.js';
import { AppError } from '../../middleware/error-handler.js';
import { normalizeEmail } from '../../utils/email.js';
import { parsePagination, calcOffset, calcTotalPages } from '../../utils/query-helpers.js';
import { blacklistUser } from '../../middleware/authenticate.js';
import { recordUserSessionRevocation } from '../auth/auth-revocation.service.js';
import { replacePasswordAndEndSessions } from '../auth/auth.service.js';
import type { CreateUserInput, UpdateUserInput } from './users.validator.js';
import { isLearnerRole } from '../../types/index.js';
import { removeUserFromDemoLogin } from '../demo-login/demo-login.service.js';
import { assertUserNotActiveDemoIframeAccount, getActiveDemoIframeUserIds } from '../demo-login/demo-iframe.service.js';
import { replaceUserPermissionGroup } from '../permissions/permissions.service.js';
import type { PermissionGroupHistoryActor } from '../permissions/permission-group-history.service.js';
import {
  ACTIVE_SUPERADMIN_COUNT_SQL,
  SUPERADMIN_SET_LOCK_SQL,
  UserAuthorityError,
  assertCanAssignPermissionGroup,
  assertCanCreateUser,
  assertCanUpdateUser,
  removesActiveSuperadmin,
  type UserAuthorityActor,
  type UserAuthorityChange,
  type UserAuthorityTarget,
} from './user-authority.logic.js';

/** The caller of an admin user write: authority subject + permission-history actor. */
export type UserAdminActor = UserAuthorityActor & PermissionGroupHistoryActor;

function isPgUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === '23505';
}

function throwDuplicateUsernameOrEmail(): never {
  throw new AppError('Username hoặc email đã tồn tại', 409);
}

async function assertUsernameOrEmailAvailable(username?: string, normalizedEmail?: string, excludeUserId?: string): Promise<void> {
  if (username !== undefined) {
    const params: unknown[] = [username];
    const excludeClause = excludeUserId ? ' AND id <> $2' : '';
    if (excludeUserId) params.push(excludeUserId);
    const existingUsername = await query(
      `SELECT id FROM users WHERE username = $1${excludeClause} LIMIT 1`,
      params,
    );
    if (existingUsername.rowCount! > 0) throwDuplicateUsernameOrEmail();
  }

  if (normalizedEmail !== undefined) {
    const params: unknown[] = [normalizedEmail];
    const excludeClause = excludeUserId ? ' AND id <> $2' : '';
    if (excludeUserId) params.push(excludeUserId);
    const existingEmail = await query(
      `SELECT id
       FROM users
       WHERE btrim(email) <> ''
         AND lower(btrim(email)) = $1${excludeClause}
       LIMIT 1`,
      params,
    );
    if (existingEmail.rowCount! > 0) throwDuplicateUsernameOrEmail();
  }
}

/**
 * Danh sách users — phân trang, search, filter role.
 * Tenant-scoped: staff/superuser chỉ thấy user trong tenant mình.
 * superadmin thấy tất cả (tenantId = null).
 */
export async function listUsers(tenantId: string | null, queryParams: Record<string, unknown>) {
  const { page, pageSize, search } = parsePagination(queryParams);
  const offset = calcOffset(page, pageSize);

  const params: unknown[] = [];
  const conditions: string[] = ['u.deletion_requested_at IS NULL'];

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
    conditions.push(
      `EXISTS (
         SELECT 1
         FROM user_permission_groups upg
         JOIN permission_groups pg_filter ON pg_filter.id = upg.permission_group_id
         WHERE upg.user_id = u.id
           AND upg.permission_group_id = $${params.length}
           AND upg.tenant_id = u.tenant_id
           AND pg_filter.tenant_id = u.tenant_id
       )`,
    );
  }

  const includeTeamAssignments = queryParams.include_team_assignments === 'true' || queryParams.include_team_assignments === true;
  const currentTeamId = typeof queryParams.current_team_id === 'string' && queryParams.current_team_id.trim()
    ? queryParams.current_team_id.trim()
    : null;

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
       LEFT JOIN user_permission_groups upg ON upg.user_id = u.id AND upg.tenant_id = u.tenant_id
       LEFT JOIN permission_groups pg ON pg.id = upg.permission_group_id AND pg.tenant_id = u.tenant_id
       ${where}
       ORDER BY u.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset],
    ),
  ]);

  const total = parseInt(countResult.rows[0].count, 10);
  const userIds = dataResult.rows.map((row: any) => row.id);
  const activeDemoIframeUserIds = await getActiveDemoIframeUserIds(userIds);
  const teamAssignmentsByUser = new Map<string, { team_assignments: unknown[]; is_current_team_member: boolean }>();

  if (includeTeamAssignments && userIds.length > 0) {
    const membershipParams: unknown[] = [userIds];
    const membershipConditions = ['tm.user_id = ANY($1::uuid[])'];

    if (tenantId) {
      membershipParams.push(tenantId);
      membershipConditions.push(`og.tenant_id = $${membershipParams.length}::uuid`);
    }

    let currentTeamExpr = 'false';
    if (currentTeamId) {
      membershipParams.push(currentTeamId);
      currentTeamExpr = `t.id::text = $${membershipParams.length}`;
    }

    const membershipResult = await query<{
      user_id: string;
      team_assignments: unknown[] | null;
      is_current_team_member: boolean | null;
    }>(
      `SELECT tm.user_id,
              jsonb_agg(
                jsonb_build_object(
                  'group_id', og.id,
                  'group_name', og.name,
                  'subgroup_id', sg.id,
                  'subgroup_name', sg.name,
                  'team_id', t.id,
                  'team_name', t.name,
                  'is_current_team', ${currentTeamExpr}
                )
                ORDER BY og.name, sg.name, t.name
              ) AS team_assignments,
              bool_or(${currentTeamExpr}) AS is_current_team_member
       FROM team_members tm
       JOIN teams t ON t.id = tm.team_id
       JOIN sub_groups sg ON sg.id = t.sub_group_id
       JOIN org_groups og ON og.id = sg.org_group_id
       WHERE ${membershipConditions.join(' AND ')}
       GROUP BY tm.user_id`,
      membershipParams,
    );

    for (const row of membershipResult.rows) {
      teamAssignmentsByUser.set(row.user_id, {
        team_assignments: row.team_assignments || [],
        is_current_team_member: Boolean(row.is_current_team_member),
      });
    }
  }

  return {
    data: dataResult.rows.map((row: any) => {
      const membershipContext = teamAssignmentsByUser.get(row.id);
      return {
        ...row,
        is_demo_iframe_active: activeDemoIframeUserIds.has(row.id),
        ...(includeTeamAssignments
          ? {
              team_assignments: membershipContext?.team_assignments || [],
              team_assignment_count: membershipContext?.team_assignments.length || 0,
              is_current_team_member: membershipContext?.is_current_team_member || false,
            }
          : {}),
      };
    }),
    total,
    page,
    pageSize,
    totalPages: calcTotalPages(total, pageSize),
  };
}

/**
 * Chi tiết user + danh sách permission groups đã gán.
 */
export async function getUserById(userId: string, tenantScopeId: string | null = null) {
  const [userResult, groupsResult] = await Promise.all([
    query(
      `SELECT u.id, u.username, u.email, u.full_name, u.phone, u.avatar_url,
              u.role, u.is_active, u.tenant_id, u.last_login_at, u.created_at,
              t.name AS tenant_name
       FROM users u
       LEFT JOIN tenants t ON t.id = u.tenant_id
       WHERE u.id = $1
         AND u.deletion_requested_at IS NULL
         AND ($2::uuid IS NULL OR u.tenant_id = $2::uuid)`,
      [userId, tenantScopeId],
    ),
    query(
      `SELECT pg.id, pg.name
       FROM user_permission_groups upg
       JOIN permission_groups pg ON pg.id = upg.permission_group_id
       JOIN users u ON u.id = upg.user_id
       WHERE upg.user_id = $1
         AND upg.tenant_id = u.tenant_id
         AND pg.tenant_id = u.tenant_id
         AND ($2::uuid IS NULL OR u.tenant_id = $2::uuid)
       ORDER BY pg.name`,
      [userId, tenantScopeId],
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
 * The authority policy decides both the role and the tenant: only superadmin
 * may choose a tenant, everyone else creates inside their own tenant.
 */
export async function createUser(input: CreateUserInput, actor: UserAuthorityActor) {
  const tenantId = assertCanCreateUser(actor, { role: input.role, tenantId: input.tenant_id ?? null });

  // ── Kiểm tra quota user cho tenant ──
  if (tenantId) {
    const { checkQuota } = await import('../tenants/tenants.service.js');
    await checkQuota(tenantId, 'users');
  }

  const normalizedEmail = normalizeEmail(input.email);
  await assertUsernameOrEmailAvailable(input.username, normalizedEmail);

  const passwordHash = await hashPassword(input.password);

  try {
    const result = await query(
      `INSERT INTO users (username, email, password_hash, full_name, phone, role, tenant_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, username, email, full_name, role, tenant_id`,
      [input.username, normalizedEmail, passwordHash, input.full_name || '', input.phone || '', input.role, tenantId],
    );

    return result.rows[0];
  } catch (err) {
    if (isPgUniqueViolation(err)) throwDuplicateUsernameOrEmail();
    throw err;
  }
}

/**
 * Cập nhật user — partial update.
 *
 * Authority (self, superadmin-only, role level, tenant, last active
 * superadmin) is decided by user-authority.logic on a snapshot of the target.
 * The UPDATE then applies only while the target still has the role and status
 * that decision saw, so a concurrent promotion cannot widen what was allowed.
 */
export async function updateUser(
  userId: string,
  input: UpdateUserInput,
  actor: UserAdminActor,
  tenantScopeId: string | null = null,
) {
  // The advisory locks below must live until commit; reuse the caller's
  // transaction (runAuditedTransaction) or own one.
  return withDatabaseTransaction(() => updateUserInTransaction(userId, input, actor, tenantScopeId));
}

type UserAuthoritySnapshot = { id: string; role: string; tenant_id: string | null; is_active: boolean };

async function loadUserAuthoritySnapshot(userId: string, tenantScopeId: string | null): Promise<UserAuthoritySnapshot> {
  const result = await query<UserAuthoritySnapshot>(
    `SELECT id, role, tenant_id, is_active
     FROM users
     WHERE id = $1
       AND deletion_requested_at IS NULL
       AND ($2::uuid IS NULL OR tenant_id = $2::uuid)`,
    [userId, tenantScopeId],
  );
  if (result.rowCount === 0) throw new AppError('User không tồn tại', 404);
  return result.rows[0];
}

function toAuthorityTarget(row: UserAuthoritySnapshot): UserAuthorityTarget {
  return { id: row.id, role: row.role, tenantId: row.tenant_id, isActive: row.is_active };
}

/**
 * Permission-group membership changes from the Users screen use the same
 * authority policy as account writes (no self change, manageable target).
 */
export async function assertCanAssignUserPermissionGroups(
  userId: string,
  actor: UserAuthorityActor,
  tenantScopeId: string | null,
): Promise<void> {
  const target = await loadUserAuthoritySnapshot(userId, tenantScopeId);
  assertCanAssignPermissionGroup(actor, toAuthorityTarget(target));
}

async function countActiveSuperadmins(): Promise<number> {
  const result = await query<{ count: number | string }>(ACTIVE_SUPERADMIN_COUNT_SQL);
  return Number(result.rows[0]?.count ?? 0);
}

async function updateUserInTransaction(
  userId: string,
  input: UpdateUserInput,
  actor: UserAdminActor,
  tenantScopeId: string | null,
) {
  await assertUserIsNotPendingDeletion(userId, tenantScopeId);

  const change: UserAuthorityChange = {
    role: input.role,
    isActive: input.is_active,
    password: Boolean(input.password),
  };
  let target = await loadUserAuthoritySnapshot(userId, tenantScopeId);
  let activeSuperadminCount: number | undefined;
  if (removesActiveSuperadmin(toAuthorityTarget(target), change)) {
    // Every write that can shrink the active superadmin set is serialized and
    // decides on state read after the lock (READ COMMITTED: new snapshot).
    await query(SUPERADMIN_SET_LOCK_SQL);
    target = await loadUserAuthoritySnapshot(userId, tenantScopeId);
    activeSuperadminCount = await countActiveSuperadmins();
  }
  assertCanUpdateUser(actor, toAuthorityTarget(target), change, activeSuperadminCount);

  await assertUserNotActiveDemoIframeAccount(userId, 'Tài khoản learner demo iframe đang được khóa, không thể cập nhật');

  // Role bookkeeping below only runs when the request carries a role.
  const oldRole: string | null = input.role !== undefined ? target.role : null;
  const userTenantId: string | null = input.role !== undefined ? target.tenant_id : null;

  // Permission-group writes acquire this lock before the user row. Take it
  // before UPDATE as well when a role change will remove group membership,
  // otherwise a simultaneous matrix save can deadlock on the same user.
  if (input.role !== undefined && oldRole && isLearnerRole(input.role) && !isLearnerRole(oldRole)) {
    await query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 20260911))`,
      [userId],
    );
  }

  const normalizedEmail = input.email !== undefined ? normalizeEmail(input.email) : undefined;
  await assertUsernameOrEmailAvailable(input.username, normalizedEmail, userId);

  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (input.username !== undefined) { sets.push(`username = $${idx++}`); params.push(input.username); }
  if (normalizedEmail !== undefined) { sets.push(`email = $${idx++}`); params.push(normalizedEmail); }
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

  params.push(userId, tenantScopeId, target.role, target.is_active);
  let result;
  try {
    result = await query(
      `UPDATE users SET ${sets.join(', ')}
       WHERE id = $${idx}
         AND ($${idx + 1}::uuid IS NULL OR tenant_id = $${idx + 1}::uuid)
         AND role = $${idx + 2}
         AND is_active = $${idx + 3}
         AND deletion_requested_at IS NULL
       RETURNING id, username, email, full_name, role, is_active`,
      params,
    );
  } catch (err) {
    if (isPgUniqueViolation(err)) throwDuplicateUsernameOrEmail();
    throw err;
  }

  // Role/status changed (or deletion started) after the authority decision.
  if (result.rowCount === 0) throw new UserAuthorityError('TARGET_CHANGED');

  // A staff member moving to a learner role must lose their group immediately.
  // The removal is recorded in the independent Permission Group history; a
  // tenant-less legacy row keeps the plain cleanup.
  if (isLearnerRole(input.role!) && oldRole && !isLearnerRole(oldRole)) {
    await query('DELETE FROM team_members WHERE user_id = $1', [userId]);
    if (userTenantId) {
      await replaceUserPermissionGroup(userId, null, userTenantId, { id: actor.id, username: actor.username, role: actor.role });
    } else {
      await query('DELETE FROM user_permission_groups WHERE user_id = $1', [userId]);
    }
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

  // A password reset, a deactivation or a role change ends every session:
  // refresh tokens are revoked (with revoked_at) and access tokens issued
  // before now are refused durably (Redis + auth_revocations), so a later
  // re-activation cannot revive them. The controller syncs the Redis cache
  // after COMMIT.
  const roleChanged = input.role !== undefined && oldRole !== null && input.role !== oldRole;
  const sessionEndReason = input.password
    ? 'password_reset_by_admin'
    : input.is_active === false
      ? 'account_deactivated'
      : roleChanged ? 'role_changed' : null;
  if (sessionEndReason) await recordUserSessionRevocation(userId, sessionEndReason);
  // In-process fast path kept for role changes (same instant semantics).
  if (roleChanged) blacklistUser(userId);

  return result.rows[0];
}

/** Whether an admin update ends the target's sessions (see updateUserInTransaction). */
export function adminUpdateEndsSessions(input: UpdateUserInput, previousRole: string | null | undefined): boolean {
  return Boolean(input.password) || input.is_active === false
    || (input.role !== undefined && previousRole !== undefined && previousRole !== null && input.role !== previousRole);
}

async function assertUserIsNotPendingDeletion(userId: string, tenantScopeId: string | null = null): Promise<void> {
  const result = await query<{ id: string }>(
    `SELECT id
     FROM users
     WHERE id = $1
       AND deletion_requested_at IS NULL
       AND ($2::uuid IS NULL OR tenant_id = $2::uuid)`,
    [userId, tenantScopeId],
  );
  if (result.rowCount === 0) {
    throw new AppError('User đang được xóa vĩnh viễn hoặc không tồn tại', 409);
  }
}

// ══════════════════════════════════════════════════════════════
// Profile Management — Self-service endpoints (user = caller)
// ══════════════════════════════════════════════════════════════

/**
 * Get the caller's OWN profile. Looked up by the authenticated user id, never
 * by a requested username: this returns email, phone, role and birth year.
 */
export async function getProfile(userId: string) {
  const profileResult = await query(
    `SELECT u.id, u.username, u.email, u.full_name, u.phone, u.avatar_url,
            u.role, u.is_active, u.tenant_id, u.created_at,
            u.bio, u.gender, u.country, u.language, u.level_of_education,
            u.year_of_birth, u.phone AS phone_number
     FROM users u
     WHERE u.id = $1`,
    [userId],
  );
  if (profileResult.rowCount === 0) throw new AppError('User không tồn tại', 404);
  return profileResult.rows[0];
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
  await assertUserIsNotPendingDeletion(userId);
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
  await assertUserIsNotPendingDeletion(userId);
  await assertUserNotActiveDemoIframeAccount(userId, 'Tài khoản learner demo iframe đang được khóa, không thể cập nhật avatar');
  const result = await query(
    `UPDATE users
     SET avatar_url = $1
     WHERE id = $2
       AND is_active = true
       AND deletion_requested_at IS NULL`,
    [avatarUrl, userId],
  );
  if (result.rowCount === 0) {
    throw new AppError('Tài khoản đang bị xóa hoặc không còn hoạt động', 409);
  }
}

/**
 * Change password — verify current password first.
 */
export async function changePassword(userId: string, currentPassword: string, newPassword: string) {
  await assertUserIsNotPendingDeletion(userId);
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
  // Ends every other session and returns a fresh one for this device.
  return replacePasswordAndEndSessions(userId, newHash);
}
