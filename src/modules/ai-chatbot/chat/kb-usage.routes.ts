// Routes of the exclusive knowledge base rule, mounted by ai-chatbot.routes.ts after authenticate and
// tenantContext, next to the bot assignments (same permission as GET /bots/assignments).

import type { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import { getKbUsageConflicts } from './kb-usage.controller.js';

type AsyncMiddleware = (req: Request, res: Response, next: NextFunction) => Promise<void>;
type AsyncHandler = (req: Request, res: Response) => Promise<void>;

/** Keeps Express's void handler signature and hands a rejection to next(); the route table keeps the name. */
function kbUsageRoute(handler: AsyncMiddleware | AsyncHandler): RequestHandler {
  const route: RequestHandler = (req, res, next) => { void handler(req, res, next).catch(next); };
  Object.defineProperty(route, 'name', { value: handler.name || 'kbUsageRoute' });
  return route;
}

export function mountKbUsageRoutes(router: Router, input: { viewPermission: AsyncMiddleware }): void {
  // Knowledge bases used in two or more places (admin page, learner page, AI ID); read only.
  router.get('/kb-usage-conflicts', kbUsageRoute(input.viewPermission), kbUsageRoute(getKbUsageConflicts));
}
