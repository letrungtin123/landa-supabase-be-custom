import { z } from 'zod';

const profileFieldSchema = z.enum([
  'bio',
  'gender',
  'country',
  'language',
  'level_of_education',
  'year_of_birth',
  'phone',
  'avatar_url',
]);

const criteriaBase = z.object({
  version: z.literal(1),
});

export const badgeCriteriaSchema = z.discriminatedUnion('type', [
  criteriaBase.extend({
    type: z.literal('profile_any'),
    profile_fields: z.array(profileFieldSchema).min(1),
  }),
  criteriaBase.extend({
    type: z.literal('completed_selected_courses'),
    threshold: z.number().int().positive(),
    requires_courses: z.literal(true),
  }),
  criteriaBase.extend({
    type: z.literal('completed_selected_plus_other'),
    selected_threshold: z.number().int().positive(),
    other_threshold: z.number().int().positive(),
    requires_courses: z.literal(true),
  }),
  criteriaBase.extend({
    type: z.literal('completed_any_courses'),
    threshold: z.number().int().positive(),
  }),
  criteriaBase.extend({
    type: z.literal('completion_within_minutes'),
    minutes: z.number().positive().max(24 * 60),
  }),
]);

export type BadgeCriteria = z.infer<typeof badgeCriteriaSchema>;

export function parseBadgeCriteria(value: unknown): BadgeCriteria | null {
  const parsed = badgeCriteriaSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function criteriaRequiresCourses(criteria: BadgeCriteria): boolean {
  return criteria.type === 'completed_selected_courses'
    || criteria.type === 'completed_selected_plus_other';
}

export function minimumMappedCourses(criteria: BadgeCriteria): number {
  switch (criteria.type) {
    case 'completed_selected_courses':
      return criteria.threshold;
    case 'completed_selected_plus_other':
      return criteria.selected_threshold;
    default:
      return 0;
  }
}

export function describeBadgeCriteria(criteria: BadgeCriteria): string {
  switch (criteria.type) {
    case 'profile_any':
      return 'Cập nhật ít nhất một thông tin hồ sơ';
    case 'completed_selected_courses':
      return `Hoàn thành ${criteria.threshold} khóa học được cấu hình`;
    case 'completed_selected_plus_other':
      return `Hoàn thành ${criteria.selected_threshold} khóa học được cấu hình và ${criteria.other_threshold} khóa học khác`;
    case 'completed_any_courses':
      return `Hoàn thành ${criteria.threshold} khóa học bất kỳ`;
    case 'completion_within_minutes':
      return `Hoàn thành một khóa học trong tối đa ${criteria.minutes} phút từ lúc ghi danh`;
  }
}
