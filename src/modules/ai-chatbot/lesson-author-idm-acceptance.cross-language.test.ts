import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { LessonAuthorProposal } from '../course-authoring/course-authoring.service.js';
import type { CourseComponentType } from '../tenants/tenant-course-components.constants.js';
import { lessonAuthorHtmlInstructionalQualityFinding } from './lesson-author-content-contract.logic.js';
import { renderSemanticLearningHtml } from './lesson-author-component-registry.logic.js';
import { IDM_BRIDGE_AVAILABLE, idmBridge, type IdmBridgeResult } from './lesson-author-idm.fixture.js';
import {
  OrchestrationV2UnitError,
  acceptOrchestrationV2GeneratedUnit,
  readOrchestrationV2UnitProviderResponse,
  type OrchestrationV2UnitGenerationContract,
} from './lesson-author-orchestration-v2-unit.logic.js';

/**
 * Run c2e5ac41: Python validated two IDM worksheet units that Node then rejected
 * at unit_acceptance (ORCHESTRATION_V2_UNIT_BASELINE_INVALID). Python now applies
 * Node's acceptance rules before it returns a unit (`app/idm/node_acceptance.py`).
 * This suite drives the real Python `/unit` route offline (fake provider,
 * `landa-ai-rag/tests/idm_contract_bridge.py`) and the real Node acceptance, and
 * checks that both sides give the same verdict, check and reason code.
 */

type Row = Record<string, any>;
type Verdict = { check: string; code: string; path: string } | null;
const ALLOWED = new Set<CourseComponentType>(['html', 'problem', 'la_faq', 'la_sortable', 'la_crossword', 'la_diagram']);
const clone = <T>(value: T): T => structuredClone(value);

async function normalizer(t: TestContext): Promise<(raw: unknown) => LessonAuthorProposal> {
  const pg = await import('pg');
  t.mock.method(pg.default.Pool.prototype, 'query', () => { throw new Error('TEST_DATABASE_ACCESS_FORBIDDEN'); });
  t.mock.method(pg.default.Pool.prototype, 'connect', () => { throw new Error('TEST_DATABASE_ACCESS_FORBIDDEN'); });
  t.mock.method(globalThis, 'fetch', () => { throw new Error('TEST_HTTP_ACCESS_FORBIDDEN'); });
  const nativeInterval = globalThis.setInterval;
  t.mock.method(globalThis, 'setInterval', (...args: Parameters<typeof setInterval>) => {
    const timer = nativeInterval(...args); timer.unref(); t.after(() => clearInterval(timer)); return timer;
  });
  return (await import('./chat.service.js')).normalizeLessonAuthorProposal;
}

/** Real Node verdict for a Python `/unit` response: null when accepted. */
function nodeVerdict(contract: Row, response: Row, normalize: (raw: unknown) => LessonAuthorProposal): Verdict {
  const typed = contract as unknown as OrchestrationV2UnitGenerationContract;
  try {
    acceptOrchestrationV2GeneratedUnit({ contract: typed, normalizeProposal: normalize, allowed: ALLOWED,
      response: readOrchestrationV2UnitProviderResponse(response, typed) });
    return null;
  } catch (error) {
    if (error instanceof OrchestrationV2UnitError && error.acceptance) {
      const { check, code, path } = error.acceptance;
      return { check, code, path };
    }
    throw error;
  }
}

function unitRun(request: Row, writer: Row, repair: Row[] = []): IdmBridgeResult {
  const [result] = idmBridge([{ stage: 'unit', request, options: { writer: [writer], repair } }]);
  assert.equal(result!.status, 200, JSON.stringify(result!.response).slice(0, 400));
  return result!;
}

const block = (kind: string, value: Row) => ({ kind, text: null, items: [], rows: [], ...value });
const sections = (component: Row) => component.semantic_content.sections as Row[];
const withoutCoverage = (slot: Row) => (({ covered_source_fact_ids: _ids, ...rest }) => rest)(slot);

/** The worksheet shapes of run c2e5ac41: identical blank-cell guidance and template labels reused by the example. */
function productionWorksheet(writer: Row): Row {
  const answer = clone(writer);
  const guidance = 'Ghi cấp độ và người cần xử lý vào ô này.';
  const [, template, example] = sections(answer.components.c0);
  template!.blocks = [block('table', { rows: ['thứ nhất', 'thứ hai', 'thứ ba']
    .map(label => ({ label: `Khiếu nại mẫu ${label}`, value: guidance })) })];
  example!.blocks = [block('table', { rows: [{ label: 'Khiếu nại mẫu thứ nhất',
    value: 'Cấp 2: thông báo trưởng nhóm vì khách hàng phàn nàn lần thứ hai.' }] })];
  return answer;
}

