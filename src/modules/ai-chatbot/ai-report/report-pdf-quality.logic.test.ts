// Report PDF quality rules (template 3.2.0): completion-rate wording, small
// comparison bases, chart buckets, peak wording, per-course activation risk,
// data checks, signal-tied recommendations, capped course table, cover logo.
// No browser, no database, no AI provider (AI answers are fakes).
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReportInsights } from './report-insights.logic.js';
import { reportPdfEn } from './report-pdf-i18n.en.js';
import { reportPdfVi } from './report-pdf-i18n.vi.js';
import { estimateReportPdfLayout, planReportPdfPages } from './report-pdf-layout.logic.js';
import {
  buildReportRecommendationCandidates,
  buildRuleBasedReportNarrative,
  describeReportFact,
  validateReportPdfNarrative,
  type ReportPdfNarrative,
} from './report-pdf-narrative.logic.js';
import { renderReportPdfHtml } from './report-pdf-template/document.js';
import { buildReportPdfViewModel, REPORT_PDF_TEMPLATE_VERSION, type ReportPdfViewModel } from './report-pdf-view-model.js';
import { composeReportPdfDocument } from './report-pdf.service.js';
import {
  longNamesReportFixture,
  manyCoursesReportFixture,
  smallBaseReportFixture,
  vietnameseReportFixture,
  weeklyReportFixture,
  yearlyReportFixture,
  tinyReportFixture,
  englishReportFixture,
  type ReportPdfFixture,
} from './report-pdf.fixture.js';
import type { StoredReportChatSnapshot } from './report-chat.service.js';

const NO_FONTS = { fontCss: '/* fonts omitted in tests */' };

function model(fixture: ReportPdfFixture, locale = fixture.locale, logoDataUri: string | null = null): ReportPdfViewModel {
  const insights = buildReportInsights(fixture.snapshot, fixture.labels);
  return buildReportPdfViewModel({
    snapshot: fixture.snapshot, snapshotHash: fixture.snapshotHash, locale,
    tenant: { name: fixture.tenantName, logoDataUri }, insights, narrative: buildRuleBasedReportNarrative(insights, locale),
  });
}

const fact = (fixture: ReportPdfFixture, id: string) => {
  const insights = buildReportInsights(fixture.snapshot, fixture.labels);
  return { insights, fact: insights.facts.find((item) => item.id === id) };
};

test('1. the Completion rate keeps its name and value, with a plain note; status shares are labelled as shares of enrollments', () => {
  const vi = model(smallBaseReportFixture());
  const rate = vi.kpis.find((card) => card.id === 'completion_rate')!;
  assert.deepEqual([rate.label, rate.value, rate.hint], ['Tỉ lệ hoàn thành', '67,1%', 'Tính theo tiến độ trung bình của học viên']);
  assert.equal(vi.coverKpis.find((card) => card.id === 'completion_rate')?.hint, rate.hint, 'the note is also on the cover, where the rate first appears');
  assert.ok(vi.kpis.filter((card) => card.id !== 'completion_rate').every((card) => card.hint === null));
  assert.equal(vi.courses.statusNote, reportPdfVi.courses.statusShareNote);
  const document = renderReportPdfHtml(vi, NO_FONTS);
  for (const text of [rate.hint!, reportPdfVi.courses.statusShareNote, reportPdfVi.courses.portfolioLegend, 'Tỉ trọng ghi danh']) {
    assert.ok(document.includes(text), text);
  }
  const statusFinding = buildRuleBasedReportNarrative(buildReportInsights(smallBaseReportFixture().snapshot), 'vi').findings.find((item) => item.factIds.includes('status.mix'));
  assert.match(statusFinding?.text ?? '', /^Tỉ trọng 421 lượt ghi danh của kỳ theo trạng thái: 58,2% đã hoàn thành/);
  const en = model(smallBaseReportFixture('en'), 'en');
  assert.equal(en.kpis.find((card) => card.id === 'completion_rate')?.label, 'Completion rate');
  assert.equal(en.kpis.find((card) => card.id === 'completion_rate')?.hint, reportPdfEn.kpi.completionHint);
});

