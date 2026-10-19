// ═══════════════════════════════════════════════════════════════
// Audit logs repository: the audit log list, cursor page and detail reads.
// SQL only, moved unchanged from audit-logs.service.ts, which keeps the
// rules: the WHERE conditions (tenant, retention, viewer scope, filters),
// the PII projection, cursors and page sizes.
// ═══════════════════════════════════════════════════════════════

import type { QueryResult, QueryResultRow } from 'pg';

// Keep the persisted response-audience marker server-internal. API consumers
// receive only the established audit DTO fields.
export const AUDIT_LOG_PUBLIC_SELECT_COLUMNS = `a.id, a.actor_username, a.action, a.entity_type,
  a.entity_id, a.entity_name, a.details, a.ip_address, a.created_at,
  a.event_code, a.event_metadata, a.changes`;

/** The pool query() (joins the current transaction) or a transaction client. */
export interface AuditLogsDb {
  query<T extends QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface AuditLogListRow {
  id: string;
  actor_username: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  entity_name: string | null;
  details: string | null;
  ip_address: string | null;
  created_at: string;
  event_code: string | null;
  event_metadata: Record<string, unknown> | null;
  changes: unknown[] | null;
}

export interface AuditLogDetailRow extends AuditLogListRow {
  actor_display_name: string | null;
  actor_email: string | null;
  subject_display_name: string | null;
  subject_username: string | null;
  subject_email: string | null;
  subject_role: string | null;
}

/** Conditions (joined with AND) and their parameters, as the service builds them. */
export interface AuditLogFilter {
  conditions: string[];
  params: unknown[];
}

export function createAuditLogsRepository(db: AuditLogsDb) {
  return {
    async countAuditLogs(filter: AuditLogFilter): Promise<string> {
      const result = await db.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM audit_logs a WHERE ${filter.conditions.join(' AND ')}`,
        filter.params,
      );
      return result.rows[0].count;
    },

    /** Newest first, by OFFSET. */
    async selectAuditLogPage(filter: AuditLogFilter, pageSize: number, offset: number): Promise<AuditLogListRow[]> {
      const { params } = filter;
      const result = await db.query<AuditLogListRow>(
        `SELECT ${AUDIT_LOG_PUBLIC_SELECT_COLUMNS}
         FROM audit_logs a WHERE ${filter.conditions.join(' AND ')}
         ORDER BY a.created_at DESC, a.id DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, pageSize, offset],
      );
      return result.rows;
    },

    /** Newest first, `limit` rows (the filter already holds the cursor condition). */
    async selectAuditLogCursorPage(filter: AuditLogFilter, limit: number): Promise<AuditLogListRow[]> {
      const { params } = filter;
      const result = await db.query<AuditLogListRow>(
        `SELECT ${AUDIT_LOG_PUBLIC_SELECT_COLUMNS}
         FROM audit_logs a WHERE ${filter.conditions.join(' AND ')}
         ORDER BY a.created_at DESC, a.id DESC
         LIMIT $${params.length + 1}`,
        [...params, limit],
      );
      return result.rows;
    },

    /** One row with the PII columns and join chosen by the service for this viewer. */
    async selectAuditLogDetail(
      filter: AuditLogFilter,
      pii: { columns: string; viewerJoin: string },
    ): Promise<QueryResult<AuditLogDetailRow>> {
      return db.query<AuditLogDetailRow>(
        `SELECT ${AUDIT_LOG_PUBLIC_SELECT_COLUMNS},
                COALESCE(NULLIF(a.actor_display_name, ''), NULLIF(actor.full_name, ''), a.actor_username) AS actor_display_name,
                ${pii.columns},
                a.subject_display_name,
                a.subject_username,
                a.subject_role
         FROM audit_logs a
         LEFT JOIN users actor ON actor.id = a.actor_id
         ${pii.viewerJoin}
         WHERE ${filter.conditions.join(' AND ')}
         LIMIT 1`,
        filter.params,
      );
    },
  };
}

export type AuditLogsRepository = ReturnType<typeof createAuditLogsRepository>;
