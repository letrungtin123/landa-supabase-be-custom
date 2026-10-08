import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReportInsights } from './report-insights.logic.js';
import {
  buildReportPdfAiNarrativeRequest,
  buildRuleBasedReportNarrative,
  describeReportFact,
  extractReportNarrativeNumbers,
  mergeStoredChatNarrative,
  toReportPdfAiNarrative,
  validateReportPdfNarrative,
  type ReportPdfNarrative,
} from './report-pdf-narrative.logic.js';
import { allReportPdfFixtures, englishReportFixture, vietnameseReportFixture } from './report-pdf.fixture.js';
import { composeReportPdfDocument } from './report-pdf.service.js';

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

test('every fact statement sent to Gemini passes the validator when quoted verbatim', () => {
  for (const fixture of allReportPdfFixtures()) {
    for (const locale of ['vi', 'en'] as const) {
      const insights = buildReportInsights(fixture.snapshot);
      const rules = buildRuleBasedReportNarrative(insights, locale);
      for (const fact of insights.facts.filter((candidate) => candidate.kind !== 'context')) {
        const statement = describeReportFact(fact, insights, locale);
        if (!statement) continue;
        for (const section of ['findings', 'risks'] as const) {
          const narrative = clone(rules);
          const item = { text: statement, factIds: [fact.id], tone: fact.tone };
          if (section === 'findings') narrative.findings[0] = item;
          else narrative.risks = [item];
          assert.deepEqual(validateReportPdfNarrative(narrative, insights, locale).issues, [], `${fixture.name}/${locale}/${fact.id}: ${statement}`);
        }
      }
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

test('reads the sign and the unit written with each number', () => {
  const read = (text: string, locale: 'vi' | 'en') => extractReportNarrativeNumbers(text, locale).map((item) => [item.raw, item.sign, item.unit]);
  assert.deepEqual(read('giảm −3,7 điểm %, đạt 61,8% với (+53) lượt, 12 phần trăm', 'vi'), [['3,7', -1, 'pp'], ['61,8', null, 'percent'], ['53', 1, 'count'], ['12', null, 'percent']]);
  assert.deepEqual(read('down -5.3 pp, 4 percentage points, 52.1 percent, 01/07/2026-31/07/2026', 'en'), [
    ['5.3', -1, 'pp'], ['4', null, 'pp'], ['52.1', null, 'percent'], ['01', null, 'count'], ['07', null, 'count'], ['2026', null, 'count'], ['31', null, 'count'], ['07', null, 'count'], ['2026', null, 'count'],
  ]);
});

/** Vietnamese fixture with the completion rate exactly 5 pp above the comparison period. */
function fivePointRiseInsights() {
  const snapshot = structuredClone(vietnameseReportFixture().snapshot);
  if (snapshot.version !== 2) throw new Error('expected a v2 fixture');
  snapshot.previous_summary.overview.completion_rate = snapshot.summary.overview.completion_rate - 5;
  return buildReportInsights(snapshot);
}

function withFinding(narrative: ReportPdfNarrative, text: string, factIds: string[]): ReportPdfNarrative {
  const copy = clone(narrative);
  copy.findings[0] = { ...copy.findings[0], text, factIds };
  return copy;
}

test('rejects a direction word that contradicts the sign of the cited change ("fell 5 pp" vs +5 pp)', () => {
  const insights = fivePointRiseInsights();
  assert.equal(insights.kpis.find((kpi) => kpi.id === 'completion_rate')?.delta, 5);
  const cite = ['kpi.completion_rate'];
  const en = buildRuleBasedReportNarrative(insights, 'en');
  const enIssues = (text: string) => validateReportPdfNarrative(withFinding(en, text, cite), insights, 'en').issues;
  assert.deepEqual(validateReportPdfNarrative(en, insights, 'en').issues, []);
  assert.ok(enIssues('The completion rate fell 5 pp vs the previous month.').includes('findings[0]: direction_mismatch:5'));
  assert.ok(enIssues('The completion rate dropped by 5 percentage points.').includes('findings[0]: direction_mismatch:5'));
  assert.ok(enIssues('The completion rate was down 5 pp on the previous month.').includes('findings[0]: direction_mismatch:5'));
  assert.ok(enIssues('The completion rate changed by −5 pp.').includes('findings[0]: number_sign_mismatch:5'));
  assert.ok(enIssues('The completion rate fell compared with the previous month.').includes('findings[0]: direction_mismatch'), 'a direction without a number is checked too');
  assert.deepEqual(enIssues('The completion rate rose 5 pp to 61.8%.'), []);
  assert.deepEqual(enIssues('The completion rate reached 61.8%, +5 pp on the previous month.'), []);
  assert.deepEqual(enIssues('The completion rate was 61.8%, 5 pp higher than in the previous month.'), []);

  const vi = buildRuleBasedReportNarrative(insights, 'vi');
  const viIssues = (text: string) => validateReportPdfNarrative(withFinding(vi, text, cite), insights, 'vi').issues;
  assert.deepEqual(validateReportPdfNarrative(vi, insights, 'vi').issues, []);
  assert.ok(viIssues('Tỉ lệ hoàn thành giảm 5 điểm % so với tháng trước.').includes('findings[0]: direction_mismatch:5'));
  assert.ok(viIssues('Tỉ lệ hoàn thành giảm xuống 61,8%.').includes('findings[0]: direction_mismatch:61,8'), 'a level cannot be reached by the wrong direction');
  assert.ok(viIssues('Tỉ lệ hoàn thành thấp hơn tháng trước.').includes('findings[0]: direction_mismatch'));
  assert.deepEqual(viIssues('Tỉ lệ hoàn thành tăng 5 điểm %, lên 61,8%.'), []);
  assert.deepEqual(viIssues('Tỉ lệ hoàn thành tăng từ 56,8% lên 61,8%.'), []);
});

test('checks each direction against its own change when a sentence cites a rise and a fall', () => {
  const insights = buildReportInsights(englishReportFixture().snapshot);
  const rules = buildRuleBasedReportNarrative(insights, 'en');
  const cite = ['kpi.total_enrollments', 'kpi.completion_rate'];
  const issues = (text: string) => validateReportPdfNarrative(withFinding(rules, text, cite), insights, 'en').issues;
  // English fixture: enrollments +124 (+34.3%), completion -5.3 pp (57.4% -> 52.1%).
  assert.deepEqual(issues('Enrollments rose 34.3% while the completion rate fell 5.3 pp to 52.1%.'), []);
  assert.deepEqual(issues('Although enrollments rose by 124, completion fell to 52.1%.'), []);
  assert.ok(issues('Enrollments fell 34.3% while the completion rate rose 5.3 pp.').includes('findings[0]: direction_mismatch:34.3'));
  assert.ok(issues('Enrollments fell 34.3% while the completion rate rose 5.3 pp.').includes('findings[0]: direction_mismatch:5.3'));
});

test('rejects a count quoted as a percentage and a percentage quoted as a count', () => {
  const insights = buildReportInsights(vietnameseReportFixture().snapshot);
  const vi = buildRuleBasedReportNarrative(insights, 'vi');
  const issues = (text: string, factIds: string[]) => validateReportPdfNarrative(withFinding(vi, text, factIds), insights, 'vi').issues;
  assert.ok(issues('Lượt ghi danh đạt 315% trong kỳ.', ['kpi.total_enrollments']).includes('findings[0]: number_unit_mismatch:315'));
  assert.ok(issues('Tỉ lệ hoàn thành đạt 61,8 lượt.', ['kpi.completion_rate']).includes('findings[0]: number_unit_mismatch:61,8'));
  assert.ok(issues('Lượt ghi danh tăng 20,2 điểm %.', ['kpi.total_enrollments']).includes('findings[0]: number_unit_mismatch:20,2'), 'a relative change is not a percentage-point change');
  assert.deepEqual(issues('Lượt ghi danh đạt 315, tăng 20,2% so với tháng trước.', ['kpi.total_enrollments']), []);
  assert.deepEqual(issues('Tỉ lệ hoàn thành tăng 3,7% so với tháng trước.', ['kpi.completion_rate']), [], 'a "%" may quote a percentage-point field');
  const en = buildRuleBasedReportNarrative(insights, 'en');
  assert.ok(validateReportPdfNarrative(withFinding(en, 'Enrollments reached 315 percent.', ['kpi.total_enrollments']), insights, 'en').issues
    .includes('findings[0]: number_unit_mismatch:315'));
});

test('a narrative that fails the sign or unit check falls back to the rule-based narrative', async () => {
  const fixture = vietnameseReportFixture();
  const insights = buildReportInsights(fixture.snapshot);
  const rules = buildRuleBasedReportNarrative(insights, 'vi');
  const wrong = withFinding({ ...rules, source: 'ai' }, 'Tỉ lệ hoàn thành giảm 3,7 điểm % so với tháng trước.', ['kpi.completion_rate']);
  const composed = await composeReportPdfDocument({
    snapshot: fixture.snapshot, snapshotHash: fixture.snapshotHash, locale: 'vi', tenant: { name: fixture.tenantName, logoDataUri: null },
    writeAiNarrative: async () => wrong,
  });
  assert.equal(composed.narrative.source, 'rules');
  const right = withFinding({ ...rules, source: 'ai' }, 'Tỉ lệ hoàn thành tăng 3,7 điểm % so với tháng trước.', ['kpi.completion_rate']);
  const accepted = await composeReportPdfDocument({
    snapshot: fixture.snapshot, snapshotHash: fixture.snapshotHash, locale: 'vi', tenant: { name: fixture.tenantName, logoDataUri: null },
    writeAiNarrative: async () => right,
  });
  assert.equal(accepted.narrative.source, 'ai');
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
