import assert from 'node:assert/strict';
import test from 'node:test';
import { pool } from '../../config/database.js';
import {
  getVietnameseReportKpiVocabulary,
  buildReportMetricFacts,
  buildReportSignals,
  createReportSnapshot,
  extractReportCourseReference,
  getReportSignalLimitations,
  getReportComparisonDisplay,
  hasNumericReportNarrativeClaim,
  isReportNarrativeAllowed,
  hasDeterministicReportIntent,
  isPotentialReportYearCorrection,
  isStoredReportChatSnapshot,
  normalizeReportChatFilter,
  resolveReportDateFilter,
  resolveReportYearCorrection,
  resolveComparableReportPeriod,
  resolveReportCourseDetail,
  resolveDeterministicReportRoute,
} from './report-chat.service.js';
import type { ReportCoursePerformance, ReportSummary } from '../reports/reports.service.js';
import { resolveLearnerPlusReportScope } from '../reports/report-access.service.js';

test.after(async () => {
  await pool.end();
});

test('normalizes a scoped report request into the same UTC+7 calendar range', () => {
  const result = normalizeReportChatFilter({
    date_from: '2026-09-01',
    date_to: '2026-09-30',
    group_id: 'group-id',
    subgroup_id: 'subgroup-id',
    team_id: 'team-id',
  });

  assert.deepEqual(result.filter, {
    date_from: '2026-09-01',
    date_to: '2026-09-30',
    group_id: 'group-id',
    subgroup_id: 'subgroup-id',
    team_id: 'team-id',
  });
  assert.equal(result.dateRange.startDate.toISOString(), '2026-08-31T17:00:00.000Z');
  assert.equal(result.dateRange.endDate.toISOString(), '2026-09-30T16:59:59.999Z');
});

test('rejects incomplete, reversed, and overlong report date ranges', () => {
  assert.throws(
    () => normalizeReportChatFilter({ date_from: '2026-09-01' }),
    (error: unknown) => Boolean(error && typeof error === 'object' && (error as { status?: number }).status === 400),
  );
  assert.throws(
    () => normalizeReportChatFilter({ date_from: '2026-09-30', date_to: '2026-09-01' }),
    (error: unknown) => Boolean(error && typeof error === 'object' && (error as { status?: number }).status === 400),
  );
  assert.throws(
    () => normalizeReportChatFilter({ date_from: '2025-01-01', date_to: '2026-01-02' }),
    (error: unknown) => Boolean(error && typeof error === 'object' && (error as { status?: number }).status === 400),
  );
});

test('recognizes explicit learning-report requests when the model router does not call its tool', () => {
  assert.equal(hasDeterministicReportIntent('Bảng xếp hạng khóa học tháng 5/2026'), true);
  assert.equal(hasDeterministicReportIntent('Show course completion metrics by team'), true);
  assert.equal(hasDeterministicReportIntent('Thời tiết hôm nay thế nào?'), false);
  assert.equal(hasDeterministicReportIntent('Giải thích khóa học là gì'), false);
});

test('routes an explicit dated report request directly to its backend snapshot', () => {
  assert.deepEqual(
    resolveDeterministicReportRoute({
      question: 'Báo cáo cho tôi Khóa Customer Experience có bao nhiêu người học trong tháng 7',
      locale: 'vi',
      referenceDate: new Date('2026-09-19T05:00:00.000Z'),
    }),
    {
      kind: 'snapshot',
      suggested_filter: { date_from: '2026-07-01', date_to: '2026-07-31' },
    },
  );
});

test('resolves a uniquely named course detail request without trusting an AI-generated course id', () => {
  const candidates: ReportCoursePerformance[] = [
    {
      course_id: 'course-customer-experience',
      name: 'Customer Experience',
      total_enrollments: 24,
      completed_enrollments: 18,
      incomplete_enrollments: 6,
      not_started_enrollments: 2,
      in_progress_enrollments: 4,
      completion_rate: 75,
    },
    {
      course_id: 'course-customer-experience-v2',
      name: 'Customer Experience V2',
      total_enrollments: 8,
      completed_enrollments: 7,
      incomplete_enrollments: 1,
      not_started_enrollments: 0,
      in_progress_enrollments: 1,
      completion_rate: 87.5,
    },
  ];
  const question = 'Báo cáo cho tôi Khóa Customer Experience có bao nhiêu người học trong tháng 7';

  assert.equal(extractReportCourseReference(question), 'Customer Experience');
  assert.deepEqual(resolveReportCourseDetail(question, candidates), {
    course_id: 'course-customer-experience',
    name: 'Customer Experience',
    total_enrollments: 24,
    completed_enrollments: 18,
    incomplete_enrollments: 6,
    not_started_enrollments: 2,
    in_progress_enrollments: 4,
    completion_rate: 75,
  });
});

