import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReportInsights } from './report-insights.logic.js';
import {
  buildReportPdfAiNarrativeRequest,
  buildRuleBasedReportNarrative,
  extractReportNarrativeNumbers,
  mergeStoredChatNarrative,
  toReportPdfAiNarrative,
  validateReportPdfNarrative,
  type ReportPdfNarrative,
} from './report-pdf-narrative.logic.js';
import { allReportPdfFixtures, englishReportFixture, vietnameseReportFixture } from './report-pdf.fixture.js';

const clone = (narrative: ReportPdfNarrative): ReportPdfNarrative => structuredClone(narrative);

test('rule-based narratives of every fixture pass the number validator in both locales', () => {
  for (const fixture of allReportPdfFixtures()) {
    for (const locale of ['vi', 'en'] as const) {
      const insights = buildReportInsights(fixture.snapshot);
      const narrative = buildRuleBasedReportNarrative(insights, locale);
      const validation = validateReportPdfNarrative(narrative, insights, locale);
      assert.deepEqual(validation.issues, [], `${fixture.name}/${locale}`);
      assert.ok(narrative.recommendations.length >= 1, `${fixture.name}/${locale} has recommendations`);
      if (insights.available) assert.ok(narrative.findings.length >= 3, `${fixture.name}/${locale} has 3+ findings`);
    }
  }
});

test('writes a fact-based Vietnamese executive narrative', () => {
  const insights = buildReportInsights(vietnameseReportFixture().snapshot);
  const narrative = buildRuleBasedReportNarrative(insights, 'vi');
  assert.equal(narrative.headline.text, 'Kỳ báo cáo ghi nhận 315 lượt ghi danh (tăng 53, tương đương 20,2%, so với tháng trước) và tỉ lệ hoàn thành 61,8% (tăng 3,7 điểm % so với tháng trước).');
  assert.ok(narrative.findings.some((item) => item.text.includes('61,6% đã hoàn thành')));
  assert.ok(narrative.risks.some((item) => item.factIds.includes('risk.watchlist')));
  assert.ok(narrative.recommendations.every((item) => item.priority));
});

test('writes the English narrative with English number formats', () => {
  const insights = buildReportInsights(englishReportFixture().snapshot);
  const narrative = buildRuleBasedReportNarrative(insights, 'en');
  assert.match(narrative.headline.text, /486 enrollments \(up 124, or 34\.3%, vs the previous month\) and a completion rate of 52\.1% \(down 5\.3 pp vs the previous month\)/);
  assert.equal(narrative.recommendations[0].priority, 'high');
});

test('extracts numbers in the locale format', () => {
  assert.deepEqual(extractReportNarrativeNumbers('Đạt 1.234,5 lượt, 53,7% và năm 2026 ({{C12}})', 'vi').map((item) => [item.value, item.decimals]), [[1234.5, 1], [53.7, 1], [2026, 0]]);
  assert.deepEqual(extractReportNarrativeNumbers('Reached 1,234.5 and 53.7% in 2026', 'en').map((item) => item.value), [1234.5, 53.7, 2026]);
});

test('rejects a narrative with an invented or wrongly formatted number', () => {
  const insights = buildReportInsights(vietnameseReportFixture().snapshot);
  const base = buildRuleBasedReportNarrative(insights, 'vi');

  const invented = clone(base);
  invented.findings[0].text = 'Số học viên có hoạt động học đạt 999 người.';
  assert.ok(validateReportPdfNarrative(invented, insights, 'vi').issues.some((issue) => issue.includes('number_not_in_facts:999')));

  const wrongFormat = clone(base);
  wrongFormat.headline = { ...wrongFormat.headline, text: 'Tỉ lệ hoàn thành đạt 61.8% trong kỳ.' };
  assert.equal(validateReportPdfNarrative(wrongFormat, insights, 'vi').ok, false);

  const rounded = clone(base);
  rounded.headline = { ...rounded.headline, text: 'Tỉ lệ hoàn thành đạt 62% (61,8%) trong kỳ.' };
  assert.equal(validateReportPdfNarrative(rounded, insights, 'vi').ok, true, 'format-aware rounding of a cited fact is accepted');

  const offByOne = clone(base);
  offByOne.headline = { ...offByOne.headline, text: 'Tỉ lệ hoàn thành đạt 61,9% trong kỳ.' };
  assert.equal(validateReportPdfNarrative(offByOne, insights, 'vi').ok, false);
});

