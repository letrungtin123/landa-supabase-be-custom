import { stableHash } from '../../config/cache.js';
import { query } from '../../config/database.js';
import {
  enforceReportScope,
  hasNoAccessibleReportScope,
  type ReportScope,
  type ReportScopeActor,
  type ReportScopeOptions,
} from '../reports/report-access.service.js';
import * as reportsService from '../reports/reports.service.js';
import {
  MAX_REPORT_RANGE_DAYS,
  REPORT_TIME_ZONE,
  clampYmd,
  localYmd,
  parseYmd,
  resolveComparableReportPeriod,
  resolveNearestReportDataPeriod,
  type ReportComparisonPeriod,
  type ReportNearestDataPeriod,
} from './report-date.logic.js';
import { foldReportText, normalizeReportEntityName } from './report-text.logic.js';
import { resolveSnapshotChartGranularity, type ReportGranularity } from './report-time-expression.logic.js';
import { findNearestReportEnrollmentDates, loadReportUnitBreakdownRows } from './report-chat.repository.js';
import {
  buildReportUnitBreakdownSection,
  type ReportUnitBreakdown,
  type ReportUnitBreakdownStatus,
} from './report-unit-breakdown.logic.js';

export { resolveComparableReportPeriod, type ReportComparisonPeriod } from './report-date.logic.js';
export {
  generateReportNarrative,
  hasNumericReportNarrativeClaim,
  isReportNarrativeAllowed,
  type ReportNarrative,
} from './report-chat-narrative.service.js';

export const REPORT_RANGE_INVALID_CODE = 'REPORT_RANGE_INVALID';
const LEGACY_SNAPSHOT_VERSION = 1 as const;
const SNAPSHOT_VERSION = 2 as const;
export const REPORT_SIGNAL_THRESHOLD_VERSION = 'v1' as const;
export const REPORT_SIGNAL_THRESHOLDS = {
  completion_decline: {
    minimum_current_enrollments: 10,
    minimum_previous_enrollments: 10,
    decline_percentage_points: -3,
  },
  high_enrollment_low_completion: {
    minimum_enrollments: 5,
    maximum_completion_rate: 50,
  },
  end_period_activity_drop: {
    minimum_buckets: 8,
    minimum_preceding_activity: 3,
    maximum_recent_to_preceding_ratio: 0.5,
  },
} as const;

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

export interface LegacyReportChatSnapshot {
  version: typeof LEGACY_SNAPSHOT_VERSION;
  generated_at: string;
  timezone: typeof REPORT_TIME_ZONE;
  filter: NormalizedReportChatFilter;
  scope: Pick<ReportScope, 'groupId' | 'subgroupId' | 'teamId'>;
  summary: reportsService.ReportSummary;
  enrollment_trend: Array<{ bucket: string; label: string; value: number }>;
  top_courses: reportsService.ReportTopCourse[];
  completion_ranking: reportsService.ReportCourseCompletionRanking[];
}

export type ReportMetricId = 'total_learners' | 'active_learners' | 'completion_rate' | 'total_enrollments' | 'incomplete_enrollments';
export type ReportMetricUnit = 'count' | 'percentage';
export type ReportSignalSeverity = 'attention' | 'warning' | 'neutral';

export interface ReportMetricFact {
  id: ReportMetricId;
  unit: ReportMetricUnit;
  current: number;
  previous: number | null;
  delta_absolute: number | null;
  delta_percent: number | null;
  delta_percentage_points: number | null;
}

export interface ReportSignalEvidence {
  metric_id?: ReportMetricId;
  course_id?: string;
  course_name?: string;
  current?: number;
  previous?: number;
  delta_absolute?: number;
  delta_percentage_points?: number;
  affected_course_count?: number;
  enrollment_count?: number;
  completion_rate?: number;
  current_sample_size?: number;
  previous_sample_size?: number;
}

export interface ReportAnalyticsSignal {
  id: string;
  category: 'enrollment' | 'completion' | 'activity' | 'course';
  severity: ReportSignalSeverity;
  threshold_version: typeof REPORT_SIGNAL_THRESHOLD_VERSION;
  evidence: ReportSignalEvidence;
}

export interface ReportScopeDisplay {
  group_name?: string;
  subgroup_name?: string;
  team_name?: string;
}

export interface ReportTrendContext {
  granularity?: 'day' | 'week' | 'month';
}

export type ReportCourseDetail = Pick<
  reportsService.ReportCoursePerformance,
  'course_id'
  | 'name'
  | 'total_enrollments'
  | 'completed_enrollments'
  | 'incomplete_enrollments'
  | 'not_started_enrollments'
  | 'in_progress_enrollments'
  | 'completion_rate'
