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
