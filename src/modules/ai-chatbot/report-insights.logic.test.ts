import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildReportInsights,
  countReportBucketEquivalents,
  countReportBuckets,
  detectReportTrendAnomaly,
  isReportPercentChangeMeaningful,
  REPORT_INSIGHT_THRESHOLDS,
} from './report-insights.logic.js';
import {
  allReportPdfFixtures,
  emptyReportFixture,
  englishExtendedReportFixture,
  englishReportFixture,
  legacyReportFixture,
  longNamesReportFixture,
  manyUnitsReportFixture,
  smallBaseReportFixture,
  tinyReportFixture,
  vietnameseReportFixture,
  weeklyReportFixture,
} from './report-pdf.fixture.js';
import type { StoredReportChatSnapshot } from './report-chat.service.js';

const kpi = (snapshot: StoredReportChatSnapshot, id: string) => buildReportInsights(snapshot).kpis.find((item) => item.id === id)!;

test('computes period-over-period deltas with metric polarity', () => {
  const { snapshot } = vietnameseReportFixture();
  const enrollments = kpi(snapshot, 'total_enrollments');
  assert.equal(enrollments.current, 315);
  assert.equal(enrollments.previous, 262);
  assert.equal(enrollments.delta, 53);
  assert.equal(enrollments.deltaPercent, 20.23);
  assert.equal(enrollments.direction, 'up');
  assert.equal(enrollments.tone, 'positive');
  const rate = kpi(snapshot, 'completion_rate');
  assert.equal(rate.unit, 'percentage');
  assert.equal(rate.delta, 3.72);
  assert.equal(rate.deltaPercent, null);
  assert.equal(kpi(snapshot, 'incomplete_enrollments').tone, 'neutral', 'incomplete volume has no favourable direction');
});

test('treats small changes as stable using the versioned thresholds', () => {
  const snapshot = structuredClone(vietnameseReportFixture().snapshot);
  assert.equal(snapshot.version, 2);
  if (snapshot.version !== 2) return;
  snapshot.previous_summary.overview.total_enrollments = 312;
  snapshot.previous_summary.overview.completion_rate = 61.5;
  assert.equal(kpi(snapshot, 'total_enrollments').direction, 'flat');
  assert.equal(kpi(snapshot, 'total_enrollments').tone, 'neutral');
  assert.equal(kpi(snapshot, 'completion_rate').direction, 'flat');
  assert.ok(REPORT_INSIGHT_THRESHOLDS.stableRateDeltaPp > Math.abs(61.84 - 61.5));
});

test('derives the status mix, concentration and course rankings from the snapshot', () => {
  const insights = buildReportInsights(vietnameseReportFixture().snapshot);
  assert.deepEqual(insights.statusMix, { completed: 194, inProgress: 79, notStarted: 42, total: 315, completedShare: 61.59, inProgressShare: 25.08, notStartedShare: 13.33 });
  assert.equal(insights.courses.topN, 3);
  assert.equal(insights.courses.topShare, 46.35);
  assert.equal(insights.courses.top1Share, 18.41);
  assert.equal(insights.courses.coverageShare, 100);
  assert.equal(insights.courses.truncated, false);
  assert.deepEqual(insights.courses.topPerformers.map((row) => row.completionRate), [100, 93.1, 86.9]);
  assert.deepEqual(insights.courses.lowPerformers.map((row) => row.completionRate), [38.7, 41.3, 49.6]);
  assert.ok(insights.courses.lowPerformers.every((row) => row.enrollments >= REPORT_INSIGHT_THRESHOLDS.minimumCourseSample), 'courses below the minimum sample are never ranked');
  assert.deepEqual(insights.courses.watchlist.map((row) => row.name), [
    'Kỹ năng tư vấn bán hàng dược phẩm', 'Lập kế hoạch kinh doanh cho quản lý cửa hàng', 'Kỹ năng lãnh đạo cho trưởng nhóm',
  ]);
  assert.equal(insights.courses.largestBacklog?.name, 'Kỹ năng tư vấn bán hàng dược phẩm');
  assert.equal(insights.courses.largestBacklog?.incompleteShare, 24.79);
});

test('analyses the daily trend with the comparison-period average', () => {
  const trend = buildReportInsights(vietnameseReportFixture().snapshot).trends.enrollments!;
  assert.equal(trend.granularity, 'day');
  assert.equal(trend.total, 315);
  assert.equal(trend.mean, 10.16);
  assert.deepEqual(trend.peak, { index: 14, bucket: '2026-07-15', value: 34 });
  assert.equal(trend.previousAverage, 8.73, 'June total 262 over 30 days');
  assert.equal(trend.spikes.length, 1);
  assert.ok(trend.momentum && trend.momentum.changePercent < 0);
  assert.equal(trend.partialLastBucket, false);
});

