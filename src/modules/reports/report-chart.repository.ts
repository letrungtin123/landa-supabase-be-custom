// ═══════════════════════════════════════════════════════════════
// Report summary and chart repository: the statements behind the summary
// cards, the date-range charts and the yearly charts of the Reports page.
// SQL only; moved unchanged from reports.service.ts, which keeps the period
// rules, caching and the mapping of rows to answers.
// ═══════════════════════════════════════════════════════════════

import {
  buildActiveLearnerEventsCte,
  buildGroupFilter,
  buildLearnerScopeExists,
  buildReportEnrollmentCte,
  buildReportLearnerRosterCte,
  buildUserGroupFilter,
} from './report-sql.js';
import type { ReportBucketGranularity, ReportPeriodBounds, ReportScopeIds, ReportsDb } from './reports.types.js';

export type GroupedEnrollmentDimension = 'group' | 'subgroup' | 'team';

export interface ReportSummaryRow {
  total_learners: string;
  active_learners: string;
  total_enrollments: string;
  completed_enrollments: string;
  incomplete_enrollments: string;
  completion_rate: string;
}

export interface ReportBucketRow {
  bucket: string;
  bucket_label: string;
  value: string;
}

export interface ReportSeriesBucketRow extends ReportBucketRow {
  series_name: string;
}

export interface ReportMonthCountRow {
  m: number;
  cnt: string;
}

export interface ReportMonthRateRow {
  m: number;
  completion_rate: string;
}

/** A year of the yearly chart: its bounds and the year itself (cumulative counts). */
export interface ReportYearInput {
  tenantId: string;
  yearStart: Date;
  yearEnd: Date;
  year: number;
}

