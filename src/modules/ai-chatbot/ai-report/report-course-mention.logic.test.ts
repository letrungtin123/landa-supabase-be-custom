import assert from 'node:assert/strict';
import test from 'node:test';
import { formatReportClarificationMessage } from './report-chat-clarification.logic.js';
import { buildReportClarification } from './report-chat-route.logic.js';
import { COURSE_IDS, REPORT_COURSE_CATALOG, REPORT_UNIT_CATALOG } from './report-chat.fixture.js';
import { dayCountBetween, MAX_REPORT_RANGE_DAYS, rollingMonthsRange } from './report-date.logic.js';
import {
  isReportCourseQuestion,
  isScannableReportCourseName,
  reportCourseChoiceNames,
  resolveReportCourseMention,
  scanReportCourseNames,
  type ReportCourseResolution,
} from './report-course-mention.logic.js';

const unitNames = REPORT_UNIT_CATALOG.units.map((unit) => unit.name);

function resolve(question: string, modelCourse: string | null = null): ReportCourseResolution {
  return resolveReportCourseMention({ question, catalog: REPORT_COURSE_CATALOG, modelCourse, unitNames });
}

function resolvedId(resolution: ReportCourseResolution): string | null {
  return resolution.status === 'resolved' ? resolution.course.id : null;
}

test('the production question finds the course without the words "khóa học", preferring the longest name', () => {
  const resolution = resolve('Customer experience v2 có bao nhiêu học viên tham gia');
  assert.deepEqual(resolution, {
    status: 'resolved',
    course: { id: COURSE_IDS.customerExperienceV2, name: 'Customer Experience V2' },
    source: 'question',
  });
  assert.equal(resolvedId(resolve('Customer Experience có bao nhiêu học viên tham gia?')), COURSE_IDS.customerExperience);
  assert.equal(resolvedId(resolve('How many learners are enrolled in Customer Experience V2?')), COURSE_IDS.customerExperienceV2);
});

test('accents, case and punctuation do not matter; a name never spans a sentence break', () => {
  assert.equal(resolvedId(resolve('CUSTOMER-EXPERIENCE v2: có bao nhiêu học viên?')), COURSE_IDS.customerExperienceV2);
  assert.equal(resolvedId(resolve('an toan lao dong va 5s tai noi lam viec co bao nhieu hoc vien')), COURSE_IDS.safety);
  assert.equal(resolvedId(resolve('Có bao nhiêu học viên hoàn thành An Toàn Lao Động Và 5S Tại Nơi Làm Việc?')), COURSE_IDS.safety);
  assert.equal(resolve('Customer, Experience có bao nhiêu học viên?').status, 'none');
  // Punctuation that is part of the name itself is fine.
  const catalog = { truncated: false, courses: [{ id: 'bic-v2', name: 'BiC Modun 1: Change Mindset - Think Big Do Right_V2' }] };
  const question = 'Bao nhiêu học viên học BiC Modun 1: Change Mindset - Think Big Do Right_V2?';
  assert.equal(resolvedId(resolveReportCourseMention({ question, catalog })), 'bic-v2');
});

test('two different courses tying for the longest name are never guessed', () => {
  const tie = resolve('Customer Experience và Quality Check có bao nhiêu học viên?');
  assert.equal(tie.status, 'ambiguous');
  assert.deepEqual(tie.status === 'ambiguous' ? tie.courses.map((course) => course.id).sort() : [], [COURSE_IDS.customerExperience, COURSE_IDS.qualityCheck].sort());
  // A longer name still wins over a shorter, different one.
  assert.equal(resolvedId(resolve('Customer Experience V2 và Quality Check có bao nhiêu học viên?')), COURSE_IDS.customerExperienceV2);
  // Two courses sharing one name: ambiguous, listed under that one name.
  const shared = resolve('Kỹ năng bán hàng có bao nhiêu học viên?');
  assert.equal(shared.status, 'ambiguous');
  assert.deepEqual(shared.status === 'ambiguous' ? reportCourseChoiceNames(shared.courses) : [], ['Kỹ năng bán hàng']);
  // The same course written twice is one course.
  assert.equal(resolvedId(resolve('Quality Check có bao nhiêu học viên, Quality Check hoàn thành bao nhiêu?')), COURSE_IDS.qualityCheck);
});

