// ═══════════════════════════════════════════════════════════════
// Learner Controller — Handlers cho learner portal
// ═══════════════════════════════════════════════════════════════

import type { Request, Response, NextFunction } from 'express';
import * as learnerService from './learner.service.js';
import { sendSuccess, sendError } from '../../utils/response.js';

/** GET /api/learner/courses */
export async function listCourses(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) { sendError(res, 'Chưa xác thực', 401); return; }

    const tenantId = req.user.tenantId;
    if (!tenantId) { sendError(res, 'Thiếu tenant', 400); return; }

    const result = await learnerService.getMyVisibleCourses(
      req.user.id,
      tenantId,
      req.user.role,
      {
        search: req.query.search as string | undefined,
        page: req.query.page ? parseInt(req.query.page as string) : undefined,
        page_size: req.query.page_size ? parseInt(req.query.page_size as string) : undefined,
      },
    );

    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}

/** GET /api/learner/courses/:courseId */
export async function getCourseDetail(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) { sendError(res, 'Chưa xác thực', 401); return; }
    const tenantId = req.user.tenantId;
    if (!tenantId) { sendError(res, 'Thiếu tenant', 400); return; }

    const result = await learnerService.getCourseDetail(
      req.params.courseId,
      req.user.id,
      tenantId,
      req.user.role,
    );
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}

/** GET /api/learner/courses/:courseId/blocks */
export async function getCourseBlocks(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) { sendError(res, 'Chưa xác thực', 401); return; }

    const result = await learnerService.getCourseBlocks(
      req.params.courseId,
      req.user.id,
    );
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}

/** GET /api/learner/enrollments */
export async function listEnrollments(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) { sendError(res, 'Chưa xác thực', 401); return; }
    const tenantId = req.user.tenantId;
    if (!tenantId) { sendError(res, 'Thiếu tenant', 400); return; }

    const result = await learnerService.getMyEnrollments(req.user.id, tenantId);
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}

/** POST /api/learner/enroll */
export async function enroll(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) { sendError(res, 'Chưa xác thực', 401); return; }
    const tenantId = req.user.tenantId;
    if (!tenantId) { sendError(res, 'Thiếu tenant', 400); return; }

    const { course_id } = req.body;
    if (!course_id) { sendError(res, 'Thiếu course_id', 400); return; }

    const result = await learnerService.selfEnroll(req.user.id, course_id, tenantId);
    sendSuccess(res, result, result.already_enrolled ? 'Đã ghi danh trước đó' : 'Ghi danh thành công');
  } catch (err) {
    next(err);
  }
}

/** POST /api/learner/complete-blocks */
export async function completeBlocks(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) { sendError(res, 'Chưa xác thực', 401); return; }

    const { course_id, block_ids } = req.body;
    if (!course_id || !Array.isArray(block_ids)) {
      sendError(res, 'Thiếu course_id hoặc block_ids', 400);
      return;
    }

    const result = await learnerService.markBlocksComplete(req.user.id, course_id, block_ids);
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}

/** GET /api/learner/progress/:courseId */
export async function getProgress(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) { sendError(res, 'Chưa xác thực', 401); return; }

    const result = await learnerService.getMyProgress(req.user.id, req.params.courseId);
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}

/** GET /api/learner/badges */
export async function listBadges(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) { sendError(res, 'Chưa xác thực', 401); return; }
    const result = await learnerService.getMyBadges(req.user.id);
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}

/** POST /api/learner/badges */
export async function saveBadge(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) { sendError(res, 'Chưa xác thực', 401); return; }
    const { badge_id } = req.body;
    if (!badge_id) { sendError(res, 'Thiếu badge_id', 400); return; }
    await learnerService.saveBadge(req.user.id, badge_id);
    sendSuccess(res, null, 'Lưu huy hiệu thành công');
  } catch (err) {
    next(err);
  }
}

/** PATCH /api/learner/badges */
export async function updateBadge(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) { sendError(res, 'Chưa xác thực', 401); return; }
    const { badge_id, is_shown } = req.body;
    if (!badge_id) { sendError(res, 'Thiếu badge_id', 400); return; }
    await learnerService.updateBadgeShown(req.user.id, badge_id, is_shown ?? true);
    sendSuccess(res, null);
  } catch (err) {
    next(err);
  }
}

/** GET /api/learner/notifications */
export async function listNotifications(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) { sendError(res, 'Chưa xác thực', 401); return; }
    const tenantId = req.user.tenantId;
    if (!tenantId) { sendError(res, 'Thiếu tenant', 400); return; }

    const result = await learnerService.getMyNotifications(req.user.id, tenantId, {
      page: req.query.page ? parseInt(req.query.page as string) : undefined,
      page_size: req.query.page_size ? parseInt(req.query.page_size as string) : undefined,
    });

    // Fill unread count
    result.unread_count = await learnerService.getUnreadCount(req.user.id, tenantId);

    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}

/** GET /api/learner/notifications/unread-count */
export async function getUnreadCount(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) { sendError(res, 'Chưa xác thực', 401); return; }
    const tenantId = req.user.tenantId;
    if (!tenantId) { sendError(res, 'Thiếu tenant', 400); return; }

    const count = await learnerService.getUnreadCount(req.user.id, tenantId);
    sendSuccess(res, { count });
  } catch (err) {
    next(err);
  }
}

/** PATCH /api/learner/notifications/:id/read */
export async function markRead(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) { sendError(res, 'Chưa xác thực', 401); return; }
    await learnerService.markNotificationRead(req.user.id, req.params.id);
    sendSuccess(res, null);
  } catch (err) {
    next(err);
  }
}

/** PATCH /api/learner/notifications/read-all */
export async function markAllRead(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) { sendError(res, 'Chưa xác thực', 401); return; }
    const tenantId = req.user.tenantId;
    if (!tenantId) { sendError(res, 'Thiếu tenant', 400); return; }

    await learnerService.markAllNotificationsRead(req.user.id, tenantId);
    sendSuccess(res, null);
  } catch (err) {
    next(err);
  }
}
