// ═══════════════════════════════════════════════════════════════
// Report export repository: the statements of the Excel exports (scope
// names, hierarchy trend, team breakdown, course ranking, and the learner and
// enrollment sheets read through a cursor of the export snapshot). SQL only;
// moved unchanged from reports-export.service.ts, which writes the workbook.
// ═══════════════════════════════════════════════════════════════

import type { QueryResultRow } from 'pg';
import { buildActiveLearnerEventsCte, buildReportEnrollmentCte, buildReportLearnerRosterCte } from './report-sql.js';
import type { ReportPeriodBounds, ReportScopeIds, ReportsDb } from './reports.types.js';

/** The export snapshot: plain reads, and long sheets streamed through a cursor. */
export interface ReportsExportDb extends ReportsDb {
  forEachCursorBatch<T extends QueryResultRow>(
    input: { text: string; params: unknown[]; batchSize: number; signal?: AbortSignal },
    onBatch: (rows: T[]) => void | Promise<void>,
  ): Promise<void>;
}

export interface ScopeNames {
  groupName: string;
  subgroupName: string;
  teamName: string;
}

export interface CourseRankingExportRow {
  course_id: string;
  name: string;
  total_enrollments: string;
  completed_enrollments: string;
  incomplete_enrollments: string;
  completion_rate: string;
}

export interface TeamBreakdownRow {
  group_name: string;
  subgroup_name: string;
  team_name: string;
  member_count: string;
  total_enrollments: string;
  completed_enrollments: string;
  incomplete_enrollments: string;
  completion_rate: string | null;
}

export interface HierarchyTrendRow {
  period_month: string;
  period_year: string;
  group_name: string;
  subgroup_name: string;
  team_name: string;
  total_enrollments: string;
  completed_enrollments: string;
  incomplete_enrollments: string;
  active_learners: string;
  completion_rate: string | null;
}

export interface LearnerSummaryRow {
  user_id: string;
  username: string;
  email: string;
  full_name: string | null;
  group_names: string | null;
  subgroup_names: string | null;
  team_names: string | null;
  enrolled_courses: string;
  completed_courses: string;
  incomplete_courses: string;
  completion_rate: string | null;
  last_completion_at: Date | null;
  status: 'not_started' | 'learning' | 'completed';
}

export interface CourseLearnerRow {
  enrollment_id: string;
  user_id: string;
  username: string;
  email: string;
  full_name: string | null;
  group_names: string | null;
  subgroup_names: string | null;
  team_names: string | null;
  course_id: string;
  course_name: string;
  enrolled_at: Date | null;
  completed_at: Date | null;
  is_completed: boolean;
  progress: string;
  status: 'not_started' | 'learning' | 'completed';
}

export type SortedCourseLearnerRow = CourseLearnerRow & { sort_name: string };

/** What an export reads: the tenant, the period bounds and the org scope. */
export interface ReportExportInput extends ReportPeriodBounds {
  tenantId: string;
  scope: ReportScopeIds;
}

/** How a cursor sheet is read: rows per batch and the client's abort signal. */
export interface ReportExportBatching {
  batchSize: number;
  signal?: AbortSignal;
}

function appendScopeFilter(
  params: unknown[],
  scope: ReportScopeIds,
  aliases: { group: string; subgroup: string; team: string } = { group: 'og', subgroup: 'sg', team: 't' },
): string {
  if (scope.teamId) {
    params.push(scope.teamId);
    return `AND ${aliases.team}.id = $${params.length}`;
  }
  if (scope.subgroupId) {
    params.push(scope.subgroupId);
    return `AND ${aliases.subgroup}.id = $${params.length}`;
  }
  if (scope.groupId) {
    params.push(scope.groupId);
    return `AND ${aliases.group}.id = $${params.length}`;
  }
  return '';
}

function scopedCohort(input: ReportExportInput) {
  return buildReportEnrollmentCte({
    tenantParam: '$1', rangeStartParam: '$2', rangeEndParam: '$3',
    groupId: input.scope.groupId, subgroupId: input.scope.subgroupId, teamId: input.scope.teamId, scopeParamStart: 4,
  });
}

/** The membership filter of the learner and enrollment sheets ($4 is the scope id). */
function membershipScopeSql(scope: ReportScopeIds): string {
  return scope.teamId
    ? 'AND t.id = $4'
    : scope.subgroupId
      ? 'AND sg.id = $4'
      : scope.groupId
        ? 'AND og.id = $4'
        : '';
}

