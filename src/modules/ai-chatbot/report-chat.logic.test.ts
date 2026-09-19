import assert from 'node:assert/strict';
import test from 'node:test';
import { pool } from '../../config/database.js';
import {
  getVietnameseReportKpiVocabulary,
  hasDeterministicReportIntent,
  isPotentialReportYearCorrection,
  normalizeReportChatFilter,
  resolveReportDateFilter,
  resolveReportYearCorrection,
} from './report-chat.service.js';

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

test('uses the exact Vietnamese KPI titles shown in the learning report dashboard', () => {
  assert.deepEqual(
    getVietnameseReportKpiVocabulary().map((metric) => [metric.key, metric.title]),
    [
      ['total_learners', 'Tổng học viên đã đào tạo'],
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
