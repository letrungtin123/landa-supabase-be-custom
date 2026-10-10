import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { REPORT_AUTO_BUCKET_RULE, resolveAutoReportBucket } from './report-buckets.logic.js';
import { getReportChart, resolveReportChartGranularity, type ReportDateRange } from './reports.service.js';
import { resolveSnapshotChartGranularity } from '../ai-chatbot/report-time-expression.logic.js';

const TENANT = '11111111-1111-4111-8111-111111111111';

function range(dateFrom: string, dateTo: string): ReportDateRange {
  return {
    startDate: new Date(`${dateFrom}T00:00:00.000+07:00`),
    endDate: new Date(`${dateTo}T23:59:59.999+07:00`),
    dateFrom,
    dateTo,
  };
}

function addDays(ymd: string, days: number): string {
  const [year, month, day] = ymd.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

test('the shared rule: up to 31 days by day, up to 120 days by week, longer by month', () => {
  assert.deepEqual(REPORT_AUTO_BUCKET_RULE, { dayMaxDays: 31, weekMaxDays: 120 });
  assert.equal(resolveAutoReportBucket(1), 'day');
  assert.equal(resolveAutoReportBucket(31), 'day');
  assert.equal(resolveAutoReportBucket(32), 'week');
  assert.equal(resolveAutoReportBucket(45), 'week');
  assert.equal(resolveAutoReportBucket(120), 'week');
  assert.equal(resolveAutoReportBucket(121), 'month');
  assert.equal(resolveAutoReportBucket(366), 'month');
});

test('the Reports screen picks its automatic buckets with the shared rule', () => {
  assert.equal(resolveReportChartGranularity(range('2026-07-01', '2026-07-31')), 'day', '31 days');
  assert.equal(resolveReportChartGranularity(range('2026-07-01', '2026-08-01')), 'week', '32 days');
  assert.equal(resolveReportChartGranularity(range('2026-06-17', '2026-07-31')), 'week', '45 days (was month before)');
  assert.equal(resolveReportChartGranularity(range('2026-06-03', '2026-09-30')), 'week', '120 days');
  assert.equal(resolveReportChartGranularity(range('2026-06-02', '2026-09-30')), 'month', '121 days');
  assert.equal(resolveReportChartGranularity(range('2025-10-09', '2026-10-08')), 'month', 'one year');
  // A range across the new year is counted in calendar days too.
  assert.equal(resolveReportChartGranularity(range('2025-12-01', '2026-01-31')), 'week', '62 days');
});

test('an explicit choice on the Reports chart is kept as before', () => {
  const fortyFiveDays = range('2026-06-17', '2026-07-31');
  assert.equal(resolveReportChartGranularity(fortyFiveDays, 'day'), 'day');
  assert.equal(resolveReportChartGranularity(fortyFiveDays, 'month'), 'month');
  assert.equal(resolveReportChartGranularity(range('2026-07-01', '2026-07-31'), 'week'), 'week');
  assert.equal(resolveReportChartGranularity(range('2025-01-01', '2026-06-30'), 'week'), 'week', '546 days by week');
  // Beyond the day limit (366 days) a "day" request falls back to the automatic rule, as before.
  assert.equal(resolveReportChartGranularity(range('2025-01-01', '2026-06-30'), 'day'), 'month');
});

test('the Reports screen and the AI report snapshot never disagree without a choice', () => {
  const start = '2026-01-01';
  for (let days = 1; days <= 366; days += 1) {
    const to = addDays(start, days - 1);
    assert.equal(
      resolveReportChartGranularity(range(start, to)),
      resolveSnapshotChartGranularity(null, { date_from: start, date_to: to }),
      `${days} days`,
    );
  }
});

async function installFakeChartDb(t: TestContext): Promise<Array<{ text: string; params: unknown[] }>> {
  const calls: Array<{ text: string; params: unknown[] }> = [];
  const pg = await import('pg');
  t.mock.method(pg.default.Pool.prototype, 'query', async (text: string, params: unknown[] = []) => {
    calls.push({ text, params });
    // ISO weeks (Monday) touching 17/06–31/07/2026; the first and last week are cut by the range.
    const mondays = ['2026-06-15', '2026-06-22', '2026-06-29', '2026-07-06', '2026-07-13', '2026-07-20', '2026-07-27'];
    return {
      rows: mondays.map((bucket, index) => ({ bucket, bucket_label: `Tuần ${index + 25}/2026`, value: String(index * 3) })),
      rowCount: mondays.length,
    };
  });
  return calls;
}

test('a 45-day Reports chart asks the database for ISO weeks and returns week buckets', async (t) => {
  const calls = await installFakeChartDb(t);
  const chart = await getReportChart(TENANT, 2026, 'total_enrollments', undefined, undefined, undefined, false, false, range('2026-06-17', '2026-07-31'), 'auto', {
    mode: 'window', direction: 'initial', limitBuckets: 72,
  });
  assert.equal(chart.granularity, 'week');
  assert.equal(chart.date_from, '2026-06-17');
  assert.equal(chart.date_to, '2026-07-31');
  assert.equal(chart.bucket_count, 7);
  assert.deepEqual(chart.data.map((point) => point.bucket), ['2026-06-15', '2026-06-22', '2026-06-29', '2026-07-06', '2026-07-13', '2026-07-20', '2026-07-27']);
  assert.equal(chart.window?.window_start, '2026-06-15');
  assert.equal(chart.window?.window_end, '2026-07-27');
  assert.equal(chart.window?.has_before, false);
  assert.equal(chart.window?.has_after, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params[3], 'week', 'date_trunc unit');
  assert.equal(calls[0].params[4], '1 week', 'generate_series step');
});
