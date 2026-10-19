// ═══════════════════════════════════════════════════════════════
// Tenant badges repository: a tenant's badge rules (enabled flag and
// mapped courses) and the courses a rule can map. SQL only; moved
// unchanged from tenant-badges.service.ts, which keeps the rules (module
// check, criteria, course counts, transactions, audit, cache invalidation).
// ═══════════════════════════════════════════════════════════════

import type { QueryResult, QueryResultRow } from 'pg';

/** The pool query() or a transaction client (PoolClient). */
export interface TenantBadgesDb {
  query<T extends QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

/** One badge of the tenant's rule screen; criteria and courses still as JSON values. */
export interface TenantBadgeRuleRow {
  id: string;
  name: string;
  description: string | null;
  image_key: string | null;
  card_image_url: string | null;
  icon_image_url: string | null;
  mobile_card_image_url: string | null;
  sort_order: number | string | null;
  criteria: unknown;
  is_enabled: boolean;
  updated_at: Date | null;
  courses: unknown;
}

export interface SelectableCourseRow {
  id: string;
  display_name: string;
  visible_to_staff_only: boolean;
}

export function createTenantBadgesRepository(db: TenantBadgesDb) {
  return {
    /** Every active badge the tenant can use, with its rule and mapped courses, in order. */
    async selectTenantBadgeRules(tenantId: string): Promise<TenantBadgeRuleRow[]> {
      const result = await db.query<TenantBadgeRuleRow>(
        `SELECT b.id,
            COALESCE(NULLIF(BTRIM(tbs.name_override), ''), b.name) AS name,
            COALESCE(NULLIF(BTRIM(tbs.description_override), ''), b.description) AS description,
            b.image_key,
            tbs.card_image_url,
            tbs.icon_image_url,
            tbs.mobile_card_image_url,
            b.sort_order,
            b.criteria,
            COALESCE(tbr.is_enabled, false) AS is_enabled,
            tbr.updated_at,
            COALESCE(
              jsonb_agg(
                jsonb_build_object(
                  'course_id', CASE WHEN c.id IS NOT NULL THEN tbrc.course_id ELSE NULL END,
                  'display_name', COALESCE(c.display_name, tbrc.course_name_snapshot, 'Khóa học đã bị xóa'),
                  'is_deleted', c.id IS NULL
                ) ORDER BY tbrc.assigned_at, tbrc.id
              ) FILTER (WHERE tbrc.id IS NOT NULL),
              '[]'::jsonb
            ) AS courses
     FROM badge_definitions b
     LEFT JOIN tenant_badge_settings tbs
       ON tbs.badge_id = b.id AND tbs.tenant_id = $1
     LEFT JOIN tenant_badge_rules tbr
       ON tbr.badge_id = b.id AND tbr.tenant_id = $1
     LEFT JOIN tenant_badge_rule_courses tbrc
       ON tbrc.badge_id = b.id AND tbrc.tenant_id = $1
     LEFT JOIN courses c
       ON c.id = tbrc.course_id
      AND c.tenant_id = $1
     WHERE b.is_active = true
       AND (b.tenant_id IS NULL OR b.tenant_id = $1)
       AND COALESCE(tbs.is_active, true) = true
     GROUP BY b.id, b.name, b.description, b.image_key, b.sort_order, b.criteria,
              tbs.name_override, tbs.description_override,
              tbs.card_image_url, tbs.icon_image_url, tbs.mobile_card_image_url,
              tbr.is_enabled, tbr.updated_at
     ORDER BY b.sort_order, b.id`,
        [tenantId],
      );
      return result.rows;
    },

    /** The tenant's courses (not deleted) matching `search` by name or id: count and one page by name. */
    async selectSelectableCoursePage(
      tenantId: string,
      search: string | undefined,
      pageSize: number,
      offset: number,
    ): Promise<{ countRow: { count: string } | undefined; rows: SelectableCourseRow[] }> {
      const params: unknown[] = [tenantId];
      const conditions = ['tenant_id = $1', 'deleted_at IS NULL'];

      if (search) {
        params.push(`%${search}%`);
        conditions.push(`(display_name ILIKE $${params.length} OR id ILIKE $${params.length})`);
      }

      const where = conditions.join(' AND ');
      const [countResult, dataResult] = await Promise.all([
        db.query<{ count: string }>(`SELECT COUNT(*) AS count FROM courses WHERE ${where}`, params),
        db.query<SelectableCourseRow>(
          `SELECT id, display_name, visible_to_staff_only
       FROM courses
       WHERE ${where}
       ORDER BY display_name ASC, id ASC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, pageSize, offset],
        ),
      ]);
      return { countRow: countResult.rows[0], rows: dataResult.rows };
    },

    /** The rule's mapped course ids, in assignment order. */
    async selectRuleCourseIds(tenantId: string, badgeId: string): Promise<string[]> {
      const result = await db.query<{ course_id: string }>(
        `SELECT course_id
     FROM tenant_badge_rule_courses
     WHERE tenant_id = $1 AND badge_id = $2 AND course_id IS NOT NULL
     ORDER BY assigned_at, id`,
        [tenantId, badgeId],
      );
      return result.rows.map((row) => row.course_id);
    },

    /** Whether the tenant's rule of the badge is enabled (false when there is none). */
    async selectRuleEnabled(tenantId: string, badgeId: string): Promise<boolean> {
      const result = await db.query<{ is_enabled: boolean }>(
        `SELECT is_enabled
     FROM tenant_badge_rules
     WHERE tenant_id = $1 AND badge_id = $2`,
        [tenantId, badgeId],
      );
      return result.rows[0]?.is_enabled === true;
    },

    /** Name and criteria of an active badge the tenant can use and has not turned off. */
    async selectActiveBadge(tenantId: string, badgeId: string): Promise<{ name: string; criteria: unknown } | null> {
      const badgeResult = await db.query<{ name: string; criteria: unknown }>(
        `SELECT COALESCE(NULLIF(BTRIM(tbs.name_override), ''), b.name) AS name, b.criteria
     FROM badge_definitions b
     LEFT JOIN tenant_badge_settings tbs
       ON tbs.badge_id = b.id AND tbs.tenant_id = $1
     WHERE b.id = $2
       AND b.is_active = true
       AND (b.tenant_id IS NULL OR b.tenant_id = $1)
       AND COALESCE(tbs.is_active, true) = true`,
        [tenantId, badgeId],
      );
      return badgeResult.rowCount === 0 ? null : badgeResult.rows[0];
    },

    /** The tenant's courses (not deleted) among `courseIds`. */
    async selectTenantCourses(tenantId: string, courseIds: string[]): Promise<Array<{ id: string; display_name: string }>> {
      const courseResult = await db.query<{ id: string; display_name: string }>(
        `SELECT id, display_name
       FROM courses
       WHERE tenant_id = $1 AND deleted_at IS NULL AND id = ANY($2::varchar[])`,
        [tenantId, courseIds],
      );
      return courseResult.rows;
    },

    async upsertRule(tenantId: string, badgeId: string, isEnabled: boolean, actorId: string): Promise<void> {
      await db.query(
        `INSERT INTO tenant_badge_rules (
         tenant_id, badge_id, is_enabled, created_by, updated_by, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $4, now(), now())
       ON CONFLICT (tenant_id, badge_id) DO UPDATE SET
         is_enabled = EXCLUDED.is_enabled,
         updated_by = EXCLUDED.updated_by,
         updated_at = now()`,
        [tenantId, badgeId, isEnabled, actorId],
      );
    },

    async deleteRuleCourses(tenantId: string, badgeId: string): Promise<void> {
      await db.query(
        'DELETE FROM tenant_badge_rule_courses WHERE tenant_id = $1 AND badge_id = $2',
        [tenantId, badgeId],
      );
    },

    async insertRuleCourse(
      tenantId: string,
      badgeId: string,
      course: { id: string; display_name: string },
      actorId: string,
    ): Promise<void> {
      await db.query(
        `INSERT INTO tenant_badge_rule_courses (
             tenant_id, badge_id, course_id, course_name_snapshot, created_by
           ) VALUES ($1, $2, $3, $4, $5)`,
        [tenantId, badgeId, course.id, course.display_name, actorId],
      );
    },
  };
}