test('IDM worksheet, FAQ and locator answers that Node used to reject are settled in Python and accepted by Node',
  { skip: !IDM_BRIDGE_AVAILABLE && 'landa-ai-rag dev virtualenv not available' }, async t => {
    const normalize = await normalizer(t);
    const golden = idmBridge([{ stage: 'golden_unit', request: {} }])[0]!.response;
    const worksheet = golden.worksheet as { request: Row; writer: Row };
    const contract = worksheet.request.unit_contract;

    // Root cause: the same worksheet html Node rendered for run c2e5ac41 repeats learner blocks.
    const production = productionWorksheet(worksheet.writer);
    const html = renderSemanticLearningHtml({ version: 2, ...production.components.c0.semantic_content })!;
    assert.equal(lessonAuthorHtmlInstructionalQualityFinding(html)?.code, 'HTML_DUPLICATE_BLOCK');
    // Fixed (both sides): a worksheet may repeat its template's table cells; no repair, Node accepts.
    const repeated = unitRun(worksheet.request, production);
    assert.deepEqual(repeated.calls.map(name => name.replace(/IdmWire$/, '')),
      ['StagedInstancePayloadUnit', 'IdmJudgeResponseV1']);
    assert.equal(repeated.response.content_origin, 'provider_validated');
    assert.equal(nodeVerdict(contract, repeated.response, normalize), null);

    // "Hiện trạng" + a number folds to a page locator in Node: Python names the rule in one repair call.
    const locator = clone(worksheet.writer);
    sections(locator.components.c0)[1]!.blocks[0].rows.unshift({ label: 'Hiện trạng',
      value: '3 khiếu nại đang chờ phân loại trong ca.' });
    const repaired = unitRun(worksheet.request, locator,
      [{ components: { c0: withoutCoverage(worksheet.writer.components.c0) } }]);
    assert.ok(repaired.calls.some(name => name.startsWith('StagedMultiRepair')));
    assert.equal(repaired.response.content_origin, 'provider_validated');
    assert.equal(nodeVerdict(contract, repaired.response, normalize), null);
    // Without a usable repair the slot falls back to the source-locked html; still accepted.
    const fallback = unitRun(worksheet.request, locator);
    assert.equal(fallback.response.content_origin, 'structured_fallback');
    assert.equal(nodeVerdict(contract, fallback.response, normalize), null);

    // An FAQ answer with ">" breaks Node's workspace schema: the item is dropped while two items remain.
    const escalate = golden.escalate as { request: Row; writer: Row };
    const faq = clone(escalate.writer);
    const items = faq.components.c1.items as Row[];
    items.push({ question: 'Thứ tự xử lý một khiếu nại liên quan an toàn là gì?',
      answer: `${items[0]!.answer} Thứ tự: phân loại -> escalate.` });
    const pruned = unitRun(escalate.request, faq);
    assert.equal(pruned.response.unit.components[1].items.length, 2);
    assert.equal(nodeVerdict(escalate.request.unit_contract, pruned.response, normalize), null);
  });

