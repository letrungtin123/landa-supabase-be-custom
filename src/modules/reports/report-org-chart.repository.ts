// SQL of the legacy yearly chart grouped by org unit. Every unit of the chart
// is read by ONE grouped statement (GROUP BY unit, month) instead of one
// statement per unit. Each metric keeps the filters, joins and arithmetic of
// the former per-unit statement (reports.service.ts batchMetricByMonth /
// batchMetricByMonthTeam), so every unit gets the same numbers as before.

import { reportsQuery } from '../../config/reports-database.js';
import type { OrgChartDimension, OrgChartEntity, OrgChartMonthValue } from './report-org-chart.logic.js';
import { buildActiveLearnerEventsCte, buildReportEnrollmentCte, buildReportLearnerRosterCte } from './reports.service.js';

/**
 * The units of the chart, with the former loop's statements and order. The
 * group statement with a group id keeps its old text: `og` is not defined
 * there, so that call fails as it did before this change (reported, not fixed here).
 */
export async function loadOrgChartEntities(
  tenantId: string,
  dimension: OrgChartDimension,
  parentId?: string,
): Promise<OrgChartEntity[]> {
  if (dimension === 'group') {
    const gFilter = parentId ? 'AND og.id = $2' : '';
    const gParams = parentId ? [tenantId, parentId] : [tenantId];
    const orgs = await reportsQuery<OrgChartEntity>(
      `SELECT id, name FROM org_groups WHERE tenant_id = $1 ${gFilter} ORDER BY name`,
      gParams,
    );
    return orgs.rows;
  }
  if (dimension === 'subgroup') {
    const sgs = await reportsQuery<OrgChartEntity>(
      `SELECT id, name FROM sub_groups WHERE org_group_id = $1 ORDER BY name`,
      [parentId],
    );
    return sgs.rows;
  }
  const teams = await reportsQuery<OrgChartEntity>(
    `SELECT id, name FROM teams WHERE sub_group_id = $1 ORDER BY name`,
    [parentId],
  );
  return teams.rows;
}

/** How a learner belongs to a unit: the joins after team_members and the unit id. */
const MEMBERSHIP: Record<OrgChartDimension, { afterTeamMembers: string; unitIdSql: string }> = {
  group: {
    afterTeamMembers: 'JOIN teams t ON t.id = tm.team_id JOIN sub_groups sg ON sg.id = t.sub_group_id',
    unitIdSql: 'sg.org_group_id',
  },
  subgroup: {
    afterTeamMembers: 'JOIN teams t ON t.id = tm.team_id',
    unitIdSql: 't.sub_group_id',
  },
  team: {
    afterTeamMembers: '',
    unitIdSql: 'tm.team_id',
  },
};

function membershipJoins(dimension: OrgChartDimension, userIdSql: string): string {
  return `JOIN team_members tm ON tm.user_id = ${userIdSql} ${MEMBERSHIP[dimension].afterTeamMembers}`;
}

