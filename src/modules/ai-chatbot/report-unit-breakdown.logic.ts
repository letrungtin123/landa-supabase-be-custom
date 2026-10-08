// ═══════════════════════════════════════════════════════════════
// Per-unit breakdown of the report snapshot (no I/O).
//
// The breakdown lists the CHILD units of the applied scope: tenant -> groups,
// group -> subgroups, subgroup -> teams; a team has nothing below it. Every
// unit row is computed exactly like the main report filtered to that unit
// (same learner population, same date window, same Completion rate formula),
// so a learner who belongs to several units is counted in each of them. The
// whole breakdown is ONE grouped SQL statement, tenant-filtered on every table.
// ═══════════════════════════════════════════════════════════════
import { hasNoAccessibleReportScope, type ReportScope } from '../reports/report-access.service.js';

/** Units listed one by one (by enrollments); the rest is aggregated into one "other units" row. */
export const REPORT_UNIT_BREAKDOWN_LIMIT = 30;
/** Reserved ids of the aggregate rows (never a real unit id, which is a uuid). */
export const REPORT_UNIT_OTHERS_ID = '__others__';
export const REPORT_UNIT_UNASSIGNED_ID = '__unassigned__';

export type ReportUnitLevel = 'group' | 'subgroup' | 'team';
export type ReportUnitRowKind = 'unit' | 'others' | 'unassigned';
/**
 * Why a snapshot has (or has no) unit_breakdown. Absent on snapshots built
 * before the breakdown existed, which the PDF reports as a limitation.
 */
export type ReportUnitBreakdownStatus = 'available' | 'leaf_scope' | 'no_child_units' | 'not_computed';

export interface ReportUnitBreakdownRow {
  kind: ReportUnitRowKind;
  unit_id: string;
  /** Unit name; a neutral English fallback for aggregate rows (the PDF localizes them by kind). */
  name: string;
  /** Aggregate "others" row only: number of units it groups. */
  unit_count?: number;
  /** Active learner accounts (learner / learner_plus) of the unit: the N of the Completion rate. */
  learners: number;
  active_learners: number;
  enrollments: number;
  completed_enrollments: number;
  completion_rate: number;
  previous_enrollments: number;
  /** null when the unit had no enrollment in the comparison period (not comparable). */
  previous_completion_rate: number | null;
}

export interface ReportUnitBreakdown {
  level: ReportUnitLevel;
  /** Units listed individually before the "others" row. */
  limit: number;
  /** Distinct active learners of the whole scope (unit rows overlap when learners belong to several units). */
  scope_learners: number;
  rows: ReportUnitBreakdownRow[];
}

/** Units listed individually: 1 to REPORT_UNIT_BREAKDOWN_LIMIT. */
export function clampReportUnitBreakdownLimit(value: number | undefined): number {
  const limit = Math.floor(value ?? REPORT_UNIT_BREAKDOWN_LIMIT);
  return Number.isFinite(limit) ? Math.max(1, Math.min(REPORT_UNIT_BREAKDOWN_LIMIT, limit)) : REPORT_UNIT_BREAKDOWN_LIMIT;
}

export type ReportUnitBreakdownPlan =
  | { kind: 'breakdown'; level: ReportUnitLevel; parentId: string | null }
  | { kind: 'leaf_scope' }
  | { kind: 'not_permitted' };

/**
 * Child level of the applied scope. The scope comes from enforceReportScope,
 * so a learner_plus scope always names one of their groups; anything else
 * (no group, a group outside their list) gets no breakdown at all.
 */
export function resolveReportUnitBreakdownPlan(scope: ReportScope): ReportUnitBreakdownPlan {
  if (hasNoAccessibleReportScope(scope)) return { kind: 'not_permitted' };
  if (scope.teamId) return { kind: 'leaf_scope' };
  if (scope.allowedGroupIds !== null && (!scope.groupId || !scope.allowedGroupIds.includes(scope.groupId))) {
    return { kind: 'not_permitted' };
  }
  if (scope.subgroupId) return { kind: 'breakdown', level: 'team', parentId: scope.subgroupId };
  if (scope.groupId) return { kind: 'breakdown', level: 'subgroup', parentId: scope.groupId };
  return { kind: 'breakdown', level: 'group', parentId: null };
}

/**
 * SQL pieces of one level. `$1` is the tenant, `$7` the parent unit.
 * - childUnits: the child units of the scope (unit_id, unit_name).
 * - teamUnits: each team under the scope -> the child unit it belongs to.
 */
