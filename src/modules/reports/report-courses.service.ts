// ═══════════════════════════════════════════════════════════════
// Course reports: course performance, completion ranking and status
// distribution, a course's learners and the top courses. Moved unchanged
// from reports.service.ts, which re-exports them.
// ═══════════════════════════════════════════════════════════════

import { cacheKey, getCacheVersion, stableHash } from '../../config/cache.js';
import { cacheKeys, cacheVersions } from '../../config/cache-keys.js';
import { reportsQuery } from '../../config/reports-database.js';
import { createReportCoursesRepository, type CoursePerformanceRow } from './report-courses.repository.js';
import type {
  ReportDateRange,
  ReportTopCourse,
  ReportCourseCompletionStatus,
  ReportCourseCompletionRanking,
  ReportCoursePerformance,
  ReportCompletionStatusDistribution,
  ReportCourseCompletionLearner,
} from './report-results.types.js';
import { getReportRange } from './report-period.logic.js';
import { getSummaryCacheTtl, getReportListCacheTtl, cachedReportAggregate } from './report-aggregate-cache.js';

const coursesRepository = createReportCoursesRepository({ query: reportsQuery });

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
