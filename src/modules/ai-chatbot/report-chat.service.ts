import { stableHash } from '../../config/cache.js';
import { query } from '../../config/database.js';
import { getGeminiClient } from './gemini.service.js';
import {
  enforceReportScope,
  type ReportScope,
  type ReportScopeActor,
} from '../reports/report-access.service.js';
import * as reportsService from '../reports/reports.service.js';

const REPORT_TIME_ZONE = 'Asia/Ho_Chi_Minh';
const MAX_REPORT_RANGE_DAYS = 366;
const SNAPSHOT_VERSION = 1 as const;

export interface ReportChatFilterInput {
  date_from?: string;
  date_to?: string;
  group_id?: string;
  subgroup_id?: string;
  team_id?: string;
}

export interface NormalizedReportChatFilter {
  date_from: string;
  date_to: string;
  group_id?: string;
  subgroup_id?: string;
  team_id?: string;
}

export interface ReportChatSnapshot {
  version: typeof SNAPSHOT_VERSION;
  generated_at: string;
  timezone: typeof REPORT_TIME_ZONE;
  filter: NormalizedReportChatFilter;
  scope: Pick<ReportScope, 'groupId' | 'subgroupId' | 'teamId'>;
  summary: reportsService.ReportSummary;
  enrollment_trend: Array<{ bucket: string; label: string; value: number }>;
  top_courses: reportsService.ReportTopCourse[];
  completion_ranking: reportsService.ReportCourseCompletionRanking[];
}

export interface ReportRouterResult {
  kind: 'direct' | 'filters' | 'snapshot';
  suggested_filter?: Pick<ReportChatFilterInput, 'date_from' | 'date_to'>;
}

export interface ReportYearCorrection {
  year: number;
  filter: NormalizedReportChatFilter;
  reportQuestion: string;
}

type ReportKpiKey = 'total_learners' | 'active_learners' | 'completion_rate' | 'total_enrollments';

export interface ReportKpiVocabularyItem {
  key: ReportKpiKey;
  title: string;
  definition: string;
}

const VIETNAMESE_REPORT_KPI_VOCABULARY: readonly ReportKpiVocabularyItem[] = [
  {
    key: 'total_learners',
    title: 'Tổng học viên đã đào tạo',
    definition: 'Tổng số tài khoản học viên được tạo trong khoảng thời gian đã chọn và thuộc phạm vi tổ chức đang lọc; mỗi học viên chỉ được tính một lần.',
  },
  {
    key: 'active_learners',
    title: 'Học viên có hoạt động học',
    definition: 'Số học viên đã hoàn thành ít nhất một nội dung học trong khoảng thời gian báo cáo; mỗi học viên chỉ được tính một lần.',
  },
  {
    key: 'completion_rate',
    title: 'Tỷ lệ hoàn thành trung bình',
    definition: 'Tính trên toàn bộ học viên thuộc phạm vi đang lọc. Mỗi học viên được tính bằng tiến độ trung bình các khóa học trong khoảng thời gian đã chọn, sau đó lấy trung bình của tất cả học viên.',
  },
  {
    key: 'total_enrollments',
    title: 'Lượt ghi danh trong kỳ',
    definition: 'Số lần học viên được ghi danh vào khóa học trong khoảng thời gian báo cáo; một học viên có thể có nhiều lượt ghi danh.',
  },
];

export function getVietnameseReportKpiVocabulary(): readonly ReportKpiVocabularyItem[] {
  return VIETNAMESE_REPORT_KPI_VOCABULARY;
}

function localYmd(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: REPORT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  return `${read('year')}-${read('month')}-${read('day')}`;
}

