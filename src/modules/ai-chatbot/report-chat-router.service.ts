// Routing of an admin chat question to the report path. The model always
// receives the question (no regex fast path skips it) and returns structured
// parameters; the deterministic parser and the org-unit resolver cross-check
// them before anything reaches the report SQL. The model call has a hard
// deadline: past it the turn continues with the deterministic parser only.

import { FunctionCallingConfigMode, Type, type FunctionDeclaration } from '@google/genai';
import { env } from '../../config/env.js';
import type { UserRole } from '../../types/index.js';
import { loadReportAllowedGroupIds } from '../reports/report-access.service.js';
import { getGeminiClient } from './gemini.service.js';
import { reportAiGenerationConfig, resolveReportAiModel } from './report-ai-model.js';
import { withReportDeadline } from './report-deadline.logic.js';
import { localYmd } from './report-date.logic.js';
import {
  decideReportRoute,
  detectReportIntent,
  parseReportRouterToolCall,
  type ReportActorScope,
  type ReportRouteDecision,
  type ReportRouterModelOutput,
} from './report-chat-route.logic.js';
import { hasReportUnitWord, resolveReportOrgUnits, type ReportGroupLabels, type ReportOrgUnitCatalog } from './report-org-unit.logic.js';
import { loadReportGroupLabels, loadReportOrgUnitCatalog } from './report-org-unit-resolver.service.js';
import { parseReportTimeExpression } from './report-time-expression.logic.js';

const REPORT_ROUTER_FUNCTIONS: FunctionDeclaration[] = [
  {
    name: 'get_report_snapshot',
    description: 'Use only when the user asks for factual learning/report metrics, trends, completion, enrollment, learner progress, or course rankings from the dashboard database.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        date_from: { type: Type.STRING, description: 'ISO YYYY-MM-DD first day of the period the user stated. Omit when the user stated no period.' },
        date_to: { type: Type.STRING, description: 'ISO YYYY-MM-DD last day (inclusive) of the period the user stated.' },
        granularity: { type: Type.STRING, enum: ['day', 'week', 'month', 'quarter'], description: 'Only when the user asks for a breakdown per day, week, month or quarter.' },
        org_units: {
          type: Type.ARRAY,
          description: 'Every group, subgroup, team or department the user named, exactly as written. Never translate, normalise or invent names or IDs.',
          items: {
            type: Type.OBJECT,
            properties: {
              name: { type: Type.STRING, description: 'The unit name exactly as the user wrote it.' },
              level: { type: Type.STRING, enum: ['group', 'subgroup', 'team', 'unknown'], description: 'Only if the user said which kind of unit it is.' },
            },
            required: ['name'],
          },
        },
        compare: { type: Type.BOOLEAN, description: 'True when the user asks to compare periods or units.' },
        course: { type: Type.STRING, description: 'One course name exactly as written, when the question is about a single course.' },
      },
    },
  },
  {
    name: 'respond_directly',
    description: 'Use for every request that does not require factual dashboard report data.',
    parameters: { type: Type.OBJECT, properties: {} },
  },
];

function routerInstruction(locale: 'vi' | 'en', today: string): string {
  return locale === 'en'
    ? `You are a strict intent router. Today is ${today} in Asia/Ho_Chi_Minh. Do not answer the user. Choose get_report_snapshot only for factual dashboard data requests; choose respond_directly for writing, explanations, definitions or anything that does not need dashboard data. Dates: return ISO YYYY-MM-DD; weeks start on Monday; "this week/month/quarter/year" and "to date/until now" end today; a date without a year is in the current year; keep any year the user wrote; never add a period the user did not mention. Organization units: copy names exactly as written. Never invent IDs, SQL, metrics, filters or data.`
    : `Bạn là bộ định tuyến ý định nghiêm ngặt. Hôm nay là ${today} theo múi giờ Asia/Ho_Chi_Minh. Không trả lời người dùng. Chỉ chọn get_report_snapshot khi người dùng cần số liệu thực tế từ dashboard; chọn respond_directly cho viết nội dung, giải thích, định nghĩa hoặc mọi yêu cầu không cần dữ liệu dashboard. Ngày: trả về ISO YYYY-MM-DD; tuần bắt đầu từ thứ Hai; "tuần/tháng/quý/năm này" và "đến nay" kết thúc hôm nay; mốc không nêu năm thuộc năm hiện tại; giữ nguyên năm người dùng đã nêu; không tự thêm khoảng thời gian người dùng không nói. Đơn vị tổ chức: chép đúng tên như người dùng viết. Không tự tạo ID, SQL, metric, bộ lọc hoặc số liệu.`;
}

