// ═══════════════════════════════════════════════════════════════
// Groups repository: the org group → sub group → team hierarchy, its lists
// and details, and the member and category lists of a team. SQL only; moved
// unchanged from groups.service.ts, which keeps the rules (tenant checks and
// their messages, what a missing row means, pagination).
//
// Every lookup by id carries the tenant through org_groups (og.tenant_id),
// except selectTeamTenantId, which reads the tenant for the caller to compare.
// ═══════════════════════════════════════════════════════════════

import type { QueryResult, QueryResultRow } from 'pg';

/** The pool query() (joins the current transaction) or a transaction client. */
export interface GroupsDb {
  query<T extends QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

/** Rows of a list that also answers how many there are (`rowCount`). */
export interface CountedRows<T> {
  rows: T[];
  rowCount: number;
}

/** A whole row (`og.*`, `sg.*`, `t.*`) with the counts the statement adds: the columns the code reads, and every other column. */
export interface WholeRow {
  [column: string]: unknown;
}

export interface IdNameRow {
  id: string;
  name: string;
}

export interface SubGroupRow extends WholeRow {
  id: string;
  name: string;
  org_group_id: string;
  org_group_name: string;
}

export interface TeamDetailRow extends WholeRow {
  id: string;
  name: string;
  subgroup_name: string;
  org_group_id: string;
  org_group_name: string;
  member_count: number | null;
  course_count: number | null;
  category_count: number | null;
  course_category_count: number | null;
}

/** Timestamps are typed as the answer types them: pg's Date reaches the client as ISO text. */
export interface TeamMemberRow {
  id: string;
  username: string;
  email: string;
  full_name: string | null;
  avatar: string | null;
  added_at: string;
}

export interface TeamDocCategoryRow {
  category_id: string;
  name: string;
  assigned_at: string;
}

export interface TeamCourseCategoryRow extends TeamDocCategoryRow {
  slug: string;
}

export interface OrgGroupListFilter {
  tenantId: string | null;
  search: string | undefined;
}

export interface TeamListFilter {
  teamId: string;
  tenantId: string;
  search: string | undefined;
}

function orgGroupWhere(filter: OrgGroupListFilter): { where: string; params: unknown[] } {
  const params: unknown[] = [];
  const conditions: string[] = [];

  if (filter.tenantId) { params.push(filter.tenantId); conditions.push(`og.tenant_id = $${params.length}`); }
  if (filter.search) { params.push(`%${filter.search}%`); conditions.push(`og.name ILIKE $${params.length}`); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return { where, params };
}

/** WHERE of a team's list: team, tenant through org_groups, and the search condition built from `$n`. */
function teamListWhere(
  filter: TeamListFilter,
  teamColumn: string,
  searchCondition: (placeholder: string) => string,
): { where: string; params: unknown[] } {
  const params: unknown[] = [filter.teamId];
  const conditions = [`${teamColumn} = $1::uuid`];

  params.push(filter.tenantId);
  conditions.push(`og.tenant_id = $${params.length}::uuid`);
  if (filter.search) {
    params.push(`%${filter.search}%`);
    conditions.push(searchCondition(`$${params.length}`));
  }

  return { where: `WHERE ${conditions.join(' AND ')}`, params };
}

const TEAM_MEMBERS_FROM = `FROM team_members tm
    JOIN teams t ON t.id = tm.team_id
    JOIN sub_groups sg ON sg.id = t.sub_group_id
    JOIN org_groups og ON og.id = sg.org_group_id
    JOIN users u ON u.id = tm.user_id`;

const TEAM_DOC_CATEGORIES_FROM = `FROM team_doc_categories tdc
    JOIN teams t ON t.id = tdc.team_id
    JOIN sub_groups sg ON sg.id = t.sub_group_id
    JOIN org_groups og ON og.id = sg.org_group_id
    JOIN document_categories dc ON dc.id = tdc.category_id`;

const TEAM_COURSE_CATEGORIES_FROM = `FROM team_course_categories tcc
    JOIN teams t ON t.id = tcc.team_id
    JOIN sub_groups sg ON sg.id = t.sub_group_id
    JOIN org_groups og ON og.id = sg.org_group_id
    JOIN course_categories cc ON cc.id = tcc.category_id`;

const teamMembersWhere = (filter: TeamListFilter) =>
  teamListWhere(filter, 'tm.team_id', (p) => `(
      u.username ILIKE ${p}
      OR u.email ILIKE ${p}
      OR u.full_name ILIKE ${p}
    )`);
const teamDocCategoriesWhere = (filter: TeamListFilter) =>
  teamListWhere(filter, 'tdc.team_id', (p) => `unaccent(dc.name) ILIKE unaccent(${p})`);
const teamCourseCategoriesWhere = (filter: TeamListFilter) =>
  teamListWhere(filter, 'tcc.team_id', (p) => `unaccent(cc.name) ILIKE unaccent(${p})`);

const counted = <T extends QueryResultRow>(result: QueryResult<T>): CountedRows<T> => ({
  rows: result.rows,
  rowCount: result.rowCount || 0,
});

export function createGroupsRepository(db: GroupsDb) {
  return {
    /** The tenant of the team's org group; null for an unknown team. */
    async selectTeamTenantId(teamId: string): Promise<string | null> {
      const result = await db.query<{ tenant_id: string }>(
        `SELECT og.tenant_id
     FROM teams t
     JOIN sub_groups sg ON sg.id = t.sub_group_id
     JOIN org_groups og ON og.id = sg.org_group_id
     WHERE t.id = $1`,
        [teamId],
      );
      return result.rows[0]?.tenant_id ?? null;
    },

    // ── Org groups ──

    /** COUNT(*) of the org group list, as text (always one row). */
    async countOrgGroups(filter: OrgGroupListFilter): Promise<{ count: string }> {
      const { where, params } = orgGroupWhere(filter);
      const result = await db.query<{ count: string }>(`SELECT COUNT(*) AS count FROM org_groups og ${where}`, params);
      return result.rows[0];
    },

    async selectOrgGroupPage(filter: OrgGroupListFilter, pageSize: number, offset: number): Promise<WholeRow[]> {
      const { where, params } = orgGroupWhere(filter);
      const result = await db.query<WholeRow>(
        `SELECT og.*, (SELECT COUNT(*) FROM sub_groups sg WHERE sg.org_group_id = og.id) AS subgroup_count
       FROM org_groups og ${where}
       ORDER BY og.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, pageSize, offset],
      );
      return result.rows;
    },

    async insertOrgGroup(tenantId: string, name: string, description: string): Promise<IdNameRow> {
      const result = await db.query<IdNameRow>(
        'INSERT INTO org_groups (tenant_id, name, description) VALUES ($1, $2, $3) RETURNING id, name',
        [tenantId, name, description],
      );
      return result.rows[0];
    },

    async lockOrgGroupName(id: string, tenantId: string): Promise<{ name: string } | null> {
      const before = await db.query<{ name: string }>(
        'SELECT name FROM org_groups WHERE id = $1 AND tenant_id = $2::uuid FOR UPDATE',
        [id, tenantId],
      );
      return before.rowCount === 0 ? null : before.rows[0];
    },

    /** Sets the given fields (at least one); null when the group is not in the tenant. */
    async updateOrgGroupFields(id: string, tenantId: string, input: { name?: string; description?: string }): Promise<IdNameRow | null> {
      const sets: string[] = [];
      const params: unknown[] = [];
      let idx = 1;
      if (input.name !== undefined) { sets.push(`name = $${idx++}`); params.push(input.name); }
      if (input.description !== undefined) { sets.push(`description = $${idx++}`); params.push(input.description); }
      params.push(id, tenantId);
      const result = await db.query<IdNameRow>(
        `UPDATE org_groups SET ${sets.join(', ')} WHERE id = $${idx} AND tenant_id = $${idx + 1}::uuid RETURNING id, name`,
        params,
      );
      return result.rowCount === 0 ? null : result.rows[0];
    },

    async deleteOrgGroup(id: string, tenantId: string): Promise<IdNameRow | null> {
      const result = await db.query<IdNameRow>(
        'DELETE FROM org_groups WHERE id = $1 AND tenant_id = $2::uuid RETURNING id, name',
        [id, tenantId],
      );
      return result.rowCount === 0 ? null : result.rows[0];
    },

    // ── Sub groups ──

    /** The group's subgroups with their team count; empty for a group of another tenant. */
    async selectSubGroups(orgGroupId: string, tenantId: string, search: string): Promise<CountedRows<WholeRow>> {
      const params: unknown[] = [orgGroupId, tenantId];
      let searchWhere = '';
      if (search) { params.push(`%${search}%`); searchWhere = ` AND sg.name ILIKE $3`; }

      const result = await db.query<WholeRow>(
        `SELECT sg.*, (SELECT COUNT(*) FROM teams t WHERE t.sub_group_id = sg.id) AS team_count
     FROM sub_groups sg
     JOIN org_groups og ON og.id = sg.org_group_id
     WHERE sg.org_group_id = $1 AND og.tenant_id = $2::uuid${searchWhere}
     ORDER BY sg.name`,
        params,
      );
      return counted(result);
    },

    /** Inserts under the group only when the group is in the tenant; null otherwise. */
    async insertSubGroup(orgGroupId: string, tenantId: string, name: string): Promise<IdNameRow | null> {
      const result = await db.query<IdNameRow>(
        `INSERT INTO sub_groups (org_group_id, name)
     SELECT id, $3 FROM org_groups WHERE id = $1 AND tenant_id = $2::uuid
     RETURNING id, name`,
        [orgGroupId, tenantId, name],
      );
      return result.rowCount === 0 ? null : result.rows[0];
    },

    async selectSubGroup(sgId: string, tenantId: string): Promise<SubGroupRow | null> {
      const sgR = await db.query<SubGroupRow>(
        `SELECT sg.*, og.name AS org_group_name, og.id AS org_group_id
     FROM sub_groups sg JOIN org_groups og ON og.id = sg.org_group_id
     WHERE sg.id = $1 AND og.tenant_id = $2::uuid`,
        [sgId, tenantId],
      );
      return sgR.rowCount === 0 ? null : sgR.rows[0];
    },

    /** Teams of a subgroup already checked to be in the tenant, with their member count. */
    async selectSubGroupTeams(sgId: string): Promise<CountedRows<WholeRow>> {
      return counted(await db.query<WholeRow>('SELECT t.*, (SELECT COUNT(*) FROM team_members tm WHERE tm.team_id = t.id) AS member_count FROM teams t WHERE t.sub_group_id = $1 ORDER BY t.name', [sgId]));
    },

    async selectSubGroupMembers(sgId: string): Promise<CountedRows<Omit<TeamMemberRow, 'full_name'>>> {
      return counted(await db.query<Omit<TeamMemberRow, 'full_name'>>(
        `SELECT DISTINCT u.id, u.username, u.email, u.avatar_url AS avatar, tm.added_at
       FROM team_members tm JOIN teams t ON t.id = tm.team_id JOIN users u ON u.id = tm.user_id
       WHERE t.sub_group_id = $1 ORDER BY tm.added_at DESC`,
        [sgId],
      ));
    },

    async selectSubGroupCourses(sgId: string): Promise<CountedRows<{ course_id: string; display_name: string; assigned_at: string }>> {
      return counted(await db.query<{ course_id: string; display_name: string; assigned_at: string }>(
        `SELECT DISTINCT tc.course_id, c.display_name, tc.assigned_at
       FROM team_courses tc JOIN teams t ON t.id = tc.team_id JOIN courses c ON c.id = tc.course_id
       WHERE t.sub_group_id = $1`,
        [sgId],
      ));
    },

    async selectSubGroupDocCategories(sgId: string): Promise<CountedRows<TeamDocCategoryRow>> {
      return counted(await db.query<TeamDocCategoryRow>(
        `SELECT DISTINCT tdc.category_id, dc.name, tdc.assigned_at
       FROM team_doc_categories tdc JOIN teams t ON t.id = tdc.team_id JOIN document_categories dc ON dc.id = tdc.category_id
       WHERE t.sub_group_id = $1`,
        [sgId],
      ));
    },

    async selectSubGroupCourseCategories(sgId: string): Promise<CountedRows<TeamCourseCategoryRow>> {
      return counted(await db.query<TeamCourseCategoryRow>(
        `SELECT DISTINCT tcc.category_id, cc.name, cc.slug, tcc.assigned_at
       FROM team_course_categories tcc JOIN teams t ON t.id = tcc.team_id JOIN course_categories cc ON cc.id = tcc.category_id
       WHERE t.sub_group_id = $1`,
        [sgId],
      ));
    },

    async lockSubGroupName(id: string, tenantId: string): Promise<{ name: string } | null> {
      const before = await db.query<{ name: string }>(
        `SELECT sg.name
     FROM sub_groups sg JOIN org_groups og ON og.id = sg.org_group_id
     WHERE sg.id = $1 AND og.tenant_id = $2::uuid FOR UPDATE OF sg`,
        [id, tenantId],
      );
      return before.rowCount === 0 ? null : before.rows[0];
    },

    async updateSubGroupName(id: string, tenantId: string, name: string): Promise<IdNameRow | null> {
      const result = await db.query<IdNameRow>(
        `UPDATE sub_groups sg SET name = $1
     FROM org_groups og
     WHERE sg.id = $2 AND sg.org_group_id = og.id AND og.tenant_id = $3::uuid
     RETURNING sg.id, sg.name`,
        [name, id, tenantId],
      );
      return result.rowCount === 0 ? null : result.rows[0];
    },

    async deleteSubGroup(id: string, tenantId: string): Promise<IdNameRow | null> {
      const result = await db.query<IdNameRow>(
        `DELETE FROM sub_groups sg
     USING org_groups og
     WHERE sg.id = $1 AND sg.org_group_id = og.id AND og.tenant_id = $2::uuid
     RETURNING sg.id, sg.name`,
        [id, tenantId],
      );
      return result.rowCount === 0 ? null : result.rows[0];
    },

    // ── Teams ──

    async selectTeams(subgroupId: string, tenantId: string, search: string): Promise<CountedRows<WholeRow>> {
      const params: unknown[] = [subgroupId, tenantId];
      let searchWhere = '';
      if (search) { params.push(`%${search}%`); searchWhere = ` AND t.name ILIKE $3`; }

      const result = await db.query<WholeRow>(
        `SELECT t.*,
            (SELECT COUNT(*) FROM team_members tm WHERE tm.team_id = t.id) AS member_count,
            (SELECT COUNT(*) FROM team_courses tc WHERE tc.team_id = t.id) AS course_count,
            (SELECT COUNT(*) FROM team_course_categories tcc WHERE tcc.team_id = t.id) AS course_category_count
     FROM teams t
     JOIN sub_groups sg ON sg.id = t.sub_group_id
     JOIN org_groups og ON og.id = sg.org_group_id
     WHERE t.sub_group_id = $1 AND og.tenant_id = $2::uuid${searchWhere}
     ORDER BY t.name`,
        params,
      );
      return counted(result);
    },

    /** Inserts under the subgroup only when it is in the tenant; null otherwise. */
    async insertTeam(subgroupId: string, tenantId: string, name: string): Promise<IdNameRow | null> {
      const result = await db.query<IdNameRow>(
        `INSERT INTO teams (sub_group_id, name)
     SELECT sg.id, $3
     FROM sub_groups sg
     JOIN org_groups og ON og.id = sg.org_group_id
     WHERE sg.id = $1 AND og.tenant_id = $2::uuid
     RETURNING id, name`,
        [subgroupId, tenantId, name],
      );
      return result.rowCount === 0 ? null : result.rows[0];
    },

    async selectTeamDetail(teamId: string, tenantId: string): Promise<TeamDetailRow | null> {
      const teamR = await db.query<TeamDetailRow>(
        `SELECT t.*,
            sg.name AS subgroup_name,
            og.id AS org_group_id,
            og.name AS org_group_name,
            (SELECT COUNT(*)::int FROM team_members tm WHERE tm.team_id = t.id) AS member_count,
            (SELECT COUNT(*)::int FROM team_courses tc WHERE tc.team_id = t.id) AS course_count,
            (SELECT COUNT(*)::int FROM team_doc_categories tdc WHERE tdc.team_id = t.id) AS category_count,
            (SELECT COUNT(*)::int FROM team_course_categories tcc WHERE tcc.team_id = t.id) AS course_category_count
     FROM teams t
     JOIN sub_groups sg ON sg.id = t.sub_group_id
     JOIN org_groups og ON og.id = sg.org_group_id
     WHERE t.id = $1 AND og.tenant_id = $2::uuid`,
        [teamId, tenantId],
      );
      return teamR.rowCount === 0 ? null : teamR.rows[0];
    },

    /** Number of members of the team in the tenant matching the search; 0 without a count row. */
    async countTeamMembers(filter: TeamListFilter): Promise<number> {
      const { where, params } = teamMembersWhere(filter);
      const countR = await db.query<{ count: string }>(`SELECT COUNT(*) AS count ${TEAM_MEMBERS_FROM} ${where}`, params);
      return parseInt(countR.rows[0]?.count || '0', 10);
    },

    async selectTeamMemberPage(filter: TeamListFilter, pageSize: number, offset: number): Promise<TeamMemberRow[]> {
      const { where, params } = teamMembersWhere(filter);
      const dataR = await db.query<TeamMemberRow>(
        `SELECT u.id,
              u.username,
              u.email,
              u.full_name,
              u.avatar_url AS avatar,
              tm.added_at
       ${TEAM_MEMBERS_FROM}
       ${where}
       ORDER BY tm.added_at DESC, u.id
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, pageSize, offset],
      );
      return dataR.rows;
    },

    async countTeamDocCategories(filter: TeamListFilter): Promise<number> {
      const { where, params } = teamDocCategoriesWhere(filter);
      const countR = await db.query<{ count: string }>(`SELECT COUNT(*) AS count ${TEAM_DOC_CATEGORIES_FROM} ${where}`, params);
      return parseInt(countR.rows[0]?.count || '0', 10);
    },

    async selectTeamDocCategoryPage(filter: TeamListFilter, pageSize: number, offset: number): Promise<TeamDocCategoryRow[]> {
      const { where, params } = teamDocCategoriesWhere(filter);
      const dataR = await db.query<TeamDocCategoryRow>(
        `SELECT tdc.category_id,
              dc.name,
              tdc.assigned_at
       ${TEAM_DOC_CATEGORIES_FROM}
       ${where}
       ORDER BY tdc.assigned_at DESC, dc.name
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, pageSize, offset],
      );
      return dataR.rows;
    },

    async countTeamCourseCategories(filter: TeamListFilter): Promise<number> {
      const { where, params } = teamCourseCategoriesWhere(filter);
      const countR = await db.query<{ count: string }>(`SELECT COUNT(*) AS count ${TEAM_COURSE_CATEGORIES_FROM} ${where}`, params);
      return parseInt(countR.rows[0]?.count || '0', 10);
    },

    async selectTeamCourseCategoryPage(filter: TeamListFilter, pageSize: number, offset: number): Promise<TeamCourseCategoryRow[]> {
      const { where, params } = teamCourseCategoriesWhere(filter);
      const dataR = await db.query<TeamCourseCategoryRow>(
        `SELECT tcc.category_id,
              cc.name,
              cc.slug,
              tcc.assigned_at
       ${TEAM_COURSE_CATEGORIES_FROM}
       ${where}
       ORDER BY tcc.assigned_at DESC, cc.name
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, pageSize, offset],
      );
      return dataR.rows;
    },

    async lockTeamName(id: string, tenantId: string): Promise<{ name: string } | null> {
      const before = await db.query<{ name: string }>(
        `SELECT t.name
     FROM teams t
     JOIN sub_groups sg ON sg.id = t.sub_group_id
     JOIN org_groups og ON og.id = sg.org_group_id
     WHERE t.id = $1 AND og.tenant_id = $2::uuid FOR UPDATE OF t`,
        [id, tenantId],
      );
      return before.rowCount === 0 ? null : before.rows[0];
    },

    async updateTeamName(id: string, tenantId: string, name: string): Promise<IdNameRow | null> {
      const result = await db.query<IdNameRow>(
        `UPDATE teams t SET name = $1
     FROM sub_groups sg
     JOIN org_groups og ON og.id = sg.org_group_id
     WHERE t.id = $2 AND t.sub_group_id = sg.id AND og.tenant_id = $3::uuid
     RETURNING t.id, t.name`,
        [name, id, tenantId],
      );
      return result.rowCount === 0 ? null : result.rows[0];
    },

    async deleteTeam(id: string, tenantId: string): Promise<IdNameRow | null> {
      const result = await db.query<IdNameRow>(
        `DELETE FROM teams t
     USING sub_groups sg, org_groups og
     WHERE t.id = $1
       AND t.sub_group_id = sg.id
       AND sg.org_group_id = og.id
       AND og.tenant_id = $2::uuid
     RETURNING t.id, t.name`,
        [id, tenantId],
      );
      return result.rowCount === 0 ? null : result.rows[0];
    },
  };
}
