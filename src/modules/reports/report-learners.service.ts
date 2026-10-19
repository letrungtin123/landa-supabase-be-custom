// ═══════════════════════════════════════════════════════════════
// Learner reports: the learner list, one learner's detail, badges and study
// time, and the summary refresh. Moved unchanged from reports.service.ts,
// which re-exports them.
// ═══════════════════════════════════════════════════════════════

import { cacheKey, stableHash } from '../../config/cache.js';
import { reportsQuery } from '../../config/reports-database.js';
import {
  getStudyTimeSeries,
  type StudyTimeGranularity,
  type StudyTimeSeriesResponse,
} from '../enrollments/enrollments.service.js';
import {
  createReportLearnersRepository,
  type LearnerCourseRow,
  type LearnerCoursesSource,
  type UserBadgeRow,
} from './report-learners.repository.js';
import type {
  ReportDateRange,
  ReportCourseCompletionStatus,
  LearnerDetailDataScope,
  ReportLearner,
  LearnerDetailResult,
  LearnerDetailResponse,
} from './report-results.types.js';
import { getReportRange } from './report-period.logic.js';
import { getReportListCacheTtl, cachedReportAggregate } from './report-aggregate-cache.js';

const learnersRepository = createReportLearnersRepository({ query: reportsQuery });

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
    const rows = await learnersRepository.selectReportLearners({
      tenantId,
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

function toLearnerDetailResult(row: LearnerCourseRow): LearnerDetailResult {
  return {
    course_id: row.course_id,
    course_name: row.course_name,
    enrolled_at: row.enrolled_at,
    completed_at: row.completed_at,
    progress: Number(row.progress) || 0,
    is_completed: Boolean(row.is_completed),
    status: row.status,
  };
}

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

  let source: LearnerCoursesSource;
  if (dataScope === 'report_filter') {
    if (!dateRange) return { total_count: 0, total_pages: 0, current_page: safePage, results: [] };
    source = { dataScope, range: dateRange };
  } else {
    source = { dataScope };
  }

  const rows = await learnersRepository.selectScopedLearnerCourses({
    tenantId, userId, ...source, groupId, subgroupId, teamId, search, status, limit: safePageSize, offset,
  });

  const total = parseInt(rows[0]?.full_count ?? '0', 10);
  return {
    total_count: total,
    total_pages: Math.ceil(total / safePageSize),
    current_page: safePage,
    results: rows.map(toLearnerDetailResult),
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

  // Following the report filters or the history, the learner must be in the org scope.
  const user = await learnersRepository.findActiveLearnerId({
    username,
    tenantId,
    scope: dataScope ? { groupId, subgroupId, teamId } : undefined,
  });
  if (!user) {
    return { username, groups: [], results: [], total_count: 0, total_pages: 0, current_page: safePage };
  }
  const userId = user.id;

  // Groups
  const groups = await learnersRepository.selectLearnerGroups(userId, tenantId);

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
    return { username, groups, ...scopedResult };
  }

  const rows = await learnersRepository.selectVisibleLearnerCourses({
    tenantId, userId, snapshotEndDate, groupId, subgroupId, teamId, search, status, limit: safePageSize, offset,
  });

  const total = parseInt(rows[0]?.full_count ?? '0');

  return {
    username,
    groups,
    results: rows.map(toLearnerDetailResult),
    total_count: total,
    total_pages: Math.ceil(total / safePageSize),
    current_page: safePage,
  };
}

// ═══════════════════════════════════════════════════════════════
// User Badges
// ═══════════════════════════════════════════════════════════════

/** Badges of one learner; name_override is the tenant's own display name for the badge, if it set one. */
export async function getUserBadges(
  username: string,
  tenantId: string,
): Promise<{ username: string; badges: UserBadgeRow[] }> {
  const badges = await learnersRepository.selectUserBadges(username, tenantId);

  return { username, badges };
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
  const user = await learnersRepository.findUserId(username, tenantId);

  if (!user) return emptyUserStudyTime(username, options);

  const series = await getStudyTimeSeries(user.id, tenantId, options);

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
  await learnersRepository.refreshSummary();
}
