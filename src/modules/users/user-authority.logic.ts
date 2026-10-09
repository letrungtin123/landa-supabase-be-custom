// ═══════════════════════════════════════════════════════════════
// User Authority — the single policy for administrative account writes
//
// Every admin path that creates a user, changes a role or the active status,
// resets a password, or deletes an account must decide through this module so
// the rules cannot drift between create, update, deactivate and delete:
//   1. Nobody changes the role or status of, resets the password of, or
//      deletes their OWN account through the admin endpoints (profile
//      endpoints stay the self-service path).
//   2. Only a superadmin creates, assigns, edits, deactivates or deletes a
//      superadmin account.
//   3. Everyone else manages accounts strictly BELOW their own level, inside
//      their own tenant, and assigns only roles strictly below their own level
//      (superuser → staff/learner_plus/learner, staff → learner_plus/learner,
//      learner_plus/learner → none).
//   4. The last active superadmin cannot be deactivated, demoted or deleted.
// This policy is applied IN ADDITION to the per-user permission matrix
// (checkPermission('account', ...) on the route): a permission group can allow
// an action, it can never widen which accounts or roles the action reaches.
// ═══════════════════════════════════════════════════════════════

import { AppError } from '../../middleware/error-handler.js';
import type { UserRole } from '../../types/index.js';

export const USER_ROLES: readonly UserRole[] = ['learner', 'learner_plus', 'staff', 'superuser', 'superadmin'];

export const USER_ROLE_LEVEL: Readonly<Record<UserRole, number>> = {
  learner: 0,
  learner_plus: 0,
  staff: 1,
  superuser: 2,
  superadmin: 3,
};

/** [HTTP status, Vietnamese, English] — the response picks by X-UI-Locale. */
export const USER_AUTHORITY_ERRORS = {
  SELF_ROLE_CHANGE: [403, 'Bạn không thể tự thay đổi vai trò của chính mình.', 'You cannot change the role of your own account.'],
  SELF_STATUS_CHANGE: [403, 'Bạn không thể tự khóa hoặc kích hoạt tài khoản của chính mình.', 'You cannot disable or activate your own account.'],
  SELF_PASSWORD_CHANGE: [403, 'Hãy đổi mật khẩu của bạn trong trang Hồ sơ cá nhân.', 'Change your own password from your profile page.'],
  SELF_DELETE: [403, 'Bạn không thể xóa tài khoản của chính mình.', 'You cannot delete your own account.'],
  SELF_PERMISSION_GROUP_CHANGE: [403, 'Bạn không thể tự thay đổi nhóm quyền của chính mình.', 'You cannot change your own permission group.'],
  SUPERADMIN_ONLY: [403, 'Chỉ Super Admin mới được quản lý tài khoản Super Admin.', 'Only a Super Admin can manage Super Admin accounts.'],
  ROLE_NOT_ASSIGNABLE: [403, 'Bạn không có quyền gán vai trò này.', 'You are not allowed to assign this role.'],
  TARGET_NOT_MANAGEABLE: [403, 'Bạn không có quyền quản lý tài khoản này.', 'You are not allowed to manage this account.'],
  CROSS_TENANT: [403, 'Bạn chỉ được quản lý tài khoản trong doanh nghiệp của mình.', 'You can only manage accounts in your own organization.'],
  TENANT_REQUIRED: [403, 'Không xác định được doanh nghiệp đang thao tác.', 'The active organization could not be determined.'],
  LAST_SUPERADMIN: [409, 'Không thể khóa, hạ quyền hoặc xóa Super Admin cuối cùng đang hoạt động.', 'The last active Super Admin cannot be disabled, demoted or deleted.'],
  TARGET_CHANGED: [409, 'Tài khoản vừa được người khác thay đổi. Vui lòng tải lại và thử lại.', 'This account was just changed by someone else. Reload and try again.'],
} as const satisfies Record<string, readonly [number, string, string]>;

export type UserAuthorityErrorCode = keyof typeof USER_AUTHORITY_ERRORS;

