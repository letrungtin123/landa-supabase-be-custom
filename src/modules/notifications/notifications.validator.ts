// ═══════════════════════════════════════════════════════════════
// Notifications Validator — Zod schemas
// ═══════════════════════════════════════════════════════════════

import { z } from 'zod';
import { fitsChars } from '../../utils/text-length.js';

// ── Query strings ──
// The query string of GET /api/notifications, read the way the service
// always read it. It never rejects and never coerces: every request accepted
// before is accepted with the same values (a repeated parameter stays a
// list). Only the keys the service reads are kept.

/** The raw value, unchecked. */
const rawQueryValue = z.unknown();

/** GET /api/notifications */
export const notificationListQuerySchema = z.object({
  page: rawQueryValue,
  page_size: rawQueryValue,
  search: rawQueryValue,
  course_id: rawQueryValue,
});

// ── Bodies ──

/** Code of a refused notification body (docs/error-codes.md). */
export const NOTIFICATION_INPUT_INVALID_CODE = 'NOTIFICATION_INPUT_INVALID';
export const NOTIFICATION_INPUT_REQUIRED_MESSAGE = 'Vui lòng chọn khóa học và nhập tiêu đề thông báo.';
/** notifications.title is VARCHAR(500). */
export const NOTIFICATION_TITLE_MAX_CHARS = 500;

/**
 * POST /api/notifications: the body must be a JSON object and its fields
 * text (no JSON body at all, or a title over the column, used to fail with a
 * 500). A missing course or title keeps its own answer in the controller.
 */
export const sendNotificationBodySchema = z.object(
  {
    course_id: z.string({ invalid_type_error: NOTIFICATION_INPUT_REQUIRED_MESSAGE }).nullable().optional(),
    title: z
      .string({ invalid_type_error: NOTIFICATION_INPUT_REQUIRED_MESSAGE })
      .refine(
        value => fitsChars(value, NOTIFICATION_TITLE_MAX_CHARS),
        `Tiêu đề thông báo tối đa ${NOTIFICATION_TITLE_MAX_CHARS} ký tự.`,
      )
      .nullable()
      .optional(),
    message: z.string({ invalid_type_error: 'Nội dung thông báo không hợp lệ.' }).nullable().optional(),
  },
  {
    required_error: NOTIFICATION_INPUT_REQUIRED_MESSAGE,
    invalid_type_error: NOTIFICATION_INPUT_REQUIRED_MESSAGE,
  },
);
