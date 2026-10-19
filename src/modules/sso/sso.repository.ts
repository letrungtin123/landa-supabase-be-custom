// ═══════════════════════════════════════════════════════════════
// SSO repository: tenant provider configs, the tenant of a public domain,
// linked identities and the accounts an exchange may reach or create. SQL
// only; moved unchanged from sso.service.ts, which keeps the rules (account
// linking policy, auto-registration, admin-site checks, secret encryption,
// caches).
// ═══════════════════════════════════════════════════════════════

import type { QueryResult, QueryResultRow } from 'pg';
import type { SsoConfigRow, SsoProvider } from './sso.types.js';

/** The pool query() (joins the current transaction) or a transaction client. */
export interface SsoDb {
  query<T extends QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

/** An account an exchange may link by email. */
export interface SsoExistingUserRow {
  id: string;
  tenant_id: string | null;
  role: string;
  is_active: boolean;
}

/** An identity already linked (tenant + provider + subject) with its account. */
export interface SsoLinkedIdentityRow {
  user_id: string;
  role: string;
  is_active: boolean;
  tenant_id: string | null;
}

export interface SsoConfigValues {
  tenantId: string;
  provider: SsoProvider;
  isEnabled: boolean;
  clientId: string | null | undefined;
  clientSecretEnc: string | null;
  issuerUrl: string | null | undefined;
  authorizationUrl: string | null | undefined;
  tokenUrl: string | null | undefined;
  userinfoUrl: string | null | undefined;
  scopes: string[];
  /** JSON text. */
  extraConfigJson: string;
}

export interface SsoIdentityValues {
  tenantId: string;
  userId: string;
  provider: SsoProvider;
  subject: string;
  email: string;
}

export interface NewSsoLearner {
  username: string;
  email: string;
  passwordHash: string;
  fullName: string;
  tenantId: string;
  isActive: boolean;
}

export function createSsoRepository(db: SsoDb) {
  return {
    // ── Provider configs ──

    async selectTenantConfigs(tenantId: string): Promise<SsoConfigRow[]> {
      const result = await db.query<SsoConfigRow>(
        `SELECT id, tenant_id, provider, is_enabled, client_id, client_secret_enc,
            issuer_url, authorization_url, token_url, userinfo_url, scopes,
            extra_config, created_at, updated_at
     FROM tenant_sso_configs
     WHERE tenant_id = $1`,
        [tenantId],
      );
      return result.rows;
    },

    /** Only whether the provider is enabled and has a secret (audit snapshot). */
    async selectConfigAuditState(
      tenantId: string,
      provider: SsoProvider,
    ): Promise<{ is_enabled: boolean; client_secret_enc: string | null } | undefined> {
      const result = await db.query<{ is_enabled: boolean; client_secret_enc: string | null }>(
        `SELECT is_enabled, client_secret_enc
     FROM tenant_sso_configs
     WHERE tenant_id = $1 AND provider = $2
     LIMIT 1`,
        [tenantId, provider],
      );
      return result.rows[0];
    },

    async selectConfig(tenantId: string, provider: SsoProvider): Promise<SsoConfigRow | undefined> {
      const existing = await db.query<SsoConfigRow>(
        'SELECT * FROM tenant_sso_configs WHERE tenant_id = $1 AND provider = $2 LIMIT 1',
        [tenantId, provider],
      );
      return existing.rows[0];
    },

    /** Inserts or replaces the tenant's config of the provider; answers the stored row. */
    async upsertConfig(values: SsoConfigValues): Promise<SsoConfigRow> {
      const result = await db.query<SsoConfigRow>(
        `INSERT INTO tenant_sso_configs (
       tenant_id, provider, is_enabled, client_id, client_secret_enc,
       issuer_url, authorization_url, token_url, userinfo_url, scopes, extra_config
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (tenant_id, provider) DO UPDATE SET
       is_enabled = EXCLUDED.is_enabled,
       client_id = EXCLUDED.client_id,
       client_secret_enc = EXCLUDED.client_secret_enc,
       issuer_url = EXCLUDED.issuer_url,
       authorization_url = EXCLUDED.authorization_url,
       token_url = EXCLUDED.token_url,
       userinfo_url = EXCLUDED.userinfo_url,
       scopes = EXCLUDED.scopes,
       extra_config = EXCLUDED.extra_config,
       updated_at = now()
     RETURNING *`,
        [
          values.tenantId,
          values.provider,
          values.isEnabled,
          values.clientId,
          values.clientSecretEnc,
          values.issuerUrl,
          values.authorizationUrl,
          values.tokenUrl,
          values.userinfoUrl,
          values.scopes,
          values.extraConfigJson,
        ],
      );
      return result.rows[0];
    },

    async deleteConfig(tenantId: string, provider: SsoProvider): Promise<void> {
      await db.query('DELETE FROM tenant_sso_configs WHERE tenant_id = $1 AND provider = $2', [tenantId, provider]);
    },

    async selectEnabledConfigs(tenantId: string): Promise<SsoConfigRow[]> {
      const configs = await db.query<SsoConfigRow>(
        `SELECT * FROM tenant_sso_configs
     WHERE tenant_id = $1 AND is_enabled = true`,
        [tenantId],
      );
      return configs.rows;
    },

    async selectEnabledConfig(tenantId: string, provider: SsoProvider): Promise<SsoConfigRow | null> {
      const result = await db.query<SsoConfigRow>(
        `SELECT * FROM tenant_sso_configs
     WHERE tenant_id = $1 AND provider = $2 AND is_enabled = true
     LIMIT 1`,
        [tenantId, provider],
      );
      return result.rowCount === 0 ? null : result.rows[0];
    },

    // ── Tenants ──

    /** The active tenant whose learner or admin host (no protocol, path or port) is `normalizedDomain`. */
    async selectActiveTenantByDomain(normalizedDomain: string): Promise<{ id: string; name: string } | null> {
      const tenantResult = await db.query<{ id: string; name: string }>(
        `SELECT id, name FROM tenants
     WHERE (
       lower(regexp_replace(regexp_replace(regexp_replace(domain_learner, '^https?://', ''), '/.*$', ''), ':[0-9]+$', '')) = $1
       OR lower(regexp_replace(regexp_replace(regexp_replace(domain_admin, '^https?://', ''), '/.*$', ''), ':[0-9]+$', '')) = $1
     ) AND is_active = true
     LIMIT 1`,
        [normalizedDomain],
      );
      return tenantResult.rowCount === 0 ? null : tenantResult.rows[0];
    },

    async selectTenantDomains(
      tenantId: string,
    ): Promise<{ domain_admin: string | null; domain_learner: string | null } | null> {
      const tenant = await db.query<{ domain_admin: string | null; domain_learner: string | null }>(
        'SELECT domain_admin, domain_learner FROM tenants WHERE id = $1 LIMIT 1',
        [tenantId],
      );
      return tenant.rowCount === 0 ? null : tenant.rows[0];
    },

    // ── Identities and accounts ──

    async selectLinkedIdentity(
      tenantId: string,
      provider: SsoProvider,
      subject: string,
    ): Promise<SsoLinkedIdentityRow | undefined> {
      const identity = await db.query<SsoLinkedIdentityRow>(
        `SELECT i.user_id, u.role, u.is_active, u.tenant_id
     FROM sso_user_identities i
     JOIN users u ON u.id = i.user_id
     WHERE i.tenant_id = $1 AND i.provider = $2 AND i.provider_subject = $3
     LIMIT 1`,
        [tenantId, provider, subject],
      );
      return identity.rows[0];
    },

    /** The account the subject is linked to in the tenant, if any. */
    async selectSubjectUserId(tenantId: string, provider: SsoProvider, subject: string): Promise<string | undefined> {
      const subjectIdentity = await db.query<{ user_id: string }>(
        `SELECT user_id
     FROM sso_user_identities
     WHERE tenant_id = $1 AND provider = $2 AND provider_subject = $3
     LIMIT 1`,
        [tenantId, provider, subject],
      );
      return subjectIdentity.rows[0]?.user_id;
    },

    /** Links the subject to the account (one identity per tenant, provider and account). */
    async upsertIdentityForUser(values: SsoIdentityValues): Promise<void> {
      await db.query(
        `INSERT INTO sso_user_identities (tenant_id, user_id, provider, provider_subject, email)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, provider, user_id)
       DO UPDATE SET provider_subject = EXCLUDED.provider_subject, email = EXCLUDED.email, updated_at = now()`,
        [values.tenantId, values.userId, values.provider, values.subject, values.email],
      );
    },

    /** Links the subject to the account (the subject's link moves to it). */
    async upsertIdentityForSubject(values: SsoIdentityValues): Promise<void> {
      await db.query(
        `INSERT INTO sso_user_identities (tenant_id, user_id, provider, provider_subject, email)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, provider, provider_subject)
       DO UPDATE SET user_id = EXCLUDED.user_id, email = EXCLUDED.email, updated_at = now()`,
        [values.tenantId, values.userId, values.provider, values.subject, values.email],
      );
    },

    async selectUserByNormalizedEmail(normalizedEmail: string): Promise<SsoExistingUserRow | null> {
      const user = await db.query<SsoExistingUserRow>(
        `SELECT id, tenant_id, role, is_active
     FROM users
     WHERE btrim(email) <> ''
       AND lower(btrim(email)) = $1
     LIMIT 1`,
        [normalizedEmail],
      );
      return user.rows[0] ?? null;
    },

    async isUsernameTaken(username: string): Promise<boolean> {
      const existing = await db.query('SELECT id FROM users WHERE username = $1 LIMIT 1', [username]);
      return existing.rowCount !== 0;
    },

    /** Inserts a learner of the tenant; answers its id. */
    async insertLearner(learner: NewSsoLearner): Promise<string> {
      const user = await db.query<{ id: string }>(
        `INSERT INTO users (username, email, password_hash, full_name, phone, role, tenant_id, is_active)
         VALUES ($1, $2, $3, $4, '', 'learner', $5, $6)
         RETURNING id`,
        [learner.username, learner.email, learner.passwordHash, learner.fullName, learner.tenantId, learner.isActive],
      );
      return user.rows[0].id;
    },

    /** How many permission groups the user belongs to (any tenant). */
    async countUserPermissionGroups(userId: string): Promise<QueryResult<{ count: string }>> {
      return db.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM user_permission_groups WHERE user_id = $1`,
        [userId],
      );
    },
  };
}
