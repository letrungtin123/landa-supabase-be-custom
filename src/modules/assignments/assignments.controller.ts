import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../../middleware/error-handler.js';
import { createTransactionalAuditEntry } from '../../middleware/audit-log.js';
import type { AuditChange } from '../audit-logs/audit-event.contract.js';
import { sendError, sendSuccess } from '../../utils/response.js';
import { isDemoIframeSession } from '../demo-login/demo-iframe.service.js';
import * as service from './assignments.service.js';
import {
  createAssignmentSchema,
  feedbackAssignmentSchema,
  reorderAssignmentsSchema,
  submitAssignmentSchema,
  updateAssignmentSchema,
} from './assignments.validator.js';

function tenantId(req: Request): string {
  const id = req.user?.tenantId;
  if (!id) throw new AppError('Thieu tenant', 400);
  return id;
}

function files(req: Request): Express.Multer.File[] {
  return (req.files as Express.Multer.File[] | undefined) || [];
}

function file(req: Request): Express.Multer.File | undefined {
  return req.file;
}

export async function listCourseAssignments(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await service.listCourseAssignments(req.params.courseId, tenantId(req));
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

export async function createAssignment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = createAssignmentSchema.safeParse(req.body);
    if (!parsed.success) { sendError(res, parsed.error.errors[0].message, 400); return; }
    const result = await service.createAssignment(
      req.params.courseId,
      tenantId(req),
      req.user!.id,
      parsed.data,
      file(req),
      (created) => createTransactionalAuditEntry(
        req,
        'CREATE',
        'assignment',
        { code: 'assignment.created', context: { course_id: created.course_id, course_name: created.course_name } },
        created.id,
        created.title,
      ),
    );
    sendSuccess(res, result, 'Tao assignment thanh cong', 201);
  } catch (err) { next(err); }
}

export async function updateAssignment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = updateAssignmentSchema.safeParse(req.body);
    if (!parsed.success) { sendError(res, parsed.error.errors[0].message, 400); return; }
    const result = await service.updateAssignment(
      req.params.assignmentId,
      tenantId(req),
      req.user!.id,
      parsed.data,
      file(req),
      (before, after) => {
        const changes: AuditChange[] = [];
        if (before.title !== after.title) changes.push({ field: 'title', before: before.title, after: after.title });
        if (before.allow_resubmission !== after.allow_resubmission) {
          changes.push({ field: 'allow_resubmission', before: before.allow_resubmission, after: after.allow_resubmission });
        }
        if (String(before.deadline_at || '') !== String(after.deadline_at || '')) {
          changes.push({ field: 'deadline_at', before: before.deadline_at ? String(before.deadline_at) : null, after: after.deadline_at ? String(after.deadline_at) : null });
        }
        if (before.submission_unlock_mode !== after.submission_unlock_mode) {
          changes.push({ field: 'submission_unlock_mode', before: before.submission_unlock_mode, after: after.submission_unlock_mode });
        }
        if (before.has_attachment !== after.has_attachment) {
          changes.push({ field: 'attachment_status', before: before.has_attachment, after: after.has_attachment });
        }
        return createTransactionalAuditEntry(
          req,
          'UPDATE',
          'assignment',
          {
            code: 'assignment.updated',
            context: { course_id: after.course_id, course_name: after.course_name },
            changes,
          },
          after.id,
          after.title,
        );
      },
    );
    sendSuccess(res, result, 'Cap nhat assignment thanh cong');
  } catch (err) { next(err); }
}

export async function deleteAssignment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const deleted = await service.deleteAssignment(
      req.params.assignmentId,
      tenantId(req),
      (removed) => createTransactionalAuditEntry(
        req,
        'DELETE',
        'assignment',
        { code: 'assignment.deleted', context: { course_id: removed.course_id, course_name: removed.course_name } },
        removed.id,
        removed.title,
      ),
    );
    sendSuccess(res, null, 'Xoa assignment thanh cong');
  } catch (err) { next(err); }
}

export async function reorderAssignments(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = reorderAssignmentsSchema.safeParse(req.body);
    if (!parsed.success) { sendError(res, parsed.error.errors[0].message, 400); return; }
    const result = await service.reorderAssignments(
      req.params.courseId,
      tenantId(req),
      parsed.data.assignment_ids,
      (course, affectedCount) => affectedCount > 0
        ? createTransactionalAuditEntry(
          req,
          'UPDATE',
          'assignment',
          {
            code: 'assignment.reordered',
            context: { course_id: course.id, course_name: course.display_name, affected_count: affectedCount },
          },
          course.id,
          course.display_name,
        )
        : null,
    );
    sendSuccess(res, result, 'Sap xep assignment thanh cong');
  } catch (err) { next(err); }
}

export async function listCourseSubmissions(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await service.listCourseSubmissions(
      req.params.courseId,
      tenantId(req),
      req.query as Record<string, unknown>,
    );
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

export async function feedbackSubmission(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = feedbackAssignmentSchema.safeParse(req.body);
    if (!parsed.success) { sendError(res, parsed.error.errors[0].message, 400); return; }
    const result = await service.feedbackSubmission(
      req.params.submissionId,
      tenantId(req),
      req.user!.id,
      parsed.data,
      files(req),
      (context, beforeScore, afterScore) => createTransactionalAuditEntry(
        req,
        'UPDATE',
        'assignment_submission',
        {
          code: 'assignment.submission.feedback_given',
          context: {
            course_id: context.courseId,
            course_name: context.courseName,
            parent_name: context.assignmentTitle,
            related_entity_name: context.learnerName,
            related_entity_type: 'learner',
          },
          changes: beforeScore !== afterScore ? [{ field: 'score', before: beforeScore, after: afterScore }] : [],
        },
        context.submissionId,
        context.assignmentTitle,
      ),
    );
    sendSuccess(res, result, 'Gui feedback thanh cong');
  } catch (err) { next(err); }
}

export async function listSubmissionFeedbackHistory(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await service.listSubmissionFeedbackHistory(req.params.submissionId, tenantId(req));
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

export async function listLearnerCourseAssignments(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await service.listLearnerCourseAssignments(req.params.courseId, req.user!);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

export async function getLearnerAssignment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await service.getLearnerAssignment(req.params.assignmentId, req.user!);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

export async function submitAssignment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (isDemoIframeSession(req.user)) {
      sendError(res, 'Phiên demo iframe không thể nộp assignment', 403);
      return;
    }
    const parsed = submitAssignmentSchema.safeParse(req.body);
    if (!parsed.success) { sendError(res, parsed.error.errors[0].message, 400); return; }
    const result = await service.submitAssignment(req.params.assignmentId, req.user!, parsed.data, files(req));
    sendSuccess(res, result, 'Nop assignment thanh cong');
  } catch (err) { next(err); }
}

export async function downloadFile(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const file = await service.getAssignmentFileForDownload(req.params.fileId, req.user!);
    const encoded = encodeURIComponent(file.originalName);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Length', file.buffer.length);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encoded}`);
    res.send(file.buffer);
  } catch (err) { next(err); }
}
