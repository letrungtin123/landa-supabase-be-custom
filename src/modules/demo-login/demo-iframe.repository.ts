// ═══════════════════════════════════════════════════════════════
// Demo iframe repository: the tenant's demo iframe settings, its demo learner,
// the sessions a change ends and the public bootstrap lookup. SQL only; moved
// unchanged from demo-iframe.service.ts, which keeps the rules (origin
// checks, which sessions end and when, blacklisting, missing-table
// tolerance).
// ═══════════════════════════════════════════════════════════════

import type { QueryResult, QueryResultRow } from 'pg';
import type { DemoTenantRow, LearnerSearch, TimestampLike } from './demo-login.repository.js';

/** The pool query() (joins the current transaction) or a transaction client. */
export interface DemoIframeDb {
  query<T extends QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface DemoIframeSettingsRow {
  tenant_id: string;
  is_enabled: boolean;
  allowed_origin: string | null;
  demo_user_id: string | null;
  public_embed_id: string;
  updated_by: string | null;
  created_at: TimestampLike;
  updated_at: TimestampLike;
  tenant_name: string;
  tenant_domain_learner: string | null;
  tenant_is_active: boolean;
  learner_username: string | null;
  learner_email: string | null;
  learner_full_name: string | null;
  learner_avatar_url: string | null;
  learner_is_active: boolean | null;
  learner_role: string | null;
}

export interface DemoIframeSettingsValues {
  tenantId: string;
  isEnabled: boolean;
  allowedOrigin: string | null;
  demoUserId: string | null;
  actorId: string | null;
}

export interface EligibleIframeLearnerRow {
  id: string;
  username: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  created_at: TimestampLike;
  is_demo_iframe_active: boolean;
}

export interface DemoIframeBootstrapRow {
  tenant_id: string;
  tenant_name: string;
  tenant_domain_learner: string | null;
  allowed_origin: string;
  demo_user_id: string;
  username: string;
  full_name: string | null;
}

export function createDemoIframeRepository(db: DemoIframeDb) {
  return {
    async selectTenantById(tenantId: string): Promise<DemoTenantRow | undefined> {
      const result = await db.query<DemoTenantRow>('SELECT id, name, domain_learner, is_active FROM tenants WHERE id = $1', [
        tenantId,
      ]);
      return result.rows[0];
    },

    // ── Settings ──

    async insertSettingsIfMissing(tenantId: string): Promise<void> {
      await db.query(
        `INSERT INTO tenant_demo_iframe_settings (tenant_id)
     VALUES ($1)
     ON CONFLICT (tenant_id) DO NOTHING`,
        [tenantId],
      );
    },

    /** The settings with the tenant and the demo learner. */
    async selectSettingsRow(tenantId: string): Promise<DemoIframeSettingsRow | undefined> {
      const result = await db.query<DemoIframeSettingsRow>(
        `SELECT s.tenant_id, s.is_enabled, s.allowed_origin, s.demo_user_id,
            s.public_embed_id, s.updated_by, s.created_at, s.updated_at,
            t.name AS tenant_name, t.domain_learner AS tenant_domain_learner,
            t.is_active AS tenant_is_active,
            u.username AS learner_username, u.email AS learner_email,
            u.full_name AS learner_full_name, u.avatar_url AS learner_avatar_url,
            u.is_active AS learner_is_active, u.role::text AS learner_role
     FROM tenant_demo_iframe_settings s
     JOIN tenants t ON t.id = s.tenant_id
     LEFT JOIN users u ON u.id = s.demo_user_id
     WHERE s.tenant_id = $1`,
        [tenantId],
      );
      return result.rows[0];
    },

    async updateSettings(values: DemoIframeSettingsValues): Promise<void> {
      await db.query(
        `UPDATE tenant_demo_iframe_settings
     SET is_enabled = $2,
         allowed_origin = $3,
         demo_user_id = $4,
         updated_by = $5,
         updated_at = now()
     WHERE tenant_id = $1`,
        [values.tenantId, values.isEnabled, values.allowedOrigin, values.demoUserId, values.actorId],
      );
    },

    async regenerateEmbedId(tenantId: string, actorId: string | null): Promise<void> {
      await db.query(
        `UPDATE tenant_demo_iframe_settings
     SET public_embed_id = gen_random_uuid(),
         updated_by = $2,
         updated_at = now()
     WHERE tenant_id = $1`,
        [tenantId, actorId],
      );
    },

    // ── Learners and their sessions ──

    /** Whether the user is an active learner of the tenant. */
    async isActiveLearnerOfTenant(tenantId: string, userId: string): Promise<boolean> {
      const result = await db.query<{ id: string }>(
        `SELECT id
     FROM users
     WHERE id = $1
       AND tenant_id = $2
       AND role = 'learner'
       AND is_active = true`,
        [userId, tenantId],
      );
      return result.rowCount !== 0;
    },

    /** Revokes the user's live refresh tokens, of one session mode when given (keeps an earlier revoked_at). */
    async revokeRefreshTokens(userId: string, mode?: string): Promise<void> {
      const params: unknown[] = [userId];
      let modeClause = '';
      if (mode) {
        params.push(mode);
        modeClause = ` AND session_mode = $${params.length}`;
      }
      await db.query(
        `UPDATE refresh_tokens
     SET revoked = true, revoked_at = COALESCE(revoked_at, now())
     WHERE user_id = $1
       AND revoked = false${modeClause}`,
        params,
      );
    },

    /** Revokes the user's live normal-mode refresh tokens (a missing mode counts as normal). */
    async revokeNormalRefreshTokens(userId: string): Promise<void> {
      await db.query(
        `UPDATE refresh_tokens
     SET revoked = true, revoked_at = COALESCE(revoked_at, now())
     WHERE user_id = $1
       AND revoked = false
       AND COALESCE(session_mode, 'normal') = 'normal'`,
        [userId],
      );
    },

    /** Active learners of the tenant with whether each is an enabled demo iframe learner: the total and one page. */
    async searchEligibleLearners(
      filter: LearnerSearch,
    ): Promise<[QueryResult<{ count: string }>, QueryResult<EligibleIframeLearnerRow>]> {
      const params: unknown[] = [filter.tenantId];
      const conditions = ['u.tenant_id = $1', "u.role = 'learner'", 'u.is_active = true'];

      if (filter.search) {
        params.push(`%${filter.search}%`);
        conditions.push(
          `(u.username ILIKE $${params.length} OR u.email ILIKE $${params.length} OR u.full_name ILIKE $${params.length})`,
        );
      }

      const where = `WHERE ${conditions.join(' AND ')}`;
      return Promise.all([
        db.query<{ count: string }>(`SELECT COUNT(*) AS count FROM users u ${where}`, params),
        db.query<EligibleIframeLearnerRow>(
          `SELECT u.id, u.username, u.email, u.full_name, u.avatar_url, u.created_at,
              EXISTS (
                SELECT 1
                FROM tenant_demo_iframe_settings s
                WHERE s.demo_user_id = u.id
                  AND s.is_enabled = true
              ) AS is_demo_iframe_active
       FROM users u
       ${where}
       ORDER BY u.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, filter.pageSize, filter.offset],
        ),
      ]);
    },

    // ── Public bootstrap and lookups ──

    /** The enabled embed with an allowed origin, an active tenant and an active demo learner. */
    async selectBootstrap(embedId: string): Promise<DemoIframeBootstrapRow | undefined> {
      const result = await db.query<DemoIframeBootstrapRow>(
        `SELECT s.tenant_id, t.name AS tenant_name, t.domain_learner AS tenant_domain_learner,
            s.allowed_origin, s.demo_user_id, u.username, u.full_name
     FROM tenant_demo_iframe_settings s
     JOIN tenants t ON t.id = s.tenant_id
     JOIN users u ON u.id = s.demo_user_id
     WHERE s.public_embed_id = $1
       AND s.is_enabled = true
       AND s.allowed_origin IS NOT NULL
       AND s.demo_user_id IS NOT NULL
       AND t.is_active = true
       AND u.role = 'learner'
       AND u.is_active = true
     LIMIT 1`,
        [embedId],
      );
      return result.rows[0];
    },

    /** Whether the user is the learner of an enabled demo iframe. */
    async isEnabledDemoLearner(userId: string): Promise<boolean> {
      const result = await db.query<{ exists: boolean }>(
        `SELECT EXISTS (
        SELECT 1
        FROM tenant_demo_iframe_settings
        WHERE demo_user_id = $1
          AND is_enabled = true
      ) AS exists`,
        [userId],
      );
      return result.rows[0]?.exists === true;
    },

    /** Which of `userIds` are learners of an enabled demo iframe. */
    async selectEnabledDemoLearnerIds(userIds: string[]): Promise<string[]> {
      const result = await db.query<{ demo_user_id: string }>(
        `SELECT demo_user_id
       FROM tenant_demo_iframe_settings
       WHERE demo_user_id = ANY($1::uuid[])
         AND is_enabled = true`,
        [userIds],
      );
      return result.rows.map(row => row.demo_user_id);
    },
  };
}
