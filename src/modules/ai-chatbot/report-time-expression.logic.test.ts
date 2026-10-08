import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseReportTimeExpression,
  reportRangesAgree,
  resolveSnapshotChartGranularity,
  validateReportRange,
} from './report-time-expression.logic.js';
import { resolveNearestReportDataPeriod } from './report-date.logic.js';
import { foldReportText } from './report-text.logic.js';

// Thursday 8 October 2026 in Asia/Ho_Chi_Minh.
const today = '2026-10-08';
const parse = (question: string) => parseReportTimeExpression(question, { today });
const range = (date_from: string, date_to: string) => ({ date_from, date_to });

function assertResolved(question: string, expected: { date_from: string; date_to: string }, confidence: 'high' | 'medium' = 'high') {
  const result = parse(question);
  assert.equal(result.status, 'resolved', `${question}: ${JSON.stringify(result)}`);
  assert.deepEqual(result.range, expected, question);
  assert.equal(result.confidence, confidence, question);
}

test('folds Vietnamese "đ" so "đến" is read as a range connector', () => {
  assert.equal(foldReportText('Từ ngày 1/7 ĐẾN nay'), 'tu ngay 1/7 den nay');
});

test('reads ISO dates as year-month-day, never day-month', () => {
  assertResolved('Báo cáo từ 2025-07-01 đến 2025-07-31', range('2025-07-01', '2025-07-31'));
  assertResolved('from 2025/07/01 to 2025/09/30', range('2025-07-01', '2025-09-30'));
  assertResolved('báo cáo ngày 2025-03-04', range('2025-03-04', '2025-03-04'));
});

test('reads dd/mm/yyyy and dd-mm-yyyy and respects the stated year', () => {
  assertResolved('Báo cáo từ 01/07/2025 đến 31/07/2025', range('2025-07-01', '2025-07-31'));
  assertResolved('báo cáo 1-7-2025 đến 31-7-2025', range('2025-07-01', '2025-07-31'));
  assertResolved('báo cáo 1/7/2025 - 31/7/2025', range('2025-07-01', '2025-07-31'));
});

test('reads d/m without a year in the current year and inherits a year from the other end', () => {
  assertResolved('số học viên từ 1/7 đến 31/7', range('2026-07-01', '2026-07-31'));
  assertResolved('từ 1/7 đến 31/7/2025', range('2025-07-01', '2025-07-31'));
  assertResolved('1/7-31/7', range('2026-07-01', '2026-07-31'));
  assertResolved('1-15/7', range('2026-07-01', '2026-07-15'));
});

test('reads "ngày X tháng Y năm Z" as one day, not the whole month', () => {
  assertResolved('Báo cáo ngày 5 tháng 7 năm 2025', range('2025-07-05', '2025-07-05'));
  assertResolved('Báo cáo ngày 5 tháng 7', range('2026-07-05', '2026-07-05'));
  assertResolved('từ ngày 1 đến ngày 15 tháng 7', range('2026-07-01', '2026-07-15'));
});

test('reads months with and without a year in Vietnamese and English', () => {
  assertResolved('báo cáo tháng 7', range('2026-07-01', '2026-07-31'));
  assertResolved('báo cáo tháng 7 năm 2025', range('2025-07-01', '2025-07-31'));
  assertResolved('báo cáo tháng 7/2025', range('2025-07-01', '2025-07-31'));
  assertResolved('báo cáo tháng 7, năm 2025', range('2025-07-01', '2025-07-31'));
  assertResolved('báo cáo T7/2025', range('2025-07-01', '2025-07-31'));
  assertResolved('báo cáo 5/2026', range('2026-05-01', '2026-05-31'));
  assertResolved('báo cáo tháng 7 năm ngoái', range('2025-07-01', '2025-07-31'));
  assertResolved('report for July 2025', range('2025-07-01', '2025-07-31'));
  assertResolved('learners in July', range('2026-07-01', '2026-07-31'));
  assertResolved('report from Sep 2025 to Nov 2025', range('2025-09-01', '2025-11-30'));
  assertResolved('enrollments between July 1 and July 31, 2025', range('2025-07-01', '2025-07-31'));
  assertResolved('report from 1 July 2025 to 15 August 2025', range('2025-07-01', '2025-08-15'));
});

test('does not read ordinary words as month names', () => {
  assertResolved('báo cáo cho sếp tháng 7', range('2026-07-01', '2026-07-31'));
  assertResolved('May I see the completion rate this month?', range('2026-10-01', '2026-10-08'));
  assert.equal(parse('có trên 2000 học viên').status, 'none');
  assert.equal(parse('Báo cáo tỷ lệ hoàn thành').status, 'none');
});

