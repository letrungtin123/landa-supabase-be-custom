import { query } from '../../config/database.js';
import type { UserRole } from '../../types/index.js';
import { createReportAccessRepository } from './report-access.repository.js';
import { ReportRequestError } from './report-request-error.js';

// The scope check reads the main pool (it may run inside a request's transaction).
const repository = createReportAccessRepository({ query });

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

/** Codes of the ReportRequestErrors thrown here; the Reports page reads status/message only. */
export const REPORT_SCOPE_FORBIDDEN_CODE = 'REPORT_SCOPE_FORBIDDEN';
export const REPORT_SCOPE_REQUIRED_CODE = 'REPORT_SCOPE_REQUIRED';
export const REPORT_SCOPE_INVALID_CODE = 'REPORT_SCOPE_INVALID';

function scopeInvalid(message: string): ReportRequestError {
  return new ReportRequestError(message, 400, REPORT_SCOPE_INVALID_CODE);
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
    throw new ReportRequestError('Vui lòng chọn đơn vị cần xem báo cáo', 400, REPORT_SCOPE_REQUIRED_CODE);
  }
  const effectiveGroupId = hierarchy.groupId || requested.groupId || allowedGroupIds[0];
  if (!allowedGroupIds.includes(effectiveGroupId)) {
    throw new ReportRequestError('Bạn không có quyền xem báo cáo của nhóm này', 403, REPORT_SCOPE_FORBIDDEN_CODE);
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
    const row = await repository.findTeamHierarchy(requested.teamId, tenantId);
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
    const row = await repository.findSubgroupHierarchy(requested.subgroupId, tenantId);
    if (!row) throw scopeInvalid('Nhóm con không hợp lệ hoặc không thuộc doanh nghiệp hiện tại');
    if (requested.groupId && requested.groupId !== row.group_id) {
      throw scopeInvalid('Nhóm con không thuộc nhóm đã chọn');
    }
    return { groupId: row.group_id, subgroupId: row.subgroup_id };
  }

  if (requested.groupId) {
    const row = await repository.findGroup(requested.groupId, tenantId);
    if (!row) throw scopeInvalid('Nhóm không hợp lệ hoặc không thuộc doanh nghiệp hiện tại');
    return { groupId: row.group_id };
  }

  return {};
}

/** Groups a learner_plus actor may report on: the groups of their own teams, in their tenant. */
export async function loadReportAllowedGroupIds(actor: Pick<ReportScopeActor, 'userId' | 'tenantId'>): Promise<string[]> {
  return repository.listMemberGroupIds(actor.userId, actor.tenantId);
}

/**
 * Whether a report actor may see one learner's personal report data (detail,
 * badges, study time). Everyone except learner_plus sees any learner of the
 * tenant (as before); a learner_plus sees only learners who belong to a team
 * of one of their own groups. Unknown and out-of-scope learners look the same.
 */
export async function canReportOnLearner(actor: ReportScopeActor, username: string): Promise<boolean> {
  if (actor.role !== 'learner_plus') return true;
  const allowedGroupIds = await loadReportAllowedGroupIds(actor);
  if (allowedGroupIds.length === 0) return false;
  return repository.learnerBelongsToGroups(username, actor.tenantId, allowedGroupIds);
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
