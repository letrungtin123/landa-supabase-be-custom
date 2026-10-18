import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

// H2: the yearly chart split by company / branch / department reads every
// unit with ONE grouped statement instead of one statement per unit, and
// returns exactly what the former per-unit loop returned. The legacy loop
// below is the old code (reports.service.ts before this change) with its
// per-unit statement replaced by the same fixture values.

const pg = await import('pg');
const { pool } = await import('../../config/database.js');
const { endReportsPool } = await import('../../config/reports-database.js');
const svc = await import('./reports.service.js');
const { buildOrgUnitChartPoints } = await import('./report-org-chart.logic.js');

test.after(async () => {
  await endReportsPool();
  await pool.end();
});

const TENANT = '11111111-1111-4111-8111-111111111111';
const GROUP = 'a0000000-0000-4000-8000-000000000001';
const SUBGROUP = 'b0000000-0000-4000-8000-000000000001';
const MONTH_LABELS = [
  '', 'Tháng 1', 'Tháng 2', 'Tháng 3', 'Tháng 4', 'Tháng 5', 'Tháng 6',
  'Tháng 7', 'Tháng 8', 'Tháng 9', 'Tháng 10', 'Tháng 11', 'Tháng 12',
];

type Unit = { id: string; name: string };
type Fixture = { units: Unit[]; values: Record<string, Record<string, Record<number, number>>> };

// Two units share a name, one has no data at all.
const FIXTURE: Fixture = {
  units: [
    { id: 'c0000000-0000-4000-8000-000000000001', name: 'Công ty Bắc' },
    { id: 'c0000000-0000-4000-8000-000000000002', name: 'Công ty Nam' },
    { id: 'c0000000-0000-4000-8000-000000000003', name: 'Công ty Bắc' },
    { id: 'c0000000-0000-4000-8000-000000000004', name: 'Công ty Trống' },
  ],
  values: {
    total_learners: {
      'c0000000-0000-4000-8000-000000000001': { 1: 4, 2: 6, 3: 9, 10: 12, 11: 15, 12: 15 },
      'c0000000-0000-4000-8000-000000000002': { 1: 1, 5: 3, 12: 8 },
      'c0000000-0000-4000-8000-000000000003': { 2: 2, 3: 2 },
    },
    active_learners: {
      'c0000000-0000-4000-8000-000000000001': { 3: 5, 9: 2 },
      'c0000000-0000-4000-8000-000000000002': { 1: 7, 11: 1 },
    },
    completion_rate: {
      'c0000000-0000-4000-8000-000000000001': { 1: 45.5, 4: 12.25, 12: 99.99 },
      'c0000000-0000-4000-8000-000000000003': { 4: 100 },
    },
    total_enrollments: {
      'c0000000-0000-4000-8000-000000000002': { 2: 30, 6: 11, 10: 4 },
      'c0000000-0000-4000-8000-000000000003': { 7: 2 },
    },
  },
};

function monthValues(fixture: Fixture, metric: string, unitId: string): Map<number, number> {
  return new Map(Object.entries(fixture.values[metric]?.[unitId] ?? {}).map(([month, value]) => [Number(month), value]));
}

/** reports.service.ts chartGroupedByOrg/SubGroup/Team before this change, per-unit statement → fixture. */
function legacyGroupedChart(fixture: Fixture, metric: string, maxMonth: number) {
  const unitMonthData = new Map<string, Map<number, number>>();
  for (const unit of fixture.units) {
    const mv = monthValues(fixture, metric, unit.id);
    unitMonthData.set(unit.name, mv);
  }
  const data: Array<Record<string, unknown>> = [];
  for (let m = 1; m <= 12; m++) {
    const point: Record<string, unknown> = { month: `T${m}`, month_label: MONTH_LABELS[m] };
    for (const unit of fixture.units) {
      point[unit.name] = m > maxMonth ? 0 : (unitMonthData.get(unit.name)?.get(m) ?? 0);
    }
    data.push(point);
  }
  return data;
}

/** The database answering the unit list and the grouped statement from the fixture. */
function installFixtureDb(t: TestContext, fixture: Fixture) {
  const statements: Array<{ text: string; params: unknown[] }> = [];
  t.mock.method(pg.default.Pool.prototype, 'query', async (text: string, params: unknown[] = []) => {
    statements.push({ text: text.replace(/\s+/g, ' ').trim(), params });
    if (/^SELECT id, name FROM (org_groups|sub_groups|teams)/.test(text)) return { rows: fixture.units, rowCount: fixture.units.length };
    const metric = Object.keys(fixture.values).find((name) => statementMetric(text) === name);
    const ids = params.find(Array.isArray) as string[];
    const rows = ids.flatMap((id) => Object.entries(fixture.values[metric!]?.[id] ?? {})
      .map(([month, value]) => ({ entity_id: id, m: Number(month), value: String(value) })));
    return { rows, rowCount: rows.length };
  });
  return statements;
}

function statementMetric(text: string): string {
  if (text.includes('generate_series(1, 12)')) return 'total_learners';
  if (text.includes('FROM active_learner_events ae')) return 'active_learners';
  if (text.includes('entity_members')) return 'completion_rate';
  return 'total_enrollments';
}

const now = new Date();
const YEARS = [now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1];
const maxMonthOf = (year: number) => (year > now.getFullYear() ? 0 : year === now.getFullYear() ? now.getMonth() + 1 : 12);
const DIMENSIONS = [
  { label: 'companies', groupId: undefined, subgroupId: undefined, groupByOrg: true },
  { label: 'branches of a company', groupId: GROUP, subgroupId: undefined, groupByOrg: false },
  { label: 'departments of a branch', groupId: GROUP, subgroupId: SUBGROUP, groupByOrg: false },
] as const;