test('only accepts numbers from the facts each sentence cites', () => {
  const insights = buildReportInsights(vietnameseReportFixture().snapshot);
  const narrative = buildRuleBasedReportNarrative(insights, 'vi');
  const statusFinding = narrative.findings.findIndex((item) => item.factIds.includes('status.mix'));
  assert.ok(statusFinding >= 0);
  const miscited = clone(narrative);
  miscited.findings[statusFinding].factIds = ['kpi.active_learners'];
  assert.equal(validateReportPdfNarrative(miscited, insights, 'vi').ok, false);
});

test('rejects unknown facts, unknown entities, markup and the wrong language', () => {
  const insights = buildReportInsights(englishReportFixture().snapshot);
  const base = buildRuleBasedReportNarrative(insights, 'en');
  const unknownFact = clone(base);
  unknownFact.findings[0].factIds = ['kpi.revenue'];
  assert.ok(validateReportPdfNarrative(unknownFact, insights, 'en').issues.some((issue) => issue.includes('unknown_fact')));
  const unknownEntity = clone(base);
  unknownEntity.findings[0].text = 'See {{C99}} for details.';
  assert.ok(validateReportPdfNarrative(unknownEntity, insights, 'en').issues.some((issue) => issue.includes('unknown_entity')));
  const markup = clone(base);
  markup.findings[0].text = '<img src=x onerror=alert(1)> details.';
  assert.ok(validateReportPdfNarrative(markup, insights, 'en').issues.some((issue) => issue.includes('markup')));
  assert.ok(validateReportPdfNarrative(base, insights, 'vi').issues.includes('language: expected_vietnamese'));
});

test('reuses a valid stored chat narrative in the same locale only', () => {
  const fixture = vietnameseReportFixture();
  const insights = buildReportInsights(fixture.snapshot);
  const rules = buildRuleBasedReportNarrative(insights, 'vi');
  const merged = mergeStoredChatNarrative({ narrative: rules, stored: fixture.storedNarrative, storedLocale: 'vi', locale: 'vi', snapshot: fixture.snapshot });
  assert.equal(merged.commentary.length, 1);
  assert.equal(merged.recommendations[0].origin, 'chat');
  assert.equal(merged.recommendations.filter((item) => item.factIds.includes('risk.watchlist')).length, 1, 'chat action replaces the rule action for the same signal');
  assert.equal(validateReportPdfNarrative(merged, insights, 'vi').ok, true);

  assert.deepEqual(mergeStoredChatNarrative({ narrative: rules, stored: fixture.storedNarrative, storedLocale: 'vi', locale: 'en', snapshot: fixture.snapshot }), rules);
  const withNumber = structuredClone(fixture.storedNarrative) as { interpretation: string[] };
  withNumber.interpretation = ['Có 3 khóa học cần hỗ trợ.'];
  assert.deepEqual(mergeStoredChatNarrative({ narrative: rules, stored: withNumber, storedLocale: 'vi', locale: 'vi', snapshot: fixture.snapshot }), rules);
  const fallback = { selected_signal_ids: [], interpretation: [], recommended_actions: [], limitations: [] };
  assert.deepEqual(mergeStoredChatNarrative({ narrative: rules, stored: fallback, storedLocale: 'vi', locale: 'vi', snapshot: fixture.snapshot }), rules);
});

test('sends Gemini only tokenized fact statements and parses its JSON contract', () => {
  const fixture = englishReportFixture();
  const insights = buildReportInsights(fixture.snapshot);
  const request = buildReportPdfAiNarrativeRequest(insights, 'vi');
  assert.match(request.systemInstruction, /Vietnamese/);
  assert.ok(!request.payload.includes('Customer Service Fundamentals'));
  assert.ok(request.payload.includes('{{C1}}'));

  const rules = buildRuleBasedReportNarrative(insights, 'en');
  const aiShape = {
    headline: { text: rules.headline.text, fact_ids: rules.headline.factIds },
    findings: rules.findings.map((item) => ({ text: item.text, fact_ids: item.factIds })),
    risks: rules.risks.map((item) => ({ text: item.text, fact_ids: item.factIds })),
    recommendations: rules.recommendations.map((item) => ({ text: item.text, fact_ids: item.factIds, priority: item.priority })),
  };
  const parsed = toReportPdfAiNarrative(aiShape, insights);
  assert.equal(parsed?.source, 'ai');
  assert.equal(parsed?.findings[0].tone, insights.facts.find((fact) => fact.id === rules.findings[0].factIds[0])?.tone);
  assert.equal(toReportPdfAiNarrative({ headline: 'x' }, insights), null);
});
