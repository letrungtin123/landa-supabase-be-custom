// ═══════════════════════════════════════════════════════════════
// Report courses repository: the course figures of the Reports page and the
// report chat (portfolio, ranking, one course, completion statuses, a
// course's learners, top courses). Every figure but the top courses reads
// the period's enrollment cohort (report-sql.ts). SQL only; moved unchanged
// from reports.service.ts, which keeps paging, caching and the mapping.
// ═══════════════════════════════════════════════════════════════

import { buildGroupFilter, buildReportEnrollmentCte } from './report-sql.js';
import type { ReportPeriodBounds, ReportScopeIds, ReportsDb } from './reports.types.js';

export interface CoursePerformanceRow {
  course_id: string;
  name: string;
  total_enrollments: string;
  completed_enrollments: string;
  incomplete_enrollments: string;
  not_started_enrollments: string;
  in_progress_enrollments: string;
  completion_rate: string;
}

export interface CourseRankingRow {
  course_id: string;
  name: string;
  total_enrollments: string;
  completed_enrollments: string;
  incomplete_enrollments: string;
  completion_rate: string;
  full_count: string;
}

export interface CompletionStatusRow {
  not_started: string;
  in_progress: string;
  completed: string;
}

/** Timestamps are typed as the answer types them: pg's Date reaches the client as ISO text. */
export interface CourseLearnerRow {
  user_id: string;
  username: string;
  email: string;
  full_name: string | null;
  avatar: string | null;
  enrolled_at: string | null;
  completed_at: string | null;
  progress: string | null;
  status: 'not_started' | 'learning' | 'completed';
  full_count: string;
}

export interface TopCourseRow {
  course_id: string;
  name: string;
  enrollments: string;
  full_count: string;
}

/** A read of the period cohort: tenant, period bounds and org scope. */
export type ReportCohortInput = { tenantId: string; range: ReportPeriodBounds } & ReportScopeIds;

function periodCohort(input: ReportCohortInput) {
  return buildReportEnrollmentCte({
    tenantParam: '$1',
    rangeStartParam: '$2',
    rangeEndParam: '$3',
    groupId: input.groupId,
    subgroupId: input.subgroupId,
    teamId: input.teamId,
    scopeParamStart: 4,
  });
}

/** Per-course figures of the cohort (the portfolio and the course name search). */
const COURSE_PERFORMANCE_AGGREGATE = `aggregated AS (
          SELECT
            re.course_id,
            MAX(re.course_name) AS name,
            COUNT(*)::bigint AS total_enrollments,
            COUNT(*) FILTER (WHERE re.is_completed)::bigint AS completed_enrollments,
            COUNT(*) FILTER (WHERE NOT re.is_completed)::bigint AS incomplete_enrollments,
            COUNT(*) FILTER (WHERE NOT re.has_started)::bigint AS not_started_enrollments,
            COUNT(*) FILTER (WHERE re.has_started AND NOT re.is_completed)::bigint AS in_progress_enrollments,
            COALESCE(ROUND(AVG(re.progress), 2), 0) AS completion_rate
          FROM report_enrollments re
          GROUP BY re.course_id
        )`;