function levelSql(level: ReportUnitLevel): { childUnits: string; teamUnits: string } {
  if (level === 'group') {
    return {
      childUnits: `SELECT og.id AS unit_id, og.name::text AS unit_name
        FROM org_groups og
        WHERE og.tenant_id = $1`,
      teamUnits: `SELECT t.id AS team_id, cu.unit_id
        FROM teams t
        JOIN sub_groups sg ON sg.id = t.sub_group_id AND sg.tenant_id = $1
        JOIN child_units cu ON cu.unit_id = sg.org_group_id
        WHERE t.tenant_id = $1`,
    };
  }
  if (level === 'subgroup') {
    return {
      childUnits: `SELECT sg.id AS unit_id, sg.name::text AS unit_name
        FROM sub_groups sg
        JOIN org_groups og ON og.id = sg.org_group_id AND og.tenant_id = $1
        WHERE sg.tenant_id = $1
          AND sg.org_group_id = $7::uuid`,
      teamUnits: `SELECT t.id AS team_id, cu.unit_id
        FROM teams t
        JOIN child_units cu ON cu.unit_id = t.sub_group_id
        WHERE t.tenant_id = $1`,
    };
  }
  return {
    childUnits: `SELECT t.id AS unit_id, t.name::text AS unit_name
      FROM teams t
      JOIN sub_groups sg ON sg.id = t.sub_group_id AND sg.tenant_id = $1
      WHERE t.tenant_id = $1
        AND t.sub_group_id = $7::uuid`,
    teamUnits: `SELECT cu.unit_id AS team_id, cu.unit_id
      FROM child_units cu`,
  };
}

/**
 * Enrollments of one period with their progress, same rules as
 * buildReportEnrollmentCte (reports.service.ts): 100 when the course was
 * completed by the period end, else the current progress capped to [0, 99.99].
 */
function cohortRowsSql(source: 'current' | 'previous', startParam: string, endParam: string): string {
  return `SELECT
        e.user_id,
        '${source}'::text AS source,
        NULL::uuid AS unit_id,
        CASE
          WHEN cp.completed_at IS NOT NULL AND cp.completed_at <= ${endParam} THEN 100
          ELSE LEAST(GREATEST(COALESCE(cp.progress, 0), 0), 99.99)
        END AS progress,
        (cp.completed_at IS NOT NULL AND cp.completed_at <= ${endParam}) AS is_completed
      FROM enrollments e
      LEFT JOIN course_progress cp ON cp.enrollment_id = e.id AND cp.tenant_id = $1
      WHERE e.tenant_id = $1
        AND e.is_active = true
        AND e.enrolled_at >= ${startParam}
        AND e.enrolled_at <= ${endParam}`;
}

export interface ReportUnitBreakdownQueryInput {
  tenantId: string;
  plan: Extract<ReportUnitBreakdownPlan, { kind: 'breakdown' }>;
  range: { startDate: Date; endDate: Date };
  previousRange: { startDate: Date; endDate: Date };
  limit?: number;
}

/**
 * One statement for the whole breakdown (current + comparison period),
 * returning at most limit + 2 rows: the top `limit` units by enrollments, one
 * "others" row (distinct learners of the remaining units) and one row of
 * scope learners in no child unit.
 *
 * Per-learner figures come from ONE grouping of a UNION ALL of base-table
 * scans (learners, memberships, both cohorts, activity), so no step joins two
 * learner-sized intermediate results: the cost stays linear whatever the
 * planner estimates (the small org tables, filtered by tenant twice, are
 * estimated at about one row). Memberships are then unnested per unit and the
 * top units are matched through an array.
 */
