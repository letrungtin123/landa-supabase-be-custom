// ═══════════════════════════════════════════════════════════════
// Enrollments Validator — Input validation
// ═══════════════════════════════════════════════════════════════

import { z } from 'zod';

/** Schema bulk enroll */
export const bulkEnrollSchema = z.object({
  user_ids: z.array(z.string().uuid()).min(1, 'user_ids không được rỗng').max(500, 'Tối đa 500 users'),
  course_id: z.string().min(1, 'course_id là bắt buộc'),
});

/** Code of a refused enrollment body (docs/error-codes.md). */
export const ENROLLMENT_INPUT_INVALID_CODE = 'ENROLLMENT_INPUT_INVALID';
export const ENROLLMENT_INPUT_INVALID_MESSAGE = 'Vui lòng chọn khóa học và học viên cần ghi danh.';

/**
 * POST /api/enrollments: the body must be a JSON object and course_id text
 * (no JSON body at all used to fail with a 500). The learner ids and a
 * missing course keep their own checks and answers in the controller.
 */
export const enrollBodySchema = z.object(
  {
    user_id: z.unknown(),
    user_ids: z.unknown(),
    course_id: z.string({ invalid_type_error: ENROLLMENT_INPUT_INVALID_MESSAGE }).nullable().optional(),
  },
  { required_error: ENROLLMENT_INPUT_INVALID_MESSAGE, invalid_type_error: ENROLLMENT_INPUT_INVALID_MESSAGE },
);

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