/** Public API code: `USER_AUTHORITY_<CODE>`; the dashboard maps it to t() keys. */
export const USER_AUTHORITY_CODE_PREFIX = 'USER_AUTHORITY_';

export class UserAuthorityError extends AppError {
  public readonly authorityCode: UserAuthorityErrorCode;
  public readonly messageEn: string;

  constructor(code: UserAuthorityErrorCode) {
    const [status, vi, en] = USER_AUTHORITY_ERRORS[code];
    super(vi, status, `${USER_AUTHORITY_CODE_PREFIX}${code}`);
    this.name = 'UserAuthorityError';
    this.authorityCode = code;
    this.messageEn = en;
  }

  localizedMessage(locale: 'vi' | 'en'): string {
    return locale === 'en' ? this.messageEn : this.message;
  }
}

export interface UserAuthorityActor {
  id: string;
  role: string;
  /** Tenant the request runs in (JWT tenant, or the selected tenant for superadmin). */
  tenantId: string | null;
}

export interface UserAuthorityTarget {
  id: string;
  role: string;
  tenantId: string | null;
  isActive: boolean;
}

export interface UserAuthorityChange {
  role?: string;
  isActive?: boolean;
  /** True when the request sets a new password. */
  password?: boolean;
}

function isKnownRole(role: string): role is UserRole {
  return Object.prototype.hasOwnProperty.call(USER_ROLE_LEVEL, role);
}

/** Unknown roles rank below every real role and therefore manage nothing. */
export function userRoleLevel(role: string): number {
  return isKnownRole(role) ? USER_ROLE_LEVEL[role] : -1;
}

function isSuperadmin(role: string): boolean {
  return role === 'superadmin';
}

/** Roles the actor may give to an account (create or role change). */
export function assignableUserRoles(actorRole: string): UserRole[] {
  if (isSuperadmin(actorRole)) return [...USER_ROLES];
  const level = userRoleLevel(actorRole);
  return USER_ROLES.filter((role) => role !== 'superadmin' && USER_ROLE_LEVEL[role] < level);
}

export function checkAssignRole(actor: Pick<UserAuthorityActor, 'role'>, role: string): UserAuthorityErrorCode | null {
  if (role === 'superadmin' && !isSuperadmin(actor.role)) return 'SUPERADMIN_ONLY';
  if (!isKnownRole(role) || !assignableUserRoles(actor.role).includes(role)) return 'ROLE_NOT_ASSIGNABLE';
  return null;
}

/** May the actor manage ANOTHER account at all (edit, status, password, delete)? */
export function checkManageTarget(actor: UserAuthorityActor, target: UserAuthorityTarget): UserAuthorityErrorCode | null {
  if (isSuperadmin(actor.role)) return null;
  if (!actor.tenantId) return 'TENANT_REQUIRED';
  if (target.tenantId !== actor.tenantId) return 'CROSS_TENANT';
  if (isSuperadmin(target.role)) return 'SUPERADMIN_ONLY';
  if (userRoleLevel(target.role) >= userRoleLevel(actor.role)) return 'TARGET_NOT_MANAGEABLE';
  return null;
}

/** Does this write remove an ACTIVE superadmin from the active superadmin set? */
export function removesActiveSuperadmin(target: UserAuthorityTarget, change: UserAuthorityChange | 'delete'): boolean {
  if (!isSuperadmin(target.role) || !target.isActive) return false;
  if (change === 'delete') return true;
  return (change.role !== undefined && change.role !== 'superadmin') || change.isActive === false;
}

/**
 * Create: the role must be assignable, and a non-superadmin always creates in
 * its own tenant. Returns the violation, or the tenant the user is created in.
 */
export function checkCreateUser(
  actor: UserAuthorityActor,
  input: { role: string; tenantId?: string | null },
): { error: UserAuthorityErrorCode } | { tenantId: string | null } {
  const roleError = checkAssignRole(actor, input.role);
  if (roleError) return { error: roleError };
  if (isSuperadmin(actor.role)) return { tenantId: input.tenantId || actor.tenantId };
  if (!actor.tenantId) return { error: 'TENANT_REQUIRED' };
  if (input.tenantId && input.tenantId !== actor.tenantId) return { error: 'CROSS_TENANT' };
  return { tenantId: actor.tenantId };
}