for (const dimension of DIMENSIONS) {
  test(`yearly chart by ${dimension.label}: identical to the per-unit loop, in two statements`, async (t) => {
    const statements = installFixtureDb(t, FIXTURE);
    for (const year of YEARS) {
      for (const metric of ['total_learners', 'active_learners', 'completion_rate', 'total_enrollments']) {
        statements.length = 0;
        const result = await svc.getReportChart(TENANT, year, metric, dimension.groupId, dimension.subgroupId, undefined, dimension.groupByOrg, true);
        assert.deepStrictEqual(result, { year, metric, data: legacyGroupedChart(FIXTURE, metric, maxMonthOf(year)), is_grouped: true });
        assert.equal(statements.length, 2, `${metric} ${year}: the unit list and one grouped statement`);
        assert.match(statements[1].text, /= ANY\(\$\d+::uuid\[\]\)/);
        assert.deepEqual(statements[1].params.find(Array.isArray), FIXTURE.units.map((unit) => unit.id));
      }
    }
  });
}

test('an unknown metric reads the units only and charts zeros, as before', async (t) => {
  const statements = installFixtureDb(t, FIXTURE);
  const result = await svc.getReportChart(TENANT, now.getFullYear() - 1, 'not_a_metric', undefined, undefined, undefined, true, true);
  assert.deepStrictEqual(result.data, legacyGroupedChart(FIXTURE, 'not_a_metric', 12));
  assert.equal(statements.length, 1);
});

test('no units: no grouped statement and twelve label-only points', async (t) => {
  const statements = installFixtureDb(t, { units: [], values: {} });
  const result = await svc.getReportChart(TENANT, now.getFullYear() - 1, 'total_enrollments', GROUP, undefined, undefined, false, true);
  assert.deepStrictEqual(result.data, legacyGroupedChart({ units: [], values: {} }, 'total_enrollments', 12));
  assert.equal(statements.length, 1);
});

test('each grouped statement keeps the former per-unit filters and counting', async (t) => {
  const statements = installFixtureDb(t, FIXTURE);
  const year = now.getFullYear() - 1;
  const sqlFor = async (metric: string, groupId?: string, subgroupId?: string, groupByOrg = false) => {
    statements.length = 0;
    await svc.getReportChart(TENANT, year, metric, groupId, subgroupId, undefined, groupByOrg, true);
    return statements[1];
  };
  // A department counted join rows (team_members is unique per team and user); companies and branches DISTINCT enrollments.
  const teamEnrollments = await sqlFor('total_enrollments', GROUP, SUBGROUP);
  assert.match(teamEnrollments.text, /SELECT tm\.team_id AS entity_id, EXTRACT\(MONTH FROM e\.enrolled_at\)::INT AS m, COUNT\(e\.id\) AS value/);
  const companyEnrollments = await sqlFor('total_enrollments', undefined, undefined, true);
  assert.match(companyEnrollments.text, /SELECT sg\.org_group_id AS entity_id, .*COUNT\(DISTINCT e\.id\) AS value FROM enrollments e JOIN team_members tm ON tm\.user_id = e\.user_id JOIN teams t ON t\.id = tm\.team_id JOIN sub_groups sg ON sg\.id = t\.sub_group_id WHERE e\.tenant_id = \$1 AND e\.is_active = true AND e\.enrolled_at >= \$2 AND e\.enrolled_at <= \$3/);
  // Learners created up to each month end; the year is a parameter, the tenant always $1.
  const branchLearners = await sqlFor('total_learners', GROUP);
  assert.match(branchLearners.text, /JOIN users u ON u\.tenant_id = \$1 AND u\.is_active = true AND u\.role IN \('learner', 'learner_plus'\) AND u\.created_at <= \(make_date\(\$2, gs\.m::INT, 1\) \+ INTERVAL '1 month' - INTERVAL '1 second'\)/);
  assert.deepEqual(branchLearners.params.slice(0, 2), [TENANT, year]);
  // Completion rate: distinct members per unit, each unit's own learner count.
  const completion = await sqlFor('completion_rate', GROUP, SUBGROUP);
  assert.match(completion.text, /entity_members AS \( SELECT DISTINCT tm\.team_id AS entity_id, tm\.user_id FROM team_members tm WHERE tm\.team_id = ANY\(\$4::uuid\[\]\) \)/);
  assert.match(completion.text, /COALESCE\(ROUND\(SUM\(lm\.completion_rate\) \/ NULLIF\(MAX\(rs\.learner_count\), 0\), 2\), 0\) AS value/);
  const active = await sqlFor('active_learners', undefined, undefined, true);
  assert.match(active.text, /COUNT\(DISTINCT ae\.user_id\) AS value FROM active_learner_events ae JOIN users u ON u\.id = ae\.user_id JOIN team_members tm ON tm\.user_id = ae\.user_id/);
  assert.match(active.text, /AND u\.created_at <= \$3/);
});

test('the assembly keeps unit order and the last same-name unit, like the loop', () => {
  const points = buildOrgUnitChartPoints(
    [{ id: 'x', name: 'A' }, { id: 'y', name: 'B' }, { id: 'z', name: 'A' }],
    [{ entityId: 'x', month: 1, value: 5 }, { entityId: 'z', month: 1, value: 7 }, { entityId: 'y', month: 2, value: 3 }],
    1,
    MONTH_LABELS,
  );
  assert.deepStrictEqual(points[0], { month: 'T1', month_label: 'Tháng 1', A: 7, B: 0 });
  assert.deepStrictEqual(points[1], { month: 'T2', month_label: 'Tháng 2', A: 0, B: 0 });
  assert.deepStrictEqual(Object.keys(points[0]), ['month', 'month_label', 'A', 'B']);
  assert.equal(points.length, 12);
});
