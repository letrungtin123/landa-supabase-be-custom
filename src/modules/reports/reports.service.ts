// ═══════════════════════════════════════════════════════════════
// Reports Service — Analytics & Dashboard data
// Optimized for millions of rows:
//   - Chart: single batch SQL per metric (not N×12 queries)
//   - Composite indexes for all hot paths
//   - No N+1 subqueries
// ═══════════════════════════════════════════════════════════════

import { cacheJson, cacheKey, stableHash } from '../../config/cache.js';
import { query } from '../../config/database.js';
import { getStudyTimeSeries, type StudyTimeGranularity, type StudyTimeSeriesResponse } from '../enrollments/enrollments.service.js';

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

function buildReportChartCacheKey(options: {
  tenantId: string;
  metric: string;
  range: ReportDateRange;
  granularity: EffectiveChartGranularity;
  groupId?: string;
  subgroupId?: string;
  teamId?: string;
  groupByOrg: boolean;
  grouped: boolean;
  seriesLimit: number;
}): string {
  return cacheKey('reports', 'chart', 'v8', options.tenantId, stableHash({
    metric: options.metric,
    dateFrom: options.range.dateFrom,
    dateTo: options.range.dateTo,
    granularity: options.granularity,
    groupId: options.groupId,
    subgroupId: options.subgroupId,
    teamId: options.teamId,
    groupByOrg: options.groupByOrg,
    grouped: options.grouped,
    seriesLimit: options.seriesLimit,
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
  return cacheKey('reports', 'summary', 'v6', options.tenantId, stableHash({
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

function getSnapshotEndDate(month?: number, year?: number, dateRange?: ReportDateRange): Date {
  if (dateRange) return dateRange.endDate;
  if (month && year) return getMonthRange(year, month).endDate;
  if (year) return new Date(year, 11, 31, 23, 59, 59, 999);
  return new Date();
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

function getSummaryCacheTtl(range: ReportDateRange): number {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
  return range.dateTo >= today ? 30 : 300;
}

function resolveChartGranularity(range: ReportDateRange, requested: ReportChartGranularity = 'auto'): EffectiveChartGranularity {
  const days = getRangeDayCount(range);
  if (requested === 'day' && days <= 366) return 'day';
  if (requested === 'week' && days <= 1095) return 'week';
  if (requested === 'month') return 'month';
  if (days <= 31) return 'day';
  return 'month';
}

function getGranularityStep(granularity: EffectiveChartGranularity): string {
  if (granularity === 'day') return '1 day';
  if (granularity === 'week') return '1 week';
  return '1 month';
}

function getBucketLabelSql(alias = 'b.bucket_start'): string {
  return `CASE
    WHEN $4 = 'day' THEN to_char(${alias}, 'DD/MM/YYYY')
    WHEN $4 = 'week' THEN 'Tuần ' || to_char(${alias}, 'IW/YYYY')
    ELSE 'Tháng ' || EXTRACT(MONTH FROM ${alias})::int || '/' || EXTRACT(YEAR FROM ${alias})::int
  END`;
}

function getBucketCteSql(): string {
  return `bounds AS (
      SELECT
        date_trunc($4, $2::timestamptz AT TIME ZONE 'Asia/Ho_Chi_Minh') AS bucket_start,
        date_trunc($4, $3::timestamptz AT TIME ZONE 'Asia/Ho_Chi_Minh') AS bucket_end
    ),
    buckets AS (
      SELECT generate_series(bucket_start, bucket_end, $5::interval) AS bucket_start
      FROM bounds
    )`;
}

function buildGroupFilter(groupId?: string, subgroupId?: string, teamId?: string): { joins: string; conditions: string[]; params: any[] } {
  const joins: string[] = [];
  const conditions: string[] = [];
  const params: any[] = [];

  if (teamId) {
    joins.push('JOIN team_members tm ON tm.user_id = e.user_id');
    conditions.push(`tm.team_id = $PARAM`);
    params.push(teamId);
  } else if (subgroupId) {
    joins.push('JOIN team_members tm ON tm.user_id = e.user_id');
    joins.push('JOIN teams t ON t.id = tm.team_id');
    conditions.push(`t.sub_group_id = $PARAM`);
    params.push(subgroupId);
  } else if (groupId) {
    joins.push('JOIN team_members tm ON tm.user_id = e.user_id');
    joins.push('JOIN teams t ON t.id = tm.team_id');
    joins.push('JOIN sub_groups sg ON sg.id = t.sub_group_id');
    conditions.push(`sg.org_group_id = $PARAM`);
    params.push(groupId);
  }

  return { joins: joins.join(' '), conditions, params };
}

function buildUserGroupFilter(groupId?: string, subgroupId?: string, teamId?: string): { joins: string; conditions: string[]; params: any[] } {
  const joins: string[] = [];
  const conditions: string[] = [];
  const params: any[] = [];

  if (teamId) {
    joins.push('JOIN team_members tm ON tm.user_id = u.id');
    conditions.push(`tm.team_id = $PARAM`);
    params.push(teamId);
  } else if (subgroupId) {
    joins.push('JOIN team_members tm ON tm.user_id = u.id');
    joins.push('JOIN teams t ON t.id = tm.team_id');
    conditions.push(`t.sub_group_id = $PARAM`);
    params.push(subgroupId);
  } else if (groupId) {
    joins.push('JOIN team_members tm ON tm.user_id = u.id');
    joins.push('JOIN teams t ON t.id = tm.team_id');
    joins.push('JOIN sub_groups sg ON sg.id = t.sub_group_id');
    conditions.push(`sg.org_group_id = $PARAM`);
    params.push(groupId);
  }

  return { joins: joins.join(' '), conditions, params };
}

export function buildLearnerScopeExists(
  userIdSql: string,
  groupId: string | undefined,
  subgroupId: string | undefined,
  teamId: string | undefined,
  startParamIndex: number,
): { sql: string; params: string[] } {
  if (teamId) {
    return {
      sql: `AND EXISTS (
        SELECT 1 FROM team_members tm_scope
        WHERE tm_scope.user_id = ${userIdSql}
          AND tm_scope.team_id = $${startParamIndex}
      )`,
      params: [teamId],
    };
  }

  if (subgroupId) {
    return {
      sql: `AND EXISTS (
        SELECT 1
        FROM team_members tm_scope
        JOIN teams t_scope ON t_scope.id = tm_scope.team_id
        WHERE tm_scope.user_id = ${userIdSql}
          AND t_scope.sub_group_id = $${startParamIndex}
      )`,
      params: [subgroupId],
    };
  }

  if (groupId) {
    return {
      sql: `AND EXISTS (
        SELECT 1
        FROM team_members tm_scope
        JOIN teams t_scope ON t_scope.id = tm_scope.team_id
        JOIN sub_groups sg_scope ON sg_scope.id = t_scope.sub_group_id
        WHERE tm_scope.user_id = ${userIdSql}
          AND sg_scope.org_group_id = $${startParamIndex}
      )`,
      params: [groupId],
    };
  }

  return { sql: '', params: [] };
}

/**
 * Returns one logical learning-activity event per learner and Vietnam-local day.
 * Keep this CTE shared by UI charts and Excel so the metric cannot silently drift.
 */
export function buildActiveLearnerEventsCte(options: {
  tenantParam: string;
  rangeStartParam: string;
  rangeEndParam: string;
  cteName?: string;
}): string {
  const { tenantParam, rangeStartParam, rangeEndParam, cteName = 'active_learner_events' } = options;
  const startDateSql = `(${rangeStartParam}::timestamptz AT TIME ZONE 'Asia/Ho_Chi_Minh')::date`;
  const endDateSql = `(${rangeEndParam}::timestamptz AT TIME ZONE 'Asia/Ho_Chi_Minh')::date`;

  return `${cteName} AS (
    SELECT ss.user_id, ss.study_date AS activity_date
    FROM study_sessions ss
    WHERE ss.tenant_id = ${tenantParam}
      AND COALESCE(ss.duration_minutes, 0) > 0
      AND ss.study_date >= ${startDateSql}
      AND ss.study_date <= ${endDateSql}

    UNION

    SELECT e.user_id, (bc.completed_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS activity_date
    FROM block_completions bc
    JOIN enrollments e ON e.id = bc.enrollment_id
    WHERE e.tenant_id = ${tenantParam}
      AND bc.completed_at >= ${rangeStartParam}
      AND bc.completed_at <= ${rangeEndParam}
  )`;
}

/**
 * Returns the immutable report cohort: active learner enrollments created in the selected period.
 * Every course-completion metric must use this CTE so cards, lists, rankings, charts, and Excel reconcile.
 */
export function buildReportEnrollmentCte(options: {
  tenantParam: string;
  rangeStartParam: string;
  rangeEndParam: string;
  groupId?: string;
  subgroupId?: string;
  teamId?: string;
  scopeParamStart: number;
  cteName?: string;
}): { sql: string; params: string[] } {
  const {
    tenantParam,
    rangeStartParam,
    rangeEndParam,
    groupId,
    subgroupId,
    teamId,
    scopeParamStart,
    cteName = 'report_enrollments',
  } = options;
  const scope = buildLearnerScopeExists('e.user_id', groupId, subgroupId, teamId, scopeParamStart);

  return {
    params: scope.params,
    sql: `${cteName} AS (
      SELECT
        e.id AS enrollment_id,
        e.user_id,
        e.course_id,
        e.enrolled_at,
        COALESCE(c.display_name, 'Khóa học không còn hiển thị') AS course_name,
        CASE
          WHEN cp.completed_at IS NOT NULL AND cp.completed_at <= ${rangeEndParam} THEN 100
          ELSE LEAST(GREATEST(COALESCE(cp.progress, 0), 0), 99.99)
        END AS progress,
        CASE
          WHEN cp.completed_at IS NOT NULL AND cp.completed_at <= ${rangeEndParam} THEN cp.completed_at
          ELSE NULL
        END AS completed_at,
        CASE
          WHEN cp.completed_at IS NOT NULL AND cp.completed_at <= ${rangeEndParam} THEN true
          ELSE false
        END AS is_completed,
        CASE
          WHEN COALESCE(cp.progress, 0) > 0 OR cp.completed_at IS NOT NULL THEN true
          ELSE false
        END AS has_started
      FROM enrollments e
      JOIN users u ON u.id = e.user_id
        AND u.tenant_id = ${tenantParam}
        AND u.is_active = true
        AND u.role IN ('learner', 'learner_plus')
      LEFT JOIN courses c ON c.id = e.course_id
      LEFT JOIN course_progress cp ON cp.enrollment_id = e.id
      WHERE e.tenant_id = ${tenantParam}
        AND e.is_active = true
        AND e.enrolled_at >= ${rangeStartParam}
        AND e.enrolled_at <= ${rangeEndParam}
        ${scope.sql}
    )`,
  };
}
export function buildReportLearnerRosterCte(options: {
  tenantParam: string;
  groupId?: string;
  subgroupId?: string;
  teamId?: string;
  scopeParamStart: number;
  cteName?: string;
}): { sql: string; params: string[] } {
  const {
    tenantParam,
    groupId,
    subgroupId,
    teamId,
    scopeParamStart,
    cteName = 'report_learners',
  } = options;
  const scope = buildLearnerScopeExists('u.id', groupId, subgroupId, teamId, scopeParamStart);

  return {
    params: scope.params,
    sql: `${cteName} AS (
      SELECT
        u.id AS user_id,
        u.username,
        u.email,
        u.full_name,
        u.avatar_url
      FROM users u
      WHERE u.tenant_id = ${tenantParam}
        AND u.is_active = true
        AND u.role IN ('learner', 'learner_plus')
        ${scope.sql}
    )`,
  };
}
function buildVisibleCourseUsersCte(options: {
  tenantParam: string;
  snapshotParam: string;
  extraFilterSql?: string;
}): string {
  const { tenantParam, snapshotParam, extraFilterSql = '' } = options;
  const learnerWhere = `
    u.tenant_id = ${tenantParam}
    AND u.is_active = true
    AND u.role IN ('learner', 'learner_plus')
    AND u.created_at <= ${snapshotParam}
  `;
  const courseWhere = `
    c.tenant_id = ${tenantParam}
    AND c.deleted_at IS NULL
    AND c.visible_to_staff_only = false
    AND c.created_at <= ${snapshotParam}
    ${extraFilterSql}
  `;
  const assignedWhere = `
    ${learnerWhere}
    AND og.tenant_id = ${tenantParam}
    AND ${courseWhere}
  `;
  const publicWhere = `
    ${learnerWhere}
    AND ${courseWhere}
    AND EXISTS (
      SELECT 1
      FROM course_category_courses ccc_public
      JOIN course_categories cc_public ON cc_public.id = ccc_public.category_id
      WHERE ccc_public.course_id = c.id
        AND cc_public.tenant_id = c.tenant_id
        AND COALESCE(cc_public.is_public, false) = true
    )
  `;

  return `
    visible_course_users AS (
      SELECT u.id AS user_id, c.id AS course_id, c.display_name AS name
      FROM users u
      JOIN team_members tm ON tm.user_id = u.id
      JOIN teams t ON t.id = tm.team_id
      JOIN sub_groups sg ON sg.id = t.sub_group_id
      JOIN org_groups og ON og.id = sg.org_group_id
      JOIN team_courses tc ON tc.team_id = t.id
      JOIN courses c ON c.id = tc.course_id
      WHERE ${assignedWhere}

      UNION

      SELECT u.id AS user_id, c.id AS course_id, c.display_name AS name
      FROM users u
      JOIN team_members tm ON tm.user_id = u.id
      JOIN teams t ON t.id = tm.team_id
      JOIN sub_groups sg ON sg.id = t.sub_group_id
      JOIN org_groups og ON og.id = sg.org_group_id
      JOIN team_course_categories tcc ON tcc.team_id = t.id
      JOIN course_category_courses ccc ON ccc.category_id = tcc.category_id
      JOIN courses c ON c.id = ccc.course_id
      WHERE ${assignedWhere}

      UNION

      SELECT u.id AS user_id, c.id AS course_id, c.display_name AS name
      FROM users u
      LEFT JOIN team_members tm ON tm.user_id = u.id
      LEFT JOIN teams t ON t.id = tm.team_id
      LEFT JOIN sub_groups sg ON sg.id = t.sub_group_id
      LEFT JOIN org_groups og ON og.id = sg.org_group_id
      JOIN courses c ON c.tenant_id = ${tenantParam}
      WHERE ${publicWhere}
    )
  `;
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

  return cacheJson(summaryCacheKey, getSummaryCacheTtl(range), () => getReportSummaryForRange({
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
  const learnerScope = buildLearnerScopeExists('u.id', groupId, subgroupId, teamId, 4);
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

  const result = await query<{
    total_learners: string;
    active_learners: string;
    total_enrollments: string;
    completed_enrollments: string;
    incomplete_enrollments: string;
    completion_rate: string;
  }>(
    `WITH ${buildActiveLearnerEventsCte({
      tenantParam: '$1',
      rangeStartParam: '$2',
      rangeEndParam: '$3',
    })},
    ${cohort.sql},
    ${roster.sql},
    learner_completion AS (
      SELECT
        rl.user_id,
        COUNT(re.enrollment_id)::bigint AS total_enrollments,
        COUNT(re.enrollment_id) FILTER (WHERE re.is_completed)::bigint AS completed_enrollments,
        COALESCE(ROUND(AVG(re.progress), 2), 0) AS completion_rate
      FROM report_learners rl
      LEFT JOIN report_enrollments re ON re.user_id = rl.user_id
      GROUP BY rl.user_id
    )
    SELECT
      (
        SELECT COUNT(*)
        FROM users u
        WHERE u.tenant_id = $1
          AND u.is_active = true
          AND u.role IN ('learner', 'learner_plus')
          AND u.created_at >= $2
          AND u.created_at <= $3
          ${learnerScope.sql}
      )::bigint AS total_learners,
      (
        SELECT COUNT(DISTINCT ae.user_id)
        FROM active_learner_events ae
        JOIN users u ON u.id = ae.user_id
        WHERE u.tenant_id = $1
          AND u.is_active = true
          AND u.role IN ('learner', 'learner_plus')
          ${learnerScope.sql}
      )::bigint AS active_learners,
      COALESCE(SUM(lc.total_enrollments), 0)::bigint AS total_enrollments,
      COALESCE(SUM(lc.completed_enrollments), 0)::bigint AS completed_enrollments,
      COALESCE(SUM(lc.total_enrollments - lc.completed_enrollments), 0)::bigint AS incomplete_enrollments,
      COALESCE(ROUND(AVG(lc.completion_rate), 2), 0) AS completion_rate
    FROM learner_completion lc`,
    [tenantId, range.startDate, range.endDate, ...cohort.params],
  );

  const row = result.rows[0];
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
    const chartCacheKey = buildReportChartCacheKey({
      tenantId,
      metric,
      range: queryRange,
      granularity,
      groupId,
      subgroupId,
      teamId,
      groupByOrg,
      grouped,
      seriesLimit,
    });
    const result = await cacheJson(chartCacheKey, 90, () => chartByDateRange(
      tenantId,
      metric,
      queryRange,
      granularity,
      groupId,
      subgroupId,
      teamId,
      groupByOrg,
      grouped,
      seriesLimit,
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

  if (teamId) {
    return chartSimple(tenantId, year, metric, maxMonth, groupId, subgroupId, teamId);
  }
  if (groupByOrg) {
    return chartGroupedByOrg(tenantId, year, metric, maxMonth, groupId);
  }
  if (subgroupId && grouped) {
    return chartGroupedByTeam(tenantId, year, metric, maxMonth, subgroupId);
  }
  if (groupId && grouped) {
    return chartGroupedBySubGroup(tenantId, year, metric, maxMonth, groupId);
  }

  return chartSimple(tenantId, year, metric, maxMonth, groupId, subgroupId, teamId);
}

async function chartByDateRange(
  tenantId: string,
  metric: string,
  range: ReportDateRange,
  granularity: EffectiveChartGranularity,
  groupId?: string,
  subgroupId?: string,
  teamId?: string,
  groupByOrg = false,
  grouped = true,
  seriesLimit = DEFAULT_GROUP_SERIES_LIMIT,
): Promise<{ data: ReportChartPoint[]; is_grouped: boolean; series_overflow?: boolean }> {
  if (!teamId && metric === 'total_enrollments') {
    if (groupByOrg) return chartGroupedEnrollmentsByRange(tenantId, range, granularity, 'group', groupId, seriesLimit);
    if (subgroupId && grouped) return chartGroupedEnrollmentsByRange(tenantId, range, granularity, 'team', subgroupId, seriesLimit);
    if (groupId && grouped) return chartGroupedEnrollmentsByRange(tenantId, range, granularity, 'subgroup', groupId, seriesLimit);
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
  const step = getGranularityStep(granularity);
  const labelSql = getBucketLabelSql();
  const scopeAlias = metric === 'total_learners' || metric === 'active_learners' ? 'u.id' : 'e.user_id';
  const scope = buildLearnerScopeExists(scopeAlias, groupId, subgroupId, teamId, 6);
  const params: any[] = [tenantId, range.startDate, range.endDate, granularity, step, ...scope.params];

  let sql: string;
  if (metric === 'total_learners') {
    sql = `WITH ${getBucketCteSql()},
      created_by_bucket AS (
        SELECT
          date_trunc($4, u.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh') AS bucket_start,
          COUNT(*)::bigint AS value
        FROM users u
        WHERE u.tenant_id = $1
          AND u.is_active = true
          AND u.role IN ('learner', 'learner_plus')
          AND u.created_at >= $2
          AND u.created_at <= $3
          ${scope.sql}
        GROUP BY bucket_start
      )
      SELECT
        to_char(b.bucket_start, 'YYYY-MM-DD') AS bucket,
        ${labelSql} AS bucket_label,
        COALESCE(cbb.value, 0)::bigint AS value
      FROM buckets b
      LEFT JOIN created_by_bucket cbb ON cbb.bucket_start = b.bucket_start
      ORDER BY b.bucket_start`;
  } else if (metric === 'active_learners') {
    sql = `WITH ${getBucketCteSql()},
      ${buildActiveLearnerEventsCte({
        tenantParam: '$1',
        rangeStartParam: '$2',
        rangeEndParam: '$3',
      })},
      active_by_bucket AS (
        SELECT
          date_trunc($4, ae.activity_date::timestamp) AS bucket_start,
          COUNT(DISTINCT ae.user_id)::bigint AS value
        FROM active_learner_events ae
        JOIN users u ON u.id = ae.user_id
        WHERE u.tenant_id = $1
          AND u.is_active = true
          AND u.role IN ('learner', 'learner_plus')
          ${scope.sql}
        GROUP BY bucket_start
      )
      SELECT
        to_char(b.bucket_start, 'YYYY-MM-DD') AS bucket,
        ${labelSql} AS bucket_label,
        COALESCE(abb.value, 0)::bigint AS value
      FROM buckets b
      LEFT JOIN active_by_bucket abb ON abb.bucket_start = b.bucket_start
      ORDER BY b.bucket_start`;
  } else {
    const cohort = buildReportEnrollmentCte({
      tenantParam: '$1',
      rangeStartParam: '$2',
      rangeEndParam: '$3',
      groupId,
      subgroupId,
      teamId,
      scopeParamStart: 6,
    });
    const roster = buildReportLearnerRosterCte({
      tenantParam: '$1',
      groupId,
      subgroupId,
      teamId,
      scopeParamStart: 6,
    });

    sql = `WITH ${getBucketCteSql()},
      ${cohort.sql},
      ${roster.sql},
      roster_size AS (
        SELECT COUNT(*)::numeric AS learner_count
        FROM report_learners
      ),
      learner_bucket_completion AS (
        SELECT
          date_trunc($4, re.enrolled_at AT TIME ZONE 'Asia/Ho_Chi_Minh') AS bucket_start,
          re.user_id,
          COUNT(*)::bigint AS total_enrollments,
          COALESCE(ROUND(AVG(re.progress), 2), 0) AS completion_rate
        FROM report_enrollments re
        GROUP BY bucket_start, re.user_id
      ),
      aggregated AS (
        SELECT
          bucket_start,
          ${metric === 'completion_rate'
            ? "COALESCE(ROUND(SUM(completion_rate) / NULLIF((SELECT learner_count FROM roster_size), 0), 2), 0) AS value"
            : 'SUM(total_enrollments)::bigint AS value'}
        FROM learner_bucket_completion
        GROUP BY bucket_start
      )
      SELECT
        to_char(b.bucket_start, 'YYYY-MM-DD') AS bucket,
        ${labelSql} AS bucket_label,
        COALESCE(a.value, 0) AS value
      FROM buckets b
      LEFT JOIN aggregated a ON a.bucket_start = b.bucket_start
      ORDER BY b.bucket_start`;
    params.splice(5, scope.params.length, ...cohort.params);
  }

  const result = await query<{ bucket: string; bucket_label: string; value: string }>(sql, params);
  return result.rows.map(row => ({
    month: row.bucket,
    month_label: row.bucket_label,
    bucket: row.bucket,
    bucket_label: row.bucket_label,
    value: metric === 'completion_rate'
      ? parseFloat(row.value ?? '0')
      : parseInt(row.value ?? '0', 10),
  }));
}
type GroupedEnrollmentDimension = 'group' | 'subgroup' | 'team';

async function chartGroupedEnrollmentsByRange(
  tenantId: string,
  range: ReportDateRange,
  granularity: EffectiveChartGranularity,
  dimension: GroupedEnrollmentDimension,
  parentId?: string,
  seriesLimit = DEFAULT_GROUP_SERIES_LIMIT,
): Promise<{ data: ReportChartPoint[]; is_grouped: boolean; series_overflow?: boolean }> {
  const step = getGranularityStep(granularity);
  const limit = clampSeriesLimit(seriesLimit);
  const params: any[] = [tenantId, range.startDate, range.endDate, granularity, step];
  let entitySql = '';
  let dimensionIdSql = '';
  let dimensionWhereSql = '';
  let unassignedCteSql = '';
  let unassignedUnionSql = '';

  if (dimension === 'group') {
    entitySql = `SELECT og.id, COALESCE(og.name, 'Không tên') AS name FROM org_groups og WHERE og.tenant_id = $1`;
    dimensionIdSql = 'og.id';
    if (parentId) {
      params.push(parentId);
      entitySql += ` AND og.id = $${params.length}`;
      dimensionWhereSql = `AND og.id = $${params.length}`;
    } else {
      unassignedCteSql = `,
      unassigned_series AS (
        SELECT
          date_trunc($4, e.enrolled_at AT TIME ZONE 'Asia/Ho_Chi_Minh') AS bucket_start,
          'Chưa phân nhóm'::text AS series_name,
          COUNT(DISTINCT e.id)::bigint AS value
        FROM enrollments e
        WHERE e.tenant_id = $1
          AND e.is_active = true
          AND e.enrolled_at >= $2
          AND e.enrolled_at <= $3
          AND NOT EXISTS (
            SELECT 1
            FROM team_members tm_unassigned
            JOIN teams t_unassigned ON t_unassigned.id = tm_unassigned.team_id
            JOIN sub_groups sg_unassigned ON sg_unassigned.id = t_unassigned.sub_group_id
            JOIN org_groups og_unassigned ON og_unassigned.id = sg_unassigned.org_group_id
            WHERE tm_unassigned.user_id = e.user_id
              AND og_unassigned.tenant_id = e.tenant_id
          )
        GROUP BY bucket_start
      )`;
      unassignedUnionSql = `
        UNION ALL
        SELECT bucket_start, series_name, value FROM unassigned_series`;
    }
  } else if (dimension === 'subgroup') {
    params.push(parentId);
    entitySql = `SELECT sg.id, COALESCE(sg.name, 'Không tên') AS name FROM sub_groups sg JOIN org_groups og ON og.id = sg.org_group_id WHERE og.tenant_id = $1 AND sg.org_group_id = $${params.length}`;
    dimensionIdSql = 'sg.id';
    dimensionWhereSql = `AND sg.org_group_id = $${params.length}`;
  } else {
    params.push(parentId);
    entitySql = `SELECT t.id, COALESCE(t.name, 'Không tên') AS name FROM teams t JOIN sub_groups sg ON sg.id = t.sub_group_id JOIN org_groups og ON og.id = sg.org_group_id WHERE og.tenant_id = $1 AND t.sub_group_id = $${params.length}`;
    dimensionIdSql = 't.id';
    dimensionWhereSql = `AND t.sub_group_id = $${params.length}`;
  }

  params.push(limit);
  const limitParam = `$${params.length}`;
  const labelSql = getBucketLabelSql('sr.bucket_start');
  const result = await query<{ bucket: string; bucket_label: string; series_name: string; value: string }>(
    `WITH ${getBucketCteSql()},
     entity_names AS (${entitySql}),
     aggregated AS (
       SELECT
         date_trunc($4, e.enrolled_at AT TIME ZONE 'Asia/Ho_Chi_Minh') AS bucket_start,
         ${dimensionIdSql} AS entity_id,
         COUNT(DISTINCT e.id)::bigint AS value
       FROM enrollments e
       JOIN team_members tm ON tm.user_id = e.user_id
       JOIN teams t ON t.id = tm.team_id
       JOIN sub_groups sg ON sg.id = t.sub_group_id
       JOIN org_groups og ON og.id = sg.org_group_id
       WHERE e.tenant_id = $1
         AND e.is_active = true
         AND e.enrolled_at >= $2
         AND e.enrolled_at <= $3
         AND og.tenant_id = $1
         ${dimensionWhereSql}
       GROUP BY bucket_start, ${dimensionIdSql}
     ),
     entity_totals AS (
       SELECT entity_id, SUM(value)::bigint AS total_value
       FROM aggregated
       GROUP BY entity_id
     ),
     ranked_entities AS (
       SELECT en.id, en.name
       FROM entity_names en
       JOIN entity_totals et ON et.entity_id = en.id
       ORDER BY et.total_value DESC, en.name ASC
       LIMIT ${limitParam}
     ),
     top_series AS (
       SELECT b.bucket_start, re.name AS series_name, COALESCE(a.value, 0)::bigint AS value
       FROM buckets b
       CROSS JOIN ranked_entities re
       LEFT JOIN aggregated a ON a.bucket_start = b.bucket_start AND a.entity_id = re.id
     ),
     other_series AS (
       SELECT a.bucket_start, 'Khác'::text AS series_name, SUM(a.value)::bigint AS value
       FROM aggregated a
       WHERE NOT EXISTS (SELECT 1 FROM ranked_entities re WHERE re.id = a.entity_id)
       GROUP BY a.bucket_start
       HAVING SUM(a.value) > 0
     )${unassignedCteSql},
     series_rows AS (
       SELECT bucket_start, series_name, value FROM top_series
       UNION ALL
       SELECT bucket_start, series_name, value FROM other_series${unassignedUnionSql}
     )
     SELECT
       to_char(sr.bucket_start, 'YYYY-MM-DD') AS bucket,
       ${labelSql} AS bucket_label,
       sr.series_name,
       sr.value::bigint AS value
     FROM series_rows sr
     ORDER BY sr.bucket_start, sr.series_name`,
    params,
  );

  const points = new Map<string, ReportChartPoint>();
  let seriesOverflow = false;
  for (const row of result.rows) {
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
 * Grouped by OrgGroup — 1 SQL query per OrgGroup (instead of N×12)
 */
async function chartGroupedByOrg(
  tenantId: string, year: number, metric: string, maxMonth: number,
  groupId?: string,
): Promise<{ year: number; metric: string; data: ReportChartPoint[]; is_grouped: boolean }> {
  const gFilter = groupId ? 'AND og.id = $2' : '';
  const gParams = groupId ? [tenantId, groupId] : [tenantId];
  const orgs = await query<{ id: string; name: string }>(
    `SELECT id, name FROM org_groups WHERE tenant_id = $1 ${gFilter} ORDER BY name`,
    gParams,
  );

  const yearStart = new Date(year, 0, 1);
  const yearEnd = new Date(year, 11, 31, 23, 59, 59, 999);

  // 1 batch query per org (not 12!)
  const orgMonthData = new Map<string, Map<number, number>>();
  for (const og of orgs.rows) {
    const mv = await batchMetricByMonth(tenantId, metric, yearStart, yearEnd, year, og.id, undefined);
    orgMonthData.set(og.name, mv);
  }

  const data: ReportChartPoint[] = [];
  for (let m = 1; m <= 12; m++) {
    const point: ReportChartPoint = { month: `T${m}`, month_label: MONTH_LABELS[m] };
    for (const og of orgs.rows) {
      point[og.name] = m > maxMonth ? 0 : (orgMonthData.get(og.name)?.get(m) ?? 0);
    }
    data.push(point);
  }

  return { year, metric, data, is_grouped: true };
}

/**
 * Grouped by SubGroup — 1 SQL query per SubGroup (not 12!)
 */
async function chartGroupedBySubGroup(
  tenantId: string, year: number, metric: string, maxMonth: number,
  groupId: string,
): Promise<{ year: number; metric: string; data: ReportChartPoint[]; is_grouped: boolean }> {
  const sgs = await query<{ id: string; name: string }>(
    `SELECT id, name FROM sub_groups WHERE org_group_id = $1 ORDER BY name`,
    [groupId],
  );

  const yearStart = new Date(year, 0, 1);
  const yearEnd = new Date(year, 11, 31, 23, 59, 59, 999);

  const sgMonthData = new Map<string, Map<number, number>>();
  for (const sg of sgs.rows) {
    const mv = await batchMetricByMonth(tenantId, metric, yearStart, yearEnd, year, undefined, sg.id);
    sgMonthData.set(sg.name, mv);
  }

  const data: ReportChartPoint[] = [];
  for (let m = 1; m <= 12; m++) {
    const point: ReportChartPoint = { month: `T${m}`, month_label: MONTH_LABELS[m] };
    for (const sg of sgs.rows) {
      point[sg.name] = m > maxMonth ? 0 : (sgMonthData.get(sg.name)?.get(m) ?? 0);
    }
    data.push(point);
  }

  return { year, metric, data, is_grouped: true };
}

/**
 * Grouped by Team — 1 SQL query per Team (not 12!)
 */
async function chartGroupedByTeam(
  tenantId: string, year: number, metric: string, maxMonth: number,
  subgroupId: string,
): Promise<{ year: number; metric: string; data: ReportChartPoint[]; is_grouped: boolean }> {
  const teams = await query<{ id: string; name: string }>(
    `SELECT id, name FROM teams WHERE sub_group_id = $1 ORDER BY name`,
    [subgroupId],
  );

  const yearStart = new Date(year, 0, 1);
  const yearEnd = new Date(year, 11, 31, 23, 59, 59, 999);

  const teamMonthData = new Map<string, Map<number, number>>();
  for (const tm of teams.rows) {
    const mv = await batchMetricByMonthTeam(tenantId, metric, yearStart, yearEnd, year, tm.id);
    teamMonthData.set(tm.name, mv);
  }

  const data: ReportChartPoint[] = [];
  for (let m = 1; m <= 12; m++) {
    const point: ReportChartPoint = { month: `T${m}`, month_label: MONTH_LABELS[m] };
    for (const tm of teams.rows) {
      point[tm.name] = m > maxMonth ? 0 : (teamMonthData.get(tm.name)?.get(m) ?? 0);
    }
    data.push(point);
  }

  return { year, metric, data, is_grouped: true };
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

  switch (metric) {
    case 'total_learners': {
      // Cumulative: count users created before end of each month
      const ugf = buildUserGroupFilter(groupId, subgroupId);
      let idx = 2;
      const conds = ugf.conditions.map(c => c.replace('$PARAM', `$${idx++}`));
      const r = await query<{ m: number; cnt: string }>(
        `SELECT gs.m,
                COUNT(DISTINCT u.id) AS cnt
         FROM generate_series(1, 12) AS gs(m)
         LEFT JOIN users u ON u.tenant_id = $1
           AND u.is_active = true AND u.role IN ('learner', 'learner_plus')
           AND u.created_at <= (make_date($${idx}, gs.m::INT, 1) + INTERVAL '1 month' - INTERVAL '1 second')
           ${ugf.joins ? ugf.joins.replace(/\bu\b/g, 'u') : ''}
           ${conds.length ? 'AND ' + conds.join(' AND ') : ''}
         GROUP BY gs.m ORDER BY gs.m`,
        [tenantId, ...ugf.params, year],
      );
      for (const row of r.rows) result.set(row.m, parseInt(row.cnt));
      break;
    }
    case 'active_learners': {
      const activeScope = buildLearnerScopeExists('u.id', groupId, subgroupId, undefined, 4);
      const r = await query<{ m: number; cnt: string }>(
        `WITH ${buildActiveLearnerEventsCte({
          tenantParam: '$1',
          rangeStartParam: '$2',
          rangeEndParam: '$3',
        })}
         SELECT EXTRACT(MONTH FROM ae.activity_date)::INT AS m,
                COUNT(DISTINCT ae.user_id) AS cnt
         FROM active_learner_events ae
         JOIN users u ON u.id = ae.user_id
         WHERE u.tenant_id = $1
           AND u.is_active = true
           AND u.role IN ('learner', 'learner_plus')
           AND u.created_at <= $3
           ${activeScope.sql}
         GROUP BY EXTRACT(MONTH FROM ae.activity_date)`,
        [tenantId, yearStart, yearEnd, ...activeScope.params],
      );
      for (const row of r.rows) result.set(row.m, parseInt(row.cnt, 10));
      break;
    }
    case 'completion_rate': {
      const cohort = buildReportEnrollmentCte({
        tenantParam: '$1',
        rangeStartParam: '$2',
        rangeEndParam: '$3',
        groupId,
        subgroupId,
        scopeParamStart: 4,
      });
      const roster = buildReportLearnerRosterCte({
        tenantParam: '$1',
        groupId,
        subgroupId,
        scopeParamStart: 4,
      });
      const r = await query<{ m: number; completion_rate: string }>(
        `WITH ${cohort.sql},
          ${roster.sql},
          roster_size AS (
            SELECT COUNT(*)::numeric AS learner_count
            FROM report_learners
          ),
          learner_month AS (
            SELECT
              EXTRACT(MONTH FROM re.enrolled_at)::INT AS m,
              re.user_id,
              COALESCE(ROUND(AVG(re.progress), 2), 0) AS completion_rate
            FROM report_enrollments re
            GROUP BY EXTRACT(MONTH FROM re.enrolled_at), re.user_id
          )
         SELECT
           m,
           COALESCE(ROUND(SUM(completion_rate) / NULLIF((SELECT learner_count FROM roster_size), 0), 2), 0) AS completion_rate
         FROM learner_month
         GROUP BY m`,
        [tenantId, yearStart, yearEnd, ...cohort.params],
      );
      for (const row of r.rows) result.set(row.m, parseFloat(row.completion_rate) || 0);
      break;
    }
    case 'total_enrollments': {
      const egf = buildGroupFilter(groupId, subgroupId);
      let idx = 2;
      const conds = egf.conditions.map(c => c.replace('$PARAM', `$${idx++}`));
      const r = await query<{ m: number; cnt: string }>(
        `SELECT EXTRACT(MONTH FROM e.enrolled_at)::INT AS m,
                COUNT(DISTINCT e.id) AS cnt
         FROM enrollments e ${egf.joins}
         WHERE e.tenant_id = $1 AND e.is_active = true
           AND e.enrolled_at >= $${idx} AND e.enrolled_at <= $${idx + 1}
           ${conds.length ? 'AND ' + conds.join(' AND ') : ''}
         GROUP BY EXTRACT(MONTH FROM e.enrolled_at)`,
        [tenantId, ...egf.params, yearStart, yearEnd],
      );
      for (const row of r.rows) result.set(row.m, parseInt(row.cnt));
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

  switch (metric) {
    case 'total_learners': {
      const r = await query<{ m: number; cnt: string }>(
        `SELECT gs.m,
                COUNT(DISTINCT u.id) AS cnt
         FROM generate_series(1, 12) AS gs(m)
         LEFT JOIN users u ON u.tenant_id = $1
           AND u.is_active = true AND u.role IN ('learner', 'learner_plus')
           AND u.created_at <= (make_date($2, gs.m::INT, 1) + INTERVAL '1 month' - INTERVAL '1 second')
         LEFT JOIN team_members tm ON tm.user_id = u.id AND tm.team_id = $3
         WHERE (u.id IS NULL OR tm.user_id IS NOT NULL)
         GROUP BY gs.m ORDER BY gs.m`,
        [tenantId, year, teamId],
      );
      for (const row of r.rows) result.set(row.m, parseInt(row.cnt));
      break;
    }
    case 'active_learners': {
      const r = await query<{ m: number; cnt: string }>(
        `WITH ${buildActiveLearnerEventsCte({
          tenantParam: '$1',
          rangeStartParam: '$2',
          rangeEndParam: '$3',
        })}
         SELECT EXTRACT(MONTH FROM ae.activity_date)::INT AS m,
                COUNT(DISTINCT ae.user_id) AS cnt
         FROM active_learner_events ae
         JOIN users u ON u.id = ae.user_id
         JOIN team_members tm ON tm.user_id = ae.user_id
         WHERE u.tenant_id = $1
           AND u.is_active = true
           AND u.role IN ('learner', 'learner_plus')
           AND u.created_at <= $3
           AND tm.team_id = $4
         GROUP BY EXTRACT(MONTH FROM ae.activity_date)`,
        [tenantId, yearStart, yearEnd, teamId],
      );
      for (const row of r.rows) result.set(row.m, parseInt(row.cnt, 10));
      break;
    }
    case 'completion_rate': {
      const cohort = buildReportEnrollmentCte({
        tenantParam: '$1',
        rangeStartParam: '$2',
        rangeEndParam: '$3',
        teamId,
        scopeParamStart: 4,
      });
      const roster = buildReportLearnerRosterCte({
        tenantParam: '$1',
        teamId,
        scopeParamStart: 4,
      });
      const r = await query<{ m: number; completion_rate: string }>(
        `WITH ${cohort.sql},
          ${roster.sql},
          roster_size AS (
            SELECT COUNT(*)::numeric AS learner_count
            FROM report_learners
          ),
          learner_month AS (
            SELECT
              EXTRACT(MONTH FROM re.enrolled_at)::INT AS m,
              re.user_id,
              COALESCE(ROUND(AVG(re.progress), 2), 0) AS completion_rate
            FROM report_enrollments re
            GROUP BY EXTRACT(MONTH FROM re.enrolled_at), re.user_id
          )
         SELECT
           m,
           COALESCE(ROUND(SUM(completion_rate) / NULLIF((SELECT learner_count FROM roster_size), 0), 2), 0) AS completion_rate
         FROM learner_month
         GROUP BY m`,
        [tenantId, yearStart, yearEnd, ...cohort.params],
      );
      for (const row of r.rows) result.set(row.m, parseFloat(row.completion_rate) || 0);
      break;
    }
    case 'total_enrollments': {
      const r = await query<{ m: number; cnt: string }>(
        `SELECT EXTRACT(MONTH FROM e.enrolled_at)::INT AS m,
                COUNT(e.id) AS cnt
         FROM enrollments e
         JOIN team_members tm ON tm.user_id = e.user_id
         WHERE e.tenant_id = $1 AND e.is_active = true AND tm.team_id = $2
           AND e.enrolled_at >= $3 AND e.enrolled_at <= $4
         GROUP BY EXTRACT(MONTH FROM e.enrolled_at)`,
        [tenantId, teamId, yearStart, yearEnd],
      );
      for (const row of r.rows) result.set(row.m, parseInt(row.cnt));
      break;
    }
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════
// Course Completion Ranking + Top Courses
// ═══════════════════════════════════════════════════════════════

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
  return cacheJson(rankingCacheKey, getSummaryCacheTtl(range), async () => {
  const cohort = buildReportEnrollmentCte({
    tenantParam: '$1',
    rangeStartParam: '$2',
    rangeEndParam: '$3',
    groupId,
    subgroupId,
    teamId,
    scopeParamStart: 4,
  });
  const limitParam = 4 + cohort.params.length;
  const result = await query<ReportCourseCompletionRanking & { full_count: string }>(
    `WITH ${cohort.sql},
      aggregated AS (
        SELECT
          re.course_id,
          MAX(re.course_name) AS name,
          COUNT(*)::bigint AS total_enrollments,
          COUNT(*) FILTER (WHERE re.is_completed)::bigint AS completed_enrollments,
          COUNT(*) FILTER (WHERE NOT re.is_completed)::bigint AS incomplete_enrollments,
          COALESCE(ROUND(AVG(re.progress), 2), 0) AS completion_rate
        FROM report_enrollments re
        GROUP BY re.course_id
      )
     SELECT aggregated.*, COUNT(*) OVER() AS full_count
     FROM aggregated
     ORDER BY completion_rate DESC NULLS LAST, completed_enrollments DESC, total_enrollments DESC, name ASC
     LIMIT $${limitParam} OFFSET $${limitParam + 1}`,
    [tenantId, range.startDate, range.endDate, ...cohort.params, safePageSize, (safePage - 1) * safePageSize],
  );
  const total = parseInt(result.rows[0]?.full_count ?? '0', 10);
  return {
    count: total,
    total_pages: Math.ceil(total / safePageSize),
    current_page: safePage,
    results: result.rows.map(row => ({
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
  const cohort = buildReportEnrollmentCte({
    tenantParam: '$1',
    rangeStartParam: '$2',
    rangeEndParam: '$3',
    groupId,
    subgroupId,
    teamId,
    scopeParamStart: 4,
  });
  const params: any[] = [tenantId, range.startDate, range.endDate, ...cohort.params, courseId];
  let paramIdx = params.length + 1;
  const filters = [`re.course_id = $${paramIdx - 1}`];
  if (search?.trim()) {
    filters.push(`(u.username ILIKE '%' || $${paramIdx} || '%' OR u.email ILIKE '%' || $${paramIdx} || '%' OR u.full_name ILIKE '%' || $${paramIdx} || '%')`);
    params.push(search.trim());
    paramIdx++;
  }
  const safeStatus = ['all', 'not_started', 'learning', 'completed'].includes(status) ? status : 'all';
  if (safeStatus !== 'all') filters.push(`CASE WHEN re.is_completed THEN 'completed' WHEN re.has_started THEN 'learning' ELSE 'not_started' END = '${safeStatus}'`);
  params.push(safePageSize, (safePage - 1) * safePageSize);
  const result = await query<ReportCourseCompletionLearner & { full_count: string }>(
    `WITH ${cohort.sql}
     SELECT
       re.user_id,
       u.username,
       u.email,
       u.full_name,
       u.avatar_url AS avatar,
       re.enrolled_at,
       re.completed_at,
       re.progress AS progress,
       CASE WHEN re.is_completed THEN 'completed' WHEN re.has_started THEN 'learning' ELSE 'not_started' END AS status,
       COUNT(*) OVER() AS full_count
     FROM report_enrollments re
     JOIN users u ON u.id = re.user_id
     WHERE ${filters.join(' AND ')}
     ORDER BY CASE WHEN re.is_completed THEN 1 WHEN re.has_started THEN 2 ELSE 3 END, COALESCE(NULLIF(u.full_name, ''), u.username), u.username
     LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    params,
  );
  const total = parseInt(result.rows[0]?.full_count ?? '0', 10);
  return {
    count: total,
    total_pages: Math.ceil(total / safePageSize),
    current_page: safePage,
    results: result.rows.map(row => ({
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
  const offset = (page - 1) * pageSize;
  const conditions: string[] = ['e.tenant_id = $1', 'e.is_active = true'];
  const params: any[] = [tenantId];
  let paramIdx = 2;

  if (dateRange || (month && year) || year) {
    const range = dateRange
      ?? (month && year
        ? getReportRange(month, year)
        : { startDate: new Date(year!, 0, 1), endDate: new Date(year!, 11, 31, 23, 59, 59, 999), dateFrom: `${year}-01-01`, dateTo: `${year}-12-31` });
    conditions.push(`e.enrolled_at >= $${paramIdx} AND e.enrolled_at <= $${paramIdx + 1}`);
    params.push(range.startDate, range.endDate);
    paramIdx += 2;
  }

  const gf = buildGroupFilter(groupId, subgroupId, teamId);
  const gfConditions = gf.conditions.map(c => c.replace('$PARAM', `$${paramIdx++}`));
  params.push(...gf.params);

  const whereClause = [...conditions, ...gfConditions].join(' AND ');

  // Single query: count + data using window function
  params.push(pageSize, offset);
  const result = await query<ReportTopCourse & { full_count: string }>(
    `SELECT e.course_id, c.display_name AS name,
            COUNT(DISTINCT e.id) AS enrollments,
            COUNT(*) OVER() AS full_count
     FROM enrollments e
     JOIN courses c ON c.id = e.course_id
     JOIN users eu ON eu.id = e.user_id AND eu.role IN ('learner', 'learner_plus')
     ${gf.joins}
     WHERE ${whereClause}
     GROUP BY e.course_id, c.display_name
     ORDER BY enrollments DESC
     LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    params,
  );

  const total = parseInt(result.rows[0]?.full_count ?? '0');

  return {
    count: total,
    total_pages: Math.ceil(total / pageSize),
    current_page: page,
    results: result.rows.map(r => ({ course_id: r.course_id, name: r.name, enrollments: Number(r.enrollments) })),
  };
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
  const safeStatus = ['all', 'not_started', 'learning', 'completed'].includes(status || 'all') ? status! : 'all';
  const statusFilter = safeStatus === 'all' ? '' : `WHERE learner_status.status = '${safeStatus}'`;
  params.push(safePageSize, (safePage - 1) * safePageSize);

  const result = await query<ReportLearner & { full_count: string }>(
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

  const result = await query<LearnerDetailResult & { full_count: string }>(
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
  const userResult = await query<{ id: string }>(
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
  const groupsResult = await query<{ group_name: string; subgroup_name: string }>(
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
  const result = await query<LearnerDetailResult & { full_count: string }>(
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

export async function getUserBadges(
  username: string,
  tenantId: string,
): Promise<{ username: string; badges: Array<{ badge_id: string; earned_at: string }> }> {
  const result = await query<{ badge_id: string; earned_at: string }>(
    `SELECT ub.badge_id, ub.earned_at
     FROM user_badges ub
     JOIN users u ON u.id = ub.user_id
     WHERE u.username = $1 AND u.tenant_id = $2
     ORDER BY ub.earned_at DESC`,
    [username, tenantId],
  );

  return { username, badges: result.rows };
}

// ═══════════════════════════════════════════════════════════════
// User Study Time
// ═══════════════════════════════════════════════════════════════

export async function getUserStudyTime(
  username: string,
  tenantId: string,
  options: { from?: string; to?: string; granularity?: StudyTimeGranularity } = {},
): Promise<{ username: string; entries: Array<{ date: string; minutes: number }>; meta: StudyTimeSeriesResponse['meta'] }> {
  const userResult = await query<{ id: string }>(
    `SELECT id FROM users WHERE username = $1 AND tenant_id = $2 LIMIT 1`,
    [username, tenantId],
  );

  if (userResult.rowCount === 0) {
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

export async function refreshReportSummary(): Promise<void> {
  try {
    await query('SELECT refresh_report_summary()', []);
  } catch {
    // Function may not exist yet
  }
}
