import assert from 'node:assert/strict';
import test from 'node:test';

// Block answer grading, without the database. The full matrix of block types
// and submissions is pinned by learner-grading.characterization.test.ts.

const { gradeBlockAnswer } = await import('./learner-grading.logic.js');
const { sortableOpaqueItemId } = await import('./learner-answer-key.logic.js');

const block = (block_type: string, data: unknown, metadata: unknown = null) => ({ id: 'b1', block_type, data, metadata });
const CHECKBOX = '<problem><choiceresponse><checkboxgroup><choice correct="true">A</choice><choice correct="true">B</choice><choice correct="false">C</choice></checkboxgroup></choiceresponse><solution><p>AB</p></solution></problem>';

test('a checkbox problem: all correct choices pass, a partial answer scores and hides the answers', () => {
  const right = gradeBlockAnswer(block('problem', CHECKBOX), { answers: { q: ['choice_0', 'choice_1'] } });
  assert.equal(right.status, 'correct');
  assert.equal(right.score, 100);
  assert.deepEqual((right as { correct_answers?: unknown }).correct_answers, ['A', 'B']);

  const partial = gradeBlockAnswer(block('problem', CHECKBOX), { answers: { q: ['choice_0'] } });
  assert.equal(partial.status, 'incorrect');
  assert.equal(partial.score, 50);
  assert.deepEqual(partial.feedback, { code: 'partial_answers', params: { correct: 1, total: 2 } });
  assert.equal('correct_answers' in partial, false, 'answers are disclosed only after a correct answer');
});

test('a media quiz moves to the next question only on a correct answer', () => {
  const data = { questions: [{ id: 'q1', choices: [{ id: 'a', correct: true }, { id: 'b' }] }, { id: 'q2', choices: [{ id: 'c', correct: true }] }] };
  const right = gradeBlockAnswer(block('la_media_quiz', JSON.stringify(data)), { question_id: 'q1', answer: ' a ' });
  assert.equal(right.status, 'correct');
  assert.equal((right as { next_question_id?: unknown }).next_question_id, 'q2');
  const wrong = gradeBlockAnswer(block('la_media_quiz', data), { question_id: 'q1', answer: 'b' });
  assert.equal((wrong as { next_question_id?: unknown }).next_question_id, null);
  assert.deepEqual(gradeBlockAnswer(block('la_media_quiz', data), { question_id: 'q9' }).feedback, { code: 'question_not_found' });
});

test('a sortable block accepts the opaque ids and the stored ids', () => {
  const metadata = { sortable_data: { items: [{ id: 1 }, { id: 2 }, { id: 3 }] } };
  const opaque = [1, 2, 3].map(id => sortableOpaqueItemId('b1', id));
  assert.equal(gradeBlockAnswer(block('la_sortable', null, metadata), { answer: opaque }).status, 'correct');
  assert.equal(gradeBlockAnswer(block('la_sortable', null, metadata), { answer: [1, 2, 3] }).status, 'correct');
  const swapped = gradeBlockAnswer(block('la_sortable', null, metadata), { answer: [opaque[1], opaque[0], opaque[2]] });
  assert.equal(swapped.score, 33);
});

test('malformed content and submissions answer as before', () => {
  assert.deepEqual(gradeBlockAnswer(block('problem', ''), { answers: {} }).feedback, { code: 'content_unavailable' });
  assert.deepEqual(gradeBlockAnswer(block('la_crossword', null, null), { answers: {} }).feedback, { code: 'content_unavailable' });
  assert.equal(gradeBlockAnswer(block('html', null), {}).status, 'ok');
  // A request without a body still fails as it always did (a 500, not a grade).
  assert.throws(() => gradeBlockAnswer(block('problem', CHECKBOX), undefined), TypeError);
});
