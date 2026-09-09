import type { Request, Response, NextFunction } from 'express';
import * as svc from './courses.service.js';
import {
  getCourseDeletionJobStatus,
  requestCourseDeletion,
  retryTerminalCourseDeletionJob,
} from '../course-deletion/course-deletion.service.js';
import {
  createCourseSchema,
  updateCourseSchema,
  bulkActionSchema,
  mentorSectionSchema,
  mentorSectionLogoModeSchema,
  MENTOR_SECTION_LOGO_MIME_TYPES,
  MENTOR_SECTION_LOGO_MAX_SIZE,
} from './courses.validator.js';
import { sendSuccess, sendError } from '../../utils/response.js';
import { createTransactionalAuditEntry, runAuditedTransaction } from '../../middleware/audit-log.js';

export async function listController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    sendSuccess(res, await svc.listCourses(tenantId, req.query as Record<string, unknown>));
  } catch (err) { next(err); }
}

function getRawQueryParam(req: Request, key: string): string {
  const queryIndex = req.originalUrl.indexOf('?');
  if (queryIndex < 0) return '';

  const rawQuery = req.originalUrl.slice(queryIndex + 1);
  for (const part of rawQuery.split('&')) {
    const [rawKey, ...rawValueParts] = part.split('=');
    if (decodeURIComponent(rawKey || '') !== key) continue;
    return decodeURIComponent(rawValueParts.join('=') || '').trim();
  }
  return '';
}

export async function exportMarkdownController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id is required', 400); return; }

    const courseId = getRawQueryParam(req, 'id') || req.params.id.trim();
    if (!courseId) { sendError(res, 'course id is required', 400); return; }

    const result = await svc.exportCourseMarkdown(courseId, tenantId);
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.status(200).send(result.markdown);
  } catch (err) { next(err); }
}

export async function createController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id is required', 400); return; }
    const parsed = createCourseSchema.safeParse(req.body);
    if (!parsed.success) { sendError(res, parsed.error.errors[0].message, 400); return; }
    const course = await runAuditedTransaction(
      () => svc.createCourse(tenantId, req.user!.id, parsed.data),
      (created) => createTransactionalAuditEntry(
        req,
        'CREATE',
        'course',
        { code: 'course.created' },
        created.id,
        created.display_name,
      ),
    );
    sendSuccess(res, course, 'Course created', 201);
  } catch (err) { next(err); }
}

export async function updateController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (req.body?.is_public !== undefined) {
      sendError(res, 'Chỉ được bật Công khai truy cập ở danh mục khóa học', 400);
      return;
    }
    const parsed = updateCourseSchema.safeParse(req.body);
    if (!parsed.success) { sendError(res, parsed.error.errors[0].message, 400); return; }
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id is required', 400); return; }
    const course = await svc.updateCourse(
      req.params.id,
      tenantId,
      parsed.data,
      (before, after) => createTransactionalAuditEntry(
        req,
        'UPDATE',
        'course',
        {
          code: 'course.updated',
          changes: [
            ...(before.display_name !== after.display_name
              ? [{ field: 'display_name', before: before.display_name, after: after.display_name }]
              : []),
            ...(before.visible_to_staff_only !== after.visible_to_staff_only
              ? [{ field: 'visible_to_staff_only', before: before.visible_to_staff_only, after: after.visible_to_staff_only }]
              : []),
            ...(before.image_url !== after.image_url
              ? [{
                field: 'image_status',
                before: Boolean(before.image_url),
                after: Boolean(after.image_url),
              }]
              : []),
          ],
        },
        after.id,
        after.display_name,
      ),
    );
    sendSuccess(res, course);
  } catch (err) { next(err); }
}

export async function bulkActionController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = bulkActionSchema.safeParse(req.body);
    if (!parsed.success) { sendError(res, parsed.error.errors[0].message, 400); return; }
    const { ids, action } = parsed.data;
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id is required', 400); return; }
    const result = await runAuditedTransaction(
      () => svc.bulkCourseAction(ids, action, tenantId),
      (updated) => updated.updated > 0 ? createTransactionalAuditEntry(
        req, 'UPDATE', 'course_bulk',
        { code: 'course.bulk.updated', context: { affected_count: updated.updated } },
      ) : null,
    );
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

function canManageCourseMentor(role: string): boolean {
  return role === 'superuser' || role === 'superadmin';
}