>;

export interface ReportComparisonDisplay {
  title: string;
  date_label: string;
  delta_suffix: string;
}

export type ReportComparisonDisplays = Record<'vi' | 'en', ReportComparisonDisplay>;

/** A comparison-period series, aligned with the current series by bucket index. */
export type ReportPreviousTrend = Array<{ bucket: string; value: number }>;

/**
 * Optional, additive parts of a V2 snapshot. `version` stays 2: the dashboard
 * card only renders `version === 2` snapshots and these fields are ignored by
 * every older reader. `unit_breakdown_status` is set on every snapshot built
 * since they exist; its absence marks an older snapshot.
 */
export interface ReportSnapshotExtensions {
  previous_enrollment_trend?: ReportPreviousTrend;
  previous_active_learner_trend?: ReportPreviousTrend;
  unit_breakdown?: ReportUnitBreakdown;
  unit_breakdown_status?: ReportUnitBreakdownStatus;
}

export interface ReportChatSnapshot extends Omit<LegacyReportChatSnapshot, 'version'>, ReportSnapshotExtensions {
  version: typeof SNAPSHOT_VERSION;
  comparison: ReportComparisonPeriod;
  comparison_display: ReportComparisonDisplays;
  scope_display: ReportScopeDisplay;
  enrollment_trend_context?: ReportTrendContext;
  previous_summary: reportsService.ReportSummary;
  active_learner_trend: Array<{ bucket: string; label: string; value: number }>;
  course_portfolio: reportsService.ReportCoursePerformance[];
  course_detail?: ReportCourseDetail;
  completion_status_distribution: reportsService.ReportCompletionStatusDistribution;
  factual_metrics: ReportMetricFact[];
  signals: ReportAnalyticsSignal[];
  signal_threshold_version: typeof REPORT_SIGNAL_THRESHOLD_VERSION;
  availability: {
    state: 'available' | 'empty' | 'no_accessible_scope';
    limitations: string[];
    /** Only for an empty period: the closest calendar month that has enrollments in the same scope. */
    nearest_data_period?: ReportNearestDataPeriod;
  };
}

export type StoredReportChatSnapshot = LegacyReportChatSnapshot | ReportChatSnapshot;


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
    title: 'Tổng học viên đã tạo',
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

function formatComparisonDate(value: string, locale: 'vi' | 'en'): string {
  const parts = parseYmd(value);
  if (!parts) return value;
  return new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'vi-VN', {
    day: '2-digit',
    month: locale === 'en' ? 'short' : '2-digit',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(parts.year, parts.month - 1, parts.day)));
}

export function getReportComparisonDisplay(
  comparison: ReportComparisonPeriod,
  locale: 'vi' | 'en',
): ReportComparisonDisplay {
  const copy = locale === 'en'
    ? {
      calendar_month: ['Compared with previous month', 'vs previous month'],
      month_to_date: ['Compared with same elapsed period last month', 'vs same elapsed period last month'],
      calendar_week: ['Compared with previous week', 'vs previous week'],
      year_to_date: ['Compared with same period last year', 'vs same period last year'],
      calendar_year: ['Compared with previous year', 'vs previous year'],
      equal_length: ['Compared with immediately preceding period', 'vs immediately preceding period'],
    }
    : {
      calendar_month: ['So sánh với tháng trước', 'so với tháng trước'],
      month_to_date: ['So sánh với cùng giai đoạn tháng trước', 'so với cùng giai đoạn tháng trước'],
      calendar_week: ['So sánh với tuần trước', 'so với tuần trước'],
      year_to_date: ['So sánh cùng kỳ năm trước', 'so với cùng kỳ năm trước'],
      calendar_year: ['So sánh với năm trước', 'so với năm trước'],
      equal_length: ['So sánh với giai đoạn liền trước', 'so với giai đoạn liền trước'],
    };
  const [title, deltaSuffix] = copy[comparison.basis];
  return {
    title,
    date_label: `${formatComparisonDate(comparison.date_from, locale)} - ${formatComparisonDate(comparison.date_to, locale)}`,
    delta_suffix: deltaSuffix,
  };
}

export function getReportComparisonDisplays(comparison: ReportComparisonPeriod): ReportComparisonDisplays {
  return {
    vi: getReportComparisonDisplay(comparison, 'vi'),
    en: getReportComparisonDisplay(comparison, 'en'),
  };
}

function normalizeReportQuestion(question: string): string {
  return foldReportText(question);
}

