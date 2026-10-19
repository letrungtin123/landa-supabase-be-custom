// ═══════════════════════════════════════════════════════════════
// Courses Validator — Zod schemas for input validation
// ═══════════════════════════════════════════════════════════════

import { z } from 'zod';

const requiredTrimmedString = (message: string, max: number) =>
  z.string().trim().min(1, message).max(max);

/** Schema tạo course */
export const createCourseSchema = z.object({
  id: requiredTrimmedString('id is required', 255),
  display_name: requiredTrimmedString('display_name is required', 500),
  description: requiredTrimmedString('description is required', 5000),
  org: z.string().trim().max(255).optional(),
  visible_to_staff_only: z.boolean().optional(),
  image_url: z.string().max(1000).optional(),
  start_date: z.string().nullable().optional(),
  end_date: z.string().nullable().optional(),
  is_active: z.boolean().optional(),
  cover_url: z.string().max(1000).optional(),
});

/** Schema cập nhật course */
export const updateCourseSchema = z.object({
  display_name: requiredTrimmedString('display_name is required', 500).optional(),
  description: requiredTrimmedString('description is required', 5000).optional(),
  visible_to_staff_only: z.boolean().optional(),
  image_url: z.string().max(1000).optional(),
  is_active: z.boolean().optional(),
  cover_url: z.string().max(1000).optional(),
  start_date: z.string().optional(),
  end_date: z.string().nullable().optional(),
}).refine(data => Object.keys(data).length > 0, 'Cần ít nhất 1 field để cập nhật');

/** Schema bulk action */
export const bulkActionSchema = z.object({
  ids: z.array(z.string()).min(1, 'ids không được rỗng').max(100, 'Tối đa 100 items'),
  action: z.enum(['staff_only', 'public']),
});

export const mentorSectionSchema = z.object({
  description: z.string().max(2000, 'description tối đa 2000 ký tự').nullable().optional(),
});

export const mentorSectionLogoModeSchema = z.enum(['light', 'dark']);

export const MENTOR_SECTION_LOGO_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/svg+xml',
  'image/gif',
] as const;

export const MENTOR_SECTION_LOGO_MAX_SIZE = 5 * 1024 * 1024;

export type CreateCourseInput = z.infer<typeof createCourseSchema>;
export type UpdateCourseInput = z.infer<typeof updateCourseSchema>;
export type BulkActionInput = z.infer<typeof bulkActionSchema>;
export type MentorSectionInput = z.infer<typeof mentorSectionSchema>;


// ── Query strings ──
// The query string of the course list routes, read the way the services
// always read it. They never reject and never coerce: every request accepted
// before is accepted with the same values (a repeated parameter stays a list,
// a page that is not a number is read by the service as before). Only the
// keys a service reads are kept.

/** The raw value, unchecked. */
const rawQueryValue = z.unknown();

/** GET /api/courses */
export const courseListQuerySchema = z.object({
  page: rawQueryValue,
  page_size: rawQueryValue,
  search: rawQueryValue,
  visibility: rawQueryValue,
});

/** GET /api/courses/:id/mentor-candidates */
export const mentorCandidatesQuerySchema = z.object({
  page: rawQueryValue,
  page_size: rawQueryValue,
  search: rawQueryValue,
});

/** GET /api/courses/:id/mentor-history */
export const mentorHistoryQuerySchema = z.object({
  page: rawQueryValue,
  page_size: rawQueryValue,
  search: rawQueryValue,
  date_from: rawQueryValue,
  date_to: rawQueryValue,
});

/** GET /api/courses/:id/section-modal-config (checked for presence in the controller). */
export const sectionModalQuerySchema = z.object({
  section_id: z.unknown().transform(value => value as string),
});