export async function getMentorController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id is required', 400); return; }
    const mentor = await svc.getCourseMentor(req.params.id, tenantId);
    sendSuccess(res, { mentor });
  } catch (err) { next(err); }
}

export async function listMentorCandidatesController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id is required', 400); return; }
    if (!canManageCourseMentor(req.user!.role)) { sendError(res, 'Forbidden', 403); return; }
    const result = await svc.listMentorCandidates(req.params.id, tenantId, req.query as Record<string, unknown>);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

export async function updateMentorController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id is required', 400); return; }
    if (!canManageCourseMentor(req.user!.role)) { sendError(res, 'Forbidden', 403); return; }
    const rawMentorId = req.body?.mentor_id;
    const mentorId = rawMentorId === null
      ? null
      : typeof rawMentorId === 'string'
        ? rawMentorId.trim() || null
        : undefined;
    if (mentorId === undefined) { sendError(res, 'mentor_id is required', 400); return; }
    const mentor = await svc.updateCourseMentor(
      req.params.id,
      tenantId,
      mentorId,
      req.user!.id,
      ({ courseName, mentorName }) => createTransactionalAuditEntry(
        req, 'UPDATE', 'course',
        { code: 'course.mentor.updated', context: { course_id: req.params.id, course_name: courseName, related_entity_name: mentorName || undefined, related_entity_type: mentorName ? 'user' : undefined } },
        req.params.id, courseName,
      ),
    );
    sendSuccess(res, { mentor });
  } catch (err) { next(err); }
}

export async function listMentorHistoryController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id is required', 400); return; }
    if (!canManageCourseMentor(req.user!.role)) { sendError(res, 'Forbidden', 403); return; }
    const result = await svc.listCourseMentorAssignmentHistory(req.params.id, tenantId, req.query as Record<string, unknown>);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

export async function getMentorSectionController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id is required', 400); return; }
    if (!canManageCourseMentor(req.user!.role)) { sendError(res, 'Forbidden', 403); return; }
    const section = await svc.getCourseMentorSection(req.params.id, tenantId);
    sendSuccess(res, { mentor_section: section });
  } catch (err) { next(err); }
}

export async function updateMentorSectionController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id is required', 400); return; }
    if (!canManageCourseMentor(req.user!.role)) { sendError(res, 'Forbidden', 403); return; }
    const parsed = mentorSectionSchema.safeParse(req.body);
    if (!parsed.success) { sendError(res, parsed.error.errors[0].message, 400); return; }
    const courseName = await svc.getCourseAuditName(req.params.id, tenantId);
    const section = await runAuditedTransaction(
      () => svc.upsertCourseMentorSection(req.params.id, tenantId, req.user!.id, parsed.data),
      () => createTransactionalAuditEntry(
        req, 'UPDATE', 'course_mentor_section',
        { code: 'course.mentor_section.updated', context: { course_id: req.params.id, course_name: courseName, related_entity_name: 'mentor_section', related_entity_type: 'course_setting' } },
        req.params.id, courseName,
      ),
    );
    sendSuccess(res, { mentor_section: section });
  } catch (err) { next(err); }
}

export async function uploadMentorSectionLogoController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id is required', 400); return; }
    if (!canManageCourseMentor(req.user!.role)) { sendError(res, 'Forbidden', 403); return; }

    const modeParsed = mentorSectionLogoModeSchema.safeParse(req.body?.mode);
    if (!modeParsed.success) { sendError(res, 'mode must be light or dark', 400); return; }

    const file = req.file;
    if (!file) { sendError(res, 'No file uploaded', 400); return; }
    if (file.size > MENTOR_SECTION_LOGO_MAX_SIZE) { sendError(res, 'File qua lon. Toi da 5MB', 400); return; }
    if (!MENTOR_SECTION_LOGO_MIME_TYPES.includes(file.mimetype as any)) {
      sendError(res, 'Dinh dang file khong ho tro', 400);
      return;
    }

    const courseName = await svc.getCourseAuditName(req.params.id, tenantId);
    const section = await svc.uploadCourseMentorSectionLogo(
      req.params.id, tenantId, req.user!.id, modeParsed.data, file,
      createTransactionalAuditEntry(
        req, 'UPDATE', 'course_mentor_section',
        { code: 'course.mentor_section.updated', context: { course_id: req.params.id, course_name: courseName, related_entity_name: `${modeParsed.data}_logo`, related_entity_type: 'course_setting' } },
        req.params.id, courseName,
      ),
    );
    sendSuccess(res, { mentor_section: section }, 'Upload thanh cong');
  } catch (err) { next(err); }
}

