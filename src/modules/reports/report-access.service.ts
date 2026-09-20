import { query } from '../../config/database.js';
import type { UserRole } from '../../types/index.js';

export interface ReportScopeActor {
  userId: string;
  tenantId: string;
  role: UserRole;
}

export interface RequestedReportScope {
  groupId?: string;
  subgroupId?: string;
  teamId?: string;
}

export interface ReportScope {
  groupId: string | undefined;
  subgroupId: string | undefined;
  teamId: string | undefined;
  /** null means unrestricted; [] means the learner_plus actor has no group. */
  allowedGroupIds: string[] | null;
}

export function resolveLearnerPlusReportScope(
  allowedGroupIds: string[],
  requested: RequestedReportScope,
  hierarchy: { groupId?: string; subgroupId?: string; teamId?: string },
): ReportScope {
  if (allowedGroupIds.length === 0) {
    return { groupId: undefined, subgroupId: undefined, teamId: undefined, allowedGroupIds: [] };
  }
  const effectiveGroupId = hierarchy.groupId || requested.groupId || allowedGroupIds[0];
  if (!allowedGroupIds.includes(effectiveGroupId)) {
    throw { status: 403, message: 'Bạn không có quyền xem báo cáo của nhóm này' };
  }
  return {
    groupId: effectiveGroupId,
    subgroupId: hierarchy.subgroupId,
    teamId: hierarchy.teamId,
    allowedGroupIds,
  };
}

export function readReportScopeId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed !== 'all' ? trimmed : undefined;
}

export async function resolveReportHierarchy(
  tenantId: string,
  requested: RequestedReportScope,
): Promise<{ groupId?: string; subgroupId?: string; teamId?: string }> {
  if (requested.teamId) {
    const result = await query<{ group_id: string; subgroup_id: string; team_id: string }>(
      `SELECT og.id AS group_id, sg.id AS subgroup_id, t.id AS team_id
       FROM teams t
       JOIN sub_groups sg ON sg.id = t.sub_group_id
       JOIN org_groups og ON og.id = sg.org_group_id
       WHERE t.id = $1 AND og.tenant_id = $2
       LIMIT 1`,
      [requested.teamId, tenantId],
    );
    const row = result.rows[0];
    if (!row) throw { status: 400, message: 'Team không hợp lệ hoặc không thuộc doanh nghiệp hiện tại' };
    if (requested.subgroupId && requested.subgroupId !== row.subgroup_id) {
      throw { status: 400, message: 'Team không thuộc nhóm con đã chọn' };
    }
    if (requested.groupId && requested.groupId !== row.group_id) {
      throw { status: 400, message: 'Team không thuộc nhóm đã chọn' };
    }
    return { groupId: row.group_id, subgroupId: row.subgroup_id, teamId: row.team_id };
  }

  if (requested.subgroupId) {
    const result = await query<{ group_id: string; subgroup_id: string }>(
      `SELECT og.id AS group_id, sg.id AS subgroup_id
       FROM sub_groups sg
       JOIN org_groups og ON og.id = sg.org_group_id
       WHERE sg.id = $1 AND og.tenant_id = $2
       LIMIT 1`,
      [requested.subgroupId, tenantId],
    );
    const row = result.rows[0];
    if (!row) throw { status: 400, message: 'Nhóm con không hợp lệ hoặc không thuộc doanh nghiệp hiện tại' };
    if (requested.groupId && requested.groupId !== row.group_id) {
      throw { status: 400, message: 'Nhóm con không thuộc nhóm đã chọn' };
    }
    return { groupId: row.group_id, subgroupId: row.subgroup_id };
  }

  if (requested.groupId) {
    const result = await query<{ group_id: string }>(
      `SELECT id AS group_id FROM org_groups WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
      [requested.groupId, tenantId],
    );
    const row = result.rows[0];
    if (!row) throw { status: 400, message: 'Nhóm không hợp lệ hoặc không thuộc doanh nghiệp hiện tại' };
    return { groupId: row.group_id };
  }

  return {};
}

/**
 * This preserves the existing Reports rule for learner_plus: they resolve to
 * one permitted group by default and every selected hierarchy remains inside
 * that group. It intentionally does not broaden their visible scope.
 */
export async function enforceReportScope(
  actor: ReportScopeActor,
  requested: RequestedReportScope,
): Promise<ReportScope> {
  if (actor.role !== 'learner_plus') {
    const hierarchy = await resolveReportHierarchy(actor.tenantId, requested);
    return {
      groupId: hierarchy.groupId,
      subgroupId: hierarchy.subgroupId,
      teamId: hierarchy.teamId,
      allowedGroupIds: null,
    };
  }

  const result = await query<{ group_id: string }>(
    `SELECT DISTINCT og.id AS group_id
     FROM team_members tm
     JOIN teams t ON t.id = tm.team_id
     JOIN sub_groups sg ON sg.id = t.sub_group_id
     JOIN org_groups og ON og.id = sg.org_group_id
     WHERE tm.user_id = $1`,
    [actor.userId],
  );
  const allowedGroupIds = result.rows.map((row) => row.group_id);
  if (allowedGroupIds.length === 0) {
    return resolveLearnerPlusReportScope(allowedGroupIds, requested, {});
  }
  const hierarchy = await resolveReportHierarchy(actor.tenantId, requested);
  return resolveLearnerPlusReportScope(allowedGroupIds, requested, hierarchy);
}
