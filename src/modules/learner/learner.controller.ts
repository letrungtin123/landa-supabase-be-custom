// ═══════════════════════════════════════════════════════════════
// Learner Controller — Handlers cho learner portal
// ═══════════════════════════════════════════════════════════════

import type { Request, Response, NextFunction } from 'express';
import * as learnerService from './learner.service.js';
import { sendSuccess, sendError } from '../../utils/response.js';
import { isDemoIframeSession } from '../demo-login/demo-iframe.service.js';
import { requestUiLocaleOf } from '../../utils/client-error.js';
import { COMPLETE_BLOCKS_LIMIT_ERROR, MAX_COMPLETE_BLOCK_IDS } from './learner-completion.logic.js';
import {
  learnerBatchProgressQuerySchema,
  learnerCoursesQuerySchema,
  learnerLibraryDocumentsQuerySchema,
  learnerNotificationsQuerySchema,
} from './learner.validator.js';

function demoProgressState() {
  return { progress: 0, is_completed: false, completed_at: null, last_activity_at: null };
}

/** `?courseIds=` sent more than once (a list) instead of one comma-separated text. */
export const LEARNER_COURSE_IDS_INVALID_CODE = 'LEARNER_COURSE_IDS_INVALID';
export const LEARNER_COURSE_IDS_INVALID_MESSAGE = 'Danh sách khóa học không hợp lệ.';

/**
 * The JSON body as an object to read fields from. A request without a JSON
 * body (no body, another content type) has `req.body` undefined in Express 5;
 * it reads as an empty object, so the route's own "missing field" 400 answers
 * instead of a 500 on destructuring.
 */
function bodyFieldsOf(req: Request): Record<string, unknown> {
  return req.body !== null && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
}

function maskEnrollmentProgress<T extends object>(rows: T[]) {
  return rows.map((row) => ({
    ...row,
    progress: 0,
    is_completed: false,
    completed_at: null,
    last_activity_at: null,
  }));
}

function demoCourseModalState(courseId: string, updates?: { welcome_shown?: boolean; confirm_shown?: boolean; complete_shown?: boolean }) {
  return {
    course_id: courseId,
    welcome_shown: updates?.welcome_shown ?? false,
    confirm_shown: updates?.confirm_shown ?? false,
    complete_shown: updates?.complete_shown ?? false,
  };
}

/** GET /api/learner/courses */
export async function listCourses(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) { sendError(res, 'Chưa xác thực', 401); return; }

    const tenantId = req.user.tenantId;
    if (!tenantId) { sendError(res, 'Thiếu tenant', 400); return; }

    const query = learnerCoursesQuerySchema.parse(req.query);
    const result = await learnerService.getMyVisibleCourses(
      req.user.id,
      tenantId,
      req.user.role,
      {
        search: query.search,
        category_id: query.category_id,
        page: query.page,
        page_size: query.page_size,
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
      req.user.role,
      req.user.tenantId,
      isDemoIframeSession(req.user),
    );
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}

/** GET /api/learner/courses/:courseId/files */
export async function getCourseFiles(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) { sendError(res, 'Chưa xác thực', 401); return; }

    const result = await learnerService.getCourseFiles(req.params.courseId, req.user.id, req.user.role, req.user.tenantId);
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}

/** GET /api/learner/library/categories */
export async function getLibraryCategories(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) { sendError(res, 'Chưa xác thực', 401); return; }
    const tenantId = req.user.tenantId;
    if (!tenantId) { sendError(res, 'Thiếu tenant', 400); return; }

    const result = await learnerService.getMyLibraryCategories(req.user.id, tenantId, req.user.role);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

/** GET /api/learner/library/documents */
export async function getLibraryDocuments(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) { sendError(res, 'Chưa xác thực', 401); return; }
    const tenantId = req.user.tenantId;
    if (!tenantId) { sendError(res, 'Thiếu tenant', 400); return; }

    const query = learnerLibraryDocumentsQuerySchema.parse(req.query);
    const result = await learnerService.getMyLibraryDocuments(
      req.user.id,
      tenantId,
      req.user.role,
      {
        page: query.page,
        page_size: query.page_size,
        category: query.category,
        extension: query.extension,
        search: query.search,
        ordering: query.ordering,
      },
    );
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

/** GET /api/learner/blocks/:blockId */
export async function getBlockDetail(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) { sendError(res, 'Chưa xác thực', 401); return; }

    const result = await learnerService.getBlockDetail(
      req.params.blockId,
      req.user.id,
      req.user.role,
      req.user.tenantId,
    );
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}

/** POST /api/learner/blocks/:blockId/submit */
export async function submitBlockAnswer(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) { sendError(res, 'Chưa xác thực', 401); return; }

    const result = await learnerService.submitBlockAnswer(
      req.params.blockId,
      req.user.id,
      req.user.role,
      req.user.tenantId,
      req.body,
    );
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}