test('resolves a trailing English course name without trusting an AI-generated course id', () => {
  const course: ReportCoursePerformance = {
    course_id: 'course-customer-experience',
    name: 'Customer Experience',
    total_enrollments: 24,
    completed_enrollments: 18,
    incomplete_enrollments: 6,
    not_started_enrollments: 2,
    in_progress_enrollments: 4,
    completion_rate: 75,
  };
  const question = 'How many learners are taking the Customer Experience course in July?';

  assert.equal(extractReportCourseReference(question), 'Customer Experience');
  assert.deepEqual(resolveReportCourseDetail(question, [course]), {
    course_id: 'course-customer-experience',
    name: 'Customer Experience',
    total_enrollments: 24,
    completed_enrollments: 18,
    incomplete_enrollments: 6,
    not_started_enrollments: 2,
    in_progress_enrollments: 4,
    completion_rate: 75,
  });
});

test('suppresses course detail selection when the candidate name is ambiguous or the request is not for learners', () => {
  const candidate: ReportCoursePerformance = {
    course_id: 'course-customer-experience',
    name: 'Customer Experience',
    total_enrollments: 24,
    completed_enrollments: 18,
    incomplete_enrollments: 6,
    not_started_enrollments: 2,
    in_progress_enrollments: 4,
    completion_rate: 75,
  };

  assert.equal(
    resolveReportCourseDetail('Khóa Customer Experience có bao nhiêu người học?', [candidate, { ...candidate, course_id: 'duplicate-course' }]),
    null,
  );
  assert.equal(resolveReportCourseDetail('Báo cáo tiến độ Khóa Customer Experience trong tháng 7', [candidate]), null);
});

test('uses the exact Vietnamese KPI titles shown in the learning report dashboard', () => {
  assert.deepEqual(
    getVietnameseReportKpiVocabulary().map((metric) => [metric.key, metric.title]),
    [
      ['total_learners', 'Tổng học viên đã tạo'],
      ['active_learners', 'Học viên có hoạt động học'],
      ['completion_rate', 'Tỷ lệ hoàn thành trung bình'],
      ['total_enrollments', 'Lượt ghi danh trong kỳ'],
    ],
  );
});

test('resolves report dates without a year against the current Vietnam calendar year', () => {
  const referenceDate = new Date('2026-09-19T05:00:00.000Z');

  assert.deepEqual(
    resolveReportDateFilter({
      question: 'số học viên có hoạt động học từ 1/7 đến 31/7 là bao nhiêu',
      locale: 'vi',
      referenceDate,
      suggestedFilter: { date_from: '2024-07-01', date_to: '2024-07-31' },
    }),
    { date_from: '2026-07-01', date_to: '2026-07-31' },
  );
  assert.deepEqual(
    resolveReportDateFilter({ question: 'báo cáo tháng 5', locale: 'vi', referenceDate }),
    { date_from: '2026-05-01', date_to: '2026-05-31' },
  );
  assert.deepEqual(
    resolveReportDateFilter({ question: 'báo cáo tháng 5/2024', locale: 'vi', referenceDate }),
    { date_from: '2024-05-01', date_to: '2024-05-31' },
  );
});

test('resolves relative report dates against the Vietnam calendar day', () => {
  const referenceDate = new Date('2026-09-19T05:00:00.000Z');

  assert.deepEqual(
    resolveReportDateFilter({ question: 'báo cáo hôm qua', locale: 'vi', referenceDate }),
    { date_from: '2026-09-18', date_to: '2026-09-18' },
  );
  assert.deepEqual(
    resolveReportDateFilter({ question: 'báo cáo tuần trước', locale: 'vi', referenceDate }),
    { date_from: '2026-09-07', date_to: '2026-09-13' },
  );
  assert.deepEqual(
    resolveReportDateFilter({ question: 'report this month', locale: 'en', referenceDate }),
    { date_from: '2026-09-01', date_to: '2026-09-19' },
  );
});

