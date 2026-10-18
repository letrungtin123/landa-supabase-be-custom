// ═══════════════════════════════════════════════════════════════
// Reports Service — Analytics & Dashboard data
// Optimized for millions of rows:
//   - Chart: single batch SQL per metric (not N×12 queries)
//   - Composite indexes for all hot paths
//   - No N+1 subqueries
// ═══════════════════════════════════════════════════════════════

import { cacheJson, cacheKey, getCacheVersion, stableHash } from '../../config/cache.js';
import { cacheKeys, cacheVersions } from '../../config/cache-keys.js';
import { reportsQuery } from '../../config/reports-database.js';
import { getStudyTimeSeries, type StudyTimeGranularity, type StudyTimeSeriesResponse } from '../enrollments/enrollments.service.js';
import { runReportAggregate } from './report-admission.service.js';
import { resolveAutoReportBucket } from './report-buckets.logic.js';
import { buildOrgUnitChartPoints, type OrgChartDimension } from './report-org-chart.logic.js';
import { loadOrgChartEntities, loadOrgChartMonthValues } from './report-org-chart.repository.js';
import { createReportChartRepository, type GroupedEnrollmentDimension } from './report-chart.repository.js';
import { createReportCoursesRepository, type CoursePerformanceRow } from './report-courses.repository.js';
import {
  buildActiveLearnerEventsCte,
  buildLearnerScopeExists,
  buildReportEnrollmentCte,
  buildReportLearnerRosterCte,
  buildVisibleCourseUsersCte,
} from './report-sql.js';

// The shared fragments moved to report-sql.ts; these names stay importable from here.
export { buildActiveLearnerEventsCte, buildLearnerScopeExists, buildReportEnrollmentCte, buildReportLearnerRosterCte };

// ── Types ──

export interface ReportSummary {
  meta: {
    month: number;
    year: number;
    month_label: string;
    is_current_month: boolean;
    date_from?: string;
    date_to?: string;
    range_label?: string;

  };
  overview: {
    total_learners: number;
    active_learners: number;
    completion_rate: number;
    total_enrollments: number;
    completed_enrollments: number;
    incomplete_enrollments: number;
  };
}

export type ReportChartGranularity = 'auto' | 'day' | 'week' | 'month';
type EffectiveChartGranularity = Exclude<ReportChartGranularity, 'auto'>;
export type ReportChartWindowDirection = 'initial' | 'before' | 'after';

export interface ReportChartWindowOptions {
  mode?: 'range' | 'window';
  direction?: ReportChartWindowDirection;
  anchorBucket?: string;
  limitBuckets?: number;
  seriesLimit?: number;
}

export interface ReportChartWindowMeta {
  mode: 'window';
  range_start: string;
  range_end: string;
  window_start: string;
  window_end: string;
  has_before: boolean;
  has_after: boolean;
  next_before: string | null;
  next_after: string | null;
  limit_buckets: number;
}
export interface ReportDateRange {
  startDate: Date;
  endDate: Date;
  dateFrom: string;
  dateTo: string;
}
export interface ReportChartPoint {
  month: string;
  month_label: string;
  bucket?: string;
  bucket_label?: string;
  value?: number;
  [key: string]: unknown;
}
export interface ReportTopCourse {
  course_id: string;
  name: string;
  enrollments: number;
}

export type ReportCourseCompletionStatus = 'all' | 'not_started' | 'learning' | 'completed';
export type LearnerDetailDataScope = 'report_filter' | 'learner_history';

export interface ReportCourseCompletionRanking {
  course_id: string;
  name: string;
  total_enrollments: number;
  completed_enrollments: number;
  incomplete_enrollments: number;
  completion_rate: number;
}

export interface ReportCoursePerformance extends ReportCourseCompletionRanking {
  not_started_enrollments: number;
  in_progress_enrollments: number;
}

export interface ReportCompletionStatusDistribution {
  not_started: number;
  in_progress: number;
  completed: number;
}

export interface ReportCourseCompletionLearner {
  user_id: string;
  username: string;
  email: string;
  full_name: string;
  avatar: string | null;
  enrolled_at: string | null;
  completed_at: string | null;
  progress: number | null;
  status: Exclude<ReportCourseCompletionStatus, 'all'>;
}

export interface ReportLearner {
  username: string;
  email: string;
  avatar: string | null;
  last_completion_at: string | null;
  completion_rate: number;
  completed_courses: number;
  enrolled_courses: number;
  status: 'not_started' | 'learning' | 'completed';
}

export interface LearnerDetailResult {
  course_id: string;
  course_name: string;
  enrolled_at: string | null;
  completed_at: string | null;
  progress: number;
  is_completed: boolean;
  status: Exclude<ReportCourseCompletionStatus, 'all'>;
}

export interface LearnerDetailResponse {
  username: string;
  groups: Array<{ group_name: string; subgroup_name: string }>;
  results: LearnerDetailResult[];
  total_count: number;
  total_pages: number;
  current_page: number;
}

// ── Helpers ──

const chartRepository = createReportChartRepository({ query: reportsQuery });
const coursesRepository = createReportCoursesRepository({ query: reportsQuery });

const MONTH_LABELS = [
  '', 'Tháng 1', 'Tháng 2', 'Tháng 3', 'Tháng 4', 'Tháng 5', 'Tháng 6',
  'Tháng 7', 'Tháng 8', 'Tháng 9', 'Tháng 10', 'Tháng 11', 'Tháng 12',
];

const DEFAULT_CHART_WINDOW_BUCKETS = 72;
const MIN_CHART_WINDOW_BUCKETS = 12;
const MAX_CHART_WINDOW_BUCKETS = 120;
const DEFAULT_GROUP_SERIES_LIMIT = 8;
const MAX_GROUP_SERIES_LIMIT = 12;
const YMD_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

type ResolvedChartWindow = {
  range: ReportDateRange;
  meta: ReportChartWindowMeta;
};

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value!), min), max);
}

function clampChartLimit(value?: number): number {
  return clampInteger(value, DEFAULT_CHART_WINDOW_BUCKETS, MIN_CHART_WINDOW_BUCKETS, MAX_CHART_WINDOW_BUCKETS);
}

function clampSeriesLimit(value?: number): number {
  return clampInteger(value, DEFAULT_GROUP_SERIES_LIMIT, 1, MAX_GROUP_SERIES_LIMIT);
}

function parseYmdParts(ymd: string): { year: number; month: number; day: number } {
  if (!YMD_PATTERN.test(ymd)) throw new Error(`Invalid YMD date: ${ymd}`);
  const [year, month, day] = ymd.split('-').map(Number);
  return { year, month, day };
}

function ymdFromUtcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDaysYmd(ymd: string, days: number): string {
  const { year, month, day } = parseYmdParts(ymd);
  return ymdFromUtcDate(new Date(Date.UTC(year, month - 1, day + days)));
}

function addMonthsYmd(ymd: string, months: number): string {
  const { year, month } = parseYmdParts(ymd);
  return ymdFromUtcDate(new Date(Date.UTC(year, month - 1 + months, 1)));
}

function startOfIsoWeekYmd(ymd: string): string {
  const { year, month, day } = parseYmdParts(ymd);
  const date = new Date(Date.UTC(year, month - 1, day));
  const isoDay = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - isoDay + 1);
  return ymdFromUtcDate(date);
}

function startOfBucketYmd(ymd: string, granularity: EffectiveChartGranularity): string {
  if (granularity === 'month') return `${ymd.slice(0, 7)}-01`;
  if (granularity === 'week') return startOfIsoWeekYmd(ymd);
  return ymd;
}

