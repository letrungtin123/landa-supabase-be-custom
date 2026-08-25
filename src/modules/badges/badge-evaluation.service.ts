import { query } from '../../config/database.js';
import { cacheJson, getCacheVersion } from '../../config/cache.js';
import { CACHE_TTL, cacheKeys, cacheVersions } from '../../config/cache-keys.js';
import {
  criteriaRequiresCourses,
  minimumMappedCourses,
  parseBadgeCriteria,
  type BadgeCriteria,
} from './badge-criteria.js';
import {
  buildBadgeAwardCandidates,
  evaluateBadgeRule,
  type BadgeProgress as EvaluationBadgeProgress,
  type CompletedCourseFact,
  type MappedCourse,
  type UserProfile,
} from './badge-evaluation.logic.js';

type EffectiveBadgeRule = {
  id: string;
  name: string;
  title: string;
  description: string;
  desc: string;
  image_key: string;
  card_image_url: string | null;
  icon_image_url: string | null;
  mobile_card_image_url: string | null;
  sort_order: number;
  rule_version: string;
  criteria: BadgeCriteria;
  mapped_courses: MappedCourse[];
};

export type BadgeProgress = EvaluationBadgeProgress;

export type UserBadgeRow = {
  badge_id: string;
  is_shown: boolean;
  earned_at: string;
};

export type BadgeEvaluationOverview = {
  badge_definitions: Array<Omit<EffectiveBadgeRule, 'criteria' | 'mapped_courses' | 'rule_version'>>;
  earned_badges: UserBadgeRow[];
  newly_earned: UserBadgeRow[];
  pending_popups: UserBadgeRow[];
  progress: Record<string, BadgeProgress>;
};

export const EMPTY_BADGE_OVERVIEW: BadgeEvaluationOverview = {
  badge_definitions: [],
  earned_badges: [],
  newly_earned: [],
  pending_popups: [],
  progress: {},
};