function groupedMetricSql(metric: string, dimension: OrgChartDimension): string | null {
  const unit = MEMBERSHIP[dimension].unitIdSql;
  switch (metric) {
    case 'total_learners':
      // Learners created up to the end of each month (cumulative). $2 year, $3 units.
      return `SELECT ${unit} AS entity_id, gs.m, COUNT(DISTINCT u.id) AS value
        FROM generate_series(1, 12) AS gs(m)
        JOIN users u ON u.tenant_id = $1
          AND u.is_active = true AND u.role IN ('learner', 'learner_plus')
          AND u.created_at <= (make_date($2, gs.m::INT, 1) + INTERVAL '1 month' - INTERVAL '1 second')
        ${membershipJoins(dimension, 'u.id')}
        WHERE ${unit} = ANY($3::uuid[])
        GROUP BY ${unit}, gs.m`;
    case 'active_learners':
      // $2/$3 year bounds, $4 units.
      return `WITH ${buildActiveLearnerEventsCte({ tenantParam: '$1', rangeStartParam: '$2', rangeEndParam: '$3' })}
        SELECT ${unit} AS entity_id,
               EXTRACT(MONTH FROM ae.activity_date)::INT AS m,
               COUNT(DISTINCT ae.user_id) AS value
        FROM active_learner_events ae
        JOIN users u ON u.id = ae.user_id
        ${membershipJoins(dimension, 'ae.user_id')}
        WHERE u.tenant_id = $1
          AND u.is_active = true
          AND u.role IN ('learner', 'learner_plus')
          AND u.created_at <= $3
          AND ${unit} = ANY($4::uuid[])
        GROUP BY ${unit}, EXTRACT(MONTH FROM ae.activity_date)`;
    case 'completion_rate': {
      // Per unit: SUM of each member's average progress of the month over the
      // unit's learner count. Members are DISTINCT, like the former EXISTS scope.
      const cohort = buildReportEnrollmentCte({ tenantParam: '$1', rangeStartParam: '$2', rangeEndParam: '$3', scopeParamStart: 4 });
      const roster = buildReportLearnerRosterCte({ tenantParam: '$1', scopeParamStart: 4 });
      return `WITH ${cohort.sql},
          ${roster.sql},
          entity_members AS (
            SELECT DISTINCT ${unit} AS entity_id, tm.user_id
            FROM team_members tm ${MEMBERSHIP[dimension].afterTeamMembers}
            WHERE ${unit} = ANY($4::uuid[])
          ),
          roster_size AS (
            SELECT em.entity_id, COUNT(*)::numeric AS learner_count
            FROM report_learners rl
            JOIN entity_members em ON em.user_id = rl.user_id
            GROUP BY em.entity_id
          ),
          learner_month AS (
            SELECT
              em.entity_id,
              EXTRACT(MONTH FROM re.enrolled_at)::INT AS m,
              re.user_id,
              COALESCE(ROUND(AVG(re.progress), 2), 0) AS completion_rate
            FROM report_enrollments re
            JOIN entity_members em ON em.user_id = re.user_id
            GROUP BY em.entity_id, EXTRACT(MONTH FROM re.enrolled_at), re.user_id
          )
        SELECT
          lm.entity_id,
          lm.m,
          COALESCE(ROUND(SUM(lm.completion_rate) / NULLIF(MAX(rs.learner_count), 0), 2), 0) AS value
        FROM learner_month lm
        LEFT JOIN roster_size rs ON rs.entity_id = lm.entity_id
        GROUP BY lm.entity_id, lm.m`;
    }
    case 'total_enrollments':
      // Group/branch counted DISTINCT enrollments, a department counted join rows.
      return `SELECT ${unit} AS entity_id,
               EXTRACT(MONTH FROM e.enrolled_at)::INT AS m,
               ${dimension === 'team' ? 'COUNT(e.id)' : 'COUNT(DISTINCT e.id)'} AS value
        FROM enrollments e
        ${membershipJoins(dimension, 'e.user_id')}
        WHERE e.tenant_id = $1 AND e.is_active = true
          AND e.enrolled_at >= $2 AND e.enrolled_at <= $3
          AND ${unit} = ANY($4::uuid[])
        GROUP BY ${unit}, EXTRACT(MONTH FROM e.enrolled_at)`;
    default:
      return null;
  }
}

/** Month values of every unit in one statement; an unknown metric has none (as before). */
export async function loadOrgChartMonthValues(input: {
  tenantId: string;
  metric: string;
  dimension: OrgChartDimension;
  entityIds: string[];
  year: number;
  yearStart: Date;
  yearEnd: Date;
}): Promise<OrgChartMonthValue[]> {
  const sql = groupedMetricSql(input.metric, input.dimension);
  if (!sql || input.entityIds.length === 0) return [];
  const params = input.metric === 'total_learners'
    ? [input.tenantId, input.year, input.entityIds]
    : [input.tenantId, input.yearStart, input.yearEnd, input.entityIds];
  const result = await reportsQuery<{ entity_id: string; m: number; value: string }>(sql, params);
  const parse = input.metric === 'completion_rate'
    ? (value: string) => parseFloat(value) || 0
    : (value: string) => parseInt(value, 10);
  return result.rows.map((row) => ({ entityId: row.entity_id, month: row.m, value: parse(row.value) }));
}
