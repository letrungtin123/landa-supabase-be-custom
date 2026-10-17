import { query } from '../../config/database.js';
import { cacheJson, getCacheJson, getCacheVersion, setCacheJson } from '../../config/cache.js';
import { CACHE_TTL, cacheKeys, cacheVersions } from '../../config/cache-keys.js';
import { isTenantModuleEnabled } from '../../middleware/tenant-module-state.js';
import {
  criteriaRequiresCourses,
  minimumMappedCourses,
  parseBadgeCriteria,
  type BadgeCriteria,
} from './badge-criteria.js';
import {
  buildBadgeAwardCandidates,
  buildBadgeOverview,
  cacheableBadgeOverview,
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

/** Module code that turns badges on for a tenant. */
export const BADGE_MODULE_CODE = 'badge_management';

export const EMPTY_BADGE_OVERVIEW: BadgeEvaluationOverview = {
  badge_definitions: [],
  earned_badges: [],
  newly_earned: [],
  pending_popups: [],
  progress: {},
};

function uniqueMappedCourses(courses: MappedCourse[]): MappedCourse[] {
  const seen = new Set<string>();
  return courses.filter((course) => {
    if (!course.course_id) return true;
    if (seen.has(course.course_id)) return false;
    seen.add(course.course_id);
    return true;
  });
}

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

    const mappedCourses = uniqueMappedCourses(Array.isArray(row.mapped_courses) ? row.mapped_courses as MappedCourse[] : []);
    const validMappedCourses = mappedCourses.filter((course) => Boolean(course.course_id) && !course.is_deleted);
    if (criteriaRequiresCourses(criteria) && validMappedCourses.length !== minimumMappedCourses(criteria)) continue;

    rules.push({
      ...row,
      sort_order: Number(row.sort_order) || 0,
      criteria,
      mapped_courses: mappedCourses,
    });
  }
  return rules;
}

/** Rules of one tenant badge-cache version (bumped by every rule, module and course change). */
function loadCachedBadgeRules(tenantId: string, version: string): Promise<EffectiveBadgeRule[]> {
  return cacheJson(
    cacheKeys.tenantResource(tenantId, 'effective-badge-rules', version),
    CACHE_TTL.badges,
    () => getEffectiveBadgeRulesFromDb(tenantId),
  );
}

export async function getEffectiveBadgeRules(tenantId: string): Promise<EffectiveBadgeRule[]> {
  // Cached module state (bumped on every tenant module change), same rule as
  // isBadgeManagementModuleEnabled.
  if (!(await isTenantModuleEnabled(tenantId, BADGE_MODULE_CODE))) return [];

  const version = await getCacheVersion(...cacheVersions.tenantBadges(tenantId));
  return loadCachedBadgeRules(tenantId, version);
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
}

/** Where the last overview of a user is kept (Redis by default; tests pass their own). */
export interface BadgeOverviewCache {
  version: (...segments: readonly unknown[]) => Promise<string>;
  read: (key: string) => Promise<{ hit: true; value: BadgeEvaluationOverview } | { hit: false; value?: undefined }>;
  write: (key: string, value: BadgeEvaluationOverview, ttlSeconds: number) => Promise<void>;
}

const redisBadgeOverviewCache: BadgeOverviewCache = {
  version: getCacheVersion,
  read: (key) => getCacheJson<BadgeEvaluationOverview>(key),
  write: (key, value, ttlSeconds) => setCacheJson(key, value, ttlSeconds),
};

/**
 * Evaluates (and awards) the user's badges, or returns the overview of the
 * last evaluation when nothing it depends on changed since: the key carries
 * the tenant badge version (rules, module, courses) and the user's badge
 * version, bumped after every change of the user's completed courses,
 * profile or badges (see invalidateUserBadgeCaches). The kept copy says
 * newly_earned: [] — what a new evaluation would answer then.
 */
export async function evaluateUserBadges(
  userId: string,
  tenantId: string,
  cache: BadgeOverviewCache = redisBadgeOverviewCache,
): Promise<BadgeEvaluationOverview> {
  if (!(await isTenantModuleEnabled(tenantId, BADGE_MODULE_CODE))) return EMPTY_BADGE_OVERVIEW;

  const [rulesVersion, userVersion] = await Promise.all([
    cache.version(...cacheVersions.tenantBadges(tenantId)),
    cache.version(...cacheVersions.userBadges(userId)),
  ]);
  const key = cacheKeys.learnerResource(tenantId, userId, 'badge-overview', [rulesVersion, userVersion]);
  const kept = await cache.read(key);
  if (kept.hit) return kept.value;

  const overview = await evaluateUserBadgesFromDb(userId, tenantId, rulesVersion);
  await cache.write(key, cacheableBadgeOverview(overview), CACHE_TTL.badgeOverview);
  return overview;
}

async function evaluateUserBadgesFromDb(
  userId: string,
  tenantId: string,
  rulesVersion: string,
): Promise<BadgeEvaluationOverview> {
  // Definitions, progress and popups use the same cached rules as the award
  // check; the award itself is validated against the database again.
  const rules = await loadCachedBadgeRules(tenantId, rulesVersion);
  if (rules.length === 0) return EMPTY_BADGE_OVERVIEW;

  const [completedCourses, profileData, ownedResult] = await Promise.all([
    loadCompletedCourses(userId, tenantId),
    loadProfile(userId, tenantId),
    query<UserBadgeRow>(
      `SELECT badge_id, is_shown, earned_at
       FROM user_badges
       WHERE user_id = $1
       ORDER BY earned_at DESC, badge_id`,
      [userId],
    ),
  ]);
  const existingIds = new Set(ownedResult.rows.map((row) => row.badge_id));
  const awardCandidates = rules.filter((rule) => {
    const result = evaluateBadgeRule(rule, completedCourses, profileData);
    return result.achieved && !existingIds.has(rule.id);
  });
  // Writes only when a badge is actually earned now.
  const newlyEarned = await insertValidatedBadgeAwards(userId, tenantId, awardCandidates);

  const effectiveIds = rules.map((rule) => rule.id);
  const effectiveIdSet = new Set(effectiveIds);
  const earnedRows = newlyEarned.length > 0
    ? (await query<UserBadgeRow>(
        `SELECT badge_id, is_shown, earned_at
         FROM user_badges
         WHERE user_id = $1 AND badge_id = ANY($2::varchar[])
         ORDER BY earned_at DESC, badge_id`,
        [userId, effectiveIds],
      )).rows
    // Same rows and order as that query: nothing was inserted since.
    : ownedResult.rows.filter((row) => effectiveIdSet.has(row.badge_id));

  return buildBadgeOverview({
    rules,
    completedCourses,
    profile: profileData,
    earnedRows,
    newlyEarned,
  });
}
