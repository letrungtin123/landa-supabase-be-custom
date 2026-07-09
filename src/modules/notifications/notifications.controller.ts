// Notifications Controller

import type { Request, Response, NextFunction } from 'express';
import { sendSuccess, sendError } from '../../utils/response.js';
import { auditFromReq } from '../../middleware/audit-log.js';
import * as svc from './notifications.service.js';

export async function send(req: Request, res: Response, next: NextFunction) {
  try {
    const { course_id, title, message, send_email } = req.body;
    const tenantId = req.user!.tenantId!;
    const userId = req.user!.id;

    if (!course_id || !title) {
      sendError(res, 'course_id và title là bắt buộc', 400);
      return;
    }

    const result = await svc.sendCourseNotification(course_id, tenantId, title, message || '', userId, {
      sendEmail: send_email === true,
    });
    auditFromReq(req, 'CREATE', 'notification', course_id, title, `Gửi cho ${result.recipients} learners`);
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}

export async function smtpStatus(req: Request, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId!;
    const result = await svc.getCourseNotificationSmtpStatus(tenantId);
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}

export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId!;
    const result = await svc.getNotifications(tenantId, req.query as Record<string, unknown>);
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}
