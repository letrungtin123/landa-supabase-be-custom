import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../../middleware/error-handler.js';
import { auditFromReq } from '../../middleware/audit-log.js';
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
    const result = await service.createAssignment(req.params.courseId, tenantId(req), req.user!.id, parsed.data, file(req));
    auditFromReq(req, 'CREATE', 'assignment', result.id, result.title, `Khóa học ${req.params.courseId}`);
    sendSuccess(res, result, 'Tao assignment thanh cong', 201);
  } catch (err) { next(err); }
}

export async function updateAssignment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = updateAssignmentSchema.safeParse(req.body);
    if (!parsed.success) { sendError(res, parsed.error.errors[0].message, 400); return; }
    const result = await service.updateAssignment(req.params.assignmentId, tenantId(req), req.user!.id, parsed.data, file(req));
    auditFromReq(req, 'UPDATE', 'assignment', result.id, result.title);
    sendSuccess(res, result, 'Cap nhat assignment thanh cong');
  } catch (err) { next(err); }
}

export async function deleteAssignment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const deleted = await service.deleteAssignment(req.params.assignmentId, tenantId(req));
    auditFromReq(req, 'DELETE', 'assignment', req.params.assignmentId, deleted.title, `Khóa học ${deleted.course_name}`);
    sendSuccess(res, null, 'Xoa assignment thanh cong');
  } catch (err) { next(err); }
}

export async function reorderAssignments(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = reorderAssignmentsSchema.safeParse(req.body);
    if (!parsed.success) { sendError(res, parsed.error.errors[0].message, 400); return; }
    const result = await service.reorderAssignments(req.params.courseId, tenantId(req), parsed.data.assignment_ids);
    auditFromReq(req, 'UPDATE', 'assignment', req.params.courseId, result.course_name, `Sắp xếp ${parsed.data.assignment_ids.length} bài tập`);
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
    const auditContext = await service.getSubmissionAuditContext(req.params.submissionId, tenantId(req));
    const result = await service.feedbackSubmission(
      req.params.submissionId,
      tenantId(req),
      req.user!.id,
      parsed.data,
      files(req),
    );
    auditFromReq(req, 'UPDATE', 'assignment_submission', req.params.submissionId, auditContext.assignment_title, `Feedback ${auditContext.learner_name} - ${auditContext.course_name}`);
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
