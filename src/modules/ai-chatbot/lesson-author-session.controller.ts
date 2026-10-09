import type { NextFunction, Request, Response } from 'express';
import { GenerationJobError } from './lesson-author-generation-job.logic.js';
import { withLessonAuthorConversationLock } from './chat.service.js';
import { LessonAuthorSessionError, parseLessonAuthorSessionScope } from './lesson-author-session-access.logic.js';
import { sendLessonAuthorSessionError } from './lesson-author-session-access.controller.js';
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
    throw new LessonAuthorSessionError('FORBIDDEN');
  }
  return { tenantId: user.tenantId, userId: user.id, role: user.role, courseId: req.params.courseId };
}

/** Session refusals answer with a stable code in the request locale. */
function run(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('Cache-Control', 'no-store');
    void handler(req, res).catch(error => {
      if (error instanceof LessonAuthorSessionError) { sendLessonAuthorSessionError(req, res, error); return; }
      next(error);
    });
  };
}

export const listLessonAuthorSessionController = run(async (req, res) => {
  if (Object.keys(req.query).some(key => !['limit', 'cursor', 'scope', 'ui_locale'].includes(key))) {
    throw new LessonAuthorSessionError('INPUT_INVALID');
  }
  const rawLimit = req.query.limit;
  const limit = rawLimit === undefined ? 20 : Number(rawLimit);
  const scope = parseLessonAuthorSessionScope(req.query.scope);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50 || Array.isArray(req.query.cursor) || !scope) {
    throw new LessonAuthorSessionError('INPUT_INVALID');
  }
  const result = await listLessonAuthorSessions(owner(req), {
    limit,
    scope,
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
    throw new LessonAuthorSessionError('INPUT_INVALID');
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
      throw new LessonAuthorSessionError('ACTIVE');
    }
    throw error;
  }
  res.status(result.replayed ? 200 : 202).json({ success: true, data: { job_id: result.job_id, replayed: result.replayed } });
});

export const getLessonAuthorSessionDeletionStatusController = run(async (req, res) => {
  const result = await getLessonAuthorSessionDeletionStatus(owner(req), req.params.jobId);
  res.json({ success: true, data: result });
});