test('2. a small comparison period shows the absolute change and a plain note, never the percentage', () => {
  const insights = buildReportInsights(smallBaseReportFixture().snapshot);
  const vi = model(smallBaseReportFixture());
  const card = vi.kpis.find((item) => item.id === 'total_enrollments')!;
  assert.deepEqual([card.deltaLabel, card.deltaNote], ['+374', 'Kỳ trước quá ít dữ liệu để so sánh theo %']);
  assert.deepEqual(vi.coverKpis.map((item) => item.deltaLabel), ['+33,3 điểm %', '+374', '+61']);
  assert.equal(vi.kpis.find((item) => item.id === 'total_learners')?.deltaLabel, '−2 · −18,2%', 'a normal base keeps its percentage');
  const narrative = buildRuleBasedReportNarrative(insights, 'vi');
  const prose = [narrative.headline, ...narrative.findings, ...narrative.risks, ...narrative.recommendations].map((item) => item.text).join(' ');
  for (const hidden of ['795', '6.100', '1.066', '576,9', '765']) assert.ok(!prose.includes(hidden), hidden);
  assert.match(narrative.headline.text, /421 lượt ghi danh \(tăng 374 so với tháng trước; kỳ trước quá ít dữ liệu để so sánh theo %\)/);
  assert.ok(narrative.findings.some((item) => item.text === 'Trung bình 13,6 lượt ghi danh mỗi ngày, tăng so với mức trung bình 1,6 của kỳ so sánh; kỳ trước quá ít dữ liệu để so sánh theo %.'));
  assert.ok(vi.appendix.methodology.some((text) => text.startsWith('Thay đổi theo %: chỉ hiển thị khi giá trị kỳ so sánh từ 10 trở lên và mức thay đổi không quá 300%')));
  const en = model(smallBaseReportFixture('en'), 'en');
  assert.deepEqual([en.kpis[0].deltaLabel, en.kpis[0].deltaNote], ['+374', 'Previous period too small for a % change']);

  const tinyRate = model(tinyReportFixture('vi')).kpis.find((item) => item.id === 'completion_rate')!;
  assert.deepEqual([tinyRate.deltaLabel, tinyRate.deltaNote], [null, reportPdfVi.kpi.smallBaseRate], 'too few enrollments: no rate change at all');
});

test('2. the narrative validator rejects a narrative that quotes a withheld percentage', () => {
  const insights = buildReportInsights(smallBaseReportFixture().snapshot);
  const rules = buildRuleBasedReportNarrative(insights, 'vi');
  const quoting = (text: string, factIds: string[]): ReportPdfNarrative => ({ ...structuredClone(rules), source: 'ai', findings: [{ text, factIds, tone: 'positive' }, ...rules.findings.slice(1)] });
  assert.ok(validateReportPdfNarrative(quoting('Lượt ghi danh đạt 421, tăng 795,7% so với tháng trước.', ['kpi.total_enrollments']), insights, 'vi').issues
    .includes('findings[0]: small_base_percent:795,7'));
  assert.ok(validateReportPdfNarrative(quoting('Số học viên có hoạt động học tăng 6.100%.', ['kpi.active_learners']), insights, 'vi').issues
    .includes('findings[0]: small_base_percent:6.100'));
  assert.ok(validateReportPdfNarrative(quoting('Trung bình 13,6 lượt mỗi ngày, tăng 765% so với kỳ so sánh.', ['trend.enrollments.vs_previous']), insights, 'vi').issues
    .includes('findings[0]: small_base_percent:765'));
  assert.deepEqual(validateReportPdfNarrative(quoting('Lượt ghi danh đạt 421, tăng 374 so với tháng trước.', ['kpi.total_enrollments']), insights, 'vi').issues, []);
});