export async function listEnrollments(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) { sendError(res, 'Chưa xác thực', 401); return; }
    const tenantId = req.user.tenantId;
    if (!tenantId) { sendError(res, 'Thiếu tenant', 400); return; }

    const result = await learnerService.getMyEnrollments(req.user.id, tenantId);
    if (isDemoIframeSession(req.user)) {
      sendSuccess(res, maskEnrollmentProgress(result));
      return;
    }
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

    const { course_id } = bodyFieldsOf(req) as { course_id?: string };
    if (!course_id) { sendError(res, 'Thiếu course_id', 400); return; }

    if (isDemoIframeSession(req.user)) {
      sendSuccess(res, { enrollment_id: null, already_enrolled: true, demo_iframe: true }, 'Demo iframe không lưu ghi danh');
      return;
    }

    const result = await learnerService.selfEnroll(req.user.id, course_id, tenantId, req.user.role);
    sendSuccess(res, result, result.already_enrolled ? 'Đã ghi danh trước đó' : 'Ghi danh thành công');
  } catch (err) {
    next(err);
  }
}

/** POST /api/learner/complete-blocks */
export async function completeBlocks(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) { sendError(res, 'Chưa xác thực', 401); return; }

    const { course_id, block_ids } = bodyFieldsOf(req) as { course_id?: string; block_ids?: unknown };
    if (!course_id || !Array.isArray(block_ids)) {
      sendError(res, 'Thiếu course_id hoặc block_ids', 400);
      return;
    }
    if (block_ids.length > MAX_COMPLETE_BLOCK_IDS) {
      const [status, vi, en] = COMPLETE_BLOCKS_LIMIT_ERROR;
      sendError(res, requestUiLocaleOf(req) === 'en' ? en : vi, status);
      return;
    }

    if (isDemoIframeSession(req.user)) {
      sendSuccess(res, { marked: block_ids.length, demo_iframe: true });
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

    const result = isDemoIframeSession(req.user)
      ? demoProgressState()
      : await learnerService.getMyProgress(req.user.id, req.params.courseId);
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}

/** GET /api/learner/progress-batch?courseIds=id1,id2,id3 */
export async function getBatchProgress(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) { sendError(res, 'Chưa xác thực', 401); return; }
    const tenantId = req.user.tenantId;
    if (!tenantId) { sendError(res, 'Thiếu tenant', 400); return; }

    const raw = learnerBatchProgressQuerySchema.parse(req.query).courseIds;
    if (!raw) { sendError(res, 'Thiếu courseIds', 400); return; }
    if (typeof raw !== 'string') {
      sendError(res, LEARNER_COURSE_IDS_INVALID_MESSAGE, 400, LEARNER_COURSE_IDS_INVALID_CODE);
      return;
    }

    const courseIds = raw.split(',').map(id => id.trim()).filter(Boolean);
    if (courseIds.length === 0) { sendSuccess(res, { progress: {} }); return; }
    if (courseIds.length > 50) { sendError(res, 'Tối đa 50 courses', 400); return; }

    if (isDemoIframeSession(req.user)) {
      const progress = Object.fromEntries(courseIds.map((courseId) => [courseId, demoProgressState()]));
      sendSuccess(res, { progress });
      return;
    }

    const result = await learnerService.getBatchProgress(req.user.id, tenantId, courseIds);
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}

/** GET /api/learner/badges */
export async function listBadges(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) { sendError(res, 'Chưa xác thực', 401); return; }
    const tenantId = req.user.tenantId;
    if (!tenantId) { sendError(res, 'Thiếu tenant', 400); return; }
    const result = isDemoIframeSession(req.user) ? [] : await learnerService.getMyBadges(req.user.id, tenantId);
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}

/** POST /api/learner/badges/evaluate */
export async function evaluateBadges(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) { sendError(res, 'Chưa xác thực', 401); return; }
    const tenantId = req.user.tenantId;
    if (!tenantId) { sendError(res, 'Thiếu tenant', 400); return; }
    if (isDemoIframeSession(req.user)) {
      sendSuccess(res, {
        badge_definitions: [], earned_badges: [], newly_earned: [], pending_popups: [], progress: {},
      });
      return;
    }
    sendSuccess(res, await learnerService.evaluateBadges(req.user.id, tenantId));
  } catch (err) {
    next(err);
  }
}

