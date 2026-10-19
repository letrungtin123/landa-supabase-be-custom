// ═══════════════════════════════════════════════════════════════
// Reports Service — Analytics & Dashboard data
// Optimized for millions of rows:
//   - Chart: single batch SQL per metric (not N×12 queries)
//   - Composite indexes for all hot paths
//   - No N+1 subqueries
// ═══════════════════════════════════════════════════════════════

import { cacheKey, stableHash } from '../../config/cache.js';
import type { ReportSummary, ReportDateRange } from './report-results.types.js';
import { MONTH_LABELS, getReportRange, getRangeLabel } from './report-period.logic.js';
import { getSummaryCacheTtl, cachedReportAggregate } from './report-aggregate-cache.js';
import { chartRepository } from './report-chart.service.js';
// The shared SQL fragments live in report-sql.ts; these names stay importable from here.
export {
  buildActiveLearnerEventsCte,
  buildLearnerScopeExists,
  buildReportEnrollmentCte,
  buildReportLearnerRosterCte,
} from './report-sql.js';
// The report service is split by concern; every name stays importable from here.
export type {
  ReportSummary,
  ReportChartGranularity,
  ReportChartWindowDirection,
  ReportChartWindowOptions,
  ReportChartWindowMeta,
  ReportDateRange,
  ReportChartPoint,
  ReportTopCourse,
  ReportCourseCompletionStatus,
  LearnerDetailDataScope,
  ReportCourseCompletionRanking,
  ReportCoursePerformance,
  ReportCompletionStatusDistribution,
  ReportCourseCompletionLearner,
  ReportLearner,
  LearnerDetailResult,
  LearnerDetailResponse,
} from './report-results.types.js';
export { resolveReportChartGranularity } from './report-period.logic.js';
export { getReportAggregateCacheTtl } from './report-aggregate-cache.js';
export { getReportChart } from './report-chart.service.js';
export {
  getReportCoursePerformance,
  getReportCourseCount,
  findReportCoursePerformanceByName,
  getReportCoursePerformanceById,
  getReportCompletionStatusDistribution,
  getReportCourseCompletionRanking,
  getReportCourseCompletionLearners,
  getReportTopCourses,
} from './report-courses.service.js';
export {
  getReportLearners,
  getLearnerDetail,
  getUserBadges,
  emptyUserStudyTime,
  getUserStudyTime,
  refreshReportSummary,
} from './report-learners.service.js';

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
