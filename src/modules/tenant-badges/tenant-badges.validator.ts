import { z } from 'zod';

export const updateTenantBadgeRuleSchema = z.object({
  is_enabled: z.boolean(),
  course_ids: z.array(z.string().trim().min(1).max(255)).max(500).optional(),
}).superRefine((value, ctx) => {
  if (!value.course_ids) return;
  if (new Set(value.course_ids).size !== value.course_ids.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['course_ids'],
      message: 'Danh sách khóa học bị trùng',
    });
  }
});

export type UpdateTenantBadgeRuleInput = z.infer<typeof updateTenantBadgeRuleSchema>;

// ── Query strings ──
// The query string of GET /api/tenant-badges/courses, read the way the
// service always read it. It never rejects and never coerces: every request
// accepted before is accepted with the same values (a repeated parameter
// stays a list). Only the keys the service reads are kept.

/** The raw value, unchecked. */
const rawQueryValue = z.unknown();

/** GET /api/tenant-badges/courses */
export const selectableCoursesQuerySchema = z.object({
  page: rawQueryValue,
  page_size: rawQueryValue,
  search: rawQueryValue,
});