test('ignores an incomplete last day when the period ends on the snapshot day', () => {
  const snapshot = structuredClone(vietnameseReportFixture().snapshot);
  snapshot.generated_at = '2026-07-31T05:00:00.000Z';
  const insights = buildReportInsights(snapshot);
  assert.ok(insights.limitations.includes('partial_last_bucket'));
  assert.equal(insights.trends.enrollments?.partialLastBucket, true);
});

test('raises attention items with severities from signals and thresholds', () => {
  const insights = buildReportInsights(englishReportFixture().snapshot);
  assert.deepEqual(insights.attention.map((item) => [item.kind, item.severity]), [
    ['completion_decline', 'warning'],
    ['course_watchlist', 'warning'],
    ['course_activation_risk', 'attention'],
    ['activation_risk', 'attention'],
    ['activity_drop', 'attention'],
    ['active_learner_drop', 'attention'],
  ]);
  const watch = insights.facts.find((fact) => fact.id === 'risk.watchlist')!;
  assert.equal(watch.values.count, 8);
  assert.equal(watch.values.min, 5);
  assert.equal(watch.values.max, 50);
});

test('keeps entity names out of facts (tokens only)', () => {
  const insights = buildReportInsights(englishReportFixture().snapshot);
  const serialized = JSON.stringify(insights.facts);
  assert.ok(!serialized.includes('Customer Service'));
  assert.ok(insights.facts.some((fact) => fact.entities.includes('C1')));
  assert.equal(insights.entities.find((entity) => entity.token === 'C1')?.name, 'Customer Service Fundamentals');
});

test('reads the optional unit breakdown and previous-series extensions defensively', () => {
  const extended = buildReportInsights(englishExtendedReportFixture().snapshot);
  assert.equal(extended.units?.level, 'group');
  assert.equal(extended.units?.best?.name, 'Head Office');
  assert.equal(extended.units?.worst?.name, 'Franchise Partners Network (pilot)');
  assert.equal(extended.units?.gapPp, 42.9);
  assert.ok(extended.trends.enrollments?.previousPoints?.length);
  assert.ok(!extended.limitations.includes('previous_trend_missing'));

  const plain = buildReportInsights(englishReportFixture().snapshot);
  assert.equal(plain.units, null);
  assert.ok(plain.limitations.includes('unit_breakdown_missing'));

  const invalid = structuredClone(englishExtendedReportFixture().snapshot) as unknown as Record<string, unknown>;
  invalid.unit_breakdown = { level: 'galaxy', rows: [] };
  const rejected = buildReportInsights(invalid as unknown as StoredReportChatSnapshot);
  assert.equal(rejected.units, null);
  assert.ok(rejected.limitations.includes('unit_breakdown_invalid'));
});

test('ranks units and flags the largest drop and the units below the threshold as facts', () => {
  const insights = buildReportInsights(vietnameseReportFixture().snapshot);
  const units = insights.units!;
  assert.equal(insights.unitBreakdownState, 'available');
  assert.equal(units.level, 'team');
  assert.equal(units.best?.name, 'Phòng Chăm sóc khách hàng');
  assert.equal(units.worst?.name, 'Kho vận Hồ Chí Minh');
  assert.equal(units.gapPp, 37.9);
  assert.equal(units.decline?.name, 'Cửa hàng Thủ Đức');
  assert.equal(units.decline?.deltaPp, -6.5);
  assert.deepEqual(units.lowCompletion.map((row) => row.name), ['Kho vận Hồ Chí Minh', 'Cửa hàng Gò Vấp']);
  assert.equal(units.unitCount, 9);
  assert.equal(units.overlapping, false, 'the fixture teams reconcile with the scope');
  assert.equal(units.rows.find((row) => row.name.includes('thí điểm'))?.deltaPp, null, 'no comparison enrollments: not comparable');
  const fact = (id: string) => insights.facts.find((item) => item.id === id);
  assert.deepEqual(fact('risk.unit_decline')?.values, { current: 57.3, previous: 63.8, delta: 6.5, threshold: 3, enrollments: 44 });
  assert.deepEqual(fact('risk.unit_low_completion')?.values, { count: 2, min: 5, max: 50, rate: 39.5, enrollments: 22 });
  assert.deepEqual(fact('units.ranking')?.values, { best_rate: 77.4, worst_rate: 39.5, gap: 37.9, count: 9 });
  assert.deepEqual(insights.attention.filter((item) => item.kind.startsWith('unit')).map((item) => [item.kind, item.severity]), [
    ['unit_decline', 'warning'], ['unit_low_completion', 'attention'], ['unit_gap', 'attention'],
  ]);
  assert.ok(!JSON.stringify(insights.facts).includes('Thủ Đức'), 'facts cite units by token only');
  assert.equal(insights.entities.find((entity) => entity.token === fact('risk.unit_decline')!.entities[0])?.name, 'Cửa hàng Thủ Đức');
  assert.ok(!insights.limitations.includes('unit_breakdown_missing'));
  assert.ok(!insights.limitations.includes('previous_trend_missing'));
  assert.equal(insights.trends.activeLearners?.previousPoints?.length, 30, 'real comparison series for the active learners too');
});

