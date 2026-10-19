// ═══════════════════════════════════════════════════════════════
// Report periods: the month or date range a report reads, the chart
// granularity and the chart window. Pure; moved unchanged from
// reports.service.ts.
// ═══════════════════════════════════════════════════════════════

import { resolveAutoReportBucket } from './report-buckets.logic.js';
import type { GroupedEnrollmentDimension } from './report-chart.repository.js';
import type {
  ReportChartGranularity,
  EffectiveChartGranularity,
  ReportChartWindowOptions,
  ReportChartWindowMeta,
  ReportDateRange,
} from './report-results.types.js';

export const MONTH_LABELS = [
  '', 'Tháng 1', 'Tháng 2', 'Tháng 3', 'Tháng 4', 'Tháng 5', 'Tháng 6',
  'Tháng 7', 'Tháng 8', 'Tháng 9', 'Tháng 10', 'Tháng 11', 'Tháng 12',
];

const DEFAULT_CHART_WINDOW_BUCKETS = 72;
const MIN_CHART_WINDOW_BUCKETS = 12;
const MAX_CHART_WINDOW_BUCKETS = 120;
export const DEFAULT_GROUP_SERIES_LIMIT = 8;
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

export function clampSeriesLimit(value?: number): number {
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

export function resolveChartWindow(
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
export type DateRangeChartShape =
  | { kind: 'simple' }
  | { kind: 'grouped'; dimension: GroupedEnrollmentDimension; parentId?: string; seriesLimit: number };

export function resolveDateRangeChartShape(options: {
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

function getMonthRange(year: number, month: number): { startDate: Date; endDate: Date } {
  const startDate = new Date(year, month - 1, 1);
  const endDate = new Date(year, month, 0, 23, 59, 59, 999);
  return { startDate, endDate };
}

export function getReportRange(month?: number, year?: number, dateRange?: ReportDateRange): ReportDateRange {
  if (dateRange) return dateRange;

  const now = new Date();
  const targetMonth = month ?? (now.getMonth() + 1);
  const targetYear = year ?? now.getFullYear();
  const { startDate, endDate } = getMonthRange(targetYear, targetMonth);
  const dateFrom = `${targetYear}-${String(targetMonth).padStart(2, '0')}-01`;
  const dateTo = `${targetYear}-${String(targetMonth).padStart(2, '0')}-${String(endDate.getDate()).padStart(2, '0')}`;
  return { startDate, endDate, dateFrom, dateTo };
}

export function getRangeLabel(range: ReportDateRange): string {
  if (range.dateFrom === range.dateTo) return range.dateFrom;
  return `${range.dateFrom} đến ${range.dateTo}`;
}

function getRangeDayCount(range: ReportDateRange): number {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.max(1, Math.ceil((range.endDate.getTime() - range.startDate.getTime() + 1) / msPerDay));
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
export function resolveChartGranularity(range: ReportDateRange, requested: ReportChartGranularity = 'auto'): EffectiveChartGranularity {
  const days = getRangeDayCount(range);
  if (requested === 'day' && days <= 366) return 'day';
  if (requested === 'week' && days <= 1095) return 'week';
  if (requested === 'month') return 'month';
  return resolveAutoReportBucket(days);
}