/** GET /api/learner/badges/active */
export async function getActiveBadges(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) { sendError(res, 'Chưa xác thực', 401); return; }
    const tenantId = req.user.tenantId;
    if (!tenantId) { sendError(res, 'Thiếu tenant', 400); return; }

    const result = await learnerService.getActiveBadges(tenantId);
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
    if (isDemoIframeSession(req.user)) {
      sendSuccess(res, null, 'Demo iframe không lưu huy hiệu');
      return;
    }
    const tenantId = req.user.tenantId;
    if (!tenantId) { sendError(res, 'Thiếu tenant', 400); return; }
    await learnerService.saveBadge(req.user.id, tenantId, badge_id);
    sendSuccess(res, null, 'Đã đánh giá huy hiệu');
  } catch (err) {
    next(err);
  }
}

/** PATCH /api/learner/badges */
export async function updateBadge(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) { sendError(res, 'Chưa xác thực', 401); return; }
    const { badge_id } = req.body;
    if (!badge_id) { sendError(res, 'Thiếu badge_id', 400); return; }
    if (isDemoIframeSession(req.user)) {
      sendSuccess(res, null);
      return;
    }
    await learnerService.updateBadgeShown(req.user.id, badge_id, true);
    sendSuccess(res, null);
  } catch (err) {
    next(err);
  }
}

/** PATCH /api/learner/badges/:badgeId/shown */
export async function updateBadgeShown(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) { sendError(res, 'Chưa xác thực', 401); return; }
    if (isDemoIframeSession(req.user)) { sendSuccess(res, null); return; }
    await learnerService.updateBadgeShown(req.user.id, req.params.badgeId, true);
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

    // { data, total, unread_count }: the unread count comes from the same query.
    const query = learnerNotificationsQuerySchema.parse(req.query);
    const result = await learnerService.getMyNotifications(req.user.id, tenantId, {
      page: query.page,
      page_size: query.page_size,
    });

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
    if (!isDemoIframeSession(req.user)) {
      await learnerService.markNotificationRead(req.user.id, req.params.id);
    }
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

    if (!isDemoIframeSession(req.user)) {
      await learnerService.markAllNotificationsRead(req.user.id, tenantId);
    }
    sendSuccess(res, null);
  } catch (err) {
    next(err);
  }
}

// ── Course Modal Config ──

/** Popup configs/states are keyed by course id: check the course is the caller's first. */
function assertPopupCourse(req: Request): Promise<void> {
  return learnerService.assertCoursePopupAccess(req.params.courseId, req.user!.id, req.user!.tenantId, req.user!.role);
}

/** GET /api/learner/courses/:courseId/modal-config */
export async function getCourseModalConfig(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) { sendError(res, 'Chưa xác thực', 401); return; }
    await assertPopupCourse(req);
    const result = await learnerService.getCourseModalConfig(req.params.courseId);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

/** GET /api/learner/courses/:courseId/modal-state */
export async function getCourseModalState(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) { sendError(res, 'Chưa xác thực', 401); return; }
    await assertPopupCourse(req);
    const result = isDemoIframeSession(req.user)
      ? demoCourseModalState(req.params.courseId)
      : await learnerService.getCourseModalState(req.user.id, req.params.courseId);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

/** PATCH /api/learner/courses/:courseId/modal-state */
export async function updateCourseModalState(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) { sendError(res, 'Chưa xác thực', 401); return; }
    await assertPopupCourse(req);
    const { welcome_shown, confirm_shown, complete_shown } = req.body;
    if (isDemoIframeSession(req.user)) {
      sendSuccess(res, demoCourseModalState(req.params.courseId, { welcome_shown, confirm_shown, complete_shown }));
      return;
    }
    const result = await learnerService.updateCourseModalState(req.user.id, req.params.courseId, {
      welcome_shown,
      confirm_shown,
      complete_shown,
    });
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

// ── Section Modal (khích lệ từng section) ──

/** GET /api/learner/courses/:courseId/section-modal-configs */
export async function getSectionModalConfigs(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) { sendError(res, 'Chưa xác thực', 401); return; }
    await assertPopupCourse(req);
    const result = await learnerService.getSectionModalConfigs(req.params.courseId);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

/** GET /api/learner/courses/:courseId/section-modal-shown */
export async function getSectionModalShown(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) { sendError(res, 'Chưa xác thực', 401); return; }
    await assertPopupCourse(req);
    const result = isDemoIframeSession(req.user)
      ? { shown_sections: [] }
      : await learnerService.getSectionModalShown(req.user.id, req.params.courseId);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

/** POST /api/learner/courses/:courseId/section-modal-shown */
export async function markSectionModalShown(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) { sendError(res, 'Chưa xác thực', 401); return; }
    const { section_id } = req.body;
    if (!section_id) { sendError(res, 'Thiếu section_id', 400); return; }
    await assertPopupCourse(req);
    if (isDemoIframeSession(req.user)) {
      sendSuccess(res, { success: true, demo_iframe: true });
      return;
    }
    const sectionId = await learnerService.assertCourseSection(req.params.courseId, section_id);
    const result = await learnerService.markSectionModalShown(req.user.id, req.params.courseId, sectionId);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}
