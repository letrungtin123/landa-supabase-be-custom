import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

// Characterization of POST /api/learner/blocks/:blockId/submit: the answer
// (or error) of submitBlockAnswer and its statements, for every block type
// and a matrix of correct, wrong, partial and malformed submissions. The
// golden file was written by the code before the grading moved to
// learner-grading.logic.ts; every entry must stay equal.
//
// No database: a pg double answers the block lookup with the case's block
// and the course access check with one row. Rewrite the golden file only for
// an intended change:
//   LEARNER_GRADING_GOLDEN_WRITE=1 npx tsx --test src/modules/learner/learner-grading.characterization.test.ts

const pg = await import('pg');
const { pool } = await import('../../config/database.js');
const svc = await import('./learner.service.js');
const { sortableOpaqueItemId } = await import('./learner-answer-key.logic.js');

test.after(async () => {
  await pool.end();
});

const GOLDEN_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'learner-grading.characterization.golden.json');
const WRITE_GOLDEN = process.env.LEARNER_GRADING_GOLDEN_WRITE === '1';
const TENANT = '11111111-1111-4111-8111-111111111111';
const BLOCK_ID = 'block-v1:Landa+G1+2026+type@problem+block@golden';

interface BlockRow {
  id: string;
  block_type: string;
  data: unknown;
  metadata: unknown;
  course_id: string;
}

const block = (block_type: string, data: unknown, metadata: unknown = null): BlockRow => ({
  id: BLOCK_ID, block_type, data, metadata, course_id: 'course-v1:Landa+G1+2026',
});

const MULTIPLE_CHOICE = `<problem><multiplechoiceresponse><p>Q?</p><choicegroup type="MultipleChoice">
<choice correct="false">Hà Nội</choice><choice correct="true">Huế</choice><choice correct="false">Đà Nẵng</choice>
</choicegroup></multiplechoiceresponse><solution><div class="detailed-solution"><p>Kinh đô cũ.</p></div></solution></problem>`;
const CHOICEGROUP_ONLY = '<problem><choicegroup><choice correct="true">Yes</choice><choice correct="false">No</choice></choicegroup></problem>';
const CHECKBOX = `<problem><choiceresponse><checkboxgroup>
<choice correct="true">A</choice><choice correct="true">B</choice><choice correct="false">C</choice>
</checkboxgroup></choiceresponse></problem>`;
const DROPDOWN_ATTR = '<problem><optionresponse><optioninput options="(\'x\',\'y\')" correct="y"></optioninput></optionresponse></problem>';
const DROPDOWN_OPTIONS = `<problem><optionresponse><optioninput>
<option correct="False">Một</option><option correct="True"><b>Hai</b></option></optioninput></optionresponse></problem>`;
const DROPDOWN_NONE = '<problem><optionresponse><optioninput><option correct="False">x</option></optioninput></optionresponse></problem>';
const STRING_CI = '<problem><stringresponse answer="Việt Nam" type="ci"><textline/></stringresponse></problem>';
const STRING_CS = '<problem><stringresponse answer="ABC"><textline/></stringresponse></problem>';
const STRING_NONE = '<problem><stringresponse><textline/></stringresponse></problem>';
const NUMERIC = '<problem><numericalresponse answer="3.14"><responseparam type="tolerance" default="0.01"/><formulaequationinput/></numericalresponse></problem>';
const NUMERIC_EXACT = '<problem><numericalresponse answer="42"><formulaequationinput/></numericalresponse></problem>';
const NUMERIC_NONE = '<problem><numericalresponse answer="abc"><formulaequationinput/></numericalresponse></problem>';
const NO_CHOICES = '<problem><multiplechoiceresponse><choicegroup></choicegroup></multiplechoiceresponse></problem>';
const UNKNOWN_PROBLEM = '<problem><customresponse/></problem>';

const MEDIA_QUIZ = {
  mode: 'single_select',
  questions: [
    { id: 'q1', choices: [{ id: 'a', correct: true }, { id: 'b', correct: false }], explanation_html: '<p>Vì a.</p>' },
    { id: 'q2', mode: 'multiple_select', choices: [{ id: 'x', correct: true }, { id: 'y', correct: true }, { id: 'z' }] },
    { id: 'q3', choices: [{ id: 'm' }] },
    null,
  ],
};
const IMAGE_CHOICE = {
  choices: [{ id: 'c1', correct: false }, { id: 'c2', correct: true }, { id: 'c3' }, { id: 'c4' }, { id: 'c5', correct: true }],
  explanation_html: '<p>Ảnh 2.</p>',
};
const SCENARIO = {
  rounds: [
    { id: 'r1', choices: [{ id: 'ok', correct: true, response_message: 'Tốt', response_description: 7, character_status: 'vui', explanation: null }, { id: 'no', correct: false, response_message: 'Chưa' }] },
    { id: 'r2', choices: [{ id: 'end', correct: true }] },
  ],
};
const CROSSWORD = { crossword_data: { words: [{ id: 1, answer: 'Huế' }, { id: 'w2', answer: ' sông ' }, { id: 3 }] } };
const SORTABLE = { sortable_data: { items: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }] } };
const opaque = (id: unknown) => sortableOpaqueItemId(BLOCK_ID, id);

