// Notifications Controller

import type { Request, Response, NextFunction } from 'express';
import { sendSuccess, sendError } from '../../utils/response.js';
import { createTransactionalAuditEntry } from '../../middleware/audit-log.js';
import * as svc from './notifications.service.js';

export async function send(req: Request, res: Response, next: NextFunction) {
  try {
    const { course_id, title, message } = req.body;
    const tenantId = req.user!.tenantId!;
    const userId = req.user!.id;

    if (!course_id || !title) {
      sendError(res, 'course_id và title là bắt buộc', 400);
      return;
    }

    const result = await svc.sendCourseNotification(
      course_id,
      tenantId,
      title,
      message || '',
      userId,
      (created) => createTransactionalAuditEntry(
        req,
        'CREATE',
        'notification',
        {
          code: 'notification.created',
          context: {
            course_id: created.courseId,
            course_name: created.courseName,
            affected_count: created.recipientCount,
          },
        },
        created.notificationId,
        title,
      ),
    );
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