function addBucketYmd(ymd: string, granularity: EffectiveChartGranularity, amount: number): string {
  if (granularity === 'month') return addMonthsYmd(ymd, amount);
  if (granularity === 'week') return addDaysYmd(ymd, amount * 7);
  return addDaysYmd(ymd, amount);
}

function endOfBucketYmd(ymd: string, granularity: EffectiveChartGranularity): string {
  if (granularity === 'month') return addDaysYmd(addMonthsYmd(ymd, 1), -1);
  if (granularity === 'week') return addDaysYmd(ymd, 6);
  return ymd;
}

function maxYmd(a: string, b: string): string {
  return a >= b ? a : b;
}

function minYmd(a: string, b: string): string {
  return a <= b ? a : b;
}

function clampYmd(value: string, min: string, max: string): string {
  return minYmd(maxYmd(value, min), max);
}

function parseLocalDayStart(ymd: string): Date {
  return new Date(`${ymd}T00:00:00.000+07:00`);
}

function parseLocalDayEnd(ymd: string): Date {
  return new Date(`${ymd}T23:59:59.999+07:00`);
}

function resolveChartWindow(
  fullRange: ReportDateRange,
  granularity: EffectiveChartGranularity,
  options: ReportChartWindowOptions,
): ResolvedChartWindow {
  const limit = clampChartLimit(options.limitBuckets);
  const rangeStartBucket = startOfBucketYmd(fullRange.dateFrom, granularity);
  const rangeEndBucket = startOfBucketYmd(fullRange.dateTo, granularity);
  const rawAnchor = options.anchorBucket && YMD_PATTERN.test(options.anchorBucket)
    ? startOfBucketYmd(options.anchorBucket, granularity)
    : undefined;
  const anchorBucket = rawAnchor ? clampYmd(rawAnchor, rangeStartBucket, rangeEndBucket) : undefined;
  const direction = options.direction || 'initial';

  let windowStartBucket: string;
  let windowEndBucket: string;

  if (direction === 'before') {
    const anchor = anchorBucket || rangeEndBucket;
    windowEndBucket = addBucketYmd(anchor, granularity, -1);
    if (windowEndBucket < rangeStartBucket) windowEndBucket = rangeStartBucket;
    windowStartBucket = maxYmd(rangeStartBucket, addBucketYmd(windowEndBucket, granularity, -(limit - 1)));
  } else if (direction === 'after') {
    const anchor = anchorBucket || rangeStartBucket;
    windowStartBucket = addBucketYmd(anchor, granularity, 1);
    if (windowStartBucket > rangeEndBucket) windowStartBucket = rangeEndBucket;
    windowEndBucket = minYmd(rangeEndBucket, addBucketYmd(windowStartBucket, granularity, limit - 1));
  } else {
    windowEndBucket = rangeEndBucket;
    windowStartBucket = maxYmd(rangeStartBucket, addBucketYmd(windowEndBucket, granularity, -(limit - 1)));
  }

  const windowDateFrom = maxYmd(fullRange.dateFrom, windowStartBucket);
  const windowDateTo = minYmd(fullRange.dateTo, endOfBucketYmd(windowEndBucket, granularity));
  const hasBefore = windowStartBucket > rangeStartBucket;
  const hasAfter = windowEndBucket < rangeEndBucket;

  return {
    range: {
      startDate: parseLocalDayStart(windowDateFrom),
      endDate: parseLocalDayEnd(windowDateTo),
      dateFrom: windowDateFrom,
      dateTo: windowDateTo,
    },
    meta: {
      mode: 'window',
      range_start: fullRange.dateFrom,
      range_end: fullRange.dateTo,
      window_start: windowStartBucket,
      window_end: windowEndBucket,
      has_before: hasBefore,
      has_after: hasAfter,
      next_before: hasBefore ? windowStartBucket : null,
      next_after: hasAfter ? windowEndBucket : null,
      limit_buckets: limit,
    },
  };
}

/**
 * What a date-range chart computes. Only enrollments outside a team scope are
 * split into series; every other request is the plain series whatever its
 * grouped / group_by_org / series_limit, so the report page and the report
 * chat share one cache entry for the same numbers.
 */
type DateRangeChartShape =
  | { kind: 'simple' }
  | { kind: 'grouped'; dimension: GroupedEnrollmentDimension; parentId?: string; seriesLimit: number };

function resolveDateRangeChartShape(options: {
  metric: string;
  groupId?: string;
  subgroupId?: string;
  teamId?: string;
  groupByOrg: boolean;
  grouped: boolean;
  seriesLimit: number;
}): DateRangeChartShape {
  if (!options.teamId && options.metric === 'total_enrollments') {
    if (options.groupByOrg) return { kind: 'grouped', dimension: 'group', parentId: options.groupId, seriesLimit: options.seriesLimit };
    if (options.subgroupId && options.grouped) return { kind: 'grouped', dimension: 'team', parentId: options.subgroupId, seriesLimit: options.seriesLimit };
    if (options.groupId && options.grouped) return { kind: 'grouped', dimension: 'subgroup', parentId: options.groupId, seriesLimit: options.seriesLimit };
  }
  return { kind: 'simple' };
}

function buildReportChartCacheKey(options: {
  tenantId: string;
  metric: string;
  range: ReportDateRange;
  granularity: EffectiveChartGranularity;
  groupId?: string;
  subgroupId?: string;
  teamId?: string;
  shape: DateRangeChartShape;
}): string {
  return cacheKey('reports', 'chart', 'v10', options.tenantId, stableHash({
    metric: options.metric,
    dateFrom: options.range.dateFrom,
    dateTo: options.range.dateTo,
    granularity: options.granularity,
    groupId: options.groupId,
    subgroupId: options.subgroupId,
    teamId: options.teamId,
    shape: options.shape,
  }));
}
function buildReportSummaryCacheKey(options: {
  tenantId: string;
  range: ReportDateRange;
  groupId?: string;
  subgroupId?: string;
  teamId?: string;
  usesDateRange: boolean;
}): string {
  return cacheKey('reports', 'summary', 'v7', options.tenantId, stableHash({
    dateFrom: options.range.dateFrom,
    dateTo: options.range.dateTo,
    groupId: options.groupId,
    subgroupId: options.subgroupId,
    teamId: options.teamId,
    usesDateRange: options.usesDateRange,
  }));
}

function getMonthRange(year: number, month: number): { startDate: Date; endDate: Date } {
  const startDate = new Date(year, month - 1, 1);
  const endDate = new Date(year, month, 0, 23, 59, 59, 999);
  return { startDate, endDate };
}

function getReportRange(month?: number, year?: number, dateRange?: ReportDateRange): ReportDateRange {
  if (dateRange) return dateRange;

  const now = new Date();
  const targetMonth = month ?? (now.getMonth() + 1);
  const targetYear = year ?? now.getFullYear();
  const { startDate, endDate } = getMonthRange(targetYear, targetMonth);
  const dateFrom = `${targetYear}-${String(targetMonth).padStart(2, '0')}-01`;
  const dateTo = `${targetYear}-${String(targetMonth).padStart(2, '0')}-${String(endDate.getDate()).padStart(2, '0')}`;
  return { startDate, endDate, dateFrom, dateTo };
}

function getRangeLabel(range: ReportDateRange): string {
  if (range.dateFrom === range.dateTo) return range.dateFrom;
  return `${range.dateFrom} đến ${range.dateTo}`;
}

function getRangeDayCount(range: ReportDateRange): number {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.max(1, Math.ceil((range.endDate.getTime() - range.startDate.getTime() + 1) / msPerDay));
}

function getSummaryCacheTtl(range: Pick<ReportDateRange, 'dateTo'>): number {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
  return range.dateTo >= today ? 30 : 300;
}

