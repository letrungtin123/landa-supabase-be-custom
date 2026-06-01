// ═══════════════════════════════════════════════════════════════
// Courses Controller
// ═══════════════════════════════════════════════════════════════

import type { Request, Response, NextFunction } from 'express';
import * as svc from './courses.service.js';
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
    if (!tenantId) { sendError(res, 'tenant_id là bắt buộc', 400); return; }
    const course = await svc.createCourse(tenantId, req.body);
    auditFromReq(req, 'CREATE', 'course', course.id, course.display_name);
    sendSuccess(res, course, 'Tạo course thành công', 201);
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
    const { ids, action } = req.body;
    if (!Array.isArray(ids) || !action) { sendError(res, 'ids và action là bắt buộc', 400); return; }
    const result = await svc.bulkCourseAction(ids, action);
    auditFromReq(req, 'UPDATE', 'course', '', '', `Bulk ${action}: ${result.updated}`);
    sendSuccess(res, result);
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
    sendSuccess(res, null, 'Cập nhật thành công');
  } catch (err) { next(err); }
}

export async function getSectionModalController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const sectionId = req.query.section_id as string;
    if (!sectionId) { sendError(res, 'section_id là bắt buộc', 400); return; }
    sendSuccess(res, await svc.getSectionModalConfig(req.params.id, sectionId));
  } catch (err) { next(err); }
}

export async function updateSectionModalController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await svc.upsertSectionModalConfig(req.params.id, req.body);
    auditFromReq(req, 'UPDATE', 'section_modal_config', req.params.id);
    sendSuccess(res, null, 'Cập nhật thành công');
  } catch (err) { next(err); }
}
