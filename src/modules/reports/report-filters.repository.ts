// ═══════════════════════════════════════════════════════════════
// Report filters repository: the org units offered by the report filters
// (companies, branches, departments) and the course lookup of the course
// export. SQL only; moved unchanged from reports.controller.ts.
// ═══════════════════════════════════════════════════════════════

import type { ReportsDb } from './reports.types.js';

export interface ReportOrgGroupRow {
  id: string;
  name: string;
  subgroup_count: number;
}

export interface ReportSubGroupRow {
  id: string;
  name: string;
  team_count: number;
}

export interface ReportTeamRow {
  id: string;
  name: string;
  member_count: number;
}

export function createReportFiltersRepository(db: ReportsDb) {
  return {
    /** The course of the tenant (not deleted), for the course learner export. */
    async findCourse(courseId: string, tenantId: string): Promise<{ display_name: string } | undefined> {
      const course = await db.query<{ display_name: string }>(
        `SELECT display_name
     FROM courses
     WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
     LIMIT 1`,
        [courseId, tenantId],
      );
      return course.rows[0];
    },

    /** The groups of the teams the user belongs to. */
    async listGroupsOfMember(userId: string): Promise<ReportOrgGroupRow[]> {
      const result = await db.query<ReportOrgGroupRow>(
        `SELECT DISTINCT og.id, og.name,
              (SELECT COUNT(*)::int FROM sub_groups sg2 WHERE sg2.org_group_id = og.id) AS subgroup_count
       FROM team_members tm
       JOIN teams t ON t.id = tm.team_id
       JOIN sub_groups sg ON sg.id = t.sub_group_id
       JOIN org_groups og ON og.id = sg.org_group_id
       WHERE tm.user_id = $1
       ORDER BY og.name`,
        [userId],
      );
      return result.rows;
    },

    async listTenantGroups(tenantId: string): Promise<ReportOrgGroupRow[]> {
      const result = await db.query<ReportOrgGroupRow>(
        `SELECT og.id, og.name,
            (SELECT COUNT(*)::int FROM sub_groups sg WHERE sg.org_group_id = og.id) AS subgroup_count
     FROM org_groups og
     WHERE og.tenant_id = $1
     ORDER BY og.name`,
        [tenantId],
      );
      return result.rows;
    },

    async groupBelongsToTenant(groupId: string, tenantId: string): Promise<boolean> {
      const groupCheck = await db.query<{ id: string }>(
        `SELECT id
     FROM org_groups
     WHERE id = $1 AND tenant_id = $2
     LIMIT 1`,
        [groupId, tenantId],
      );
      return groupCheck.rows.length > 0;
    },

    /** Whether the user belongs to a team of the group. */
    async memberBelongsToGroup(userId: string, groupId: string): Promise<boolean> {
      const check = await db.query<{ group_id: string }>(
        `SELECT DISTINCT og.id AS group_id
       FROM team_members tm
       JOIN teams t ON t.id = tm.team_id
       JOIN sub_groups sg ON sg.id = t.sub_group_id
       JOIN org_groups og ON og.id = sg.org_group_id
       WHERE tm.user_id = $1 AND og.id = $2`,
        [userId, groupId],
      );
      return check.rows.length > 0;
    },

    async listSubGroups(groupId: string): Promise<ReportSubGroupRow[]> {
      const result = await db.query<ReportSubGroupRow>(
        `SELECT sg.id, sg.name,
            (SELECT COUNT(*)::int FROM teams t WHERE t.sub_group_id = sg.id) AS team_count
     FROM sub_groups sg
     WHERE sg.org_group_id = $1
     ORDER BY sg.name`,
        [groupId],
      );
      return result.rows;
    },

    async subgroupBelongsToGroupOfTenant(subgroupId: string, groupId: string, tenantId: string): Promise<boolean> {
      const subgroupCheck = await db.query<{ subgroup_id: string }>(
        `SELECT sg.id AS subgroup_id
     FROM sub_groups sg
     JOIN org_groups og ON og.id = sg.org_group_id
     WHERE sg.id = $1 AND og.id = $2 AND og.tenant_id = $3
     LIMIT 1`,
        [subgroupId, groupId, tenantId],
      );
      return subgroupCheck.rows.length > 0;
    },

    async listTeams(subgroupId: string): Promise<ReportTeamRow[]> {
      const result = await db.query<ReportTeamRow>(
        `SELECT t.id, t.name,
            (SELECT COUNT(*)::int FROM team_members tm WHERE tm.team_id = t.id) AS member_count
     FROM teams t
     WHERE t.sub_group_id = $1
     ORDER BY t.name`,
        [subgroupId],
      );
      return result.rows;
    },
  };
}

export type ReportFiltersRepository = ReturnType<typeof createReportFiltersRepository>;
