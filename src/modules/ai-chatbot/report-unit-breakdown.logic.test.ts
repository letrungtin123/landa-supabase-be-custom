import assert from 'node:assert/strict';
import test from 'node:test';
import type { ReportScope } from '../reports/report-access.service.js';
import {
  buildReportSnapshotExtensions,
  createReportSnapshot,
  isStoredReportChatSnapshot,
} from './report-chat.service.js';
import {
  REPORT_UNIT_BREAKDOWN_LIMIT,
  REPORT_UNIT_OTHERS_ID,
  REPORT_UNIT_UNASSIGNED_ID,
  buildReportUnitBreakdownQuery,
  buildReportUnitBreakdownSection,
  resolveReportUnitBreakdownPlan,
  toReportUnitBreakdown,
  type ReportUnitBreakdownQueryInput,
  type ReportUnitBreakdownQueryRow,
} from './report-unit-breakdown.logic.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const GROUP = '22222222-2222-4222-8222-222222222222';
const SUBGROUP = '33333333-3333-4333-8333-333333333333';
const TEAM = '44444444-4444-4444-8444-444444444444';
const range = { startDate: new Date('2026-06-30T17:00:00.000Z'), endDate: new Date('2026-07-31T16:59:59.999Z') };
const previousRange = { startDate: new Date('2026-05-31T17:00:00.000Z'), endDate: new Date('2026-06-30T16:59:59.999Z') };

function scope(input: Partial<ReportScope> = {}): ReportScope {
  return { groupId: undefined, subgroupId: undefined, teamId: undefined, allowedGroupIds: null, ...input };
}

function row(input: Partial<ReportUnitBreakdownQueryRow> & { kind: string }): ReportUnitBreakdownQueryRow {
  return {
    unit_id: null, name: null, learners: 10, active_learners: 5, enrollments: 20, completed_enrollments: 8,
    completion_rate: '55.50', previous_enrollments: 12, previous_completion_rate: '60.25', others_unit_count: 0, scope_learners: 40,
    ...input,
  };
}

test('breaks a scope down by its child level; a team has nothing below it', () => {
  assert.deepEqual(resolveReportUnitBreakdownPlan(scope()), { kind: 'breakdown', level: 'group', parentId: null });
  assert.deepEqual(resolveReportUnitBreakdownPlan(scope({ groupId: GROUP })), { kind: 'breakdown', level: 'subgroup', parentId: GROUP });
  assert.deepEqual(resolveReportUnitBreakdownPlan(scope({ groupId: GROUP, subgroupId: SUBGROUP })), { kind: 'breakdown', level: 'team', parentId: SUBGROUP });
  assert.deepEqual(resolveReportUnitBreakdownPlan(scope({ groupId: GROUP, subgroupId: SUBGROUP, teamId: TEAM })), { kind: 'leaf_scope' });
});

test('a learner_plus breakdown stays inside their own group', () => {
  assert.deepEqual(
    resolveReportUnitBreakdownPlan(scope({ groupId: GROUP, allowedGroupIds: [GROUP, 'other-group'] })),
    { kind: 'breakdown', level: 'subgroup', parentId: GROUP },
  );
  assert.deepEqual(
    resolveReportUnitBreakdownPlan(scope({ groupId: GROUP, subgroupId: SUBGROUP, allowedGroupIds: [GROUP] })),
    { kind: 'breakdown', level: 'team', parentId: SUBGROUP },
  );
  assert.deepEqual(resolveReportUnitBreakdownPlan(scope({ allowedGroupIds: [] })), { kind: 'not_permitted' }, 'no group: no accessible scope');
  assert.deepEqual(resolveReportUnitBreakdownPlan(scope({ allowedGroupIds: [GROUP] })), { kind: 'not_permitted' }, 'never a tenant-wide list of groups');
  assert.deepEqual(resolveReportUnitBreakdownPlan(scope({ groupId: 'other-group', allowedGroupIds: [GROUP] })), { kind: 'not_permitted' });
});

const TENANT_TABLES = ['users', 'team_members', 'teams', 'sub_groups', 'org_groups', 'enrollments', 'course_progress', 'block_completions'];

function queryFor(level: 'group' | 'subgroup' | 'team', limit?: number) {
  const plan = level === 'group'
    ? { kind: 'breakdown' as const, level, parentId: null }
    : { kind: 'breakdown' as const, level, parentId: level === 'subgroup' ? GROUP : SUBGROUP };
  return buildReportUnitBreakdownQuery({ tenantId: TENANT, plan, range, previousRange, limit });
}

test('filters every table of the breakdown query by tenant', () => {
  for (const level of ['group', 'subgroup', 'team'] as const) {
    const { sql } = queryFor(level);
    const references = [...sql.matchAll(/\b(?:FROM|JOIN)\s+([a-z_]+)\s+([a-z_0-9]+)/g)]
      .filter((match) => TENANT_TABLES.includes(match[1]));
    assert.ok(references.length >= 8, `${level}: base tables are referenced`);
    for (const [, table, alias] of references) {
      assert.match(sql, new RegExp(`\\b${alias}\\.tenant_id = \\$1\\b`), `${level}: ${table} ${alias} has a tenant filter`);
    }
  }
});

