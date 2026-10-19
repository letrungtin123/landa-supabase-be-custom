// ═══════════════════════════════════════════════════════════════
// Badge evaluation repository: whether badges are on for a tenant, the
// tenant's effective badge rules, a learner's completed courses, profile
// and badges, and the validated award insert. SQL only; moved unchanged
// from badge-evaluation.service.ts, which keeps the rules (criteria
// parsing, evaluation, caches).
// ═══════════════════════════════════════════════════════════════

import type { QueryResult, QueryResultRow } from 'pg';
import type { BadgeAwardCandidate, CompletedCourseFact, UserProfile } from './badge-evaluation.logic.js';

/** The pool query() (joins the current transaction). */
export interface BadgeEvaluationDb {
  query<T extends QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

/** One enabled rule as stored: criteria and mapped courses still as JSON values. */
export interface BadgeRuleRow {
  id: string;
  name: string;
  title: string;
  description: string;
  desc: string;
  image_key: string;
  card_image_url: string | null;
  icon_image_url: string | null;
  mobile_card_image_url: string | null;
  sort_order: number | string | null;
  criteria: unknown;
  rule_version: string;
  mapped_courses: unknown;
}

export type UserBadgeRow = {
  badge_id: string;
  is_shown: boolean;
  earned_at: string;
};

export function createBadgeEvaluationRepository(db: BadgeEvaluationDb) {
  return {
    async badgeModuleEnabled(tenantId: string): Promise<boolean> {
      const result = await db.query<{ enabled: boolean }>(
        `SELECT EXISTS (
       SELECT 1
       FROM tenant_modules tm
       JOIN modules m ON m.id = tm.module_id
       WHERE tm.tenant_id = $1
         AND tm.is_enabled = true
         AND m.code = 'badge_management'
         AND m.is_active = true
     ) AS enabled`,
        [tenantId],
      );
      return result.rows[0]?.enabled === true;
    },

    /** The tenant's enabled rules of active badges (module on), with their mapped courses, in order. */
    async selectEffectiveBadgeRules(tenantId: string): Promise<BadgeRuleRow[]> {
      const result = await db.query<BadgeRuleRow>(
        `SELECT b.id,
            COALESCE(NULLIF(BTRIM(tbs.name_override), ''), b.name) AS name,
            COALESCE(NULLIF(BTRIM(tbs.name_override), ''), b.name) AS title,
            COALESCE(NULLIF(BTRIM(tbs.description_override), ''), b.description) AS description,
            COALESCE(NULLIF(BTRIM(tbs.description_override), ''), b.description) AS desc,
            b.image_key,
            tbs.card_image_url,
            tbs.icon_image_url,
            tbs.mobile_card_image_url,
            b.sort_order,
            b.criteria,
            tbr.updated_at::text AS rule_version,
            COALESCE(
              jsonb_agg(
                jsonb_build_object(
                  'course_id', CASE WHEN c.id IS NOT NULL THEN tbrc.course_id ELSE NULL END,
                  'course_name', COALESCE(c.display_name, tbrc.course_name_snapshot, ''),
                  'is_deleted', c.id IS NULL
                ) ORDER BY tbrc.assigned_at, tbrc.id
              ) FILTER (WHERE tbrc.id IS NOT NULL),
              '[]'::jsonb
            ) AS mapped_courses
     FROM badge_definitions b
     LEFT JOIN tenant_badge_settings tbs
       ON tbs.badge_id = b.id AND tbs.tenant_id = $1
     JOIN tenant_badge_rules tbr
       ON tbr.badge_id = b.id AND tbr.tenant_id = $1 AND tbr.is_enabled = true
     LEFT JOIN tenant_badge_rule_courses tbrc
       ON tbrc.badge_id = b.id AND tbrc.tenant_id = $1
     LEFT JOIN courses c
       ON c.id = tbrc.course_id
      AND c.tenant_id = $1
     WHERE b.is_active = true
       AND (b.tenant_id IS NULL OR b.tenant_id = $1)
       AND COALESCE(tbs.is_active, true) = true
       AND EXISTS (
         SELECT 1
         FROM tenant_modules tm
         JOIN modules m ON m.id = tm.module_id
         WHERE tm.tenant_id = $1
           AND tm.is_enabled = true
           AND m.code = 'badge_management'
           AND m.is_active = true
       )
     GROUP BY b.id, b.name, b.description, b.image_key, b.sort_order, b.criteria,
              tbs.name_override, tbs.description_override,
              tbs.card_image_url, tbs.icon_image_url, tbs.mobile_card_image_url,
              tbr.updated_at
     ORDER BY b.sort_order, b.id`,
        [tenantId],
      );
      return result.rows;
    },

    /** The learner's completed courses of the tenant (progress 100, completed, with a time). */
    async selectCompletedCourses(userId: string, tenantId: string): Promise<CompletedCourseFact[]> {
      const result = await db.query<CompletedCourseFact>(
        `SELECT DISTINCT e.course_id, e.enrolled_at, cp.completed_at
     FROM enrollments e
     JOIN course_progress cp ON cp.enrollment_id = e.id
     WHERE e.user_id = $1
       AND e.tenant_id = $2
       AND cp.progress >= 100
       AND cp.is_completed = true
       AND cp.completed_at IS NOT NULL`,
        [userId, tenantId],
      );
      return result.rows;
    },

    /** The profile fields profile badges read; undefined when the user is not in the tenant. */
    async selectProfile(userId: string, tenantId: string): Promise<UserProfile | undefined> {
      const result = await db.query<UserProfile>(
        `SELECT bio, gender, country, language, level_of_education,
            year_of_birth, phone, avatar_url
     FROM users
     WHERE id = $1 AND tenant_id = $2`,
        [userId, tenantId],
      );
      return result.rows[0];
    },

    /**
     * Awards the candidates whose rule, criteria and mapped courses are still
     * those the evaluation saw; the badges inserted now.
     */
    async insertValidatedAwards(userId: string, tenantId: string, candidates: BadgeAwardCandidate[]): Promise<UserBadgeRow[]> {
      const result = await db.query<UserBadgeRow>(
        `WITH candidates AS (
       SELECT badge_id, rule_version, criteria, mapped_course_ids
       FROM jsonb_to_recordset($3::jsonb) AS candidate(
         badge_id varchar,
         rule_version text,
         criteria jsonb,
         mapped_course_ids jsonb
       )
     ),
     validated AS (
       SELECT candidate.badge_id
       FROM candidates candidate
       JOIN badge_definitions b ON b.id = candidate.badge_id
       JOIN tenant_badge_rules tbr
         ON tbr.badge_id = candidate.badge_id
        AND tbr.tenant_id = $2
        AND tbr.is_enabled = true
       LEFT JOIN tenant_badge_settings tbs
         ON tbs.badge_id = candidate.badge_id
        AND tbs.tenant_id = $2
       WHERE b.is_active = true
         AND (b.tenant_id IS NULL OR b.tenant_id = $2)
         AND COALESCE(tbs.is_active, true) = true
         AND tbr.updated_at::text = candidate.rule_version
         AND b.criteria = candidate.criteria
          AND candidate.mapped_course_ids = COALESCE((
            SELECT jsonb_agg(valid_course_ids.course_id ORDER BY valid_course_ids.course_id)
            FROM (
              SELECT DISTINCT tbrc.course_id
              FROM tenant_badge_rule_courses tbrc
              JOIN courses current_course
                ON current_course.id = tbrc.course_id
               AND current_course.tenant_id = $2
              WHERE tbrc.tenant_id = $2
                AND tbrc.badge_id = candidate.badge_id
                AND tbrc.course_id IS NOT NULL
            ) valid_course_ids
          ), '[]'::jsonb)
         AND EXISTS (
           SELECT 1
           FROM tenant_modules tm
           JOIN modules m ON m.id = tm.module_id
           WHERE tm.tenant_id = $2
             AND tm.is_enabled = true
             AND m.code = 'badge_management'
             AND m.is_active = true
         )
     )
     INSERT INTO user_badges (user_id, badge_id)
     SELECT $1, badge_id
     FROM validated
     ON CONFLICT (user_id, badge_id) DO NOTHING
     RETURNING badge_id, is_shown, earned_at`,
        [userId, tenantId, JSON.stringify(candidates)],
      );
      return result.rows;
    },

    /** Every badge of the user, newest first. */
    async selectOwnedBadges(userId: string): Promise<UserBadgeRow[]> {
      const result = await db.query<UserBadgeRow>(
        `SELECT badge_id, is_shown, earned_at
       FROM user_badges
       WHERE user_id = $1
       ORDER BY earned_at DESC, badge_id`,
        [userId],
      );
      return result.rows;
    },

    /** The user's badges among `badgeIds`, newest first. */
    async selectEarnedBadges(userId: string, badgeIds: string[]): Promise<UserBadgeRow[]> {
      const result = await db.query<UserBadgeRow>(
        `SELECT badge_id, is_shown, earned_at
         FROM user_badges
         WHERE user_id = $1 AND badge_id = ANY($2::varchar[])
         ORDER BY earned_at DESC, badge_id`,
        [userId, badgeIds],
      );
      return result.rows;
    },
  };
}
