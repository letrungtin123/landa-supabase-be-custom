import type { Request, Response, NextFunction } from 'express';
import * as svc from './course-categories.service.js';
import { sendSuccess, sendError } from '../../utils/response.js';
import {
  createTransactionalAuditEntry,
  runAuditedTransaction,
} from '../../middleware/audit-log.js';
import type { AuditChange } from '../audit-logs/audit-event.contract.js';

export async function listController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    sendSuccess(res, await svc.listCourseCategories(tenantId, req.query as Record<string, unknown>));
  } catch (err) { next(err); }
}

export async function createController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id là bắt buộc', 400); return; }
    const cat = await runAuditedTransaction(
      () => svc.createCourseCategory(tenantId, req.body),
      (created) => createTransactionalAuditEntry(
        req,
        'CREATE',
        'course_category',
        { code: 'course_category.created' },
        created.id,
        created.name,
      ),
    );
    sendSuccess(res, cat, 'Tạo danh mục thành công', 201);
  } catch (err) { next(err); }
}

export async function updateController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id là bắt buộc', 400); return; }
    const cat = await svc.updateCourseCategory(req.params.id, tenantId, req.body, (before, after, removedAssignments) => {
      const changes: AuditChange[] = [];
      if (before.name !== after.name) changes.push({ field: 'name', before: before.name, after: after.name });
      if (before.sort_order !== after.sort_order) changes.push({ field: 'sort_order', before: before.sort_order, after: after.sort_order });
      if (before.is_public !== after.is_public) changes.push({ field: 'is_public', before: before.is_public, after: after.is_public });
      return createTransactionalAuditEntry(
        req,
        'UPDATE',
        'course_category',
        {
          code: 'course_category.updated',
          context: removedAssignments > 0 ? { affected_count: removedAssignments } : undefined,
          changes,
        },
        after.id,
        after.name,
      );
    });
    sendSuccess(res, cat);
  } catch (err) { next(err); }
}

export async function publicImpactController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id là bắt buộc', 400); return; }
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    sendSuccess(res, await svc.getCourseCategoryPublicImpact(req.params.id, tenantId, limit));
  } catch (err) { next(err); }
}

export async function deleteController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id là bắt buộc', 400); return; }
    const cat = await runAuditedTransaction(
      () => svc.deleteCourseCategory(req.params.id, tenantId),
      (deleted) => createTransactionalAuditEntry(
        req,
        'DELETE',
        'course_category',
        { code: 'course_category.deleted' },
        deleted.id,
        deleted.name,
      ),
    );
    sendSuccess(res, null, 'Xóa thành công');
  } catch (err) { next(err); }
}

export async function getCoursesController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id là bắt buộc', 400); return; }
    sendSuccess(res, await svc.getCategoryCourses(req.params.id, tenantId));
  }
  catch (err) { next(err); }
}

export async function addCoursesController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { course_ids } = req.body;
    if (!Array.isArray(course_ids)) { sendError(res, 'course_ids phải là mảng', 400); return; }
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id là bắt buộc', 400); return; }
    const result = await runAuditedTransaction(
      () => svc.addCoursesToCategory(req.params.id, tenantId, course_ids),
      (assigned) => assigned.assigned > 0
        ? createTransactionalAuditEntry(
          req,
          'UPDATE',
          'course_category',
          {
            code: 'course_category.course.assigned',
            context: { parent_name: assigned.categoryName, affected_count: assigned.assigned },
          },
          req.params.id,
          assigned.categoryName,
        )
        : null,
    );
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

export async function removeCourseController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id là bắt buộc', 400); return; }
    const result = await runAuditedTransaction(
      () => svc.removeCourseFromCategory(req.params.id, tenantId, decodeURIComponent(req.params.courseId)),
      (removed) => createTransactionalAuditEntry(
        req,
        'DELETE',
        'course_category_course',
        {
          code: 'course_category.course.removed',
          context: {
            parent_name: removed.categoryName,
            related_entity_name: removed.courseName,
            related_entity_type: 'course',
          },
        },
        req.params.id,
        removed.categoryName,
      ),
    );
    sendSuccess(res, null, 'Đã gỡ khóa học');
  } catch (err) { next(err); }
}

