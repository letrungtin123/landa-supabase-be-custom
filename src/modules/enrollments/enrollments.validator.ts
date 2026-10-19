// ═══════════════════════════════════════════════════════════════
// Enrollments Validator — Input validation
// ═══════════════════════════════════════════════════════════════

import { z } from 'zod';

/** Schema bulk enroll */
export const bulkEnrollSchema = z.object({
  user_ids: z.array(z.string().uuid()).min(1, 'user_ids không được rỗng').max(500, 'Tối đa 500 users'),
  course_id: z.string().min(1, 'course_id là bắt buộc'),
});

/** Single enroll: the learner id */
export const singleEnrollUserIdSchema = z.string().uuid();

/** Schema bulk unenroll */
export const bulkUnenrollSchema = z.object({
  user_ids: z.array(z.string().uuid()).min(1).max(500),
  course_id: z.string().min(1),
});

export type BulkEnrollInput = z.infer<typeof bulkEnrollSchema>;

// ── Query strings ──
// The query strings of the enrollment list and study time routes, read the
// way the controller always read them. They never reject and never coerce:
// every request accepted before is accepted with the same values (a repeated
// parameter stays a list). Only the keys the controller reads are kept.

/** The raw value, unchecked. */
const rawQueryValue = z.unknown();

/** GET /api/enrollments/weekly-study-time */
export const studyTimeQuerySchema = z.object({
  from: rawQueryValue,
  to: rawQueryValue,
  granularity: rawQueryValue,
});

/** GET /api/enrollments/user/:userId */
export const userEnrollmentsQuerySchema = z.object({
  page: rawQueryValue,
  page_size: rawQueryValue,
  search: rawQueryValue,
});

/** GET /api/enrollments/course/:courseId */
export const courseEnrollmentsQuerySchema = z.object({
  page: rawQueryValue,
  page_size: rawQueryValue,
  search: rawQueryValue,
  status: rawQueryValue,
});