function getGranularityStep(granularity: ReportBucketGranularity): string {
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

/** Learners created in each bucket. $1 tenant, $2/$3 range, $4 granularity, $5 step, $6 scope. */
function learnersCreatedByBucketSql(scopeSql: string, labelSql: string): string {
  return `WITH ${getBucketCteSql()},
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
          ${scopeSql}
        GROUP BY bucket_start
      )
      SELECT
        to_char(b.bucket_start, 'YYYY-MM-DD') AS bucket,
        ${labelSql} AS bucket_label,
        COALESCE(cbb.value, 0)::bigint AS value
      FROM buckets b
      LEFT JOIN created_by_bucket cbb ON cbb.bucket_start = b.bucket_start
      ORDER BY b.bucket_start`;
}

/** Learners with learning activity in each bucket. Same parameters. */
function activeLearnersByBucketSql(scopeSql: string, labelSql: string): string {
  return `WITH ${getBucketCteSql()},
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
          ${scopeSql}
        GROUP BY bucket_start
      )
      SELECT
        to_char(b.bucket_start, 'YYYY-MM-DD') AS bucket,
        ${labelSql} AS bucket_label,
        COALESCE(abb.value, 0)::bigint AS value
      FROM buckets b
      LEFT JOIN active_by_bucket abb ON abb.bucket_start = b.bucket_start
      ORDER BY b.bucket_start`;
}

/** Enrollments, or the learners' average completion, of each bucket's cohort. */
function cohortByBucketSql(metric: string, cohortSql: string, rosterSql: string, labelSql: string): string {
  return `WITH ${getBucketCteSql()},
      ${cohortSql},
      ${rosterSql},
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
}

/** The org unit part of the grouped enrollment chart; pushes its parameters onto `params`. */
function groupedDimensionSql(dimension: GroupedEnrollmentDimension, parentId: string | undefined, params: unknown[]) {
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
  return { entitySql, dimensionIdSql, dimensionWhereSql, unassignedCteSql, unassignedUnionSql };
}

export function createReportChartRepository(db: ReportsDb) {
  return {
    /** The summary cards of a period: learners, active learners and the enrollment cohort. */
    async selectSummary(input: { tenantId: string; range: ReportPeriodBounds } & ReportScopeIds): Promise<ReportSummaryRow | undefined> {
      const { tenantId, range, groupId, subgroupId, teamId } = input;
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

      const result = await db.query<ReportSummaryRow>(
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
      return result.rows[0];
    },

    /** One value per bucket of the range for the metric (an unknown metric reads the enrollments). */
    async selectRangeBuckets(
      input: { tenantId: string; metric: string; range: ReportPeriodBounds; granularity: ReportBucketGranularity } & ReportScopeIds,
    ): Promise<ReportBucketRow[]> {
      const { tenantId, metric, range, granularity, groupId, subgroupId, teamId } = input;
      const step = getGranularityStep(granularity);
      const labelSql = getBucketLabelSql();
      const scopeAlias = metric === 'total_learners' || metric === 'active_learners' ? 'u.id' : 'e.user_id';
      const scope = buildLearnerScopeExists(scopeAlias, groupId, subgroupId, teamId, 6);
      const params: unknown[] = [tenantId, range.startDate, range.endDate, granularity, step, ...scope.params];

      let sql: string;
      if (metric === 'total_learners') {
        sql = learnersCreatedByBucketSql(scope.sql, labelSql);
      } else if (metric === 'active_learners') {
        sql = activeLearnersByBucketSql(scope.sql, labelSql);
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
        sql = cohortByBucketSql(metric, cohort.sql, roster.sql, labelSql);
        params.splice(5, scope.params.length, ...cohort.params);
      }

      const result = await db.query<ReportBucketRow>(sql, params);
      return result.rows;
    },

    /**
     * Enrollments of each bucket split by the org units under the parent: the
     * `seriesLimit` biggest units, then 'Khác' for the rest (and 'Chưa phân
     * nhóm' for learners outside every group when no parent is set).
     */
    async selectGroupedEnrollmentBuckets(input: {
      tenantId: string;
      range: ReportPeriodBounds;
      granularity: ReportBucketGranularity;
      dimension: GroupedEnrollmentDimension;
      parentId?: string;
      seriesLimit: number;
    }): Promise<ReportSeriesBucketRow[]> {
      const { tenantId, range, granularity, dimension, parentId } = input;
      const step = getGranularityStep(granularity);
      const params: unknown[] = [tenantId, range.startDate, range.endDate, granularity, step];
      const { entitySql, dimensionIdSql, dimensionWhereSql, unassignedCteSql, unassignedUnionSql } =
        groupedDimensionSql(dimension, parentId, params);

      params.push(input.seriesLimit);
      const limitParam = `$${params.length}`;
      const labelSql = getBucketLabelSql('sr.bucket_start');
      const result = await db.query<ReportSeriesBucketRow>(
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
      return result.rows;
    },

    // ── Yearly chart, one statement for the 12 months (group or subgroup scope) ──

    /** Learners created up to the end of each month (cumulative). */
    async selectYearLearnersByMonth(input: ReportYearInput & Pick<ReportScopeIds, 'groupId' | 'subgroupId'>): Promise<ReportMonthCountRow[]> {
      const { tenantId, year, groupId, subgroupId } = input;
      const ugf = buildUserGroupFilter(groupId, subgroupId);
      let idx = 2;
      const conds = ugf.conditions.map(c => c.replace('$PARAM', `$${idx++}`));
      const r = await db.query<ReportMonthCountRow>(
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
      return r.rows;
    },

    async selectYearActiveLearnersByMonth(
      input: ReportYearInput & Pick<ReportScopeIds, 'groupId' | 'subgroupId'>,
    ): Promise<ReportMonthCountRow[]> {
      const { tenantId, yearStart, yearEnd, groupId, subgroupId } = input;
      const activeScope = buildLearnerScopeExists('u.id', groupId, subgroupId, undefined, 4);
      const r = await db.query<ReportMonthCountRow>(
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
      return r.rows;
    },

    /** The learners' average completion of each month's cohort (group, subgroup or team scope). */
    async selectYearCompletionRateByMonth(input: ReportYearInput & ReportScopeIds): Promise<ReportMonthRateRow[]> {
      const { tenantId, yearStart, yearEnd, groupId, subgroupId, teamId } = input;
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
      const r = await db.query<ReportMonthRateRow>(
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
      return r.rows;
    },

    async selectYearEnrollmentsByMonth(
      input: ReportYearInput & Pick<ReportScopeIds, 'groupId' | 'subgroupId'>,
    ): Promise<ReportMonthCountRow[]> {
      const { tenantId, yearStart, yearEnd, groupId, subgroupId } = input;
      const egf = buildGroupFilter(groupId, subgroupId);
      let idx = 2;
      const conds = egf.conditions.map(c => c.replace('$PARAM', `$${idx++}`));
      const r = await db.query<ReportMonthCountRow>(
        `SELECT EXTRACT(MONTH FROM e.enrolled_at)::INT AS m,
                COUNT(DISTINCT e.id) AS cnt
         FROM enrollments e ${egf.joins}
         WHERE e.tenant_id = $1 AND e.is_active = true
           AND e.enrolled_at >= $${idx} AND e.enrolled_at <= $${idx + 1}
           ${conds.length ? 'AND ' + conds.join(' AND ') : ''}
         GROUP BY EXTRACT(MONTH FROM e.enrolled_at)`,
        [tenantId, ...egf.params, yearStart, yearEnd],
      );
      return r.rows;
    },

    // ── Yearly chart of one team ──

    async selectTeamYearLearnersByMonth(input: ReportYearInput & { teamId: string }): Promise<ReportMonthCountRow[]> {
      const r = await db.query<ReportMonthCountRow>(
        `SELECT gs.m,
                COUNT(DISTINCT u.id) AS cnt
         FROM generate_series(1, 12) AS gs(m)
         LEFT JOIN users u ON u.tenant_id = $1
           AND u.is_active = true AND u.role IN ('learner', 'learner_plus')
           AND u.created_at <= (make_date($2, gs.m::INT, 1) + INTERVAL '1 month' - INTERVAL '1 second')
         LEFT JOIN team_members tm ON tm.user_id = u.id AND tm.team_id = $3
         WHERE (u.id IS NULL OR tm.user_id IS NOT NULL)
         GROUP BY gs.m ORDER BY gs.m`,
        [input.tenantId, input.year, input.teamId],
      );
      return r.rows;
    },

    async selectTeamYearActiveLearnersByMonth(input: ReportYearInput & { teamId: string }): Promise<ReportMonthCountRow[]> {
      const r = await db.query<ReportMonthCountRow>(
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
        [input.tenantId, input.yearStart, input.yearEnd, input.teamId],
      );
      return r.rows;
    },

    async selectTeamYearEnrollmentsByMonth(input: ReportYearInput & { teamId: string }): Promise<ReportMonthCountRow[]> {
      const r = await db.query<ReportMonthCountRow>(
        `SELECT EXTRACT(MONTH FROM e.enrolled_at)::INT AS m,
                COUNT(e.id) AS cnt
         FROM enrollments e
         JOIN team_members tm ON tm.user_id = e.user_id
         WHERE e.tenant_id = $1 AND e.is_active = true AND tm.team_id = $2
           AND e.enrolled_at >= $3 AND e.enrolled_at <= $4
         GROUP BY EXTRACT(MONTH FROM e.enrolled_at)`,
        [input.tenantId, input.teamId, input.yearStart, input.yearEnd],
      );
      return r.rows;
    },
  };
}

export type ReportChartRepository = ReturnType<typeof createReportChartRepository>;
