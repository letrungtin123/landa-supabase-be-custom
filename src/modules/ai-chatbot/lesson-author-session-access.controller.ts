import type { NextFunction, Request, Response } from 'express';
import type { AuthUser } from '../../types/express.js';
import type { GenerationJobSql } from './lesson-author-generation-job.repository.js';
import {
  LessonAuthorSessionError,
  lessonAuthorRequestLocale,
  type LessonAuthorSessionErrorCode,
} from './lesson-author-session-access.logic.js';
import { findLessonAuthorSessionOwner, listLessonAuthorActiveRuns } from './lesson-author-session-access.repository.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AUTHOR_ROLES = new Set(['staff', 'superuser', 'superadmin']);

export interface LessonAuthorSessionAccessDependencies {
  db: Pick<GenerationJobSql, 'query'>;
  /** The shared permission matrix (hasPermission) for the authenticated caller. */
  canEditCourses: (user: AuthUser) => Promise<boolean>;
}

export function requestLocale(req: Request): 'vi' | 'en' {
  return lessonAuthorRequestLocale(req.query.ui_locale, req.get('X-UI-Locale'));
}

/** Same `{ success, code, message }` body as every other localized refusal. */
export function sendLessonAuthorSessionError(req: Request, res: Response, error: LessonAuthorSessionError): void {
  res.setHeader('Cache-Control', 'no-store');
  res.status(error.statusCode).json({ success: false, code: error.code, message: error.localizedMessage(requestLocale(req)) });
}

function refuse(req: Request, res: Response, code: LessonAuthorSessionErrorCode): void {
  sendLessonAuthorSessionError(req, res, new LessonAuthorSessionError(code));
}

function courseEditorCandidate(user: AuthUser | undefined): user is AuthUser & { tenantId: string } {
  return !!user && user.sessionMode === 'normal' && AUTHOR_ROLES.has(user.role)
    && typeof user.tenantId === 'string' && UUID.test(user.tenantId) && UUID.test(user.id);
}

/**
 * Write boundary for every lesson-author route keyed by a conversation: only
 * the creator may continue the session. A course editor of the same tenant who
 * can see the session gets a clear localized 403; anyone else (other tenant,
 * no course permission, unknown id) falls through to the route's existing
 * not-found handling, so this guard never reveals a session to them.
 * Install after authenticate + tenantContext and BEFORE any body/file parser.
 */
export function createLessonAuthorSessionOwnerGuard(deps: LessonAuthorSessionAccessDependencies) {
  return (conversationParam: string, options: { courseParam?: string } = {}) =>
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      const user = req.user;
      const conversationId = req.params[conversationParam];
      if (!courseEditorCandidate(user) || typeof conversationId !== 'string' || !UUID.test(conversationId)) { next(); return; }
      const courseId = options.courseParam ? req.params[options.courseParam] : undefined;
      try {
        const owner = await findLessonAuthorSessionOwner(deps.db, {
          tenantId: user.tenantId, conversationId, ...(typeof courseId === 'string' ? { courseId } : {}),
        });
        if (!owner || owner.owner_id === user.id) { next(); return; }
        if (!await deps.canEditCourses(user)) { next(); return; }
        refuse(req, res, 'NOT_OWNER');
      } catch (error) { next(error); }
    };
}

/**
 * Using AI course design needs the course data permission, never the chatbot
 * configuration module. Applies only when the runtime chat target is the
 * lesson author; admin/learner chat keep their deployment-only rules.
 */
export function createLessonAuthorCourseEditorGuard(deps: Pick<LessonAuthorSessionAccessDependencies, 'canEditCourses'>,
  readTarget: (req: Request) => string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (readTarget(req) !== 'lesson_author') { next(); return; }
    const user = req.user;
    try {
      if (!courseEditorCandidate(user) || !await deps.canEditCourses(user)) { refuse(req, res, 'COURSE_EDIT_REQUIRED'); return; }
      next();
    } catch (error) { next(error); }
  };
}

/** GET …/courses/:courseId/sessions/active-runs — banner data, read-only. */
export function createLessonAuthorActiveRunsHandler(deps: Pick<LessonAuthorSessionAccessDependencies, 'db'>) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    res.setHeader('Cache-Control', 'no-store');
    const user = req.user, courseId = req.params.courseId;
    if (!courseEditorCandidate(user)) { refuse(req, res, 'FORBIDDEN'); return; }
    if (typeof courseId !== 'string' || !courseId.trim() || courseId.length > 255 || /[\x00-\x1f\x7f]/.test(courseId)
      || Object.keys(req.query).some(key => key !== 'ui_locale')) { refuse(req, res, 'INPUT_INVALID'); return; }
    try {
      const items = await listLessonAuthorActiveRuns(deps.db, { tenantId: user.tenantId, courseId, actorId: user.id });
      res.json({ success: true, data: { items } });
    } catch (error) { next(error); }
  };
}
