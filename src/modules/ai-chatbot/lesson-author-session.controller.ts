import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../../middleware/error-handler.js';
import { GenerationJobError } from './lesson-author-generation-job.logic.js';
import { withLessonAuthorConversationLock } from './chat.service.js';
import {
  getLessonAuthorSessionDeleteImpact,
  getLessonAuthorSessionDeletionStatus,
  listLessonAuthorSessions,
  renameLessonAuthorSession,
  requestLessonAuthorSessionDeletion,
  type LessonAuthorSessionOwner,
} from './lesson-author-session.service.js';

function owner(req: Request): LessonAuthorSessionOwner {
  const user = req.user;
  if (!user || user.sessionMode !== 'normal' || !user.tenantId
    || !['staff', 'superuser', 'superadmin'].includes(user.role)) {
    throw new AppError('Bạn không có quyền quản lý phiên thiết kế khóa học.', 403, 'LESSON_AUTHOR_SESSION_FORBIDDEN');
  }
  return { tenantId: user.tenantId, userId: user.id, courseId: req.params.courseId };
}

function run(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('Cache-Control', 'no-store');
    void handler(req, res).catch(next);
  };
}

export const listLessonAuthorSessionController = run(async (req, res) => {
  if (Object.keys(req.query).some(key => !['limit', 'cursor', 'ui_locale'].includes(key))) {
    throw new AppError('Tham số danh sách không hợp lệ.', 400, 'LESSON_AUTHOR_SESSION_INPUT_INVALID');
  }
  const rawLimit = req.query.limit;
  const limit = rawLimit === undefined ? 20 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50 || Array.isArray(req.query.cursor)) {
    throw new AppError('Tham số danh sách không hợp lệ.', 400, 'LESSON_AUTHOR_SESSION_INPUT_INVALID');
  }
  const result = await listLessonAuthorSessions(owner(req), {
    limit,
    cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
  });
  res.json({ success: true, data: result });
});

export const renameLessonAuthorSessionController = run(async (req, res) => {
  const body = req.body as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some(key => !['title', 'expected_updated_at'].includes(key))
    || typeof body.title !== 'string'
    || body.expected_updated_at !== undefined && typeof body.expected_updated_at !== 'string') {
    throw new AppError('Tên phiên không hợp lệ.', 400, 'LESSON_AUTHOR_SESSION_INPUT_INVALID');
  }
  const result = await renameLessonAuthorSession(owner(req), req.params.conversationId, body.title,
    body.expected_updated_at as string | undefined);
  res.json({ success: true, data: result });
});

export const getLessonAuthorSessionDeleteImpactController = run(async (req, res) => {
  const result = await getLessonAuthorSessionDeleteImpact(owner(req), req.params.conversationId);
  res.json({ success: true, data: result });
});

export const deleteLessonAuthorSessionController = run(async (req, res) => {
  let result: Awaited<ReturnType<typeof requestLessonAuthorSessionDeletion>>;
  try {
    // Uses the same cross-instance Redis lock as generation admission, closing
    // the create/delete race before the durable database tombstone is written.
    result = await withLessonAuthorConversationLock(req.params.conversationId,
      () => requestLessonAuthorSessionDeletion(owner(req), req.params.conversationId));
  } catch (error) {
    if (error instanceof GenerationJobError && error.code === 'GENERATION_ALREADY_ACTIVE') {
      throw new AppError('Phiên đang tạo nội dung. Hãy chờ hoàn tất trước khi xóa.', 409, 'LESSON_AUTHOR_SESSION_ACTIVE');
    }
    throw error;
  }
  res.status(result.replayed ? 200 : 202).json({ success: true, data: result });
});

export const getLessonAuthorSessionDeletionStatusController = run(async (req, res) => {
  const result = await getLessonAuthorSessionDeletionStatus(owner(req), req.params.jobId);
  res.json({ success: true, data: result });
});
