// One admin chat turn on the report path: route the question (or apply the
// filters chosen in the UI), then persist exactly one assistant message: a
// filter request, a clarification with chips, or a report analysis.
//
// Report problems a user can fix (ambiguous period or unit, a unit outside
// their scope, a reversed range) become clarification turns. Everything else
// is a typed ReportChatError, so the generic chat error handling can neither
// rewrite it as "Yêu cầu không hợp lệ" nor mark the bot KB store broken.

import type { UserRole } from '../../types/index.js';
import {
  REPORT_DATA_UNAVAILABLE_CODE,
  ReportChatError,
  isReportChatError,
  readReportDomainErrorCode,
} from './report-chat-error.logic.js';
import { formatReportClarificationMessage } from './report-chat-clarification.logic.js';
import {
  buildReportClarification,
  checkReportFilterScope,
  reportCourseRequestFields,
  type ReportActorScope,
  type ReportClarification,
  type ReportRequestContext,
  type ReportRouteDecision,
} from './report-chat-route.logic.js';
import {
  defaultReportRouterDeps,
  loadReportActorScope,
  resolveReportQuestionCourse,
  routeAdminReportQuestion,
  type ReportRouterDeps,
} from './report-chat-router.service.js';
import {
  buildReportChatSnapshot,
  formatReportFilterRequest,
  generateReportNarrative,
  getReportSnapshotHash,
  isPotentialReportYearCorrection,
  resolveReportYearCorrection,
  type ReportChatFilterInput,
} from './report-chat.service.js';
import {
  insertReportAssistantMessage,
  loadLatestReportAnalysisContext,
  touchReportConversation,
} from './report-chat.repository.js';
import { permittedReportGroups } from './report-org-unit.logic.js';

export type ReportChatSideEvent =
  | {
    type: 'report_filter';
    message_id: string;
    question: string;
    locale: 'vi' | 'en';
    suggested_filter?: ReportChatFilterInput;
  }
  | { type: 'report_result'; message_id: string; metadata: Record<string, unknown> }
  | { type: 'report_status'; stage: 'collecting' | 'analyzing' };

export interface AdminReportTurnInput {
  conversationId: string;
  tenantId: string;
  userId: string;
  role: UserRole;
  locale: 'vi' | 'en';
  question: string;
  reportFilters?: ReportChatFilterInput;
  chatModel: string;
  isFirstMessage: boolean;
  correlationId?: string | null;
}

export interface AdminReportTurnIO {
  chunk: (text: string) => void;
  sideEvent: (event: ReportChatSideEvent) => void;
  /** Settles the turn's token reservation from an estimate of the model input/output. */
  finalize: (inputParts: string[], outputText: string, metadata: Record<string, unknown>) => Promise<void>;
}

export interface AdminReportTurnDeps {
  router: ReportRouterDeps;
  route: typeof routeAdminReportQuestion;
  buildSnapshot: typeof buildReportChatSnapshot;
  generateNarrative: typeof generateReportNarrative;
  loadLatestAnalysis: typeof loadLatestReportAnalysisContext;
  saveAssistantMessage: typeof insertReportAssistantMessage;
  touchConversation: typeof touchReportConversation;
}

export const defaultAdminReportTurnDeps: AdminReportTurnDeps = {
  router: defaultReportRouterDeps,
  route: routeAdminReportQuestion,
  buildSnapshot: buildReportChatSnapshot,
  generateNarrative: generateReportNarrative,
  loadLatestAnalysis: loadLatestReportAnalysisContext,
  saveAssistantMessage: insertReportAssistantMessage,
  touchConversation: touchReportConversation,
};

type Decision = Exclude<ReportRouteDecision, { kind: 'direct' }>;

function conversationTitle(question: string): string {
  return question.slice(0, 50) + (question.length > 50 ? '...' : '');
}

async function saveAndAnnounce(
  input: AdminReportTurnInput,
  deps: AdminReportTurnDeps,
  content: string,
  metadata: Record<string, unknown>,
): Promise<string> {
  const messageId = await deps.saveAssistantMessage(input.conversationId, content, metadata);
  await deps.touchConversation({
    conversationId: input.conversationId,
    tenantId: input.tenantId,
    title: conversationTitle(input.question),
    setTitle: input.isFirstMessage,
  });
  return messageId;
}

