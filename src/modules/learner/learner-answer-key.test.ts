import assert from 'node:assert/strict';
import test from 'node:test';
import { getDefaultProblemXml } from '../course-authoring/course-authoring-problem-defaults.logic.js';
import {
  problemExplanationHtml,
  resolveSortableSubmission,
  sortableOpaqueItemId,
  toLearnerProblemOlx,
} from './learner-answer-key.logic.js';
import { toLearnerBlockRow } from './learner-block-row.logic.js';

// S2 T2: learners never receive answer keys; grading stays on the server.

const BLOCK = '0b7f6a7e-6a0b-4c2e-9d53-7d6c4d1f0a11';

test('problem OLX loses every answer key, solution and per-choice hint, and keeps the question', () => {
  const olx = `<problem>
  <multiplechoiceresponse>
    <label>Thủ đô của Pháp?</label>
    <choicegroup type="MultipleChoice">
      <choice name="a" correct="true">Paris <choicehint>Đúng rồi!</choicehint></choice>
      <choice correct='false' name="b">Lyon</choice>
      <choice correct=False>Nice</choice>
    </choicegroup>
  </multiplechoiceresponse>
  <stringresponse answer="Paris" type="ci"><additional_answer answer="paris city"/><textline size="20"/></stringresponse>
  <numericalresponse answer="100"><responseparam type="tolerance" default="5%" /><formulaequationinput /></numericalresponse>
  <optionresponse><optioninput options="('A','B')" correct="B"><option correct="True">B</option><option>A</option></optioninput></optionresponse>
  <script type="loncapa/python">expected = "Paris"</script>
  <solution><div class="detailed-solution"><p>Giải thích</p><p>Paris là thủ đô.</p></div></solution>
  <demandhint><hint>Thành phố ánh sáng</hint></demandhint>
</problem>`;
  const learner = toLearnerProblemOlx(olx);
  assert.doesNotMatch(learner, /correct\s*=|\banswer\s*=|<solution|choicehint|additional_answer|responseparam|loncapa|expected|Đúng rồi/i);
  assert.match(learner, /<label>Thủ đô của Pháp\?<\/label>/);
  assert.match(learner, /<choice name="a">Paris <\/choice>/);
  assert.match(learner, /<choice name="b">Lyon<\/choice>/);
  assert.match(learner, /<optioninput options="\('A','B'\)"><option>B<\/option>/);
  assert.match(learner, /<stringresponse type="ci">/);
  assert.match(learner, /<demandhint><hint>Thành phố ánh sáng<\/hint><\/demandhint>/);
  assert.equal(problemExplanationHtml(olx), '<p>Giải thích</p><p>Paris là thủ đô.</p>');
});

test('every starter problem type keeps no answer key for learners', () => {
  for (const boilerplate of ['multiplechoice.yaml', 'checkboxes_response.yaml', 'optionresponse.yaml', 'numericalresponse.yaml', 'string_response.yaml']) {
    for (const locale of ['vi', 'en'] as const) {
      const olx = getDefaultProblemXml(boilerplate, locale);
      assert.ok(olx, boilerplate);
      assert.doesNotMatch(toLearnerProblemOlx(olx!), /correct\s*=|\banswer\s*=|additional_answer|tolerance/, `${boilerplate} ${locale}`);
    }
  }
});

test('crossword words keep their length, never their answer, in metadata and data', () => {
  const row = toLearnerBlockRow({
    id: BLOCK, block_type: 'la_crossword', display_name: 'Ô chữ',
    data: { crossword_data: JSON.stringify({ words: [{ id: 1, answer: 'PARIS', clue: 'Thủ đô', row: 0, col: 0, direction: 'across' }] }) },
    metadata: { crossword_data: { words: [{ id: 1, answer: 'PARIS', clue: 'Thủ đô', length: 3 }], keyword_coordinates: [[0, 0]] } },
  });
  assert.doesNotMatch(JSON.stringify(row), /PARIS|"answer"/);
  assert.deepEqual(row.metadata.crossword_data.words[0], { id: 1, clue: 'Thủ đô', length: 5 });
  assert.deepEqual(row.metadata.crossword_data.keyword_coordinates, [[0, 0]]);
  assert.equal(JSON.parse(row.data.crossword_data).words[0].length, 5);
});