export function buildReportUnitBreakdownQuery(input: ReportUnitBreakdownQueryInput): { sql: string; params: unknown[] } {
  const { level, parentId } = input.plan;
  if (level !== 'group' && !parentId) throw new Error(`A ${level} breakdown needs its parent unit id`);
  const limit = clampReportUnitBreakdownLimit(input.limit);
  const { childUnits, teamUnits } = levelSql(level);
  // Below the tenant the scope population is exactly the learners with at
  // least one child unit (a learner of group G is in a team of one of G's
  // subgroups) - the same set as buildLearnerScopeExists.
  const scopeFilter = level === 'group' ? '' : 'AND bool_or(x.source = \'member\')';
  const params: unknown[] = [
    input.tenantId,
    input.range.startDate, input.range.endDate,
    input.previousRange.startDate, input.previousRange.endDate,
    limit,
    ...(level === 'group' ? [] : [parentId]),
  ];
  const sql = `WITH child_units AS MATERIALIZED (
      ${childUnits}
    ),
    team_units AS MATERIALIZED (
      ${teamUnits}
    ),
    learner_stats AS MATERIALIZED (
      SELECT
        x.user_id,
        COALESCE(array_agg(DISTINCT x.unit_id) FILTER (WHERE x.unit_id IS NOT NULL), ARRAY[]::uuid[]) AS unit_ids,
        COUNT(*) FILTER (WHERE x.source = 'current') AS enrollments,
        COUNT(*) FILTER (WHERE x.source = 'current' AND x.is_completed) AS completed,
        COALESCE(ROUND(AVG(x.progress) FILTER (WHERE x.source = 'current'), 2), 0) AS rate,
        COUNT(*) FILTER (WHERE x.source = 'previous') AS previous_enrollments,
        COALESCE(ROUND(AVG(x.progress) FILTER (WHERE x.source = 'previous'), 2), 0) AS previous_rate,
        bool_or(x.source = 'active') AS is_active
      FROM (
        SELECT u.id AS user_id, 'learner'::text AS source, NULL::uuid AS unit_id, NULL::numeric AS progress, false AS is_completed
        FROM users u
        WHERE u.tenant_id = $1
          AND u.is_active = true
          AND u.role IN ('learner', 'learner_plus')
        UNION ALL
        SELECT tm.user_id, 'member', tu.unit_id, NULL, false
        FROM team_members tm
        JOIN team_units tu ON tu.team_id = tm.team_id
        WHERE tm.tenant_id = $1
        UNION ALL
        ${cohortRowsSql('current', '$2', '$3')}
        UNION ALL
        ${cohortRowsSql('previous', '$4', '$5')}
        UNION ALL
        SELECT active.user_id, 'active', NULL, NULL, false
        FROM (
          SELECT DISTINCT e.user_id
          FROM block_completions bc
          JOIN enrollments e ON e.id = bc.enrollment_id AND e.tenant_id = $1
          WHERE bc.tenant_id = $1
            AND bc.completed_at >= $2
            AND bc.completed_at <= $3
        ) active
      ) x
      GROUP BY x.user_id
      HAVING bool_or(x.source = 'learner') ${scopeFilter}
    ),
    member_stats AS MATERIALIZED (
      SELECT m.unit_id, ls.enrollments, ls.completed, ls.rate, ls.previous_enrollments, ls.previous_rate, ls.is_active
      FROM learner_stats ls
      CROSS JOIN LATERAL unnest(ls.unit_ids) AS m(unit_id)
    ),
    ranked_units AS MATERIALIZED (
      SELECT ut.unit_id, ROW_NUMBER() OVER (ORDER BY ut.enrollments DESC, ut.learners DESC, cu.unit_name, cu.unit_id) AS position
      FROM (
        SELECT unit_id, COUNT(*) AS learners, SUM(enrollments) AS enrollments
        FROM member_stats
        GROUP BY unit_id
      ) ut
      JOIN child_units cu ON cu.unit_id = ut.unit_id
    ),
    top_units AS MATERIALIZED (
      SELECT COALESCE(array_agg(unit_id), ARRAY[]::uuid[]) AS ids
      FROM ranked_units
      WHERE position <= $6
    ),
    buckets AS (
      SELECT 'unit'::text AS kind, ms.unit_id, ms.enrollments, ms.completed, ms.rate, ms.previous_enrollments, ms.previous_rate, ms.is_active
      FROM member_stats ms
      WHERE ms.unit_id = ANY ((SELECT ids FROM top_units)::uuid[])
      UNION ALL
      SELECT 'others', NULL::uuid, ls.enrollments, ls.completed, ls.rate, ls.previous_enrollments, ls.previous_rate, ls.is_active
      FROM learner_stats ls
      WHERE EXISTS (SELECT 1 FROM unnest(ls.unit_ids) AS x(unit_id) WHERE x.unit_id <> ALL ((SELECT ids FROM top_units)::uuid[]))
      UNION ALL
      SELECT 'unassigned', NULL::uuid, ls.enrollments, ls.completed, ls.rate, ls.previous_enrollments, ls.previous_rate, ls.is_active
      FROM learner_stats ls
      WHERE cardinality(ls.unit_ids) = 0
    ),
    aggregated AS (
      SELECT
        kind,
        unit_id,
        COUNT(*)::int AS learners,
        COUNT(*) FILTER (WHERE is_active)::int AS active_learners,
        COALESCE(SUM(enrollments), 0)::int AS enrollments,
        COALESCE(SUM(completed), 0)::int AS completed_enrollments,
        COALESCE(ROUND(AVG(rate), 2), 0)::text AS completion_rate,
        COALESCE(SUM(previous_enrollments), 0)::int AS previous_enrollments,
        COALESCE(ROUND(AVG(previous_rate), 2), 0)::text AS previous_completion_rate
      FROM buckets
      GROUP BY kind, unit_id
    )
    SELECT
      a.kind,
      a.unit_id::text AS unit_id,
      cu.unit_name AS name,
      a.learners,
      a.active_learners,
      a.enrollments,
      a.completed_enrollments,
      a.completion_rate,
      a.previous_enrollments,
      a.previous_completion_rate,
      (SELECT COUNT(*) FROM ranked_units WHERE position > $6)::int AS others_unit_count,
      (SELECT COUNT(*) FROM learner_stats)::int AS scope_learners
    FROM aggregated a
    LEFT JOIN child_units cu ON cu.unit_id = a.unit_id`;
  return { sql, params };
}


