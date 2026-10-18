// Report overview figures of several periods in ONE statement (the Excel
// monthly sheet: twelve months and the year so far). For each period the
// statement repeats getReportSummary()'s arithmetic (reports.service.ts):
// the same learner roster, enrollment cohort, completion rule, activity
// events and averages, only grouped by period instead of run per period.

import { reportsQuery } from '../../config/reports-database.js';
import { buildLearnerScopeExists, buildReportLearnerRosterCte } from './report-sql.js';
import type { ReportSummary } from './reports.service.js';

export interface ReportPeriodRange {
  startDate: Date;
  endDate: Date;
}

type OverviewRow = {
  idx: number;
  total_learners: string;
  active_learners: string;
  total_enrollments: string;
  completed_enrollments: string;
  incomplete_enrollments: string;
  completion_rate: string;
};

/** Overview of each range, in the order of `ranges`. */
export async function loadReportPeriodOverviews(input: {
  tenantId: string;
  ranges: readonly ReportPeriodRange[];
  groupId?: string;
  subgroupId?: string;
  teamId?: string;
}): Promise<Array<ReportSummary['overview']>> {
  if (input.ranges.length === 0) return [];
  const { groupId, subgroupId, teamId } = input;
  const learnerScope = buildLearnerScopeExists('u.id', groupId, subgroupId, teamId, 4);
  const enrollmentScope = buildLearnerScopeExists('e.user_id', groupId, subgroupId, teamId, 4);
  const roster = buildReportLearnerRosterCte({ tenantParam: '$1', groupId, subgroupId, teamId, scopeParamStart: 4 });

  const result = await reportsQuery<OverviewRow>(
    `WITH periods AS (
      SELECT p.idx::int AS idx, p.range_start, p.range_end
      FROM unnest($2::timestamptz[], $3::timestamptz[]) WITH ORDINALITY AS p(range_start, range_end, idx)
    ),
    ${roster.sql},
    period_enrollments AS (
      SELECT
        p.idx,
        e.id AS enrollment_id,
        e.user_id,
        CASE
          WHEN cp.completed_at IS NOT NULL AND cp.completed_at <= p.range_end THEN 100
          ELSE LEAST(GREATEST(COALESCE(cp.progress, 0), 0), 99.99)
        END AS progress,
        CASE
          WHEN cp.completed_at IS NOT NULL AND cp.completed_at <= p.range_end THEN true
          ELSE false
        END AS is_completed
      FROM periods p
      JOIN enrollments e ON e.tenant_id = $1
        AND e.is_active = true
        AND e.enrolled_at >= p.range_start
        AND e.enrolled_at <= p.range_end
      JOIN users u ON u.id = e.user_id
        AND u.tenant_id = $1
        AND u.is_active = true
        AND u.role IN ('learner', 'learner_plus')
      LEFT JOIN course_progress cp ON cp.enrollment_id = e.id
      WHERE true
        ${enrollmentScope.sql}
    ),
    learner_completion AS (
      SELECT
        p.idx,
        rl.user_id,
        COUNT(pe.enrollment_id)::bigint AS total_enrollments,
        COUNT(pe.enrollment_id) FILTER (WHERE pe.is_completed)::bigint AS completed_enrollments,
        COALESCE(ROUND(AVG(pe.progress), 2), 0) AS completion_rate
      FROM periods p
      CROSS JOIN report_learners rl
      LEFT JOIN period_enrollments pe ON pe.idx = p.idx AND pe.user_id = rl.user_id
      GROUP BY p.idx, rl.user_id
    ),
    completion AS (
      SELECT
        lc.idx,
        COALESCE(SUM(lc.total_enrollments), 0)::bigint AS total_enrollments,
        COALESCE(SUM(lc.completed_enrollments), 0)::bigint AS completed_enrollments,
        COALESCE(SUM(lc.total_enrollments - lc.completed_enrollments), 0)::bigint AS incomplete_enrollments,
        COALESCE(ROUND(AVG(lc.completion_rate), 2), 0) AS completion_rate
      FROM learner_completion lc
      GROUP BY lc.idx
    ),
    created AS (
      SELECT p.idx, COUNT(*)::bigint AS total_learners
      FROM periods p
      JOIN users u ON u.tenant_id = $1
        AND u.is_active = true
        AND u.role IN ('learner', 'learner_plus')
        AND u.created_at >= p.range_start
        AND u.created_at <= p.range_end
      WHERE true
        ${learnerScope.sql}
      GROUP BY p.idx
    ),
    active AS (
      SELECT p.idx, COUNT(DISTINCT e.user_id)::bigint AS active_learners
      FROM periods p
      JOIN block_completions bc ON bc.completed_at >= p.range_start AND bc.completed_at <= p.range_end
      JOIN enrollments e ON e.id = bc.enrollment_id AND e.tenant_id = $1
      JOIN users u ON u.id = e.user_id
      WHERE u.tenant_id = $1
        AND u.is_active = true
        AND u.role IN ('learner', 'learner_plus')
        ${learnerScope.sql}
      GROUP BY p.idx
    )
    SELECT
      p.idx,
      COALESCE(cr.total_learners, 0)::bigint AS total_learners,
      COALESCE(ac.active_learners, 0)::bigint AS active_learners,
      COALESCE(c.total_enrollments, 0)::bigint AS total_enrollments,
      COALESCE(c.completed_enrollments, 0)::bigint AS completed_enrollments,
      COALESCE(c.incomplete_enrollments, 0)::bigint AS incomplete_enrollments,
      COALESCE(c.completion_rate, 0) AS completion_rate
    FROM periods p
    LEFT JOIN created cr ON cr.idx = p.idx
    LEFT JOIN active ac ON ac.idx = p.idx
    LEFT JOIN completion c ON c.idx = p.idx
    ORDER BY p.idx`,
    [
      input.tenantId,
      input.ranges.map((range) => range.startDate),
      input.ranges.map((range) => range.endDate),
      ...learnerScope.params,
    ],
  );

  const byIndex = new Map(result.rows.map((row) => [Number(row.idx), row]));
  return input.ranges.map((_range, index) => {
    const row = byIndex.get(index + 1);
    return {
      total_learners: parseInt(row?.total_learners ?? '0', 10),
      active_learners: parseInt(row?.active_learners ?? '0', 10),
      completion_rate: parseFloat(row?.completion_rate ?? '0'),
      total_enrollments: parseInt(row?.total_enrollments ?? '0', 10),
      completed_enrollments: parseInt(row?.completed_enrollments ?? '0', 10),
      incomplete_enrollments: parseInt(row?.incomplete_enrollments ?? '0', 10),
    };
  });
}