function parseYmd(value: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [, rawYear, rawMonth, rawDay] = match;
  const year = Number(rawYear);
  const month = Number(rawMonth);
  const day = Number(rawDay);
  if (year < 1900 || month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
  return { year, month, day };
}

function formatYmd(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function clampYmd(year: number, month: number, day: number): string | null {
  if (year < 1900 || month < 1 || month > 12 || day < 1) return null;
  return formatYmd(year, month, Math.min(day, new Date(Date.UTC(year, month, 0)).getUTCDate()));
}

function addDays(value: string, offset: number): string {
  const parts = parseYmd(value);
  if (!parts) return value;
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  date.setUTCDate(date.getUTCDate() + offset);
  return formatYmd(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

function startOfWeek(value: string): string {
  const parts = parseYmd(value);
  if (!parts) return value;
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const offset = (date.getUTCDay() + 6) % 7;
  return addDays(value, -offset);
}

function endOfMonth(year: number, month: number): string {
  return formatYmd(year, month, new Date(Date.UTC(year, month, 0)).getUTCDate());
}

function normalizeReportQuestion(question: string): string {
  return question
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('vi-VN')
    .trim();
}

function containsExplicitYear(question: string): boolean {
  return /\b(?:19|20)\d{2}\b/.test(question);
}

function readDateRangeFromShortDates(question: string, defaultYear: number): Pick<ReportChatFilterInput, 'date_from' | 'date_to'> | null {
  const values = [...question.matchAll(/\b(\d{1,2})\s*[/.\-]\s*(\d{1,2})(?:\s*[/.\-]\s*((?:19|20)\d{2}))?\b/g)]
    .map((match) => {
      const day = Number(match[1]);
      const month = Number(match[2]);
      const year = match[3] ? Number(match[3]) : defaultYear;
      return clampYmd(year, month, day);
    })
    .filter((value): value is string => Boolean(value));
  if (values.length === 0) return null;
  return {
    date_from: values[0],
    date_to: values[Math.min(values.length - 1, 1)],
  };
}

function rebaseDateToYear(value: string | undefined, year: number): string | undefined {
  const parts = value ? parseYmd(value) : null;
  return parts ? clampYmd(year, parts.month, parts.day) ?? undefined : undefined;
}

export function resolveReportDateFilter(input: {
  question: string;
  locale: 'vi' | 'en';
  suggestedFilter?: Pick<ReportChatFilterInput, 'date_from' | 'date_to'>;
  referenceDate?: Date;
}): Pick<ReportChatFilterInput, 'date_from' | 'date_to'> {
  const reference = localYmd(input.referenceDate ?? new Date());
  const referenceParts = parseYmd(reference);
  if (!referenceParts) return input.suggestedFilter ?? {};
  const question = normalizeReportQuestion(input.question);
  const hasExplicitYear = containsExplicitYear(question);

  if (!hasExplicitYear) {
    if (/\b(hom qua|yesterday)\b/.test(question)) {
      const date = addDays(reference, -1);
      return { date_from: date, date_to: date };
    }
    if (/\b(hom nay|today)\b/.test(question)) return { date_from: reference, date_to: reference };
    if (/\b(tuan truoc|last week)\b/.test(question)) {
      const end = addDays(startOfWeek(reference), -1);
      return { date_from: startOfWeek(end), date_to: end };
    }
    if (/\b(tuan nay|this week|current week)\b/.test(question)) {
      return { date_from: startOfWeek(reference), date_to: reference };
    }
    if (/\b(thang truoc|last month)\b/.test(question)) {
      const previousMonth = referenceParts.month === 1 ? 12 : referenceParts.month - 1;
      const previousYear = referenceParts.month === 1 ? referenceParts.year - 1 : referenceParts.year;
      return { date_from: formatYmd(previousYear, previousMonth, 1), date_to: endOfMonth(previousYear, previousMonth) };
    }
    if (/\b(thang nay|this month|current month)\b/.test(question)) {
      return { date_from: formatYmd(referenceParts.year, referenceParts.month, 1), date_to: reference };
    }
    if (/\b(nam nay|this year|current year)\b/.test(question)) {
      return { date_from: formatYmd(referenceParts.year, 1, 1), date_to: reference };
    }

    const shortDateRange = readDateRangeFromShortDates(question, referenceParts.year);
    if (shortDateRange) return shortDateRange;
  }

  const monthMatch = /\b(?:thang|month)\s*(\d{1,2})(?:\s*(?:\/|\-|nam|year)\s*((?:19|20)\d{2}))?\b/.exec(question);
  if (monthMatch) {
    const month = Number(monthMatch[1]);
    const year = monthMatch[2] ? Number(monthMatch[2]) : referenceParts.year;
    if (month >= 1 && month <= 12) {
      return { date_from: formatYmd(year, month, 1), date_to: endOfMonth(year, month) };
    }
  }

  if (hasExplicitYear) {
    const shortDateRange = readDateRangeFromShortDates(question, referenceParts.year);
    if (shortDateRange) return shortDateRange;
  }

  const suggested = input.suggestedFilter ?? {};
  if (!hasExplicitYear) {
    const dateFrom = rebaseDateToYear(suggested.date_from, referenceParts.year);
    const dateTo = rebaseDateToYear(suggested.date_to, referenceParts.year);
    return {
      ...(dateFrom ? { date_from: dateFrom } : {}),
      ...(dateTo ? { date_to: dateTo } : {}),
    };
  }
  return suggested;
}

function reportYearCorrectionMatch(question: string): RegExpExecArray | null {
  return /^(?:(?:la\s+)?(?:nam|year)\s*)?((?:19|20)\d{2})(?:\s+(?:ma|nhe|nha|ba|ban|roi|do|thoi|please|instead))*[.!?]*$/.exec(normalizeReportQuestion(question));
}

export function isPotentialReportYearCorrection(question: string): boolean {
  return Boolean(reportYearCorrectionMatch(question));
}

export function resolveReportYearCorrection(input: {
  question: string;
  previousFilter: NormalizedReportChatFilter;
  previousQuestion: string;
}): ReportYearCorrection | null {
  const match = reportYearCorrectionMatch(input.question);
  if (!match || !parseYmd(input.previousFilter.date_from) || !parseYmd(input.previousFilter.date_to)) return null;
  const year = Number(match[1]);
  const dateFrom = rebaseDateToYear(input.previousFilter.date_from, year);
  const dateTo = rebaseDateToYear(input.previousFilter.date_to, year);
  if (!dateFrom || !dateTo || dateFrom > dateTo) return null;
  return {
    year,
    filter: { ...input.previousFilter, date_from: dateFrom, date_to: dateTo },
    reportQuestion: input.previousQuestion,
  };
}

function dateRangeFromYmd(dateFrom: string, dateTo: string): reportsService.ReportDateRange {
  const pattern = /^\d{4}-\d{2}-\d{2}$/;
  if (!pattern.test(dateFrom) || !pattern.test(dateTo)) {
    throw { status: 400, message: 'date_from/date_to phải có định dạng YYYY-MM-DD' };
  }
  const startDate = new Date(`${dateFrom}T00:00:00.000+07:00`);
  const endDate = new Date(`${dateTo}T23:59:59.999+07:00`);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime()) || startDate.getTime() > endDate.getTime()) {
    throw { status: 400, message: 'Khoảng ngày không hợp lệ' };
  }
  const dayCount = Math.floor((endDate.getTime() - startDate.getTime()) / 86_400_000) + 1;
  if (dayCount > MAX_REPORT_RANGE_DAYS) {
    throw { status: 400, message: `Khoảng ngày báo cáo tối đa ${MAX_REPORT_RANGE_DAYS} ngày` };
  }
  return { startDate, endDate, dateFrom, dateTo };
}

export function normalizeReportChatFilter(input: ReportChatFilterInput = {}): {
  filter: NormalizedReportChatFilter;
  dateRange: reportsService.ReportDateRange;
} {
  if ((input.date_from && !input.date_to) || (!input.date_from && input.date_to)) {
    throw { status: 400, message: 'date_from và date_to phải được gửi cùng nhau' };
  }
  const today = localYmd(new Date());
  const defaultFrom = `${today.slice(0, 8)}01`;
  const dateFrom = input.date_from?.trim() || defaultFrom;
  const dateTo = input.date_to?.trim() || today;
  const dateRange = dateRangeFromYmd(dateFrom, dateTo);
  return {
    filter: {
      date_from: dateRange.dateFrom,
      date_to: dateRange.dateTo,
      ...(input.group_id?.trim() ? { group_id: input.group_id.trim() } : {}),
      ...(input.subgroup_id?.trim() ? { subgroup_id: input.subgroup_id.trim() } : {}),
      ...(input.team_id?.trim() ? { team_id: input.team_id.trim() } : {}),
    },
    dateRange,
  };
}

export async function buildReportChatSnapshot(input: {
  tenantId: string;
  actor: ReportScopeActor;
  filter?: ReportChatFilterInput;
}): Promise<ReportChatSnapshot> {
  const normalized = normalizeReportChatFilter(input.filter);
  const scope = await enforceReportScope(input.actor, {
    groupId: normalized.filter.group_id,
    subgroupId: normalized.filter.subgroup_id,
    teamId: normalized.filter.team_id,
  });
  const effectiveFilter: NormalizedReportChatFilter = {
    date_from: normalized.filter.date_from,
    date_to: normalized.filter.date_to,
    ...(scope.groupId ? { group_id: scope.groupId } : {}),
    ...(scope.subgroupId ? { subgroup_id: scope.subgroupId } : {}),
    ...(scope.teamId ? { team_id: scope.teamId } : {}),
  };

  if (scope.allowedGroupIds?.length === 0) {
    return {
      version: SNAPSHOT_VERSION,
      generated_at: new Date().toISOString(),
      timezone: REPORT_TIME_ZONE,
      filter: effectiveFilter,
      scope: { groupId: scope.groupId, subgroupId: scope.subgroupId, teamId: scope.teamId },
      summary: {
        meta: { month: normalized.dateRange.startDate.getMonth() + 1, year: normalized.dateRange.startDate.getFullYear(), month_label: '', is_current_month: false, date_from: normalized.dateRange.dateFrom, date_to: normalized.dateRange.dateTo },
        overview: { total_learners: 0, active_learners: 0, completion_rate: 0, total_enrollments: 0, completed_enrollments: 0, incomplete_enrollments: 0 },
      },
      enrollment_trend: [],
      top_courses: [],
      completion_ranking: [],
    };
  }

  const [summary, chart, topCourses, completionRanking] = await Promise.all([
    reportsService.getReportSummary(input.tenantId, undefined, undefined, scope.groupId, scope.subgroupId, scope.teamId, normalized.dateRange),
    reportsService.getReportChart(input.tenantId, normalized.dateRange.startDate.getFullYear(), 'total_enrollments', scope.groupId, scope.subgroupId, scope.teamId, false, false, normalized.dateRange, 'auto', { limitBuckets: 62 }),
    reportsService.getReportTopCourses(input.tenantId, 1, 5, undefined, undefined, scope.groupId, scope.subgroupId, scope.teamId, normalized.dateRange),
    reportsService.getReportCourseCompletionRanking(input.tenantId, 1, 5, undefined, undefined, scope.groupId, scope.subgroupId, scope.teamId, normalized.dateRange),
  ]);
  const chartData = Array.isArray((chart as { data?: unknown }).data) ? (chart as { data: reportsService.ReportChartPoint[] }).data : [];
  return {
    version: SNAPSHOT_VERSION,
    generated_at: new Date().toISOString(),
    timezone: REPORT_TIME_ZONE,
    filter: effectiveFilter,
    scope: { groupId: scope.groupId, subgroupId: scope.subgroupId, teamId: scope.teamId },
    summary,
    enrollment_trend: chartData.slice(0, 62).map((point) => ({
      bucket: String(point.bucket ?? point.month ?? ''),
      label: String(point.bucket_label ?? point.month_label ?? point.bucket ?? point.month ?? ''),
      value: Number(point.value ?? 0) || 0,
    })),
    top_courses: topCourses.results.slice(0, 5),
    completion_ranking: completionRanking.results.slice(0, 5),
  };
}

export function getReportSnapshotHash(snapshot: ReportChatSnapshot): string {
  return stableHash(snapshot);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isReportChatSnapshot(value: unknown): value is ReportChatSnapshot {
  if (!isRecord(value) || value.version !== SNAPSHOT_VERSION || !isRecord(value.filter) || !isRecord(value.scope)) return false;
  if (!isRecord(value.summary) || !isRecord(value.summary.overview)) return false;
  return typeof value.filter.date_from === 'string'
    && typeof value.filter.date_to === 'string'
    && Array.isArray(value.enrollment_trend)
    && Array.isArray(value.top_courses)
    && Array.isArray(value.completion_ranking);
}

export async function loadStoredReportSnapshot(input: {
  assistantMessageId: string;
  conversationId: string;
  userId: string;
  tenantId: string;
}): Promise<{ snapshot: ReportChatSnapshot; question: string; locale: 'vi' | 'en' }> {
  const result = await query<{ metadata: unknown }>(
    `SELECT message.metadata
     FROM chat_messages message
     JOIN chat_conversations conversation ON conversation.id = message.conversation_id
     WHERE message.id = $1
       AND message.conversation_id = $2
       AND message.role = 'assistant'
       AND conversation.user_id = $3
       AND conversation.tenant_id = $4
       AND conversation.target = 'admin'
     LIMIT 1`,
    [input.assistantMessageId, input.conversationId, input.userId, input.tenantId],
  );
  const metadata = result.rows[0]?.metadata;
  if (!isRecord(metadata) || metadata.kind !== 'report_analysis' || !isReportChatSnapshot(metadata.report_snapshot)) {
    throw { status: 404, message: 'Không tìm thấy bản chụp báo cáo hợp lệ' };
  }
  const snapshot = metadata.report_snapshot;
  const storedHash = typeof metadata.report_snapshot_hash === 'string' ? metadata.report_snapshot_hash : '';
  if (!storedHash || storedHash !== getReportSnapshotHash(snapshot)) {
    throw { status: 409, message: 'Bản chụp báo cáo không còn toàn vẹn' };
  }
  return {
    snapshot,
    question: typeof metadata.report_question === 'string' ? metadata.report_question : '',
    locale: metadata.locale === 'en' ? 'en' : 'vi',
  };
}

const REPORT_ROUTER_TOOL = {
  functionDeclarations: [
    {
      name: 'get_report_snapshot',
      description: 'Use only when the user asks for factual learning/report metrics, trends, completion, enrollment, learner progress, or course rankings from the dashboard database.',
      parameters: {
        type: 'OBJECT',
        properties: {
          date_from: { type: 'STRING', description: 'Optional YYYY-MM-DD start date resolved from the request.' },
          date_to: { type: 'STRING', description: 'Optional YYYY-MM-DD end date resolved from the request.' },
          requires_filters: { type: 'BOOLEAN', description: 'True only when a group/team scope is explicitly requested but cannot be selected safely without the user choosing it in the UI.' },
        },
      },
    },
    {
      name: 'respond_directly',
      description: 'Use for every request that does not require factual dashboard report data.',
      parameters: { type: 'OBJECT', properties: {} },
    },
  ],
};

export function hasDeterministicReportIntent(question: string): boolean {
  const normalized = question
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('vi-VN');

  const reportCue = /\b(bao cao|thong ke|phan tich|so lieu|dashboard|report|analytics?|metrics?)\b/.test(normalized);
  const learningMetricCue = /\b(hoc vien|nguoi hoc|khoa hoc|dao tao|tien do|hoan thanh|ghi danh|dang ky|enrollment|completion|learner|course|training)\b/.test(normalized);
  const rankingCue = /\b(bang xep hang|xep hang|ranking|top)\b/.test(normalized);
  const explicitMetricCue = /\b(ty le hoan thanh|luot dang ky|tinh hinh hoc tap|completion rate|enrollments?)\b/.test(normalized);

  return (reportCue && learningMetricCue)
    || (rankingCue && learningMetricCue)
    || explicitMetricCue;
}

export async function routeAdminReportQuestion(input: {
  tenantId: string;
  model: string;
  question: string;
  locale: 'vi' | 'en';
  referenceDate?: Date;
}): Promise<ReportRouterResult> {
  const referenceDate = localYmd(input.referenceDate ?? new Date());
  const aiClient = await getGeminiClient(input.tenantId);
  const response = await aiClient.models.generateContent({
    model: input.model,
    contents: [{ role: 'user', parts: [{ text: input.question }] }],
    config: {
      systemInstruction: input.locale === 'en'
        ? `You are a strict intent router. Today is ${referenceDate} in Asia/Ho_Chi_Minh. Do not answer the user. Choose get_report_snapshot only for factual dashboard data requests. Choose respond_directly for writing, explanations, or any request that does not require dashboard data. Resolve dates without a year to the current year, and relative dates from today. Never invent IDs, SQL, metrics, filters, or data.`
        : `Bạn là bộ định tuyến ý định nghiêm ngặt. Hôm nay là ${referenceDate} theo múi giờ Asia/Ho_Chi_Minh. Không trả lời người dùng. Chỉ chọn get_report_snapshot khi người dùng cần số liệu thực tế từ dashboard. Chọn respond_directly cho viết nội dung, giải thích hoặc mọi yêu cầu không cần dữ liệu dashboard. Mốc ngày không nêu năm phải dùng năm hiện tại; mốc tương đối phải tính từ hôm nay. Không tự tạo ID, SQL, metric, bộ lọc hoặc số liệu.`,
      tools: [REPORT_ROUTER_TOOL] as any,
      toolConfig: { functionCallingConfig: { mode: 'ANY' as any } },
      maxOutputTokens: 256,
    } as any,
  });
  const part = response.candidates?.[0]?.content?.parts?.find((item: any) => item.functionCall) as any;
  const call = part?.functionCall ?? response.functionCalls?.[0];
  const args = call?.args && typeof call.args === 'object' ? call.args as Record<string, unknown> : {};
  const suggestedFilter = resolveReportDateFilter({
    question: input.question,
    locale: input.locale,
    suggestedFilter: {
      ...(typeof args.date_from === 'string' ? { date_from: args.date_from } : {}),
      ...(typeof args.date_to === 'string' ? { date_to: args.date_to } : {}),
    },
    referenceDate: input.referenceDate,
  });
  if (call?.name !== 'get_report_snapshot') {
    // The model router is preferred for intent and explicit date extraction.
    // This fallback prevents obvious report requests from being answered by KB RAG when it declines the tool call.
    return hasDeterministicReportIntent(input.question) ? { kind: 'filters', suggested_filter: suggestedFilter } : { kind: 'direct' };
  }
  return args.requires_filters === true
    ? { kind: 'filters', suggested_filter: suggestedFilter }
    : { kind: 'snapshot', suggested_filter: suggestedFilter };
}

function formatReaderDate(value: string, locale: 'vi' | 'en'): string {
  const [year, month, day] = value.split('-').map(Number);
  if (!year || !month || !day) return value;
  const date = new Date(Date.UTC(year, month - 1, day));
  return new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'vi-VN', {
    day: '2-digit',
    month: locale === 'en' ? 'short' : '2-digit',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

function snapshotPrompt(snapshot: ReportChatSnapshot, locale: 'vi' | 'en'): string {
  const overview = snapshot.summary.overview;
  return JSON.stringify({
    reporting_period: locale === 'en'
      ? `${formatReaderDate(snapshot.filter.date_from, locale)} to ${formatReaderDate(snapshot.filter.date_to, locale)}`
      : `${formatReaderDate(snapshot.filter.date_from, locale)} đến ${formatReaderDate(snapshot.filter.date_to, locale)}`,
    kpis: locale === 'vi'
      ? getVietnameseReportKpiVocabulary().map((metric) => ({
        title: metric.title,
        value: overview[metric.key],
        definition: metric.definition,
      }))
      : overview,
    trend: snapshot.enrollment_trend,
    top_courses: snapshot.top_courses,
    completion_ranking: snapshot.completion_ranking,
  });
}

export async function streamGroundedReportAnalysis(input: {
  tenantId: string;
  model: string;
  question: string;
  locale: 'vi' | 'en';
  snapshot: ReportChatSnapshot;
  onChunk: (text: string) => void;
}): Promise<string> {
  const aiClient = await getGeminiClient(input.tenantId);
  const systemInstruction = input.locale === 'en'
    ? 'Answer as a concise, professional reporting analyst. Use only facts and values in REPORT_SNAPSHOT. Do not claim a causal reason unless the data proves it. State when the data does not provide enough evidence. Use reader-friendly dates such as 19 Sep 2026, never ISO dates. Do not mention REPORT_SNAPSHOT, snapshots, scopes, databases, backends, tools, prompts, or other implementation details. Use short Markdown headings and bullets; do not use tables or HTML.'
    : 'Trả lời như chuyên viên phân tích báo cáo, ngắn gọn và chuyên nghiệp. Chỉ dùng số liệu và sự kiện trong REPORT_SNAPSHOT. Không khẳng định nguyên nhân nếu dữ liệu không chứng minh. Nêu rõ khi dữ liệu chưa đủ bằng chứng. Dùng ngày dễ đọc theo dạng 19/09/2026, không dùng dạng YYYY-MM-DD. Khi nêu bất kỳ KPI nào, phải dùng nguyên văn tiêu đề KPI được cung cấp trong REPORT_SNAPSHOT; tuyệt đối không thay bằng các biến thể như "Tổng học viên đã tạo", "Người học", "Người học hoạt động", "Tỷ lệ hoàn thành" hoặc "Lượt ghi danh". Không nhắc REPORT_SNAPSHOT, snapshot, phạm vi kỹ thuật, cơ sở dữ liệu, backend, công cụ, prompt hoặc chi tiết triển khai. Dùng heading Markdown ngắn và bullet; không dùng bảng hoặc HTML.';
  const response = await aiClient.models.generateContentStream({
    model: input.model,
    contents: [{ role: 'user', parts: [{ text: `USER_QUESTION:\n${input.question}\n\nREPORT_SNAPSHOT:\n${snapshotPrompt(input.snapshot, input.locale)}` }] }],
    config: { systemInstruction, maxOutputTokens: 3_500 },
  });
  let fullText = '';
  for await (const chunk of response) {
    const text = chunk.text ?? '';
    if (!text) continue;
    fullText += text;
    input.onChunk(text);
  }
  return fullText.trim();
}

export function formatReportFilterRequest(locale: 'vi' | 'en'): string {
  return locale === 'en'
    ? 'Choose the reporting period and organization scope, then apply the filter to generate a grounded analysis.'
    : 'Chọn thời gian và phạm vi tổ chức, sau đó áp dụng bộ lọc để tạo phân tích dựa trên số liệu thực tế.';
}
