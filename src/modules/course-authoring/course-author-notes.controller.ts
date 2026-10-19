// ═══════════════════════════════════════════════════════════════
// Course author notes controller: the one read path of the AI ID author notes
// (editors only). Moved unchanged from course-authoring.controller.ts, which
// still re-exports it.
// ═══════════════════════════════════════════════════════════════

import type { Request, Response } from 'express';
import { sendSuccess } from '../../utils/response.js';
import { AppError } from '../../utils/errors.js';
import * as svc from './course-authoring.service.js';
import { requestComponentLocale } from './course-authoring-request.js';

const authorNotesErrors = {
  TENANT_REQUIRED: [403, 'Không xác định được doanh nghiệp đang thao tác.', 'The active organization could not be determined.'],
  COURSE_INVALID: [400, 'Mã khóa học không hợp lệ.', 'The course ID is invalid.'],
  COURSE_NOT_FOUND: [404, 'Không tìm thấy khóa học.', 'The course was not found.'],
  UNAVAILABLE: [500, 'Chưa thể tải ghi chú AI ID cho tác giả.', 'AI ID notes for authors could not be loaded.'],
} as const;

/** GET /api/course-authoring/author-notes/:courseId — `courses.can_edit` only.
 * The single read path for AI ID author notes; learner/CMS reads strip them. */
export async function getAuthorNotes(req: Request, res: Response) {
  res.setHeader('Cache-Control', 'no-store');
  const fail = (code: keyof typeof authorNotesErrors) => {
    const [status, vi, en] = authorNotesErrors[code];
    res.status(status).json({ success: false, code: `COURSE_AUTHOR_NOTES_${code}`, message: requestComponentLocale(req) === 'en' ? en : vi });
  };
  const tenantId = req.user?.tenantId;
  const courseId = req.params.courseId;
  if (!tenantId) return fail('TENANT_REQUIRED');
  if (!courseId || courseId.length > 255 || /[\x00-\x1f\x7f]/.test(courseId)) return fail('COURSE_INVALID');
  try {
    sendSuccess(res, await svc.getCourseAuthorNotes(courseId, tenantId));
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 404) return fail('COURSE_NOT_FOUND');
    console.error('[CourseAuthorNotes] read failed', { error: err instanceof Error ? err.name : 'unknown' });
    fail('UNAVAILABLE');
  }
}
