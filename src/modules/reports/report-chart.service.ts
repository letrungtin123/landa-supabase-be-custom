// ═══════════════════════════════════════════════════════════════
// Report charts: the date-range charts and the yearly charts of the Reports
// page. Moved unchanged from reports.service.ts, which re-exports
// getReportChart.
// ═══════════════════════════════════════════════════════════════

import { cacheKey, stableHash } from '../../config/cache.js';
import { reportsQuery } from '../../config/reports-database.js';
import { buildOrgUnitChartPoints, type OrgChartDimension } from './report-org-chart.logic.js';
import { loadOrgChartEntities, loadOrgChartMonthValues } from './report-org-chart.repository.js';
import { createReportChartRepository, type GroupedEnrollmentDimension } from './report-chart.repository.js';
import type {
  ReportChartGranularity,
  EffectiveChartGranularity,
  ReportChartWindowOptions,
  ReportChartWindowMeta,
  ReportDateRange,
  ReportChartPoint,
} from './report-results.types.js';
import {
  MONTH_LABELS,
  DEFAULT_GROUP_SERIES_LIMIT,
  clampSeriesLimit,
  resolveChartWindow,
  type DateRangeChartShape,
  resolveDateRangeChartShape,
  resolveChartGranularity,
} from './report-period.logic.js';
import { getReportListCacheTtl, cachedReportAggregate } from './report-aggregate-cache.js';

// ── Helpers ──

export const chartRepository = createReportChartRepository({ query: reportsQuery });

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
