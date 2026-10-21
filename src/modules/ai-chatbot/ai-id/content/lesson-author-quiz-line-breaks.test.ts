import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeProblemComponent } from '../legacy/component-normalize.logic.js';
import { editWorkspaceComponent, hydrateWorkspaceComponent, workspaceComponentContent, workspaceComponentStorage } from './lesson-author-workspace-component.logic.js';
import { decodeWorkspaceProblem, encodeWorkspaceProblem } from './lesson-author-workspace-problem.logic.js';
import { validateLessonAuthorSingleChoiceProblem } from './lesson-author-content-contract.logic.js';
import { assertAiGeneratedComponentValid } from './lesson-author-component-registry.logic.js';
import { problemExplanationHtml, toLearnerProblemOlx } from '../../../learner/learner-answer-key.logic.js';
import { toLearnerBlockRow } from '../../../learner/learner-block-row.logic.js';
import { gradeBlockAnswer } from '../../../learner/learner-grading.logic.js';
import type { LessonAuthorComponentProposal } from '../../../course-authoring/course-authoring.service.js';
import type { CourseComponentType } from '../../../tenants/tenant-course-components.constants.js';

// K1 (QC A2, B1, B2): the MCQ `question` and `explanation` are plain text that may contain line feeds; a
// question line starting with "- " is a list item, the explanation has the principle then one
// "A - …" line per option. Every backend layer keeps each \n byte for byte: the generation normaliser,
// the workspace problem codec, an author edit, the Apply step (editWorkspaceComponent, then the jsonb
// write), the learner block payload and the graded answer's explanation. The text stays XML-escaped
// plain text inside <label> and <solution><div class="detailed-solution"><p>; no markup is added.

const QUESTION = 'Một nhân viên mới nhận ba việc cùng lúc:\n- Gửi báo cáo tuần trước 17 giờ\n- Trả lời khách hàng đang chờ\n'
  + '- Chuẩn bị họp sáng mai\nTheo bài học, việc nào cần làm trước tiên?';
const EXPLANATION = 'Nguyên tắc: việc gấp và có người đang chờ được làm trước.\nA - Đúng vì khách hàng đang chờ phản hồi.\n'
  + 'B - Sai vì báo cáo còn thời hạn đến 17 giờ.\nC - Sai vì cuộc họp diễn ra vào sáng mai.\nD - Sai vì bỏ qua người đang chờ.';
const CHOICES = [
  { text: 'Trả lời khách hàng đang chờ', correct: true },
  { text: 'Gửi báo cáo tuần trước hạn', correct: false },
  { text: 'Chuẩn bị nội dung cho cuộc họp', correct: false },
  { text: 'Đợi quản lý phân công lại việc', correct: false },
];
const allowed = new Set<CourseComponentType>(['html', 'problem']);
const metadata = { component_plan_id: 'component_1', source_fact_ids: ['fact_1'], covered_source_fact_ids: ['fact_1'],
  supporting_evidence_fact_ids: [], learning_objective_refs: ['lo_1'], generated_by: 'lesson_author_ai' };
const escapeXml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

function generated(): LessonAuthorComponentProposal {
  const component = normalizeProblemComponent({ type: 'problem', problem_type: 'multiple_choice', title: 'Kiểm tra',
    question: `  ${QUESTION}\n`, explanation: `${EXPLANATION}\n\n`, choices: CHOICES }, 'Câu hỏi');
  return { ...component, metadata: structuredClone(metadata) };
}

test('the generation normaliser keeps every line of the question and the explanation (ends trimmed only)', () => {
  const component = generated();
  const xml = component.data as string;
  assert.ok(xml.includes(`<label>${escapeXml(QUESTION)}</label>`));
  assert.ok(xml.includes(`<solution><div class="detailed-solution"><p>${escapeXml(EXPLANATION)}</p></div></solution>`));
  assert.equal(/<(?:br|ul|li|strong|b)\b/i.test(xml), false, 'no markup is added for the lines');
  // The AI ID content contract and the generated-component gate accept the multi-line problem.
  assert.equal(validateLessonAuthorSingleChoiceProblem(xml), null);
  assert.doesNotThrow(() => assertAiGeneratedComponentValid(component, allowed));
  const decoded = decodeWorkspaceProblem(xml);
  assert.equal(decoded.question, QUESTION);
  assert.equal(decoded.explanation, EXPLANATION);
});