test('3. week and month charts: lighter cut edges, notes, labels with the year across two years', () => {
  const weeklyChart = model(weeklyReportFixture()).trends.enrollments!;
  assert.equal(weeklyChart.title, 'Lượt ghi danh theo tuần');
  assert.deepEqual(weeklyChart.labels, ['17/06', '22/06', '29/06', '06/07', '13/07', '20/07', '27/07'], 'first day of each week inside the period');
  assert.deepEqual(weeklyChart.partialIndexes, [0, 6]);
  assert.equal(weeklyChart.previousValues?.[0], null, 'a cut comparison week is not drawn');
  assert.equal(weeklyChart.stats.find((stat) => stat.label === reportPdfVi.trends.average.week)?.value, '72,5');
  assert.ok(weeklyChart.notes.includes(reportPdfVi.trends.partialWeekNote) && weeklyChart.notes.includes(reportPdfVi.trends.weekAxisNote));
  assert.ok(weeklyChart.legend.some((item) => item.key === 'partial'));

  const yearly = model(yearlyReportFixture()).trends.enrollments!;
  assert.deepEqual([yearly.labels[0], yearly.labels[3], yearly.labels.at(-1)], ['T10/2025', 'T1/2026', 'T10/2026']);
  assert.ok(yearly.notes.includes(reportPdfVi.trends.partialMonthNote));
  assert.deepEqual(model({ ...yearlyReportFixture(), locale: 'en' }, 'en').trends.enrollments!.labels.slice(0, 2), ['Oct 2025', 'Nov 2025']);
  const byDay = model(yearlyReportFixture({ requestedDay: true })).trends.enrollments!;
  assert.equal(byDay.labels[0], '11/10/2025', 'days of a range across two years carry the year');
  assert.ok(byDay.notes.some((note) => note.startsWith('Bạn yêu cầu xem theo ngày, nhưng kỳ báo cáo dài hơn 62 ngày nên biểu đồ hiển thị theo tuần')));
  assert.equal(model(vietnameseReportFixture()).trends.enrollments!.labels[0], '01/07', 'one calendar year: no year on day labels');
  assert.ok(model(vietnameseReportFixture()).appendix.methodology.some((text) => text.includes('kỳ đến 31 ngày hiển thị theo ngày, đến 120 ngày theo tuần')));
});

test('4. a peak is worded by its bucket: a day, a week or a month', () => {
  const words = (fixture: ReportPdfFixture, locale: 'vi' | 'en') => {
    const { insights, fact: peak } = fact(fixture, 'trend.enrollments.peak');
    return describeReportFact(peak!, insights, locale)!;
  };
  assert.equal(words(yearlyReportFixture(), 'vi'), 'Lượt ghi danh đạt đỉnh vào tháng 08/2026 với 350 lượt, gấp 1,3 lần mức trung bình của kỳ.');
  assert.equal(words(yearlyReportFixture(), 'en'), 'Enrollments peaked in Aug 2026 at 350, 1.3 times the period average.');
  assert.ok(!words(yearlyReportFixture(), 'vi').includes('01/08/2026'));
  assert.equal(words(weeklyReportFixture(), 'vi'), 'Lượt ghi danh đạt đỉnh vào tuần 13/07–19/07/2026 với 90 lượt, gấp 1,2 lần mức trung bình của kỳ.');
  assert.equal(words(weeklyReportFixture(), 'en'), 'Enrollments peaked in the week of 13–19 Jul 2026 at 90, 1.2 times the period average.');
  assert.equal(words(smallBaseReportFixture(), 'vi'), 'Lượt ghi danh đạt đỉnh vào ngày 15/07/2026 với 26 lượt, gấp 1,9 lần mức trung bình của kỳ.');
  assert.equal(model(yearlyReportFixture()).trends.enrollments!.stats.find((stat) => stat.label === reportPdfVi.trends.peak)?.detail, 'Tháng 08/2026');
  assert.equal(model(weeklyReportFixture()).trends.enrollments!.stats.find((stat) => stat.label === reportPdfVi.trends.peak)?.detail, 'Tuần 13/07–19/07/2026');
  // Every fact statement of the new fixtures stays verifiable when quoted.
  for (const fixture of [yearlyReportFixture(), weeklyReportFixture(), yearlyReportFixture({ requestedDay: true })]) {
    const insights = buildReportInsights(fixture.snapshot, fixture.labels);
    const rules = buildRuleBasedReportNarrative(insights, 'vi');
    assert.deepEqual(validateReportPdfNarrative(rules, insights, 'vi').issues, [], fixture.name);
  }
});

