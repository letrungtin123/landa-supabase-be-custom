import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyLessonAuthorIntent } from './lesson-author-intent.logic.js';
import {
  buildNormalizedLessonAuthorCommand,
  isSimpleDeterministicLessonAuthorCommand,
  normalizeLessonAuthorEditorContext,
  selectEditorContextTarget,
  validateResolvedLessonAuthorEditorContext,
  type ResolvedLessonAuthorEditorEntity,
} from './lesson-author-command.logic.js';

const COURSE_ID = '11111111-1111-4111-8111-111111111111';
const CHAPTER_ID = '22222222-2222-4222-8222-222222222222';
const LESSON_ID = '33333333-3333-4333-8333-333333333333';
const UNIT_ID = '44444444-4444-4444-8444-444444444444';
const COMPONENT_ID = '55555555-5555-4555-8555-555555555555';
const OTHER_UNIT_ID = '66666666-6666-4666-8666-666666666666';
const COURSE_KEY = 'course-v1:nesso+06786+2026';

function resolvedEntities(): Map<string, ResolvedLessonAuthorEditorEntity> {
  return new Map([
    [CHAPTER_ID, { id: CHAPTER_ID, type: 'chapter', parent_id: 'course-block', ancestor_ids: ['course-block'] }],
    [LESSON_ID, { id: LESSON_ID, type: 'lesson', parent_id: CHAPTER_ID, ancestor_ids: ['course-block', CHAPTER_ID] }],
    [UNIT_ID, { id: UNIT_ID, type: 'unit', parent_id: LESSON_ID, ancestor_ids: ['course-block', CHAPTER_ID, LESSON_ID] }],
    [COMPONENT_ID, { id: COMPONENT_ID, type: 'component', parent_id: UNIT_ID, ancestor_ids: ['course-block', CHAPTER_ID, LESSON_ID, UNIT_ID] }],
    [OTHER_UNIT_ID, { id: OTHER_UNIT_ID, type: 'unit', parent_id: LESSON_ID, ancestor_ids: ['course-block', CHAPTER_ID, LESSON_ID] }],
  ]);
}

function componentEditorContext() {
  return normalizeLessonAuthorEditorContext({
    course_id: COURSE_ID,
    selected_entity: { id: COMPONENT_ID, type: 'component', block_type: 'html' },
    current_chapter_id: CHAPTER_ID,
    current_lesson_id: LESSON_ID,
    current_unit_id: UNIT_ID,
    current_component_id: COMPONENT_ID,
  })!;
}

test('uses validated selected component for a deictic rewrite request', () => {
  const context = validateResolvedLessonAuthorEditorContext(componentEditorContext(), COURSE_ID, resolvedEntities());
  const preliminary = classifyLessonAuthorIntent({ message: 'Sửa component này dễ hiểu hơn' });
  const selected = selectEditorContextTarget('Sửa component này dễ hiểu hơn', preliminary, context, false);

  assert.deepEqual(selected, { id: COMPONENT_ID, type: 'component' });

  const plan = classifyLessonAuthorIntent({
    message: 'Sửa component này dễ hiểu hơn',
    mention: { block_id: COMPONENT_ID, block_type: 'html' },
    mentionSource: 'editor_context',
  });
  const command = buildNormalizedLessonAuthorCommand({
    plan: { ...plan, target_block_id: COMPONENT_ID, target_resolution: 'existing' },
    userInstruction: 'Sửa component này dễ hiểu hơn',
    sourceDocumentIds: [],
  });

  assert.equal(plan.target_source, 'editor_context');
  assert.equal(command.intent, 'UPDATE_CONTENT');
  assert.equal(command.target.id, COMPONENT_ID);
  assert.equal(command.scope, 'CURRENT_ENTITY');
  assert.equal(command.source_mode, 'NONE');
  assert.equal(isSimpleDeterministicLessonAuthorCommand(command), false);
});

test('explicit @mention takes priority over passive editor context', () => {
  const context = validateResolvedLessonAuthorEditorContext(componentEditorContext(), COURSE_ID, resolvedEntities());
  const preliminary = classifyLessonAuthorIntent({ message: 'Sửa component này' });

  assert.equal(
    selectEditorContextTarget('Sửa component này', preliminary, context, true),
    null,
  );
});