export interface ReportUnitBreakdownQueryRow {
  kind: string;
  unit_id: string | null;
  name: string | null;
  learners: number | string;
  active_learners: number | string;
  enrollments: number | string;
  completed_enrollments: number | string;
  completion_rate: number | string;
  previous_enrollments: number | string;
  previous_completion_rate: number | string;
  others_unit_count: number | string;
  scope_learners: number | string;
}

const toCount = (value: number | string | null | undefined) => {
  const parsed = Math.trunc(Number(value ?? 0));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};
const toRate = (value: number | string | null | undefined) => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.min(100, Math.max(0, Math.round(parsed * 100) / 100)) : 0;
};
const UNIT_NAME_MAX = 300;

function unitName(value: string | null): string {
  const name = Array.from((value ?? '').replace(/\s+/g, ' ').trim()).slice(0, UNIT_NAME_MAX).join('');
  return name || '—';
}

function toRow(row: ReportUnitBreakdownQueryRow, kind: ReportUnitRowKind): ReportUnitBreakdownRow {
  const previousEnrollments = toCount(row.previous_enrollments);
  return {
    kind,
    unit_id: kind === 'unit' ? String(row.unit_id) : kind === 'others' ? REPORT_UNIT_OTHERS_ID : REPORT_UNIT_UNASSIGNED_ID,
    name: kind === 'unit' ? unitName(row.name) : kind === 'others' ? 'Other units' : 'Other (not in any unit)',
    ...(kind === 'others' ? { unit_count: Math.max(1, toCount(row.others_unit_count)) } : {}),
    learners: toCount(row.learners),
    active_learners: toCount(row.active_learners),
    enrollments: toCount(row.enrollments),
    completed_enrollments: toCount(row.completed_enrollments),
    completion_rate: toRate(row.completion_rate),
    previous_enrollments: previousEnrollments,
    previous_completion_rate: previousEnrollments > 0 ? toRate(row.previous_completion_rate) : null,
  };
}

export interface ReportUnitBreakdownSection {
  unit_breakdown?: ReportUnitBreakdown;
  unit_breakdown_status: ReportUnitBreakdownStatus;
}

/**
 * Breakdown part of a snapshot. The loader runs the grouped query (injected so
 * this stays free of I/O); it is never called for a team scope or a scope the
 * actor may not break down.
 */
export async function buildReportUnitBreakdownSection(input: {
  tenantId: string;
  scope: ReportScope;
  range: { startDate: Date; endDate: Date };
  previousRange: { startDate: Date; endDate: Date };
  limit?: number;
  load: (query: ReportUnitBreakdownQueryInput) => Promise<ReportUnitBreakdownQueryRow[]>;
}): Promise<ReportUnitBreakdownSection> {
  const plan = resolveReportUnitBreakdownPlan(input.scope);
  if (plan.kind === 'leaf_scope') return { unit_breakdown_status: 'leaf_scope' };
  if (plan.kind === 'not_permitted') return { unit_breakdown_status: 'not_computed' };
  const limit = clampReportUnitBreakdownLimit(input.limit);
  const rows = await input.load({ tenantId: input.tenantId, plan, range: input.range, previousRange: input.previousRange, limit });
  const breakdown = toReportUnitBreakdown(rows, plan.level, limit);
  return breakdown ? { unit_breakdown: breakdown, unit_breakdown_status: 'available' } : { unit_breakdown_status: 'no_child_units' };
}

/**
 * Snapshot extension from the query rows: units by enrollments (then learners,
 * name), then "others" and "not in any unit" when they hold learners. null
 * when no child unit of the scope has an active learner.
 */
export function toReportUnitBreakdown(
  rows: ReportUnitBreakdownQueryRow[],
  level: ReportUnitLevel,
  requestedLimit?: number,
): ReportUnitBreakdown | null {
  const limit = clampReportUnitBreakdownLimit(requestedLimit);
  const units = rows
    .filter((row) => row.kind === 'unit' && row.unit_id && toCount(row.learners) > 0)
    .map((row) => toRow(row, 'unit'))
    .sort((left, right) => right.enrollments - left.enrollments || right.learners - left.learners
      || left.name.localeCompare(right.name) || left.unit_id.localeCompare(right.unit_id))
    .slice(0, limit);
  if (!units.length) return null;
  const aggregate = (kind: 'others' | 'unassigned') => {
    const row = rows.find((candidate) => candidate.kind === kind && toCount(candidate.learners) > 0);
    return row ? [toRow(row, kind)] : [];
  };
  return {
    level,
    limit,
    scope_learners: toCount(rows[0]?.scope_learners),
    rows: [...units, ...aggregate('others'), ...aggregate('unassigned')],
  };
}
