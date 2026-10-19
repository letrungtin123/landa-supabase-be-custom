// ═══════════════════════════════════════════════════════════════
// Groups Validator — Input validation
// ═══════════════════════════════════════════════════════════════

import { z } from 'zod';
import { isUuid } from '../../utils/uuid.js';

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

/** Code of a refused team course category assignment (docs/error-codes.md). */
export const TEAM_COURSE_CATEGORY_IDS_INVALID_CODE = 'TEAM_COURSE_CATEGORY_IDS_INVALID';
export const TEAM_COURSE_CATEGORY_IDS_INVALID_MESSAGE = 'Danh sách danh mục khóa học không hợp lệ. Vui lòng tải lại trang và chọn lại.';
/**
 * The most course categories one assignment request may name. The dashboard
 * can select every assignable category of the tenant across its pages (12 at
 * most per tenant on the local database, 2026-10-19); each id is one insert.
 */
export const TEAM_COURSE_CATEGORY_MAX_IDS = 500;

/** POST /api/groups/teams/:teamId/course-categories: a JSON object (a non-list category_ids keeps its own answer). */
export const assignTeamCourseCategoriesBodySchema = z.object(
  { category_ids: z.unknown() },
  { required_error: TEAM_COURSE_CATEGORY_IDS_INVALID_MESSAGE, invalid_type_error: TEAM_COURSE_CATEGORY_IDS_INVALID_MESSAGE },
);

/** Its category_ids list: UUIDs (anything else used to fail in the database with a 500), at most the cap. */
export const teamCourseCategoryIdsSchema = z
  .array(
    z
      .string({ invalid_type_error: TEAM_COURSE_CATEGORY_IDS_INVALID_MESSAGE })
      .uuid(TEAM_COURSE_CATEGORY_IDS_INVALID_MESSAGE),
  )
  .max(
    TEAM_COURSE_CATEGORY_MAX_IDS,
    `Mỗi lần chỉ gán được tối đa ${TEAM_COURSE_CATEGORY_MAX_IDS} danh mục khóa học.`,
  );

/** Code of a refused team document category assignment (docs/error-codes.md). */
export const TEAM_DOCUMENT_CATEGORY_IDS_INVALID_CODE = 'TEAM_DOCUMENT_CATEGORY_IDS_INVALID';
export const TEAM_DOCUMENT_CATEGORY_IDS_INVALID_MESSAGE = 'Danh sách danh mục tài liệu không hợp lệ. Vui lòng tải lại trang và chọn lại.';
/**
 * The most items one document category assignment request may send. The
 * dashboard (AssignCategoriesModal) sends ids from the server's own list and
 * can select every assignable category of the tenant across pages, with no
 * client cap; each id is one insert.
 */
export const TEAM_DOCUMENT_CATEGORY_MAX_IDS = 500;

/** POST /api/groups/teams/:teamId/categories: a JSON object (a non-list category_ids keeps its own answer). */
export const assignTeamDocCategoriesBodySchema = z.object(
  { category_ids: z.unknown() },
  { required_error: TEAM_DOCUMENT_CATEGORY_IDS_INVALID_MESSAGE, invalid_type_error: TEAM_DOCUMENT_CATEGORY_IDS_INVALID_MESSAGE },
);

/**
 * Its category_ids list, at most the cap. assignTeamDocCategories skips an
 * item that is not text or is blank, trims the others and assigns a repeated
 * id once, so those requests keep working as before. A trimmed id that is not
 * a UUID used to fail the $2::uuid cast in the database (500, after the
 * earlier inserts of the request had run in its transaction): it is refused.
 * The texts go on as sent; the service still trims them.
 */
export const teamDocCategoryIdsSchema = z
  .array(z.unknown())
  .max(
    TEAM_DOCUMENT_CATEGORY_MAX_IDS,
    `Mỗi lần chỉ gán được tối đa ${TEAM_DOCUMENT_CATEGORY_MAX_IDS} danh mục tài liệu.`,
  )
  .refine(
    ids => ids.every(id => typeof id !== 'string' || id.trim() === '' || isUuid(id.trim())),
    TEAM_DOCUMENT_CATEGORY_IDS_INVALID_MESSAGE,
  )
  .transform(ids => ids.filter((id): id is string => typeof id === 'string'));

/** Assign category */
export const assignCategorySchema = z.object({
  category_id: z.string().uuid('category_id phải là UUID hợp lệ'),
});

// ── Query strings ──
// The query string of the group list routes, read the way the service always
// read it. They never reject and never coerce: every request accepted before
// is accepted with the same values (a repeated parameter stays a list, a page
// that is not a number is read by the service as before). Only the keys the
// service reads are kept.

/** The raw value, unchecked. */
const rawQueryValue = z.unknown();

/** GET /api/groups, GET /api/groups/teams/:teamId/members|categories|course-categories */
export const groupPageQuerySchema = z.object({
  page: rawQueryValue,
  page_size: rawQueryValue,
  search: rawQueryValue,
});

/** GET /api/groups/:groupId/subgroups, GET /api/groups/subgroups/:subgroupId/teams */
export const groupSearchQuerySchema = z.object({
  search: rawQueryValue,
});

/** GET /api/groups/audit-logs */
export const groupAuditLogsQuerySchema = z.object({
  page: rawQueryValue,
  page_size: rawQueryValue,
  search: rawQueryValue,
  action: rawQueryValue,
  date_from: rawQueryValue,
  date_to: rawQueryValue,
});