test('keeps the others and no-unit rows out of rankings, facts and entities', () => {
  const insights = buildReportInsights(manyUnitsReportFixture().snapshot);
  const units = insights.units!;
  assert.deepEqual(units.rows.slice(-2).map((row) => [row.kind, row.unitCount, row.rankable]), [['others', 4, false], ['unassigned', null, false]]);
  assert.equal(units.unitCount, 34);
  assert.equal(units.truncated, true);
  assert.equal(insights.entities.filter((entity) => entity.type === 'unit').length, 30);
  const aggregateTokens = new Set(units.rows.filter((row) => row.kind !== 'unit').map((row) => row.token));
  assert.ok(insights.facts.every((item) => item.entities.every((token) => !aggregateTokens.has(token))));
  assert.ok(units.best?.kind === 'unit' && units.worst?.kind === 'unit');
});

test('detects learners counted in several units', () => {
  const snapshot = structuredClone(vietnameseReportFixture().snapshot) as unknown as { unit_breakdown: { scope_learners: number } };
  snapshot.unit_breakdown.scope_learners = 200;
  assert.equal(buildReportInsights(snapshot as unknown as StoredReportChatSnapshot).units?.overlapping, true);
});

test('draws no unit conclusion from a single ranked unit', () => {
  const snapshot = structuredClone(vietnameseReportFixture().snapshot) as unknown as { unit_breakdown: { rows: Array<{ enrollments: number }> } };
  snapshot.unit_breakdown.rows.forEach((row, index) => { if (index > 0) row.enrollments = 3; });
  const insights = buildReportInsights(snapshot as unknown as StoredReportChatSnapshot);
  assert.equal(insights.units?.rows.length, 9, 'the table still lists every unit');
  assert.equal(insights.units?.worst, null);
  assert.equal(insights.units?.decline, null);
  assert.deepEqual(insights.units?.lowCompletion, []);
  assert.ok(!insights.facts.some((item) => item.id.includes('unit')));
});

test('explains a missing breakdown: nothing below a team, no unit yet, an older snapshot', () => {
  const team = buildReportInsights(longNamesReportFixture('vi').snapshot);
  assert.equal(team.unitBreakdownState, 'leaf_scope');
  assert.ok(!team.limitations.includes('unit_breakdown_missing'), 'a team scope has no child unit to miss');
  assert.equal(buildReportInsights(emptyReportFixture().snapshot).unitBreakdownState, 'leaf_scope');
  const young = buildReportInsights(tinyReportFixture().snapshot);
  assert.equal(young.unitBreakdownState, 'no_child_units');
  assert.ok(!young.limitations.includes('unit_breakdown_missing'));
  const older = buildReportInsights(englishReportFixture().snapshot);
  assert.equal(older.unitBreakdownState, 'missing');
  assert.ok(older.limitations.includes('unit_breakdown_missing'));
  const inconsistent = { ...englishReportFixture().snapshot, unit_breakdown_status: 'available' } as StoredReportChatSnapshot;
  assert.equal(buildReportInsights(inconsistent).unitBreakdownState, 'invalid');
  const emptyTenant = { ...emptyReportFixture().snapshot, scope: { groupId: undefined, subgroupId: undefined, teamId: undefined } } as StoredReportChatSnapshot;
  const emptyInsights = buildReportInsights(emptyTenant);
  assert.equal(emptyInsights.unitBreakdownState, 'not_computed');
  assert.ok(!emptyInsights.limitations.includes('unit_breakdown_missing'), 'nothing to break down in an empty period');
  assert.ok(!emptyInsights.limitations.includes('previous_trend_missing'));
});

