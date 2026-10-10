// The report PDF names organization levels and learner roles with the tenant's
// own labels (tenant_group_labels / tenant_role_labels), never with the default
// level names when a label is configured, and never with a technical role id.
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReportInsights } from './report-insights.logic.js';
import {
  normalizeReportTenantLabels,
  reportTenantLabelsKey,
  resolveReportPdfLabelWords,
  type ReportTenantLabels,
} from './report-labels.logic.js';
import {
  buildReportPdfAiNarrativeRequest,
  buildRuleBasedReportNarrative,
  describeReportFact,
  validateReportPdfNarrative,
  type ReportPdfNarrative,
} from './report-pdf-narrative.logic.js';
import { renderReportPdfHtml } from './report-pdf-template/document.js';
import { buildReportPdfViewModel, type ReportPdfViewModel } from './report-pdf-view-model.js';
import {
  customLabelsReportFixture,
  englishExtendedReportFixture,
  LONG_LABELS,
  manyUnitsReportFixture,
  NESSO_LIKE_LABELS,
  vietnameseReportFixture,
  type ReportPdfFixture,
} from './report-pdf.fixture.js';

const NO_FONTS = { fontCss: '/* fonts omitted in tests */' };
const TECHNICAL_ROLE_IDS = /\b(?:learner_plus|superadmin|superuser|staff)\b|vai trò learner\b|role learner\b/;

function model(fixture: ReportPdfFixture, labels: ReportTenantLabels | undefined = fixture.labels, locale = fixture.locale): ReportPdfViewModel {
  const insights = buildReportInsights(fixture.snapshot, labels);
  return buildReportPdfViewModel({
    snapshot: fixture.snapshot, snapshotHash: fixture.snapshotHash, locale,
    tenant: { name: fixture.tenantName, logoDataUri: null }, insights, narrative: buildRuleBasedReportNarrative(insights, locale),
  });
}