test('sortable items lose their order key: opaque ids, stable shuffled order', () => {
  const items = [{ id: 1, text: 'Một' }, { id: 2, text: 'Hai' }, { id: 3, text: 'Ba' }, { id: 4, text: 'Bốn' }, { id: 5, text: 'Năm' }];
  const row = toLearnerBlockRow({
    id: BLOCK, block_type: 'la_sortable', display_name: 'Sắp xếp',
    data: { sortable_data: JSON.stringify({ items }) },
    metadata: { sortable_data: { items, question_text: 'Xếp theo thứ tự' } },
  });
  const learnerItems = row.metadata.sortable_data.items as Array<{ id: string; text: string }>;
  assert.equal(learnerItems.length, 5);
  for (const item of learnerItems) assert.match(item.id, /^s_[0-9a-f]{20}$/);
  assert.deepEqual([...learnerItems.map((item) => item.text)].sort(), items.map((item) => item.text).sort());
  assert.deepEqual(JSON.parse(row.data.sortable_data).items, learnerItems, 'data copy matches metadata');
  assert.deepEqual(toLearnerBlockRow({ id: BLOCK, block_type: 'la_sortable', metadata: { sortable_data: { items } } }).metadata.sortable_data.items, learnerItems, 'stable');
  assert.notEqual(sortableOpaqueItemId(BLOCK, 1), sortableOpaqueItemId('another-block', 1));

  const correct = items.map((item) => sortableOpaqueItemId(BLOCK, item.id));
  assert.deepEqual(resolveSortableSubmission(BLOCK, [1, 2, 3, 4, 5], correct), [1, 2, 3, 4, 5]);
  assert.deepEqual(resolveSortableSubmission(BLOCK, [1, 2, 3, 4, 5], [2, 1, 3, 4, 5]), [2, 1, 3, 4, 5], 'older clients still graded');
});

test('media quiz learners no longer receive the explanation before answering', () => {
  const row = toLearnerBlockRow({
    id: BLOCK, block_type: 'la_media_quiz',
    data: { questions: [{ id: 'q1', prompt_html: '<p>?</p>', explanation_html: '<p>Đáp án là A</p>', choices: [{ id: 'a', html: 'A', correct: true }] }] },
  });
  assert.doesNotMatch(JSON.stringify(row), /Đáp án là A|"correct"|explanation_html/);
});

async function submitWith(t: import('node:test').TestContext, block: Record<string, unknown>, body: unknown) {
  const pg = await import('pg');
  t.mock.method(pg.default.Pool.prototype, 'query', async (text: string) => {
    if (text.includes('FROM course_blocks b') && text.includes('b.is_published = true')) return { rows: [{ course_id: 'course-v1:A+1+2026', ...block }], rowCount: 1 };
    if (text.includes('FROM courses c')) return { rows: [{ id: 'course-v1:A+1+2026' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  const { submitBlockAnswer } = await import('./learner.service.js');
  return submitBlockAnswer(BLOCK, 'a0000000-0000-4000-8000-000000000001', 'learner', '11111111-1111-4111-8111-111111111111', body) as Promise<Record<string, unknown>>;
}

const MCQ = `<problem><multiplechoiceresponse><label>2 + 2?</label><choicegroup>
<choice correct="true">4</choice><choice correct="false">5</choice></choicegroup></multiplechoiceresponse>
<solution><p>Vì 2 + 2 = 4.</p></solution></problem>`;

test('a wrong problem answer reveals neither the correct answer nor the explanation', async (t) => {
  const wrong = await submitWith(t, { id: BLOCK, block_type: 'problem', data: MCQ, metadata: {} }, { answers: { olx_mcq_0: 'choice_1' } });
  assert.equal(wrong.status, 'incorrect');
  assert.equal('correct_answers' in wrong, false);
  assert.equal('explanation_html' in wrong, false);
});

test('a correct problem answer returns the correct answer and the explanation', async (t) => {
  const right = await submitWith(t, { id: BLOCK, block_type: 'problem', data: MCQ, metadata: {} }, { answers: { olx_mcq_0: 'choice_0' } });
  assert.equal(right.status, 'correct');
  assert.deepEqual(right.correct_answers, ['4']);
  assert.equal(right.explanation_html, '<p>Vì 2 + 2 = 4.</p>');
});

test('sortable is graded from the opaque ids and never returns the correct order', async (t) => {
  const items = [{ id: 1, text: 'A' }, { id: 2, text: 'B' }, { id: 3, text: 'C' }];
  const block = { id: BLOCK, block_type: 'la_sortable', data: {}, metadata: { sortable_data: { items } } };
  const right = await submitWith(t, block, { answer: items.map((item) => sortableOpaqueItemId(BLOCK, item.id)) });
  assert.equal(right.status, 'correct');
  const wrong = await submitWith(t, block, { answer: [3, 2, 1].map((id) => sortableOpaqueItemId(BLOCK, id)) });
  assert.equal(wrong.status, 'incorrect');
  assert.equal('correct_order' in wrong, false);
});
