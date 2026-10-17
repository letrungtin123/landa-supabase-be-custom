import type { BadgeCriteria } from './badge-criteria.js';

export type MappedCourse = {
  course_id: string | null;
  course_name: string;
  is_deleted: boolean;
};

export type CompletedCourseFact = {
  course_id: string;
  enrolled_at: string | Date;
  completed_at: string | Date;
};

export type UserProfile = Record<string, unknown>;

export type BadgeProgress = {
  current: number;
  target: number;
  percent: number;
  unit_label: string;
};

export type EvaluatableBadgeRule = {
  criteria: BadgeCriteria;
  mapped_courses: MappedCourse[];
};

export type BadgeAwardCandidate = {
  badge_id: string;
  rule_version: string;
  criteria: BadgeCriteria;
  mapped_course_ids: string[];
};

type AwardCandidateRule = EvaluatableBadgeRule & {
  id: string;
  rule_version: string;
};

function progress(current: number, target: number, unitLabel: string): BadgeProgress {
  return {
    current,
    target,
    percent: target > 0 ? Math.min(100, Math.round((current / target) * 100)) : 0,
    unit_label: unitLabel,
  };
}

function hasProfileValue(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function toTime(value: string | Date): number {
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Number.NaN;
}

export function evaluateBadgeRule(
  rule: EvaluatableBadgeRule,
  completedCourses: CompletedCourseFact[],
  profileData: UserProfile,
): { achieved: boolean; progress: BadgeProgress } {
  const completedIds = new Set(completedCourses.map((course) => course.course_id));
  const mappedIds = new Set(
    rule.mapped_courses
      .filter((course) => !course.is_deleted)
      .map((course) => course.course_id)
      .filter((courseId): courseId is string => Boolean(courseId)),
  );

  switch (rule.criteria.type) {
    case 'profile_any': {
      const completed = rule.criteria.profile_fields.some((field) => hasProfileValue(profileData[field]));
      return { achieved: completed, progress: progress(completed ? 1 : 0, 1, 'hồ sơ') };
    }
    case 'completed_selected_courses': {
      const current = [...completedIds].filter((courseId) => mappedIds.has(courseId)).length;
      return {
        achieved: current >= rule.criteria.threshold,
        progress: progress(current, rule.criteria.threshold, 'khóa'),
      };
    }
    case 'completed_selected_plus_other': {
      const selectedCount = [...completedIds].filter((courseId) => mappedIds.has(courseId)).length;
      const selectedForThreshold = Math.min(selectedCount, rule.criteria.selected_threshold);
      const otherCount = Math.max(0, completedIds.size - selectedForThreshold);
      const achieved = selectedCount >= rule.criteria.selected_threshold
        && otherCount >= rule.criteria.other_threshold;
      const current = selectedForThreshold + Math.min(otherCount, rule.criteria.other_threshold);
      const target = rule.criteria.selected_threshold + rule.criteria.other_threshold;
      return { achieved, progress: progress(current, target, 'khóa') };
    }
    case 'completed_any_courses': {
      const current = completedIds.size;
      return {
        achieved: current >= rule.criteria.threshold,
        progress: progress(current, rule.criteria.threshold, 'khóa'),
      };
    }
    case 'completion_within_minutes': {
      const limitMs = rule.criteria.minutes * 60_000;
      const completed = completedCourses.some((course) => {
        const enrolledAt = toTime(course.enrolled_at);
        const completedAt = toTime(course.completed_at);
        const duration = completedAt - enrolledAt;
        return Number.isFinite(duration) && duration >= 0 && duration <= limitMs;
      });
      return { achieved: completed, progress: progress(completed ? 1 : 0, 1, 'khóa') };
    }
  }
}

/** One user_badges row as the learner endpoints return it. */
export type EarnedBadgeRow = {
  badge_id: string;
  is_shown: boolean;
  earned_at: string | Date;
};

/** A rule as loaded for a tenant; only id and sort_order are read here besides the criteria. */
export type OverviewBadgeRule = EvaluatableBadgeRule & {
  id: string;
  sort_order: number;
  rule_version: string;
};

export type BadgeOverview<Rule extends OverviewBadgeRule, Row extends EarnedBadgeRow> = {
  badge_definitions: Array<Omit<Rule, 'criteria' | 'mapped_courses' | 'rule_version'>>;
  earned_badges: Row[];
  newly_earned: Row[];
  pending_popups: Row[];
  progress: Record<string, BadgeProgress>;
};

/**
 * The learner badge overview. `earnedRows` are the user's badges of the
 * effective rules, ordered by earned_at DESC, badge_id (as read from the
 * database); `newlyEarned` are the rows this evaluation inserted.
 */
export function buildBadgeOverview<Rule extends OverviewBadgeRule, Row extends EarnedBadgeRow>(input: {
  rules: Rule[];
  completedCourses: CompletedCourseFact[];
  profile: UserProfile;
  earnedRows: Row[];
  newlyEarned: Row[];
}): BadgeOverview<Rule, Row> {
  const { rules, completedCourses, profile, earnedRows, newlyEarned } = input;
  const effectiveIdSet = new Set(rules.map((rule) => rule.id));
  const progressMap: Record<string, BadgeProgress> = {};
  for (const rule of rules) {
    progressMap[rule.id] = evaluateBadgeRule(rule, completedCourses, profile).progress;
  }

  const sortOrder = new Map(rules.map((rule) => [rule.id, rule.sort_order]));
  const pendingPopups = earnedRows
    .filter((badge) => !badge.is_shown)
    .sort((a, b) => {
      const timeDiff = toTime(a.earned_at) - toTime(b.earned_at);
      return timeDiff || (sortOrder.get(a.badge_id) || 0) - (sortOrder.get(b.badge_id) || 0);
    });

  return {
    badge_definitions: rules.map(({
      criteria: _criteria,
      mapped_courses: _mappedCourses,
      rule_version: _ruleVersion,
      ...definition
    }) => definition),
    earned_badges: earnedRows,
    newly_earned: newlyEarned.filter((badge) => effectiveIdSet.has(badge.badge_id)),
    pending_popups: pendingPopups,
    progress: progressMap,
  };
}

/**
 * What is kept between evaluations: a later read inserted nothing, so it
 * reports no newly earned badge (the same answer a new evaluation gives).
 */
export function cacheableBadgeOverview<T extends { newly_earned: unknown[] }>(overview: T): T {
  return { ...overview, newly_earned: [] };
}

export function buildBadgeAwardCandidates(rules: AwardCandidateRule[]): BadgeAwardCandidate[] {
  return rules.map((rule) => ({
    badge_id: rule.id,
    rule_version: rule.rule_version,
    criteria: rule.criteria,
    mapped_course_ids: Array.from(new Set(
      rule.mapped_courses
        .filter((course) => course.course_id && !course.is_deleted)
        .map((course) => course.course_id as string),
    )).sort(),
  }));
}
