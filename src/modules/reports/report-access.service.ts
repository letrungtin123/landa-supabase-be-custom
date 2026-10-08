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

export interface ReportScopeOptions {
  /**
   * Chat reports must not silently pick "the first allowed group" for a
   * learner_plus who belongs to several groups; they ask the user instead.
   * The Reports page keeps its existing default.
   */
  requireExplicitLearnerPlusScope?: boolean;
}

/** Codes on the thrown `{ status, message, code }` objects; the Reports page reads status/message only. */
export const REPORT_SCOPE_FORBIDDEN_CODE = 'REPORT_SCOPE_FORBIDDEN';
export const REPORT_SCOPE_REQUIRED_CODE = 'REPORT_SCOPE_REQUIRED';
export const REPORT_SCOPE_INVALID_CODE = 'REPORT_SCOPE_INVALID';

function scopeInvalid(message: string): { status: number; message: string; code: string } {
  return { status: 400, message, code: REPORT_SCOPE_INVALID_CODE };
}

/**
 * A learner_plus actor without any group resolves to a scope whose ids are all
 * undefined, which reads like "tenant-wide". Every consumer must treat it as
 * "nothing is visible" (empty data or a denial), never as unrestricted.
 */
export function hasNoAccessibleReportScope(scope: Pick<ReportScope, 'allowedGroupIds'>): boolean {
  return scope.allowedGroupIds !== null && scope.allowedGroupIds.length === 0;
}

export function resolveLearnerPlusReportScope(
  allowedGroupIds: string[],
  requested: RequestedReportScope,
  hierarchy: { groupId?: string; subgroupId?: string; teamId?: string },
  options: ReportScopeOptions = {},
): ReportScope {
  if (allowedGroupIds.length === 0) {
    return { groupId: undefined, subgroupId: undefined, teamId: undefined, allowedGroupIds: [] };
  }
  const requestedAny = Boolean(hierarchy.groupId || requested.groupId || requested.subgroupId || requested.teamId);
  if (!requestedAny && options.requireExplicitLearnerPlusScope && allowedGroupIds.length > 1) {
    throw { status: 400, message: 'Vui lòng chọn đơn vị cần xem báo cáo', code: REPORT_SCOPE_REQUIRED_CODE };
  }
  const effectiveGroupId = hierarchy.groupId || requested.groupId || allowedGroupIds[0];
  if (!allowedGroupIds.includes(effectiveGroupId)) {
    throw { status: 403, message: 'Bạn không có quyền xem báo cáo của nhóm này', code: REPORT_SCOPE_FORBIDDEN_CODE };
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
    if (!row) throw scopeInvalid('Team không hợp lệ hoặc không thuộc doanh nghiệp hiện tại');
    if (requested.subgroupId && requested.subgroupId !== row.subgroup_id) {
      throw scopeInvalid('Team không thuộc nhóm con đã chọn');
    }
    if (requested.groupId && requested.groupId !== row.group_id) {
      throw scopeInvalid('Team không thuộc nhóm đã chọn');
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
    if (!row) throw scopeInvalid('Nhóm con không hợp lệ hoặc không thuộc doanh nghiệp hiện tại');
    if (requested.groupId && requested.groupId !== row.group_id) {
      throw scopeInvalid('Nhóm con không thuộc nhóm đã chọn');
    }
    return { groupId: row.group_id, subgroupId: row.subgroup_id };
  }

  if (requested.groupId) {
    const result = await query<{ group_id: string }>(
      `SELECT id AS group_id FROM org_groups WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
      [requested.groupId, tenantId],
    );
    const row = result.rows[0];
    if (!row) throw scopeInvalid('Nhóm không hợp lệ hoặc không thuộc doanh nghiệp hiện tại');
    return { groupId: row.group_id };
  }

  return {};
}

/** Groups a learner_plus actor may report on: the groups of their own teams, in their tenant. */
export async function loadReportAllowedGroupIds(actor: Pick<ReportScopeActor, 'userId' | 'tenantId'>): Promise<string[]> {
  const result = await query<{ group_id: string }>(
    `SELECT DISTINCT og.id AS group_id
     FROM team_members tm
     JOIN teams t ON t.id = tm.team_id
     JOIN sub_groups sg ON sg.id = t.sub_group_id
     JOIN org_groups og ON og.id = sg.org_group_id
     WHERE tm.user_id = $1
       AND og.tenant_id = $2`,
    [actor.userId, actor.tenantId],
  );
  return result.rows.map((row) => row.group_id);
}

/**
 * This preserves the existing Reports rule for learner_plus: they resolve to
 * one permitted group by default and every selected hierarchy remains inside
 * that group. It intentionally does not broaden their visible scope.
 */
export async function enforceReportScope(
  actor: ReportScopeActor,
  requested: RequestedReportScope,
  options: ReportScopeOptions = {},
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

  const allowedGroupIds = await loadReportAllowedGroupIds(actor);
  if (allowedGroupIds.length === 0) {
    return resolveLearnerPlusReportScope(allowedGroupIds, requested, {}, options);
  }
  const hierarchy = await resolveReportHierarchy(actor.tenantId, requested);
  return resolveLearnerPlusReportScope(allowedGroupIds, requested, hierarchy, options);
}
