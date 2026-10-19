// ═══════════════════════════════════════════════════════════════
// Users repository: the staff user list, user detail, create, the guarded
// admin update, the self-service profile and the locks of the user authority
// policy. SQL only; moved unchanged from users.service.ts, which keeps the
// rules (authority, quota, which fields may change, sessions, caches).
// ═══════════════════════════════════════════════════════════════

import type { QueryResult, QueryResultRow } from 'pg';
import { ACTIVE_SUPERADMIN_COUNT_SQL, SUPERADMIN_SET_LOCK_SQL } from './user-authority.logic.js';

/** The pool query() (joins the current transaction) or a transaction client. */
export interface UsersDb {
  query<T extends QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

/** The columns of a user the staff screens read. Timestamps are pg Dates. */
export interface UserDetailRow {
  id: string;
  username: string;
  email: string | null;
  full_name: string | null;
  phone: string | null;
  avatar_url: string | null;
  role: string;
  is_active: boolean;
  tenant_id: string | null;
  last_login_at: Date | null;
  created_at: Date;
  tenant_name: string | null;
}

export interface UserListRow extends UserDetailRow {
  permission_group_id: string | null;
  permission_group_name: string | null;
}

export interface UserPermissionGroupRow {
  id: string;
  name: string;
}

export interface UserTeamAssignmentsRow {
  user_id: string;
  team_assignments: unknown[] | null;
  is_current_team_member: boolean | null;
}

export interface CreatedUserRow {
  id: string;
  username: string;
  email: string | null;
  full_name: string | null;
  role: string;
  tenant_id: string | null;
}

export interface UpdatedUserRow {
  id: string;
  username: string;
  email: string | null;
  full_name: string | null;
  role: string;
  is_active: boolean;
}

export interface UserAuthoritySnapshotRow {
  id: string;
  role: string;
  tenant_id: string | null;
  is_active: boolean;
}

export interface UserProfileRow {
  id: string;
  username: string;
  email: string | null;
  full_name: string | null;
  phone: string | null;
  avatar_url: string | null;
  role: string;
  is_active: boolean;
  tenant_id: string | null;
  created_at: Date;
  bio: string | null;
  gender: string | null;
  country: string | null;
  language: string | null;
  level_of_education: string | null;
  year_of_birth: number | null;
  phone_number: string | null;
}

export type UpdatedProfileRow = Pick<CreatedUserRow, 'id' | 'username' | 'email' | 'full_name' | 'role'>;

export interface UserListFilter {
  tenantId: string | null;
  search: string | undefined;
  /** The role query value as sent (one role, a comma list, or 'all'). */
  roleFilter: string;
  /** The is_active query value as sent. */
  statusFilter: string;
  permissionGroupId: string;
}

export interface UserCreateValues {
  username: string;
  email: string;
  passwordHash: string;
  fullName: string;
  phone: string;
  role: string;
  tenantId: string | null;
}

/** Columns the admin update may write, in the order the service lists them. */
export type AdminUserColumn =
  | 'username'
  | 'email'
  | 'full_name'
  | 'phone'
  | 'avatar_url'
  | 'role'
  | 'is_active'
  | 'password_hash';

/** Columns the self-service profile update may write. */
export type ProfileColumn =
  | 'full_name'
  | 'bio'
  | 'gender'
  | 'country'
  | 'level_of_education'
  | 'language'
  | 'year_of_birth'
  | 'phone';

export type ColumnValue<C extends string> = [column: C, value: unknown];

/** The state the authority decision saw: the UPDATE applies only while it still holds. */
export interface AdminUpdateGuard {
  userId: string;
  tenantScopeId: string | null;
  role: string;
  isActive: boolean;
}

/** WHERE of the staff user list and its parameters. */
function userListWhere(filter: UserListFilter): { where: string; params: unknown[] } {
  const params: unknown[] = [];
  const conditions: string[] = ['u.deletion_requested_at IS NULL'];

  // Tenant scope (trừ superadmin)
  if (filter.tenantId) {
    params.push(filter.tenantId);
    conditions.push(`u.tenant_id = $${params.length}`);
  }

  // Search
  if (filter.search) {
    params.push(`%${filter.search}%`);
    conditions.push(`(u.username ILIKE $${params.length} OR u.email ILIKE $${params.length} OR u.full_name ILIKE $${params.length})`);
  }

  // Filter role (supports comma-separated: 'learner,learner_plus')
  const roleFilter = filter.roleFilter;
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
  const statusFilter = filter.statusFilter;
  if (statusFilter === 'true') {
    conditions.push('u.is_active = true');
  } else if (statusFilter === 'false') {
    conditions.push('u.is_active = false');
  }

  // Filter by permission group
  const permGroupFilter = filter.permissionGroupId;
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

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return { where, params };
}

/** `col = $n, ...` from the first parameter number, and the values in the same order. */
function setList<C extends string>(columns: ColumnValue<C>[]): { sets: string[]; params: unknown[] } {
  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;
  for (const [column, value] of columns) {
    sets.push(`${column} = $${idx++}`);
    params.push(value);
  }
  return { sets, params };
}

export function createUsersRepository(db: UsersDb) {
  return {
    /** Whether another user has this username (`excludeUserId` excluded). */
    async usernameTaken(username: string, excludeUserId?: string): Promise<boolean> {
      const params: unknown[] = [username];
      const excludeClause = excludeUserId ? ' AND id <> $2' : '';
      if (excludeUserId) params.push(excludeUserId);
      const existingUsername = await db.query<{ id: string }>(
        `SELECT id FROM users WHERE username = $1${excludeClause} LIMIT 1`,
        params,
      );
      return existingUsername.rowCount! > 0;
    },

    /** Whether another user has this email, compared trimmed and lower case (`excludeUserId` excluded). */
    async emailTaken(normalizedEmail: string, excludeUserId?: string): Promise<boolean> {
      const params: unknown[] = [normalizedEmail];
      const excludeClause = excludeUserId ? ' AND id <> $2' : '';
      if (excludeUserId) params.push(excludeUserId);
      const existingEmail = await db.query<{ id: string }>(
        `SELECT id
       FROM users
       WHERE btrim(email) <> ''
         AND lower(btrim(email)) = $1${excludeClause}
       LIMIT 1`,
        params,
      );
      return existingEmail.rowCount! > 0;
    },

    /** Number of users of the staff list filter, as text (COUNT(*) always answers one row). */
    async countUsers(filter: UserListFilter): Promise<{ count: string }> {
      const { where, params } = userListWhere(filter);
      const result = await db.query<{ count: string }>(`SELECT COUNT(*) AS count FROM users u ${where}`, params);
      return result.rows[0];
    },

    /** One page of the staff list, newest first, with tenant name and permission group. */
    async selectUserPage(filter: UserListFilter, pageSize: number, offset: number): Promise<UserListRow[]> {
      const { where, params } = userListWhere(filter);
      const result = await db.query<UserListRow>(
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
      );
      return result.rows;
    },

    /**
     * Team memberships of these users (org group > sub group > team), one row
     * per user; `tenantId` limits them to the tenant's org groups and
     * `currentTeamId` marks that team.
     */
    async selectTeamAssignments(
      userIds: string[],
      tenantId: string | null,
      currentTeamId: string | null,
    ): Promise<UserTeamAssignmentsRow[]> {
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

      const membershipResult = await db.query<UserTeamAssignmentsRow>(
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
      return membershipResult.rows;
    },

    /** The user (not being deleted) when it exists in the tenant scope (null = every tenant). */
    async selectUserDetail(userId: string, tenantScopeId: string | null): Promise<UserDetailRow | null> {
      const result = await db.query<UserDetailRow>(
        `SELECT u.id, u.username, u.email, u.full_name, u.phone, u.avatar_url,
              u.role, u.is_active, u.tenant_id, u.last_login_at, u.created_at,
              t.name AS tenant_name
       FROM users u
       LEFT JOIN tenants t ON t.id = u.tenant_id
       WHERE u.id = $1
         AND u.deletion_requested_at IS NULL
         AND ($2::uuid IS NULL OR u.tenant_id = $2::uuid)`,
        [userId, tenantScopeId],
      );
      return result.rowCount === 0 ? null : result.rows[0];
    },

    /** The user's permission groups of its own tenant, by name. */
    async selectUserPermissionGroups(userId: string, tenantScopeId: string | null): Promise<UserPermissionGroupRow[]> {
      const result = await db.query<UserPermissionGroupRow>(
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
      );
      return result.rows;
    },

    async insertUser(values: UserCreateValues): Promise<CreatedUserRow> {
      const result = await db.query<CreatedUserRow>(
        `INSERT INTO users (username, email, password_hash, full_name, phone, role, tenant_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, username, email, full_name, role, tenant_id`,
        [values.username, values.email, values.passwordHash, values.fullName, values.phone, values.role, values.tenantId],
      );
      return result.rows[0];
    },

    /** Role, tenant and status of a user not being deleted, in the tenant scope. */
    async selectAuthoritySnapshot(userId: string, tenantScopeId: string | null): Promise<UserAuthoritySnapshotRow | null> {
      const result = await db.query<UserAuthoritySnapshotRow>(
        `SELECT id, role, tenant_id, is_active
     FROM users
     WHERE id = $1
       AND deletion_requested_at IS NULL
       AND ($2::uuid IS NULL OR tenant_id = $2::uuid)`,
        [userId, tenantScopeId],
      );
      return result.rowCount === 0 ? null : result.rows[0];
    },

    /** Serializes every write that can shrink the active superadmin set (until commit). */
    async lockSuperadminSet(): Promise<void> {
      await db.query(SUPERADMIN_SET_LOCK_SQL);
    },

    async countActiveSuperadmins(): Promise<{ count: number | string } | undefined> {
      const result = await db.query<{ count: number | string }>(ACTIVE_SUPERADMIN_COUNT_SQL);
      return result.rows[0];
    },

    /** The lock permission-group writes take for this user (until commit). */
    async lockUserPermissionGroups(userId: string): Promise<void> {
      await db.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 20260911))`,
        [userId],
      );
    },

    /** Row lock of the user (FOR UPDATE), taken before a deactivation. */
    async lockUserRow(userId: string): Promise<void> {
      await db.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
    },

    /**
     * Writes `columns` while the user still has the role and status of
     * `guard` and is not being deleted; null when no row matched.
     */
    async updateUserGuarded(columns: ColumnValue<AdminUserColumn>[], guard: AdminUpdateGuard): Promise<UpdatedUserRow | null> {
      const { sets, params } = setList(columns);
      const idx = params.length + 1;
      params.push(guard.userId, guard.tenantScopeId, guard.role, guard.isActive);
      const result = await db.query<UpdatedUserRow>(
        `UPDATE users SET ${sets.join(', ')}
       WHERE id = $${idx}
         AND ($${idx + 1}::uuid IS NULL OR tenant_id = $${idx + 1}::uuid)
         AND role = $${idx + 2}
         AND is_active = $${idx + 3}
         AND deletion_requested_at IS NULL
       RETURNING id, username, email, full_name, role, is_active`,
        params,
      );
      return result.rowCount === 0 ? null : result.rows[0];
    },

    async deleteTeamMemberships(userId: string): Promise<void> {
      await db.query('DELETE FROM team_members WHERE user_id = $1', [userId]);
    },

    /** The plain group cleanup of a tenant-less legacy user. */
    async deleteUserPermissionGroups(userId: string): Promise<void> {
      await db.query('DELETE FROM user_permission_groups WHERE user_id = $1', [userId]);
    },

    /** Whether the user exists in the tenant scope and is not being deleted. */
    async userNotPendingDeletion(userId: string, tenantScopeId: string | null): Promise<boolean> {
      const result = await db.query<{ id: string }>(
        `SELECT id
     FROM users
     WHERE id = $1
       AND deletion_requested_at IS NULL
       AND ($2::uuid IS NULL OR tenant_id = $2::uuid)`,
        [userId, tenantScopeId],
      );
      return result.rowCount !== 0;
    },

    async selectProfile(userId: string): Promise<UserProfileRow | null> {
      const profileResult = await db.query<UserProfileRow>(
        `SELECT u.id, u.username, u.email, u.full_name, u.phone, u.avatar_url,
            u.role, u.is_active, u.tenant_id, u.created_at,
            u.bio, u.gender, u.country, u.language, u.level_of_education,
            u.year_of_birth, u.phone AS phone_number
     FROM users u
     WHERE u.id = $1`,
        [userId],
      );
      return profileResult.rowCount === 0 ? null : profileResult.rows[0];
    },

    /** Writes the profile `columns`; null when the user does not exist. */
    async updateProfileColumns(userId: string, columns: ColumnValue<ProfileColumn>[]): Promise<UpdatedProfileRow | null> {
      const { sets, params } = setList(columns);
      const idx = params.length + 1;
      params.push(userId);
      const result = await db.query<UpdatedProfileRow>(
        `UPDATE users SET ${sets.join(', ')} WHERE id = $${idx}
     RETURNING id, username, email, full_name, role`,
        params,
      );
      return result.rowCount === 0 ? null : result.rows[0];
    },

    /** Sets the avatar path of an active user not being deleted; false when no row matched. */
    async updateAvatarUrl(userId: string, avatarUrl: string): Promise<boolean> {
      const result = await db.query(
        `UPDATE users
     SET avatar_url = $1
     WHERE id = $2
       AND is_active = true
       AND deletion_requested_at IS NULL`,
        [avatarUrl, userId],
      );
      return result.rowCount !== 0;
    },

    async selectPasswordHash(userId: string): Promise<{ password_hash: string } | null> {
      const result = await db.query<{ password_hash: string }>(
        'SELECT password_hash FROM users WHERE id = $1',
        [userId],
      );
      return result.rowCount === 0 ? null : result.rows[0];
    },
  };
}

export type UsersRepository = ReturnType<typeof createUsersRepository>;