export async function isBadgeManagementModuleEnabled(tenantId: string): Promise<boolean> {
  const result = await query<{ enabled: boolean }>(
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
}

async function getEffectiveBadgeRulesFromDb(tenantId: string): Promise<EffectiveBadgeRule[]> {
  const result = await query<any>(
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

  const rules: EffectiveBadgeRule[] = [];
  for (const row of result.rows) {
    const criteria = parseBadgeCriteria(row.criteria);
    if (!criteria) {
      console.warn(`[Badges] Ignoring unsupported criteria for badge ${row.id}`);
      continue;
    }

    const mappedCourses = Array.isArray(row.mapped_courses) ? row.mapped_courses as MappedCourse[] : [];
    const validMappedCourses = mappedCourses.filter((course) => Boolean(course.course_id) && !course.is_deleted);
    if (criteriaRequiresCourses(criteria) && validMappedCourses.length < minimumMappedCourses(criteria)) continue;

    rules.push({
      ...row,
      sort_order: Number(row.sort_order) || 0,
      criteria,
      mapped_courses: mappedCourses,
    });
  }
  return rules;
}

export async function getEffectiveBadgeRules(tenantId: string): Promise<EffectiveBadgeRule[]> {
  if (!(await isBadgeManagementModuleEnabled(tenantId))) return [];

  const version = await getCacheVersion(...cacheVersions.tenantBadges(tenantId));
  return cacheJson(
    cacheKeys.tenantResource(tenantId, 'effective-badge-rules', version),
    CACHE_TTL.badges,
    () => getEffectiveBadgeRulesFromDb(tenantId),
  );
}

export async function getEffectiveBadgeDefinitions(tenantId: string) {
  const rules = await getEffectiveBadgeRules(tenantId);
  return rules.map(({
    criteria: _criteria,
    mapped_courses: _mappedCourses,
    rule_version: _ruleVersion,
    ...definition
  }) => definition);
}

function toTime(value: string | Date): number {
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Number.NaN;
}


async function loadCompletedCourses(userId: string, tenantId: string): Promise<CompletedCourseFact[]> {
  const result = await query<CompletedCourseFact>(
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
}

async function loadProfile(userId: string, tenantId: string): Promise<UserProfile> {
  const result = await query<UserProfile>(
    `SELECT bio, gender, country, language, level_of_education,
            year_of_birth, phone, avatar_url
     FROM users
     WHERE id = $1 AND tenant_id = $2`,
    [userId, tenantId],
  );
  return result.rows[0] || {};
}

async function insertValidatedBadgeAwards(
  userId: string,
  tenantId: string,
  rules: EffectiveBadgeRule[],
): Promise<UserBadgeRow[]> {
  if (rules.length === 0) return [];

  const candidates = buildBadgeAwardCandidates(rules);

  const result = await query<UserBadgeRow>(
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
           SELECT jsonb_agg(tbrc.course_id ORDER BY tbrc.course_id)
           FROM tenant_badge_rule_courses tbrc
           JOIN courses current_course
             ON current_course.id = tbrc.course_id
            AND current_course.tenant_id = $2
           WHERE tbrc.tenant_id = $2
             AND tbrc.badge_id = candidate.badge_id
             AND tbrc.course_id IS NOT NULL
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
}

export async function evaluateUserBadges(userId: string, tenantId: string): Promise<BadgeEvaluationOverview> {
  const rules = await getEffectiveBadgeRules(tenantId);
  if (rules.length === 0) return EMPTY_BADGE_OVERVIEW;

  const [completedCourses, profileData, existingResult] = await Promise.all([
    loadCompletedCourses(userId, tenantId),
    loadProfile(userId, tenantId),
    query<{ badge_id: string }>(
      'SELECT badge_id FROM user_badges WHERE user_id = $1',
      [userId],
    ),
  ]);
  const existingIds = new Set(existingResult.rows.map((row) => row.badge_id));
  const awardCandidates = rules.filter((rule) => {
    const result = evaluateBadgeRule(rule, completedCourses, profileData);
    return result.achieved && !existingIds.has(rule.id);
  });
  const newlyEarned = await insertValidatedBadgeAwards(userId, tenantId, awardCandidates);

  // Reload from DB so definitions, progress and popups follow the latest committed configuration.
  const currentRules = await getEffectiveBadgeRulesFromDb(tenantId);
  if (currentRules.length === 0) return EMPTY_BADGE_OVERVIEW;

  const effectiveIds = currentRules.map((rule) => rule.id);
  const effectiveIdSet = new Set(effectiveIds);
  const progressMap: Record<string, BadgeProgress> = {};
  for (const rule of currentRules) {
    progressMap[rule.id] = evaluateBadgeRule(rule, completedCourses, profileData).progress;
  }

  const earnedResult = await query<UserBadgeRow>(
    `SELECT badge_id, is_shown, earned_at
     FROM user_badges
     WHERE user_id = $1 AND badge_id = ANY($2::varchar[])
     ORDER BY earned_at DESC, badge_id`,
    [userId, effectiveIds],
  );

  const sortOrder = new Map(currentRules.map((rule) => [rule.id, rule.sort_order]));
  const pendingPopups = earnedResult.rows
    .filter((badge) => !badge.is_shown)
    .sort((a, b) => {
      const timeDiff = toTime(a.earned_at) - toTime(b.earned_at);
      return timeDiff || (sortOrder.get(a.badge_id) || 0) - (sortOrder.get(b.badge_id) || 0);
    });

  return {
    badge_definitions: currentRules.map(({
      criteria: _criteria,
      mapped_courses: _mappedCourses,
      rule_version: _ruleVersion,
      ...definition
    }) => definition),
    earned_badges: earnedResult.rows,
    newly_earned: newlyEarned.filter((badge) => effectiveIdSet.has(badge.badge_id)),
    pending_popups: pendingPopups,
    progress: progressMap,
  };
}
