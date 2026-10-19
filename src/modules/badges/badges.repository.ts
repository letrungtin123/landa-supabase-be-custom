// ═══════════════════════════════════════════════════════════════
// Badges repository: a tenant's badge settings (status, name and
// description overrides, card/icon/mobile images). SQL only; moved
// unchanged from badges.service.ts, which keeps the rules (text checks,
// transactions, audit entries, Storage, cache invalidation).
// ═══════════════════════════════════════════════════════════════

import type { QueryResult, QueryResultRow } from 'pg';

/** The pool query() or a transaction client (PoolClient). */
export interface BadgesDb {
  query<T extends QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

/** One badge of the tenant's badge settings screen. */
export interface TenantBadgeSettingRow {
  id: string;
  name: string;
  title: string;
  description: string | null;
  desc: string | null;
  default_name: string;
  default_description: string | null;
  name_override: string | null;
  description_override: string | null;
  image_key: string | null;
  card_image_url: string | null;
  icon_image_url: string | null;
  mobile_card_image_url: string | null;
  is_active: boolean;
}

export type BadgeDefaults = {
  id: string;
  name: string;
  description: string | null;
};

/** The image columns of tenant_badge_settings. */
export type BadgeImageColumn = 'card_image_url' | 'icon_image_url' | 'mobile_card_image_url';

/** One tenant_badge_settings upsert; an override left undefined is not written. */
export interface BadgeSettingWrite {
  tenantId: string;
  badgeId: string;
  isActive: boolean;
  nameOverride?: string | null;
  descriptionOverride?: string | null;
}

export function createBadgesRepository(db: BadgesDb) {
  return {
    /** Whether the badge is global or the tenant's own. */
    async badgeAccessibleToTenant(tenantId: string, badgeId: string): Promise<boolean> {
      const result = await db.query<{ id: string }>(
        `SELECT id FROM badge_definitions
     WHERE id = $1 AND (tenant_id IS NULL OR tenant_id = $2)`,
        [badgeId, tenantId],
      );
      return result.rowCount !== 0;
    },

    /** Every badge the tenant can use, with its settings (defaults when none). */
    async selectTenantBadgeSettings(tenantId: string): Promise<TenantBadgeSettingRow[]> {
      const result = await db.query<TenantBadgeSettingRow>(
        `SELECT b.id,
            COALESCE(NULLIF(BTRIM(tbs.name_override), ''), b.name) AS name,
            COALESCE(NULLIF(BTRIM(tbs.name_override), ''), b.name) AS title,
            COALESCE(NULLIF(BTRIM(tbs.description_override), ''), b.description) AS description,
            COALESCE(NULLIF(BTRIM(tbs.description_override), ''), b.description) AS desc,
            b.name AS default_name,
            b.description AS default_description,
            tbs.name_override,
            tbs.description_override,
            b.image_key,
            tbs.card_image_url, tbs.icon_image_url, tbs.mobile_card_image_url,
            COALESCE(tbs.is_active, true) AS is_active
     FROM badge_definitions b
     LEFT JOIN tenant_badge_settings tbs ON tbs.badge_id = b.id AND tbs.tenant_id = $1
     WHERE b.tenant_id IS NULL OR b.tenant_id = $1
     ORDER BY b.sort_order, b.id`,
        [tenantId]
      );
      return result.rows;
    },

    async upsertBadgeStatus(tenantId: string, badgeId: string, isActive: boolean): Promise<void> {
      await db.query(
        `INSERT INTO tenant_badge_settings (tenant_id, badge_id, is_active)
     VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, badge_id)
     DO UPDATE SET is_active = $3, updated_at = now()`,
        [tenantId, badgeId, isActive]
      );
    },

    /** Default name and description of the badges the tenant can use among `badgeIds`. */
    async selectBadgeDefaults(badgeIds: string[], tenantId: string): Promise<BadgeDefaults[]> {
      const defaultsResult = await db.query<BadgeDefaults>(
        `SELECT id, name, description FROM badge_definitions
     WHERE id = ANY($1::varchar[]) AND (tenant_id IS NULL OR tenant_id = $2)`,
        [badgeIds, tenantId],
      );
      return defaultsResult.rows;
    },

    /** Inserts or updates one badge setting: the status, and each override given. */
    async upsertBadgeSetting(setting: BadgeSettingWrite): Promise<void> {
      const columns = ['tenant_id', 'badge_id', 'is_active'];
      const placeholders = ['$1', '$2', '$3'];
      const params: unknown[] = [setting.tenantId, setting.badgeId, setting.isActive];
      const updateSets = ['is_active = EXCLUDED.is_active'];

      if (setting.nameOverride !== undefined) {
        params.push(setting.nameOverride);
        columns.push('name_override');
        placeholders.push(`$${params.length}`);
        updateSets.push('name_override = EXCLUDED.name_override');
      }

      if (setting.descriptionOverride !== undefined) {
        params.push(setting.descriptionOverride);
        columns.push('description_override');
        placeholders.push(`$${params.length}`);
        updateSets.push('description_override = EXCLUDED.description_override');
      }

      await db.query(
        `INSERT INTO tenant_badge_settings (${columns.join(', ')})
         VALUES (${placeholders.join(', ')})
         ON CONFLICT (tenant_id, badge_id)
         DO UPDATE SET ${updateSets.join(', ')}, updated_at = now()`,
        params,
      );
    },

    /** Makes sure the tenant has a settings row for the badge. */
    async ensureBadgeSettingRow(tenantId: string, badgeId: string): Promise<void> {
      await db.query(
        `INSERT INTO tenant_badge_settings (tenant_id, badge_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [tenantId, badgeId],
      );
    },

    /** The current path of one image column, row-locked (FOR UPDATE) until commit. */
    async lockBadgeImage(tenantId: string, badgeId: string, column: BadgeImageColumn): Promise<string | null> {
      const current = await db.query<{ image_url: string | null }>(
        `SELECT ${column} AS image_url
       FROM tenant_badge_settings
       WHERE tenant_id = $1 AND badge_id = $2
       FOR UPDATE`,
        [tenantId, badgeId],
      );
      return current.rows[0]?.image_url ?? null;
    },

    async updateBadgeImage(tenantId: string, badgeId: string, column: BadgeImageColumn, storagePath: string): Promise<void> {
      await db.query(
        `UPDATE tenant_badge_settings
       SET ${column} = $1, updated_at = now()
       WHERE tenant_id = $2 AND badge_id = $3`,
        [storagePath, tenantId, badgeId],
      );
    },
  };
}