export async function callReportRouterModel(input: {
  tenantId: string;
  model: string;
  question: string;
  locale: 'vi' | 'en';
  today: string;
  signal?: AbortSignal;
}): Promise<ReportRouterModelOutput> {
  const aiClient = await getGeminiClient(input.tenantId);
  const model = resolveReportAiModel(input.model);
  const response = await aiClient.models.generateContent({
    model,
    contents: [{ role: 'user', parts: [{ text: input.question }] }],
    config: {
      systemInstruction: routerInstruction(input.locale, input.today),
      tools: [{ functionDeclarations: REPORT_ROUTER_FUNCTIONS }],
      toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.ANY } },
      ...reportAiGenerationConfig(model, 256),
      ...(input.signal ? { abortSignal: input.signal } : {}),
    },
  });
  const call = response.functionCalls?.[0] ?? null;
  return parseReportRouterToolCall(call ? { name: call.name, args: call.args } : null, input.today);
}

export interface ReportRouterActor {
  userId: string;
  tenantId: string;
  role: UserRole;
}

export interface ReportRouterDeps {
  callModel: typeof callReportRouterModel;
  loadCatalog: (tenantId: string) => Promise<ReportOrgUnitCatalog>;
  loadLabels: (tenantId: string) => Promise<ReportGroupLabels>;
  loadAllowedGroupIds: (actor: ReportRouterActor) => Promise<string[]>;
  log: (event: Record<string, unknown>) => void;
  /** Deadline of the model call; REPORT_CHAT_ROUTER_TIMEOUT_MS when absent. */
  modelTimeoutMs?: number;
}

export const defaultReportRouterDeps: ReportRouterDeps = {
  callModel: callReportRouterModel,
  loadCatalog: loadReportOrgUnitCatalog,
  loadLabels: loadReportGroupLabels,
  loadAllowedGroupIds: loadReportAllowedGroupIds,
  log: (event) => console.info(JSON.stringify(event)),
};

/** learner_plus scope; the catalog is loaded only when names must be resolved or shown. */
export async function loadReportActorScope(
  actor: ReportRouterActor,
  deps: Pick<ReportRouterDeps, 'loadCatalog' | 'loadAllowedGroupIds'>,
  needCatalog: boolean,
): Promise<ReportActorScope> {
  const restricted = actor.role === 'learner_plus';
  const [allowedGroupIds, catalog] = await Promise.all([
    restricted ? deps.loadAllowedGroupIds(actor) : Promise.resolve(null),
    needCatalog || restricted ? deps.loadCatalog(actor.tenantId) : Promise.resolve(null),
  ]);
  return { restricted, allowedGroupIds, catalog };
}

function errorClass(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

export async function routeAdminReportQuestion(
  input: ReportRouterActor & {
    model: string;
    question: string;
    locale: 'vi' | 'en';
    referenceDate?: Date;
    correlationId?: string | null;
  },
  deps: ReportRouterDeps = defaultReportRouterDeps,
): Promise<ReportRouteDecision> {
  const today = localYmd(input.referenceDate ?? new Date());
  const parse = parseReportTimeExpression(input.question, { today });
  const labels = await deps.loadLabels(input.tenantId);
  const deterministicIntent = detectReportIntent(input.question, { labels, hasTimeExpression: parse.status !== 'none' });

  let model: ReportRouterModelOutput | null = null;
  try {
    model = await withReportDeadline('report_router_model', deps.modelTimeoutMs ?? env.REPORT_CHAT_ROUTER_TIMEOUT_MS, (signal) => deps.callModel({
      tenantId: input.tenantId, model: input.model, question: input.question, locale: input.locale, today, signal,
    }));
  } catch (error) {
    // The deterministic parser and intent gate are a complete fallback; the
    // turn continues without model parameters instead of failing (or hanging).
    deps.log({
      event: 'report_router_model_unavailable',
      correlation_id: input.correlationId ?? null,
      tenant_id: input.tenantId,
      error_class: errorClass(error),
      deterministic_intent: deterministicIntent,
    });
  }

  const isReport = model?.tool === 'get_report_snapshot' || deterministicIntent;
  const needCatalog = isReport && ((model?.org_units.length ?? 0) > 0 || hasReportUnitWord(input.question, labels));
  const scope = isReport
    ? await loadReportActorScope(input, deps, needCatalog)
    : { restricted: false, allowedGroupIds: null, catalog: null };
  const units = scope.catalog && needCatalog
    ? resolveReportOrgUnits({
      question: input.question,
      modelUnits: model?.org_units ?? [],
      catalog: scope.catalog,
      labels,
      allowedGroupIds: scope.allowedGroupIds,
    })
    : { status: 'none' as const };
  const decision = decideReportRoute({ today, parse, model, deterministicIntent, units, scope });
  deps.log({
    event: 'report_router_decision',
    correlation_id: input.correlationId ?? null,
    tenant_id: input.tenantId,
    outcome: decision.kind,
    model_tool: model?.tool ?? null,
    deterministic_intent: deterministicIntent,
    time_status: parse.status,
    time_confidence: parse.confidence,
    unit_status: units.status,
    ...(decision.kind === 'snapshot' ? { period_source: decision.request.period_source } : {}),
    ...(decision.kind === 'clarification' ? { reasons: decision.clarification.reasons } : {}),
  });
  return decision;
}