/**
 * Every learner of the scope with their period figures, ordered by user id
 * (the order of the former keyset batches). Read through one cursor, so the
 * period cohort is built once for the whole sheet.
 */
function learnerSummaryQuery(input: ReportExportInput): { text: string; params: unknown[] } {
  const cohort = scopedCohort(input);
  const roster = buildReportLearnerRosterCte({
    tenantParam: '$1',
    groupId: input.scope.groupId,
    subgroupId: input.scope.subgroupId,
    teamId: input.scope.teamId,
    scopeParamStart: 4,
  });
  const membershipScope = membershipScopeSql(input.scope);
  return {
    text: `WITH ${cohort.sql},
      ${roster.sql},
      memberships AS (
        SELECT
          tm.user_id,
          string_agg(DISTINCT og.name, ', ' ORDER BY og.name) AS group_names,
          string_agg(DISTINCT sg.name, ', ' ORDER BY sg.name) AS subgroup_names,
          string_agg(DISTINCT t.name, ', ' ORDER BY t.name) AS team_names
        FROM report_learners su
        JOIN team_members tm ON tm.user_id = su.user_id
        JOIN teams t ON t.id = tm.team_id
        JOIN sub_groups sg ON sg.id = t.sub_group_id
        JOIN org_groups og ON og.id = sg.org_group_id
        WHERE og.tenant_id = $1 ${membershipScope}
        GROUP BY tm.user_id
      )
      SELECT
        su.user_id,
        u.username,
        u.email,
        u.full_name,
        m.group_names,
        m.subgroup_names,
        m.team_names,
        COUNT(re.enrollment_id)::bigint AS enrolled_courses,
        COUNT(re.enrollment_id) FILTER (WHERE re.is_completed)::bigint AS completed_courses,
        COUNT(re.enrollment_id) FILTER (WHERE NOT re.is_completed)::bigint AS incomplete_courses,
        COALESCE(ROUND(AVG(re.progress), 2), 0) AS completion_rate,
        MAX(re.completed_at) FILTER (WHERE re.is_completed) AS last_completion_at,
        CASE
          WHEN COALESCE(AVG(re.progress), 0) >= 100 THEN 'completed'
          WHEN COALESCE(AVG(re.progress), 0) > 0 THEN 'learning'
          ELSE 'not_started'
        END AS status
      FROM report_learners su
      JOIN users u ON u.id = su.user_id
      LEFT JOIN report_enrollments re ON re.user_id = su.user_id
      LEFT JOIN memberships m ON m.user_id = su.user_id
      GROUP BY su.user_id, u.username, u.email, u.full_name, m.group_names, m.subgroup_names, m.team_names
      ORDER BY su.user_id`,
    params: [input.tenantId, input.startDate, input.endDate, ...cohort.params],
  };
}

/**
 * Every enrollment of the period cohort, ordered by enrollment time then id,
 * read through one cursor. (The former keyset carried enrolled_at back as a
 * millisecond JS Date, so a batch could restart inside the microseconds of
 * the previous batch's last row and repeat rows.)
 */
function courseLearnerQuery(input: ReportExportInput): { text: string; params: unknown[] } {
  const cohort = scopedCohort(input);
  const membershipScope = membershipScopeSql(input.scope);
  return {
    text: `WITH ${cohort.sql},
      memberships AS (
        SELECT
          tm.user_id,
          string_agg(DISTINCT og.name, ', ' ORDER BY og.name) AS group_names,
          string_agg(DISTINCT sg.name, ', ' ORDER BY sg.name) AS subgroup_names,
          string_agg(DISTINCT t.name, ', ' ORDER BY t.name) AS team_names
        FROM report_enrollments se
        JOIN team_members tm ON tm.user_id = se.user_id
        JOIN teams t ON t.id = tm.team_id
        JOIN sub_groups sg ON sg.id = t.sub_group_id
        JOIN org_groups og ON og.id = sg.org_group_id
        WHERE og.tenant_id = $1 ${membershipScope}
        GROUP BY tm.user_id
      )
      SELECT
        se.enrollment_id,
        se.user_id,
        u.username,
        u.email,
        u.full_name,
        m.group_names,
        m.subgroup_names,
        m.team_names,
        se.course_id,
        se.course_name,
        se.enrolled_at,
        se.completed_at,
        se.is_completed,
        se.progress,
        CASE WHEN se.is_completed THEN 'completed' WHEN se.has_started THEN 'learning' ELSE 'not_started' END AS status
      FROM report_enrollments se
      JOIN users u ON u.id = se.user_id
      LEFT JOIN memberships m ON m.user_id = se.user_id
      ORDER BY se.enrolled_at, se.enrollment_id`,
    params: [input.tenantId, input.startDate, input.endDate, ...cohort.params],
  };
}

