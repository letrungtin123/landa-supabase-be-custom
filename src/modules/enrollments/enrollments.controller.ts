// ═══════════════════════════════════════════════════════════════
// Enrollments Controller — HTTP handlers
// ═══════════════════════════════════════════════════════════════

import type { Request, Response } from 'express';
import { sendSuccess, sendError } from '../../utils/response.js';
import * as svc from './enrollments.service.js';

/** POST /api/enrollments — Enroll user(s) into a course */
export async function enroll(req: Request, res: Response) {
  const { user_id, user_ids, course_id } = req.body;
  const tenantId = req.user!.tenantId!;

  if (!course_id) return sendError(res, 'course_id is required', 400);

  // Bulk enroll
  if (Array.isArray(user_ids) && user_ids.length > 0) {
    const result = await svc.bulkEnroll(user_ids, course_id, tenantId);
    return sendSuccess(res, result, undefined, 201);
  }

  // Single enroll
  if (!user_id) return sendError(res, 'user_id or user_ids is required', 400);

  const result = await svc.enrollUser(user_id, course_id, tenantId);
  sendSuccess(res, result, undefined, result.already_enrolled ? 200 : 201);
}

/** DELETE /api/enrollments — Unenroll user from course */
export async function unenroll(req: Request, res: Response) {
  const { user_id, course_id } = req.body;
  if (!user_id || !course_id) return sendError(res, 'user_id and course_id are required', 400);

  const success = await svc.unenrollUser(user_id, course_id);
  if (!success) return sendError(res, 'Enrollment not found', 404);
  sendSuccess(res, { success: true });
}

/** PATCH /api/enrollments/progress — Update progress */
export async function updateProgress(req: Request, res: Response) {
  const { user_id, course_id, progress } = req.body;
  if (!user_id || !course_id || progress === undefined) {
    return sendError(res, 'user_id, course_id, progress are required', 400);
  }

  await svc.updateProgress(user_id, course_id, progress);
  sendSuccess(res, { success: true });
}

/** POST /api/enrollments/study-session — Record study time */
export async function recordStudySession(req: Request, res: Response) {
  const { course_id, duration_minutes } = req.body;
  const userId = req.user!.id;
  const tenantId = req.user!.tenantId!;

  if (!course_id || !duration_minutes) {
    return sendError(res, 'course_id and duration_minutes are required', 400);
  }

  await svc.recordStudySession(userId, course_id, tenantId, duration_minutes);
  sendSuccess(res, { success: true });
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
