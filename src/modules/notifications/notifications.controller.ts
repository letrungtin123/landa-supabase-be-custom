// ═══════════════════════════════════════════════════════════════
// Notifications Controller
// ═══════════════════════════════════════════════════════════════

import type { Request, Response } from 'express';
import { sendSuccess, sendError } from '../../utils/response.js';
import * as svc from './notifications.service.js';

export async function send(req: Request, res: Response) {
  const { course_id, title, message } = req.body;
  const tenantId = req.user!.tenantId!;
  const userId = req.user!.id;

  if (!course_id || !title) return sendError(res, 'course_id and title are required', 400);

  const result = await svc.sendCourseNotification(course_id, tenantId, title, message || '', userId);
  sendSuccess(res, result);
}

export async function list(req: Request, res: Response) {
  const tenantId = req.user!.tenantId!;
  const page = parseInt(req.query.page as string) || 1;
  const pageSize = Math.min(parseInt(req.query.page_size as string) || 20, 100);

  const result = await svc.getNotifications(tenantId, page, pageSize);
  sendSuccess(res, result);
}