test('5. the course activation risk is shown in "Điểm cần chú ý" with the course name and numbers', () => {
  const insights = buildReportInsights(smallBaseReportFixture().snapshot);
  const token = insights.facts.find((item) => item.id === 'risk.course_activation')!.entities[0];
  const vi = model(smallBaseReportFixture());
  const card = vi.attention.find((item) => item.title === reportPdfVi.attention.titles.course_activation_risk)!;
  assert.equal(card.text, `{{${token}}}: 14/26 học viên (53,9%) chưa bắt đầu học, vượt ngưỡng theo dõi 30%.`);
  assert.ok(renderReportPdfHtml(vi, NO_FONTS).includes('<span class="entity">Lập trình Python cơ bản</span>: 14/26 học viên'));
  const en = model(smallBaseReportFixture('en'), 'en');
  assert.ok(en.attention.some((item) => item.title === 'Courses where many learners have not started' && item.text.includes('14 of 26 learners (53.9%)')));
  assert.ok(vi.appendix.methodology.some((text) => text.includes('cho từng khóa học (khi khóa có từ 5 lượt ghi danh)')));
});

test('6. a flagged flat tail is drawn in orange, explained under the chart and in the appendix', () => {
  const vi = model(smallBaseReportFixture());
  const chart = vi.trends.active!;
  assert.deepEqual(chart.flaggedIndexes, [27, 28, 29, 30]);
  assert.equal(chart.peakIndex, 23);
  assert.ok(chart.legend.some((item) => item.key === 'flagged'));
  assert.ok(chart.notes.some((note) => note.startsWith('Lưu ý dữ liệu: 4 mốc cuối có cùng giá trị 35')));
  assert.ok(vi.appendix.limitations.includes(reportPdfVi.appendix.limitations.data_anomaly));
  assert.ok(!vi.trends.observations.some((item) => item.text.includes('35')), 'the tail is not read as a trend');
  const document = renderReportPdfHtml(vi, NO_FONTS);
  assert.equal((document.match(/class="bar bar-flagged"/g) ?? []).length, 4);
});

