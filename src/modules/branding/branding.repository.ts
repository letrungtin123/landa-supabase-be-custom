// ═══════════════════════════════════════════════════════════════
// Branding repository: the branding and dashboard content keys of
// tenants.settings, and the tenant lookups by id or public domain. SQL only,
// moved unchanged from branding.service.ts and dashboard-content.service.ts,
// which keep the rules (Storage uploads and cleanup, messages, audit entries,
// transactions, caches).
// ═══════════════════════════════════════════════════════════════

import type { QueryResult, QueryResultRow } from 'pg';

/** The pool query() (joins the current transaction) or a transaction client. */
export interface BrandingDb {
  query<T extends QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export type TenantBrandingRow = {
  id: string;
  name: string;
  domain_admin: string | null;
  domain_learner: string | null;
  settings: Record<string, unknown>;
};

export type TenantSettingsRow = { settings: Record<string, unknown> };

/** Active tenants whose learner or admin domain, without scheme and port, is $1. */
const ACTIVE_TENANT_BY_DOMAIN = `WHERE (
           regexp_replace(regexp_replace(domain_learner, '^https?://', ''), ':[0-9]+$', '') = $1
           OR regexp_replace(regexp_replace(domain_admin, '^https?://', ''), ':[0-9]+$', '') = $1
         ) AND is_active = true`;

export function createBrandingRepository(db: BrandingDb) {
  return {
    async selectSettings(tenantId: string): Promise<QueryResult<TenantSettingsRow>> {
      return db.query<TenantSettingsRow>('SELECT settings FROM tenants WHERE id = $1', [tenantId]);
    },

    async lockSettings(tenantId: string): Promise<QueryResult<TenantSettingsRow>> {
      return db.query<TenantSettingsRow>('SELECT settings FROM tenants WHERE id = $1 FOR UPDATE', [tenantId]);
    },

    async tenantExists(tenantId: string): Promise<boolean> {
      const result = await db.query<{ id: string }>('SELECT id FROM tenants WHERE id = $1', [tenantId]);
      return result.rowCount !== 0;
    },

    async selectBrandingTenant(tenantId: string): Promise<QueryResult<TenantBrandingRow>> {
      return db.query<TenantBrandingRow>(
        'SELECT id, name, domain_admin, domain_learner, settings FROM tenants WHERE id = $1',
        [tenantId],
      );
    },

    async selectBrandingTenantByDomain(normalizedDomain: string): Promise<QueryResult<TenantBrandingRow>> {
      return db.query<TenantBrandingRow>(
        `SELECT id, name, domain_admin, domain_learner, settings FROM tenants
         ${ACTIVE_TENANT_BY_DOMAIN}`,
        [normalizedDomain],
      );
    },

    async selectSettingsByDomain(normalizedDomain: string): Promise<QueryResult<{ id: string; settings: Record<string, unknown> }>> {
      return db.query<{ id: string; settings: Record<string, unknown> }>(
        `SELECT id, settings FROM tenants
         ${ACTIVE_TENANT_BY_DOMAIN}`,
        [normalizedDomain],
      );
    },

    /** Replaces settings.branding (JSON text), without touching updated_at. */
    async writeBranding(tenantId: string, brandingJson: string): Promise<void> {
      await db.query(
        `UPDATE tenants SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{branding}', $1::jsonb) WHERE id = $2`,
        [brandingJson, tenantId],
      );
    },

    /** Replaces settings.branding (JSON text) and sets updated_at. */
    async updateBranding(tenantId: string, brandingJson: string): Promise<void> {
      await db.query(
        `UPDATE tenants
         SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{branding}', $1::jsonb), updated_at = now()
         WHERE id = $2`,
        [brandingJson, tenantId],
      );
    },

    /** Replaces settings.dashboard_content (JSON text). */
    async writeDashboardContent(tenantId: string, contentJson: string): Promise<void> {
      await db.query(
        `UPDATE tenants SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{dashboard_content}', $1::jsonb) WHERE id = $2`,
        [contentJson, tenantId],
      );
    },
  };
}

export type BrandingRepository = ReturnType<typeof createBrandingRepository>;
