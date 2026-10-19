// ═══════════════════════════════════════════════════════════════
// Permission groups repository: groups, their module matrix and their
// members. SQL only, moved unchanged from permissions.service.ts, which keeps
// the rules (tenant fence, protected module, membership locking order,
// history entries, messages, transactions).
// ═══════════════════════════════════════════════════════════════

import type { QueryResult, QueryResultRow } from 'pg';

/** The pool query() (joins the current transaction) or a transaction client. */
export interface PermissionsDb {
  query<T extends QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface PermissionGroupRow {
  id: string;
  name: string;
  description: string | null;
}

export interface PermissionGroupDetailRow extends PermissionGroupRow {
  tenant_id: string;
  tenant_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface PermissionGroupListRow extends PermissionGroupDetailRow {
  member_count: string;
}

export interface MatrixSnapshotRow {
  module_code: string;
  module_name: string;
  module_icon: string | null;
  can_view: boolean;
  can_add: boolean;
  can_edit: boolean;
  can_delete: boolean;
}

export interface GroupPermissionRow {
  module_id: string;
  code: string;
  name: string;
  icon: string | null;
  sort_order: number;
  can_view: boolean;
  can_add: boolean;
  can_edit: boolean;
  can_delete: boolean;
}

export interface GroupMemberRow {
  id: string;
  username: string;
  email: string | null;
  full_name: string | null;
  avatar_url: string | null;
}

/** A user as a history entry records it (trimmed name, lower-case email). */
export interface MemberSnapshotRow {
  id: string;
  username: string;
  full_name: string | null;
  email: string | null;
  role: string | null;
}

export interface EligibleMemberRow extends MemberSnapshotRow {
  previous_group_id: string | null;
  previous_group_name: string | null;
}

export interface PermissionGroupListFilter {
  tenantId: string | null;
  search: string | undefined;
}

function listWhere(filter: PermissionGroupListFilter): { where: string; params: unknown[] } {
  const params: unknown[] = [];
  const conditions: string[] = [];
  if (filter.tenantId) {
    params.push(filter.tenantId);
    conditions.push(`pg.tenant_id = $${params.length}::uuid`);
  }
  if (filter.search) {
    params.push(`%${filter.search}%`);
    conditions.push(`(pg.name ILIKE $${params.length} OR pg.description ILIKE $${params.length})`);
  }
  return { where: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '', params };
}

export function createPermissionsRepository(db: PermissionsDb) {
  return {
    // ── Groups ──

    async lockGroup(groupId: string, tenantId: string): Promise<QueryResult<PermissionGroupRow>> {
      return db.query<PermissionGroupRow>(
        `SELECT id, name, description
         FROM permission_groups
         WHERE id = $1::uuid AND tenant_id = $2::uuid
         FOR UPDATE`,
        [groupId, tenantId],
      );
    },

    async countGroups(filter: PermissionGroupListFilter): Promise<string> {
      const { where, params } = listWhere(filter);
      const result = await db.query<{ count: string }>(`SELECT COUNT(*) AS count FROM permission_groups pg ${where}`, params);
      return result.rows[0].count;
    },

    async selectGroupPage(filter: PermissionGroupListFilter, pageSize: number, offset: number): Promise<PermissionGroupListRow[]> {
      const { where, params } = listWhere(filter);
      const result = await db.query<PermissionGroupListRow>(
        `SELECT pg.id, pg.name, pg.description, pg.tenant_id, pg.created_at, pg.updated_at,
                t.name AS tenant_name,
                (SELECT COUNT(*) FROM user_permission_groups upg WHERE upg.permission_group_id = pg.id AND upg.tenant_id = pg.tenant_id) AS member_count
         FROM permission_groups pg
         LEFT JOIN tenants t ON t.id = pg.tenant_id
         ${where}
         ORDER BY pg.created_at DESC, pg.id DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, pageSize, offset],
      );
      return result.rows;
    },

    async selectGroup(groupId: string, tenantId: string): Promise<QueryResult<PermissionGroupDetailRow>> {
      return db.query<PermissionGroupDetailRow>(
        `SELECT pg.id, pg.name, pg.description, pg.tenant_id, t.name AS tenant_name, pg.created_at, pg.updated_at
         FROM permission_groups pg
         LEFT JOIN tenants t ON t.id = pg.tenant_id
         WHERE pg.id = $1::uuid AND pg.tenant_id = $2::uuid`,
        [groupId, tenantId],
      );
    },

    /** Enabled modules of the tenant with the group's rights, without the protected module. */
    async selectGroupPermissions(groupId: string, tenantId: string, protectedModuleCode: string): Promise<GroupPermissionRow[]> {
      const result = await db.query<GroupPermissionRow>(
        `SELECT m.id AS module_id, m.code, m.name, m.icon, m.sort_order,
                COALESCE(pgm.can_view, false) AS can_view,
                COALESCE(pgm.can_add, false) AS can_add,
                COALESCE(pgm.can_edit, false) AS can_edit,
                COALESCE(pgm.can_delete, false) AS can_delete
         FROM modules m
         JOIN tenant_modules tm ON tm.module_id = m.id AND tm.tenant_id = $2::uuid AND tm.is_enabled = true
         LEFT JOIN permission_group_modules pgm ON pgm.module_id = m.id AND pgm.permission_group_id = $1::uuid AND pgm.tenant_id = $2::uuid
         WHERE m.is_active = true AND m.code <> $3
         ORDER BY m.sort_order ASC, m.code ASC`,
        [groupId, tenantId, protectedModuleCode],
      );
      return result.rows;
    },

    async selectGroupMembers(groupId: string, tenantId: string): Promise<GroupMemberRow[]> {
      const result = await db.query<GroupMemberRow>(
        `SELECT u.id, u.username, u.email, u.full_name, u.avatar_url
         FROM user_permission_groups upg
         JOIN users u ON u.id = upg.user_id
         WHERE upg.permission_group_id = $1::uuid AND upg.tenant_id = $2::uuid AND u.tenant_id = $2::uuid
         ORDER BY u.username ASC, u.id ASC`,
        [groupId, tenantId],
      );
      return result.rows;
    },

    async nameTaken(tenantId: string, name: string): Promise<number | null> {
      const result = await db.query<{ id: string }>('SELECT id FROM permission_groups WHERE tenant_id = $1::uuid AND name = $2', [tenantId, name]);
      return result.rowCount;
    },

    async nameTakenByOther(tenantId: string, name: string, groupId: string): Promise<number | null> {
      const result = await db.query<{ id: string }>(
        'SELECT id FROM permission_groups WHERE tenant_id = $1::uuid AND name = $2 AND id <> $3::uuid',
        [tenantId, name, groupId],
      );
      return result.rowCount;
    },

    async insertGroup(tenantId: string, name: string, description: string): Promise<PermissionGroupRow & { tenant_id: string }> {
      const result = await db.query<PermissionGroupRow & { tenant_id: string }>(
        `INSERT INTO permission_groups (tenant_id, name, description)
         VALUES ($1::uuid, $2, $3)
         RETURNING id, name, description, tenant_id`,
        [tenantId, name, description],
      );
      return result.rows[0];
    },

    async updateGroup(groupId: string, tenantId: string, name: string, description: string): Promise<PermissionGroupRow> {
      const result = await db.query<PermissionGroupRow>(
        `UPDATE permission_groups SET name = $1, description = $2
         WHERE id = $3::uuid AND tenant_id = $4::uuid
         RETURNING id, name, description`,
        [name, description, groupId, tenantId],
      );
      return result.rows[0];
    },

    async deleteGroup(groupId: string, tenantId: string): Promise<void> {
      await db.query('DELETE FROM permission_groups WHERE id = $1::uuid AND tenant_id = $2::uuid', [groupId, tenantId]);
    },

    // ── Matrix ──

    async selectMatrixSnapshot(groupId: string, tenantId: string, protectedModuleCode: string): Promise<MatrixSnapshotRow[]> {
      const result = await db.query<MatrixSnapshotRow>(
        `SELECT m.code AS module_code,
                m.name AS module_name,
                m.icon AS module_icon,
                COALESCE(pgm.can_view, false) AS can_view,
                COALESCE(pgm.can_add, false) AS can_add,
                COALESCE(pgm.can_edit, false) AS can_edit,
                COALESCE(pgm.can_delete, false) AS can_delete
         FROM modules m
         JOIN tenant_modules tm
           ON tm.module_id = m.id
          AND tm.tenant_id = $2::uuid
          AND tm.is_enabled = true
         LEFT JOIN permission_group_modules pgm
           ON pgm.permission_group_id = $1::uuid
          AND pgm.module_id = m.id
          AND pgm.tenant_id = $2::uuid
         WHERE m.is_active = true
           AND m.code <> $3
         ORDER BY m.sort_order ASC, m.code ASC`,
        [groupId, tenantId, protectedModuleCode],
      );
      return result.rows;
    },

    /** Codes of the tenant's enabled, active modules except the protected one. */
    async selectEditableModuleCodes(tenantId: string, protectedModuleCode: string): Promise<string[]> {
      const result = await db.query<{ code: string }>(
        `SELECT m.code
         FROM modules m
         JOIN tenant_modules tm ON tm.module_id = m.id
         WHERE tm.tenant_id = $1::uuid
           AND tm.is_enabled = true
           AND m.is_active = true
           AND m.code <> $2
         ORDER BY m.code ASC`,
        [tenantId, protectedModuleCode],
      );
      return result.rows.map((row) => row.code);
    },

    /** Upserts the group's rights from the matrix (JSON text of module_code + can_* rows). */
    async upsertMatrix(groupId: string, tenantId: string, permissionsJson: string): Promise<void> {
      await db.query(
        `INSERT INTO permission_group_modules (
           permission_group_id, module_id, tenant_id,
           can_view, can_add, can_edit, can_delete
         )
         SELECT $1::uuid, m.id, $2::uuid,
                p.can_view, p.can_add, p.can_edit, p.can_delete
         FROM jsonb_to_recordset($3::jsonb) AS p(
           module_code text,
           can_view boolean,
           can_add boolean,
           can_edit boolean,
           can_delete boolean
         )
         JOIN modules m ON m.code = p.module_code
         ON CONFLICT (permission_group_id, module_id) DO UPDATE
           SET can_view = EXCLUDED.can_view,
               can_add = EXCLUDED.can_add,
               can_edit = EXCLUDED.can_edit,
               can_delete = EXCLUDED.can_delete,
               tenant_id = EXCLUDED.tenant_id`,
        [groupId, tenantId, permissionsJson],
      );
    },

    // ── Members ──

    async selectMembersSnapshot(groupId: string, tenantId: string): Promise<MemberSnapshotRow[]> {
      const result = await db.query<MemberSnapshotRow>(
        `SELECT u.id, u.username,
                NULLIF(btrim(u.full_name), '') AS full_name,
                NULLIF(lower(btrim(u.email)), '') AS email,
                u.role
         FROM user_permission_groups upg
         JOIN users u ON u.id = upg.user_id
         WHERE upg.permission_group_id = $1::uuid
           AND upg.tenant_id = $2::uuid
           AND u.tenant_id = $2::uuid
         ORDER BY u.id ASC`,
        [groupId, tenantId],
      );
      return result.rows;
    },

    /** Transaction advisory locks on the users, in id order (`sortedUserIds` already sorted). */
    async lockMembershipUsers(sortedUserIds: string[]): Promise<void> {
      await db.query(
        `SELECT pg_advisory_xact_lock(hashtextextended(user_id::text, 20260911))
         FROM (
           SELECT user_id
           FROM unnest($1::uuid[]) AS u(user_id)
           ORDER BY user_id
         ) ordered_users`,
        [sortedUserIds],
      );
    },

    /** Members of the group among `userIds`, locked. */
    async lockGroupMembers(groupId: string, tenantId: string, userIds: string[]): Promise<QueryResult<MemberSnapshotRow>> {
      return db.query<MemberSnapshotRow>(
        `SELECT u.id, u.username,
                NULLIF(btrim(u.full_name), '') AS full_name,
                NULLIF(lower(btrim(u.email)), '') AS email,
                u.role
         FROM user_permission_groups upg
         JOIN users u ON u.id = upg.user_id
         WHERE upg.permission_group_id = $1::uuid
           AND upg.tenant_id = $2::uuid
           AND u.tenant_id = $2::uuid
           AND u.id = ANY($3::uuid[])
         ORDER BY u.id ASC
         FOR UPDATE`,
        [groupId, tenantId, userIds],
      );
    },

    async deleteGroupMembers(groupId: string, tenantId: string, userIds: string[]): Promise<void> {
      await db.query(
        `DELETE FROM user_permission_groups upg
         USING permission_groups pg
         WHERE upg.permission_group_id = pg.id
           AND upg.permission_group_id = $1::uuid
           AND upg.tenant_id = $2::uuid
           AND pg.tenant_id = $2::uuid
           AND upg.user_id = ANY($3::uuid[])`,
        [groupId, tenantId, userIds],
      );
    },

    /** Staff and learner_plus users of the tenant among `userIds`, locked, with their current group. */
    async lockEligibleUsers(userIds: string[], tenantId: string): Promise<QueryResult<EligibleMemberRow>> {
      return db.query<EligibleMemberRow>(
        `SELECT u.id, u.username,
                NULLIF(btrim(u.full_name), '') AS full_name,
                NULLIF(lower(btrim(u.email)), '') AS email,
                u.role,
                current_group.permission_group_id AS previous_group_id,
                current_group.name AS previous_group_name
         FROM users u
         LEFT JOIN LATERAL (
           SELECT upg.permission_group_id, pg.name
           FROM user_permission_groups upg
           JOIN permission_groups pg ON pg.id = upg.permission_group_id
           WHERE upg.user_id = u.id
             AND upg.tenant_id = $2::uuid
             AND pg.tenant_id = $2::uuid
           ORDER BY upg.created_at DESC, upg.id DESC
           LIMIT 1
         ) current_group ON true
         WHERE u.id = ANY($1::uuid[])
           AND u.tenant_id = $2::uuid
           AND u.role IN ('staff', 'learner_plus')
         ORDER BY u.id ASC
         FOR UPDATE OF u`,
        [userIds, tenantId],
      );
    },

    /** Removes the users from every group of the tenant. */
    async deleteMemberships(userIds: string[], tenantId: string): Promise<void> {
      await db.query(
        `DELETE FROM user_permission_groups upg
         USING permission_groups pg
         WHERE upg.permission_group_id = pg.id
           AND upg.tenant_id = $2::uuid
           AND pg.tenant_id = $2::uuid
           AND upg.user_id = ANY($1::uuid[])`,
        [userIds, tenantId],
      );
    },

    async insertMemberships(userIds: string[], groupId: string, tenantId: string): Promise<void> {
      await db.query(
        `INSERT INTO user_permission_groups (user_id, permission_group_id, tenant_id)
         SELECT user_id, $2::uuid, $3::uuid
         FROM unnest($1::uuid[]) AS user_id`,
        [userIds, groupId, tenantId],
      );
    },

    /** The user (not being deleted) of the tenant, locked. */
    async lockTenantUser(userId: string, tenantId: string): Promise<QueryResult<MemberSnapshotRow>> {
      return db.query<MemberSnapshotRow>(
        `SELECT id, username,
                NULLIF(btrim(full_name), '') AS full_name,
                NULLIF(lower(btrim(email)), '') AS email,
                role
         FROM users
         WHERE id = $1::uuid
           AND tenant_id = $2::uuid
           AND deletion_requested_at IS NULL
         FOR UPDATE`,
        [userId, tenantId],
      );
    },

    /** The user's current group rows in the tenant, newest first, locked. */
    async lockCurrentGroups(userId: string, tenantId: string): Promise<QueryResult<PermissionGroupRow>> {
      return db.query<PermissionGroupRow>(
        `SELECT pg.id, pg.name, pg.description
         FROM user_permission_groups upg
         JOIN permission_groups pg ON pg.id = upg.permission_group_id
         WHERE upg.user_id = $1::uuid
           AND upg.tenant_id = $2::uuid
           AND pg.tenant_id = $2::uuid
         ORDER BY upg.created_at DESC, upg.id DESC
         FOR UPDATE`,
        [userId, tenantId],
      );
    },

    async deleteMembership(userId: string, groupId: string, tenantId: string): Promise<void> {
      await db.query(
        `DELETE FROM user_permission_groups
         WHERE user_id = $1::uuid
           AND permission_group_id = $2::uuid
           AND tenant_id = $3::uuid`,
        [userId, groupId, tenantId],
      );
    },

    async insertMembership(userId: string, groupId: string, tenantId: string): Promise<void> {
      await db.query(
        `INSERT INTO user_permission_groups (user_id, permission_group_id, tenant_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid)`,
        [userId, groupId, tenantId],
      );
    },
  };
}

export type PermissionsRepository = ReturnType<typeof createPermissionsRepository>;