test('handles empty, tiny and legacy snapshots without inventing comparisons', () => {
  const empty = buildReportInsights(emptyReportFixture().snapshot);
  assert.equal(empty.available, false);
  assert.deepEqual(empty.attention, []);
  assert.ok(empty.limitations.includes('no_data_in_selected_period'));

  const tiny = buildReportInsights(tinyReportFixture().snapshot);
  assert.equal(tiny.available, true);
  assert.equal(tiny.courses.topPerformers.length, 0, 'a course with 2 enrollments is not ranked');
  assert.equal(tiny.kpis.find((item) => item.id === 'total_enrollments')?.deltaPercent, null, 'no percentage change from zero');

  const legacy = buildReportInsights(legacyReportFixture().snapshot);
  assert.equal(legacy.comparisonBasis, 'none');
  assert.ok(legacy.kpis.every((item) => item.direction === null));
  assert.ok(legacy.limitations.includes('legacy_snapshot'));
  assert.equal(legacy.courses.rows[0].notStarted, null);
});

test('counts chart buckets per granularity', () => {
  assert.equal(countReportBuckets('2026-06-01', '2026-06-30', 'day'), 30);
  assert.equal(countReportBuckets('2026-01-01', '2026-03-31', 'month'), 3);
  assert.equal(countReportBuckets('2026-09-14', '2026-09-27', 'week'), 2);
  assert.equal(countReportBuckets('2026-09-14', '2026-09-27', 'unknown'), null);
});

test('shows a percentage change only from a comparison value of 10 and up to +300%', () => {
  assert.equal(isReportPercentChangeMeaningful(10, 300), true);
  assert.equal(isReportPercentChangeMeaningful(10, 310), false);
  assert.equal(isReportPercentChangeMeaningful(9, 33.3), false);
  assert.equal(isReportPercentChangeMeaningful(47, 795.7), false);
  assert.equal(isReportPercentChangeMeaningful(262, -95), true, 'a large fall from a real base stays meaningful');

  const insights = buildReportInsights(smallBaseReportFixture().snapshot);
  const item = (id: string) => insights.kpis.find((candidate) => candidate.id === id)!;
  assert.deepEqual([item('total_enrollments').delta, item('total_enrollments').deltaPercent, item('total_enrollments').smallBase], [374, null, true], '47 -> 421');
  assert.deepEqual([item('active_learners').delta, item('active_learners').deltaPercent, item('active_learners').smallBase], [61, null, true], '1 -> 62');
  assert.deepEqual([item('total_learners').deltaPercent, item('total_learners').smallBase], [-18.18, false], '11 -> 9 keeps its percentage');
  assert.deepEqual([item('completion_rate').delta, item('completion_rate').smallBase], [33.3, false], 'both periods have 10+ enrollments');
  assert.deepEqual(insights.hiddenPercentChanges, [795.74, 6100, 1066.67, 576.92, 765], 'withheld changes, the trend average (+765%) included');
  const vsPrevious = insights.facts.find((candidate) => candidate.id === 'trend.enrollments.vs_previous')!;
  assert.deepEqual(vsPrevious.values, { avg: 13.6, previous: 1.6, direction: 1 }, 'no percentage value to quote');
  assert.equal(insights.facts.find((candidate) => candidate.id === 'kpi.total_enrollments')?.values.delta_percent, undefined);

  // Too few enrollments in a period: the completion-rate change is not judged.
  const tinyRate = kpi(tinyReportFixture().snapshot, 'completion_rate');
  assert.deepEqual([tinyRate.delta, tinyRate.direction, tinyRate.smallBase], [null, null, true]);
});

