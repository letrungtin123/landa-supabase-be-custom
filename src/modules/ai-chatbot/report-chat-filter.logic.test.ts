import assert from 'node:assert/strict';
import test from 'node:test';
import { parseReportFilters } from './report-chat-filter.logic.js';
import { REPORT_CHAT_ERRORS, reportChatErrorBody } from './report-chat-error.logic.js';

const GROUP = '00000000-0000-4000-8000-000000000001';
const TEAM = '00000000-0000-4000-8000-000000000105';

test('accepts an absent or empty filter', () => {
  assert.deepEqual(parseReportFilters(undefined), { ok: true, value: undefined });
  assert.deepEqual(parseReportFilters({}), { ok: true, value: {} });
});

test('accepts a complete filter and drops "all" or empty unit IDs', () => {
  assert.deepEqual(
    parseReportFilters({ date_from: '2026-07-01', date_to: '2026-07-31', group_id: GROUP, subgroup_id: 'all', team_id: TEAM }),
    { ok: true, value: { date_from: '2026-07-01', date_to: '2026-07-31', group_id: GROUP, team_id: TEAM } },
  );
  assert.deepEqual(parseReportFilters({ group_id: '' }), { ok: true, value: {} });
});

test('accepts exactly 366 days and rejects 367', () => {
  assert.equal(parseReportFilters({ date_from: '2024-01-01', date_to: '2024-12-31' }).ok, true);
  assert.deepEqual(parseReportFilters({ date_from: '2025-01-01', date_to: '2026-01-02' }), { ok: false, code: 'REPORT_FILTER_RANGE_TOO_LONG' });
});

test('rejects malformed input with a specific code', () => {
  for (const value of [null, [], 'x', 1]) {
    assert.deepEqual(parseReportFilters(value), { ok: false, code: 'REPORT_FILTERS_INVALID' }, String(value));
  }
  assert.deepEqual(parseReportFilters({ date_from: '2026/07/01', date_to: '2026-07-31' }), { ok: false, code: 'REPORT_FILTER_DATE_INVALID' });
  assert.deepEqual(parseReportFilters({ date_from: '2026-02-31', date_to: '2026-03-31' }), { ok: false, code: 'REPORT_FILTER_DATE_INVALID' });
  assert.deepEqual(parseReportFilters({ date_from: 20260701, date_to: '2026-07-31' }), { ok: false, code: 'REPORT_FILTER_DATE_INVALID' });
  assert.deepEqual(parseReportFilters({ date_from: '2026-07-01' }), { ok: false, code: 'REPORT_FILTER_RANGE_INCOMPLETE' });
  assert.deepEqual(parseReportFilters({ date_from: '2026-07-31', date_to: '2026-07-01' }), { ok: false, code: 'REPORT_FILTER_RANGE_REVERSED' });
  assert.deepEqual(parseReportFilters({ team_id: 'team-1' }), { ok: false, code: 'REPORT_FILTER_UNIT_INVALID' });
  assert.deepEqual(parseReportFilters({ group_id: 42 }), { ok: false, code: 'REPORT_FILTER_UNIT_INVALID' });
});

test('every report error code has a status and distinct Vietnamese and English messages', () => {
  for (const [code, [status, vi, en]] of Object.entries(REPORT_CHAT_ERRORS)) {
    assert.ok(status >= 400 && status < 600, code);
    assert.ok(vi.trim() && en.trim() && vi !== en, code);
  }
  assert.deepEqual(reportChatErrorBody('REPORT_FILTER_RANGE_REVERSED', 'en'), {
    status: 400,
    body: { success: false, message: 'The start date must be on or before the end date.', code: 'REPORT_FILTER_RANGE_REVERSED' },
  });
  assert.equal(reportChatErrorBody('REPORT_FILTER_RANGE_REVERSED', 'vi').body.message, 'Ngày bắt đầu phải trước hoặc trùng ngày kết thúc.');
});
