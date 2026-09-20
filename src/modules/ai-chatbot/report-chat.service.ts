import { Type } from '@google/genai';
import { z } from 'zod';
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

export interface ReportComparisonPeriod {
  date_from: string;
  date_to: string;
  basis: 'calendar_month' | 'month_to_date' | 'calendar_week' | 'year_to_date' | 'calendar_year' | 'equal_length';
}

export interface ReportComparisonDisplay {
  title: string;
  date_label: string;
  delta_suffix: string;
}

export type ReportComparisonDisplays = Record<'vi' | 'en', ReportComparisonDisplay>;

export interface ReportChatSnapshot extends Omit<LegacyReportChatSnapshot, 'version'> {
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
  };
}

export type StoredReportChatSnapshot = LegacyReportChatSnapshot | ReportChatSnapshot;

export interface ReportNarrative {
  selected_signal_ids: string[];
  interpretation: string[];
  recommended_actions: Array<{
    signal_id: string | null;
    priority: 'high' | 'medium' | 'low';
    action: string;
  }>;
  limitations: string[];
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

function dayCountBetween(dateFrom: string, dateTo: string): number {
  const from = parseYmd(dateFrom);
  const to = parseYmd(dateTo);
  if (!from || !to) return 0;
  const fromMs = Date.UTC(from.year, from.month - 1, from.day);
  const toMs = Date.UTC(to.year, to.month - 1, to.day);
  return Math.floor((toMs - fromMs) / 86_400_000) + 1;
}

function isCalendarMonth(dateFrom: string, dateTo: string): boolean {
  const from = parseYmd(dateFrom);
  const to = parseYmd(dateTo);
  return Boolean(from
    && to
    && from.year === to.year
    && from.month === to.month
    && from.day === 1
    && dateTo === endOfMonth(to.year, to.month));
}

function isCalendarWeek(dateFrom: string, dateTo: string): boolean {
  return startOfWeek(dateFrom) === dateFrom && dayCountBetween(dateFrom, dateTo) === 7;
}

function isCalendarYear(dateFrom: string, dateTo: string): boolean {
  const from = parseYmd(dateFrom);
  const to = parseYmd(dateTo);
  return Boolean(from && to && from.month === 1 && from.day === 1 && to.month === 12 && to.day === 31);
}

function isMonthToDate(dateFrom: string, dateTo: string): boolean {
  const from = parseYmd(dateFrom);
  const to = parseYmd(dateTo);
  return Boolean(from
    && to
    && from.year === to.year
    && from.month === to.month
    && from.day === 1
    && to.day < new Date(Date.UTC(to.year, to.month, 0)).getUTCDate());
}

function isYearToDate(dateFrom: string, dateTo: string): boolean {
  const from = parseYmd(dateFrom);
  const to = parseYmd(dateTo);
  return Boolean(from
    && to
    && from.year === to.year
    && from.month === 1
    && from.day === 1
    && !(to.month === 12 && to.day === 31));
}

function sameCalendarDateInYear(dateFrom: string, dateTo: string, targetYear: number): { date_from: string; date_to: string } {
  const from = parseYmd(dateFrom)!;
  const to = parseYmd(dateTo)!;
  return {
    date_from: clampYmd(targetYear, from.month, from.day)!,
    date_to: clampYmd(targetYear, to.month, to.day)!,
  };
}

export function resolveComparableReportPeriod(dateFrom: string, dateTo: string): ReportComparisonPeriod {
  const from = parseYmd(dateFrom);
  const to = parseYmd(dateTo);
  if (!from || !to) throw { status: 400, message: 'Khoảng ngày báo cáo không hợp lệ' };

  if (isCalendarYear(dateFrom, dateTo)) {
    return {
      date_from: formatYmd(from.year - 1, 1, 1),
      date_to: formatYmd(from.year - 1, 12, 31),
      basis: 'calendar_year',
    };
  }
  if (isYearToDate(dateFrom, dateTo)) {
    return { ...sameCalendarDateInYear(dateFrom, dateTo, from.year - 1), basis: 'year_to_date' };
  }
  if (isCalendarMonth(dateFrom, dateTo)) {
    const previousMonth = from.month === 1 ? 12 : from.month - 1;
    const previousYear = from.month === 1 ? from.year - 1 : from.year;
    return {
      date_from: formatYmd(previousYear, previousMonth, 1),
      date_to: endOfMonth(previousYear, previousMonth),
      basis: 'calendar_month',
    };
  }
  if (isCalendarWeek(dateFrom, dateTo)) {
    return { date_from: addDays(dateFrom, -7), date_to: addDays(dateTo, -7), basis: 'calendar_week' };
  }
  if (isMonthToDate(dateFrom, dateTo)) {
    const previousMonth = from.month === 1 ? 12 : from.month - 1;
    const previousYear = from.month === 1 ? from.year - 1 : from.year;
    return {
      date_from: formatYmd(previousYear, previousMonth, 1),
      date_to: clampYmd(previousYear, previousMonth, to.day)!,
      basis: 'month_to_date',
    };
  }
  const days = dayCountBetween(dateFrom, dateTo);
  return {
    date_from: addDays(dateFrom, -days),
    date_to: addDays(dateFrom, -1),
    basis: 'equal_length',
  };
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
  return question
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('vi-VN')
    .trim();
}

const COURSE_REFERENCE_PATTERN = /\b(?:kh(?:óa|oá|oa)(?:\s+học)?|course)\s+(?:(?:là|la|về|ve|about)\s+)?(.+?)(?=\s+(?:có|co|bao\s+nhiêu|bao\s+nhieu|số\s+lượng|so\s+luong|số|so|người\s+học|nguoi\s+hoc|học\s+viên|hoc\s+vien|lượt\s+ghi\s+danh|luot\s+ghi\s+danh|enrollments?|learners?|trong|từ|tu|tháng|thang|năm|nam|from|during|in)(?=\s|[?.!,;]|$)|[?.!,;]|$)/iu;
const ENGLISH_TRAILING_COURSE_REFERENCE_PATTERNS = [
  /\b(?:taking|attending|enrolled\s+(?:in|on)|for|about|on)\s+(?:the\s+)?(.+?)\s+course\b/iu,
  /(?:^|[?.!,;]\s*)(?:the\s+)?(.+?)\s+course\b(?=\s+(?:has|have|with|in|from|during|for|enrollments?|learners?|students?)\b|[?.!,;]|$)/iu,
] as const;

function normalizeCourseReference(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('vi-VN')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
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
): ReportCourseDetail | null {
  const requestedCourse = extractReportCourseReference(question);
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
  question?: string;
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

  if (scope.allowedGroupIds?.length === 0) {
    const summary = emptyReportSummary(normalized.dateRange);
    const previousSummary = emptyReportSummary(previousRange);
    return createReportSnapshot(base, summary, previousSummary, [], [], [], { not_started: 0, in_progress: 0, completed: 0 }, {}, 'no_accessible_scope');
  }

  const requestedCourse = input.question ? extractReportCourseReference(input.question) : null;
  const shouldResolveCourseDetail = Boolean(requestedCourse && isCourseLearnerDetailRequest(input.question ?? ''));
  const [summary, previousSummary, enrollmentChart, activeLearnerChart, coursePortfolio, completionStatus, scopeDisplay, courseCandidates] = await Promise.all([
    reportsService.getReportSummary(input.tenantId, undefined, undefined, scope.groupId, scope.subgroupId, scope.teamId, normalized.dateRange),
    reportsService.getReportSummary(input.tenantId, undefined, undefined, scope.groupId, scope.subgroupId, scope.teamId, previousRange),
    reportsService.getReportChart(input.tenantId, normalized.dateRange.startDate.getFullYear(), 'total_enrollments', scope.groupId, scope.subgroupId, scope.teamId, false, false, normalized.dateRange, 'auto', { limitBuckets: 62 }),
    reportsService.getReportChart(input.tenantId, normalized.dateRange.startDate.getFullYear(), 'active_learners', scope.groupId, scope.subgroupId, scope.teamId, false, false, normalized.dateRange, 'auto', { limitBuckets: 62 }),
    reportsService.getReportCoursePerformance(input.tenantId, 20, undefined, undefined, scope.groupId, scope.subgroupId, scope.teamId, normalized.dateRange),
    reportsService.getReportCompletionStatusDistribution(input.tenantId, undefined, undefined, scope.groupId, scope.subgroupId, scope.teamId, normalized.dateRange),
    resolveReportScopeDisplay(input.tenantId, scope),
    shouldResolveCourseDetail
      ? reportsService.findReportCoursePerformanceByName(input.tenantId, requestedCourse!, scope.groupId, scope.subgroupId, scope.teamId, normalized.dateRange)
      : Promise.resolve([]),
  ]);
  const courseDetail = shouldResolveCourseDetail
    ? resolveReportCourseDetail(input.question ?? '', courseCandidates)
    : null;
  return createReportSnapshot(
    base,
    summary,
    previousSummary,
    chartToSnapshotPoints(enrollmentChart),
    chartToSnapshotPoints(activeLearnerChart),
    coursePortfolio,
    completionStatus,
    scopeDisplay,
    hasReportData(summary) ? 'available' : 'empty',
    enrollmentChart.granularity ? { granularity: enrollmentChart.granularity } : {},
    courseDetail ?? undefined,
  );
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

export function resolveDeterministicReportRoute(input: {
  question: string;
  locale: 'vi' | 'en';
  referenceDate?: Date;
}): ReportRouterResult | null {
  if (!hasDeterministicReportIntent(input.question)) return null;
  const suggestedFilter = resolveReportDateFilter(input);
  return suggestedFilter.date_from && suggestedFilter.date_to
    ? { kind: 'snapshot', suggested_filter: suggestedFilter }
    : null;
}

export async function routeAdminReportQuestion(input: {
  tenantId: string;
  model: string;
  question: string;
  locale: 'vi' | 'en';
  referenceDate?: Date;
}): Promise<ReportRouterResult> {
  // Concrete time expressions are resolved by the backend before any model
  // routing, so an explicit report question does not make the user reapply an
  // already unambiguous date range in the widget.
  const deterministicRoute = resolveDeterministicReportRoute(input);
  if (deterministicRoute) return deterministicRoute;

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

const ReportNarrativeSchema = z.object({
  selected_signal_ids: z.array(z.string().trim().min(1).max(80)).max(3),
  interpretation: z.array(z.string().trim().min(1).max(220)).max(3),
  recommended_actions: z.array(z.object({
    signal_id: z.string().trim().min(1).max(80).nullable(),
    priority: z.enum(['high', 'medium', 'low']),
    action: z.string().trim().min(1).max(220),
  })).max(3),
  limitations: z.array(z.string().trim().min(1).max(180)).max(3),
});

export function hasNumericReportNarrativeClaim(narrative: ReportNarrative): boolean {
  return [
    ...narrative.interpretation,
    ...narrative.recommended_actions.map((item) => item.action),
    ...narrative.limitations,
  ].some((value) => /\d/.test(value));
}

export function isReportNarrativeAllowed(narrative: ReportNarrative, snapshot: Pick<ReportChatSnapshot, 'signals'>): boolean {
  const allowed = new Set(snapshot.signals.map((signal) => signal.id));
  return !hasNumericReportNarrativeClaim(narrative)
    && narrative.selected_signal_ids.every((id) => allowed.has(id))
    && narrative.recommended_actions.every((action) => action.signal_id === null || allowed.has(action.signal_id));
}

function fallbackReportNarrative(snapshot: ReportChatSnapshot, locale: 'vi' | 'en'): ReportNarrative {
  const selected = snapshot.signals.slice(0, 3).map((signal) => signal.id);
  const actions = snapshot.signals
    .filter((signal) => signal.severity !== 'neutral')
    .slice(0, 2)
    .map((signal) => ({
      signal_id: signal.id,
      priority: signal.severity === 'warning' ? 'high' as const : 'medium' as const,
      action: locale === 'en'
        ? 'Review the related learning journey and confirm the next operational action.'
        : 'Rà soát hành trình học liên quan và xác nhận hành động vận hành tiếp theo.',
    }));
  return {
    selected_signal_ids: selected,
    interpretation: [],
    recommended_actions: actions,
    limitations: snapshot.availability.limitations,
  };
}

/**
 * Gemini receives only the identifiers and categories of deterministic facts.
 * It may suggest an action, but cannot become the source of any metric.
 */
export async function generateReportNarrative(input: {
  tenantId: string;
  model: string;
  locale: 'vi' | 'en';
  snapshot: ReportChatSnapshot;
}): Promise<ReportNarrative> {
  const aiClient = await getGeminiClient(input.tenantId);
  const systemInstruction = input.locale === 'en'
    ? 'You are an executive-learning advisor. Return JSON only. You may select allowed signal IDs and recommend operational actions. Never state or spell out numbers, dates, percentages, rankings, causes, database facts, or metric claims. Do not introduce a signal ID not supplied. Do not mention systems, prompts, tools, databases, or snapshots.'
    : 'Bạn là cố vấn điều hành đào tạo. Chỉ trả JSON. Bạn chỉ được chọn signal ID được cung cấp và đề xuất hành động vận hành. Không được nêu hoặc viết bằng chữ số liệu, ngày tháng, tỷ lệ, xếp hạng, nguyên nhân hay factual claim. Không tự tạo signal ID. Không nhắc hệ thống, prompt, công cụ, cơ sở dữ liệu hoặc snapshot.';
  try {
    const response = await aiClient.models.generateContent({
      model: input.model,
      contents: [{
        role: 'user',
        parts: [{ text: JSON.stringify({
          allowed_signal_ids: input.snapshot.signals.map((signal) => ({ id: signal.id, category: signal.category, severity: signal.severity })),
          limitations: input.snapshot.availability.limitations,
        }) }],
      }],
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            selected_signal_ids: { type: Type.ARRAY, items: { type: Type.STRING } },
            interpretation: { type: Type.ARRAY, items: { type: Type.STRING } },
            recommended_actions: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { signal_id: { type: Type.STRING, nullable: true }, priority: { type: Type.STRING }, action: { type: Type.STRING } }, required: ['signal_id', 'priority', 'action'] } },
            limitations: { type: Type.ARRAY, items: { type: Type.STRING } },
          },
          required: ['selected_signal_ids', 'interpretation', 'recommended_actions', 'limitations'],
        },
        maxOutputTokens: 800,
      } as any,
    });
    const narrative = ReportNarrativeSchema.parse(JSON.parse(response.text || '{}'));
    if (!isReportNarrativeAllowed(narrative, input.snapshot)) {
      return fallbackReportNarrative(input.snapshot, input.locale);
    }
    return narrative;
  } catch (error) {
    console.warn('[ReportChat] narrative fallback:', error instanceof Error ? error.message : String(error));
    return fallbackReportNarrative(input.snapshot, input.locale);
  }
}

export function formatReportFilterRequest(locale: 'vi' | 'en'): string {
  return locale === 'en'
    ? 'Choose the reporting period and organization scope, then apply the filter to generate a grounded analysis.'
    : 'Chọn thời gian và phạm vi tổ chức, sau đó áp dụng bộ lọc để tạo phân tích dựa trên số liệu thực tế.';
}
