import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCourseLearnerExcelFileName,
  buildReportExcelFileName,
  getReportExcelCopy,
  normalizeReportExcelLocale,
  resolveReportExcelLabels,
} from './reports-export.service.js';

test('normalizes only the supported Excel export locales', () => {
  assert.equal(normalizeReportExcelLocale('en'), 'en');
  assert.equal(normalizeReportExcelLocale('vi'), 'vi');
  assert.equal(normalizeReportExcelLocale('EN'), 'vi');
  assert.equal(normalizeReportExcelLocale(undefined), 'vi');
});

test('uses English structural copy for English Excel exports', () => {
  const copy = getReportExcelCopy('en');

  assert.equal(copy.information, 'Information');
  assert.equal(copy.course, 'Course');
  assert.equal(copy.statuses.completed, 'Completed');
  assert.equal(copy.statuses.learning, 'In progress');
  assert.equal(copy.statuses.not_started, 'Not started');
  assert.equal(copy.months[7], 'July');
});

test('keeps Vietnamese filenames for legacy exports and uses English filenames when requested', () => {
  const dateRange = {
    startDate: new Date('2026-07-01T00:00:00.000+07:00'),
    endDate: new Date('2026-07-31T23:59:59.999+07:00'),
    dateFrom: '2026-07-01',
    dateTo: '2026-07-31',
  };

  assert.equal(
    buildReportExcelFileName('vi', dateRange, undefined, 2026),
    'bao-cao-tong-hop-2026-07-01-den-2026-07-31.xlsx',
  );
  assert.equal(
    buildReportExcelFileName('en', dateRange, undefined, 2026),
    'learning-report-2026-07-01-to-2026-07-31.xlsx',
  );
  assert.equal(
    buildCourseLearnerExcelFileName('vi', 'An toàn bảo mật hệ thống & AI', dateRange, undefined, 2026),
    'chi-tiet-hoc-vien-an-toan-bao-mat-he-thong-ai-2026-07-01-den-2026-07-31.xlsx',
  );
  assert.equal(
    buildCourseLearnerExcelFileName('en', 'System Security & AI', dateRange, undefined, 2026),
    'course-learners-system-security-ai-2026-07-01-to-2026-07-31.xlsx',
  );
});

test('names the organization levels with the tenant labels, then the client names, then the localized defaults', () => {
  const nesso = { group: 'Khối/Khu vực', subgroup: 'Đơn vị', team: 'Bộ phận' };
  assert.deepEqual(resolveReportExcelLabels(nesso, { group: 'Công ty', team: 'Phòng ban' }, 'en'), nesso, 'configured labels win, in English too');
  assert.deepEqual(resolveReportExcelLabels({}, { group: ' Khối ', subgroup: '', team: 42 }, 'vi'), { group: 'Khối', subgroup: 'Chi nhánh', team: 'Phòng ban' });
  assert.deepEqual(resolveReportExcelLabels({ team: '  ' }, {}, 'en'), { group: 'Company', subgroup: 'Branch', team: 'Department' });
});

test('the team breakdown member column names the team level instead of a fixed word', () => {
  assert.equal(getReportExcelCopy('vi').currentTeamMembers('bộ phận'), 'Học viên hiện thuộc bộ phận');
  assert.equal(getReportExcelCopy('en').currentTeamMembers('department'), 'Current department members');
});