async function respondWithClarification(
  input: AdminReportTurnInput,
  io: AdminReportTurnIO,
  deps: AdminReportTurnDeps,
  reportQuestion: string,
  clarification: ReportClarification,
  suggestedFilter: ReportChatFilterInput,
): Promise<void> {
  const assistantText = formatReportClarificationMessage(clarification, input.locale);
  await saveAndAnnounce(input, deps, assistantText, {
    kind: 'report_clarification',
    report_chat: true,
    locale: input.locale,
    report_question: reportQuestion,
    report_clarification: clarification,
    report_suggested_filter: suggestedFilter,
  });
  io.chunk(assistantText);
  await io.finalize([input.question], assistantText, { report_chat: true, report_stage: 'clarification', report_reasons: clarification.reasons });
}

/**
 * Turns a scope/range error raised while reading data (a unit removed since
 * the filter was chosen, a learner_plus unit outside their groups) into a
 * clarification; returns null for errors that are not the user's to fix.
 */
async function clarificationForDomainError(
  error: unknown,
  input: AdminReportTurnInput,
  deps: AdminReportTurnDeps,
  filter: ReportChatFilterInput,
): Promise<{ clarification: ReportClarification; suggested: ReportChatFilterInput } | null> {
  const code = readReportDomainErrorCode(error);
  if (!code) return null;
  const period = filter.date_from && filter.date_to ? { date_from: filter.date_from, date_to: filter.date_to } : null;
  if (code === 'REPORT_RANGE_INVALID') {
    return { clarification: buildReportClarification({ reasons: ['date_invalid'], periods: [], units: [] }), suggested: {} };
  }
  const scope: ReportActorScope = await loadReportActorScope(input, deps.router, true);
  const permitted = scope.restricted && scope.catalog && scope.allowedGroupIds
    ? permittedReportGroups(scope.catalog, scope.allowedGroupIds)
    : [];
  const choices = scope.restricted ? permitted.map((unit) => ({ unit })) : [{ unit: null, allScope: true }];
  if (code === 'REPORT_SCOPE_REQUIRED') {
    return { clarification: buildReportClarification({ reasons: ['scope_required'], periods: [period], units: choices }), suggested: period ?? {} };
  }
  // The unit came as an id from the filters: the reply never names it (it may lie outside the actor's groups).
  return {
    clarification: buildReportClarification({
      reasons: [code === 'REPORT_SCOPE_FORBIDDEN' ? 'unit_forbidden' : 'unit_not_found'],
      periods: [period],
      units: choices,
    }),
    suggested: period ?? {},
  };
}

async function resolveDecision(input: AdminReportTurnInput, deps: AdminReportTurnDeps): Promise<{
  decision: ReportRouteDecision;
  reportQuestion: string;
  correction: { user_message: string; corrected_year: number } | null;
}> {
  const previous = !input.reportFilters && isPotentialReportYearCorrection(input.question)
    ? await deps.loadLatestAnalysis(input.conversationId)
    : null;
  const correction = previous
    ? resolveReportYearCorrection({ question: input.question, previousFilter: previous.filter, previousQuestion: previous.question })
    : null;
  if (!input.reportFilters && !correction) {
    return {
      decision: await deps.route({
        tenantId: input.tenantId,
        userId: input.userId,
        role: input.role,
        model: input.chatModel,
        question: input.question,
        locale: input.locale,
        correlationId: input.correlationId,
      }, deps.router),
      reportQuestion: input.question,
      correction: null,
    };
  }
  const filter = input.reportFilters ?? correction!.filter;
  const reportQuestion = correction?.reportQuestion ?? input.question;
  // Filters chosen in the UI re-run the original question: it keeps naming
  // the same catalog course (an ambiguous name is not asked again here).
  const [scope, course] = await Promise.all([
    loadReportActorScope(input, deps.router, false),
    resolveReportQuestionCourse({ tenantId: input.tenantId, question: reportQuestion, correlationId: input.correlationId }, deps.router),
  ]);
  const check = checkReportFilterScope(filter, scope);
  const request: ReportRequestContext = {
    period_source: input.reportFilters ? 'filters' : 'correction',
    unit_source: 'filters',
    ...reportCourseRequestFields(course),
  };
  return {
    decision: check.kind === 'ok'
      ? { kind: 'snapshot', filter: check.filter, request }
      : { kind: 'clarification', clarification: check.clarification, suggested_filter: check.suggested_filter },
    reportQuestion,
    correction: correction ? { user_message: input.question, corrected_year: correction.year } : null,
  };
}

async function respondWithFilterRequest(
  input: AdminReportTurnInput,
  io: AdminReportTurnIO,
  deps: AdminReportTurnDeps,
  suggestedFilter: ReportChatFilterInput,
): Promise<void> {
  const assistantText = formatReportFilterRequest(input.locale);
  const messageId = await saveAndAnnounce(input, deps, assistantText, {
    kind: 'report_filter_request',
    locale: input.locale,
    report_question: input.question,
    report_suggested_filter: suggestedFilter,
  });
  io.chunk(assistantText);
  io.sideEvent({ type: 'report_filter', message_id: messageId, question: input.question, locale: input.locale, suggested_filter: suggestedFilter });
  await io.finalize([input.question], assistantText, { report_chat: true, report_stage: 'filter_request' });
}