test('an explicit numbered target does not get replaced by passive editor context', () => {
  const context = validateResolvedLessonAuthorEditorContext(componentEditorContext(), COURSE_ID, resolvedEntities());
  const preliminary = classifyLessonAuthorIntent({ message: 'Đổi tên Chương 2 thành An toàn lao động' });

  assert.equal(
    selectEditorContextTarget('Đổi tên Chương 2 thành An toàn lao động', preliminary, context, false),
    null,
  );
});

test('rejects cross-course and invalid hierarchy editor context before routing', () => {
  const crossCourse = normalizeLessonAuthorEditorContext({
    ...componentEditorContext(),
    course_id: '77777777-7777-4777-8777-777777777777',
  })!;
  assert.throws(
    () => validateResolvedLessonAuthorEditorContext(crossCourse, COURSE_ID, resolvedEntities()),
    /không thuộc khóa học/i,
  );

  const invalidHierarchy = normalizeLessonAuthorEditorContext({
    ...componentEditorContext(),
    current_unit_id: OTHER_UNIT_ID,
  })!;
  assert.throws(
    () => validateResolvedLessonAuthorEditorContext(invalidHierarchy, COURSE_ID, resolvedEntities()),
    /quan hệ phân cấp/i,
  );
});

test('keeps rename deterministic, proposal-first, and independent of source retrieval', () => {
  const plan = classifyLessonAuthorIntent({
    message: 'Đổi tên component này thành Nội dung dễ hiểu hơn',
    mention: { block_id: COMPONENT_ID, block_type: 'html' },
    mentionSource: 'editor_context',
  });
  const command = buildNormalizedLessonAuthorCommand({
    plan: { ...plan, target_block_id: COMPONENT_ID, target_resolution: 'existing' },
    userInstruction: 'Đổi tên component này thành Nội dung dễ hiểu hơn',
    sourceDocumentIds: [],
  });

  assert.equal(command.intent, 'RENAME');
  assert.equal(command.source_mode, 'NONE');
  assert.equal(isSimpleDeterministicLessonAuthorCommand(command), true);
  assert.equal(command.clarification_required, false);
});

test('keeps old clients valid when editor_context is omitted', () => {
  assert.equal(normalizeLessonAuthorEditorContext(undefined), null);
  const plan = classifyLessonAuthorIntent({
    message: 'Sửa nội dung Chương 3',
    mention: { block_id: CHAPTER_ID, block_type: 'chapter' },
    mentionSource: 'current',
  });
  assert.equal(plan.target_source, 'mention');
  assert.equal(plan.target_type, 'chapter');
});

test('accepts the canonical backend course key while keeping hierarchy IDs UUID-only', () => {
  assert.deepEqual(
    normalizeLessonAuthorEditorContext({ course_id: COURSE_KEY }),
    { course_id: COURSE_KEY },
  );

  const context = normalizeLessonAuthorEditorContext({
    course_id: COURSE_KEY,
    current_chapter_id: CHAPTER_ID,
  })!;
  assert.equal(context.current_chapter_id, CHAPTER_ID);
  assert.throws(
    () => normalizeLessonAuthorEditorContext({
      course_id: COURSE_KEY,
      current_chapter_id: 'chapter-1',
    }),
    /current_chapter_id không hợp lệ/i,
  );
});

test('rejects malformed course identifiers and preserves exact conversation-course matching', () => {
  assert.throws(
    () => normalizeLessonAuthorEditorContext({ course_id: 'not-a-course-id' }),
    /editor_context\.course_id không hợp lệ/i,
  );
  assert.throws(
    () => normalizeLessonAuthorEditorContext({ course_id: 'course-v1:nesso+only-one-part' }),
    /editor_context\.course_id không hợp lệ/i,
  );

  const context = normalizeLessonAuthorEditorContext({ course_id: COURSE_KEY })!;
  assert.throws(
    () => validateResolvedLessonAuthorEditorContext(
      context,
      'course-v1:other+06786+2026',
      new Map(),
    ),
    /không thuộc khóa học/i,
  );
});
