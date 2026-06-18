import type { Request, Response, NextFunction } from 'express';
import * as svc from './courses.service.js';
import { requestCourseDeletion } from '../course-deletion/course-deletion.service.js';
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
import { auditFromReq } from '../../middleware/audit-log.js';

export async function listController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    sendSuccess(res, await svc.listCourses(tenantId, req.query as Record<string, unknown>));
  } catch (err) { next(err); }
}

export async function createController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id is required', 400); return; }
    const parsed = createCourseSchema.safeParse(req.body);
    if (!parsed.success) { sendError(res, parsed.error.errors[0].message, 400); return; }
    const course = await svc.createCourse(tenantId, req.user!.id, req.body);
    auditFromReq(req, 'CREATE', 'course', course.id, course.display_name);
    sendSuccess(res, course, 'Course created', 201);
  } catch (err) { next(err); }
}

export async function updateController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const course = await svc.updateCourse(req.params.id, req.body);
    auditFromReq(req, 'UPDATE', 'course', course.id, course.display_name);
    sendSuccess(res, course);
  } catch (err) { next(err); }
}

export async function bulkActionController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = bulkActionSchema.safeParse(req.body);
    if (!parsed.success) { sendError(res, parsed.error.errors[0].message, 400); return; }
    const { ids, action } = parsed.data;
    const result = await svc.bulkCourseAction(ids, action);
    auditFromReq(req, 'UPDATE', 'course', '', '', `Bulk ${action}: ${result.updated}`);
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
    const mentor = await svc.updateCourseMentor(req.params.id, tenantId, mentorId);
    auditFromReq(req, 'UPDATE', 'course', req.params.id, undefined, mentor ? `Update mentor: ${mentor.id}` : 'Remove mentor');
    sendSuccess(res, { mentor });
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
    const section = await svc.upsertCourseMentorSection(req.params.id, tenantId, req.user!.id, parsed.data);
    auditFromReq(req, 'UPDATE', 'course_mentor_section', req.params.id, undefined, 'Update mentor section');
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

    const section = await svc.uploadCourseMentorSectionLogo(req.params.id, tenantId, req.user!.id, modeParsed.data, file);
    auditFromReq(req, 'UPDATE', 'course_mentor_section', req.params.id, undefined, `Upload ${modeParsed.data} logo`);
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

    const section = await svc.deleteCourseMentorSectionLogo(req.params.id, tenantId, req.user!.id, modeParsed.data);
    auditFromReq(req, 'UPDATE', 'course_mentor_section', req.params.id, undefined, `Delete ${modeParsed.data} logo`);
    sendSuccess(res, { mentor_section: section });
  } catch (err) { next(err); }
}

export async function getModalConfigController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try { sendSuccess(res, await svc.getCourseModalConfig(req.params.id)); }
  catch (err) { next(err); }
}

export async function updateModalConfigController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await svc.upsertCourseModalConfig(req.params.id, req.body);
    auditFromReq(req, 'UPDATE', 'course_modal_config', req.params.id);
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
    await svc.upsertSectionModalConfig(req.params.id, req.body);
    auditFromReq(req, 'UPDATE', 'section_modal_config', req.params.id);
    sendSuccess(res, null, 'Updated');
  } catch (err) { next(err); }
}

export async function hardDeleteController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id is required', 400); return; }

    const result = await requestCourseDeletion(req.params.id, tenantId, req.user!.id);
    auditFromReq(req, 'DELETE', 'course', req.params.id, undefined, `Delete requested: ${result.jobId}`);
    sendSuccess(res, { success: true });
  } catch (err) { next(err); }
}