test('7. recommendations come from detected signals with who, what and a target; the AI may only select and reword them', async () => {
  const fixture = smallBaseReportFixture();
  const insights = buildReportInsights(fixture.snapshot, fixture.labels);
  const python = `{{${insights.facts.find((item) => item.id === 'risk.course_activation')!.entities[0]}}}`;
  const rules = buildRuleBasedReportNarrative(insights, 'vi');
  assert.ok(rules.recommendations.length >= 3 && rules.recommendations.length <= 5);
  assert.ok(rules.recommendations.every((item) => item.recId && item.factIds.every((id) => insights.facts.some((candidate) => candidate.id === id))));
  assert.ok(rules.recommendations.some((item) => item.text === `Nhắc 14 học viên chưa bắt đầu khóa ${python}; mục tiêu: giảm tỉ lệ chưa bắt đầu từ 53,9% xuống dưới 30% trong kỳ tới.`));
  assert.ok(rules.recommendations.some((item) => item.text.startsWith('Kiểm tra lại dữ liệu học viên có hoạt động học của 4 mốc cuối kỳ (cùng giá trị 35)')));
  assert.ok(!rules.recommendations.some((item) => item.text === reportPdfVi.narrative.recMonitor), 'no generic filler when there are signals');
  assert.deepEqual(validateReportPdfNarrative(rules, insights, 'vi').issues, []);
  assert.ok(buildReportRecommendationCandidates(insights, 'en').some((item) => item.text.startsWith(`Remind the 14 learners who have not started ${python}; target:`)));

  const ai = (recommendations: ReportPdfNarrative['recommendations']): ReportPdfNarrative => ({ ...structuredClone(rules), source: 'ai', recommendations });
  const reworded = rules.recommendations.map((item) => (item.recId === 'rec.risk.course_activation'
    ? { ...item, text: `Gửi nhắc cho 14 học viên chưa vào học khóa ${python}, đưa tỉ lệ chưa bắt đầu từ 53,9% xuống dưới 30% trong kỳ tới.` } : item));
  assert.deepEqual(validateReportPdfNarrative(ai(reworded), insights, 'vi').issues, [], 'rewording with the same numbers is accepted');
  const invented = ai([{ ...rules.recommendations[0], recId: 'rec.made_up' }]);
  assert.ok(validateReportPdfNarrative(invented, insights, 'vi').issues.includes('recommendations[0]: unknown_recommendation'));
  const otherCourse = ai([{ ...rules.recommendations.find((item) => item.recId === 'rec.risk.course_activation')!, text: `Nhắc 14 học viên chưa bắt đầu khóa {{C1}}.` }]);
  assert.ok(validateReportPdfNarrative(otherCourse, insights, 'vi').issues.includes('recommendations[0]: recommendation_entity:C1'));
  const newNumber = ai([{ ...rules.recommendations.find((item) => item.recId === 'rec.risk.course_activation')!, text: `Nhắc 20 học viên chưa bắt đầu khóa ${python}.` }]);
  assert.ok(validateReportPdfNarrative(newNumber, insights, 'vi').issues.includes('recommendations[0]: number_not_in_facts:20'));

  // Missing or rejected AI narrative: the deterministic actions are printed.
  for (const writer of [async () => null, async () => invented]) {
    const composed = await composeReportPdfDocument({
      snapshot: fixture.snapshot, snapshotHash: fixture.snapshotHash, locale: 'vi', tenant: { name: fixture.tenantName, logoDataUri: null },
      writeAiNarrative: writer, fontCss: NO_FONTS.fontCss,
    });
    assert.equal(composed.narrative.source, 'rules');
    assert.deepEqual(composed.narrative.recommendations.map((item) => item.text), rules.recommendations.map((item) => item.text));
  }
});