/** One course's enrollments of the period cohort, ordered by learner name, username, id; read through one cursor. */
function singleCourseLearnerQuery(input: ReportExportInput & { courseId: string }): { text: string; params: unknown[] } {
  const cohort = scopedCohort(input);
  const courseParam = 4 + cohort.params.length;
  const membershipScope = membershipScopeSql(input.scope);
  const displayNameSql = "COALESCE(NULLIF(BTRIM(u.full_name), ''), u.username)";
  const sortNameSql = `unaccent(LOWER(${displayNameSql}))`;
  return {
    text: `WITH ${cohort.sql},
      selected_enrollments AS (
        SELECT
          re.*,
          u.username,
          u.email,
          u.full_name,
          ${sortNameSql} AS sort_name
        FROM report_enrollments re
        JOIN users u ON u.id = re.user_id
        WHERE re.course_id = $${courseParam}
      ),
      memberships AS (
        SELECT
          tm.user_id,
          string_agg(DISTINCT og.name, ', ' ORDER BY og.name) AS group_names,
          string_agg(DISTINCT sg.name, ', ' ORDER BY sg.name) AS subgroup_names,
          string_agg(DISTINCT t.name, ', ' ORDER BY t.name) AS team_names
        FROM selected_enrollments se
        JOIN team_members tm ON tm.user_id = se.user_id
        JOIN teams t ON t.id = tm.team_id
        JOIN sub_groups sg ON sg.id = t.sub_group_id
        JOIN org_groups og ON og.id = sg.org_group_id
        WHERE og.tenant_id = $1 ${membershipScope}
        GROUP BY tm.user_id
      )
      SELECT
        se.enrollment_id,
        se.user_id,
        se.username,
        se.email,
        se.full_name,
        se.sort_name,
        m.group_names,
        m.subgroup_names,
        m.team_names,
        se.course_id,
        se.course_name,
        se.enrolled_at,
        se.completed_at,
        se.is_completed,
        se.progress,
        CASE WHEN se.is_completed THEN 'completed' WHEN se.has_started THEN 'learning' ELSE 'not_started' END AS status
      FROM selected_enrollments se
      LEFT JOIN memberships m ON m.user_id = se.user_id
      ORDER BY se.sort_name, se.username, se.enrollment_id`,
    params: [input.tenantId, input.startDate, input.endDate, ...cohort.params, input.courseId],
  };
}

