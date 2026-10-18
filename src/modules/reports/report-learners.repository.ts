// ═══════════════════════════════════════════════════════════════
// Report learners repository: the learner list of the Reports page, one
// learner's detail (their courses, groups, badges) and the summary refresh.
// SQL only; moved unchanged from reports.service.ts, which keeps paging,
// caching and the mapping of rows to answers.
// ═══════════════════════════════════════════════════════════════

import {
  buildLearnerScopeExists,
  buildReportEnrollmentCte,
  buildReportLearnerRosterCte,
  buildVisibleCourseUsersCte,
} from './report-sql.js';
import type { ReportPeriodBounds, ReportScopeIds, ReportsDb } from './reports.types.js';

type LearningStatus = 'not_started' | 'learning' | 'completed';

/** Timestamps are typed as the answer types them: pg's Date reaches the client as ISO text. */
export interface ReportLearnerRow {
  user_id: string;
  username: string;
  email: string;
  avatar: string | null;
  last_completion_at: string | null;
  enrolled_courses: string;
  completed_courses: string;
  completion_rate: string;
  status: LearningStatus;
  full_count: string;
}

/** One course of a learner's detail, with the total count on every row. */
export interface LearnerCourseRow {
  course_id: string;
  course_name: string;
  enrolled_at: string | null;
  completed_at: string | null;
  progress: string;
  is_completed: boolean;
  status: LearningStatus;
  full_count: string;
}

export interface LearnerGroupRow {
  group_name: string;
  subgroup_name: string;
}

export interface UserBadgeRow {
  badge_id: string;
  earned_at: string;
  name_override: string | null;
}

/** A page of a learner's courses: optional course name search and status. */
interface LearnerCoursesPage {
  search: string;
  status: string;
  limit: number;
  offset: number;
}

const LEARNING_STATUSES = ['all', 'not_started', 'learning', 'completed'];

/** The period cohort of the report filters, or the learner's whole history. */
export type LearnerCoursesSource =
  | { dataScope: 'report_filter'; range: ReportPeriodBounds }
  | { dataScope: 'learner_history' };