const BLOCKS: Record<string, BlockRow> = {
  'problem multiple choice': block('problem', MULTIPLE_CHOICE),
  'problem choicegroup only': block('problem', CHOICEGROUP_ONLY),
  'problem checkbox': block('problem', CHECKBOX),
  'problem dropdown attribute': block('problem', DROPDOWN_ATTR),
  'problem dropdown options': block('problem', DROPDOWN_OPTIONS),
  'problem dropdown no answer': block('problem', DROPDOWN_NONE),
  'problem string ci': block('problem', STRING_CI),
  'problem string cs': block('problem', STRING_CS),
  'problem string no answer': block('problem', STRING_NONE),
  'problem numeric tolerance': block('problem', NUMERIC),
  'problem numeric exact': block('problem', NUMERIC_EXACT),
  'problem numeric no answer': block('problem', NUMERIC_NONE),
  'problem no choices': block('problem', NO_CHOICES),
  'problem unknown type': block('problem', UNKNOWN_PROBLEM),
  'problem empty': block('problem', ''),
  'problem object data': block('problem', { olx: MULTIPLE_CHOICE }),
  'media quiz object': block('la_media_quiz', MEDIA_QUIZ),
  'media quiz text': block('la_media_quiz', JSON.stringify(MEDIA_QUIZ)),
  'media quiz bad text': block('la_media_quiz', '{not json'),
  'media quiz no questions': block('la_media_quiz', { questions: 'x' }),
  'image choice': block('la_image_choice_quiz', IMAGE_CHOICE),
  'image choice text': block('la_image_choice_quiz', JSON.stringify(IMAGE_CHOICE)),
  'image choice no choices': block('la_image_choice_quiz', null),
  scenario: block('la_scenario_chat', SCENARIO),
  'scenario text': block('la_scenario_chat', JSON.stringify(SCENARIO)),
  'scenario no rounds': block('la_scenario_chat', { rounds: {} }),
  crossword: block('la_crossword', null, CROSSWORD),
  'crossword empty': block('la_crossword', null, { crossword_data: {} }),
  'crossword no metadata': block('la_crossword', null, null),
  sortable: block('la_sortable', null, SORTABLE),
  'sortable empty': block('la_sortable', null, { sortable_data: { items: [] } }),
  'sortable no metadata': block('la_sortable', null, null),
  'html block': block('html', '<p>x</p>'),
};