test('reads quarters, halves and whole years', () => {
  assertResolved('quý 3 năm 2025', range('2025-07-01', '2025-09-30'));
  assertResolved('quý 3', range('2026-07-01', '2026-09-30'));
  assertResolved('Q3/2025', range('2025-07-01', '2025-09-30'));
  assertResolved('quý 2 năm nay', range('2026-04-01', '2026-06-30'));
  assertResolved('third quarter of 2025', range('2025-07-01', '2025-09-30'));
  assertResolved('nửa đầu năm 2025', range('2025-01-01', '2025-06-30'));
  assertResolved('H2 2025', range('2025-07-01', '2025-12-31'));
  assertResolved('năm 2025', range('2025-01-01', '2025-12-31'));
  // "Q1" is also a district name: without a year or date preposition it is not a quarter.
  assertResolved('báo cáo chi nhánh Q1 tháng 5', range('2026-05-01', '2026-05-31'));
});

test('resolves relative periods against today with Monday weeks', () => {
  assertResolved('tuần này', range('2026-10-05', '2026-10-08'));
  assertResolved('tuần trước', range('2026-09-28', '2026-10-04'));
  assertResolved('tháng này', range('2026-10-01', '2026-10-08'));
  assertResolved('tháng trước', range('2026-09-01', '2026-09-30'));
  assertResolved('năm nay', range('2026-01-01', '2026-10-08'));
  assertResolved('năm ngoái', range('2025-01-01', '2025-12-31'));
  assertResolved('quý trước', range('2026-07-01', '2026-09-30'));
  assertResolved('hôm nay', range('2026-10-08', '2026-10-08'));
  assertResolved('hôm qua', range('2026-10-07', '2026-10-07'));
  assertResolved('30 ngày qua', range('2026-09-09', '2026-10-08'));
  assertResolved('last 30 days', range('2026-09-09', '2026-10-08'));
  assertResolved('3 tháng gần đây', range('2026-07-09', '2026-10-08'));
  assertResolved('year to date', range('2026-01-01', '2026-10-08'));
});

test('marks "tuần qua / tháng qua" as medium confidence with the rolling alternative', () => {
  const result = parse('tháng qua');
  assert.equal(result.confidence, 'medium');
  assert.deepEqual(result.range, range('2026-09-01', '2026-09-30'));
  assert.deepEqual(result.alternatives, [range('2026-09-09', '2026-10-08')]);
});

test('reads "đến nay / hôm nay" as an end at today', () => {
  assertResolved('từ 1/7 đến nay', range('2026-07-01', '2026-10-08'));
  assertResolved('tháng 7 đến nay', range('2026-07-01', '2026-10-08'));
  assertResolved('từ 1/7 đến hôm nay', range('2026-07-01', '2026-10-08'));
  assertResolved('từ đầu năm đến nay', range('2026-01-01', '2026-10-08'));
  assertResolved('since March', range('2026-03-01', '2026-10-08'));
  // "since November" asked before November means last November.
  assertResolved('từ tháng 11 đến nay', range('2025-11-01', '2026-10-08'));
});

test('asks for a start when only "đến nay" is given', () => {
  const result = parse('đến nay có bao nhiêu học viên');
  assert.equal(result.status, 'needs_clarification');
  assert.equal(result.issue, 'open_range');
  assert.equal(result.alternatives.length, 3);
});

test('resolves cross-year ranges', () => {
  assertResolved('từ tháng 11 đến tháng 2 năm 2026', range('2025-11-01', '2026-02-28'));
  assertResolved('từ tháng 11 đến tháng 2', range('2025-11-01', '2026-02-28'));
  assertResolved('từ 15/12 đến 10/1', range('2025-12-15', '2026-01-10'));
  assertResolved('từ 15/12/2025 đến 10/1', range('2025-12-15', '2026-01-10'));
});

test('turns reversed, too long, impossible and future-without-year periods into issues with options', () => {
  const reversed = parse('từ 31/7 đến 1/7');
  assert.equal(reversed.issue, 'reversed_range');
  assert.deepEqual(reversed.alternatives, [range('2026-07-01', '2026-07-31')]);

  const tooLong = parse('từ 1/1/2024 đến 31/12/2025');
  assert.equal(tooLong.issue, 'range_too_long');
  assert.deepEqual(tooLong.alternatives, [range('2024-12-31', '2025-12-31'), range('2024-01-01', '2024-12-31')]);

  const impossible = parse('ngày 31/2');
  assert.equal(impossible.issue, 'invalid_date');
  assert.deepEqual(impossible.alternatives, [range('2026-02-28', '2026-02-28')]);

  const future = parse('tháng 11');
  assert.equal(future.issue, 'future_without_year');
  assert.deepEqual(future.alternatives, [range('2025-11-01', '2025-11-30'), range('2026-11-01', '2026-11-30')]);

  // A stated future year is respected (it simply has no data yet).
  assertResolved('tháng 12/2026', range('2026-12-01', '2026-12-31'));
});