async function respondWithAnalysis(
  input: AdminReportTurnInput,
  io: AdminReportTurnIO,
  deps: AdminReportTurnDeps,
  decision: Extract<Decision, { kind: 'snapshot' }>,
  reportQuestion: string,
  correction: { user_message: string; corrected_year: number } | null,
): Promise<void> {
  io.sideEvent({ type: 'report_status', stage: 'collecting' });
  let snapshot: Awaited<ReturnType<AdminReportTurnDeps['buildSnapshot']>>;
  try {
    snapshot = await deps.buildSnapshot({
      tenantId: input.tenantId,
      actor: { userId: input.userId, tenantId: input.tenantId, role: input.role },
      filter: decision.filter,
      question: reportQuestion,
      granularity: decision.request.granularity ?? null,
      courseHint: decision.request.course_hint ?? null,
      course: decision.request.course_id && decision.request.course_hint
        ? { id: decision.request.course_id, name: decision.request.course_hint }
        : null,
      scopeOptions: { requireExplicitLearnerPlusScope: true },
    });
  } catch (error) {
    const clarification = await clarificationForDomainError(error, input, deps, decision.filter);
    if (!clarification) throw error;
    await respondWithClarification(input, io, deps, reportQuestion, clarification.clarification, clarification.suggested);
    return;
  }
  io.sideEvent({ type: 'report_status', stage: 'analyzing' });
  const narrative = await deps.generateNarrative({ tenantId: input.tenantId, model: input.chatModel, locale: input.locale, snapshot });
  // Facts live exclusively in report_snapshot. This short text is only a
  // fallback for legacy/accessibility rendering and must not contain data.
  const assistantText = input.locale === 'en' ? 'Your report analysis is ready.' : 'Phân tích báo cáo đã sẵn sàng.';
  io.chunk(assistantText);
  const metadata: Record<string, unknown> = {
    kind: 'report_analysis',
    report_chat: true,
    report_ui_version: 2,
    locale: input.locale,
    report_contract_version: snapshot.version,
    report_filter: snapshot.filter,
    report_scope: snapshot.scope,
    report_question: reportQuestion,
    report_request: decision.request,
    ...(correction ? { report_follow_up_correction: correction } : {}),
    report_generated_at: snapshot.generated_at,
    report_snapshot_hash: getReportSnapshotHash(snapshot),
    report_snapshot: snapshot,
    report_narrative: narrative,
  };
  const messageId = await saveAndAnnounce(input, deps, assistantText, metadata);
  io.sideEvent({ type: 'report_result', message_id: messageId, metadata });
  await io.finalize(
    // Gemini only receives signal IDs/categories, never the factual snapshot.
    [input.question, JSON.stringify(snapshot.signals.map((signal) => ({ id: signal.id, category: signal.category, severity: signal.severity })))],
    JSON.stringify(narrative),
    { report_chat: true, report_stage: 'analysis', report_snapshot_hash: metadata.report_snapshot_hash },
  );
}

/**
 * Returns 'not_report' when the question belongs to the normal chat; in every
 * other case exactly one assistant message has been persisted and streamed.
 */
export async function handleAdminReportTurn(
  input: AdminReportTurnInput,
  io: AdminReportTurnIO,
  deps: AdminReportTurnDeps = defaultAdminReportTurnDeps,
): Promise<'handled' | 'not_report'> {
  try {
    const { decision, reportQuestion, correction } = await resolveDecision(input, deps);
    if (decision.kind === 'direct') return 'not_report';
    if (decision.kind === 'filters') {
      await respondWithFilterRequest(input, io, deps, decision.suggested_filter);
    } else if (decision.kind === 'clarification') {
      await respondWithClarification(input, io, deps, reportQuestion, decision.clarification, decision.suggested_filter);
    } else {
      await respondWithAnalysis(input, io, deps, decision, reportQuestion, correction);
    }
    return 'handled';
  } catch (error) {
    if (isReportChatError(error)) throw error;
    console.error(JSON.stringify({
      event: 'report_chat_turn_failed',
      correlation_id: input.correlationId ?? null,
      tenant_id: input.tenantId,
      conversation_id: input.conversationId,
      error_class: error instanceof Error ? error.name : typeof error,
      error_code: error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : null,
      message: error instanceof Error ? error.message.slice(0, 300) : null,
    }));
    throw new ReportChatError(REPORT_DATA_UNAVAILABLE_CODE, input.locale);
  }
}
