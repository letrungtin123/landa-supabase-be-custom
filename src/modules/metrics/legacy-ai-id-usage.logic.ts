// ═══════════════════════════════════════════════════════════════
// Usage of the AI ID V1 entry points (the routes that reach
// modules/ai-chatbot/ai-id/legacy/), counted so they can be removed once
// they get no traffic. Pure: the table of entries, the counter store, the
// metric family and the classification of a chat message request.
//
//   landa_legacy_ai_id_calls_total{route="<method> <route template>",entry="<entry>"}
//
// Bounded: labels come only from LEGACY_AI_ID_ENTRIES, never from a request.
// ═══════════════════════════════════════════════════════════════

import type { MetricFamily } from './metrics.logic.js';

const MESSAGES_ROUTE = 'POST /api/ai-chatbot/chat/conversations/:id/messages';

/** Every counted entry: the route template it arrives on (method + path under /api/ai-chatbot). */
export const LEGACY_AI_ID_ENTRIES = {
  /** A lesson-author chat turn streamed by the V1 flow (proposal / Blueprint / chat). */
  lesson_author_message: MESSAGES_ROUTE,
  /** A lesson-author turn with X-Lesson-Author-Job-Key: V1 durable Blueprint generation job. */
  durable_blueprint_enqueue: MESSAGES_ROUTE,
  /** A lesson-author turn with chapter_resume: V1 chapter checkpoint resume. */
  chapter_checkpoint_resume: MESSAGES_ROUTE,
  /** V1 chapter checkpoint status. */
  chapter_checkpoint_status: 'GET /api/ai-chatbot/chat/lesson-author/conversations/:conversationId/chapter-checkpoint',
  /** Status of a V1 durable Blueprint generation job. */
  generation_job_status: 'GET /api/ai-chatbot/chat/lesson-author/conversations/:conversationId/generation-jobs/:jobId',
  /** Apply of a V1 proposal job to the course structure. */
  proposal_job_apply: 'POST /api/ai-chatbot/lesson-author/jobs/:jobId/apply',
  /** Workspace launch on the V1 workspace runtime (orchestration V2 admission off). */
  workspace_v1_launch: 'POST /api/ai-chatbot/chat/lesson-author/courses/:courseId/conversations/:conversationId/workspaces',
} as const;

export type LegacyAiIdEntry = keyof typeof LEGACY_AI_ID_ENTRIES;

/** Entries counted by a step on their own route (mountLegacyAiIdCounters). */
export const LEGACY_AI_ID_ROUTE_ENTRIES = [
  'chapter_checkpoint_status',
  'generation_job_status',
  'proposal_job_apply',
] as const satisfies readonly LegacyAiIdEntry[];

/** The chat message route, counted per lesson-author turn (legacyLessonAuthorMessageEntry). */
export const LEGACY_AI_ID_MESSAGES_ROUTE = MESSAGES_ROUTE;

/** Method and path of `route` on the /api/ai-chatbot router. */
export function aiChatbotRouterPath(route: string): { method: 'get' | 'post'; path: string } {
  const match = /^(GET|POST) \/api\/ai-chatbot(\/\S+)$/.exec(route);
  if (!match) throw new Error(`[LegacyAiId] not a route of /api/ai-chatbot: ${route}`);
  return { method: match[1] === 'GET' ? 'get' : 'post', path: match[2] };
}

export const LEGACY_AI_ID_ENTRY_NAMES = Object.keys(LEGACY_AI_ID_ENTRIES) as LegacyAiIdEntry[];

export interface LegacyAiIdUsage {
  record(entry: LegacyAiIdEntry): void;
  /** Every entry, in table order, with its count (0 when never called). */
  snapshot(): Array<{ entry: LegacyAiIdEntry; route: string; value: number }>;
}

export function createLegacyAiIdUsage(): LegacyAiIdUsage {
  const counts = new Map<LegacyAiIdEntry, number>(LEGACY_AI_ID_ENTRY_NAMES.map((entry) => [entry, 0]));
  return {
    record(entry) {
      if (!counts.has(entry)) throw new Error(`[LegacyAiId] unknown entry: ${String(entry)}`);
      counts.set(entry, (counts.get(entry) ?? 0) + 1);
    },
    snapshot() {
      return LEGACY_AI_ID_ENTRY_NAMES.map((entry) => ({ entry, route: LEGACY_AI_ID_ENTRIES[entry], value: counts.get(entry) ?? 0 }));
    },
  };
}

export function legacyAiIdMetricFamilies(usage: LegacyAiIdUsage): MetricFamily[] {
  return [
    {
      name: 'landa_legacy_ai_id_calls_total',
      help: 'Calls that reached an AI ID V1 (legacy) entry point since the process started.',
      type: 'counter',
      samples: usage.snapshot().map(({ entry, route, value }) => ({ labels: { route, entry }, value })),
    },
  ];
}

/**
 * The V1 entry of POST /chat/conversations/:id/messages, from the request
 * shape the controller dispatches on (chat.controller.ts sendMessage), or
 * null for a chat of another target (learner, admin, AI Report).
 */
export function legacyLessonAuthorMessageEntry(request: {
  target: string | undefined;
  jobKeyHeader: string | undefined;
  chapterResume: unknown;
}): LegacyAiIdEntry | null {
  if (request.target !== 'lesson_author') return null;
  if (request.chapterResume !== undefined) return 'chapter_checkpoint_resume';
  if (request.jobKeyHeader) return 'durable_blueprint_enqueue';
  return 'lesson_author_message';
}