const BODIES: Record<string, () => unknown> = {
  'no answers': () => ({}),
  'answers empty': () => ({ answers: {} }),
  'answer choice_1': () => ({ answers: { olx_0: 'choice_1' } }),
  'answer choice_0 list': () => ({ answers: { olx_0: ['choice_0', 'choice_1'] } }),
  'answer by text': () => ({ answers: { olx_0: 'Huế' } }),
  'answer y': () => ({ answers: { olx_0: 'y' } }),
  'answer Hai': () => ({ answers: { olx_0: 'Hai' } }),
  'answer viet nam lower': () => ({ answers: { olx_0: ' viet nam ' } }),
  'answer Việt Nam upper': () => ({ answers: { olx_0: 'VIỆT NAM' } }),
  'answer ABC padded': () => ({ answers: { olx_0: ' ABC ' } }),
  'answer abc': () => ({ answers: { olx_0: 'abc' } }),
  'answer 3.145': () => ({ answers: { olx_0: '3.145' } }),
  'answer 3.2': () => ({ answers: { olx_0: '3.2' } }),
  'answer 42 list': () => ({ answers: { olx_0: ['42', '1'] } }),
  'answer number': () => ({ answers: { olx_0: 42 } }),
  'answer null': () => ({ answers: { olx_0: null } }),
  'answers not object': () => ({ answers: 'choice_1' }),
  'media q1 a': () => ({ question_id: 'q1', answer: 'a' }),
  'media q1 b': () => ({ question_id: 'q1', answer: ['b', 'a'] }),
  'media q1 a via answers': () => ({ question_id: 'q1', answers: { q1: ' a ' } }),
  'media q2 x y': () => ({ question_id: 'q2', answer: ['y', 'x', 'x'] }),
  'media q2 x': () => ({ question_id: 'q2', answers: ['x'] }),
  'media q3': () => ({ question_id: 'q3', answer: 'm' }),
  'media unknown question': () => ({ question_id: 'q9', answer: 'a' }),
  'media question number': () => ({ question_id: 1, answer: 'a' }),
  'image c2': () => ({ choice_id: ' c2 ' }),
  'image c1 answer': () => ({ answer: 'c1' }),
  'image c2 answers map': () => ({ answers: { first: 'c2', second: 'c1' } }),
  'image c5 beyond four': () => ({ choice_id: 'c5' }),
  'scenario r1 ok': () => ({ round_id: 'r1', choice_id: 'ok' }),
  'scenario r1 no': () => ({ round_id: 'r1', choice_id: 'no' }),
  'scenario r2 end': () => ({ round_id: 'r2', choice_id: 'end' }),
  'scenario unknown round': () => ({ round_id: 'r9', choice_id: 'ok' }),
  'scenario unknown choice': () => ({ round_id: 'r1', choice_id: 'zz' }),
  'crossword all': () => ({ answers: { 1: 'huế', w2: 'SÔNG', 3: '' } }),
  'crossword some': () => ({ answers: { 1: 'HUẾ' } }),
  'sortable stored order': () => ({ answer: [1, 2, 3, 4] }),
  'sortable opaque order': () => ({ answer: [opaque(1), opaque(2), opaque(3), opaque(4)] }),
  'sortable opaque swapped': () => ({ answer: [opaque(2), opaque(1), opaque(3), opaque(4)] }),
  'sortable short': () => ({ answer: [opaque(1)] }),
  'sortable not a list': () => ({ answer: '1,2,3,4' }),
  'null body': () => null,
  'no body': () => undefined,
};

function plain(value: unknown): unknown {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}

async function runCase(t: TestContext, row: BlockRow | null, body: unknown, role: string, access = true) {
  const statements: Array<{ text: string; params: unknown[] }> = [];
  t.mock.method(pg.default.Pool.prototype, 'query', async (text: string, params: unknown[] = []) => {
    statements.push({ text: text.replace(/\s+/g, ' ').trim(), params });
    if (statements.length === 1) return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
    return access ? { rows: [{ id: row?.course_id }], rowCount: 1 } : { rows: [], rowCount: 0 };
  });
  let result: unknown;
  try {
    result = { value: plain(await svc.submitBlockAnswer(BLOCK_ID, 'user-1', role, TENANT, body)) };
  } catch (error) {
    const { statusCode } = error as { statusCode?: unknown };
    result = { error: (error as Error).name, message: (error as Error).message, statusCode: statusCode ?? null };
  }
  return { statements: statements.map(s => ({ text: s.text, params: plain(s.params) })), result };
}

const cases: Array<{ name: string; run: (t: TestContext) => ReturnType<typeof runCase> }> = [];
for (const [blockName, row] of Object.entries(BLOCKS)) {
  for (const [bodyName, body] of Object.entries(BODIES)) {
    cases.push({ name: `${blockName} / ${bodyName}`, run: t => runCase(t, row, body(), 'staff') });
  }
}
cases.push({ name: 'unknown block', run: t => runCase(t, null, { answers: {} }, 'staff') });
cases.push({ name: 'no course access staff', run: t => runCase(t, BLOCKS['problem checkbox'], { answers: {} }, 'staff', false) });
cases.push({ name: 'no course access learner', run: t => runCase(t, BLOCKS['problem checkbox'], { answers: {} }, 'learner', false) });
cases.push({ name: 'learner access query', run: t => runCase(t, BLOCKS['problem checkbox'], { answers: { a: ['choice_0'] } }, 'learner') });

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const golden: Record<string, string> = existsSync(GOLDEN_PATH) ? JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) : {};
const written: Record<string, string> = {};

for (const item of cases) {
  test(`learner grading: ${item.name}`, async t => {
    const outcome = await item.run(t);
    if (WRITE_GOLDEN) {
      written[item.name] = digest(outcome);
      return;
    }
    assert.equal(digest(outcome), golden[item.name], `outcome changed:\n${JSON.stringify(outcome).slice(0, 3000)}`);
  });
}

test('every golden entry still has its case', () => {
  if (WRITE_GOLDEN) {
    const sorted = Object.fromEntries(
      Object.keys(written)
        .sort()
        .map(name => [name, written[name]]),
    );
    writeFileSync(GOLDEN_PATH, `${JSON.stringify(sorted, null, 1)}\n`);
    return;
  }
  assert.deepStrictEqual(Object.keys(golden).sort(), cases.map(item => item.name).sort());
});
