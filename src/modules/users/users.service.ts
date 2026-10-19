// ═══════════════════════════════════════════════════════════════
// Users Service — CRUD users (tenant-scoped)
// Tối ưu: parameterized queries, index trên tenant_id + role
// ═══════════════════════════════════════════════════════════════

import { query, withDatabaseTransaction } from '../../config/database.js';
import { invalidateUserBadgeCaches } from '../../config/cache-invalidation.js';
import { hashPassword } from '../../utils/password.js';
import { AppError } from '../../utils/errors.js';
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
  UserAuthorityError,
  assertCanAssignPermissionGroup,
  assertCanCreateUser,
  assertCanUpdateUser,
  removesActiveSuperadmin,
  type UserAuthorityActor,
  type UserAuthorityChange,
  type UserAuthorityTarget,
} from './user-authority.logic.js';
import {
  createUsersRepository,
  type AdminUserColumn,
  type ColumnValue,
  type ProfileColumn,
  type UserAuthoritySnapshotRow,
  type UsersDb,
} from './users.repository.js';

// query() joins the caller's current transaction (withDatabaseTransaction) when there is one.
const poolDb: UsersDb = { query };
const usersRepository = createUsersRepository(poolDb);

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
    if (await usersRepository.usernameTaken(username, excludeUserId)) throwDuplicateUsernameOrEmail();
  }

  if (normalizedEmail !== undefined) {
    if (await usersRepository.emailTaken(normalizedEmail, excludeUserId)) throwDuplicateUsernameOrEmail();
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

  const filter = {
    tenantId,
    search,
    roleFilter: queryParams.role as string,
    statusFilter: queryParams.is_active as string,
    permissionGroupId: queryParams.permission_group_id as string,
  };

  const includeTeamAssignments = queryParams.include_team_assignments === 'true' || queryParams.include_team_assignments === true;
  const currentTeamId = typeof queryParams.current_team_id === 'string' && queryParams.current_team_id.trim()
    ? queryParams.current_team_id.trim()
    : null;

  const [countRow, rows] = await Promise.all([
    usersRepository.countUsers(filter),
    usersRepository.selectUserPage(filter, pageSize, offset),
  ]);

  const total = parseInt(countRow.count, 10);
  const userIds = rows.map(row => row.id);
  const activeDemoIframeUserIds = await getActiveDemoIframeUserIds(userIds);
  const teamAssignmentsByUser = new Map<string, { team_assignments: unknown[]; is_current_team_member: boolean }>();

  if (includeTeamAssignments && userIds.length > 0) {
    const membershipRows = await usersRepository.selectTeamAssignments(userIds, tenantId, currentTeamId);

    for (const row of membershipRows) {
      teamAssignmentsByUser.set(row.user_id, {
        team_assignments: row.team_assignments || [],
        is_current_team_member: Boolean(row.is_current_team_member),
      });
    }
  }

  return {
    data: rows.map(row => {
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
  const [user, groups] = await Promise.all([
    usersRepository.selectUserDetail(userId, tenantScopeId),
    usersRepository.selectUserPermissionGroups(userId, tenantScopeId),
  ]);

  if (!user) throw new AppError('User không tồn tại', 404);

  const activeDemoIframeUserIds = await getActiveDemoIframeUserIds([userId]);

  return {
    ...user,
    is_demo_iframe_active: activeDemoIframeUserIds.has(userId),
    permission_groups: groups,
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
    return await usersRepository.insertUser({
      username: input.username,
      email: normalizedEmail,
      passwordHash,
      fullName: input.full_name || '',
      phone: input.phone || '',
      role: input.role,
      tenantId,
    });
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

type UserAuthoritySnapshot = UserAuthoritySnapshotRow;

async function loadUserAuthoritySnapshot(userId: string, tenantScopeId: string | null): Promise<UserAuthoritySnapshot> {
  const snapshot = await usersRepository.selectAuthoritySnapshot(userId, tenantScopeId);
  if (!snapshot) throw new AppError('User không tồn tại', 404);
  return snapshot;
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
  const row = await usersRepository.countActiveSuperadmins();
  return Number(row?.count ?? 0);
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
    await usersRepository.lockSuperadminSet();
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
    await usersRepository.lockUserPermissionGroups(userId);
  }

  const normalizedEmail = input.email !== undefined ? normalizeEmail(input.email) : undefined;
  await assertUsernameOrEmailAvailable(input.username, normalizedEmail, userId);

  const sets: ColumnValue<AdminUserColumn>[] = [];

  if (input.username !== undefined) sets.push(['username', input.username]);
  if (normalizedEmail !== undefined) sets.push(['email', normalizedEmail]);
  if (input.full_name !== undefined) sets.push(['full_name', input.full_name]);
  if (input.phone !== undefined) sets.push(['phone', input.phone]);
  if (input.avatar_url !== undefined) sets.push(['avatar_url', input.avatar_url]);
  if (input.role !== undefined) sets.push(['role', input.role]);
  if (input.is_active !== undefined) sets.push(['is_active', input.is_active]);

  // Password — hash trước khi lưu
  if (input.password) {
    const hash = await hashPassword(input.password);
    sets.push(['password_hash', hash]);
  }

  if (sets.length === 0) throw new AppError('Không có dữ liệu cần cập nhật', 400);

  // The user deletion fence trigger locks the row FOR KEY SHARE, which a plain
  // UPDATE does not wait for. A deactivation takes FOR UPDATE first, so a write
  // racing it (refresh token, progress) waits and is then rejected as inactive.
  if (input.is_active === false) {
    await usersRepository.lockUserRow(userId);
  }

  let updated;
  try {
    updated = await usersRepository.updateUserGuarded(sets, {
      userId,
      tenantScopeId,
      role: target.role,
      isActive: target.is_active,
    });
  } catch (err) {
    if (isPgUniqueViolation(err)) throwDuplicateUsernameOrEmail();
    throw err;
  }

  // Role/status changed (or deletion started) after the authority decision.
  if (!updated) throw new UserAuthorityError('TARGET_CHANGED');

  // A staff member moving to a learner role must lose their group immediately.
  // The removal is recorded in the independent Permission Group history; a
  // tenant-less legacy row keeps the plain cleanup.
  if (isLearnerRole(input.role!) && oldRole && !isLearnerRole(oldRole)) {
    await usersRepository.deleteTeamMemberships(userId);
    if (userTenantId) {
      await replaceUserPermissionGroup(userId, null, userTenantId, { id: actor.id, username: actor.username, role: actor.role });
    } else {
      await usersRepository.deleteUserPermissionGroups(userId);
    }
  } else if (oldRole && isLearnerRole(oldRole) && !isLearnerRole(input.role!)) {
    // From learner/learner_plus → staff/superuser: remove from teams
    await usersRepository.deleteTeamMemberships(userId);
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
  // Profile badges read phone and avatar_url (bumped after the commit).
  if (input.phone !== undefined || input.avatar_url !== undefined) await invalidateUserBadgeCaches([userId]);

  return updated;
}

/** Whether an admin update ends the target's sessions (see updateUserInTransaction). */
export function adminUpdateEndsSessions(input: UpdateUserInput, previousRole: string | null | undefined): boolean {
  return Boolean(input.password) || input.is_active === false
    || (input.role !== undefined && previousRole !== undefined && previousRole !== null && input.role !== previousRole);
}

async function assertUserIsNotPendingDeletion(userId: string, tenantScopeId: string | null = null): Promise<void> {
  if (!(await usersRepository.userNotPendingDeletion(userId, tenantScopeId))) {
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
  const profile = await usersRepository.selectProfile(userId);
  if (!profile) throw new AppError('User không tồn tại', 404);
  return profile;
}

/**
 * Update user's own profile (limited fields).
 */
export async function updateProfile(
  userId: string,
  input: {
    name?: string | null;
    bio?: string | null;
    gender?: string;
    country?: string | null;
    level_of_education?: string;
    language?: string | null;
    year_of_birth?: number | null;
    phone_number?: string | null;
  },
) {
  await assertUserIsNotPendingDeletion(userId);
  await assertUserNotActiveDemoIframeAccount(userId, 'Tài khoản learner demo iframe đang được khóa, không thể cập nhật hồ sơ');

  const sets: ColumnValue<ProfileColumn>[] = [];

  if (input.name !== undefined) sets.push(['full_name', input.name]);
  if (input.bio !== undefined) sets.push(['bio', input.bio]);
  if (input.gender !== undefined) {
    const validGenders = ['male', 'female', 'other', ''];
    if (!validGenders.includes(input.gender)) {
      throw new AppError(`Giới tính không hợp lệ: "${input.gender}". Chỉ chấp nhận: male, female, other`, 400);
    }
    if (input.gender === '') {
      sets.push(['gender', null]);
    } else {
      sets.push(['gender', input.gender]);
    }
  }
  if (input.country !== undefined) sets.push(['country', input.country]);
  if (input.level_of_education !== undefined) {
    const validEdu = ['primary', 'junior_high', 'high_school', 'associate', 'bachelor', 'master', 'doctorate', 'other', 'none', ''];
    if (!validEdu.includes(input.level_of_education)) {
      throw new AppError(`Trình độ học vấn không hợp lệ: "${input.level_of_education}"`, 400);
    }
    if (input.level_of_education === '') {
      sets.push(['level_of_education', null]);
    } else {
      sets.push(['level_of_education', input.level_of_education]);
    }
  }
  if (input.language !== undefined) sets.push(['language', input.language]);
  if (input.year_of_birth !== undefined) sets.push(['year_of_birth', input.year_of_birth]);
  if (input.phone_number !== undefined) sets.push(['phone', input.phone_number]);

  if (sets.length === 0) throw new AppError('Không có dữ liệu cần cập nhật', 400);

  const updated = await usersRepository.updateProfileColumns(userId, sets);
  if (!updated) throw new AppError('User không tồn tại', 404);
  // Profile badges read these fields.
  await invalidateUserBadgeCaches([userId]);
  return updated;
}

/**
 * Update avatar URL.
 */
export async function updateAvatar(userId: string, avatarUrl: string) {
  await assertUserIsNotPendingDeletion(userId);
  await assertUserNotActiveDemoIframeAccount(userId, 'Tài khoản learner demo iframe đang được khóa, không thể cập nhật avatar');
  if (!(await usersRepository.updateAvatarUrl(userId, avatarUrl))) {
    throw new AppError('Tài khoản đang bị xóa hoặc không còn hoạt động', 409);
  }
  // Profile badges read avatar_url.
  await invalidateUserBadgeCaches([userId]);
}

/**
 * Change password — verify current password first.
 */
export async function changePassword(userId: string, currentPassword: string, newPassword: string) {
  await assertUserIsNotPendingDeletion(userId);
  await assertUserNotActiveDemoIframeAccount(userId, 'Tài khoản learner demo iframe đang được khóa, không thể đổi mật khẩu');

  const { comparePassword } = await import('../../utils/password.js');

  const user = await usersRepository.selectPasswordHash(userId);
  if (!user) throw new AppError('User không tồn tại', 404);

  const isValid = await comparePassword(currentPassword, user.password_hash);
  if (!isValid) throw new AppError('Mật khẩu hiện tại không đúng', 400);

  const newHash = await hashPassword(newPassword);
  // Ends every other session and returns a fresh one for this device.
  return replacePasswordAndEndSessions(userId, newHash);
}