/** Where a learner's detail comes from when it follows the report filters or their history. */
function scopedSourceCte(
  input: { tenantId: string; userId: string } & LearnerCoursesSource & ReportScopeIds,
  params: unknown[],
): string {
  const { tenantId, userId, groupId, subgroupId, teamId } = input;
  if (input.dataScope === 'report_filter') {
    const { range } = input;
    const cohort = buildReportEnrollmentCte({
      tenantParam: '$1',
      rangeStartParam: '$2',
      rangeEndParam: '$3',
      groupId,
      subgroupId,
      teamId,
      scopeParamStart: 4,
    });
    params.push(tenantId, range.startDate, range.endDate, ...cohort.params, userId);
    const userParam = `$${params.length}`;
    return `${cohort.sql},
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
  }
  params.push(tenantId, userId);
  return `source_enrollments AS (
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

export function createReportLearnersRepository(db: ReportsDb) {
  return {
    /**
     * One page of the scope's learners with their period figures, the most
     * recent completion first. `search` matches username, email or full
     * name; an unknown or missing `status` lists every status.
     */
    async selectReportLearners(
      input: { tenantId: string; range: ReportPeriodBounds; search?: string; status?: string; limit: number; offset: number } & ReportScopeIds,
    ): Promise<ReportLearnerRow[]> {
      const { tenantId, range, groupId, subgroupId, teamId, search, status } = input;
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
      const params: unknown[] = [tenantId, range.startDate, range.endDate, ...cohort.params];
      let paramIdx = params.length + 1;
      const searchFilter = search?.trim()
        ? `(rl.username ILIKE '%' || $${paramIdx} || '%' OR rl.email ILIKE '%' || $${paramIdx} || '%' OR rl.full_name ILIKE '%' || $${paramIdx} || '%')`
        : '';
      if (search?.trim()) {
        params.push(search.trim());
        paramIdx++;
      }
      // A missing status never becomes the filter text 'undefined' (the controller refuses it).
      // The status is written into the statement: only these four values ever are.
      const safeStatus = status && LEARNING_STATUSES.includes(status) ? status : 'all';
      const statusFilter = safeStatus === 'all' ? '' : `WHERE learner_status.status = '${safeStatus}'`;
      params.push(input.limit, input.offset);

      const result = await db.query<ReportLearnerRow>(
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
      return result.rows;
    },

    /**
     * The id of an active learner of the tenant by username; with `scope`,
     * only when the learner also belongs to that org unit.
     */
    async findActiveLearnerId(input: { username: string; tenantId: string; scope?: ReportScopeIds }): Promise<{ id: string } | undefined> {
      const { scope } = input;
      const userScope = scope
        ? buildLearnerScopeExists('u.id', scope.groupId, scope.subgroupId, scope.teamId, 3)
        : { sql: '', params: [] as string[] };
      const userResult = await db.query<{ id: string }>(
        `SELECT u.id
     FROM users u
     WHERE u.username = $1
       AND u.tenant_id = $2
       AND u.is_active = true
       AND u.role IN ('learner', 'learner_plus')
       ${userScope.sql}
     LIMIT 1`,
        [input.username, input.tenantId, ...userScope.params],
      );
      return userResult.rows[0];
    },

    /** The groups and subgroups of the learner's teams, in the tenant. */
    async selectLearnerGroups(userId: string, tenantId: string): Promise<LearnerGroupRow[]> {
      const groupsResult = await db.query<LearnerGroupRow>(
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
      return groupsResult.rows;
    },

    /**
     * One page of the learner's enrolled courses: the period cohort of the
     * report filters ('report_filter', needs `range`) or their whole history
     * ('learner_history'). The latest enrollment of each course counts.
     */
    async selectScopedLearnerCourses(
      input: { tenantId: string; userId: string } & LearnerCoursesSource & ReportScopeIds & LearnerCoursesPage,
    ): Promise<LearnerCourseRow[]> {
      const { search, status } = input;
      const params: unknown[] = [];
      const sourceCte = scopedSourceCte(input, params);

      let paramIdx = params.length + 1;
      const filters: string[] = [];
      if (search.trim()) {
        filters.push(`cr.course_name ILIKE '%' || $${paramIdx} || '%'`);
        params.push(search.trim());
        paramIdx++;
      }
      const safeStatus = LEARNING_STATUSES.includes(status) ? status : 'all';
      if (safeStatus !== 'all') {
        filters.push(`cr.status = $${paramIdx}`);
        params.push(safeStatus);
        paramIdx++;
      }
      const whereSql = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
      params.push(input.limit, input.offset);

      const result = await db.query<LearnerCourseRow>(
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
      return result.rows;
    },

    /**
     * One page of every course the learner can see (assigned to one of their
     * teams, in the org unit, or public) at `snapshotEndDate`, with their
     * progress: completed first, then in progress, then not started.
     */
    async selectVisibleLearnerCourses(
      input: { tenantId: string; userId: string; snapshotEndDate: Date } & ReportScopeIds & LearnerCoursesPage,
    ): Promise<LearnerCourseRow[]> {
      const { groupId, subgroupId, teamId, search, status } = input;
      const params: unknown[] = [input.tenantId, input.snapshotEndDate, input.userId];
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

      const safeStatus = LEARNING_STATUSES.includes(status) ? status : 'all';
      let statusFilter = '';
      if (safeStatus !== 'all') {
        statusFilter = `WHERE sub.status = $${paramIdx}`;
        params.push(safeStatus);
        paramIdx++;
      }

      params.push(input.limit, input.offset);
      const result = await db.query<LearnerCourseRow>(
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
      return result.rows;
    },

    /** Badges of one learner; name_override is the tenant's own display name for the badge, if it set one. */
    async selectUserBadges(username: string, tenantId: string): Promise<UserBadgeRow[]> {
      const result = await db.query<UserBadgeRow>(
        `SELECT ub.badge_id, ub.earned_at, NULLIF(BTRIM(tbs.name_override), '') AS name_override
     FROM user_badges ub
     JOIN users u ON u.id = ub.user_id
     LEFT JOIN tenant_badge_settings tbs ON tbs.tenant_id = u.tenant_id AND tbs.badge_id = ub.badge_id
     WHERE u.username = $1 AND u.tenant_id = $2
     ORDER BY ub.earned_at DESC`,
        [username, tenantId],
      );
      return result.rows;
    },

    /** The id of a user of the tenant by username (any role, active or not). */
    async findUserId(username: string, tenantId: string): Promise<{ id: string } | undefined> {
      const userResult = await db.query<{ id: string }>(
        `SELECT id FROM users WHERE username = $1 AND tenant_id = $2 LIMIT 1`,
        [username, tenantId],
      );
      return userResult.rows[0];
    },

    /** Rebuilds the shared report summary of every tenant; a failure rejects. */
    async refreshSummary(): Promise<void> {
      await db.query<Record<string, unknown>>('SELECT refresh_report_summary()', []);
    },
  };
}

export type ReportLearnersRepository = ReturnType<typeof createReportLearnersRepository>;