const COURSE_REFERENCE_PATTERN = /\b(?:kh(?:óa|oá|oa)(?:\s+học)?|course)\s+(?:(?:là|la|về|ve|about)\s+)?(.+?)(?=\s+(?:có|co|bao\s+nhiêu|bao\s+nhieu|số\s+lượng|so\s+luong|số|so|người\s+học|nguoi\s+hoc|học\s+viên|hoc\s+vien|lượt\s+ghi\s+danh|luot\s+ghi\s+danh|enrollments?|learners?|trong|từ|tu|tháng|thang|năm|nam|from|during|in)(?=\s|[?.!,;]|$)|[?.!,;]|$)/iu;
const ENGLISH_TRAILING_COURSE_REFERENCE_PATTERNS = [
  /\b(?:taking|attending|enrolled\s+(?:in|on)|for|about|on)\s+(?:the\s+)?(.+?)\s+course\b/iu,
  /(?:^|[?.!,;]\s*)(?:the\s+)?(.+?)\s+course\b(?=\s+(?:has|have|with|in|from|during|for|enrollments?|learners?|students?)\b|[?.!,;]|$)/iu,
] as const;

function normalizeCourseReference(value: string): string {
  return normalizeReportEntityName(value);
}

export function extractReportCourseReference(question: string): string | null {
  const quoted = /["“]([^"”]{2,160})["”]/u.exec(question)?.[1]?.trim();
  if (quoted) return quoted;
  const normalizedQuestion = question.replace(/\s+/g, ' ');
  for (const pattern of ENGLISH_TRAILING_COURSE_REFERENCE_PATTERNS) {
    const trailingCourseReference = pattern.exec(normalizedQuestion)?.[1]?.trim();
    if (trailingCourseReference) return trailingCourseReference;
  }
  const leadingCourseReference = COURSE_REFERENCE_PATTERN.exec(normalizedQuestion)?.[1]?.trim();
  if (leadingCourseReference) return leadingCourseReference;
  return null;
}

export function isCourseLearnerDetailRequest(question: string): boolean {
  const normalized = normalizeReportQuestion(question);
  return /\b(bao nhieu|how many|so luong|nguoi hoc|hoc vien|learners?|students?|danh sach|list|who)\b/.test(normalized);
}

export function resolveReportCourseDetail(
  question: string,
  candidates: reportsService.ReportCoursePerformance[],
  requestedCourse: string | null = extractReportCourseReference(question),
): ReportCourseDetail | null {
  if (!requestedCourse || !isCourseLearnerDetailRequest(question)) return null;
  const normalizedRequest = normalizeCourseReference(requestedCourse);
  if (!normalizedRequest) return null;
  const exactMatches = candidates.filter((candidate) => normalizeCourseReference(candidate.name) === normalizedRequest);
  if (exactMatches.length !== 1) return null;
  const course = exactMatches[0];
  return {
    course_id: course.course_id,
    name: course.name,
    total_enrollments: course.total_enrollments,
    completed_enrollments: course.completed_enrollments,
    incomplete_enrollments: course.incomplete_enrollments,
    not_started_enrollments: course.not_started_enrollments,
    in_progress_enrollments: course.in_progress_enrollments,
    completion_rate: course.completion_rate,
  };
}

function rebaseDateToYear(value: string | undefined, year: number): string | undefined {
  const parts = value ? parseYmd(value) : null;
  return parts ? clampYmd(year, parts.month, parts.day) ?? undefined : undefined;
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

function rangeError(message: string): { status: number; message: string; code: string } {
  return { status: 400, message, code: REPORT_RANGE_INVALID_CODE };
}

function dateRangeFromYmd(dateFrom: string, dateTo: string): reportsService.ReportDateRange {
  if (!parseYmd(dateFrom) || !parseYmd(dateTo)) {
    throw rangeError('date_from/date_to phải có định dạng YYYY-MM-DD');
  }
  const startDate = new Date(`${dateFrom}T00:00:00.000+07:00`);
  const endDate = new Date(`${dateTo}T23:59:59.999+07:00`);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime()) || startDate.getTime() > endDate.getTime()) {
    throw rangeError('Khoảng ngày không hợp lệ');
  }
  const dayCount = Math.floor((endDate.getTime() - startDate.getTime()) / 86_400_000) + 1;
  if (dayCount > MAX_REPORT_RANGE_DAYS) {
    throw rangeError(`Khoảng ngày báo cáo tối đa ${MAX_REPORT_RANGE_DAYS} ngày`);
  }
  return { startDate, endDate, dateFrom, dateTo };
}

