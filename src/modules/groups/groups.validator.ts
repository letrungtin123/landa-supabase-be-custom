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