test('the Python acceptance mirror reports the same first rule as Node (check, code, path)',
  { skip: !IDM_BRIDGE_AVAILABLE && 'landa-ai-rag dev virtualenv not available' }, async t => {
    const normalize = await normalizer(t);
    const golden = idmBridge([{ stage: 'golden_unit', request: {} }])[0]!.response as Record<string, { request: Row; writer: Row }>;
    const bases = Object.fromEntries(Object.entries(golden).map(([name, { request, writer }]) =>
      [name, { contract: request.unit_contract, response: unitRun(request, writer).response }]));
    type Case = { name: string; base: string; edit: (unit: Row) => void; origin?: 'structured_fallback' };
    const html = (unit: Row) => unit.components[0] as Row;
    const problem = (unit: Row) => unit.components.find((component: Row) => component.type === 'problem') as Row;
    const faq = (unit: Row) => unit.components[1] as Row;
    const paragraph = (unit: Row, text: string) => sections(html(unit))[0]!.blocks.push(block('paragraph', { text }));
    const long = Array.from({ length: 4 }, (_, part) => Array.from({ length: 250 },
      (_word, index) => `mục${part * 250 + index}`).join(' '));
    const cases: Case[] = [
      { name: 'unchanged worksheet', base: 'worksheet', edit: () => undefined },
      { name: 'worksheet repeats template cells', base: 'worksheet', edit: unit => {
        sections(html(unit))[1]!.blocks[0].rows.forEach((row: Row) => { row.value = 'Ghi người cần xử lý vào ô này.'; });
      } },
      { name: 'repeated paragraph', base: 'worksheet', edit: unit => {
        paragraph(unit, 'Đối chiếu từng dòng với tiêu chí đã học.'); paragraph(unit, 'Đối chiếu từng dòng với tiêu chí đã học.');
      } },
      { name: 'locator after trạng', base: 'worksheet', edit: unit => paragraph(unit, 'Hiện trạng 3 khiếu nại chờ xử lý.') },
      { name: 'attribution', base: 'worksheet', edit: unit => paragraph(unit, 'Theo tài liệu nguồn, cần phân loại trước.') },
      { name: 'file name', base: 'worksheet', edit: unit => paragraph(unit, 'Mẫu có trong bang-phan-loai.pdf của nhóm.') },
      { name: 'fact key', base: 'worksheet', edit: unit => paragraph(unit,
        `Ghi chú ${bases.worksheet!.contract.source_facts[0].fact_key} cho người học.`) },
      { name: 'OCR noise', base: 'worksheet', edit: unit => paragraph(unit, 'Chờ.......... xử lý tiếp theo.') },
      { name: 'boilerplate item', base: 'worksheet', edit: unit => sections(html(unit))[3]!.blocks[0].items.push('www.example.com') },
      { name: 'thin html', base: 'worksheet', edit: unit => {
        html(unit).semantic_content.sections = [{ heading: 'Nhiệm vụ', learning_block_ids: [],
          blocks: [block('task', { text: 'Phân loại ba khiếu nại mẫu.' })] }];
      } },
      { name: 'over budget', base: 'worksheet', edit: unit => long.forEach(text => paragraph(unit, text)) },
      { name: 'over budget in a fallback unit', base: 'worksheet', origin: 'structured_fallback',
        edit: unit => long.forEach(text => paragraph(unit, text)) },
      { name: 'short choice', base: 'worksheet', edit: unit => { problem(unit).choices[0].text = 'Có'; } },
      { name: 'two choices', base: 'worksheet', edit: unit => { problem(unit).choices = problem(unit).choices
        .filter((choice: Row) => choice.correct).concat([{ text: 'Chuyển hồ sơ cho bộ phận khác ngay.', correct: false }]); } },
      { name: 'no explanation', base: 'worksheet', edit: unit => { problem(unit).explanation = ''; } },
      { name: 'choices differ only by accents', base: 'worksheet', edit: unit => {
        const choices = problem(unit).choices as Row[];
        const wrong = choices.findIndex(choice => !choice.correct);
        choices[wrong]!.text = choices.find(choice => choice.correct)!.text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      } },
      { name: 'escaped angle bracket in a choice', base: 'worksheet', edit: unit => {
        problem(unit).choices.find((choice: Row) => !choice.correct).text = 'Thiệt hại < 50 triệu đồng thì bỏ qua.';
      } },
      { name: 'no question', base: 'worksheet', edit: unit => { problem(unit).question = '  '; } },
      { name: 'two correct choices', base: 'worksheet', edit: unit => {
        problem(unit).choices.forEach((choice: Row) => { choice.correct = true; });
      } },
      { name: 'explanation html repeats cells', base: 'severity', edit: unit => {
        sections(html(unit))[0]!.blocks.find((item: Row) => item.kind === 'table').rows
          .forEach((row: Row) => { row.value = 'Ghi người cần xử lý vào ô này.'; });
      } },
      { name: 'unchanged faq', base: 'escalate', edit: () => undefined },
      { name: 'faq angle bracket', base: 'escalate', edit: unit => { faq(unit).items[0].answer += ' (A -> B)'; } },
      { name: 'faq NFKC duplicate question', base: 'escalate', edit: unit => {
        faq(unit).items[1].question = faq(unit).items[0].question.replace(/\?$/, '\uff1f');
      } },
      { name: 'faq single item', base: 'escalate', edit: unit => { faq(unit).items = faq(unit).items.slice(0, 1); } },
      { name: 'faq control character', base: 'escalate', edit: unit => { faq(unit).items[0].question += '\u0007 nữa?'; } },
    ];
    const prepared = cases.map(item => {
      const base = bases[item.base]!;
      const response = clone(base.response);
      item.edit(response.unit);
      if (item.origin) Object.assign(response, { content_origin: item.origin, quality_state: 'review_required' });
      return { item, contract: base.contract, response };
    });
    const python = idmBridge(prepared.map(({ contract, response }) => ({ stage: 'acceptance' as const,
      request: { contract, units: [{ unit: response.unit, provider_validated: response.content_origin === 'provider_validated' }] } })))
      .map(result => (result.response.results as Verdict[])[0]);
    const verdicts = prepared.map(({ item, contract, response }, index) => ({ name: item.name,
      node: nodeVerdict(contract, response, normalize), python: python[index] ?? null }));
    for (const verdict of verdicts) assert.deepEqual(verdict.python, verdict.node, verdict.name);
    // The corpus exercises every check Node applies to authored content, not only accepted units.
    assert.deepEqual([...new Set(verdicts.map(verdict => verdict.node?.check ?? 'accepted'))].sort(),
      ['accepted', 'coverage', 'idm_budget', 'normalization', 'workspace_component']);
  });
