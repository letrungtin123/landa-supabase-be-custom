// Routes of the AI ID organization context, mounted by ai-chatbot.routes.ts after authenticate and
// tenantContext. Every route has the authority of the AI ID source documents: the course data
// permission (checkPermission('courses','can_edit')) and an AI ID author (lessonAuthorAuthor); never
// the ai_chatbot management module.

import type { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import { createOrgContextHandlers, parseOrgContextUpload } from './lesson-author-org-context.controller.js';
import type { OrgContextService } from './lesson-author-org-context.service.js';

export const ORG_CONTEXT_BASE_PATH = '/chat/lesson-author/org-context';

type AsyncMiddleware = (req: Request, res: Response, next: NextFunction) => Promise<void>;
type AsyncHandler = (req: Request, res: Response) => Promise<void>;

/** Keeps Express's void handler signature and hands a rejection to next(); the route table keeps the name. */
function orgContextRoute(handler: AsyncMiddleware | AsyncHandler): RequestHandler {
  const route: RequestHandler = (req, res, next) => { void handler(req, res, next).catch(next); };
  Object.defineProperty(route, 'name', { value: handler.name || 'orgContextRoute' });
  return route;
}

export function mountOrgContextRoutes(router: Router, input: {
  coursePermission: AsyncMiddleware;
  author: AsyncMiddleware;
  service: OrgContextService;
}): void {
  const handlers = createOrgContextHandlers({
    service: input.service,
    report: record => console.warn('[LessonAuthorOrgContext] ' + JSON.stringify(record)),
  });
  const guards = [orgContextRoute(input.coursePermission), orgContextRoute(input.author)];
  const base = ORG_CONTEXT_BASE_PATH;
  router.get(base, ...guards, orgContextRoute(handlers.state));
  router.post(`${base}/documents`, ...guards, parseOrgContextUpload, orgContextRoute(handlers.upload));
  router.delete(`${base}/documents/:documentId`, ...guards, orgContextRoute(handlers.deleteDocument));
  router.post(`${base}/profile/distill`, ...guards, orgContextRoute(handlers.distill));
  router.put(`${base}/profile`, ...guards, orgContextRoute(handlers.saveProfile));
  router.post(`${base}/profile/restore`, ...guards, orgContextRoute(handlers.restoreProfile));
  router.get(`${base}/profile/versions/:version`, ...guards, orgContextRoute(handlers.version));
}
