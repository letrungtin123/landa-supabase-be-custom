import type { Request, Response, NextFunction } from 'express';
import * as svc from './course-categories.service.js';
import { sendSuccess, sendError } from '../../utils/response.js';
import { auditFromReq } from '../../middleware/audit-log.js';

export async function listController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    sendSuccess(res, await svc.listCourseCategories(tenantId));
  } catch (err) { next(err); }
}

export async function createController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id là bắt buộc', 400); return; }
    const cat = await svc.createCourseCategory(tenantId, req.body);
    auditFromReq(req, 'CREATE', 'course_category', cat.id, cat.name);
    sendSuccess(res, cat, 'Tạo danh mục thành công', 201);
  } catch (err) { next(err); }
}

export async function updateController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const cat = await svc.updateCourseCategory(req.params.id, req.body);
    auditFromReq(req, 'UPDATE', 'course_category', cat.id, cat.name);
    sendSuccess(res, cat);
  } catch (err) { next(err); }
}

export async function deleteController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await svc.deleteCourseCategory(req.params.id);
    auditFromReq(req, 'DELETE', 'course_category', req.params.id);
    sendSuccess(res, null, 'Xóa thành công');
  } catch (err) { next(err); }
}

export async function getCoursesController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try { sendSuccess(res, await svc.getCategoryCourses(req.params.id)); }
  catch (err) { next(err); }
}

export async function addCoursesController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { course_ids } = req.body;
    if (!Array.isArray(course_ids)) { sendError(res, 'course_ids phải là mảng', 400); return; }
    const result = await svc.addCoursesToCategory(req.params.id, course_ids);
    auditFromReq(req, 'UPDATE', 'course_category', req.params.id, '', `Gán ${result.assigned} courses`);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

export async function removeCourseController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await svc.removeCourseFromCategory(req.params.id, decodeURIComponent(req.params.courseId));
    auditFromReq(req, 'DELETE', 'course_category_course', req.params.id);
    sendSuccess(res, null, 'Đã gỡ course');
  } catch (err) { next(err); }
}
