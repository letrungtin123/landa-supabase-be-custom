import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReportPdfChartViewModel } from './report-pdf-chart-view-model.js';
import type { StoredReportChatSnapshot } from './report-chat.service.js';

function snapshot(): StoredReportChatSnapshot {
  return {
    version: 2,
    generated_at: '2026-09-20T08:00:00.000Z',
    timezone: 'Asia/Ho_Chi_Minh',
    filter: { date_from: '2026-07-01', date_to: '2026-07-31' },
    scope: { groupId: 'group-1', subgroupId: undefined, teamId: undefined },
    comparison: { date_from: '2026-06-01', date_to: '2026-06-30', basis: 'calendar_month' },
    comparison_display: {
      vi: { title: 'So sánh với tháng trước', date_label: '01/06/2026 - 30/06/2026', delta_suffix: 'so với tháng trước' },
      en: { title: 'Compared with previous month', date_label: '01 Jun 2026 - 30 Jun 2026', delta_suffix: 'vs previous month' },
    },
    scope_display: { group_name: 'L&A Hold' },
    enrollment_trend_context: { granularity: 'day' },
    summary: { meta: { month: 7, year: 2026, month_label: '07/2026', is_current_month: false, date_from: '2026-07-01', date_to: '2026-07-31' }, overview: { total_learners: 9, active_learners: 5, completion_rate: 53.7, total_enrollments: 65, completed_enrollments: 35, incomplete_enrollments: 30 } },
    previous_summary: { meta: { month: 6, year: 2026, month_label: '06/2026', is_current_month: false, date_from: '2026-06-01', date_to: '2026-06-30' }, overview: { total_learners: 7, active_learners: 4, completion_rate: 48.1, total_enrollments: 48, completed_enrollments: 23, incomplete_enrollments: 25 } },
    enrollment_trend: [
      { bucket: '2026-07-01', label: '01/07', value: 4 }, { bucket: '2026-07-05', label: '05/07', value: 7 }, { bucket: '2026-07-10', label: '10/07', value: 11 }, { bucket: '2026-07-15', label: '15/07', value: 26 }, { bucket: '2026-07-20', label: '20/07', value: 8 }, { bucket: '2026-07-25', label: '25/07', value: 6 }, { bucket: '2026-07-31', label: '31/07', value: 3 },
    ],
    active_learner_trend: [],
    top_courses: [
      { course_id: 'safety', name: 'An toàn lao động và 5S tại nơi làm việc', enrollments: 52 },
      { course_id: 'python', name: 'Lập trình Python cơ bản', enrollments: 47 },
      { course_id: 'cx', name: 'Customer Experience', enrollments: 38 },
    ],
    completion_ranking: [
      { course_id: 'cx', name: 'Customer Experience', total_enrollments: 16, completed_enrollments: 14, incomplete_enrollments: 2, completion_rate: 96.1 },
      { course_id: 'python', name: 'Lập trình Python cơ bản', total_enrollments: 26, completed_enrollments: 8, incomplete_enrollments: 18, completion_rate: 30.8 },
    ],
    course_portfolio: [],
    completion_status_distribution: { completed: 32, in_progress: 32, not_started: 1 },
    factual_metrics: [
      { id: 'total_learners', unit: 'count', current: 9, previous: 7, delta_absolute: 2, delta_percent: 28.6, delta_percentage_points: null },
      { id: 'active_learners', unit: 'count', current: 5, previous: 4, delta_absolute: 1, delta_percent: 25, delta_percentage_points: null },
      { id: 'completion_rate', unit: 'percentage', current: 53.7, previous: 48.1, delta_absolute: null, delta_percent: null, delta_percentage_points: 5.6 },
      { id: 'total_enrollments', unit: 'count', current: 65, previous: 48, delta_absolute: 17, delta_percent: 35.4, delta_percentage_points: null },
      { id: 'incomplete_enrollments', unit: 'count', current: 30, previous: 25, delta_absolute: 5, delta_percent: 20, delta_percentage_points: null },
    ],
    signals: [{ id: 'high_enrollment_low_completion', category: 'course', severity: 'warning', threshold_version: 'v1', evidence: { course_id: 'python', course_name: 'Lập trình Python cơ bản', enrollment_count: 26, completion_rate: 30.8 } }],
    signal_threshold_version: 'v1',
    availability: { state: 'available', limitations: [] },
  };
}

test('builds a labeled zero-baseline enrollment trend from immutable snapshot values', () => {
  const model = buildReportPdfChartViewModel(snapshot(), 'vi');
  assert.equal(model.trend?.title, 'Xu hướng lượt ghi danh theo ngày');
  assert.equal(model.trend?.subtitle, '01/07/2026 - 31/07/2026 · Đơn vị: lượt ghi danh');
  assert.equal(model.trend?.yTicks[0], 0);
  assert.ok(model.trend?.yTicks.every(Number.isInteger));
  assert.equal(model.trend?.yTicks.length, 5);
  assert.ok((model.trend?.xTicks.length ?? 0) <= 7);
  assert.deepEqual(model.trend?.peak, { index: 3, value: 26, valueLabel: '26 lượt ghi danh', dateLabel: '15/07/2026' });
  assert.deepEqual(model.trend?.summary[1], { label: 'Tổng trong kỳ', value: '65 lượt ghi danh', detail: '01/07/2026 - 31/07/2026' });
});

test('uses one proportional course-bar scale with readable metric labels', () => {
  const courses = buildReportPdfChartViewModel(snapshot(), 'vi').topCourses;
  assert.equal(courses[0].barRatio, 1);
  assert.equal(courses[1].barRatio, 47 / 52);
  assert.equal(courses[0].valueLabel, '52 lượt ghi danh');
  assert.match(courses[0].displayName, /\n/);
});

test('keeps completion rate separate from enrollment and completed count semantics', () => {
  const course = buildReportPdfChartViewModel(snapshot(), 'vi').completionRows[0];
  assert.equal(course.completionRateLabel, '96,1% hoàn thành');
  assert.equal(course.enrollmentLabel, '16 lượt ghi danh');
  assert.equal(course.completedLabel, '14 lượt hoàn thành');
  assert.notEqual(course.completionRateLabel, '14 / 16');
});

test('builds status distribution only from the mutually exclusive backend counts', () => {
  const status = buildReportPdfChartViewModel(snapshot(), 'vi').statusDistribution;
  assert.equal(status?.totalLabel, 'Tổng: 65 lượt ghi danh');
  assert.deepEqual(status?.segments.map((item) => item.countLabel), ['32 lượt', '32 lượt', '1 lượt']);
  assert.equal(status?.segments.reduce((sum, item) => sum + item.ratio, 0), 1);
});

test('keeps legacy snapshots renderable without inventing daily chart semantics', () => {
  const legacy: StoredReportChatSnapshot = {
    version: 1,
    generated_at: '2026-09-20T08:00:00.000Z',
    timezone: 'Asia/Ho_Chi_Minh',
    filter: { date_from: '2026-07-01', date_to: '2026-07-31' },
    scope: { groupId: undefined, subgroupId: undefined, teamId: undefined },
    summary: snapshot().summary,
    enrollment_trend: [{ bucket: '2026-07-01', label: '01/07', value: 4 }],
    top_courses: [],
    completion_ranking: [],
  };
  assert.equal(buildReportPdfChartViewModel(legacy, 'vi').trend?.title, 'Xu hướng lượt ghi danh trong kỳ báo cáo');
  assert.equal(buildReportPdfChartViewModel(legacy, 'vi').statusDistribution, null);
});
