import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReportInsights } from './report-insights.logic.js';
import { reportPdfEn } from './report-pdf-i18n.en.js';
import { slugifyReportText } from './report-pdf-i18n.js';
import { reportPdfVi } from './report-pdf-i18n.vi.js';
import { planReportPdfPages, estimateReportPdfLayout } from './report-pdf-layout.logic.js';
import { buildRuleBasedReportNarrative } from './report-pdf-narrative.logic.js';
import { renderReportPdfHtml, renderReportPdfMeasureHtml, REPORT_PDF_CONTENT_SECURITY_POLICY } from './report-pdf-template/document.js';
import { renderAreaTrendChart, renderBarTrendChart } from './report-pdf-template/charts.js';
import { escapeHtml, html, renderNarrativeText } from './report-pdf-template/html.js';
import { buildReportPdfFileName, buildReportPdfViewModel, type ReportPdfViewModel } from './report-pdf-view-model.js';
import { composeReportPdfDocument } from './report-pdf.service.js';
import {
  allReportPdfFixtures,
  emptyReportFixture,
  englishExtendedReportFixture,
  englishReportFixture,
  legacyReportFixture,
  longNamesReportFixture,
  manyUnitsReportFixture,
  tinyReportFixture,
  vietnameseReportFixture,
  type ReportPdfFixture,
} from './report-pdf.fixture.js';

const NO_FONTS = { fontCss: '/* fonts omitted in tests */' };
const VIETNAMESE_CHARS = /[ăâđêôơưàáạảãầấậẩẫằắặẳẵèéẹẻẽềếệểễìíịỉĩòóọỏõồốộổỗờớợởỡùúụủũừứựửữỳýỵỷỹ]/i;

function model(fixture: ReportPdfFixture, locale = fixture.locale): ReportPdfViewModel {
  const insights = buildReportInsights(fixture.snapshot, fixture.labels);
  return buildReportPdfViewModel({
    snapshot: fixture.snapshot,
    snapshotHash: fixture.snapshotHash,
    locale,
    tenant: { name: fixture.tenantName, logoDataUri: null },
    insights,
    narrative: buildRuleBasedReportNarrative(insights, locale),
  });
}

const visibleText = (document: string) => document
  .replace(/<style>[\s\S]*?<\/style>/g, ' ')
  .replace(/<title>[\s\S]*?<\/title>/g, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&[a-z#0-9]+;/gi, ' ');

test('dictionaries have identical keys and parameter shapes in vi and en', () => {
  const shape = (value: unknown): unknown => (typeof value === 'function'
    ? `fn/${(value as (...args: unknown[]) => unknown).length}`
    : Array.isArray(value) ? value.map(shape)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shape(item)])) : typeof value);
  assert.deepEqual(shape(reportPdfEn), shape(reportPdfVi));
});

test('formats KPI cards with locale numbers, deltas and comparison values', () => {
  const vi = model(vietnameseReportFixture());
  const enrollments = vi.kpis.find((card) => card.id === 'total_enrollments')!;
  assert.deepEqual([enrollments.value, enrollments.deltaLabel, enrollments.previousLabel, enrollments.tone], ['315', '+53 · +20,2%', 'Kỳ so sánh: 262', 'positive']);
  const rate = vi.kpis.find((card) => card.id === 'completion_rate')!;
  assert.deepEqual([rate.label, rate.value, rate.deltaLabel], ['Tỉ lệ hoàn thành', '61,8%', '+3,7 điểm %']);
  const en = model(englishReportFixture());
  const enRate = en.kpis.find((card) => card.id === 'completion_rate')!;
  assert.deepEqual([enRate.label, enRate.value, enRate.deltaLabel, enRate.tone], ['Completion rate', '52.1%', '−5.3 pp', 'negative']);
});

test('builds charts and course data from mutually exclusive snapshot counts', () => {
  const vi = model(vietnameseReportFixture());
  assert.equal(vi.courses.status?.reduce((sum, segment) => sum + segment.ratio, 0), 1);
  assert.deepEqual(vi.courses.status?.map((segment) => segment.countLabel), ['194', '79', '42']);
  assert.equal(vi.courses.concentration[0].ratio, 1);
  assert.equal(vi.courses.rows.length, 14);
  assert.equal(vi.trends.enrollments?.values.length, 31);
  assert.equal(vi.trends.enrollments?.previousValues?.length, 30, 'June series overlaid on July');
  assert.equal(vi.trends.enrollments?.previousAverage, null, 'the real series replaces the average line');
  assert.equal(vi.trends.active?.kind, 'bars');
  assert.equal(vi.trends.active?.previousValues?.length, 30);
  assert.deepEqual(vi.trends.active?.legend.map((item) => item.key), ['current', 'previous', 'average']);
  const older = model(englishReportFixture());
  assert.equal(older.trends.enrollments?.previousValues, null);
  assert.equal(older.trends.enrollments?.previousAverage, 11.68, 'without the series: comparison total / days (362 / 31)');
  const extended = model(englishExtendedReportFixture());
  assert.ok(extended.trends.enrollments?.previousValues?.length, 'comparison series overlay when the snapshot carries it');
  assert.equal(extended.organization.rows.length, 6);
  const legacy = model(legacyReportFixture());
  assert.equal(legacy.courses.status, null);
  assert.equal(legacy.trends.enrollments?.title, 'Lượt ghi danh trong kỳ');
});