test('replays the preceding report when the user only corrects its year', () => {
  const correction = resolveReportYearCorrection({
    question: 'năm 2026 mà ba',
    previousQuestion: 'số học viên có hoạt động học từ 1/7 đến 31/7 là bao nhiêu',
    previousFilter: {
      date_from: '2024-07-01',
      date_to: '2024-07-31',
      group_id: 'group-id',
    },
  });

  assert.equal(isPotentialReportYearCorrection('năm 2026 mà ba'), true);
  assert.equal(isPotentialReportYearCorrection('báo cáo năm 2026'), false);
  assert.deepEqual(correction, {
    year: 2026,
    reportQuestion: 'số học viên có hoạt động học từ 1/7 đến 31/7 là bao nhiêu',
    filter: {
      date_from: '2026-07-01',
      date_to: '2026-07-31',
      group_id: 'group-id',
    },
  });
});

test('uses a calendar comparison period when the selected period is a full calendar month', () => {
  assert.deepEqual(
    resolveComparableReportPeriod('2026-07-01', '2026-07-31'),
    { date_from: '2026-06-01', date_to: '2026-06-30', basis: 'calendar_month' },
  );
  assert.deepEqual(
    resolveComparableReportPeriod('2026-09-04', '2026-09-19'),
    { date_from: '2026-08-19', date_to: '2026-09-03', basis: 'equal_length' },
  );
  assert.deepEqual(
    resolveComparableReportPeriod('2026-09-01', '2026-09-19'),
    { date_from: '2026-08-01', date_to: '2026-08-19', basis: 'month_to_date' },
  );
  assert.deepEqual(
    resolveComparableReportPeriod('2026-01-01', '2026-09-19'),
    { date_from: '2025-01-01', date_to: '2025-09-19', basis: 'year_to_date' },
  );
  assert.deepEqual(
    resolveComparableReportPeriod('2024-01-01', '2024-02-29'),
    { date_from: '2023-01-01', date_to: '2023-02-28', basis: 'year_to_date' },
  );
  assert.deepEqual(
    resolveComparableReportPeriod('2026-09-14', '2026-09-20'),
    { date_from: '2026-09-07', date_to: '2026-09-13', basis: 'calendar_week' },
  );
  assert.deepEqual(
    resolveComparableReportPeriod('2026-01-01', '2026-12-31'),
    { date_from: '2025-01-01', date_to: '2025-12-31', basis: 'calendar_year' },
  );
});

test('renders comparison terminology from the resolved basis and exact snapshot dates', () => {
  assert.deepEqual(
    getReportComparisonDisplay({ date_from: '2026-03-01', date_to: '2026-03-31', basis: 'calendar_month' }, 'vi'),
    { title: 'So sánh với tháng trước', date_label: '01/03/2026 - 31/03/2026', delta_suffix: 'so với tháng trước' },
  );
  assert.deepEqual(
    getReportComparisonDisplay({ date_from: '2026-03-23', date_to: '2026-03-29', basis: 'calendar_week' }, 'en'),
    { title: 'Compared with previous week', date_label: '23 Mar 2026 - 29 Mar 2026', delta_suffix: 'vs previous week' },
  );
  assert.deepEqual(
    getReportComparisonDisplay({ date_from: '2025-01-01', date_to: '2025-04-30', basis: 'year_to_date' }, 'vi'),
    { title: 'So sánh cùng kỳ năm trước', date_label: '01/01/2025 - 30/04/2025', delta_suffix: 'so với cùng kỳ năm trước' },
  );
  assert.deepEqual(
    getReportComparisonDisplay({ date_from: '2026-03-01', date_to: '2026-03-31', basis: 'equal_length' }, 'en'),
    { title: 'Compared with immediately preceding period', date_label: '01 Mar 2026 - 31 Mar 2026', delta_suffix: 'vs immediately preceding period' },
  );
});