export function normalizeReportChatFilter(input: ReportChatFilterInput = {}): {
  filter: NormalizedReportChatFilter;
  dateRange: reportsService.ReportDateRange;
} {
  if ((input.date_from && !input.date_to) || (!input.date_from && input.date_to)) {
    throw rangeError('date_from và date_to phải được gửi cùng nhau');
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
  question?: string;
  /** Breakdown the user asked for ("theo tuần"); coarsened to keep at most 62 chart buckets. */
  granularity?: ReportGranularity | null;
  /** Course name as written, from the router, used when the question has no recognisable course phrase. */
  courseHint?: string | null;
  scopeOptions?: ReportScopeOptions;
}): Promise<ReportChatSnapshot> {
  const normalized = normalizeReportChatFilter(input.filter);
  const scope = await enforceReportScope(input.actor, {
    groupId: normalized.filter.group_id,
    subgroupId: normalized.filter.subgroup_id,
    teamId: normalized.filter.team_id,
  }, input.scopeOptions);
  const effectiveFilter: NormalizedReportChatFilter = {
    date_from: normalized.filter.date_from,
    date_to: normalized.filter.date_to,
    ...(scope.groupId ? { group_id: scope.groupId } : {}),
    ...(scope.subgroupId ? { subgroup_id: scope.subgroupId } : {}),
    ...(scope.teamId ? { team_id: scope.teamId } : {}),
  };

  const comparison = resolveComparableReportPeriod(normalized.dateRange.dateFrom, normalized.dateRange.dateTo);
  const previousRange = dateRangeFromYmd(comparison.date_from, comparison.date_to);
  const base = {
    version: SNAPSHOT_VERSION,
    generated_at: new Date().toISOString(),
    timezone: REPORT_TIME_ZONE,
    filter: effectiveFilter,
    scope: { groupId: scope.groupId, subgroupId: scope.subgroupId, teamId: scope.teamId },
    comparison,
  } as const;

  if (hasNoAccessibleReportScope(scope)) {
    const summary = emptyReportSummary(normalized.dateRange);
    const previousSummary = emptyReportSummary(previousRange);
    return createReportSnapshot(base, summary, previousSummary, [], [], [], { not_started: 0, in_progress: 0, completed: 0 }, {}, 'no_accessible_scope', {}, undefined, { unit_breakdown_status: 'not_computed' });
  }

  const requestedCourse = (input.question ? extractReportCourseReference(input.question) : null) ?? input.courseHint?.trim() ?? null;
  const shouldResolveCourseDetail = Boolean(requestedCourse && isCourseLearnerDetailRequest(input.question ?? ''));
  const chartGranularity = resolveSnapshotChartGranularity(input.granularity, { date_from: normalized.dateRange.dateFrom, date_to: normalized.dateRange.dateTo });
  // The comparison series uses the current chart's effective granularity so
  // both series have the same bucket size and align by index in the PDF.
  const previousChartGranularity = reportsService.resolveReportChartGranularity(normalized.dateRange, chartGranularity);
  const chart = (metric: 'total_enrollments' | 'active_learners', range: reportsService.ReportDateRange, granularity: reportsService.ReportChartGranularity) => reportsService.getReportChart(
    input.tenantId, range.startDate.getFullYear(), metric, scope.groupId, scope.subgroupId, scope.teamId, false, false, range, granularity, { limitBuckets: 62 },
  );
  const [summary, previousSummary, enrollmentChart, activeLearnerChart, previousEnrollmentChart, previousActiveLearnerChart, coursePortfolio, completionStatus, scopeDisplay, courseCandidates, unitBreakdown] = await Promise.all([
    reportsService.getReportSummary(input.tenantId, undefined, undefined, scope.groupId, scope.subgroupId, scope.teamId, normalized.dateRange),
    reportsService.getReportSummary(input.tenantId, undefined, undefined, scope.groupId, scope.subgroupId, scope.teamId, previousRange),
    chart('total_enrollments', normalized.dateRange, chartGranularity),
    chart('active_learners', normalized.dateRange, chartGranularity),
    chart('total_enrollments', previousRange, previousChartGranularity),
    chart('active_learners', previousRange, previousChartGranularity),
    reportsService.getReportCoursePerformance(input.tenantId, 20, undefined, undefined, scope.groupId, scope.subgroupId, scope.teamId, normalized.dateRange),
    reportsService.getReportCompletionStatusDistribution(input.tenantId, undefined, undefined, scope.groupId, scope.subgroupId, scope.teamId, normalized.dateRange),
    resolveReportScopeDisplay(input.tenantId, scope),
    shouldResolveCourseDetail
      ? reportsService.findReportCoursePerformanceByName(input.tenantId, requestedCourse!, scope.groupId, scope.subgroupId, scope.teamId, normalized.dateRange)
      : Promise.resolve([]),
    buildReportUnitBreakdownSection({
      tenantId: input.tenantId,
      scope,
      range: normalized.dateRange,
      previousRange,
      load: loadReportUnitBreakdownRows,
    }),
  ]);
  const courseDetail = shouldResolveCourseDetail
    ? resolveReportCourseDetail(input.question ?? '', courseCandidates, requestedCourse)
    : null;
  const availability = hasReportData(summary) ? 'available' : 'empty';
  const snapshot = createReportSnapshot(
    base,
    summary,
    previousSummary,
    chartToSnapshotPoints(enrollmentChart),
    chartToSnapshotPoints(activeLearnerChart),
    coursePortfolio,
    completionStatus,
    scopeDisplay,
    availability,
    enrollmentChart.granularity ? { granularity: enrollmentChart.granularity } : {},
    courseDetail ?? undefined,
    // An empty period has nothing to compare or break down.
    availability === 'available'
      ? buildReportSnapshotExtensions({
        previousEnrollmentTrend: chartToPreviousTrend(previousEnrollmentChart, enrollmentChart.granularity),
        previousActiveLearnerTrend: chartToPreviousTrend(previousActiveLearnerChart, activeLearnerChart.granularity),
        unitBreakdown,
      })
      : { unit_breakdown_status: unitBreakdown.unit_breakdown_status === 'leaf_scope' ? 'leaf_scope' : 'not_computed' },
  );
  if (snapshot.availability.state !== 'empty') return snapshot;
  // Two LIMIT 1 index lookups, only for an empty period: lets the card offer
  // the nearest month that has data instead of a dead end.
  const nearest = await findNearestReportEnrollmentDates({
    tenantId: input.tenantId,
    scope,
    range: normalized.dateRange,
  });
  const nearestPeriod = resolveNearestReportDataPeriod({
    ...nearest,
    range: { date_from: normalized.dateRange.dateFrom, date_to: normalized.dateRange.dateTo },
    today: localYmd(new Date()),
  });
  return nearestPeriod
    ? { ...snapshot, availability: { ...snapshot.availability, nearest_data_period: nearestPeriod } }
    : snapshot;
}