test('passes the tenant, both periods, the unit cap and the parent unit as parameters', () => {
  const group = queryFor('group');
  assert.deepEqual(group.params, [TENANT, range.startDate, range.endDate, previousRange.startDate, previousRange.endDate, REPORT_UNIT_BREAKDOWN_LIMIT]);
  assert.ok(!group.sql.includes('$7'), 'a tenant-wide breakdown has no parent unit');
  const subgroup = queryFor('subgroup');
  assert.equal(subgroup.params[6], GROUP);
  assert.match(subgroup.sql, /sg\.org_group_id = \$7::uuid/);
  const team = queryFor('team');
  assert.equal(team.params[6], SUBGROUP);
  assert.match(team.sql, /t\.sub_group_id = \$7::uuid/);
  assert.equal(queryFor('group', 500).params[5], REPORT_UNIT_BREAKDOWN_LIMIT, 'the unit cap is bounded');
  assert.equal(queryFor('group', 0).params[5], 1);
  assert.throws(() => buildReportUnitBreakdownQuery({ tenantId: TENANT, plan: { kind: 'breakdown', level: 'team', parentId: null }, range, previousRange }));
});

test('computes units with the main report rules in one grouped statement', () => {
  const { sql } = queryFor('subgroup');
  // Same cohort and rate rules as buildReportEnrollmentCte + getReportSummary.
  assert.match(sql, /u\.role IN \('learner', 'learner_plus'\)/);
  assert.match(sql, /e\.is_active = true/);
  assert.match(sql, /cp\.completed_at <= \$3 THEN 100/);
  assert.match(sql, /cp\.completed_at <= \$5 THEN 100/);
  assert.match(sql, /LEAST\(GREATEST\(COALESCE\(cp\.progress, 0\), 0\), 99\.99\)/);
  assert.match(sql, /ROUND\(AVG\(x\.progress\) FILTER \(WHERE x\.source = 'current'\), 2\)/, 'learner rate rounded to 2 decimals');
  assert.match(sql, /ROUND\(AVG\(rate\), 2\)/, 'unit rate is the mean of learner rates');
  assert.match(sql, /bc\.completed_at >= \$2/);
  assert.match(sql, /HAVING bool_or\(x\.source = 'learner'\) AND bool_or\(x\.source = 'member'\)/, 'below the tenant only members of a child unit');
  assert.match(queryFor('group').sql, /HAVING bool_or\(x\.source = 'learner'\)\s*\n/, 'tenant-wide: every active learner');
  assert.match(sql, /position <= \$6/);
});

test('orders units by enrollments and keeps the others and no-unit rows last', () => {
  const breakdown = toReportUnitBreakdown([
    row({ kind: 'unassigned', learners: 3, enrollments: 4 }),
    row({ kind: 'unit', unit_id: 'u-b', name: '  Chi nhánh   Hà Nội ', enrollments: 30, learners: 12 }),
    row({ kind: 'others', learners: 9, enrollments: 11, others_unit_count: 14 }),
    row({ kind: 'unit', unit_id: 'u-a', name: 'Chi nhánh Đà Nẵng', enrollments: 30, learners: 15 }),
    row({ kind: 'unit', unit_id: 'u-c', name: 'Chi nhánh Cần Thơ', enrollments: '45', learners: '20', completion_rate: '101.7' }),
  ], 'subgroup');
  assert.ok(breakdown);
  assert.equal(breakdown.level, 'subgroup');
  assert.equal(breakdown.scope_learners, 40);
  assert.deepEqual(breakdown.rows.map((item) => [item.kind, item.unit_id]), [
    ['unit', 'u-c'], ['unit', 'u-a'], ['unit', 'u-b'], ['others', REPORT_UNIT_OTHERS_ID], ['unassigned', REPORT_UNIT_UNASSIGNED_ID],
  ]);
  assert.equal(breakdown.rows[0].completion_rate, 100, 'rates are clamped to 0..100');
  assert.equal(breakdown.rows[0].enrollments, 45, 'numeric strings are parsed');
  assert.equal(breakdown.rows[2].name, 'Chi nhánh Hà Nội');
  assert.equal(breakdown.rows[3].unit_count, 14);
  assert.equal(breakdown.rows[3].learners, 9);
});

test('drops an empty no-unit row, marks units without a comparison period as not comparable', () => {
  const breakdown = toReportUnitBreakdown([
    row({ kind: 'unit', unit_id: 'u-a', name: 'Team A', previous_enrollments: 0, previous_completion_rate: '0' }),
    row({ kind: 'unit', unit_id: 'u-b', name: '', learners: 2 }),
    row({ kind: 'unit', unit_id: 'u-empty', name: 'Team without learners', learners: 0 }),
    row({ kind: 'unassigned', learners: 0 }),
  ], 'team');
  assert.deepEqual(breakdown?.rows.map((item) => item.unit_id), ['u-a', 'u-b']);
  assert.equal(breakdown?.rows[0].previous_completion_rate, null);
  assert.equal(breakdown?.rows[1].previous_completion_rate, 60.25);
  assert.equal(breakdown?.rows[1].name, '—');
  assert.equal(toReportUnitBreakdown([row({ kind: 'unassigned', learners: 12 })], 'group'), null, 'no child unit with learners: no breakdown');
  assert.equal(toReportUnitBreakdown([], 'group'), null);
});