test('the workspace codec, its stored baseline and an author edit keep the line feeds', () => {
  const original = generated();
  const content = workspaceComponentContent(original, allowed);
  const data = content.data as { question: string; explanation: string };
  assert.equal(data.question, QUESTION);
  assert.equal(data.explanation, EXPLANATION);
  // The stored baseline rehydrates to the same text (workspace read / node detail).
  const stored = workspaceComponentStorage(original, allowed);
  assert.deepEqual(workspaceComponentContent(hydrateWorkspaceComponent(stored.binding, stored.content, allowed), allowed).data,
    content.data);
  // Author edit: add a list line and reorder the explanation lines; nothing is collapsed or trimmed inside.
  const editedQuestion = QUESTION.replace('\n- Chuẩn bị', '\n- Gọi lại cho đồng nghiệp\n- Chuẩn bị');
  const editedExplanation = `${EXPLANATION}\n\nGhi nhớ: hỏi lại khi chưa rõ ưu tiên.`;
  const edited = editWorkspaceComponent(original, { ...content, data: { ...content.data as object,
    question: editedQuestion, explanation: editedExplanation } }, allowed);
  const back = decodeWorkspaceProblem(edited.data);
  assert.equal(back.question, editedQuestion);
  assert.equal(back.explanation, editedExplanation);
  assert.equal(encodeWorkspaceProblem(back), edited.data, 'the encoded XML is stable');
});

test('Apply, the learner payload and the graded explanation keep the line feeds', () => {
  const original = generated();
  const content = workspaceComponentContent(original, allowed);
  // Apply compiles the current revision with editWorkspaceComponent (lesson-author-orchestration-v2-apply.logic.ts)
  // and writes component.data with JSON.stringify into course_blocks.data (jsonb); publishing copies it.
  const applied = editWorkspaceComponent(original, { ...content, title: 'Kiểm tra nhanh' }, allowed);
  const published = JSON.parse(JSON.stringify(applied.data)) as string;
  assert.equal(published, original.data);

  const row = toLearnerBlockRow({ id: 'b1', block_type: 'problem', data: published, metadata: {} });
  const learnerOlx = row.data as string;
  assert.equal(learnerOlx, toLearnerProblemOlx(published));
  assert.ok(learnerOlx.includes(`<label>${escapeXml(QUESTION)}</label>`), 'the learner receives the question lines unchanged');
  assert.equal(/<solution|correct=/.test(learnerOlx), false, 'never the answer key or the explanation before answering');

  assert.equal(problemExplanationHtml(published), `<p>${escapeXml(EXPLANATION)}</p>`);
  const right = gradeBlockAnswer({ id: 'b1', block_type: 'problem', data: published, metadata: {} }, { answers: { q: 'choice_0' } });
  assert.equal(right.status, 'correct');
  assert.equal((right as { explanation_html?: string }).explanation_html, `<p>${escapeXml(EXPLANATION)}</p>`);
  const wrong = gradeBlockAnswer({ id: 'b1', block_type: 'problem', data: published, metadata: {} }, { answers: { q: 'choice_1' } });
  assert.equal(wrong.status, 'incorrect');
  assert.equal('explanation_html' in wrong, false);
});

test('an old single-line quiz is unchanged by the same path', () => {
  const component = normalizeProblemComponent({ type: 'problem', problem_type: 'multiple_choice', title: 'Cũ',
    question: 'Việc nào cần làm trước tiên khi khách hàng đang chờ?', explanation: 'Khách hàng đang chờ nên cần trả lời trước.',
    choices: CHOICES }, 'Câu hỏi');
  const decoded = decodeWorkspaceProblem(component.data);
  assert.equal(decoded.question, 'Việc nào cần làm trước tiên khi khách hàng đang chờ?');
  assert.equal(problemExplanationHtml(component.data as string), '<p>Khách hàng đang chờ nên cần trả lời trước.</p>');
});