export async function deleteMentorSectionLogoController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id is required', 400); return; }
    if (!canManageCourseMentor(req.user!.role)) { sendError(res, 'Forbidden', 403); return; }

    const modeParsed = mentorSectionLogoModeSchema.safeParse(req.params.mode);
    if (!modeParsed.success) { sendError(res, 'mode must be light or dark', 400); return; }

    const courseName = await svc.getCourseAuditName(req.params.id, tenantId);
    const section = await svc.deleteCourseMentorSectionLogo(
      req.params.id, tenantId, req.user!.id, modeParsed.data,
      createTransactionalAuditEntry(
        req, 'UPDATE', 'course_mentor_section',
        { code: 'course.mentor_section.updated', context: { course_id: req.params.id, course_name: courseName, related_entity_name: `${modeParsed.data}_logo`, related_entity_type: 'course_setting' } },
        req.params.id, courseName,
      ),
    );
    sendSuccess(res, { mentor_section: section });
  } catch (err) { next(err); }
}

export async function getModalConfigController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try { sendSuccess(res, await svc.getCourseModalConfig(req.params.id)); }
  catch (err) { next(err); }
}

export async function updateModalConfigController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id is required', 400); return; }
    const courseName = await svc.getCourseAuditName(req.params.id, tenantId);
    await runAuditedTransaction(
      () => svc.upsertCourseModalConfig(req.params.id, tenantId, req.body),
      () => createTransactionalAuditEntry(
        req, 'UPDATE', 'course_modal_config',
        { code: 'course.modal.updated', context: { course_id: req.params.id, course_name: courseName, related_entity_name: 'course_modal', related_entity_type: 'course_setting' } },
        req.params.id, courseName,
      ),
    );
    sendSuccess(res, null, 'Updated');
  } catch (err) { next(err); }
}

export async function getSectionModalController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const sectionId = req.query.section_id as string;
    if (!sectionId) { sendError(res, 'section_id is required', 400); return; }
    sendSuccess(res, await svc.getSectionModalConfig(req.params.id, sectionId));
  } catch (err) { next(err); }
}

export async function updateSectionModalController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id is required', 400); return; }
    const courseName = await svc.getCourseAuditName(req.params.id, tenantId);
    await runAuditedTransaction(
      () => svc.upsertSectionModalConfig(req.params.id, tenantId, req.body),
      () => createTransactionalAuditEntry(
        req, 'UPDATE', 'section_modal_config',
        { code: 'course.modal.updated', context: { course_id: req.params.id, course_name: courseName, related_entity_name: 'section_modal', related_entity_type: 'course_setting' } },
        req.params.id, courseName,
      ),
    );
    sendSuccess(res, null, 'Updated');
  } catch (err) { next(err); }
}

export async function hardDeleteController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id is required', 400); return; }

    const result = await requestCourseDeletion(
      req.params.id,
      tenantId,
      req.user!.id,
      (jobId) => createTransactionalAuditEntry(
        req,
        'DELETE',
        'course_deletion_job',
        { code: 'course.deleted' },
        jobId,
        'Khóa học đã xóa',
      ),
    );
    sendSuccess(res, { job_id: result.jobId, status: 'queued' }, 'Đã đưa khóa học vào hàng đợi xóa vĩnh viễn', 202);
  } catch (err) { next(err); }
}

export async function getDeletionJobStatusController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id is required', 400); return; }
    sendSuccess(res, await getCourseDeletionJobStatus(req.params.jobId, tenantId));
  } catch (err) { next(err); }
}

/** POST /api/courses/deletion-jobs/:jobId/retry — retry an exhausted job. */
export async function retryDeletionJobController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id is required', 400); return; }
    await runAuditedTransaction(
      () => retryTerminalCourseDeletionJob(req.params.jobId, tenantId),
      () => createTransactionalAuditEntry(
        req,
        'UPDATE',
        'course_deletion_job',
        { code: 'course.deletion_job.retry_queued' },
        req.params.jobId,
        'Yêu cầu xóa khóa học',
      ),
    );
    sendSuccess(res, { job_id: req.params.jobId, status: 'queued' }, 'Đã đưa deletion job vào hàng đợi retry', 202);
  } catch (err) { next(err); }
}

