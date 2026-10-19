// ═══════════════════════════════════════════════════════════════
// Course Categories Validator — Zod schemas
// ═══════════════════════════════════════════════════════════════

import { z } from 'zod';
import { fitsChars } from '../../utils/text-length.js';

// ── Query strings ──
// The query strings of the course category list and public impact routes,
// read the way the controller and service always read them. They never
// reject and never coerce: every request accepted before is accepted with
// the same values (a repeated parameter stays a list, an absent key stays
// absent). Only the keys they read are kept.

/** The raw value, unchecked. */
const rawQueryValue = z.unknown();

/** GET /api/course-categories */
export const courseCategoryListQuerySchema = z.object({
  page: rawQueryValue,
  page_size: rawQueryValue,
  search: rawQueryValue,
  assigned_team_id: rawQueryValue,
});

/** GET /api/course-categories/:id/public-impact */
export const publicImpactQuerySchema = z.object({
  limit: rawQueryValue,
});

// ── Bodies ──

/** Code of every refused course category body (docs/error-codes.md). */
export const COURSE_CATEGORY_INPUT_INVALID_CODE = 'COURSE_CATEGORY_INPUT_INVALID';
export const COURSE_CATEGORY_NAME_REQUIRED_MESSAGE = 'Vui lòng nhập tên danh mục khóa học.';
/** course_categories.name is VARCHAR(200). */
export const COURSE_CATEGORY_NAME_MAX_CHARS = 200;

/**
 * POST /api/course-categories. A body without a name (or no JSON body at all)
 * used to fail with a 500; the dashboard always sends a trimmed, non-empty
 * name, a description string and a numeric sort order.
 */
export const createCourseCategoryBodySchema = z.object(
  {
    name: z
      .string({
        required_error: COURSE_CATEGORY_NAME_REQUIRED_MESSAGE,
        invalid_type_error: COURSE_CATEGORY_NAME_REQUIRED_MESSAGE,
      })
      .refine(value => value.trim() !== '', COURSE_CATEGORY_NAME_REQUIRED_MESSAGE)
      .refine(
        value => fitsChars(value, COURSE_CATEGORY_NAME_MAX_CHARS),
        `Tên danh mục khóa học tối đa ${COURSE_CATEGORY_NAME_MAX_CHARS} ký tự.`,
      ),
    description: z
      .string({ invalid_type_error: 'Mô tả danh mục khóa học không hợp lệ.' })
      .nullable()
      .optional(),
    sort_order: z
      .number({ invalid_type_error: 'Thứ tự hiển thị của danh mục phải là số nguyên.' })
      .int('Thứ tự hiển thị của danh mục phải là số nguyên.')
      .min(-2147483648, 'Thứ tự hiển thị của danh mục phải là số nguyên.')
      .max(2147483647, 'Thứ tự hiển thị của danh mục phải là số nguyên.')
      .nullable()
      .optional(),
  },
  {
    required_error: COURSE_CATEGORY_NAME_REQUIRED_MESSAGE,
    invalid_type_error: COURSE_CATEGORY_NAME_REQUIRED_MESSAGE,
  },
);
