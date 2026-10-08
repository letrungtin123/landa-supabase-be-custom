import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReportInsights } from './report-insights.logic.js';
import { reportPdfEn } from './report-pdf-i18n.en.js';
import { slugifyReportText } from './report-pdf-i18n.js';
import { reportPdfVi } from './report-pdf-i18n.vi.js';
import { planReportPdfPages, estimateReportPdfLayout } from './report-pdf-layout.logic.js';
import { buildRuleBasedReportNarrative } from './report-pdf-narrative.logic.js';
import { renderReportPdfHtml, renderReportPdfMeasureHtml, REPORT_PDF_CONTENT_SECURITY_POLICY } from './report-pdf-template/document.js';
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
  vietnameseReportFixture,
  type ReportPdfFixture,
} from './report-pdf.fixture.js';

const NO_FONTS = { fontCss: '/* fonts omitted in tests */' };
const VIETNAMESE_CHARS = /[ăâđêôơưàáạảãầấậẩẫằắặẳẵèéẹẻẽềếệểễìíịỉĩòóọỏõồốộổỗờớợởỡùúụủũừứựửữỳýỵỷỹ]/i;

function model(fixture: ReportPdfFixture, locale = fixture.locale): ReportPdfViewModel {
  const insights = buildReportInsights(fixture.snapshot);
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
  assert.equal(vi.trends.enrollments?.previousAverage, 8.73);
  assert.equal(vi.trends.active?.kind, 'bars');
  const extended = model(englishExtendedReportFixture());
  assert.ok(extended.trends.enrollments?.previousValues?.length, 'comparison series overlay when the snapshot carries it');
  assert.equal(extended.organization.rows.length, 6);
  const legacy = model(legacyReportFixture());
  assert.equal(legacy.courses.status, null);
  assert.equal(legacy.trends.enrollments?.title, 'Lượt ghi danh trong kỳ');
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
  for (const label of ['Confidential · For internal use only', 'Page 2 of', 'Executive summary', 'How the Completion rate is calculated', '99.99%', 'learner_plus']) {
    assert.ok(en.includes(label), label);
  }
  const vi = renderReportPdfHtml(model(vietnameseReportFixture()), NO_FONTS);
  for (const label of ['Bảo mật · Chỉ lưu hành nội bộ', 'Trang 2/', 'Tóm tắt điều hành', 'Cách tính Tỉ lệ hoàn thành', '99,99%', 'được tính là 0%']) {
    assert.ok(vi.includes(label), label);
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
  assert.ok(composition.html.includes('Từ phân tích trong cuộc trò chuyện'));
});