test('calculates report metric facts only from current and prior ReportsService summaries', () => {
  const current: ReportSummary = {
    meta: { month: 7, year: 2026, month_label: '07/2026', is_current_month: false, date_from: '2026-07-01', date_to: '2026-07-31' },
    overview: {
      total_learners: 120,
      active_learners: 88,
      completion_rate: 67.5,
      total_enrollments: 180,
      completed_enrollments: 121,
      incomplete_enrollments: 59,
    },
  };
  const previous: ReportSummary = {
    meta: { month: 6, year: 2026, month_label: '06/2026', is_current_month: false, date_from: '2026-06-01', date_to: '2026-06-30' },
    overview: {
      total_learners: 100,
      active_learners: 80,
      completion_rate: 70,
      total_enrollments: 150,
      completed_enrollments: 105,
      incomplete_enrollments: 45,
    },
  };

  assert.deepEqual(buildReportMetricFacts(current, previous), [
    { id: 'total_learners', unit: 'count', current: 120, previous: 100, delta_absolute: 20, delta_percent: 20, delta_percentage_points: null },
    { id: 'active_learners', unit: 'count', current: 88, previous: 80, delta_absolute: 8, delta_percent: 10, delta_percentage_points: null },
    { id: 'completion_rate', unit: 'percentage', current: 67.5, previous: 70, delta_absolute: -2.5, delta_percent: null, delta_percentage_points: -2.5 },
    { id: 'total_enrollments', unit: 'count', current: 180, previous: 150, delta_absolute: 30, delta_percent: 20, delta_percentage_points: null },
    { id: 'incomplete_enrollments', unit: 'count', current: 59, previous: 45, delta_absolute: 14, delta_percent: 31.11, delta_percentage_points: null },
  ]);
});

test('rejects AI narrative content that attempts to add numeric factual claims', () => {
  assert.equal(hasNumericReportNarrativeClaim({
    selected_signal_ids: ['completion_decline'],
    interpretation: ['Completion declined by 12 percent.'],
    recommended_actions: [],
    limitations: [],
  }), true);
  assert.equal(hasNumericReportNarrativeClaim({
    selected_signal_ids: ['completion_decline'],
    interpretation: ['Review the learner journey before deciding the next action.'],
    recommended_actions: [{ signal_id: 'completion_decline', priority: 'high', action: 'Review the learning journey with the responsible team.' }],
    limitations: [],
  }), false);
});

test('rejects an AI narrative with a metric mismatch or an unknown evidence identifier', () => {
  const snapshot = {
    signals: [{ id: 'completion_decline', category: 'completion' as const, severity: 'warning' as const, threshold_version: 'v1' as const, evidence: {} }],
  };
  assert.equal(isReportNarrativeAllowed({
    selected_signal_ids: ['unknown_signal'],
    interpretation: [],
    recommended_actions: [],
    limitations: [],
  }, snapshot), false);
  assert.equal(isReportNarrativeAllowed({
    selected_signal_ids: ['completion_decline'],
    interpretation: [],
    recommended_actions: [{ signal_id: 'completion_decline', priority: 'medium', action: 'Coordinate a review with the learning owner.' }],
    limitations: [],
  }, snapshot), true);
});

function reportSummary(input: Partial<ReportSummary['overview']> = {}): ReportSummary {
  return {
    meta: {
      month: 9,
      year: 2026,
      month_label: '09/2026',
      is_current_month: true,
      date_from: '2026-09-01',
      date_to: '2026-09-19',
    },
    overview: {
      total_learners: 0,
      active_learners: 0,
      completion_rate: 0,
      total_enrollments: 0,
      completed_enrollments: 0,
      incomplete_enrollments: 0,
      ...input,
    },
  };
}

test('persists KPI and previous-period values exactly as supplied by ReportsService summaries', () => {
  const current = reportSummary({ total_learners: 120, active_learners: 88, completion_rate: 67.5, total_enrollments: 180, completed_enrollments: 121, incomplete_enrollments: 59 });
  const previous = reportSummary({ total_learners: 100, active_learners: 80, completion_rate: 70, total_enrollments: 150, completed_enrollments: 105, incomplete_enrollments: 45 });
  const snapshot = createReportSnapshot(
    {
      version: 2,
      generated_at: '2026-09-19T00:00:00.000Z',
      timezone: 'Asia/Ho_Chi_Minh',
      filter: { date_from: '2026-09-01', date_to: '2026-09-19' },
      scope: { groupId: 'group-1', subgroupId: undefined, teamId: undefined },
      comparison: { date_from: '2026-08-01', date_to: '2026-08-19', basis: 'month_to_date' },
    },
    current,
    previous,
    [],
    [],
    [],
    { not_started: 0, in_progress: 0, completed: 0 },
    { group_name: 'Group 1' },
    'available',
    { granularity: 'day' },
  );

  assert.deepEqual(snapshot.summary, current);
  assert.deepEqual(snapshot.previous_summary, previous);
  assert.deepEqual(snapshot.factual_metrics, buildReportMetricFacts(current, previous));
  assert.deepEqual(snapshot.enrollment_trend_context, { granularity: 'day' });
});