/**
 * Update / activate / deactivate. `activeSuperadminCount` is required only when
 * the write removes an active superadmin; when missing the check fails closed.
 */
export function checkUpdateUser(
  actor: UserAuthorityActor,
  target: UserAuthorityTarget,
  change: UserAuthorityChange,
  activeSuperadminCount?: number,
): UserAuthorityErrorCode | null {
  if (target.id === actor.id) {
    if (change.role !== undefined && change.role !== target.role) return 'SELF_ROLE_CHANGE';
    if (change.isActive !== undefined && change.isActive !== target.isActive) return 'SELF_STATUS_CHANGE';
    if (change.password) return 'SELF_PASSWORD_CHANGE';
    return null;
  }
  const manageError = checkManageTarget(actor, target);
  if (manageError) return manageError;
  if (change.role !== undefined && change.role !== target.role) {
    const roleError = checkAssignRole(actor, change.role);
    if (roleError) return roleError;
  }
  if (removesActiveSuperadmin(target, change) && !((activeSuperadminCount ?? 0) > 1)) return 'LAST_SUPERADMIN';
  return null;
}

export function checkDeleteUser(
  actor: UserAuthorityActor,
  target: UserAuthorityTarget,
  activeSuperadminCount?: number,
): UserAuthorityErrorCode | null {
  if (target.id === actor.id) return 'SELF_DELETE';
  const manageError = checkManageTarget(actor, target);
  if (manageError) return manageError;
  if (removesActiveSuperadmin(target, 'delete') && !((activeSuperadminCount ?? 0) > 1)) return 'LAST_SUPERADMIN';
  return null;
}

/**
 * Permission-group membership (PUT /api/users/:id/permission-groups). The
 * route admits only superuser/superadmin; a group can never lift a member
 * above the role policy because every account write re-checks it here.
 */
export function checkAssignPermissionGroup(actor: UserAuthorityActor, target: UserAuthorityTarget): UserAuthorityErrorCode | null {
  if (target.id === actor.id) return 'SELF_PERMISSION_GROUP_CHANGE';
  if (actor.role !== 'superuser' && !isSuperadmin(actor.role)) return 'TARGET_NOT_MANAGEABLE';
  return checkManageTarget(actor, target);
}

function raise(code: UserAuthorityErrorCode | null): void {
  if (code) throw new UserAuthorityError(code);
}

export function assertCanCreateUser(actor: UserAuthorityActor, input: { role: string; tenantId?: string | null }): string | null {
  const decision = checkCreateUser(actor, input);
  if ('error' in decision) throw new UserAuthorityError(decision.error);
  return decision.tenantId;
}

export function assertCanUpdateUser(
  actor: UserAuthorityActor,
  target: UserAuthorityTarget,
  change: UserAuthorityChange,
  activeSuperadminCount?: number,
): void {
  raise(checkUpdateUser(actor, target, change, activeSuperadminCount));
}

export function assertCanDeleteUser(actor: UserAuthorityActor, target: UserAuthorityTarget, activeSuperadminCount?: number): void {
  raise(checkDeleteUser(actor, target, activeSuperadminCount));
}

export function assertCanAssignPermissionGroup(actor: UserAuthorityActor, target: UserAuthorityTarget): void {
  raise(checkAssignPermissionGroup(actor, target));
}

/** Serializes every write that can shrink the active superadmin set. */
export const SUPERADMIN_SET_LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtextextended('landa:users:active-superadmins', 20261009))`;

export const ACTIVE_SUPERADMIN_COUNT_SQL = `SELECT COUNT(*)::int AS count
   FROM users
   WHERE role = 'superadmin'
     AND is_active = true
     AND deletion_requested_at IS NULL`;

export function requestUiLocale(header: string | undefined): 'vi' | 'en' {
  return header?.trim().toLowerCase() === 'en' ? 'en' : 'vi';
}