test('never queries a team scope or a scope the actor may not break down', async () => {
  const calls: ReportUnitBreakdownQueryInput[] = [];
  const load = async (input: ReportUnitBreakdownQueryInput) => {
    calls.push(input);
    return [row({ kind: 'unit', unit_id: 'u-a', name: 'Unit A' }), row({ kind: 'others', others_unit_count: 31 })];
  };
  const base = { tenantId: TENANT, range, previousRange, load };
  assert.deepEqual(await buildReportUnitBreakdownSection({ ...base, scope: scope({ groupId: GROUP, subgroupId: SUBGROUP, teamId: TEAM }) }), { unit_breakdown_status: 'leaf_scope' });
  assert.deepEqual(await buildReportUnitBreakdownSection({ ...base, scope: scope({ allowedGroupIds: [] }) }), { unit_breakdown_status: 'not_computed' });
  assert.deepEqual(await buildReportUnitBreakdownSection({ ...base, scope: scope({ allowedGroupIds: [GROUP] }) }), { unit_breakdown_status: 'not_computed' });
  assert.equal(calls.length, 0);

  const restricted = await buildReportUnitBreakdownSection({ ...base, scope: scope({ groupId: GROUP, allowedGroupIds: [GROUP] }) });
  assert.equal(restricted.unit_breakdown_status, 'available');
  assert.deepEqual(calls[0].plan, { kind: 'breakdown', level: 'subgroup', parentId: GROUP });
  assert.equal(calls[0].tenantId, TENANT);
  assert.equal(calls[0].limit, REPORT_UNIT_BREAKDOWN_LIMIT);
  assert.deepEqual(restricted.unit_breakdown?.rows.map((item) => [item.kind, item.unit_count ?? null]), [['unit', null], ['others', 31]]);

  const empty = await buildReportUnitBreakdownSection({ ...base, scope: scope(), load: async () => [row({ kind: 'unassigned' })] });
  assert.deepEqual(empty, { unit_breakdown_status: 'no_child_units' });
});

test('stores the breakdown and the comparison series as additive V2 snapshot fields', () => {
  const summary = {
    meta: { month: 7, year: 2026, month_label: '', is_current_month: false, date_from: '2026-07-01', date_to: '2026-07-31' },
    overview: { total_learners: 4, active_learners: 3, completion_rate: 50, total_enrollments: 9, completed_enrollments: 4, incomplete_enrollments: 5 },
  };
  const breakdown = toReportUnitBreakdown([row({ kind: 'unit', unit_id: 'u-a', name: 'Unit A' })], 'group')!;
  const extensions = buildReportSnapshotExtensions({
    previousEnrollmentTrend: [{ bucket: '2026-06-01', value: 2 }],
    previousActiveLearnerTrend: [],
    unitBreakdown: { unit_breakdown: breakdown, unit_breakdown_status: 'available' },
  });
  assert.deepEqual(Object.keys(extensions).sort(), ['previous_enrollment_trend', 'unit_breakdown', 'unit_breakdown_status'], 'an empty series is left out');
  const snapshot = createReportSnapshot(
    {
      version: 2, generated_at: '2026-08-01T00:00:00.000Z', timezone: 'Asia/Ho_Chi_Minh',
      filter: { date_from: '2026-07-01', date_to: '2026-07-31' }, scope: { groupId: undefined, subgroupId: undefined, teamId: undefined },
      comparison: { date_from: '2026-06-01', date_to: '2026-06-30', basis: 'calendar_month' },
    },
    summary, summary, [], [], [], { not_started: 1, in_progress: 4, completed: 4 }, {}, 'available', { granularity: 'day' }, undefined, extensions,
  );
  assert.equal(snapshot.version, 2, 'the dashboard card renders version 2 only');
  assert.deepEqual(snapshot.unit_breakdown, breakdown);
  assert.equal(snapshot.unit_breakdown_status, 'available');
  assert.deepEqual(snapshot.previous_enrollment_trend, [{ bucket: '2026-06-01', value: 2 }]);
  assert.equal(snapshot.previous_active_learner_trend, undefined);
  assert.equal(isStoredReportChatSnapshot(snapshot), true);
  assert.equal(isStoredReportChatSnapshot({ ...snapshot, unit_breakdown: [] }), false);
  const leaf = buildReportSnapshotExtensions({ unitBreakdown: { unit_breakdown_status: 'leaf_scope' } });
  assert.deepEqual(leaf, { unit_breakdown_status: 'leaf_scope' });
});
