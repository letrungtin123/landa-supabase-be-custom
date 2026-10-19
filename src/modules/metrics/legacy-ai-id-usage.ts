// ═══════════════════════════════════════════════════════════════
// Usage counters of the AI ID V1 entry points (legacy-ai-id-usage.logic.ts),
// wired at route level in ai-chatbot.routes.ts (mountLegacyAiIdCounters, and
// withCount on the V1 workspace runtime call). Each call that reaches one of
// those routes (after sign-in and tenant context, before its permission
// checks and validation) adds 1 to landa_legacy_ai_id_calls_total of this
// process (GET /internal/metrics) and writes one line, route and entry only:
//   [LegacyAiId] {"event":"legacy_ai_id_call","level":"info","ts":"...","route":"POST /api/...","entry":"..."}
// Counting never changes the request: it only calls next().
// ═══════════════════════════════════════════════════════════════

import type { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import { createJsonLogger, type JsonLogger } from '../../utils/json-logger.js';
import {
  aiChatbotRouterPath,
  createLegacyAiIdUsage,
  LEGACY_AI_ID_ENTRIES,
  LEGACY_AI_ID_MESSAGES_ROUTE,
  LEGACY_AI_ID_ROUTE_ENTRIES,
  legacyLessonAuthorMessageEntry,
  type LegacyAiIdEntry,
  type LegacyAiIdUsage,
} from './legacy-ai-id-usage.logic.js';

export const LESSON_AUTHOR_JOB_KEY_HEADER = 'X-Lesson-Author-Job-Key';

export interface LegacyAiIdRecorder {
  usage: LegacyAiIdUsage;
  /** Counts one call of `entry` and writes its log line. */
  record(entry: LegacyAiIdEntry): void;
  /** Route middleware: counts every request that reaches the route. */
  count(entry: LegacyAiIdEntry): RequestHandler;
  /** Route middleware of POST /chat/conversations/:id/messages: counts lesson-author turns only. */
  countLessonAuthorMessage(readTarget: (req: Request) => string | undefined): RequestHandler;
  /** `run`, counted as `entry` on every call. */
  withCount<Args extends unknown[], Result>(entry: LegacyAiIdEntry, run: (...args: Args) => Result): (...args: Args) => Result;
}

export function createLegacyAiIdRecorder(options: { usage?: LegacyAiIdUsage; logger?: JsonLogger } = {}): LegacyAiIdRecorder {
  const usage = options.usage ?? createLegacyAiIdUsage();
  const logger = options.logger ?? createJsonLogger({ tag: 'LegacyAiId' });

  function record(entry: LegacyAiIdEntry): void {
    usage.record(entry);
    logger.info('legacy_ai_id_call', { route: LEGACY_AI_ID_ENTRIES[entry], entry });
  }

  return {
    usage,
    record,
    count(entry) {
      return function countLegacyAiIdCall(_req: Request, _res: Response, next: NextFunction): void {
        record(entry);
        next();
      };
    },
    countLessonAuthorMessage(readTarget) {
      return function countLegacyLessonAuthorMessage(req: Request, _res: Response, next: NextFunction): void {
        const body = req.body as { chapter_resume?: unknown } | undefined;
        const entry = legacyLessonAuthorMessageEntry({
          target: readTarget(req),
          jobKeyHeader: req.get(LESSON_AUTHOR_JOB_KEY_HEADER),
          chapterResume: body?.chapter_resume,
        });
        if (entry) record(entry);
        next();
      };
    },
    withCount(entry, run) {
      return (...args) => {
        record(entry);
        return run(...args);
      };
    },
  };
}

/** The counters of this process (read by metrics.service.ts). */
export const legacyAiId: LegacyAiIdRecorder = createLegacyAiIdRecorder();

/**
 * Adds the counting steps to the /api/ai-chatbot router, ahead of the routes
 * they count (call it before those routes are registered). Each step counts
 * and calls next(), so the real route answers exactly as before.
 */
export function mountLegacyAiIdCounters(
  router: Pick<Router, 'get' | 'post'>,
  recorder: LegacyAiIdRecorder,
  readTarget: (req: Request) => string | undefined,
): void {
  const mount = (route: string, handler: RequestHandler) => {
    const { method, path } = aiChatbotRouterPath(route);
    if (method === 'get') router.get(path, handler);
    else router.post(path, handler);
  };
  for (const entry of LEGACY_AI_ID_ROUTE_ENTRIES) mount(LEGACY_AI_ID_ENTRIES[entry], recorder.count(entry));
  mount(LEGACY_AI_ID_MESSAGES_ROUTE, recorder.countLessonAuthorMessage(readTarget));
}