function emptyReportSummary(range: reportsService.ReportDateRange): reportsService.ReportSummary {
  return {
    meta: {
      month: range.startDate.getMonth() + 1,
      year: range.startDate.getFullYear(),
      month_label: '',
      is_current_month: false,
      date_from: range.dateFrom,
      date_to: range.dateTo,
    },
    overview: {
      total_learners: 0,
      active_learners: 0,
      completion_rate: 0,
      total_enrollments: 0,
      completed_enrollments: 0,
      incomplete_enrollments: 0,
    },
  };
}

function chartToSnapshotPoints(chart: { data?: reportsService.ReportChartPoint[] }): Array<{ bucket: string; label: string; value: number }> {
  return (Array.isArray(chart.data) ? chart.data : []).slice(0, 62).map((point) => ({
    bucket: String(point.bucket ?? point.month ?? ''),
    label: String(point.bucket_label ?? point.month_label ?? point.bucket ?? point.month ?? ''),
    value: Number(point.value ?? 0) || 0,
  }));
}

/** Comparison-period series, only when its bucket size matches the current chart's. */
function chartToPreviousTrend(
  chart: { data?: reportsService.ReportChartPoint[]; granularity?: string },
  currentGranularity: string | undefined,
): ReportPreviousTrend | undefined {
  if (!currentGranularity || chart.granularity !== currentGranularity) return undefined;
  const points = chartToSnapshotPoints(chart)
    .filter((point) => /^\d{4}-\d{2}-\d{2}$/.test(point.bucket))
    .map(({ bucket, value }) => ({ bucket, value: Math.max(0, value) }));
  return points.length ? points : undefined;
}

export function buildReportSnapshotExtensions(input: {
  previousEnrollmentTrend?: ReportPreviousTrend;
  previousActiveLearnerTrend?: ReportPreviousTrend;
  unitBreakdown: { unit_breakdown?: ReportUnitBreakdown; unit_breakdown_status: ReportUnitBreakdownStatus };
}): ReportSnapshotExtensions {
  return {
    ...(input.previousEnrollmentTrend?.length ? { previous_enrollment_trend: input.previousEnrollmentTrend } : {}),
    ...(input.previousActiveLearnerTrend?.length ? { previous_active_learner_trend: input.previousActiveLearnerTrend } : {}),
    ...(input.unitBreakdown.unit_breakdown ? { unit_breakdown: input.unitBreakdown.unit_breakdown } : {}),
    unit_breakdown_status: input.unitBreakdown.unit_breakdown_status,
  };
}

