// ═══════════════════════════════════════════════════════════════
// Groups Validator — Input validation
// ═══════════════════════════════════════════════════════════════

import { z } from 'zod';

/** Create org group */
export const createOrgGroupSchema = z.object({
  name: z.string().min(1, 'Tên là bắt buộc').max(200),
  description: z.string().max(1000).optional(),
});

/** Create sub group */
export const createSubGroupSchema = z.object({
  name: z.string().min(1, 'Tên là bắt buộc').max(200),
});

/** Create team */
export const createTeamSchema = z.object({
  name: z.string().min(1, 'Tên là bắt buộc').max(200),
});

/** Add member */
export const addMemberSchema = z.object({
  user_id: z.string().uuid('user_id phải là UUID hợp lệ'),
});

/** Assign course */
export const assignCourseSchema = z.object({
  course_id: z.string().min(1, 'course_id là bắt buộc'),
});

/** Assign category */
export const assignCategorySchema = z.object({
  category_id: z.string().uuid('category_id phải là UUID hợp lệ'),
});
