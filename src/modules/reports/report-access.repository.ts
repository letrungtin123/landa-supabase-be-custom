// ═══════════════════════════════════════════════════════════════
// Report access repository: the org hierarchy lookups and memberships behind
// the report scope check (report-access.service.ts). SQL only; every lookup
// is bound to the tenant. Moved unchanged from report-access.service.ts.
// ═══════════════════════════════════════════════════════════════

import type { ReportsDb } from './reports.types.js';

export interface ReportTeamHierarchyRow {
  group_id: string;
  subgroup_id: string;
  team_id: string;
}

export interface ReportSubgroupHierarchyRow {
  group_id: string;
  subgroup_id: string;
}

export function createReportAccessRepository(db: ReportsDb) {
  return {
    /** The team with its subgroup and group, when its group belongs to the tenant. */
    async findTeamHierarchy(teamId: string, tenantId: string): Promise<ReportTeamHierarchyRow | undefined> {
      const result = await db.query<ReportTeamHierarchyRow>(
        `SELECT og.id AS group_id, sg.id AS subgroup_id, t.id AS team_id
       FROM teams t
       JOIN sub_groups sg ON sg.id = t.sub_group_id
       JOIN org_groups og ON og.id = sg.org_group_id
       WHERE t.id = $1 AND og.tenant_id = $2
       LIMIT 1`,
        [teamId, tenantId],
      );
      return result.rows[0];
    },

    /** The subgroup with its group, when its group belongs to the tenant. */
    async findSubgroupHierarchy(subgroupId: string, tenantId: string): Promise<ReportSubgroupHierarchyRow | undefined> {
      const result = await db.query<ReportSubgroupHierarchyRow>(
        `SELECT og.id AS group_id, sg.id AS subgroup_id
       FROM sub_groups sg
       JOIN org_groups og ON og.id = sg.org_group_id
       WHERE sg.id = $1 AND og.tenant_id = $2
       LIMIT 1`,
        [subgroupId, tenantId],
      );
      return result.rows[0];
    },

    async findGroup(groupId: string, tenantId: string): Promise<{ group_id: string } | undefined> {
      const result = await db.query<{ group_id: string }>(
        `SELECT id AS group_id FROM org_groups WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
        [groupId, tenantId],
      );
      return result.rows[0];
    },

    /** The groups of the user's own teams, in the tenant. */
    async listMemberGroupIds(userId: string, tenantId: string): Promise<string[]> {
      const result = await db.query<{ group_id: string }>(
        `SELECT DISTINCT og.id AS group_id
     FROM team_members tm
     JOIN teams t ON t.id = tm.team_id
     JOIN sub_groups sg ON sg.id = t.sub_group_id
     JOIN org_groups og ON og.id = sg.org_group_id
     WHERE tm.user_id = $1
       AND og.tenant_id = $2`,
        [userId, tenantId],
      );
      return result.rows.map(row => row.group_id);
    },

    /** Whether the learner (by username) belongs to a team of one of the groups, in the tenant. */
    async learnerBelongsToGroups(username: string, tenantId: string, groupIds: string[]): Promise<boolean> {
      const result = await db.query<{ visible: boolean }>(
        `SELECT EXISTS (
       SELECT 1
       FROM users u
       JOIN team_members tm ON tm.user_id = u.id
       JOIN teams t ON t.id = tm.team_id
       JOIN sub_groups sg ON sg.id = t.sub_group_id
       JOIN org_groups og ON og.id = sg.org_group_id
       WHERE u.username = $1
         AND u.tenant_id = $2::uuid
         AND og.tenant_id = $2::uuid
         AND og.id = ANY($3::uuid[])
     ) AS visible`,
        [username, tenantId, groupIds],
      );
      return result.rows[0]?.visible === true;
    },
  };
}

export type ReportAccessRepository = ReturnType<typeof createReportAccessRepository>;
