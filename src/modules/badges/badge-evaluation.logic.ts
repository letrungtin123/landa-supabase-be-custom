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

export function buildBadgeAwardCandidates(rules: AwardCandidateRule[]): BadgeAwardCandidate[] {
  return rules.map((rule) => ({
    badge_id: rule.id,
    rule_version: rule.rule_version,
    criteria: rule.criteria,
    mapped_course_ids: rule.mapped_courses
      .filter((course) => course.course_id && !course.is_deleted)
      .map((course) => course.course_id as string)
      .sort(),
  }));
}
