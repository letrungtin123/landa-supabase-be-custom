// ═══════════════════════════════════════════════════════════════
// Report filters: the org units a report actor may pick, and the course of a
// course learner export. Uses the report_summary permission, not the groups
// module. learner_plus sees only the groups of their own teams.
// ═══════════════════════════════════════════════════════════════

import { query } from '../../config/database.js';
import type { UserRole } from '../../types/index.js';
import {
  createReportFiltersRepository,
  type ReportOrgGroupRow,
  type ReportSubGroupRow,
  type ReportTeamRow,
} from './report-filters.repository.js';

const repository = createReportFiltersRepository({ query });

export interface ReportFilterActor {
  userId: string;
  tenantId: string;
  role: UserRole;
}

/** Why a filter list is refused; the controller maps each one to its answer. */
export type ReportFilterRefusal = 'group_not_in_tenant' | 'group_not_allowed' | 'subgroup_not_in_group';

export type ReportFilterList<K extends string, T> =
  | ({ refusal: null } & Record<K, T[]>)
  | { refusal: ReportFilterRefusal };

export function findReportCourse(tenantId: string, courseId: string): Promise<{ display_name: string } | undefined> {
  return repository.findCourse(courseId, tenantId);
}

/** Staff and above: every group of the tenant. learner_plus: the groups of their teams. */
export function listReportGroups(actor: ReportFilterActor): Promise<ReportOrgGroupRow[]> {
  return actor.role === 'learner_plus'
    ? repository.listGroupsOfMember(actor.userId)
    : repository.listTenantGroups(actor.tenantId);
}

export async function listReportSubGroups(
  actor: ReportFilterActor,
  groupId: string,
): Promise<ReportFilterList<'subgroups', ReportSubGroupRow>> {
  if (!(await repository.groupBelongsToTenant(groupId, actor.tenantId))) return { refusal: 'group_not_in_tenant' };
  if (actor.role === 'learner_plus' && !(await repository.memberBelongsToGroup(actor.userId, groupId))) {
    return { refusal: 'group_not_allowed' };
  }
  return { refusal: null, subgroups: await repository.listSubGroups(groupId) };
}

export async function listReportTeams(
  actor: ReportFilterActor,
  groupId: string,
  subgroupId: string,
): Promise<ReportFilterList<'teams', ReportTeamRow>> {
  if (!(await repository.subgroupBelongsToGroupOfTenant(subgroupId, groupId, actor.tenantId))) {
    return { refusal: 'subgroup_not_in_group' };
  }
  // learner_plus: the group must be one of theirs (the same rule as the subgroup list).
  if (actor.role === 'learner_plus' && !(await repository.memberBelongsToGroup(actor.userId, groupId))) {
    return { refusal: 'group_not_allowed' };
  }
  return { refusal: null, teams: await repository.listTeams(subgroupId) };
}