/** Text a reader sees (tags, styles and entities removed). */
const visibleText = (document: string) => document
  .replace(/<style>[\s\S]*?<\/style>/g, ' ')
  .replace(/<title>[\s\S]*?<\/title>/g, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&[a-z#0-9]+;/gi, ' ')
  .replace(/\s+/g, ' ');

test('normalizes configured labels: known keys, one line, no braces, at most 64 characters', () => {
  assert.deepEqual(normalizeReportTenantLabels({
    group: '  Khối/Khu   vực ', subgroup: '', team: '{{U1}} Bộ phận', learner: 42, learner_plus: 'Team Leader', staff: 'L&D Manager',
  }), { group: 'Khối/Khu vực', team: 'U1 Bộ phận', learner_plus: 'Team Leader' });
  const long = normalizeReportTenantLabels({ team: 'x'.repeat(70) }).team!;
  assert.equal(Array.from(long).length, 64);
  assert.ok(long.endsWith('…'));
  assert.deepEqual(normalizeReportTenantLabels(null), {});
  assert.notEqual(reportTenantLabelsKey({}), reportTenantLabelsKey({ team: 'Bộ phận' }), 'a label change gives a new stored-PDF key');
  assert.equal(reportTenantLabelsKey({ team: 'Bộ phận', group: 'Khối' }), reportTenantLabelsKey({ group: 'Khối', team: 'Bộ phận' }));
});

test('falls back to the default names per level and role, the dashboard rule', () => {
  assert.deepEqual(resolveReportPdfLabelWords('vi', {}, 'subgroup'), {
    group: 'Công ty', subgroup: 'Chi nhánh', team: 'Phòng ban', unit: 'Chi nhánh', unitLower: 'chi nhánh', units: 'Chi nhánh', unitsLower: 'chi nhánh',
    learnerRoles: ['Learner', 'Learner+'],
  });
  const en = resolveReportPdfLabelWords('en', { team: 'Bộ phận', learner_plus: 'Team Leader' }, 'team');
  assert.deepEqual([en.group, en.team, en.unit, en.unitLower, en.units, en.unitsLower, en.learnerRoles], [
    'Company', 'Bộ phận', 'Bộ phận', 'bộ phận', 'Bộ phận units', 'bộ phận units', ['Learner', 'Team Leader'],
  ], 'a configured label is used as configured in English too');
  assert.equal(resolveReportPdfLabelWords('en', {}, 'group').units, 'Companies', 'default names keep their English plural');
  assert.deepEqual(resolveReportPdfLabelWords('vi', { learner: 'Học viên', learner_plus: 'học viên' }).learnerRoles, ['Học viên'], 'the same name is not repeated');
});

test('a tenant with its own labels sees them everywhere in the Vietnamese PDF, and no default level name or role id', () => {
  const pdf = model(customLabelsReportFixture('vi'));
  const document = renderReportPdfHtml(pdf, NO_FONTS);
  const text = visibleText(document);
  assert.deepEqual(pdf.scopePath, [{ level: 'Khối/Khu vực', name: 'Miền Nam' }, { level: 'Đơn vị', name: 'Hồ Chí Minh' }]);
  assert.equal(pdf.organization.level, 'Bộ phận');
  for (const expected of [
    'Phân tích theo bộ phận', 'Xếp hạng bộ phận theo tỉ lệ hoàn thành', '9 bộ phận', '<th>Bộ phận</th>',
    'Thay đổi: so với kỳ so sánh, tính bằng điểm %; “—” khi bộ phận không có lượt ghi danh',
    '(vai trò Learner hoặc Team Leader)', 'Số liệu theo bộ phận: mỗi dòng của bảng bộ phận', 'Phân tích theo bộ phận: chỉ xếp hạng bộ phận',
    'Tỉ lệ hoàn thành của một bộ phận giảm', 'Bộ phận có tỉ lệ hoàn thành thấp',
    'Khối/Khu vực: Miền Nam › Đơn vị: Hồ Chí Minh',
  ]) assert.ok(document.includes(expected), expected);
  assert.ok(pdf.narrative.risks.some((item) => /^2 bộ phận có từ \d+ lượt ghi danh/.test(item.text)), 'the deterministic narrative names the level too');
  assert.ok(pdf.narrative.recommendations.some((item) => item.text.includes('đưa tỉ lệ của bộ phận này về lại')));
  assert.doesNotMatch(text, /công ty|chi nhánh|phòng ban/i, 'no default level name');
  assert.doesNotMatch(text, /đơn vị/, 'the generic "đơn vị" is gone: here it would read as this tenant\'s second level');
  assert.doesNotMatch(document, TECHNICAL_ROLE_IDS);
  assert.ok(!text.includes('Learner+'), 'the configured learner_plus name replaces the default one');
});

test('the English PDF uses the configured labels as configured, like the dashboard in English', () => {
  const pdf = model(customLabelsReportFixture('en'));
  const document = renderReportPdfHtml(pdf, NO_FONTS);
  for (const expected of [
    'Breakdown by bộ phận', 'Bộ phận ranking by completion rate', '9 bộ phận units', '<th>Bộ phận</th>',
    'belong to the bộ phận (not only learners created in the period)', '(role Learner or Team Leader)',
    'Completion rate declined in one bộ phận', 'Bộ phận units with a low completion rate', 'Khối/Khu vực: Miền Nam › Đơn vị: Hồ Chí Minh',
  ]) assert.ok(document.includes(expected), expected);
  assert.ok(pdf.narrative.risks.some((item) => /^2 bộ phận units with at least \d+ enrollments/.test(item.text)));
  assert.doesNotMatch(visibleText(document), /\b(?:compan(?:y|ies)|branch(?:es)?|departments?)\b/i, 'no default level name');
  assert.doesNotMatch(document, TECHNICAL_ROLE_IDS);
  // The narrative still passes the validator although the labels are Vietnamese words in an English text.
  assert.deepEqual(validateReportPdfNarrative(pdf.narrative, buildReportInsights(customLabelsReportFixture('en').snapshot, NESSO_LIKE_LABELS), 'en').issues, []);
});

test('"other units" and "not in any unit" rows name the level of the breakdown', () => {
  const vi = model(manyUnitsReportFixture(), NESSO_LIKE_LABELS);
  assert.deepEqual(vi.organization.rows.slice(-2).map((row) => row.name), ['Các khối/khu vực khác (4)', 'Chưa thuộc khối/khu vực nào']);
  assert.ok(vi.organization.footnotes.some((text) => text === 'Bảng liệt kê 30 khối/khu vực có nhiều lượt ghi danh nhất; các khối/khu vực còn lại được gộp vào dòng “Các khối/khu vực khác”, mỗi học viên chỉ tính một lần.'));
  const en = model({ ...manyUnitsReportFixture(), locale: 'en' }, NESSO_LIKE_LABELS, 'en');
  assert.deepEqual(en.organization.rows.slice(-2).map((row) => row.name), ['Other khối/khu vực units (4)', 'Other (not in any khối/khu vực)']);
  const defaults = model({ ...manyUnitsReportFixture(), locale: 'en' }, {}, 'en');
  assert.deepEqual(defaults.organization.rows.slice(-2).map((row) => row.name), ['Other companies (4)', 'Other (not in any company)']);
});

test('without configured labels the default level and role names are used', () => {
  const vi = renderReportPdfHtml(model(vietnameseReportFixture()), NO_FONTS);
  for (const expected of ['<span>Công ty</span>', '<span>Chi nhánh</span>', 'Xếp hạng phòng ban theo tỉ lệ hoàn thành', '<th>Phòng ban</th>', '(vai trò Learner hoặc Learner+)']) {
    assert.ok(vi.includes(expected), expected);
  }
  const en = renderReportPdfHtml(model(englishExtendedReportFixture()), NO_FONTS);
  for (const expected of ['Breakdown by company', 'Company ranking by completion rate', '<th>Company</th>', '(role Learner or Learner+)', 'Each row is computed like the report filtered to that company.']) {
    assert.ok(en.includes(expected), expected);
  }
  assert.doesNotMatch(vi + en, TECHNICAL_ROLE_IDS);
});

test('labels are tenant input: escaped in the HTML and never expanded as entity tokens', () => {
  const hostile: ReportTenantLabels = {
    group: '"><script>alert(1)</script>', subgroup: 'Đơn vị & \'Co\' {{C1}}', team: '<img src=x onerror=alert(1)>',
    learner: '<b>Học viên</b>', learner_plus: 'Team</td><td>Leader',
  };
  const pdf = model(customLabelsReportFixture('vi'), hostile);
  const document = renderReportPdfHtml(pdf, NO_FONTS);
  assert.ok(!document.includes('<script>alert') && !document.includes('<img src=x') && !document.includes('<b>Học viên</b>') && !document.includes('Team</td>'));
  assert.ok(document.includes('&lt;img src=x onerror=alert(1)&gt;'), 'the breakdown level is printed escaped');
  assert.ok(document.includes('Đơn vị &amp; &#39;Co&#39; C1'), 'braces are dropped: no {{C1}} token can be formed');
  assert.ok(document.includes('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;'));
  const unitRisk = pdf.narrative.risks.find((item) => item.factIds.includes('risk.unit_low_completion'))!;
  assert.ok(unitRisk.text.includes('<img src=x onerror=alert(1)>'), 'narrative text keeps the label; the template escapes it');
});

test('a label with digits or direction words is a name: the AI narrative validator ignores it, but still checks the claim', () => {
  const fixture = customLabelsReportFixture('vi', LONG_LABELS);
  const insights = buildReportInsights(fixture.snapshot, LONG_LABELS);
  const rules = buildRuleBasedReportNarrative(insights, 'vi');
  assert.deepEqual(validateReportPdfNarrative(rules, insights, 'vi').issues, [], 'label digits ("Tầng 2") are not numbers to verify');
  const low = insights.facts.find((fact) => fact.id === 'risk.unit_low_completion')!;
  const statement = describeReportFact(low, insights, 'vi')!;
  assert.ok(statement.includes('bộ phận chăm sóc khách hàng, hậu mãi và hỗ trợ kỹ thuật tầng 2'), 'lowercased inside the sentence');
  const withRisk = (text: string): ReportPdfNarrative => ({ ...structuredClone(rules), risks: [{ text, factIds: [low.id], tone: low.tone }] });
  assert.deepEqual(validateReportPdfNarrative(withRisk(statement), insights, 'vi').issues, [], 'quoted verbatim, the 64-character label does not make it too long');
  assert.ok(validateReportPdfNarrative(withRisk(`${statement} Thêm 99 lượt.`), insights, 'vi').issues.some((issue) => issue.includes('number_not_in_facts:99')));
  const en = buildReportInsights(customLabelsReportFixture('en').snapshot, NESSO_LIKE_LABELS);
  const enRules = buildRuleBasedReportNarrative(en, 'en');
  const enRisk = (text: string): ReportPdfNarrative => ({ ...structuredClone(enRules), risks: [{ text, factIds: [low.id], tone: low.tone }] });
  assert.deepEqual(validateReportPdfNarrative(enRisk('2 bộ phận units have a low completion rate.'), en, 'en').issues, []);
  assert.ok(validateReportPdfNarrative(enRisk('2 bộ phận units có tỉ lệ thấp.'), en, 'en').issues.includes('language: expected_english'), 'other Vietnamese words are still caught');
});

test('the facts and actions sent to the model use the same labels and ask to keep them', () => {
  const insights = buildReportInsights(customLabelsReportFixture('en').snapshot, NESSO_LIKE_LABELS);
  const request = buildReportPdfAiNarrativeRequest(insights, 'en');
  const payload = JSON.parse(request.payload) as { facts: Array<{ id: string; statement: string }>; recommendation_candidates: Array<{ statement: string }> };
  assert.match(payload.facts.find((fact) => fact.id === 'risk.unit_low_completion')!.statement, /^2 bộ phận units with at least/);
  assert.match(request.systemInstruction, /Organization level names in the statements are the organization's own terms/);
  assert.doesNotMatch(request.payload, /\b(?:compan(?:y|ies)|branch(?:es)?|departments?)\b|learner_plus/i);
});
