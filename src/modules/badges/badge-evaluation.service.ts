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
import {
  createBadgeEvaluationRepository,
  type BadgeEvaluationDb,
  type UserBadgeRow,
} from './badge-evaluation.repository.js';

export type { UserBadgeRow } from './badge-evaluation.repository.js';

const poolDb: BadgeEvaluationDb = { query };
const evaluationRepository = createBadgeEvaluationRepository(poolDb);

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
  return evaluationRepository.badgeModuleEnabled(tenantId);
}

async function getEffectiveBadgeRulesFromDb(tenantId: string): Promise<EffectiveBadgeRule[]> {
  const rows = await evaluationRepository.selectEffectiveBadgeRules(tenantId);

  const rules: EffectiveBadgeRule[] = [];
  for (const row of rows) {
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
  return evaluationRepository.selectCompletedCourses(userId, tenantId);
}

async function loadProfile(userId: string, tenantId: string): Promise<UserProfile> {
  return (await evaluationRepository.selectProfile(userId, tenantId)) || {};
}

async function insertValidatedBadgeAwards(
  userId: string,
  tenantId: string,
  rules: EffectiveBadgeRule[],
): Promise<UserBadgeRow[]> {
  if (rules.length === 0) return [];

  const candidates = buildBadgeAwardCandidates(rules);

  return evaluationRepository.insertValidatedAwards(userId, tenantId, candidates);
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

  const [completedCourses, profileData, ownedRows] = await Promise.all([
    loadCompletedCourses(userId, tenantId),
    loadProfile(userId, tenantId),
    evaluationRepository.selectOwnedBadges(userId),
  ]);
  const existingIds = new Set(ownedRows.map((row) => row.badge_id));
  const awardCandidates = rules.filter((rule) => {
    const result = evaluateBadgeRule(rule, completedCourses, profileData);
    return result.achieved && !existingIds.has(rule.id);
  });
  // Writes only when a badge is actually earned now.
  const newlyEarned = await insertValidatedBadgeAwards(userId, tenantId, awardCandidates);

  const effectiveIds = rules.map((rule) => rule.id);
  const effectiveIdSet = new Set(effectiveIds);
  const earnedRows = newlyEarned.length > 0
    ? await evaluationRepository.selectEarnedBadges(userId, effectiveIds)
    // Same rows and order as that query: nothing was inserted since.
    : ownedRows.filter((row) => effectiveIdSet.has(row.badge_id));

  return buildBadgeOverview({
    rules,
    completedCourses,
    profile: profileData,
    earnedRows,
    newlyEarned,
  });
}
