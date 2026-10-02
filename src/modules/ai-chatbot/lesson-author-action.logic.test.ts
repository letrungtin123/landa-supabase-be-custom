import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolveLessonAuthorAction } from './lesson-author-action.logic.js';
import { classifyLessonAuthorIntent } from './lesson-author-intent.logic.js';

const id = '11111111-1111-4111-8111-111111111111';
const create = { lesson_author_action: 'GENERATE_COURSE_BLUEPRINT', source_documents: [{ document_id: id }] };
const draft = { lesson_author_action: 'DRAFT_BLUEPRINT_CHAPTER', blueprint_id: id, blueprint_chapter_index: 2 };
const resume = { lesson_author_action: 'CONTINUE_CHAPTER', chapter_resume: { draft_id: id, previous_attempt_id: id } };

test('button action, not display text, controls routing; EN/VI produces a review Blueprint', () => {
  for (const locale of ['vi', 'en']) {
    for (const content of ['tạo nội dung bài học', 'delete everything', '', null]) {
      const action = resolveLessonAuthorAction({ ...create, content, locale }, 'lesson_author')!;
      assert.equal(action.action, 'GENERATE_COURSE_BLUEPRINT');
      assert.equal(action.mode, 'course_blueprint');
      assert.equal(classifyLessonAuthorIntent({ message: action.content, mode: action.mode }).operation, 'course_blueprint');
      assert.ok(!action.content.includes('delete'));
    }
  }
});
test('draft and continuation have exact typed envelopes; no target guessed from text', () => {
  assert.equal(resolveLessonAuthorAction(draft, 'lesson_author')?.content, 'Soạn Chương 3 theo bản thiết kế đã duyệt.');
  assert.equal(resolveLessonAuthorAction({ ...draft, locale: 'en' }, 'lesson_author')?.mode, 'draft_lesson');
  assert.equal(resolveLessonAuthorAction(resume, 'lesson_author')?.action, 'CONTINUE_CHAPTER');
});
test('legacy messages and other bots are unchanged; action cannot be used for other targets', () => {
  assert.equal(resolveLessonAuthorAction({ content: 'hello', mode: 'chat' }, 'admin'), null);
  assert.equal(resolveLessonAuthorAction({ content: 'tạo nội dung bài học' }, 'lesson_author'), null);
  assert.throws(() => resolveLessonAuthorAction(create, 'admin'), /LESSON_AUTHOR_ACTION_INVALID/);
});
test('reject unknown operations, conflicting modes, mentions and voice before any dispatch', () => {
  for (const body of [
    { ...create, lesson_author_action: null }, { ...create, lesson_author_action: 'APPLY' },
    { ...create, mode: 'chat' }, { ...draft, mode: 'course_blueprint' }, { ...resume, mode: 'auto' },
    { ...create, input_mode: 'voice' }, { ...create, outline_mentions: [{ block_id: id }] },
    { ...create, outline_mentions: {} },
  ]) assert.throws(() => resolveLessonAuthorAction(body, 'lesson_author'), /LESSON_AUTHOR_ACTION_INVALID/);
});
test('create requires exactly one canonical source reference and cannot carry a draft/resume target', () => {
  for (const body of [
    { ...create, source_documents: [] }, { ...create, source_documents: [{ document_id: id }, { document_id: id }] },
    { ...create, source_documents: [{}] }, { ...create, source_documents: [{ document_id: 'invalid' }] },
    { ...create, blueprint_id: id }, { ...create, blueprint_chapter_index: 0 }, { ...create, chapter_resume: resume.chapter_resume },
  ]) assert.throws(() => resolveLessonAuthorAction(body, 'lesson_author'));
});
test('draft/resume reject malformed or mixed target contracts', () => {
  for (const body of [
    { ...draft, blueprint_id: 'bad' }, { ...draft, blueprint_chapter_index: -1 },
    { ...draft, blueprint_chapter_index: 12 }, { ...draft, blueprint_chapter_index: '2' },
    { ...draft, chapter_resume: resume.chapter_resume }, { ...resume, blueprint_id: id },
    { ...resume, chapter_resume: {} }, { ...resume, chapter_resume: { ...resume.chapter_resume, other: true } },
  ]) assert.throws(() => resolveLessonAuthorAction(body, 'lesson_author'));
});
test('HTTP wiring resolves action before admission/SSE and existing message owners persist it exactly once', () => {
  const controller = readFileSync(new URL('./chat.controller.ts', import.meta.url), 'utf8');
  const service = readFileSync(new URL('./chat.service.ts', import.meta.url), 'utf8');
  assert.ok(controller.indexOf('resolveLessonAuthorAction(req.body') < controller.indexOf('tryEnqueueDurableBlueprint(conversationId'));
  assert.equal(controller.match(/lessonAuthorAction: buttonAction\?\.action/g)?.length, 2);
  assert.equal(service.match(/lesson_author_action: options.lessonAuthorAction }/g)?.length, 3);
  assert.match(controller, /!checkpointKey \|\| target!=='lesson_author'/);
  assert.match(service, /await validateLessonAuthorSourceDocuments/);
  assert.match(service, /await assertDurableBlueprintActor/);
  assert.match(service, /await validateLessonAuthorEditorContext/);
});