test('renders the unit heat table with localized aggregate rows and notes', () => {
  const vi = model(vietnameseReportFixture());
  assert.equal(vi.organization.level, 'Phòng ban');
  assert.equal(vi.organization.unitCountLabel, '9 phòng ban', 'without tenant labels the default level name is used');
  assert.deepEqual(vi.organization.rows.slice(0, 2).map((row) => [row.name, row.rateLabel, row.deltaLabel]), [
    ['Phòng Chăm sóc khách hàng', '77,4%', '+2,9 điểm %'], ['Cửa hàng Quận 1', '71,2%', '+6,3 điểm %'],
  ]);
  assert.equal(vi.organization.rows.find((row) => row.name === 'Cửa hàng Thủ Đức')?.deltaTone, 'negative');
  assert.equal(vi.organization.rows.find((row) => row.name.includes('thí điểm'))?.deltaLabel, '—');
  assert.equal(vi.organization.footnotes.length, 2, 'legend and learner definition; no overlap, nothing grouped');
  const viDocument = renderReportPdfHtml(vi, NO_FONTS);
  assert.ok(viDocument.includes('class="heat"') && viDocument.includes('Kho vận Hồ Chí Minh'));
  assert.ok(!viDocument.includes(reportPdfVi.appendix.limitations.unit_breakdown_missing));
  assert.equal(vi.sectionNumbers.organization, '04', 'with units the breakdown is section 04');
  assert.ok(viDocument.includes(reportPdfVi.appendix.methodology.unitCounting), 'the appendix says how learners in several units are counted');

  const many = model(manyUnitsReportFixture());
  assert.equal(many.organization.rows.length, 32);
  assert.deepEqual(many.organization.rows.slice(-2).map((row) => [row.name, row.aggregate]), [['Các công ty khác (4)', true], ['Chưa thuộc công ty nào', true]]);
  assert.equal(many.organization.unitCountLabel, '34 công ty');
  assert.ok(many.organization.footnotes.some((text) => text.startsWith('Bảng liệt kê 30 công ty')));
  assert.ok(renderReportPdfHtml(many, NO_FONTS).includes('class="aggregate"'));
  const en = model({ ...manyUnitsReportFixture(), locale: 'en' }, 'en');
  assert.deepEqual(en.organization.rows.slice(-2).map((row) => row.name), ['Other companies (4)', 'Other (not in any company)']);

  const overlapping = structuredClone(vietnameseReportFixture());
  (overlapping.snapshot as unknown as { unit_breakdown: { scope_learners: number } }).unit_breakdown.scope_learners = 200;
  assert.ok(model(overlapping).organization.footnotes.includes(reportPdfVi.organization.overlapNote({ sum: '230', total: '200' })));
});

test('leaves the unit section out without units, renumbers the next sections and says why in the appendix', () => {
  const sectionIds = (pdf: ReportPdfViewModel) => pdf.pages.flat().map((slice) => slice.id);
  const team = model(longNamesReportFixture('vi'));
  assert.equal(team.organization.rows.length, 0);
  assert.ok(!sectionIds(team).includes('organization'), 'nothing below a team: no unit section');
  assert.ok(!team.appendix.limitations.includes(reportPdfVi.appendix.limitations.unit_breakdown_missing));
  assert.deepEqual([team.sectionNumbers.attention, team.sectionNumbers.recommendations], ['04', '05'], 'the following sections move up');
  const teamDocument = renderReportPdfHtml(team, NO_FONTS);
  assert.ok(!teamDocument.includes(reportPdfVi.sections.organization.title));
  assert.ok(teamDocument.includes('<span class="num">04</span>Rủi ro'));

  const young = model(tinyReportFixture('en'), 'en');
  assert.ok(!sectionIds(young).includes('organization'));
  assert.ok(young.appendix.limitations.includes('No company in this scope has learners yet, so the report has no breakdown by company.'), 'one short line in the appendix, naming the level below the scope');
  const older = model(englishReportFixture());
  assert.ok(!sectionIds(older).includes('organization'));
  assert.ok(older.appendix.limitations.includes('The snapshot does not include figures per company, so the report has no breakdown by company.'));

  const empty = model(emptyReportFixture('vi'));
  assert.deepEqual([empty.sectionNumbers.summary, empty.sectionNumbers.attention, empty.sectionNumbers.recommendations], ['01', '02', '03'], 'no gap in the numbering of an empty report');
});

