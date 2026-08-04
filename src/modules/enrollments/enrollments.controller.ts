// ═══════════════════════════════════════════════════════════════
// Enrollments Controller — HTTP handlers
// ═══════════════════════════════════════════════════════════════

import type { Request, Response } from 'express';
import { sendSuccess, sendError } from '../../utils/response.js';
import * as svc from './enrollments.service.js';
import { bulkEnrollSchema } from './enrollments.validator.js';
import { isDemoIframeSession } from '../demo-login/demo-iframe.service.js';
import { auditFromReq } from '../../middleware/audit-log.js';

const VALID_GRANULARITIES = new Set(['day', 'month', 'year']);

/** POST /api/enrollments — Enroll user(s) into a course */
export async function enroll(req: Request, res: Response) {
  const { user_id, user_ids, course_id } = req.body;
  const tenantId = req.user!.tenantId!;

  if (!course_id) return sendError(res, 'course_id is required', 400);

  // Bulk enroll — validate input
  if (Array.isArray(user_ids) && user_ids.length > 0) {
    const parsed = bulkEnrollSchema.safeParse({ user_ids, course_id });
    if (!parsed.success) return sendError(res, parsed.error.errors[0].message, 400);
    const result = await svc.bulkEnroll(parsed.data.user_ids, parsed.data.course_id, tenantId);
    const courseName = await svc.getCourseAuditName(parsed.data.course_id, tenantId);
    auditFromReq(req, 'CREATE', 'enrollment', parsed.data.course_id, courseName, `Bulk enroll: ${result.enrolled} learner, skipped ${result.skipped}`);
    return sendSuccess(res, result, undefined, 201);
  }

  // Single enroll
  if (!user_id) return sendError(res, 'user_id or user_ids is required', 400);

  const result = await svc.enrollUser(user_id, course_id, tenantId);
  const auditContext = await svc.getEnrollmentAuditContext(user_id, course_id, tenantId);
  auditFromReq(req, result.already_enrolled ? 'UPDATE' : 'CREATE', 'enrollment', result.enrollment_id, auditContext.course_name, `Ghi danh ${auditContext.username}`);
  sendSuccess(res, result, undefined, result.already_enrolled ? 200 : 201);
}

/** DELETE /api/enrollments — Unenroll user from course */
export async function unenroll(req: Request, res: Response) {
  const { user_id, course_id } = req.body;
  if (!user_id || !course_id) return sendError(res, 'user_id and course_id are required', 400);

  const success = await svc.unenrollUser(user_id, course_id);
  if (!success) return sendError(res, 'Enrollment not found', 404);
  const auditContext = await svc.getEnrollmentAuditContext(user_id, course_id, req.user!.tenantId!);
  auditFromReq(req, 'DELETE', 'enrollment', `${user_id}:${course_id}`, auditContext.course_name, `Hủy ghi danh ${auditContext.username}`);
  sendSuccess(res, { success: true });
}

/** PATCH /api/enrollments/progress — Update progress */
export async function updateProgress(req: Request, res: Response) {
  const { user_id, course_id, progress } = req.body;
  if (!user_id || !course_id || progress === undefined) {
    return sendError(res, 'user_id, course_id, progress are required', 400);
  }

  await svc.updateProgress(user_id, course_id, progress);
  const auditContext = await svc.getEnrollmentAuditContext(user_id, course_id, req.user!.tenantId!);
  auditFromReq(req, 'UPDATE', 'enrollment', `${user_id}:${course_id}`, auditContext.course_name, `Cập nhật tiến độ ${auditContext.username}: ${progress}%`);
  sendSuccess(res, { success: true });
}

/** POST /api/enrollments/study-session — Record study time */
export async function recordStudySession(req: Request, res: Response) {
  const { course_id, duration_minutes, started_at, entries } = req.body;
  const userId = req.user!.id;
  const tenantId = req.user!.tenantId!;

  if (isDemoIframeSession(req.user)) {
    return sendSuccess(res, { success: true, synced: Array.isArray(entries) ? 0 : undefined, demo_iframe: true });
  }

  if (Array.isArray(entries)) {
    if (entries.length > 370) {
      return sendError(res, 'Danh sách entries không được vượt quá 370 mục', 400);
    }

    const normalized = entries.map((entry: any) => ({
      date: String(entry.date || ''),
      minutes: Number(entry.minutes || 0),
      course_id: entry.course_id || null,
    }));

    const result = await svc.recordStudySessionEntries(userId, tenantId, normalized);
    return sendSuccess(res, { success: true, synced: result.synced });
  }

  if (!duration_minutes) {
    return sendError(res, 'duration_minutes is required', 400);
  }

  await svc.recordStudySession(userId, course_id || null, tenantId, duration_minutes, started_at);
  sendSuccess(res, { success: true });
}

/** GET /api/enrollments/weekly-study-time — Weekly study time for current user */
export async function getWeeklyStudyTime(req: Request, res: Response) {
  const userId = req.user!.id;
  const tenantId = req.user!.tenantId!;
  const granularity = req.query.granularity as string | undefined;

  if (granularity && !VALID_GRANULARITIES.has(granularity)) {
    return sendError(res, 'granularity must be day, month, or year', 400);
  }

  const result = await svc.getWeeklyStudyTime(userId, tenantId, {
    from: req.query.from as string | undefined,
    to: req.query.to as string | undefined,
    granularity: granularity as svc.StudyTimeGranularity | undefined,
  });
  sendSuccess(res, result);
}

/** GET /api/enrollments/user/:userId — User's enrolled courses */
export async function getUserEnrollments(req: Request, res: Response) {
  const { userId } = req.params;
  const tenantId = req.user!.tenantId!;
  const page = parseInt(req.query.page as string) || 1;
  const pageSize = Math.min(parseInt(req.query.page_size as string) || 10, 100);
  const search = (req.query.search as string) || '';

  const result = await svc.getUserEnrollments(userId, tenantId, page, pageSize, search);
  sendSuccess(res, {
    ...result,
    page,
    pageSize,
    totalPages: Math.ceil(result.total / pageSize),
  });
}

/** GET /api/enrollments/course/:courseId — Course's enrolled users */
export async function getCourseEnrollments(req: Request, res: Response) {
  const { courseId } = req.params;
  const tenantId = req.user!.tenantId!;
  const page = parseInt(req.query.page as string) || 1;
  const pageSize = Math.min(parseInt(req.query.page_size as string) || 20, 100);
  const search = (req.query.search as string) || '';
  const status = (req.query.status as string) || 'all';

  const result = await svc.getCourseEnrollments(
    courseId, tenantId, page, pageSize, search,
    status as 'all' | 'not_started' | 'learning' | 'completed',
  );
  sendSuccess(res, {
    ...result,
    page,
    pageSize,
    totalPages: Math.ceil(result.total / pageSize),
  });
}