export function createReportsExportRepository(db: ReportsExportDb) {
  return {
    async findTeamNames(teamId: string, tenantId: string): Promise<ScopeNames | undefined> {
      const result = await db.query<ScopeNames>(
        `SELECT og.name AS "groupName", sg.name AS "subgroupName", t.name AS "teamName"
       FROM teams t
       JOIN sub_groups sg ON sg.id = t.sub_group_id
       JOIN org_groups og ON og.id = sg.org_group_id
       WHERE t.id = $1 AND og.tenant_id = $2
       LIMIT 1`,
        [teamId, tenantId],
      );
      return result.rows[0];
    },

    async findSubgroupNames(subgroupId: string, tenantId: string): Promise<Pick<ScopeNames, 'groupName' | 'subgroupName'> | undefined> {
      const result = await db.query<Pick<ScopeNames, 'groupName' | 'subgroupName'>>(
        `SELECT og.name AS "groupName", sg.name AS "subgroupName"
       FROM sub_groups sg
       JOIN org_groups og ON og.id = sg.org_group_id
       WHERE sg.id = $1 AND og.tenant_id = $2
       LIMIT 1`,
        [subgroupId, tenantId],
      );
      return result.rows[0];
    },

    async findGroupName(groupId: string, tenantId: string): Promise<Pick<ScopeNames, 'groupName'> | undefined> {
      const result = await db.query<Pick<ScopeNames, 'groupName'>>(
        `SELECT name AS "groupName"
       FROM org_groups
       WHERE id = $1 AND tenant_id = $2
       LIMIT 1`,
        [groupId, tenantId],
      );
      return result.rows[0];
    },

    /** Period figures per month and team of the scope (enrollment cohort and learning activity). */
    async selectHierarchyTrend(input: ReportExportInput): Promise<HierarchyTrendRow[]> {
      const params: unknown[] = [input.tenantId, input.startDate, input.endDate];
      const scopeFilter = appendScopeFilter(params, input.scope);
      const cohort = buildReportEnrollmentCte({
        tenantParam: '$1', rangeStartParam: '$2', rangeEndParam: '$3', scopeParamStart: 4,
      });
      const result = await db.query<HierarchyTrendRow>(
        `WITH ${buildActiveLearnerEventsCte({ tenantParam: '$1', rangeStartParam: '$2', rangeEndParam: '$3' })},
      ${cohort.sql},
      enrollment_metrics AS (
        SELECT
          date_trunc('month', re.enrolled_at AT TIME ZONE 'Asia/Ho_Chi_Minh') AS period_start,
          og.id AS group_id, sg.id AS subgroup_id, t.id AS team_id,
          og.name AS group_name, sg.name AS subgroup_name, t.name AS team_name,
          COUNT(DISTINCT re.enrollment_id)::bigint AS total_enrollments,
          COUNT(DISTINCT re.enrollment_id) FILTER (WHERE re.is_completed)::bigint AS completed_enrollments,
          COUNT(DISTINCT re.enrollment_id) FILTER (WHERE NOT re.is_completed)::bigint AS incomplete_enrollments,
          COALESCE(ROUND(AVG(re.progress), 2), 0) AS completion_rate
        FROM report_enrollments re
        JOIN team_members tm ON tm.user_id = re.user_id
        JOIN teams t ON t.id = tm.team_id
        JOIN sub_groups sg ON sg.id = t.sub_group_id
        JOIN org_groups og ON og.id = sg.org_group_id
        WHERE og.tenant_id = $1 ${scopeFilter}
        GROUP BY period_start, og.id, sg.id, t.id, og.name, sg.name, t.name
      ),
      activity_metrics AS (
        SELECT
          date_trunc('month', ae.activity_date::timestamp) AS period_start,
          og.id AS group_id, sg.id AS subgroup_id, t.id AS team_id,
          og.name AS group_name, sg.name AS subgroup_name, t.name AS team_name,
          COUNT(DISTINCT ae.user_id)::bigint AS active_learners
        FROM active_learner_events ae
        JOIN users u ON u.id = ae.user_id
        JOIN team_members tm ON tm.user_id = ae.user_id
        JOIN teams t ON t.id = tm.team_id
        JOIN sub_groups sg ON sg.id = t.sub_group_id
        JOIN org_groups og ON og.id = sg.org_group_id
        WHERE u.tenant_id = $1
          AND u.is_active = true
          AND u.role IN ('learner', 'learner_plus')
          AND og.tenant_id = $1 ${scopeFilter}
        GROUP BY period_start, og.id, sg.id, t.id, og.name, sg.name, t.name
      )
      SELECT
        EXTRACT(MONTH FROM COALESCE(em.period_start, am.period_start))::int AS period_month,
        EXTRACT(YEAR FROM COALESCE(em.period_start, am.period_start))::int AS period_year,
        COALESCE(em.group_name, am.group_name) AS group_name,
        COALESCE(em.subgroup_name, am.subgroup_name) AS subgroup_name,
        COALESCE(em.team_name, am.team_name) AS team_name,
        COALESCE(em.total_enrollments, 0)::bigint AS total_enrollments,
        COALESCE(em.completed_enrollments, 0)::bigint AS completed_enrollments,
        COALESCE(em.incomplete_enrollments, 0)::bigint AS incomplete_enrollments,
        COALESCE(am.active_learners, 0)::bigint AS active_learners,
        em.completion_rate
      FROM enrollment_metrics em
      FULL OUTER JOIN activity_metrics am
        ON am.period_start = em.period_start AND am.group_id = em.group_id AND am.subgroup_id = em.subgroup_id AND am.team_id = em.team_id
      ORDER BY COALESCE(em.period_start, am.period_start), COALESCE(em.group_name, am.group_name), COALESCE(em.subgroup_name, am.subgroup_name), COALESCE(em.team_name, am.team_name)`,
        params,
      );
      return result.rows;
    },

    /** Current members and period figures of every team of the scope. */
    async selectTeamBreakdown(input: ReportExportInput): Promise<TeamBreakdownRow[]> {
      const params: unknown[] = [input.tenantId, input.startDate, input.endDate];
      const scopeFilter = appendScopeFilter(params, input.scope);
      const cohort = buildReportEnrollmentCte({ tenantParam: '$1', rangeStartParam: '$2', rangeEndParam: '$3', scopeParamStart: 4 });
      const result = await db.query<TeamBreakdownRow>(
        `WITH ${cohort.sql},
      scoped_teams AS (
        SELECT t.id AS team_id, t.name AS team_name, sg.name AS subgroup_name, og.name AS group_name
        FROM teams t
        JOIN sub_groups sg ON sg.id = t.sub_group_id
        JOIN org_groups og ON og.id = sg.org_group_id
        WHERE og.tenant_id = $1 ${scopeFilter}
      ),
      members AS (
        SELECT st.team_id, COUNT(DISTINCT u.id)::bigint AS member_count
        FROM scoped_teams st
        LEFT JOIN team_members tm ON tm.team_id = st.team_id
        LEFT JOIN users u ON u.id = tm.user_id AND u.tenant_id = $1 AND u.is_active = true AND u.role IN ('learner', 'learner_plus')
        GROUP BY st.team_id
      ),
      enrollment_metrics AS (
        SELECT
          st.team_id,
          COUNT(DISTINCT re.enrollment_id)::bigint AS total_enrollments,
          COUNT(DISTINCT re.enrollment_id) FILTER (WHERE re.is_completed)::bigint AS completed_enrollments,
          COUNT(DISTINCT re.enrollment_id) FILTER (WHERE NOT re.is_completed)::bigint AS incomplete_enrollments,
          COALESCE(ROUND(AVG(re.progress), 2), 0) AS completion_rate
        FROM scoped_teams st
        LEFT JOIN team_members tm ON tm.team_id = st.team_id
        LEFT JOIN report_enrollments re ON re.user_id = tm.user_id
        GROUP BY st.team_id
      )
      SELECT
        st.group_name, st.subgroup_name, st.team_name,
        COALESCE(m.member_count, 0)::bigint AS member_count,
        COALESCE(em.total_enrollments, 0)::bigint AS total_enrollments,
        COALESCE(em.completed_enrollments, 0)::bigint AS completed_enrollments,
        COALESCE(em.incomplete_enrollments, 0)::bigint AS incomplete_enrollments,
        COALESCE(em.completion_rate, 0) AS completion_rate
      FROM scoped_teams st
      LEFT JOIN members m ON m.team_id = st.team_id
      LEFT JOIN enrollment_metrics em ON em.team_id = st.team_id
      ORDER BY st.group_name, st.subgroup_name, st.team_name`,
        params,
      );
      return result.rows;
    },

    /** Every course of the scope's period cohort, by completion rate. */
    async selectCourseRanking(input: ReportExportInput): Promise<CourseRankingExportRow[]> {
      const cohort = scopedCohort(input);
      const result = await db.query<CourseRankingExportRow>(
        `WITH ${cohort.sql}
     SELECT
       re.course_id,
       MAX(re.course_name) AS name,
       COUNT(*)::bigint AS total_enrollments,
       COUNT(*) FILTER (WHERE re.is_completed)::bigint AS completed_enrollments,
       COUNT(*) FILTER (WHERE NOT re.is_completed)::bigint AS incomplete_enrollments,
       COALESCE(ROUND(AVG(re.progress), 2), 0) AS completion_rate
     FROM report_enrollments re
     GROUP BY re.course_id
     ORDER BY completion_rate DESC NULLS LAST, completed_enrollments DESC, total_enrollments DESC, name ASC`,
        [input.tenantId, input.startDate, input.endDate, ...cohort.params],
      );
      return result.rows;
    },

    streamLearnerSummary(
      input: ReportExportInput,
      batching: ReportExportBatching,
      onBatch: (rows: LearnerSummaryRow[]) => Promise<void>,
    ): Promise<void> {
      return db.forEachCursorBatch<LearnerSummaryRow>({ ...learnerSummaryQuery(input), ...batching }, onBatch);
    },

    streamCourseLearners(
      input: ReportExportInput,
      batching: ReportExportBatching,
      onBatch: (rows: CourseLearnerRow[]) => Promise<void>,
    ): Promise<void> {
      return db.forEachCursorBatch<CourseLearnerRow>({ ...courseLearnerQuery(input), ...batching }, onBatch);
    },

    streamSingleCourseLearners(
      input: ReportExportInput & { courseId: string },
      batching: ReportExportBatching,
      onBatch: (rows: SortedCourseLearnerRow[]) => Promise<void>,
    ): Promise<void> {
      return db.forEachCursorBatch<SortedCourseLearnerRow>({ ...singleCourseLearnerQuery(input), ...batching }, onBatch);
    },
  };
}

export type ReportsExportRepository = ReturnType<typeof createReportsExportRepository>;