test('overlays the comparison series by bucket index on both charts', () => {
  const format = (value: number) => String(value);
  const area = renderAreaTrendChart({ values: [1, 2, 3], labels: ['a', 'b', 'c'], previousValues: [4, 5, 6, 7, 8], previousAverage: null, average: 2, peakIndex: 2, peakLabel: '3', format }).value;
  const previousPath = /<path class="line-previous" d="([^"]+)"/.exec(area)?.[1] ?? '';
  assert.equal(previousPath.split(/[ML]/).filter(Boolean).length, 3, 'points past the current period are not drawn');
  const currentPath = /<path class="line-current" d="([^"]+)"/.exec(area)?.[1] ?? '';
  const xs = (path: string) => path.split(/[ML]/).filter(Boolean).map((point) => point.trim().split(' ')[0]);
  assert.deepEqual(xs(previousPath), xs(currentPath), 'day i of the comparison sits over day i of the period');
  const bars = renderBarTrendChart({ values: [3, 4, 5], labels: ['a', 'b', 'c'], previousValues: [2, 6, 1], previousAverage: null, average: 4, peakIndex: 2, peakLabel: '5', format }).value;
  assert.ok(bars.includes('class="line-previous"'));
  const fallback = renderBarTrendChart({ values: [3, 4, 5], labels: ['a', 'b', 'c'], previousValues: null, previousAverage: 3.5, average: 4, peakIndex: 2, peakLabel: '5', format }).value;
  assert.ok(fallback.includes('class="line-previous-average"'), 'average line without the series');
});

