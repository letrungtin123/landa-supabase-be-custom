// ═══════════════════════════════════════════════════════════════
// Enrollments Validator — Input validation
// ═══════════════════════════════════════════════════════════════

import { z } from 'zod';

/** Schema bulk enroll */
export const bulkEnrollSchema = z.object({
  user_ids: z.array(z.string().uuid()).min(1, 'user_ids không được rỗng').max(500, 'Tối đa 500 users'),
  course_id: z.string().min(1, 'course_id là bắt buộc'),
});

/** Schema bulk unenroll */
export const bulkUnenrollSchema = z.object({
  user_ids: z.array(z.string().uuid()).min(1).max(500),
  course_id: z.string().min(1),
});

export type BulkEnrollInput = z.infer<typeof bulkEnrollSchema>;