test('9. the tenant logo sits on a light badge on the dark cover, unchanged', () => {
  const logo = 'data:image/png;base64,iVBORw0KGgo=';
  const document = renderReportPdfHtml(model(smallBaseReportFixture(), 'vi', logo), NO_FONTS);
  assert.ok(document.includes(`<span class="logo-badge"><img src="${logo}" alt=""></span>`));
  assert.ok(/\.cover \.tenant-mark \.logo-badge \{[^}]*background: #FFFFFF/.test(document));
  assert.ok(!/filter:\s*(?:invert|brightness)/.test(document), 'the logo is never recoloured');
});

test('10. the course table lists at most 20 courses in ranking order and says how many are left out', () => {
  const many = model(manyCoursesReportFixture());
  assert.equal(many.courses.rows.length, 20);
  assert.equal(many.courses.moreCoursesNote, 'Còn 40 khóa học khác — xem đầy đủ trong file Excel.');
  assert.ok(renderReportPdfHtml(many, NO_FONTS).includes('Còn 40 khóa học khác — xem đầy đủ trong file Excel.'));
  assert.equal(model({ ...manyCoursesReportFixture(), locale: 'en' }, 'en').courses.moreCoursesNote, '40 more courses are not listed — see the full list in the Excel export.');

  const stress = structuredClone(manyCoursesReportFixture());
  const snapshot = stress.snapshot as StoredReportChatSnapshot & { course_portfolio: Array<Record<string, unknown>>; course_portfolio_total?: number };
  snapshot.course_portfolio = Array.from({ length: 60 }, (_, index) => ({ ...snapshot.course_portfolio[index % 20], course_id: `c-${index}`, name: `Khóa ${index + 1}`, total_enrollments: 200 - index }));
  delete snapshot.course_portfolio_total;
  const capped = model(stress);
  assert.deepEqual(capped.courses.rows.map((row) => row.rank), Array.from({ length: 20 }, (_, index) => index + 1));
  assert.equal(capped.courses.rows[0].name, 'Khóa 1', 'ranking order is kept');
  assert.equal(capped.courses.moreCoursesNote, 'Còn 40 khóa học khác — xem đầy đủ trong file Excel.');

  const older = structuredClone(englishReportFixture());
  (older.snapshot as unknown as { summary: { overview: { total_enrollments: number } } }).summary.overview.total_enrollments += 500;
  assert.equal(model(older).courses.moreCoursesNote, reportPdfEn.courses.moreCoursesUnknown, 'an older snapshot without the count still says courses are missing');
  assert.equal(model(vietnameseReportFixture()).courses.moreCoursesNote, null);

  const long = model(longNamesReportFixture('vi'));
  const measurements = estimateReportPdfLayout(long);
  measurements.rows.portfolio = measurements.rows.portfolio.map(() => 15);
  measurements.sections.portfolio = 40 + 20 * 15;
  const slices = planReportPdfPages(long, measurements).flat().filter((slice) => slice.id === 'portfolio');
  assert.ok(slices.length >= 2, 'a long table still paginates');
  const html = renderReportPdfHtml({ ...long, pages: planReportPdfPages(long, measurements) }, NO_FONTS);
  assert.equal((html.match(/<table class="portfolio">/g) ?? []).length, slices.length, 'each page repeats the table header');
});

test('8/11. appendix rows flow onto the next page, the unit section is left out without units, template 3.3.0', () => {
  assert.equal(REPORT_PDF_TEMPLATE_VERSION, '3.3.0');
  const vi = model(smallBaseReportFixture());
  assert.ok(vi.appendix.scopeRows.some((row) => row.value === 'Mẫu 3.3.0'));
  assert.ok(!vi.pages.flat().some((slice) => slice.id === 'organization'));
  assert.equal(vi.sectionNumbers.attention, '04');
  assert.equal(vi.appendix.methodRows[0].text, reportPdfVi.appendix.limitationsTitle, 'limitations come first');

  const measurements = estimateReportPdfLayout(vi);
  measurements.sections.appendixData = 200;
  measurements.rows.appendixMethods = vi.appendix.methodRows.map(() => 12);
  measurements.sections.appendixMethods = vi.appendix.methodRows.length * 12;
  const pages = planReportPdfPages(vi, measurements);
  const methodSlices = pages.flatMap((page, index) => page.filter((slice) => slice.id === 'appendixMethods').map((slice) => ({ ...slice, page: index })));
  assert.ok(methodSlices.length >= 2, 'the rows continue on the next page');
  assert.equal(methodSlices[0].page, pages.findIndex((page) => page.some((slice) => slice.id === 'appendixData')), 'they start under the scope table');
  for (const slice of methodSlices.slice(0, -1)) {
    assert.equal(vi.appendix.methodRows[slice.to! - 1].kind, 'item', 'a page never ends on a heading');
  }
  const document = renderReportPdfHtml({ ...vi, pages }, NO_FONTS);
  assert.ok(document.includes('Phạm vi, dữ liệu và giới hạn <span>(tiếp theo)</span>'));
});
