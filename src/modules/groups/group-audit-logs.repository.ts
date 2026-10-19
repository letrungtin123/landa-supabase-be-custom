// ═══════════════════════════════════════════════════════════════
// Group audit logs repository: the audit entries of the groups module for
// one tenant, in the viewer's scope. SQL only; moved unchanged from
// groups.service.ts, which keeps the rules (tenant required, pagination).
// The viewer-scope fragment and the public columns come from the audit-logs
// module, as before.
// ═══════════════════════════════════════════════════════════════

import {
  appendAuditLogViewerScopeFilter,
  AUDIT_LOG_PUBLIC_SELECT_COLUMNS,
  AUDIT_LOG_RETENTION_DAYS,
} from '../audit-logs/audit-logs.service.js';
import type { UserRole } from '../../types/index.js';
import type { GroupsDb, WholeRow } from './groups.repository.js';

export interface GroupAuditLogFilter {
  tenantId: string;
  viewerRole: UserRole;
  search: string | undefined;
  action: string;
  dateFrom: string;
  dateTo: string;
}

function groupAuditLogWhere(filter: GroupAuditLogFilter): { where: string; params: unknown[] } {
  const params: unknown[] = [];
  const conditions: string[] = [];

  // Chỉ lấy audit logs liên quan đến groups
  conditions.push(`a.entity_type IN ('org_group', 'sub_group', 'team', 'team_member', 'team_course', 'team_category', 'team_course_category')`);

  params.push(filter.tenantId);
  conditions.push(`a.tenant_id = $${params.length}`);
  appendAuditLogViewerScopeFilter(filter.viewerRole, params, conditions);
  const search = filter.search;
  if (search && search.length >= 2) { params.push(`%${search}%`); conditions.push(`(a.entity_name ILIKE $${params.length} OR a.actor_username ILIKE $${params.length})`); }
  const actionFilter = filter.action;
  if (actionFilter && actionFilter !== 'all') { params.push(actionFilter); conditions.push(`a.action = $${params.length}`); }
  const dateFrom = filter.dateFrom;
  if (dateFrom) { params.push(dateFrom); conditions.push(`a.created_at >= $${params.length}::timestamptz`); }
  else { conditions.push(`a.created_at >= now() - (${AUDIT_LOG_RETENTION_DAYS} * interval '1 day')`); }
  const dateTo = filter.dateTo;
  if (dateTo) { params.push(dateTo); conditions.push(`a.created_at <= $${params.length}::timestamptz`); }

  return { where: `WHERE ${conditions.join(' AND ')}`, params };
}

export function createGroupAuditLogsRepository(db: GroupsDb) {
  return {
    /** COUNT(*) of the filter, as text (always one row). */
    async countGroupAuditLogs(filter: GroupAuditLogFilter): Promise<{ count: string }> {
      const { where, params } = groupAuditLogWhere(filter);
      const countR = await db.query<{ count: string }>(`SELECT COUNT(*) AS count FROM audit_logs a ${where}`, params);
      return countR.rows[0];
    },

    /** One page of the filter, newest first, with the public audit columns. */
    async selectGroupAuditLogPage(filter: GroupAuditLogFilter, pageSize: number, offset: number): Promise<WholeRow[]> {
      const { where, params } = groupAuditLogWhere(filter);
      const dataR = await db.query<WholeRow>(
        `SELECT ${AUDIT_LOG_PUBLIC_SELECT_COLUMNS}
       FROM audit_logs a ${where}
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, pageSize, offset],
      );
      return dataR.rows;
    },
  };
}