test('short and generic names are not looked for in free text, only as an explicit reference', () => {
  assert.equal(isScannableReportCourseName('HSE'), false);
  assert.equal(isScannableReportCourseName('Test 1'), false);
  assert.equal(isScannableReportCourseName('Khoá học 1'), false);
  assert.equal(isScannableReportCourseName('test v6'), false);
  assert.equal(isScannableReportCourseName('Pilot'), false);
  assert.equal(isScannableReportCourseName('Quality Check'), true);
  assert.equal(resolve('HSE có bao nhiêu học viên?').status, 'none');
  assert.equal(resolve('Test 1 có bao nhiêu học viên?').status, 'none');
  assert.equal(resolvedId(resolve('Khóa học HSE có bao nhiêu học viên?')), COURSE_IDS.hse);
});

test('another version of a name, or a name written as an org unit, is not that course', () => {
  assert.equal(resolve('Customer Experience V3 có bao nhiêu học viên?').status, 'none');
  assert.equal(resolve('Customer Experience 4 có bao nhiêu học viên?').status, 'none');
  // "3 tháng gần đây" is a period, not a version.
  assert.equal(resolvedId(resolve('Customer Experience 3 tháng gần đây có bao nhiêu học viên?')), COURSE_IDS.customerExperience);
  // A course named like an org unit is only picked when written as a course.
  assert.equal(resolve('Marketing có bao nhiêu học viên?').status, 'none');
  assert.equal(resolvedId(resolve('Khóa học Marketing có bao nhiêu học viên?')), COURSE_IDS.marketing);
  const scan = (question: string) => scanReportCourseNames({ question, catalog: REPORT_COURSE_CATALOG });
  assert.equal(resolvedId(scan('Marketing có bao nhiêu học viên?')), COURSE_IDS.marketing);
  assert.equal(scan('Có bao nhiêu học viên trong team Marketing?').status, 'none');
  assert.equal(scan('How many learners in the Marketing team?').status, 'none');
});

test('one small typo in one long word is accepted only when nothing matches exactly', () => {
  assert.equal(resolvedId(resolve('Custmer Experience V2 có bao nhiêu học viên?')), COURSE_IDS.customerExperienceV2);
  assert.equal(resolvedId(resolve('Customer Experiance có bao nhiêu học viên?')), COURSE_IDS.customerExperience);
  // Short words, numbers and two typos are not guessed.
  assert.equal(resolve('Quality Chek có bao nhiêu học viên?').status, 'none');
  assert.equal(resolve('Custmer Experiance có bao nhiêu học viên?').status, 'none');
  // An exact name elsewhere in the question wins over a typo.
  assert.equal(resolvedId(resolve('Quality Check và Custmer Experience V2 có bao nhiêu học viên?')), COURSE_IDS.qualityCheck);
});

test('only learner, enrollment, progress or completion questions look for a course', () => {
  for (const question of ['Customer Experience V2 có bao nhiêu học viên', 'Tiến độ Customer Experience V2', 'Tỉ lệ hoàn thành Customer Experience V2', 'Danh sách người học Customer Experience V2', 'Who completed Customer Experience V2?', 'Enrollments of Customer Experience V2']) {
    assert.equal(isReportCourseQuestion(question), true, question);
    assert.equal(resolvedId(resolve(question)), COURSE_IDS.customerExperienceV2, question);
  }
  assert.equal(isReportCourseQuestion('Customer Experience V2 là gì?'), false);
  assert.equal(resolve('Customer Experience V2 là gì?').status, 'none');
});