function roundReportValue(value: number): number {
  return Math.round(value * 100) / 100;
}

function metricFact(id: ReportMetricId, unit: ReportMetricUnit, current: number, previous: number): ReportMetricFact {
  const delta = roundReportValue(current - previous);
  return {
    id,
    unit,
    current,
    previous,
    delta_absolute: delta,
    delta_percent: unit === 'count' && previous > 0 ? roundReportValue((delta / previous) * 100) : null,
    delta_percentage_points: unit === 'percentage' ? delta : null,
  };
}

export function buildReportMetricFacts(summary: reportsService.ReportSummary, previousSummary: reportsService.ReportSummary): ReportMetricFact[] {
  const current = summary.overview;
  const previous = previousSummary.overview;
  return [
    metricFact('total_learners', 'count', current.total_learners, previous.total_learners),
    metricFact('active_learners', 'count', current.active_learners, previous.active_learners),
    metricFact('completion_rate', 'percentage', current.completion_rate, previous.completion_rate),
    metricFact('total_enrollments', 'count', current.total_enrollments, previous.total_enrollments),
    metricFact('incomplete_enrollments', 'count', current.incomplete_enrollments, previous.incomplete_enrollments),
  ];
}

export function buildReportSignals(input: {
  metrics: ReportMetricFact[];
  activeTrend: Array<{ value: number }>;
  coursePortfolio: reportsService.ReportCoursePerformance[];
}): ReportAnalyticsSignal[] {
  const metric = (id: ReportMetricId) => input.metrics.find((item) => item.id === id)!;
  const signals: ReportAnalyticsSignal[] = [];
  const enrollments = metric('total_enrollments');
  const completion = metric('completion_rate');
  if (enrollments.delta_absolute !== null && enrollments.delta_absolute !== 0) {
    signals.push({
      id: 'enrollment_period_change',
      category: 'enrollment',
      severity: 'neutral',
      threshold_version: REPORT_SIGNAL_THRESHOLD_VERSION,
      evidence: {
        metric_id: 'total_enrollments',
        current: enrollments.current,
        previous: enrollments.previous ?? undefined,
        delta_absolute: enrollments.delta_absolute,
      },
    });
  }
  const enrollmentCount = metric('total_enrollments');
  const completionSampleIsSufficient = enrollmentCount.current >= REPORT_SIGNAL_THRESHOLDS.completion_decline.minimum_current_enrollments
    && (enrollmentCount.previous ?? 0) >= REPORT_SIGNAL_THRESHOLDS.completion_decline.minimum_previous_enrollments;
  if (completionSampleIsSufficient
    && (completion.delta_percentage_points ?? 0) <= REPORT_SIGNAL_THRESHOLDS.completion_decline.decline_percentage_points) {
    signals.push({
      id: 'completion_decline',
      category: 'completion',
      severity: 'warning',
      threshold_version: REPORT_SIGNAL_THRESHOLD_VERSION,
      evidence: {
        metric_id: 'completion_rate',
        current: completion.current,
        previous: completion.previous ?? undefined,
        delta_percentage_points: completion.delta_percentage_points ?? undefined,
        current_sample_size: enrollmentCount.current,
        previous_sample_size: enrollmentCount.previous ?? undefined,
      },
    });
  }
  const watchlist = input.coursePortfolio.filter((course) => (
    course.total_enrollments >= REPORT_SIGNAL_THRESHOLDS.high_enrollment_low_completion.minimum_enrollments
    && course.completion_rate <= REPORT_SIGNAL_THRESHOLDS.high_enrollment_low_completion.maximum_completion_rate
  ));
  if (watchlist.length > 0) {
    const representative = watchlist[0];
    signals.push({
      id: 'high_enrollment_low_completion',
      category: 'course',
      severity: 'warning',
      threshold_version: REPORT_SIGNAL_THRESHOLD_VERSION,
      evidence: {
        course_id: representative.course_id,
        course_name: representative.name,
        affected_course_count: watchlist.length,
        enrollment_count: representative.total_enrollments,
        completion_rate: representative.completion_rate,
      },
    });
  }
  if (input.activeTrend.length >= REPORT_SIGNAL_THRESHOLDS.end_period_activity_drop.minimum_buckets) {
    const recent = input.activeTrend.slice(-Math.min(7, Math.floor(input.activeTrend.length / 2))).reduce((sum, point) => sum + point.value, 0);
    const preceding = input.activeTrend.slice(-Math.min(14, input.activeTrend.length), -Math.min(7, Math.floor(input.activeTrend.length / 2))).reduce((sum, point) => sum + point.value, 0);
    if (preceding >= REPORT_SIGNAL_THRESHOLDS.end_period_activity_drop.minimum_preceding_activity
      && recent <= preceding * REPORT_SIGNAL_THRESHOLDS.end_period_activity_drop.maximum_recent_to_preceding_ratio) {
      signals.push({
        id: 'end_period_activity_drop',
        category: 'activity',
        severity: 'attention',
        threshold_version: REPORT_SIGNAL_THRESHOLD_VERSION,
        evidence: { current: recent, previous: preceding, delta_absolute: recent - preceding },
      });
    }
  }
  return signals.slice(0, 5);
}