/** Seconds a cached aggregate of a range lives: 30 while the range includes today, else 300. */
export function getReportAggregateCacheTtl(range: Pick<ReportDateRange, 'dateTo'>): number {
  return getSummaryCacheTtl(range);
}

/**
 * Report list pages (learners, a course's learners, top courses, the yearly
 * chart): 30 s while the period includes today, 60 s for a past period. Lists
 * page and search, so they keep a shorter life than the summary figures.
 */
function getReportListCacheTtl(dateTo: string | null): number {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
  return dateTo === null || dateTo >= today ? 30 : 60;
}

/**
 * A report aggregate: from Redis when cached, else loaded in a slot of the
 * tenant's report admission (runReportAggregate), so a cache hit never waits.
 */
function cachedReportAggregate<T>(tenantId: string, key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T> {
  return cacheJson(key, ttlSeconds, () => runReportAggregate(tenantId, load));
}

/** Effective chart granularity of a range (the rule of the Reports charts). */
export function resolveReportChartGranularity(range: ReportDateRange, requested: ReportChartGranularity = 'auto'): 'day' | 'week' | 'month' {
  return resolveChartGranularity(range, requested);
}

/**
 * An explicit choice is kept within its limits; 'auto' follows the shared
 * report bucket rule (report-buckets.logic.ts): up to 31 days by day, up to
 * 120 days by ISO week, longer ranges by month.
 */
function resolveChartGranularity(range: ReportDateRange, requested: ReportChartGranularity = 'auto'): EffectiveChartGranularity {
  const days = getRangeDayCount(range);
  if (requested === 'day' && days <= 366) return 'day';
  if (requested === 'week' && days <= 1095) return 'week';
  if (requested === 'month') return 'month';
  return resolveAutoReportBucket(days);
}

// ═══════════════════════════════════════════════════════════════
// Report Summary — 4 queries total (optimized)
// ═══════════════════════════════════════════════════════════════

export async function getReportSummary(
  tenantId: string,
  month?: number,
  year?: number,
  groupId?: string,
  subgroupId?: string,
  teamId?: string,
  dateRange?: ReportDateRange,
): Promise<ReportSummary> {
  const now = new Date();
  const range = getReportRange(month, year, dateRange);
  const targetMonth = range.startDate.getMonth() + 1;
  const targetYear = range.startDate.getFullYear();
  const isCurrentMonth = !dateRange && targetMonth === now.getMonth() + 1 && targetYear === now.getFullYear();
  const summaryCacheKey = buildReportSummaryCacheKey({
    tenantId,
    range,
    groupId,
    subgroupId,
    teamId,
    usesDateRange: Boolean(dateRange),
  });

  return cachedReportAggregate(tenantId, summaryCacheKey, getSummaryCacheTtl(range), () => getReportSummaryForRange({
    tenantId,
    range,
    targetMonth,
    targetYear,
    isCurrentMonth,
    groupId,
    subgroupId,
    teamId,
    usesDateRange: Boolean(dateRange),
  }));
}

async function getReportSummaryForRange(options: {
  tenantId: string;
  range: ReportDateRange;
  targetMonth: number;
  targetYear: number;
  isCurrentMonth: boolean;
  groupId?: string;
  subgroupId?: string;
  teamId?: string;
  usesDateRange: boolean;
}): Promise<ReportSummary> {
  const {
    tenantId,
    range,
    targetMonth,
    targetYear,
    isCurrentMonth,
    groupId,
    subgroupId,
    teamId,
    usesDateRange,
  } = options;
  const row = await chartRepository.selectSummary({ tenantId, range, groupId, subgroupId, teamId });
  return {
    meta: {
      month: targetMonth,
      year: targetYear,
      month_label: usesDateRange ? getRangeLabel(range) : MONTH_LABELS[targetMonth],
      is_current_month: isCurrentMonth,
      date_from: range.dateFrom,
      date_to: range.dateTo,
      range_label: getRangeLabel(range),
    },
    overview: {
      total_learners: parseInt(row?.total_learners ?? '0', 10),
      active_learners: parseInt(row?.active_learners ?? '0', 10),
      completion_rate: parseFloat(row?.completion_rate ?? '0'),
      total_enrollments: parseInt(row?.total_enrollments ?? '0', 10),
      completed_enrollments: parseInt(row?.completed_enrollments ?? '0', 10),
      incomplete_enrollments: parseInt(row?.incomplete_enrollments ?? '0', 10),
    },
  };
}

// Report Chart - batch queries (1 SQL per metric, not N x 12 queries)
export async function getReportChart(
  tenantId: string,
  year: number,
  metric: string,
  groupId?: string,
  subgroupId?: string,
  teamId?: string,
  groupByOrg = false,
  grouped = true,
  dateRange?: ReportDateRange,
  requestedGranularity: ReportChartGranularity = 'auto',
  windowOptions: ReportChartWindowOptions = {},
): Promise<{
  year: number;
  metric: string;
  data: ReportChartPoint[];
  is_grouped: boolean;
  granularity?: EffectiveChartGranularity;
  date_from?: string;
  date_to?: string;
  bucket_count?: number;
  window?: ReportChartWindowMeta;
  series_limit?: number;
  series_overflow?: boolean;
}> {
  if (dateRange) {
    const granularity = resolveChartGranularity(dateRange, requestedGranularity);
    const seriesLimit = clampSeriesLimit(windowOptions.seriesLimit);
    const resolvedWindow = windowOptions.mode === 'window'
      ? resolveChartWindow(dateRange, granularity, windowOptions)
      : null;
    const queryRange = resolvedWindow?.range ?? dateRange;
    const shape = resolveDateRangeChartShape({ metric, groupId, subgroupId, teamId, groupByOrg, grouped, seriesLimit });
    const chartCacheKey = buildReportChartCacheKey({
      tenantId,
      metric,
      range: queryRange,
      granularity,
      groupId,
      subgroupId,
      teamId,
      shape,
    });
    const result = await cachedReportAggregate(tenantId, chartCacheKey, 90, () => chartByDateRange(
      tenantId,
      metric,
      queryRange,
      granularity,
      shape,
      groupId,
      subgroupId,
      teamId,
    ));
    return {
      year: dateRange.startDate.getFullYear(),
      metric,
      ...result,
      granularity,
      date_from: dateRange.dateFrom,
      date_to: dateRange.dateTo,
      bucket_count: result.data.length,
      window: resolvedWindow?.meta,
      series_limit: result.is_grouped ? seriesLimit : undefined,
    };
  }

  const now = new Date();
  const maxMonth = year > now.getFullYear() ? 0
    : year === now.getFullYear() ? now.getMonth() + 1
    : 12;
  const yearChartCacheKey = cacheKey('reports', 'chart-year', 'v1', tenantId, stableHash({
    year, metric, groupId, subgroupId, teamId, groupByOrg, grouped, maxMonth,
  }));

  return cachedReportAggregate(tenantId, yearChartCacheKey, getReportListCacheTtl(`${year}-12-31`), async () => {
    if (teamId) {
      return chartSimple(tenantId, year, metric, maxMonth, groupId, subgroupId, teamId);
    }
    if (groupByOrg) {
      return chartGroupedByOrgUnit(tenantId, year, metric, maxMonth, 'group', groupId);
    }
    if (subgroupId && grouped) {
      return chartGroupedByOrgUnit(tenantId, year, metric, maxMonth, 'team', subgroupId);
    }
    if (groupId && grouped) {
      return chartGroupedByOrgUnit(tenantId, year, metric, maxMonth, 'subgroup', groupId);
    }

    return chartSimple(tenantId, year, metric, maxMonth, groupId, subgroupId, teamId);
  });
}

async function chartByDateRange(
  tenantId: string,
  metric: string,
  range: ReportDateRange,
  granularity: EffectiveChartGranularity,
  shape: DateRangeChartShape,
  groupId?: string,
  subgroupId?: string,
  teamId?: string,
): Promise<{ data: ReportChartPoint[]; is_grouped: boolean; series_overflow?: boolean }> {
  if (shape.kind === 'grouped') {
    return chartGroupedEnrollmentsByRange(tenantId, range, granularity, shape.dimension, shape.parentId, shape.seriesLimit);
  }

  const data = await chartSimpleByRange(tenantId, metric, range, granularity, groupId, subgroupId, teamId);
  return { data, is_grouped: false };
}
async function chartSimpleByRange(
  tenantId: string,
  metric: string,
  range: ReportDateRange,
  granularity: EffectiveChartGranularity,
  groupId?: string,
  subgroupId?: string,
  teamId?: string,
): Promise<ReportChartPoint[]> {
  const rows = await chartRepository.selectRangeBuckets({ tenantId, metric, range, granularity, groupId, subgroupId, teamId });
  return rows.map(row => ({
    month: row.bucket,
    month_label: row.bucket_label,
    bucket: row.bucket,
    bucket_label: row.bucket_label,
    value: metric === 'completion_rate'
      ? parseFloat(row.value ?? '0')
      : parseInt(row.value ?? '0', 10),
  }));
}
async function chartGroupedEnrollmentsByRange(
  tenantId: string,
  range: ReportDateRange,
  granularity: EffectiveChartGranularity,
  dimension: GroupedEnrollmentDimension,
  parentId?: string,
  seriesLimit = DEFAULT_GROUP_SERIES_LIMIT,
): Promise<{ data: ReportChartPoint[]; is_grouped: boolean; series_overflow?: boolean }> {
  const rows = await chartRepository.selectGroupedEnrollmentBuckets({
    tenantId,
    range,
    granularity,
    dimension,
    parentId,
    seriesLimit: clampSeriesLimit(seriesLimit),
  });

  const points = new Map<string, ReportChartPoint>();
  let seriesOverflow = false;
  for (const row of rows) {
    if (row.series_name === 'Khác') seriesOverflow = true;
    const point = points.get(row.bucket) || {
      month: row.bucket,
      month_label: row.bucket_label,
      bucket: row.bucket,
      bucket_label: row.bucket_label,
    };
    point[row.series_name] = parseInt(row.value ?? '0');
    points.set(row.bucket, point);
  }

  return { data: [...points.values()], is_grouped: true, series_overflow: seriesOverflow };
}
/**
 * Simple chart — 1 SQL query for ALL 12 months (batch).
 * Uses GROUP BY EXTRACT(MONTH FROM ...) instead of 12 separate queries.
 */
async function chartSimple(
  tenantId: string, year: number, metric: string, maxMonth: number,
  groupId?: string, subgroupId?: string, teamId?: string,
): Promise<{ year: number; metric: string; data: ReportChartPoint[]; is_grouped: boolean }> {
  const yearStart = new Date(year, 0, 1);
  const yearEnd = new Date(year, 11, 31, 23, 59, 59, 999);

  const monthValues = teamId
    ? await batchMetricByMonthTeam(tenantId, metric, yearStart, yearEnd, year, teamId)
    : await batchMetricByMonth(tenantId, metric, yearStart, yearEnd, year, groupId, subgroupId);

  const data: ReportChartPoint[] = [];
  for (let m = 1; m <= 12; m++) {
    data.push({
      month: `T${m}`,
      month_label: MONTH_LABELS[m],
      value: m > maxMonth ? 0 : (monthValues.get(m) ?? 0),
    });
  }

  return { year, metric, data, is_grouped: false };
}

/**
 * Yearly chart split by org unit (company, branch or department under the
 * parent): the unit list, then ONE grouped statement for every unit's
 * months (report-org-chart.repository.ts) instead of one statement per unit.
 */
async function chartGroupedByOrgUnit(
  tenantId: string, year: number, metric: string, maxMonth: number,
  dimension: OrgChartDimension, parentId?: string,
): Promise<{ year: number; metric: string; data: ReportChartPoint[]; is_grouped: boolean }> {
  const entities = await loadOrgChartEntities(tenantId, dimension, parentId);
  const values = await loadOrgChartMonthValues({
    tenantId,
    metric,
    dimension,
    entityIds: entities.map((entity) => entity.id),
    year,
    yearStart: new Date(year, 0, 1),
    yearEnd: new Date(year, 11, 31, 23, 59, 59, 999),
  });
  return { year, metric, data: buildOrgUnitChartPoints(entities, values, maxMonth, MONTH_LABELS), is_grouped: true };
}

/**
 * BATCH: Calculate metric for all 12 months in 1 SQL query.
 * Returns Map<month_number, value>.
 */
async function batchMetricByMonth(
  tenantId: string, metric: string,
  yearStart: Date, yearEnd: Date, year: number,
  groupId?: string, subgroupId?: string,
): Promise<Map<number, number>> {
  const result = new Map<number, number>();
  const input = { tenantId, yearStart, yearEnd, year, groupId, subgroupId };

  switch (metric) {
    case 'total_learners': {
      // Cumulative: count users created before end of each month
      const rows = await chartRepository.selectYearLearnersByMonth(input);
      for (const row of rows) result.set(row.m, parseInt(row.cnt));
      break;
    }
    case 'active_learners': {
      const rows = await chartRepository.selectYearActiveLearnersByMonth(input);
      for (const row of rows) result.set(row.m, parseInt(row.cnt, 10));
      break;
    }
    case 'completion_rate': {
      const rows = await chartRepository.selectYearCompletionRateByMonth(input);
      for (const row of rows) result.set(row.m, parseFloat(row.completion_rate) || 0);
      break;
    }
    case 'total_enrollments': {
      const rows = await chartRepository.selectYearEnrollmentsByMonth(input);
      for (const row of rows) result.set(row.m, parseInt(row.cnt));
      break;
    }
  }

  return result;
}

/**
 * BATCH by Team: single SQL for all months, filtered by team_id.
 */
async function batchMetricByMonthTeam(
  tenantId: string, metric: string,
  yearStart: Date, yearEnd: Date, year: number,
  teamId: string,
): Promise<Map<number, number>> {
  const result = new Map<number, number>();
  const input = { tenantId, yearStart, yearEnd, year, teamId };

  switch (metric) {
    case 'total_learners': {
      const rows = await chartRepository.selectTeamYearLearnersByMonth(input);
      for (const row of rows) result.set(row.m, parseInt(row.cnt));
      break;
    }
    case 'active_learners': {
      const rows = await chartRepository.selectTeamYearActiveLearnersByMonth(input);
      for (const row of rows) result.set(row.m, parseInt(row.cnt, 10));
      break;
    }
    case 'completion_rate': {
      const rows = await chartRepository.selectYearCompletionRateByMonth(input);
      for (const row of rows) result.set(row.m, parseFloat(row.completion_rate) || 0);
      break;
    }
    case 'total_enrollments': {
      const rows = await chartRepository.selectTeamYearEnrollmentsByMonth(input);
      for (const row of rows) result.set(row.m, parseInt(row.cnt));
      break;
    }
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════
// Course Completion Ranking + Top Courses
// ═══════════════════════════════════════════════════════════════

/**
 * Compact, server-owned course portfolio for executive reporting. It uses the
 * same immutable enrollment cohort as the existing dashboard rankings.
 */
export async function getReportCoursePerformance(
  tenantId: string,
  pageSize = 20,
  month?: number,
  year?: number,
  groupId?: string,
  subgroupId?: string,
  teamId?: string,
  dateRange?: ReportDateRange,
): Promise<ReportCoursePerformance[]> {
  const safePageSize = Math.min(Math.max(pageSize, 1), 50);
  const range = getReportRange(month, year, dateRange);
  const portfolioCacheKey = cacheKey('reports', 'course-performance', 'v1', tenantId, stableHash({
    dateFrom: range.dateFrom,
    dateTo: range.dateTo,
    groupId,
    subgroupId,
    teamId,
    pageSize: safePageSize,
  }));

  return cachedReportAggregate(tenantId, portfolioCacheKey, getSummaryCacheTtl(range), async () => {
    const rows = await coursesRepository.selectCoursePerformance({
      tenantId, range, groupId, subgroupId, teamId, limit: safePageSize,
    });
    return rows.map((row) => ({
      course_id: row.course_id,
      name: row.name,
      total_enrollments: Number(row.total_enrollments) || 0,
      completed_enrollments: Number(row.completed_enrollments) || 0,
      incomplete_enrollments: Number(row.incomplete_enrollments) || 0,
      not_started_enrollments: Number(row.not_started_enrollments) || 0,
      in_progress_enrollments: Number(row.in_progress_enrollments) || 0,
      completion_rate: Number(row.completion_rate) || 0,
    }));
  });
}

/**
 * Number of distinct courses in the same enrollment cohort as
 * getReportCoursePerformance, so a capped course list can say how many
 * courses it leaves out.
 */
export async function getReportCourseCount(
  tenantId: string,
  groupId?: string,
  subgroupId?: string,
  teamId?: string,
  dateRange?: ReportDateRange,
): Promise<number> {
  const range = getReportRange(undefined, undefined, dateRange);
  const countCacheKey = cacheKey('reports', 'course-count', 'v1', tenantId, stableHash({
    dateFrom: range.dateFrom,
    dateTo: range.dateTo,
    groupId,
    subgroupId,
    teamId,
  }));

  return cachedReportAggregate(tenantId, countCacheKey, getSummaryCacheTtl(range), async () => {
    const row = await coursesRepository.selectCourseCount({ tenantId, range, groupId, subgroupId, teamId });
    return Number(row?.course_count) || 0;
  });
}

/**
 * Returns only report-course candidates from the same authorized enrollment
 * cohort used by the dashboard rankings. The caller must still resolve an
 * exact normalized title before selecting a course for a chat response.
 */
export async function findReportCoursePerformanceByName(
  tenantId: string,
  courseName: string,
  groupId?: string,
  subgroupId?: string,
  teamId?: string,
  dateRange?: ReportDateRange,
): Promise<ReportCoursePerformance[]> {
  const normalizedName = courseName.trim();
  if (!normalizedName) return [];

  const range = getReportRange(undefined, undefined, dateRange);
  const matchingCacheKey = cacheKey('reports', 'course-performance-match', 'v1', tenantId, stableHash({
    dateFrom: range.dateFrom,
    dateTo: range.dateTo,
    groupId,
    subgroupId,
    teamId,
    courseName: normalizedName.toLocaleLowerCase('vi-VN'),
  }));

  return cachedReportAggregate(tenantId, matchingCacheKey, getSummaryCacheTtl(range), async () => {
    const rows = await coursesRepository.selectCoursePerformanceByName({
      tenantId, range, groupId, subgroupId, teamId, courseName: normalizedName,
    });
    return rows.map(toReportCoursePerformance);
  });
}

function toReportCoursePerformance(row: CoursePerformanceRow): ReportCoursePerformance {
  return {
    course_id: row.course_id,
    name: row.name,
    total_enrollments: Number(row.total_enrollments) || 0,
    completed_enrollments: Number(row.completed_enrollments) || 0,
    incomplete_enrollments: Number(row.incomplete_enrollments) || 0,
    not_started_enrollments: Number(row.not_started_enrollments) || 0,
    in_progress_enrollments: Number(row.in_progress_enrollments) || 0,
    completion_rate: Number(row.completion_rate) || 0,
  };
}

/**
 * One course's figures in the same authorized enrollment cohort as the
 * dashboard rankings (tenant, org scope and period). Null when the course has
 * no enrollment in that cohort. The id comes from the tenant's own course
 * catalog, never from the model.
 */
export async function getReportCoursePerformanceById(
  tenantId: string,
  courseId: string,
  groupId?: string,
  subgroupId?: string,
  teamId?: string,
  dateRange?: ReportDateRange,
): Promise<ReportCoursePerformance | null> {
  const id = courseId.trim();
  if (!id) return null;

  const range = getReportRange(undefined, undefined, dateRange);
  const byIdCacheKey = cacheKey('reports', 'course-performance-by-id', 'v1', tenantId, stableHash({
    dateFrom: range.dateFrom,
    dateTo: range.dateTo,
    groupId,
    subgroupId,
    teamId,
    courseId: id,
  }));

  return cachedReportAggregate(tenantId, byIdCacheKey, getSummaryCacheTtl(range), async () => {
    const row = await coursesRepository.selectCoursePerformanceById({
      tenantId, range, groupId, subgroupId, teamId, courseId: id,
    });
    return row ? toReportCoursePerformance(row) : null;
  });
}

export async function getReportCompletionStatusDistribution(
  tenantId: string,
  month?: number,
  year?: number,
  groupId?: string,
  subgroupId?: string,
  teamId?: string,
  dateRange?: ReportDateRange,
): Promise<ReportCompletionStatusDistribution> {
  const range = getReportRange(month, year, dateRange);
  const cacheKeyValue = cacheKey('reports', 'completion-status', 'v1', tenantId, stableHash({
    dateFrom: range.dateFrom,
    dateTo: range.dateTo,
    groupId,
    subgroupId,
    teamId,
  }));
  return cachedReportAggregate(tenantId, cacheKeyValue, getSummaryCacheTtl(range), async () => {
    const row = await coursesRepository.selectCompletionStatusDistribution({ tenantId, range, groupId, subgroupId, teamId });
    return {
      not_started: Number(row?.not_started) || 0,
      in_progress: Number(row?.in_progress) || 0,
      completed: Number(row?.completed) || 0,
    };
  });
}

export async function getReportCourseCompletionRanking(
  tenantId: string,
  page = 1,
  pageSize = 10,
  month?: number,
  year?: number,
  groupId?: string,
  subgroupId?: string,
  teamId?: string,
  dateRange?: ReportDateRange,
): Promise<{ count: number; total_pages: number; current_page: number; results: ReportCourseCompletionRanking[] }> {
  const safePage = Math.max(page, 1);
  const safePageSize = Math.min(Math.max(pageSize, 1), 100);
  const range = getReportRange(month, year, dateRange);
  const rankingCacheKey = cacheKey('reports', 'course-ranking', 'v3', tenantId, stableHash({
    dateFrom: range.dateFrom,
    dateTo: range.dateTo,
    groupId,
    subgroupId,
    teamId,
    page: safePage,
    pageSize: safePageSize,
  }));
  return cachedReportAggregate(tenantId, rankingCacheKey, getSummaryCacheTtl(range), async () => {
    const rows = await coursesRepository.selectCourseCompletionRanking({
      tenantId, range, groupId, subgroupId, teamId, limit: safePageSize, offset: (safePage - 1) * safePageSize,
    });
    const total = parseInt(rows[0]?.full_count ?? '0', 10);
    return {
      count: total,
      total_pages: Math.ceil(total / safePageSize),
      current_page: safePage,
      results: rows.map(row => ({
        course_id: row.course_id,
        name: row.name,
        total_enrollments: Number(row.total_enrollments) || 0,
        completed_enrollments: Number(row.completed_enrollments) || 0,
        incomplete_enrollments: Number(row.incomplete_enrollments) || 0,
        completion_rate: Number(row.completion_rate) || 0,
      })),
    };
  });
}

export async function getReportCourseCompletionLearners(
  tenantId: string,
  courseId: string,
  page = 1,
  pageSize = 20,
  search?: string,
  month?: number,
  year?: number,
  groupId?: string,
  subgroupId?: string,
  teamId?: string,
  status: ReportCourseCompletionStatus = 'all',
  dateRange?: ReportDateRange,
): Promise<{ count: number; total_pages: number; current_page: number; results: ReportCourseCompletionLearner[] }> {
  const safePage = Math.max(page, 1);
  const safePageSize = Math.min(Math.max(pageSize, 1), 100);
  const range = getReportRange(month, year, dateRange);
  // Cached per tenant, course, period, org scope, page, search and status. The
  // key carries the tenant's course cache version: a course change shows at once.
  const coursesVersion = await getCacheVersion(...cacheVersions.tenantCourses(tenantId));
  const learnersCacheKey = cacheKeys.tenantResource(tenantId, 'report-course-learners', coursesVersion, {
    courseId,
    dateFrom: range.dateFrom,
    dateTo: range.dateTo,
    groupId,
    subgroupId,
    teamId,
    page: safePage,
    pageSize: safePageSize,
    search: search?.trim() ?? '',
    status,
  });
  return cachedReportAggregate(tenantId, learnersCacheKey, getReportListCacheTtl(range.dateTo), async () => {
    const rows = await coursesRepository.selectCourseCompletionLearners({
      tenantId,
      courseId,
      range,
      groupId,
      subgroupId,
      teamId,
      search,
      status,
      limit: safePageSize,
      offset: (safePage - 1) * safePageSize,
    });
    const total = parseInt(rows[0]?.full_count ?? '0', 10);
    return {
      count: total,
      total_pages: Math.ceil(total / safePageSize),
      current_page: safePage,
      results: rows.map(row => ({
        user_id: row.user_id,
        username: row.username,
        email: row.email,
        full_name: row.full_name || '',
        avatar: row.avatar,
        enrolled_at: row.enrolled_at,
        completed_at: row.completed_at,
        progress: row.progress === null || row.progress === undefined ? null : Number(row.progress),
        status: row.status,
      })),
    };
  });
}
export async function getReportTopCourses(
  tenantId: string,
  page = 1,
  pageSize = 10,
  month?: number,
  year?: number,
  groupId?: string,
  subgroupId?: string,
  teamId?: string,
  dateRange?: ReportDateRange,
): Promise<{ count: number; total_pages: number; current_page: number; results: ReportTopCourse[] }> {
  // Cached per tenant, period, org scope and page; the key carries the tenant's
  // course cache version (course names).
  const periodEnd = dateRange?.dateTo
    ?? (month && year ? getReportRange(month, year).dateTo : year ? `${year}-12-31` : null);
  const coursesVersion = await getCacheVersion(...cacheVersions.tenantCourses(tenantId));
  const topCoursesCacheKey = cacheKeys.tenantResource(tenantId, 'report-top-courses', coursesVersion, {
    page,
    pageSize,
    month,
    year,
    dateFrom: dateRange?.dateFrom,
    dateTo: dateRange?.dateTo,
    groupId,
    subgroupId,
    teamId,
  });
  return cachedReportAggregate(tenantId, topCoursesCacheKey, getReportListCacheTtl(periodEnd), async () => {
    const offset = (page - 1) * pageSize;
    // The period: the date range, else the month of the year, else the year; none means all time.
    const range = dateRange || (month && year) || year
      ? dateRange
        ?? (month && year
          ? getReportRange(month, year)
          : { startDate: new Date(year!, 0, 1), endDate: new Date(year!, 11, 31, 23, 59, 59, 999), dateFrom: `${year}-01-01`, dateTo: `${year}-12-31` })
      : undefined;
    const rows = await coursesRepository.selectTopCourses({
      tenantId, range, groupId, subgroupId, teamId, limit: pageSize, offset,
    });

    const total = parseInt(rows[0]?.full_count ?? '0');

    return {
      count: total,
      total_pages: Math.ceil(total / pageSize),
      current_page: page,
      results: rows.map(r => ({ course_id: r.course_id, name: r.name, enrollments: Number(r.enrollments) })),
    };
  });
}

// ═══════════════════════════════════════════════════════════════
// Report Learners — optimized with no N+1 subqueries
// ═══════════════════════════════════════════════════════════════

export async function getReportLearners(
  tenantId: string,
  page = 1,
  pageSize = 20,
  search?: string,
  month?: number,
  year?: number,
  groupId?: string,
  subgroupId?: string,
  teamId?: string,
  status?: 'all' | 'not_started' | 'learning' | 'completed',
  dateRange?: ReportDateRange,
): Promise<{ count: number; total_pages: number; current_page: number; results: ReportLearner[] }> {
  const safePage = Math.max(page, 1);
  const safePageSize = Math.min(Math.max(pageSize, 1), 100);
  const range = getReportRange(month, year, dateRange);
  // Cached per tenant, period, org scope, page, search and status.
  const learnersCacheKey = cacheKey('reports', 'learners', 'v1', tenantId, stableHash({
    dateFrom: range.dateFrom,
    dateTo: range.dateTo,
    groupId,
    subgroupId,
    teamId,
    page: safePage,
    pageSize: safePageSize,
    search: search?.trim() ?? '',
    status: status ?? null,
  }));
  return cachedReportAggregate(tenantId, learnersCacheKey, getReportListCacheTtl(range.dateTo), async () => {
  const cohort = buildReportEnrollmentCte({
    tenantParam: '$1',
    rangeStartParam: '$2',
    rangeEndParam: '$3',
    groupId,
    subgroupId,
    teamId,
    scopeParamStart: 4,
  });
  const roster = buildReportLearnerRosterCte({
    tenantParam: '$1',
    groupId,
    subgroupId,
    teamId,
    scopeParamStart: 4,
  });
  const params: any[] = [tenantId, range.startDate, range.endDate, ...cohort.params];
  let paramIdx = params.length + 1;
  const searchFilter = search?.trim()
    ? `(rl.username ILIKE '%' || $${paramIdx} || '%' OR rl.email ILIKE '%' || $${paramIdx} || '%' OR rl.full_name ILIKE '%' || $${paramIdx} || '%')`
    : '';
  if (search?.trim()) {
    params.push(search.trim());
    paramIdx++;
  }
  // A missing status never becomes the filter text 'undefined' (the controller refuses it).
  const safeStatus = status && ['all', 'not_started', 'learning', 'completed'].includes(status) ? status : 'all';
  const statusFilter = safeStatus === 'all' ? '' : `WHERE learner_status.status = '${safeStatus}'`;
  params.push(safePageSize, (safePage - 1) * safePageSize);

  const result = await reportsQuery<ReportLearner & { full_count: string }>(
    `WITH ${cohort.sql},
      ${roster.sql},
      learner_status AS (
        SELECT
          rl.user_id,
          rl.username,
          rl.email,
          rl.avatar_url AS avatar,
          MAX(re.completed_at) AS last_completion_at,
          COUNT(re.enrollment_id)::bigint AS enrolled_courses,
          COUNT(re.enrollment_id) FILTER (WHERE re.is_completed)::bigint AS completed_courses,
          COALESCE(ROUND(AVG(re.progress), 2), 0) AS completion_rate,
          CASE
            WHEN COALESCE(AVG(re.progress), 0) >= 100 THEN 'completed'
            WHEN COALESCE(AVG(re.progress), 0) > 0 THEN 'learning'
            ELSE 'not_started'
          END AS status
        FROM report_learners rl
        LEFT JOIN report_enrollments re ON re.user_id = rl.user_id
        ${searchFilter ? `WHERE ${searchFilter}` : ''}
        GROUP BY rl.user_id, rl.username, rl.email, rl.avatar_url
      )
     SELECT learner_status.*, COUNT(*) OVER() AS full_count
     FROM learner_status
     ${statusFilter}
     ORDER BY last_completion_at DESC NULLS LAST, username ASC
     LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    params,
  );
  const total = parseInt(result.rows[0]?.full_count ?? '0', 10);
  return {
    count: total,
    total_pages: Math.ceil(total / safePageSize),
    current_page: safePage,
    results: result.rows.map(row => ({
      username: row.username,
      email: row.email,
      avatar: row.avatar,
      last_completion_at: row.last_completion_at,
      completion_rate: Number(row.completion_rate) || 0,
      completed_courses: Number(row.completed_courses) || 0,
      enrolled_courses: Number(row.enrolled_courses) || 0,
      status: row.status,
    })),
  };
  });
}
// ═══════════════════════════════════════════════════════════════
// Learner Detail
// ═══════════════════════════════════════════════════════════════

async function getEnrollmentScopedLearnerDetailRows(options: {
  tenantId: string;
  userId: string;
  page: number;
  pageSize: number;
  search: string;
  status: ReportCourseCompletionStatus;
  dataScope: LearnerDetailDataScope;
  dateRange?: ReportDateRange;
  groupId?: string;
  subgroupId?: string;
  teamId?: string;
}): Promise<{ total_count: number; total_pages: number; current_page: number; results: LearnerDetailResult[] }> {
  const {
    tenantId, userId, page, pageSize, search, status, dataScope,
    dateRange, groupId, subgroupId, teamId,
  } = options;
  const safePage = Math.max(page, 1);
  const safePageSize = Math.min(Math.max(pageSize, 1), 100);
  const offset = (safePage - 1) * safePageSize;
  const params: any[] = [];
  let sourceCte: string;

  if (dataScope === 'report_filter') {
    if (!dateRange) return { total_count: 0, total_pages: 0, current_page: safePage, results: [] };
    const cohort = buildReportEnrollmentCte({
      tenantParam: '$1',
      rangeStartParam: '$2',
      rangeEndParam: '$3',
      groupId,
      subgroupId,
      teamId,
      scopeParamStart: 4,
    });
    params.push(tenantId, dateRange.startDate, dateRange.endDate, ...cohort.params, userId);
    const userParam = `$${params.length}`;
    sourceCte = `${cohort.sql},
      source_enrollments AS (
        SELECT DISTINCT ON (re.course_id)
          re.enrollment_id,
          re.course_id,
          re.course_name,
          re.enrolled_at,
          re.completed_at,
          re.is_completed,
          re.has_started,
          COALESCE(cp.progress, 0) AS progress
        FROM report_enrollments re
        LEFT JOIN course_progress cp ON cp.enrollment_id = re.enrollment_id
        WHERE re.user_id = ${userParam}
        ORDER BY re.course_id, re.enrolled_at DESC, re.enrollment_id DESC
      )`;
  } else {
    params.push(tenantId, userId);
    sourceCte = `source_enrollments AS (
      SELECT DISTINCT ON (e.course_id)
        e.id AS enrollment_id,
        e.course_id,
        COALESCE(c.display_name, 'Khóa học không còn hiển thị') AS course_name,
        e.enrolled_at,
        cp.completed_at,
        COALESCE(cp.progress, 0) AS progress,
        (
          COALESCE(cp.progress, 0) >= 100
          OR COALESCE(cp.is_completed, false) = true
        ) AS is_completed,
        (
          COALESCE(cp.progress, 0) > 0
          OR cp.completed_at IS NOT NULL
        ) AS has_started
      FROM enrollments e
      LEFT JOIN courses c ON c.id = e.course_id
      LEFT JOIN course_progress cp ON cp.enrollment_id = e.id
      WHERE e.tenant_id = $1
        AND e.user_id = $2
      ORDER BY e.course_id, e.enrolled_at DESC, e.id DESC
    )`;
  }

  let paramIdx = params.length + 1;
  const filters: string[] = [];
  if (search.trim()) {
    filters.push(`cr.course_name ILIKE '%' || $${paramIdx} || '%'`);
    params.push(search.trim());
    paramIdx++;
  }
  const safeStatus: ReportCourseCompletionStatus = ['all', 'not_started', 'learning', 'completed'].includes(status)
    ? status
    : 'all';
  if (safeStatus !== 'all') {
    filters.push(`cr.status = $${paramIdx}`);
    params.push(safeStatus);
    paramIdx++;
  }
  const whereSql = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  params.push(safePageSize, offset);

  const result = await reportsQuery<LearnerDetailResult & { full_count: string }>(
    `WITH ${sourceCte},
      course_rows AS (
        SELECT
          se.course_id,
          se.course_name,
          se.enrolled_at,
          se.completed_at,
          CASE
            WHEN se.is_completed THEN 100
            ELSE LEAST(se.progress, 99.99)
          END AS progress,
          se.is_completed,
          CASE
            WHEN se.is_completed THEN 'completed'
            WHEN se.has_started THEN 'learning'
            ELSE 'not_started'
          END AS status
        FROM source_enrollments se
      )
     SELECT cr.*, COUNT(*) OVER() AS full_count
     FROM course_rows cr
     ${whereSql}
     ORDER BY cr.enrolled_at DESC NULLS LAST, cr.course_name ASC, cr.course_id ASC
     LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    params,
  );

  const total = parseInt(result.rows[0]?.full_count ?? '0', 10);
  return {
    total_count: total,
    total_pages: Math.ceil(total / safePageSize),
    current_page: safePage,
    results: result.rows.map(row => ({
      course_id: row.course_id,
      course_name: row.course_name,
      enrolled_at: row.enrolled_at,
      completed_at: row.completed_at,
      progress: Number(row.progress) || 0,
      is_completed: Boolean(row.is_completed),
      status: row.status,
    })),
  };
}
export async function getLearnerDetail(
  tenantId: string,
  username: string,
  page = 1,
  pageSize = 10,
  search = '',
  groupId?: string,
  subgroupId?: string,
  teamId?: string,
  status: ReportCourseCompletionStatus = 'all',
  dataScope?: LearnerDetailDataScope,
  dateRange?: ReportDateRange,
): Promise<LearnerDetailResponse> {
  const safePage = Math.max(page, 1);
  const safePageSize = Math.min(Math.max(pageSize, 1), 100);
  const offset = (safePage - 1) * safePageSize;
  const snapshotEndDate = new Date();

  const userScope = dataScope
    ? buildLearnerScopeExists('u.id', groupId, subgroupId, teamId, 3)
    : { sql: '', params: [] as string[] };
  const userResult = await reportsQuery<{ id: string }>(
    `SELECT u.id
     FROM users u
     WHERE u.username = $1
       AND u.tenant_id = $2
       AND u.is_active = true
       AND u.role IN ('learner', 'learner_plus')
       ${userScope.sql}
     LIMIT 1`,
    [username, tenantId, ...userScope.params],
  );
  if (userResult.rowCount === 0) {
    return { username, groups: [], results: [], total_count: 0, total_pages: 0, current_page: safePage };
  }
  const userId = userResult.rows[0].id;

  // Groups
  const groupsResult = await reportsQuery<{ group_name: string; subgroup_name: string }>(
    `SELECT DISTINCT og.name AS group_name, sg.name AS subgroup_name
     FROM team_members tm
     JOIN teams t ON t.id = tm.team_id
     JOIN sub_groups sg ON sg.id = t.sub_group_id
     JOIN org_groups og ON og.id = sg.org_group_id
     WHERE tm.user_id = $1
       AND og.tenant_id = $2
     ORDER BY og.name, sg.name`,
    [userId, tenantId],
  );

  if (dataScope) {
    const scopedResult = await getEnrollmentScopedLearnerDetailRows({
      tenantId,
      userId,
      page: safePage,
      pageSize: safePageSize,
      search,
      status,
      dataScope,
      dateRange,
      groupId,
      subgroupId,
      teamId,
    });
    return { username, groups: groupsResult.rows, ...scopedResult };
  }
  const params: any[] = [tenantId, snapshotEndDate, userId];
  let paramIdx = 4;
  const visibilityFilters: string[] = ['AND u.id = $3'];

  if (teamId) {
    visibilityFilters.push(`AND t.id = $${paramIdx}`);
    params.push(teamId);
    paramIdx++;
  } else if (subgroupId) {
    visibilityFilters.push(`AND t.sub_group_id = $${paramIdx}`);
    params.push(subgroupId);
    paramIdx++;
  } else if (groupId) {
    visibilityFilters.push(`AND sg.org_group_id = $${paramIdx}`);
    params.push(groupId);
    paramIdx++;
  }

  if (search.trim()) {
    visibilityFilters.push(`AND c.display_name ILIKE '%' || $${paramIdx} || '%'`);
    params.push(search.trim());
    paramIdx++;
  }

  const safeStatus: ReportCourseCompletionStatus = ['all', 'not_started', 'learning', 'completed'].includes(status)
    ? status
    : 'all';
  let statusFilter = '';
  if (safeStatus !== 'all') {
    statusFilter = `WHERE sub.status = $${paramIdx}`;
    params.push(safeStatus);
    paramIdx++;
  }

  params.push(safePageSize, offset);
  const result = await reportsQuery<LearnerDetailResult & { full_count: string }>(
    `WITH
      ${buildVisibleCourseUsersCte({
        tenantParam: '$1',
        snapshotParam: '$2',
        extraFilterSql: visibilityFilters.join('\n'),
      })},
      active_enrollments AS (
        SELECT DISTINCT ON (e.course_id)
          e.id,
          e.course_id,
          e.enrolled_at
        FROM enrollments e
        WHERE e.tenant_id = $1
          AND e.user_id = $3
          AND e.is_active = true
          AND e.enrolled_at <= $2
        ORDER BY e.course_id, e.enrolled_at DESC, e.id DESC
      ),
      learner_courses AS (
        SELECT
          v.course_id,
          v.name AS course_name,
          ae.enrolled_at,
          cp.completed_at,
          (
            ae.id IS NOT NULL
            AND (
              COALESCE(cp.progress, 0) >= 100
              OR COALESCE(cp.is_completed, false) = true
            )
            AND (cp.completed_at IS NULL OR cp.completed_at <= $2)
          ) AS is_completed,
          CASE
            WHEN ae.id IS NULL THEN 'not_started'
            WHEN (
              COALESCE(cp.progress, 0) >= 100
              OR COALESCE(cp.is_completed, false) = true
            ) AND (cp.completed_at IS NULL OR cp.completed_at <= $2) THEN 'completed'
            ELSE 'learning'
          END AS status,
          CASE
            WHEN ae.id IS NULL THEN 0
            WHEN (
              COALESCE(cp.progress, 0) >= 100
              OR COALESCE(cp.is_completed, false) = true
            ) AND (cp.completed_at IS NULL OR cp.completed_at <= $2) THEN 100
            ELSE LEAST(COALESCE(cp.progress, 0), 99.99)
          END AS progress
        FROM visible_course_users v
        LEFT JOIN active_enrollments ae ON ae.course_id = v.course_id
        LEFT JOIN course_progress cp ON cp.enrollment_id = ae.id
      )
     SELECT sub.*, COUNT(*) OVER() AS full_count
     FROM learner_courses sub
     ${statusFilter}
     ORDER BY
       CASE sub.status
         WHEN 'completed' THEN 1
         WHEN 'learning' THEN 2
         ELSE 3
       END,
       sub.enrolled_at DESC NULLS LAST,
       sub.course_name ASC,
       sub.course_id ASC
     LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    params,
  );

  const total = parseInt(result.rows[0]?.full_count ?? '0');

  return {
    username,
    groups: groupsResult.rows,
    results: result.rows.map(r => ({
      course_id: r.course_id,
      course_name: r.course_name,
      enrolled_at: r.enrolled_at,
      completed_at: r.completed_at,
      progress: Number(r.progress) || 0,
      is_completed: Boolean(r.is_completed),
      status: r.status,
    })),
    total_count: total,
    total_pages: Math.ceil(total / safePageSize),
    current_page: safePage,
  };
}

// ═══════════════════════════════════════════════════════════════
// User Badges
// ═══════════════════════════════════════════════════════════════

type UserBadgeRow = { badge_id: string; earned_at: string; name_override: string | null };

/** Badges of one learner; name_override is the tenant's own display name for the badge, if it set one. */
export async function getUserBadges(
  username: string,
  tenantId: string,
): Promise<{ username: string; badges: UserBadgeRow[] }> {
  const result = await reportsQuery<UserBadgeRow>(
    `SELECT ub.badge_id, ub.earned_at, NULLIF(BTRIM(tbs.name_override), '') AS name_override
     FROM user_badges ub
     JOIN users u ON u.id = ub.user_id
     LEFT JOIN tenant_badge_settings tbs ON tbs.tenant_id = u.tenant_id AND tbs.badge_id = ub.badge_id
     WHERE u.username = $1 AND u.tenant_id = $2
     ORDER BY ub.earned_at DESC`,
    [username, tenantId],
  );

  return { username, badges: result.rows };
}

// ═══════════════════════════════════════════════════════════════
// User Study Time
// ═══════════════════════════════════════════════════════════════

type UserStudyTimeOptions = { from?: string; to?: string; granularity?: StudyTimeGranularity };
type UserStudyTimeResponse = { username: string; entries: Array<{ date: string; minutes: number }>; meta: StudyTimeSeriesResponse['meta'] };

/** The answer for a learner that is unknown (or outside the caller's report scope). */
export function emptyUserStudyTime(username: string, options: UserStudyTimeOptions = {}): UserStudyTimeResponse {
  return {
    username,
    entries: [],
    meta: {
      from: options.from || '',
      to: options.to || '',
      granularity: options.granularity || 'day',
      requested_granularity: options.granularity || 'day',
      default_weekly: !options.from && !options.to && !options.granularity,
      point_count: 0,
      reduced_granularity: false,
    },
  };
}

export async function getUserStudyTime(
  username: string,
  tenantId: string,
  options: UserStudyTimeOptions = {},
): Promise<UserStudyTimeResponse> {
  const userResult = await reportsQuery<{ id: string }>(
    `SELECT id FROM users WHERE username = $1 AND tenant_id = $2 LIMIT 1`,
    [username, tenantId],
  );

  if (userResult.rowCount === 0) return emptyUserStudyTime(username, options);

  const series = await getStudyTimeSeries(userResult.rows[0].id, tenantId, options);

  return {
    username,
    entries: series.entries,
    meta: series.meta,
  };
}

// ═══════════════════════════════════════════════════════════════
// Refresh Materialized View
// ═══════════════════════════════════════════════════════════════

/** A failure reaches the caller: POST /api/reports/refresh answers it as an error. */
export async function refreshReportSummary(): Promise<void> {
  await reportsQuery('SELECT refresh_report_summary()', []);
}