export function createReportCoursesRepository(db: ReportsDb) {
  return {
    /** The `limit` courses with the most enrollments (least completed first on ties). */
    async selectCoursePerformance(input: ReportCohortInput & { limit: number }): Promise<CoursePerformanceRow[]> {
      const cohort = periodCohort(input);
      const limitParam = 4 + cohort.params.length;
      const result = await db.query<CoursePerformanceRow>(
        `WITH ${cohort.sql},
        ${COURSE_PERFORMANCE_AGGREGATE}
       SELECT *
       FROM aggregated
       ORDER BY total_enrollments DESC, completion_rate ASC, name ASC
       LIMIT $${limitParam}`,
        [input.tenantId, input.range.startDate, input.range.endDate, ...cohort.params, input.limit],
      );
      return result.rows;
    },

    async selectCourseCount(input: ReportCohortInput): Promise<{ course_count: string } | undefined> {
      const cohort = periodCohort(input);
      const result = await db.query<{ course_count: string }>(
        `WITH ${cohort.sql}
       SELECT COUNT(DISTINCT re.course_id)::bigint AS course_count
       FROM report_enrollments re`,
        [input.tenantId, input.range.startDate, input.range.endDate, ...cohort.params],
      );
      return result.rows[0];
    },

    /** Up to 25 courses of the cohort whose name contains `courseName` (case-insensitive). */
    async selectCoursePerformanceByName(input: ReportCohortInput & { courseName: string }): Promise<CoursePerformanceRow[]> {
      const cohort = periodCohort(input);
      const courseNameParam = 4 + cohort.params.length;
      const result = await db.query<CoursePerformanceRow>(
        `WITH ${cohort.sql},
        ${COURSE_PERFORMANCE_AGGREGATE}
       SELECT *
       FROM aggregated
       WHERE name ILIKE '%' || $${courseNameParam} || '%'
       ORDER BY total_enrollments DESC, completion_rate ASC, name ASC
       LIMIT 25`,
        [input.tenantId, input.range.startDate, input.range.endDate, ...cohort.params, input.courseName],
      );
      return result.rows;
    },

    async selectCoursePerformanceById(input: ReportCohortInput & { courseId: string }): Promise<CoursePerformanceRow | undefined> {
      const cohort = periodCohort(input);
      const courseIdParam = 4 + cohort.params.length;
      const result = await db.query<CoursePerformanceRow>(
        `WITH ${cohort.sql}
       SELECT
         re.course_id,
         MAX(re.course_name) AS name,
         COUNT(*)::bigint AS total_enrollments,
         COUNT(*) FILTER (WHERE re.is_completed)::bigint AS completed_enrollments,
         COUNT(*) FILTER (WHERE NOT re.is_completed)::bigint AS incomplete_enrollments,
         COUNT(*) FILTER (WHERE NOT re.has_started)::bigint AS not_started_enrollments,
         COUNT(*) FILTER (WHERE re.has_started AND NOT re.is_completed)::bigint AS in_progress_enrollments,
         COALESCE(ROUND(AVG(re.progress), 2), 0) AS completion_rate
       FROM report_enrollments re
       WHERE re.course_id = $${courseIdParam}
       GROUP BY re.course_id`,
        [input.tenantId, input.range.startDate, input.range.endDate, ...cohort.params, input.courseId],
      );
      return result.rows[0];
    },

    async selectCompletionStatusDistribution(input: ReportCohortInput): Promise<CompletionStatusRow | undefined> {
      const cohort = periodCohort(input);
      const result = await db.query<CompletionStatusRow>(
        `WITH ${cohort.sql}
       SELECT
         COUNT(*) FILTER (WHERE NOT has_started)::bigint AS not_started,
         COUNT(*) FILTER (WHERE has_started AND NOT is_completed)::bigint AS in_progress,
         COUNT(*) FILTER (WHERE is_completed)::bigint AS completed
       FROM report_enrollments`,
        [input.tenantId, input.range.startDate, input.range.endDate, ...cohort.params],
      );
      return result.rows[0];
    },

    /** One page of the courses by completion rate, with the total count on every row. */
    async selectCourseCompletionRanking(input: ReportCohortInput & { limit: number; offset: number }): Promise<CourseRankingRow[]> {
      const cohort = periodCohort(input);
      const limitParam = 4 + cohort.params.length;
      const result = await db.query<CourseRankingRow>(
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
        [input.tenantId, input.range.startDate, input.range.endDate, ...cohort.params, input.limit, input.offset],
      );
      return result.rows;
    },

    /**
     * One page of a course's cohort enrollments with their learners, by
     * learner name. `search` matches username, email or full name; an unknown
     * `status` lists every status.
     */
    async selectCourseCompletionLearners(
      input: ReportCohortInput & { courseId: string; search?: string; status: string; limit: number; offset: number },
    ): Promise<CourseLearnerRow[]> {
      const { search, status } = input;
      const cohort = periodCohort(input);
      const params: unknown[] = [input.tenantId, input.range.startDate, input.range.endDate, ...cohort.params, input.courseId];
      let paramIdx = params.length + 1;
      const filters = [`re.course_id = $${paramIdx - 1}`];
      if (search?.trim()) {
        filters.push(`(u.username ILIKE '%' || $${paramIdx} || '%' OR u.email ILIKE '%' || $${paramIdx} || '%' OR u.full_name ILIKE '%' || $${paramIdx} || '%')`);
        params.push(search.trim());
        paramIdx++;
      }
      // The status is written into the statement: only these four values ever are.
      const safeStatus = ['all', 'not_started', 'learning', 'completed'].includes(status) ? status : 'all';
      if (safeStatus !== 'all') filters.push(`CASE WHEN re.is_completed THEN 'completed' WHEN re.has_started THEN 'learning' ELSE 'not_started' END = '${safeStatus}'`);
      params.push(input.limit, input.offset);
      const result = await db.query<CourseLearnerRow>(
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
     ORDER BY unaccent(LOWER(COALESCE(NULLIF(BTRIM(u.full_name), ''), u.username))), u.username, re.enrollment_id
     LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
        params,
      );
      return result.rows;
    },

    /**
     * One page of the courses with the most active learner enrollments, in
     * the period when `range` is set (else all time), with the total count.
     */
    async selectTopCourses(
      input: { tenantId: string; range?: ReportPeriodBounds; limit: number; offset: number } & ReportScopeIds,
    ): Promise<TopCourseRow[]> {
      const conditions: string[] = ['e.tenant_id = $1', 'e.is_active = true'];
      const params: unknown[] = [input.tenantId];
      let paramIdx = 2;

      if (input.range) {
        conditions.push(`e.enrolled_at >= $${paramIdx} AND e.enrolled_at <= $${paramIdx + 1}`);
        params.push(input.range.startDate, input.range.endDate);
        paramIdx += 2;
      }

      const gf = buildGroupFilter(input.groupId, input.subgroupId, input.teamId);
      const gfConditions = gf.conditions.map(c => c.replace('$PARAM', `$${paramIdx++}`));
      params.push(...gf.params);

      const whereClause = [...conditions, ...gfConditions].join(' AND ');

      // Single query: count + data using window function
      params.push(input.limit, input.offset);
      const result = await db.query<TopCourseRow>(
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
      return result.rows;
    },
  };
}

export type ReportCoursesRepository = ReturnType<typeof createReportCoursesRepository>;
