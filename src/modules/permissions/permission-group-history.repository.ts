// ═══════════════════════════════════════════════════════════════
// Permission group history repository: history rows, their filters and the
// actor snapshot. SQL only, moved unchanged from
// permission-group-history.service.ts, which keeps the rules (cursor
// signing, date and page size parsing, the total cache, messages).
// ═══════════════════════════════════════════════════════════════

import type { QueryResult, QueryResultRow } from 'pg';

/** The pool query() (joins the current transaction) or a transaction client. */
export interface PermissionGroupHistoryDb {
  query<T extends QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface HistoryFilter {
  tenantId: string;
  /** Already normalized; '' for none. */
  search: string;
  from: Date | null;
  /** Inclusive day; the filter ends before the next day. */
  to: Date | null;
}

/** WHERE conditions (joined with AND) and their parameters for a history filter. */
export function historyFilterSql(filter: HistoryFilter): { conditions: string[]; params: unknown[] } {
  const params: unknown[] = [filter.tenantId];
  const conditions = ['h.tenant_id = $1::uuid'];
  if (filter.search) {
    params.push(`%${filter.search}%`);
    conditions.push(`h.search_text ILIKE $${params.length}`);
  }
  if (filter.from) {
    params.push(filter.from.toISOString());
    conditions.push(`h.created_at >= $${params.length}::timestamptz`);
  }
  if (filter.to) {
    const endExclusive = new Date(filter.to);
    endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
    params.push(endExclusive.toISOString());
    conditions.push(`h.created_at < $${params.length}::timestamptz`);
  }
  return { conditions, params };
}

export interface HistoryListRow {
  id: string;
  permission_group_id: string;
  permission_group_name: string;
  action: string;
  actor_username: string;
  actor_display_name: string | null;
  actor_role: string | null;
  created_at: string;
}

export interface HistoryDetailRow extends HistoryListRow {
  actor_id: string;
  actor_email: string | null;
  before_state: unknown;
  after_state: unknown;
  participants: unknown;
}

export interface ActorSnapshotRow {
  full_name: string | null;
  email: string | null;
  username: string | null;
  role: string | null;
}

export interface HistoryInsertValues {
  tenantId: string;
  groupId: string;
  groupName: string;
  action: string;
  actorId: string;
  actorUsername: string;
  actorDisplayName: string | null;
  actorEmail: string | null;
  actorRole: string | null;
  beforeState: string | null;
  afterState: string | null;
  participants: string;
  searchText: string;
}

export function createPermissionGroupHistoryRepository(db: PermissionGroupHistoryDb) {
  return {
    /** Count of the rows matching `historyFilterSql` conditions. */
    async countHistory(conditions: string[], params: unknown[]): Promise<string | undefined> {
      const result = await db.query<{ total: string }>(
        `SELECT count(*)::text AS total
         FROM permission_group_history h
         WHERE ${conditions.join(' AND ')}`,
        params,
      );
      return result.rows[0]?.total;
    },

    /**
     * One page, newest first: the filter conditions, then the cursor
     * (created_at, id) when given, then `limit` rows.
     */
    async selectHistoryPage(
      filter: { conditions: string[]; params: unknown[] },
      cursor: { createdAt: string; id: string } | null,
      limit: number,
    ): Promise<HistoryListRow[]> {
      const params = [...filter.params];
      const pageConditions = [...filter.conditions];
      if (cursor) {
        params.push(cursor.createdAt, cursor.id);
        pageConditions.push(`(h.created_at, h.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
      }
      params.push(limit);
      const result = await db.query<HistoryListRow>(
        `SELECT h.id, h.permission_group_id, h.permission_group_name, h.action,
                h.actor_username, h.actor_display_name, h.actor_role,
                h.created_at
         FROM permission_group_history h
         WHERE ${pageConditions.join(' AND ')}
         ORDER BY h.created_at DESC, h.id DESC
         LIMIT $${params.length}`,
        params,
      );
      return result.rows;
    },

    async selectHistoryDetail(historyId: string, tenantId: string): Promise<QueryResult<HistoryDetailRow>> {
      return db.query<HistoryDetailRow>(
        `SELECT h.id, h.permission_group_id, h.permission_group_name, h.action,
                h.actor_id, h.actor_username, h.actor_display_name, h.actor_email, h.actor_role,
                h.before_state, h.after_state, h.participants, h.created_at
         FROM permission_group_history h
         WHERE h.id = $1::uuid AND h.tenant_id = $2::uuid`,
        [historyId, tenantId],
      );
    },

    async selectActorSnapshot(actorId: string): Promise<ActorSnapshotRow | undefined> {
      const result = await db.query<ActorSnapshotRow>(
        `SELECT NULLIF(btrim(full_name), '') AS full_name,
                NULLIF(lower(btrim(email)), '') AS email,
                username,
                role
         FROM users
         WHERE id = $1::uuid
         LIMIT 1`,
        [actorId],
      );
      return result.rows[0];
    },

    async insertHistory(values: HistoryInsertValues): Promise<void> {
      await db.query(
        `INSERT INTO permission_group_history (
           tenant_id, permission_group_id, permission_group_name, action,
           actor_id, actor_username, actor_display_name, actor_email, actor_role,
           before_state, after_state, participants, search_text
         ) VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb, $13)`,
        [
          values.tenantId,
          values.groupId,
          values.groupName,
          values.action,
          values.actorId,
          values.actorUsername,
          values.actorDisplayName,
          values.actorEmail,
          values.actorRole,
          values.beforeState,
          values.afterState,
          values.participants,
          values.searchText,
        ],
      );
    },
  };
}

export type PermissionGroupHistoryRepository = ReturnType<typeof createPermissionGroupHistoryRepository>;