test('persists the backend-resolved course detail in the immutable report snapshot', () => {
  const courseDetail = {
    course_id: 'course-customer-experience',
    name: 'Customer Experience',
    total_enrollments: 24,
    completed_enrollments: 18,
    incomplete_enrollments: 6,
    not_started_enrollments: 2,
    in_progress_enrollments: 4,
    completion_rate: 75,
  };
  const snapshot = createReportSnapshot(
    {
      version: 2,
      generated_at: '2026-09-19T00:00:00.000Z',
      timezone: 'Asia/Ho_Chi_Minh',
      filter: { date_from: '2026-07-01', date_to: '2026-07-31' },
      scope: { groupId: 'group-1', subgroupId: undefined, teamId: undefined },
      comparison: { date_from: '2026-06-01', date_to: '2026-06-30', basis: 'calendar_month' },
    },
    reportSummary(),
    reportSummary(),
    [],
    [],
    [],
    { not_started: 0, in_progress: 0, completed: 0 },
    { group_name: 'Group 1' },
    'available',
    {},
    courseDetail,
  );

  assert.deepEqual(snapshot.course_detail, courseDetail);
});

test('calculates deterministic deltas without dividing by a zero prior denominator', () => {
  const facts = buildReportMetricFacts(
    reportSummary({ total_learners: 5, total_enrollments: 5 }),
    reportSummary({ total_learners: 0, total_enrollments: 0 }),
  );
  const learners = facts.find((metric) => metric.id === 'total_learners');
  assert.deepEqual(learners, {
    id: 'total_learners',
    unit: 'count',
    current: 5,
    previous: 0,
    delta_absolute: 5,
    delta_percent: null,
    delta_percentage_points: null,
  });
});

test('suppresses completion-decline warnings below the deterministic sample threshold', () => {
  const metrics = buildReportMetricFacts(
    reportSummary({ completion_rate: 20, total_enrollments: 9 }),
    reportSummary({ completion_rate: 90, total_enrollments: 100 }),
  );
  assert.equal(buildReportSignals({ metrics, activeTrend: [], coursePortfolio: [] }).some((signal) => signal.id === 'completion_decline'), false);
  assert.deepEqual(getReportSignalLimitations(metrics), ['completion_decline_insufficient_sample:v1']);
});

test('uses only snapshot metric facts as evidence for a completion-decline signal', () => {
  const metrics = buildReportMetricFacts(
    reportSummary({ completion_rate: 60, total_enrollments: 20 }),
    reportSummary({ completion_rate: 70, total_enrollments: 25 }),
  );
  const signal = buildReportSignals({ metrics, activeTrend: [], coursePortfolio: [] })
    .find((item) => item.id === 'completion_decline');
  assert.deepEqual(signal?.evidence, {
    metric_id: 'completion_rate',
    current: 60,
    previous: 70,
    delta_percentage_points: -10,
    current_sample_size: 20,
    previous_sample_size: 25,
  });
  assert.equal(signal?.threshold_version, 'v1');
});

test('continues to accept a persisted V1 report snapshot', () => {
  assert.equal(isStoredReportChatSnapshot({
    version: 1,
    generated_at: '2026-09-19T00:00:00.000Z',
    timezone: 'Asia/Ho_Chi_Minh',
    filter: { date_from: '2026-09-01', date_to: '2026-09-19' },
    scope: { groupId: 'group-1' },
    summary: reportSummary(),
    enrollment_trend: [],
    top_courses: [],
    completion_ranking: [],
  }), true);
});

test('keeps learner_plus report scope confined to the existing allowed groups', () => {
  assert.deepEqual(
    resolveLearnerPlusReportScope(['group-a', 'group-b'], {}, {}),
    { groupId: 'group-a', subgroupId: undefined, teamId: undefined, allowedGroupIds: ['group-a', 'group-b'] },
  );
  assert.deepEqual(
    resolveLearnerPlusReportScope(['group-a'], { groupId: 'group-a' }, { groupId: 'group-a', subgroupId: 'subgroup-a', teamId: 'team-a' }),
    { groupId: 'group-a', subgroupId: 'subgroup-a', teamId: 'team-a', allowedGroupIds: ['group-a'] },
  );
  assert.throws(() => resolveLearnerPlusReportScope(['group-a'], { groupId: 'group-b' }, { groupId: 'group-b' }));
});