export function getReportSignalLimitations(metrics: ReportMetricFact[]): string[] {
  const enrollments = metrics.find((metric) => metric.id === 'total_enrollments');
  if (!enrollments) return [];
  const currentIsSufficient = enrollments.current >= REPORT_SIGNAL_THRESHOLDS.completion_decline.minimum_current_enrollments;
  const previousIsSufficient = (enrollments.previous ?? 0) >= REPORT_SIGNAL_THRESHOLDS.completion_decline.minimum_previous_enrollments;
  return currentIsSufficient && previousIsSufficient
    ? []
    : [`completion_decline_insufficient_sample:${REPORT_SIGNAL_THRESHOLD_VERSION}`];
}

function hasReportData(summary: reportsService.ReportSummary): boolean {
  return Object.values(summary.overview).some((value) => Number(value) > 0);
}

async function resolveReportScopeDisplay(tenantId: string, scope: Pick<ReportScope, 'groupId' | 'subgroupId' | 'teamId'>): Promise<ReportScopeDisplay> {
  if (!scope.groupId && !scope.subgroupId && !scope.teamId) return {};
  const result = await query<{ group_name: string | null; subgroup_name: string | null; team_name: string | null }>(
    `SELECT
       (SELECT name FROM org_groups WHERE id = $2 AND tenant_id = $1) AS group_name,
       (SELECT sg.name FROM sub_groups sg JOIN org_groups og ON og.id = sg.org_group_id WHERE sg.id = $3 AND og.tenant_id = $1) AS subgroup_name,
       (SELECT t.name FROM teams t JOIN sub_groups sg ON sg.id = t.sub_group_id JOIN org_groups og ON og.id = sg.org_group_id WHERE t.id = $4 AND og.tenant_id = $1) AS team_name`,
    [tenantId, scope.groupId ?? null, scope.subgroupId ?? null, scope.teamId ?? null],
  );
  const row = result.rows[0];
  return {
    ...(row?.group_name ? { group_name: row.group_name } : {}),
    ...(row?.subgroup_name ? { subgroup_name: row.subgroup_name } : {}),
    ...(row?.team_name ? { team_name: row.team_name } : {}),
  };
}