test('averages week and month buckets per whole bucket and marks the cut edges', () => {
  const weekly = buildReportInsights(weeklyReportFixture().snapshot).trends.enrollments!;
  assert.equal(weekly.granularity, 'week');
  assert.deepEqual(weekly.partialIndexes, [0, 6], 'Wed 17 June and Fri 31 July cut the first and last week');
  assert.deepEqual(weekly.coverage.slice(0, 2), [0.7143, 1]);
  assert.deepEqual(weekly.previousPartialIndexes, [0, 7]);
  assert.equal(weekly.mean, 72.49, '466 enrollments over 45 days = 6.43 weeks');
  assert.equal(weekly.previousAverage, 63.93);
  assert.equal(weekly.momentum, null, 'only 5 whole weeks: no momentum claim');
  assert.equal(countReportBucketEquivalents('2025-10-11', '2026-10-10', 'month')?.toFixed(4), (21 / 31 + 11 + 10 / 31).toFixed(4));
  assert.equal(countReportBucketEquivalents('2026-06-17', '2026-07-31', 'week'), 45 / 7);
  assert.equal(countReportBucketEquivalents('2026-06-01', '2026-06-30', 'day'), 30);
  const peak = buildReportInsights(weeklyReportFixture().snapshot).facts.find((candidate) => candidate.id === 'trend.enrollments.peak')!;
  assert.deepEqual(peak.values, { value: 90, ratio: 1.2, peak_year: 2026, peak_month: 7, peak_day: 13, peak_end_year: 2026, peak_end_month: 7, peak_end_day: 19 });
});

test('flags a course with 30% or more of its learners not started, from 5 enrollments', () => {
  const insights = buildReportInsights(smallBaseReportFixture().snapshot);
  const risk = insights.facts.find((candidate) => candidate.id === 'risk.course_activation')!;
  assert.deepEqual(risk.values, { count: 1, not_started: 14, enrollments: 26, share: 53.85, threshold: 30, min: 5 });
  assert.equal(insights.entities.find((entity) => entity.token === risk.entities[0])?.name, 'Lập trình Python cơ bản');
  assert.deepEqual(insights.attention.map((item) => item.kind), ['course_watchlist', 'course_activation_risk']);
  const vi = buildReportInsights(vietnameseReportFixture().snapshot).courses.activationRisk.map((row) => [row.name, row.notStarted, row.enrollments]);
  assert.deepEqual(vi, [['Lập kế hoạch kinh doanh cho quản lý cửa hàng', 8, 24], ['Kỹ năng lãnh đạo cho trưởng nhóm', 4, 12]], 'a 4-enrollment course is not judged');
});

test('flags a suspicious flat tail and keeps it out of the trend; ordinary series are not flagged', () => {
  const points = (values: number[]) => values.map((value, index) => ({ bucket: `2026-07-${String(index + 1).padStart(2, '0')}`, value }));
  const insights = buildReportInsights(smallBaseReportFixture().snapshot);
  const active = insights.trends.activeLearners!;
  assert.deepEqual(active.anomaly, { kind: 'flat_tail', indexes: [27, 28, 29, 30], value: 35 });
  assert.deepEqual(active.excludedIndexes, [27, 28, 29, 30]);
  assert.deepEqual(active.peak, { index: 23, bucket: '2026-07-24', value: 12 }, 'the flagged tail is not presented as the peak');
  assert.equal(active.mean, 7.11, 'nor in the average');
  assert.ok(active.momentum && active.momentum.last < 35);
  assert.ok(insights.limitations.includes('data_anomaly'));
  assert.deepEqual(insights.facts.find((candidate) => candidate.id === 'data.anomaly.active_learners')?.values, { count: 4, value: 35, start_year: 2026, start_month: 7, start_day: 28 });
  assert.ok(!insights.attention.some((item) => item.factId.startsWith('data.')), 'a data check is not a business risk');

  assert.equal(detectReportTrendAnomaly(points([5, 7, 6, 8, 9, 2, 2, 2])), null, 'a small repeated value is ordinary');
  assert.equal(detectReportTrendAnomaly(points([5, 7, 6, 8, 9, 0, 0, 0])), null, 'zeros are not a data problem');
  assert.equal(detectReportTrendAnomaly(points([9, 9, 9, 9, 9, 9, 9])), null, 'a whole flat series is not a tail');
  assert.equal(detectReportTrendAnomaly(points([12, 15, 14, 14])), null, 'too short to judge');
  assert.deepEqual(detectReportTrendAnomaly(points([4, 6, 5, 3, 7, 300, 5, 6])), { kind: 'outlier', indexes: [5], value: 300 });
  assert.equal(detectReportTrendAnomaly(points([0, 0, 0, 0, 0, 300, 0, 0])), null, 'one bulk day without other activity is not judged');
  for (const fixture of allReportPdfFixtures().filter((item) => !item.name.startsWith('small-base'))) {
    const checked = buildReportInsights(fixture.snapshot);
    assert.equal(checked.trends.enrollments?.anomaly ?? null, null, `${fixture.name} enrollments`);
    assert.equal(checked.trends.activeLearners?.anomaly ?? null, null, `${fixture.name} active learners`);
  }
});
