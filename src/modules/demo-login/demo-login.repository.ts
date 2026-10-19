// ═══════════════════════════════════════════════════════════════
// Demo QR login repository: the tenant's demo login settings, its demo
// accounts, their public list and the claim of one. SQL only; moved unchanged
// from demo-login.service.ts, which keeps the rules (limits and their
// messages, eligibility, the transaction of a list replace, the one-time
// token of a claim, caches).
// ═══════════════════════════════════════════════════════════════

import type { QueryResult, QueryResultRow } from 'pg';

/** The pool query() (joins the current transaction) or a transaction client. */
export interface DemoLoginDb {
  query<T extends QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export type TimestampLike = Date | string | null;

export interface DemoTenantRow {
  id: string;
  name: string;
  domain_learner: string | null;
  is_active: boolean;
}

export interface DemoLoginSettingsRow {
  tenant_id: string;
  is_enabled: boolean;
  max_demo_accounts: number;
  reservation_ttl_seconds: number;
  updated_by: string | null;
  created_at: TimestampLike;
  updated_at: TimestampLike;
}

export interface DemoAdminAccountRow {
  public_id: string;
  user_id: string;
  label: string | null;
  sort_order: number;
  reserved_until: TimestampLike;
  username: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  is_active: boolean;
  role: string;
  created_at: TimestampLike;
  updated_at: TimestampLike;
}

export interface DemoPublicAccountRow {
  public_id: string;
  label: string | null;
  username: string;
  full_name: string | null;
  avatar_url: string | null;
}

export interface DemoLockSummaryRow {
  locked_count: string;
  next_reset_at: TimestampLike;
  next_reset_in_seconds: number | null;
}

export interface DemoClaimRow {
  user_id: string;
  reserved_until: TimestampLike;
  reservation_ttl_seconds: number;
}

export interface EligibleLearnerRow {
  id: string;
  username: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  created_at: TimestampLike;
}

export interface LearnerSearch {
  tenantId: string;
  search: string | undefined;
  pageSize: number;
  offset: number;
}

export function createDemoLoginRepository(db: DemoLoginDb) {
  return {
    // ── Tenants ──

    async selectTenantById(tenantId: string): Promise<DemoTenantRow | undefined> {
      const result = await db.query<DemoTenantRow>('SELECT id, name, domain_learner, is_active FROM tenants WHERE id = $1', [
        tenantId,
      ]);
      return result.rows[0];
    },

    /** The active tenant whose learner host (no protocol, path or port) is `normalizedDomain`. */
    async selectActiveTenantByLearnerDomain(normalizedDomain: string): Promise<DemoTenantRow | undefined> {
      const result = await db.query<DemoTenantRow>(
        `SELECT id, name, domain_learner, is_active
     FROM tenants
     WHERE lower(regexp_replace(regexp_replace(regexp_replace(domain_learner, '^https?://', ''), '/.*$', ''), ':[0-9]+$', '')) = $1
       AND is_active = true
     LIMIT 1`,
        [normalizedDomain],
      );
      return result.rows[0];
    },

    // ── Settings ──

    async insertSettingsIfMissing(tenantId: string): Promise<void> {
      await db.query(
        `INSERT INTO tenant_demo_login_settings (tenant_id)
     VALUES ($1)
     ON CONFLICT (tenant_id) DO NOTHING`,
        [tenantId],
      );
    },

    async selectSettings(tenantId: string): Promise<DemoLoginSettingsRow | undefined> {
      const result = await db.query<DemoLoginSettingsRow>(
        `SELECT tenant_id, is_enabled, max_demo_accounts, reservation_ttl_seconds,
            updated_by, created_at, updated_at
     FROM tenant_demo_login_settings
     WHERE tenant_id = $1`,
        [tenantId],
      );
      return result.rows[0];
    },

    /** Sets the given columns (names from the caller's fixed list, in order) and updated_by. */
    async updateSettings(
      tenantId: string,
      columns: ReadonlyArray<readonly [string, unknown]>,
      actorId: string | null,
    ): Promise<void> {
      const sets: string[] = [];
      const params: unknown[] = [tenantId];
      let idx = 2;
      for (const [column, value] of columns) {
        sets.push(`${column} = $${idx++}`);
        params.push(value);
      }
      sets.push(`updated_by = $${idx++}`);
      params.push(actorId);

      await db.query(
        `UPDATE tenant_demo_login_settings
     SET ${sets.join(', ')}
     WHERE tenant_id = $1`,
        params,
      );
    },

    // ── Accounts (admin) ──

    async selectAdminAccounts(tenantId: string): Promise<DemoAdminAccountRow[]> {
      const accounts = await db.query<DemoAdminAccountRow>(
        `SELECT a.public_id, a.user_id, a.label, a.sort_order, a.reserved_until,
            a.created_at, a.updated_at,
            u.username, u.email, u.full_name, u.avatar_url, u.is_active, u.role
     FROM tenant_demo_login_accounts a
     JOIN users u ON u.id = a.user_id
     WHERE a.tenant_id = $1
     ORDER BY a.sort_order ASC, a.created_at ASC`,
        [tenantId],
      );
      return accounts.rows;
    },

    async countAccounts(tenantId: string): Promise<{ count: string }> {
      const countResult = await db.query<{ count: string }>(
        'SELECT COUNT(*) AS count FROM tenant_demo_login_accounts WHERE tenant_id = $1',
        [tenantId],
      );
      return countResult.rows[0];
    },

    /** Active learners of the tenant that are not demo accounts yet: the total and one page. */
    async searchEligibleLearners(
      filter: LearnerSearch,
    ): Promise<[QueryResult<{ count: string }>, QueryResult<EligibleLearnerRow>]> {
      const params: unknown[] = [filter.tenantId];
      const conditions = [
        'u.tenant_id = $1',
        "u.role = 'learner'",
        'u.is_active = true',
        'NOT EXISTS (SELECT 1 FROM tenant_demo_login_accounts a WHERE a.user_id = u.id)',
      ];

      if (filter.search) {
        params.push(`%${filter.search}%`);
        conditions.push(
          `(u.username ILIKE $${params.length} OR u.email ILIKE $${params.length} OR u.full_name ILIKE $${params.length})`,
        );
      }

      const where = `WHERE ${conditions.join(' AND ')}`;
      return Promise.all([
        db.query<{ count: string }>(`SELECT COUNT(*) AS count FROM users u ${where}`, params),
        db.query<EligibleLearnerRow>(
          `SELECT u.id, u.username, u.email, u.full_name, u.avatar_url, u.created_at
       FROM users u
       ${where}
       ORDER BY u.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, filter.pageSize, filter.offset],
        ),
      ]);
    },

    /** How many of `userIds` are active learners of the tenant. */
    async countEligibleUsers(tenantId: string, userIds: string[]): Promise<number | null> {
      const validUsers = await db.query<{ id: string }>(
        `SELECT id
       FROM users
       WHERE tenant_id = $1
         AND role = 'learner'
         AND is_active = true
         AND id = ANY($2::uuid[])`,
        [tenantId, userIds],
      );
      return validUsers.rowCount;
    },

    async deleteAllAccounts(tenantId: string): Promise<void> {
      await db.query('DELETE FROM tenant_demo_login_accounts WHERE tenant_id = $1', [tenantId]);
    },

    async deleteAccountsNotIn(tenantId: string, userIds: string[]): Promise<void> {
      await db.query('DELETE FROM tenant_demo_login_accounts WHERE tenant_id = $1 AND NOT (user_id = ANY($2::uuid[]))', [
        tenantId,
        userIds,
      ]);
    },

    async upsertAccount(
      tenantId: string,
      userId: string,
      label: string | null,
      sortOrder: number,
      actorId: string | null,
    ): Promise<void> {
      await db.query(
        `INSERT INTO tenant_demo_login_accounts (tenant_id, user_id, label, sort_order, created_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, user_id)
         DO UPDATE SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order, updated_at = now()`,
        [tenantId, userId, label, sortOrder, actorId],
      );
    },

    /** Deletes the tenant's demo account; answers its username, or null when there is none. */
    async deleteAccount(tenantId: string, publicId: string): Promise<{ username: string } | null> {
      const result = await db.query<{ username: string }>(
        `DELETE FROM tenant_demo_login_accounts a
     USING users u
     WHERE a.user_id = u.id AND a.tenant_id = $1 AND a.public_id = $2
     RETURNING u.username`,
        [tenantId, publicId],
      );
      return result.rowCount === 0 ? null : result.rows[0];
    },

    async selectAccountTenantId(userId: string): Promise<string | undefined> {
      const tenantResult = await db.query<{ tenant_id: string }>(
        'SELECT tenant_id FROM tenant_demo_login_accounts WHERE user_id = $1 LIMIT 1',
        [userId],
      );
      return tenantResult.rows[0]?.tenant_id;
    },

    async deleteAccountsOfUser(userId: string): Promise<void> {
      await db.query('DELETE FROM tenant_demo_login_accounts WHERE user_id = $1', [userId]);
    },

    // ── Public list and claim ──

    /** Free accounts (active learners, not reserved), at most `limit`. */
    async selectPublicAccounts(tenantId: string, limit: number): Promise<DemoPublicAccountRow[]> {
      const accounts = await db.query<DemoPublicAccountRow>(
        `SELECT a.public_id, a.label, u.username, u.full_name, u.avatar_url
       FROM tenant_demo_login_accounts a
       JOIN users u ON u.id = a.user_id
       WHERE a.tenant_id = $1
         AND u.role = 'learner'
         AND u.is_active = true
         AND (a.reserved_until IS NULL OR a.reserved_until <= now())
       ORDER BY a.sort_order ASC, a.created_at ASC
       LIMIT $2`,
        [tenantId, limit],
      );
      return accounts.rows;
    },

    /** How many accounts are reserved now and when the first reservation ends. */
    async selectLockSummary(tenantId: string): Promise<DemoLockSummaryRow | undefined> {
      const locks = await db.query<DemoLockSummaryRow>(
        `SELECT COUNT(*)::text AS locked_count,
              MIN(a.reserved_until) AS next_reset_at,
              GREATEST(0, CEIL(EXTRACT(EPOCH FROM (MIN(a.reserved_until) - now()))))::int AS next_reset_in_seconds
       FROM tenant_demo_login_accounts a
       JOIN users u ON u.id = a.user_id
       WHERE a.tenant_id = $1
         AND u.role = 'learner'
         AND u.is_active = true
         AND a.reserved_until > now()`,
        [tenantId],
      );
      return locks.rows[0];
    },

    /** Reserves the account for the tenant's TTL when it is free and demo login is on; undefined otherwise. */
    async claimAccount(tenantId: string, publicId: string): Promise<DemoClaimRow | undefined> {
      const result = await db.query<DemoClaimRow>(
        `WITH target AS (
       SELECT a.public_id, a.user_id, s.reservation_ttl_seconds
       FROM tenant_demo_login_accounts a
       JOIN tenant_demo_login_settings s ON s.tenant_id = a.tenant_id
       JOIN users u ON u.id = a.user_id
       WHERE a.tenant_id = $1
         AND a.public_id = $2
         AND s.is_enabled = true
         AND u.role = 'learner'
         AND u.is_active = true
         AND (a.reserved_until IS NULL OR a.reserved_until <= now())
       LIMIT 1
     )
     UPDATE tenant_demo_login_accounts a
     SET reserved_until = now() + (target.reservation_ttl_seconds * interval '1 second'),
         updated_at = now()
     FROM target
     WHERE a.public_id = target.public_id
     RETURNING a.user_id, a.reserved_until, target.reservation_ttl_seconds`,
        [tenantId, publicId],
      );
      return result.rows[0];
    },
  };
}