export function createReportSnapshot(
  base: Pick<ReportChatSnapshot, 'version' | 'generated_at' | 'timezone' | 'filter' | 'scope' | 'comparison'>,
  summary: reportsService.ReportSummary,
  previousSummary: reportsService.ReportSummary,
  enrollmentTrend: Array<{ bucket: string; label: string; value: number }>,
  activeLearnerTrend: Array<{ bucket: string; label: string; value: number }>,
  coursePortfolio: reportsService.ReportCoursePerformance[],
  completionStatus: reportsService.ReportCompletionStatusDistribution,
  scopeDisplay: ReportScopeDisplay,
  availabilityState: ReportChatSnapshot['availability']['state'],
  enrollmentTrendContext: ReportTrendContext = {},
  courseDetail?: ReportCourseDetail,
  extensions: ReportSnapshotExtensions = {},
): ReportChatSnapshot {
  const factualMetrics = buildReportMetricFacts(summary, previousSummary);
  const signalLimitations = getReportSignalLimitations(factualMetrics);
  return {
    ...base,
    comparison_display: getReportComparisonDisplays(base.comparison),
    scope_display: scopeDisplay,
    summary,
    previous_summary: previousSummary,
    enrollment_trend: enrollmentTrend,
    ...(enrollmentTrendContext.granularity ? { enrollment_trend_context: enrollmentTrendContext } : {}),
    active_learner_trend: activeLearnerTrend,
    ...(extensions.previous_enrollment_trend ? { previous_enrollment_trend: extensions.previous_enrollment_trend } : {}),
    ...(extensions.previous_active_learner_trend ? { previous_active_learner_trend: extensions.previous_active_learner_trend } : {}),
    ...(extensions.unit_breakdown ? { unit_breakdown: extensions.unit_breakdown } : {}),
    ...(extensions.unit_breakdown_status ? { unit_breakdown_status: extensions.unit_breakdown_status } : {}),
    top_courses: coursePortfolio.slice(0, 5).map(({ course_id, name, total_enrollments }) => ({ course_id, name, enrollments: total_enrollments })),
    completion_ranking: [...coursePortfolio]
      .sort((left, right) => right.completion_rate - left.completion_rate || right.completed_enrollments - left.completed_enrollments || right.total_enrollments - left.total_enrollments || left.name.localeCompare(right.name))
      .slice(0, 5)
      .map(({ course_id, name, total_enrollments, completed_enrollments, incomplete_enrollments, completion_rate }) => ({ course_id, name, total_enrollments, completed_enrollments, incomplete_enrollments, completion_rate })),
    course_portfolio: coursePortfolio,
    ...(courseDetail ? { course_detail: courseDetail } : {}),
    completion_status_distribution: completionStatus,
    factual_metrics: factualMetrics,
    signals: buildReportSignals({ metrics: factualMetrics, activeTrend: activeLearnerTrend, coursePortfolio }),
    signal_threshold_version: REPORT_SIGNAL_THRESHOLD_VERSION,
    availability: {
      state: availabilityState,
      limitations: [
        ...(availabilityState === 'no_accessible_scope'
        ? ['no_accessible_scope']
        : availabilityState === 'empty'
          ? ['no_data_in_selected_period']
          : []),
        ...signalLimitations,
      ],
    },
  };
}

export function getReportSnapshotHash(snapshot: StoredReportChatSnapshot): string {
  return stableHash(snapshot);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isStoredReportChatSnapshot(value: unknown): value is StoredReportChatSnapshot {
  if (!isRecord(value) || (value.version !== LEGACY_SNAPSHOT_VERSION && value.version !== SNAPSHOT_VERSION) || !isRecord(value.filter) || !isRecord(value.scope)) return false;
  if (!isRecord(value.summary) || !isRecord(value.summary.overview)) return false;
  const validBase = typeof value.filter.date_from === 'string'
    && typeof value.filter.date_to === 'string'
    && Array.isArray(value.enrollment_trend)
    && Array.isArray(value.top_courses)
    && Array.isArray(value.completion_ranking);
  if (!validBase) return false;
  return value.version === LEGACY_SNAPSHOT_VERSION
    || (isRecord(value.comparison)
      && (value.comparison_display === undefined || isRecord(value.comparison_display))
      && isRecord(value.previous_summary)
      && Array.isArray(value.active_learner_trend)
      && Array.isArray(value.course_portfolio)
      && isRecord(value.completion_status_distribution)
      && Array.isArray(value.factual_metrics)
      && Array.isArray(value.signals)
      // Existing V2 snapshots predate versioned signal thresholds. Preserve their
      // integrity contract while new snapshots always carry the threshold version.
      && (value.signal_threshold_version === undefined || typeof value.signal_threshold_version === 'string')
      // Optional extensions (validated in depth by the PDF insights).
      && (value.previous_enrollment_trend === undefined || Array.isArray(value.previous_enrollment_trend))
      && (value.previous_active_learner_trend === undefined || Array.isArray(value.previous_active_learner_trend))
      && (value.unit_breakdown === undefined || isRecord(value.unit_breakdown))
      && (value.unit_breakdown_status === undefined || typeof value.unit_breakdown_status === 'string')
      && isRecord(value.availability));
}

export async function loadStoredReportSnapshot(input: {
  assistantMessageId: string;
  conversationId: string;
  userId: string;
  tenantId: string;
}): Promise<{ snapshot: StoredReportChatSnapshot; question: string; locale: 'vi' | 'en' }> {
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
  if (!isRecord(metadata) || metadata.kind !== 'report_analysis' || !isStoredReportChatSnapshot(metadata.report_snapshot)) {
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

export function formatReportFilterRequest(locale: 'vi' | 'en'): string {
  return locale === 'en'
    ? 'Choose the reporting period and organization scope, then apply the filter to generate a grounded analysis.'
    : 'Chọn thời gian và phạm vi tổ chức, sau đó áp dụng bộ lọc để tạo phân tích dựa trên số liệu thực tế.';
}