test('an explicit reference decides first; a quoted or shared name keeps the existing lookup; the model hint comes last', () => {
  // "khóa X" names Customer Experience even if V2 is mentioned later.
  assert.equal(resolvedId(resolve('Khóa Customer Experience có bao nhiêu người học, so với Customer Experience V2?')), COURSE_IDS.customerExperience);
  // A reference with trailing words falls back to the names in the question.
  assert.equal(resolvedId(resolve('Khóa Customer Experience V2 hiện có bao nhiêu học viên?')), COURSE_IDS.customerExperienceV2);
  // A quoted name is taken literally: an unknown one is not replaced by a similar course.
  assert.equal(resolve('Khóa học "Customer Experience V3" có bao nhiêu học viên?').status, 'none');
  assert.equal(resolvedId(resolve('Khóa học "Customer Experience" có bao nhiêu học viên?')), COURSE_IDS.customerExperience);
  // A reference shared by two courses is resolved by the snapshot among the period's courses, as before.
  assert.equal(resolve('Khóa học Kỹ năng bán hàng có bao nhiêu học viên?').status, 'none');
  // The router hint only counts when it names exactly one catalog course and the question names none.
  assert.deepEqual(resolve('Có bao nhiêu học viên tham gia khóa này?', 'Quality Check'), {
    status: 'resolved', course: { id: COURSE_IDS.qualityCheck, name: 'Quality Check' }, source: 'model',
  });
  assert.equal(resolvedId(resolve('Customer experience v2 có bao nhiêu học viên tham gia', 'Customer experience')), COURSE_IDS.customerExperienceV2);
  assert.equal(resolve('Có bao nhiêu học viên tham gia khóa này?', 'Unknown course').status, 'none');
});

test('the course default period is the last 12 months ending today and stays within the 366-day cap', () => {
  assert.deepEqual(rollingMonthsRange('2026-10-08', 12), { date_from: '2025-10-09', date_to: '2026-10-08' });
  for (const today of ['2028-02-29', '2028-03-01', '2027-02-28', '2026-12-31']) {
    const range = rollingMonthsRange(today, 12);
    assert.ok(dayCountBetween(range.date_from, range.date_to) <= MAX_REPORT_RANGE_DAYS, `${today}: ${JSON.stringify(range)}`);
  }
  assert.deepEqual(rollingMonthsRange('2028-02-29', 12), { date_from: '2027-03-01', date_to: '2028-02-29' });
});

test('the course clarification names the courses from the question in vi and en', () => {
  const several = buildReportClarification({ reasons: ['course_ambiguous'], periods: [], units: [], courses: ['Customer Experience', 'Quality Check'] });
  assert.deepEqual(several.options, []);
  assert.deepEqual(several.params, { courses: ['Customer Experience', 'Quality Check'] });
  assert.equal(
    formatReportClarificationMessage(several, 'vi'),
    'Câu hỏi nhắc đến nhiều khóa học: “Customer Experience”, “Quality Check”. Hãy hỏi lại với tên một khóa học trong dấu ngoặc kép. Mở bộ lọc để chọn thời gian và đơn vị.',
  );
  assert.equal(
    formatReportClarificationMessage(several, 'en'),
    'Your question names several courses: “Customer Experience”, “Quality Check”. Ask again with one course name in quotes. Open the filters to choose the period and unit.',
  );
  const shared = buildReportClarification({ reasons: ['course_ambiguous'], periods: [], units: [], courses: ['Kỹ năng bán hàng'] });
  assert.equal(formatReportClarificationMessage(shared, 'vi'), 'Có nhiều khóa học cùng tên “Kỹ năng bán hàng”, nên chưa thể chọn đúng một khóa học. Mở bộ lọc để chọn thời gian và đơn vị.');
  assert.equal(formatReportClarificationMessage(shared, 'en'), 'Several courses are named “Kỹ năng bán hàng”, so one course cannot be chosen. Open the filters to choose the period and unit.');
});