test('handles several periods: comparison with the previous period vs. a real choice', () => {
  const comparison = parse('so sánh tháng 6 với tháng 5');
  assert.equal(comparison.status, 'resolved');
  assert.deepEqual(comparison.range, range('2026-06-01', '2026-06-30'));
  assert.equal(comparison.compare, true);
  assertResolved('so sánh tháng này với tháng trước', range('2026-10-01', '2026-10-08'));

  const choice = parse('tháng 5 và tháng 7');
  assert.equal(choice.issue, 'multiple_periods');
  assert.deepEqual(choice.alternatives, [range('2026-05-01', '2026-05-31'), range('2026-07-01', '2026-07-31'), range('2026-05-01', '2026-07-31')]);

  // A context year is not a second period.
  assertResolved('năm 2025, từ tháng 3 đến tháng 5', range('2025-03-01', '2025-05-31'));
});

test('clamps the part of a period after today and records it', () => {
  const result = parse('báo cáo tháng 10');
  assert.deepEqual(result.range, range('2026-10-01', '2026-10-08'));
  assert.equal(result.clamped_to_today, true);
});

test('detects an explicit breakdown granularity only', () => {
  assert.equal(parse('báo cáo theo tuần tháng 9').granularity, 'week');
  assert.equal(parse('monthly enrollments this year').granularity, 'month');
  assert.equal(parse('báo cáo hàng ngày tuần này').granularity, 'day');
  assert.equal(parse('báo cáo theo tháng 7').granularity, null);
});

test('validates ranges deterministically', () => {
  assert.equal(validateReportRange(range('2026-07-01', '2026-07-31')).issue, null);
  assert.equal(validateReportRange(range('2026-07-31', '2026-07-01')).issue, 'reversed_range');
  assert.equal(validateReportRange(range('2025-01-01', '2026-01-02')).issue, 'range_too_long');
  assert.equal(validateReportRange(range('2026-02-30', '2026-03-01')).issue, 'invalid_date');
});

test('agreement tolerates days after today and a model-guessed year only when the user gave none', () => {
  assert.equal(reportRangesAgree(range('2026-10-01', '2026-10-08'), range('2026-10-01', '2026-10-31'), today, false), true);
  assert.equal(reportRangesAgree(range('2026-07-01', '2026-07-31'), range('2024-07-01', '2024-07-31'), today, true), true);
  assert.equal(reportRangesAgree(range('2026-07-01', '2026-07-31'), range('2024-07-01', '2024-07-31'), today, false), false);
  assert.equal(reportRangesAgree(range('2026-07-01', '2026-07-31'), range('2026-07-01', '2026-07-30'), today, true), false);
});

test('never asks the chart for more than 62 buckets', () => {
  assert.equal(resolveSnapshotChartGranularity(null, range('2026-01-01', '2026-10-08')), 'auto');
  assert.equal(resolveSnapshotChartGranularity('day', range('2026-09-01', '2026-09-30')), 'day');
  assert.equal(resolveSnapshotChartGranularity('day', range('2026-01-01', '2026-10-08')), 'week');
  assert.equal(resolveSnapshotChartGranularity('week', range('2026-01-01', '2026-10-08')), 'week');
  assert.equal(resolveSnapshotChartGranularity('quarter', range('2026-01-01', '2026-10-08')), 'month');
});

test('offers the closest month with data around an empty period', () => {
  assert.deepEqual(
    resolveNearestReportDataPeriod({ before: '2026-08-24', after: null, range: range('2026-09-01', '2026-09-30'), today }),
    { date_from: '2026-08-01', date_to: '2026-08-31', direction: 'before' },
  );
  assert.deepEqual(
    resolveNearestReportDataPeriod({ before: '2025-01-03', after: '2026-10-02', range: range('2026-09-01', '2026-09-30'), today }),
    { date_from: '2026-10-01', date_to: '2026-10-08', direction: 'after' },
  );
  assert.equal(resolveNearestReportDataPeriod({ before: null, after: null, range: range('2026-09-01', '2026-09-30'), today }), null);
});