test('renders a self-contained, script-free document with escaped tenant data', () => {
  const fixture = longNamesReportFixture('vi');
  const document = renderReportPdfHtml(model(fixture), NO_FONTS);
  assert.ok(document.startsWith('<!doctype html><html lang="vi">'));
  assert.ok(document.includes(REPORT_PDF_CONTENT_SECURITY_POLICY));
  assert.ok(!/<script/i.test(document), 'tenant text "<script>" must be escaped');
  assert.ok(document.includes('&lt;script&gt;alert(0)&lt;/script&gt;'));
  assert.ok(document.includes('&lt;b&gt;khu vực&lt;/b&gt;'));
  assert.ok(!/\b(?:src|href)="(?:https?:)?\/\//i.test(document), 'no external resources');
  assert.ok(!document.includes('{{C'), 'every entity token is substituted');
});

test('the cover brand line is the tenant name (escaped, shortened), never a fixed product name', () => {
  for (const fixture of allReportPdfFixtures()) {
    const document = renderReportPdfHtml(model(fixture), NO_FONTS);
    assert.ok(!/NESSO|Learning Analytics</.test(document), fixture.name);
  }
  assert.ok(renderReportPdfHtml(model(vietnameseReportFixture()), NO_FONTS).includes('<span class="brand">Công ty Cổ phần Dược phẩm An Khang</span>'));
  const long = model(longNamesReportFixture('en'));
  assert.equal(Array.from(long.brandLine).length, 80);
  assert.ok(long.brandLine.startsWith('Tập đoàn Công nghiệp') && long.brandLine.endsWith('…'));
  const hostile = renderReportPdfHtml(model({ ...englishReportFixture(), tenantName: 'Acme <img src=x onerror=alert(1)> & "Co"' }), NO_FONTS);
  assert.ok(hostile.includes('<span class="brand">Acme &lt;img src=x onerror=alert(1)&gt; &amp; &quot;Co&quot;</span>'));
  assert.ok(!hostile.includes('<img src=x'));
  // Without a tenant name the brand line is the localized report title.
  assert.equal(model({ ...englishReportFixture(), tenantName: '   ' }).brandLine, 'Learning Performance Report');
  assert.equal(model({ ...vietnameseReportFixture(), tenantName: '' }).brandLine, 'Báo cáo hiệu quả học tập');
});

test('renders the whole document in the request locale', () => {
  const en = renderReportPdfHtml(model(englishReportFixture()), NO_FONTS);
  const text = visibleText(en);
  assert.ok(!VIETNAMESE_CHARS.test(text), 'no Vietnamese text in an English document with English names');
  for (const label of ['Confidential · For internal use only', 'Page 2 of', 'Executive summary', 'Metric definitions', '(role Learner or Learner+)']) {
    assert.ok(en.includes(label), label);
  }
  assert.ok(!/learner_plus|role learner\b/.test(en), 'no technical role id, only the role names the dashboard shows');
  const vi = renderReportPdfHtml(model(vietnameseReportFixture()), NO_FONTS);
  for (const label of ['Bảo mật · Chỉ lưu hành nội bộ', 'Trang 2/', 'Tóm tắt điều hành', 'Định nghĩa chỉ số']) {
    assert.ok(vi.includes(label), label);
  }
  // Owner decision 2026-10-10: the PDF no longer prints the completion-rate calculation box.
  for (const removed of ['How the Completion rate is calculated', 'Cách tính Tỉ lệ hoàn thành']) {
    assert.ok(!en.includes(removed) && !vi.includes(removed), removed);
  }
  const viForEnglishData = renderReportPdfHtml(model(englishReportFixture(), 'vi'), NO_FONTS);
  assert.ok(viForEnglishData.includes('Bảo mật'), 'locale comes from the request, not from the data');
});

test('paginates deterministically and splits long tables with a continued header', () => {
  const longModel = model(longNamesReportFixture('en'));
  const measurements = estimateReportPdfLayout(longModel);
  measurements.rows.portfolio = measurements.rows.portfolio.map(() => 15);
  measurements.sections.portfolio = 40 + 20 * 15;
  const pages = planReportPdfPages(longModel, measurements);
  const slices = pages.flat().filter((slice) => slice.id === 'portfolio');
  assert.equal(slices.length, 2);
  assert.equal(slices[0].from, 0);
  assert.equal(slices[1].from, slices[0].to);
  assert.equal(slices[1].to, 20);
  const continued = renderReportPdfHtml({ ...longModel, pages }, NO_FONTS);
  assert.ok(continued.includes('(continued)'));
  assert.ok(pages.every((page) => page.length > 0));
  const empty = model(emptyReportFixture('en'));
  assert.ok(!empty.pages.flat().some((slice) => slice.id === 'trends' || slice.id === 'courses'), 'an empty report skips trend and course sections');
  const measure = renderReportPdfMeasureHtml(longModel, NO_FONTS);
  assert.ok(measure.includes('data-measure="section:summary"') && measure.includes('data-measure="row:portfolio:19"') && measure.includes('data-measure="cont:portfolio"'));
});

test('escapes every interpolation and substitutes only known entity tokens', () => {
  assert.equal(escapeHtml(`<a href="x">'&\``), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#96;');
  assert.equal(html`<p>${'<b>x</b>'}</p>`.value, '<p>&lt;b&gt;x&lt;/b&gt;</p>');
  assert.equal(renderNarrativeText('{{C1}} & {{C2}}', { C1: '<img onerror=x>' }).value, '<span class="entity">&lt;img onerror=x&gt;</span> &amp; ');
});

test('builds localized, ASCII-safe file names', () => {
  assert.equal(buildReportPdfFileName({ locale: 'vi', dateFrom: '2026-07-01', dateTo: '2026-07-31', tenantSlug: slugifyReportText('Công ty Dược phẩm Đông Á') }),
    'bao-cao-hieu-qua-hoc-tap_cong-ty-duoc-pham-dong-a_2026-07-01_den_2026-07-31.pdf');
  assert.equal(buildReportPdfFileName({ locale: 'en', dateFrom: '2026-08-01', dateTo: '2026-08-31' }), 'learning-performance-report_2026-08-01_to_2026-08-31.pdf');
  assert.equal(buildReportPdfFileName({ locale: 'en', dateFrom: '../../etc', dateTo: '2026-08-31' }), 'learning-performance-report_unknown_to_2026-08-31.pdf');
});

test('composes the document with the stored chat narrative and an injected AI writer', async () => {
  const fixture = vietnameseReportFixture();
  let aiCalls = 0;
  const composition = await composeReportPdfDocument({
    snapshot: fixture.snapshot,
    snapshotHash: fixture.snapshotHash,
    locale: 'vi',
    tenant: { name: fixture.tenantName, logoDataUri: null },
    storedNarrative: fixture.storedNarrative,
    storedNarrativeLocale: 'vi',
    writeAiNarrative: async () => { aiCalls += 1; return null; },
    fontCss: NO_FONTS.fontCss,
  });
  assert.equal(aiCalls, 1);
  assert.equal(composition.narrative.source, 'rules', 'a rejected AI narrative falls back to rules');
  assert.equal(composition.narrative.commentary.length, 1);
  assert.ok(composition.html.includes(reportPdfVi.summary.commentary), 'the chat commentary is kept');
  assert.ok(!composition.narrative.recommendations.some((item) => item.origin === 'chat'), 'the report already has a targeted action for that signal');
});
