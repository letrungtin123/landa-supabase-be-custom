import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { buildNormalizedLessonAuthorCommand } from './lesson-author-command.logic.js';
import {
  buildLessonAuthorCreationContext,
  classifyLessonAuthorIntent,
  detectLessonAuthorInputLocale,
  extractLessonAuthorTargetNumberPath,
  extractRequestedTitle,
  formatChapterTitle,
  isLessonAuthorNewChapterDraftRequest,
  matchesLessonAuthorBlueprintChapterDraft,
  resolveLessonAuthorOutputLocale,
  resolveLessonAuthorDraftLocale,
  stripLessonAuthorSourceRangeSuffix,
} from './lesson-author-intent.logic.js';

const attachedCreationContext = buildLessonAuthorCreationContext({
  sourceDocuments: [{ document_id: '825c18ff-d1b2-42e6-b87b-3096426db3b5' }],
}, null);

test('latest UAT generic learning-content request with current source enters review-only FULL_SOURCE Blueprint', () => {
  for (const message of ['tạo nội dung bài học', 'Soạn bài học', 'Hãy tạo học liệu.',
    'Tạo nội dung bài học từ file đã chọn', 'Soạn bài học dựa trên tài liệu đính kèm',
    'Create lesson content', 'Please generate learning materials from the attached document']) {
    const plan = classifyLessonAuthorIntent({ message, mode: 'auto', creationContext: attachedCreationContext });
    assert.equal(plan.operation, 'course_blueprint', message);
    assert.equal(plan.target_type, 'course');
    assert.equal(plan.target_source, 'none');
    assert.ok(plan.signals.includes('source_attached_learning_create'));
    const command = buildNormalizedLessonAuthorCommand({ plan, userInstruction: message, sourceDocumentIds: ['source'] });
    assert.equal(command.intent, 'GENERATE_COURSE');
    assert.equal(command.scope, 'FULL_COURSE');
    assert.equal(command.source_mode, 'FULL_SOURCE');
  }
});

test('creation context uses only current-turn source hints; missing/empty hints retain legacy target resolution', () => {
  for (const options of [{}, { sourceDocuments: [] }, { sourceDocuments: [{}] }, { sourceDocuments: [{ document_id: ' ' }] }]) {
    const creationContext = buildLessonAuthorCreationContext(options, null);
    assert.equal(creationContext.hasCurrentSourceDocuments, false);
    const input = { message: 'tạo nội dung bài học' };
    assert.deepEqual(classifyLessonAuthorIntent({ ...input, creationContext }), classifyLessonAuthorIntent(input));
  }
  // Presence is a hint, not permission: validation remains downstream in both paths.
  assert.equal(buildLessonAuthorCreationContext({ sourceDocuments: [{ document_id: 'not-authorized' }] }, null).hasCurrentSourceDocuments, true);
});

test('course-root editor permits generic source creation; every non-course editor boundary blocks promotion', () => {
  const source = { sourceDocuments: [{ document_id: 'source' }] };
  const root = { course_id: 'course', selected_entity: { id: 'course', type: 'course' as const } };
  const input = { message: 'tạo nội dung bài học' };
  assert.equal(classifyLessonAuthorIntent({ ...input, creationContext: buildLessonAuthorCreationContext(source, root) }).operation, 'course_blueprint');
  for (const editor of [
    { course_id: 'course', current_chapter_id: 'chapter' },
    { course_id: 'course', current_lesson_id: 'lesson' },
    { course_id: 'course', current_unit_id: 'unit' },
    { course_id: 'course', current_component_id: 'component' },
    { course_id: 'course', selected_entity: { id: 'unit', type: 'unit' as const } },
  ]) {
    const creationContext = buildLessonAuthorCreationContext(source, editor);
    assert.equal(creationContext.hasEditorNode, true);
    assert.deepEqual(classifyLessonAuthorIntent({ ...input, creationContext }), classifyLessonAuthorIntent(input));
  }
});

test('explicit/carried/editor targets, Blueprint drafts and forced modes are never widened by current sources', () => {
  for (const mentionSource of ['current', 'editor_context', 'carried_forward'] as const) {
    const input = { message: 'tạo nội dung bài học', mention: { block_id: 'unit', block_type: 'vertical' }, mentionSource };
    assert.deepEqual(classifyLessonAuthorIntent({ ...input, creationContext: attachedCreationContext }), classifyLessonAuthorIntent(input));
  }
  const carried = { message: 'tạo nội dung bài học', carriedTarget: true };
  assert.deepEqual(classifyLessonAuthorIntent({ ...carried, creationContext: attachedCreationContext }), classifyLessonAuthorIntent(carried));
  for (const mode of ['chat', 'draft_lesson', 'course_blueprint'] as const) {
    const input = { message: 'tạo nội dung bài học', mode };
    assert.deepEqual(classifyLessonAuthorIntent({ ...input, creationContext: attachedCreationContext }), classifyLessonAuthorIntent(input));
  }
  const blueprintContext = buildLessonAuthorCreationContext({ sourceDocuments: [{ document_id: 'source' }], blueprintId: 'blueprint' }, null);
  assert.notEqual(classifyLessonAuthorIntent({ message: 'tạo nội dung bài học', creationContext: blueprintContext }).operation, 'course_blueprint');
});

test('source hint never promotes named/numbered/deictic targets, edits, negations, compound commands or chat', () => {
  for (const message of ['Tạo nội dung bài học 2', 'Tạo nội dung bài học An toàn', 'Soạn bài học này',
    'Create lesson content for lesson 2', 'Create lesson content for this lesson', 'Create lesson content about safety',
    'Sửa nội dung bài học', 'Đổi tên bài học', 'Xóa bài học', 'Di chuyển bài học',
    'Không tạo nội dung bài học', 'Đừng soạn bài học', 'Do not create lesson content',
    'Tạo nội dung bài học và xóa chương 1', 'Tạo nội dung bài học?', 'Tạo nội dung bài học như thế nào?',
    'ok cảm ơn bạn', 'Giải thích tài liệu này', 'Soạn chi tiết Chương 3: An toàn']) {
    const baseline = classifyLessonAuthorIntent({ message });
    const actual = classifyLessonAuthorIntent({ message, creationContext: attachedCreationContext });
    assert.deepEqual(actual, baseline, message);
    assert.notEqual(actual.operation, 'course_blueprint', message);
  }
});

test('durable admission and all stream classifications share creation context without bypassing source validation', () => {
  const source = readFileSync(new URL('./chat.service.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('chat.service.ts', source, ts.ScriptTarget.Latest, true);
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'classifyLessonAuthorIntentV2') calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.equal(calls.length, 4);
  for (const call of calls) assert.equal(call.arguments[4]?.getText(ast), 'creationContext');
  assert.ok(source.includes('buildLessonAuthorCreationContext(options, editor?.context)'));
  assert.ok(source.includes('buildLessonAuthorCreationContext(options, validatedEditorContext?.context)'));
  const admission = source.slice(source.indexOf('export async function prepareDurableBlueprint('), source.indexOf('function classifyLessonAuthorIntentV2('));
  const classification = admission.indexOf('const classified = classifyLessonAuthorIntentV2');
  const validation = admission.indexOf('await validateLessonAuthorSourceDocuments');
  assert.ok(classification > 0 && validation > classification);
  assert.ok(admission.includes("if (!sources.length) throw new AppError('Vui lòng chọn tài liệu nguồn đã học.'"));
  assert.ok(admission.indexOf('await validateLessonAuthorEditorContext') < classification);
});

test('approved Blueprint locale survives UI and draft-button language changes without changing explicit precedence', () => {
  assert.equal(resolveLessonAuthorDraftLocale('Draft the first chapter', 'en', 'vi'), 'vi');
  assert.equal(resolveLessonAuthorDraftLocale('Soạn chương đầu tiên', 'vi', 'en'), 'en');
  assert.equal(resolveLessonAuthorDraftLocale('Soạn chương bằng tiếng Anh', 'vi', 'vi'), 'en');
  assert.equal(resolveLessonAuthorDraftLocale('Write in Vietnamese', 'en', 'en'), 'vi');
  assert.equal(resolveLessonAuthorDraftLocale('Draft the chapter', 'vi'), 'en');
  assert.equal(resolveLessonAuthorDraftLocale('Soạn chương đầu tiên', 'en', null), 'vi');
  assert.equal(resolveLessonAuthorDraftLocale('OK', 'en', 'unknown'), 'en');
  assert.equal(resolveLessonAuthorDraftLocale('OK', 'vi', 'en'), 'en');
});

test('routes an edit request to content update instead of course creation', () => {
  const plan = classifyLessonAuthorIntent({
    message: 'Sửa nội dung Chương 3, bổ sung phần thực hành nhận diện mối nguy.',
  });

  assert.equal(plan.operation, 'update_content');
  assert.equal(plan.target_type, 'chapter');
  assert.equal(plan.requires_confirmation, false);
});

test('distinguishes title rename from content update', () => {
  const plan = classifyLessonAuthorIntent({
    message: 'Đổi tên Bài 3.1 thành Nhận diện mối nguy trong nhà máy',
  });

  assert.equal(plan.operation, 'rename');
  assert.equal(plan.target_type, 'lesson');
  assert.equal(plan.requested_title, 'Nhận diện mối nguy trong nhà máy');
});

test('routes a chapter title-format request to a guarded rename strategy', () => {
  const plan = classifyLessonAuthorIntent({
    message: 'Chỉnh format tiêu đề của chương này cho giống tiêu đề của các chương khác hiện tại',
    mention: {
      block_id: 'chapter-id',
      block_type: 'chapter',
      display_name: 'Quy định an toàn lao động và bảo vệ môi trường trong sản xuất (từ slide 30 đến slide 32 )',
    },
  });

  assert.equal(plan.operation, 'rename');
  assert.equal(plan.target_type, 'chapter');
  assert.equal(plan.requested_title, null);
  assert.equal(plan.title_strategy, 'prefix_chapter_number');
  assert.ok(plan.signals.includes('title_format_signal'));
});

test('formats a chapter title without duplicating an existing prefix', () => {
  assert.equal(
    formatChapterTitle('Quy định an toàn lao động và bảo vệ môi trường trong sản xuất (từ slide 30 đến slide 32 )', '6'),
    'Chương 6: Quy định an toàn lao động và bảo vệ môi trường trong sản xuất',
  );
  assert.equal(formatChapterTitle('Chương 6: An toàn lao động', '6'), 'Chương 6: An toàn lao động');
});

test('strips only trailing source slide/page ranges from structural titles', () => {
  assert.equal(
    stripLessonAuthorSourceRangeSuffix('Quy trình ứng phó (từ slide 30 đến slide 32 )'),
    'Quy trình ứng phó',
  );
  assert.equal(
    stripLessonAuthorSourceRangeSuffix('Emergency response (from page 3 to page 5)'),
    'Emergency response',
  );
  assert.equal(
    stripLessonAuthorSourceRangeSuffix('An toàn (góc nhìn người mới)'),
    'An toàn (góc nhìn người mới)',
  );
  assert.equal(
    stripLessonAuthorSourceRangeSuffix('(từ slide 30 đến slide 32)'),
    '',
  );
});

test('asks for clarification when a rename has no new title', () => {
  const plan = classifyLessonAuthorIntent({
    message: 'Sửa tiêu đề Chương 2',
  });

  assert.equal(plan.operation, 'clarify');
  assert.ok(plan.ambiguity_reasons.some(reason => reason.includes('tên tiêu đề mới')));
});

test('creates a guarded delete plan instead of treating delete as chat', () => {
  const plan = classifyLessonAuthorIntent({
    message: 'Xóa Chương 4 khỏi khóa học',
  });

  assert.equal(plan.operation, 'delete');
  assert.equal(plan.target_type, 'chapter');
  assert.equal(plan.requires_confirmation, true);
});

test('asks for a target before destructive operations', () => {
  const plan = classifyLessonAuthorIntent({ message: 'Xóa phần này đi' });

  assert.equal(plan.operation, 'clarify');
  assert.equal(plan.requires_confirmation, false);
});

test('does not let a forced drafting mode bypass a delete request', () => {
  const plan = classifyLessonAuthorIntent({
    message: 'Xóa node này',
    mode: 'draft_lesson',
    mention: { block_id: 'block-id', block_type: 'chapter', display_name: 'Chương 1' },
  });

  assert.equal(plan.operation, 'clarify');
  assert.equal(plan.requires_confirmation, false);
});

test('keeps explicit whole-course creation as a blueprint', () => {
  const plan = classifyLessonAuthorIntent({
    message: 'Tạo bản thiết kế khóa học đầy đủ từ tài liệu nguồn',
  });

  assert.equal(plan.operation, 'course_blueprint');
  assert.equal(plan.target_type, 'course');
});

test('routes a detailed whole-course request to the blueprint branch before content updates', () => {
  const plan = classifyLessonAuthorIntent({
    message: 'Hãy tạo chi tiết và chuyên sâu nội dung khoá học của toàn bộ khoá học này, file pdf tao đã cung cấp chình là nguồn sự thật',
    mode: 'auto',
  });

  assert.equal(plan.operation, 'course_blueprint');
  assert.equal(plan.target_type, 'course');
  assert.deepEqual(plan.signals, ['create_verb', 'course_scope']);
});

test('routes an English full-course authoring request to the blueprint branch', () => {
  const plan = classifyLessonAuthorIntent({
    message: 'Please create detailed and in-depth content for the entire course. The docx file I provided should be treated as the single source of truth.',
    mode: 'auto',
  });

  assert.equal(plan.operation, 'course_blueprint');
  assert.equal(plan.target_type, 'course');
  assert.equal(plan.confidence, 0.96);
});

test('routes a detailed course request to a blueprint without requiring whole-course wording', () => {
  const vietnamese = classifyLessonAuthorIntent({
    message: 'Hãy tạo nội dung chi tiết cho khóa học này',
    mode: 'auto',
  });
  const english = classifyLessonAuthorIntent({
    message: 'Please create detailed content for this course.',
    mode: 'auto',
  });

  assert.equal(vietnamese.operation, 'course_blueprint');
  assert.equal(english.operation, 'course_blueprint');
  assert.equal(vietnamese.target_type, 'course');
  assert.equal(english.target_type, 'course');
});

test('keeps a whole-course edit request out of the blueprint branch', () => {
  const plan = classifyLessonAuthorIntent({
    message: 'Chỉnh sửa nội dung toàn bộ khóa học',
    mode: 'auto',
  });

  assert.equal(plan.operation, 'clarify');
  assert.equal(plan.target_type, 'course');
  assert.ok(plan.ambiguity_reasons.some(reason => reason.includes('Chương')));
});

test('does not turn an unspecific course-content request into a new chapter', () => {
  const plan = classifyLessonAuthorIntent({
    message: 'Tạo nội dung chi tiết',
    mention: { block_id: 'course-id', block_type: 'course', display_name: 'Khóa học' },
  });

  assert.equal(plan.operation, 'clarify');
  assert.equal(plan.target_type, 'course');
});

test('routes explicit course creation without requiring depth adjectives', () => {
  for (const message of [
    'Tạo nội dung cho khóa học',
    'Tạo nội dung khoá học',
    'Soạn khóa học từ file này',
    'Create course content',
    'Build a course from this PDF',
  ]) {
    const plan = classifyLessonAuthorIntent({ message, mode: 'auto' });
    assert.equal(plan.operation, 'course_blueprint', message);
    assert.equal(plan.target_type, 'course', message);
    assert.ok(plan.signals.includes('explicit_course_create'), message);
  }
});

test('does not widen an artifact request or a selected-node request into a course blueprint', () => {
  const quiz = classifyLessonAuthorIntent({ message: 'Tạo quiz cho khóa học' });
  assert.notEqual(quiz.operation, 'course_blueprint');
  assert.equal(quiz.target_type, 'component');

  const selected = classifyLessonAuthorIntent({
    message: 'Tạo nội dung khóa học cho chương này',
    mention: { block_id: 'chapter-id', block_type: 'chapter', display_name: 'Chương hiện tại' },
    mentionSource: 'editor_context',
  });
  assert.notEqual(selected.operation, 'course_blueprint');
  assert.equal(selected.target_type, 'chapter');
});

test('does not treat an ordinary question as a mutation', () => {
  const plan = classifyLessonAuthorIntent({
    message: 'Mục tiêu của Chương 2 là gì?',
  });

  assert.equal(plan.operation, 'answer');
});

test('extracts English rename titles', () => {
  assert.equal(
    extractRequestedTitle('Rename lesson 3.1 to Emergency response basics'),
    'Emergency response basics',
  );
});

test('extracts Vietnamese titles from đặt tên and tiêu đề syntax', () => {
  assert.equal(
    extractRequestedTitle('Đặt tên Chương 2 là Nhận diện mối nguy'),
    'Nhận diện mối nguy',
  );
  assert.equal(
    extractRequestedTitle('Sửa tiêu đề Chương 2: Nhận diện mối nguy'),
    'Nhận diện mối nguy',
  );
  assert.equal(
    extractRequestedTitle('Đổi tên Chương 6 thành Quy định an toàn (từ slide 30 đến slide 32)'),
    'Quy định an toàn',
  );
  assert.equal(
    extractRequestedTitle('Rename Chapter 6 to Chapter 6: Workplace safety'),
    'Workplace safety',
  );
  assert.equal(extractRequestedTitle('Tiêu đề Chương 2 là gì?'), null);
  assert.equal(extractRequestedTitle('Đổi tên Bài 3.1 là gì?'), null);
});

test('maps user-facing outline levels to the internal sequential and vertical types', () => {
  assert.equal(
    classifyLessonAuthorIntent({ message: 'Sửa nội dung Mục 2.1' }).target_type,
    'lesson',
  );
  assert.equal(
    classifyLessonAuthorIntent({ message: 'Sửa nội dung Bài học 2.1.1' }).target_type,
    'unit',
  );
  assert.equal(
    classifyLessonAuthorIntent({ message: 'Update Section 2.1 content' }).target_type,
    'lesson',
  );
  assert.equal(
    classifyLessonAuthorIntent({ message: 'Update Lesson 2.1.1 content' }).target_type,
    'unit',
  );
});

test('does not guess when one request contains multiple mutations', () => {
  const plan = classifyLessonAuthorIntent({
    message: 'Đổi tên Chương 2 và sửa nội dung Chương 2',
  });

  assert.equal(plan.operation, 'clarify');
  assert.ok(plan.ambiguity_reasons.some(reason => reason.includes('nhiều thao tác')));
});

test('keeps an explicit current mention distinct from a carried conversation target', () => {
  const current = classifyLessonAuthorIntent({
    message: 'Sửa nội dung này',
    mention: { block_id: 'current', block_type: 'chapter' },
    mentionSource: 'current',
  });
  const carried = classifyLessonAuthorIntent({
    message: 'Sửa tiếp nội dung này',
    mention: { block_id: 'carried', block_type: 'chapter' },
    mentionSource: 'carried_forward',
  });

  assert.equal(current.target_source, 'mention');
  assert.equal(carried.target_source, 'conversation_context');
});

test('detects Vietnamese, English and mixed authoring commands', () => {
  assert.equal(detectLessonAuthorInputLocale('Đổi tên Chương 6'), 'vi');
  assert.equal(detectLessonAuthorInputLocale('Rename Chapter 6'), 'en');
  assert.equal(detectLessonAuthorInputLocale('Đổi tên Chapter 6'), 'mixed');
  assert.equal(
    detectLessonAuthorInputLocale('Please create detailed and in-depth content for the entire course.'),
    'en',
  );
});

test('uses message language or an explicit instruction before dashboard locale', () => {
  assert.equal(
    resolveLessonAuthorOutputLocale('Please create detailed content for the entire course.', 'vi'),
    'en',
  );
  assert.equal(
    resolveLessonAuthorOutputLocale('Soạn chi tiết nội dung khóa học bằng tiếng Anh.', 'vi'),
    'en',
  );
  assert.equal(
    resolveLessonAuthorOutputLocale('Create a diagram', 'vi'),
    'en',
  );
});

test('recognizes guarded new-chapter drafting without treating edits as creation', () => {
  assert.equal(isLessonAuthorNewChapterDraftRequest('Soạn chi tiết Chương 3'), true);
  assert.equal(isLessonAuthorNewChapterDraftRequest('Draft Chapter 3'), true);
  assert.equal(isLessonAuthorNewChapterDraftRequest('Sửa nội dung Chương 3'), false);
  assert.equal(isLessonAuthorNewChapterDraftRequest('Đổi tên Chương 3 thành An toàn'), false);

  const detailedDraft = classifyLessonAuthorIntent({
    message: 'Soạn chi tiết Chương 3: Thực hành Nhận diện mối nguy, Đánh giá rủi ro, Lựa chọn và sử dụng PPE phù hợp',
  });
  assert.equal(detailedDraft.operation, 'update_content');
  assert.equal(detailedDraft.target_type, 'chapter');

  const twoChapterDraft = classifyLessonAuthorIntent({
    message: 'Soạn Chương 3 và tạo Chương 4',
  });
  assert.equal(twoChapterDraft.operation, 'clarify');
});

test('extracts structural target number paths for Vietnamese and English labels', () => {
  assert.equal(extractLessonAuthorTargetNumberPath('Soạn Chương 3', 'chapter'), '3');
  assert.equal(extractLessonAuthorTargetNumberPath('Update Section 2.1', 'lesson'), '2.1');
  assert.equal(extractLessonAuthorTargetNumberPath('Draft Lesson 2.1.1', 'unit'), '2.1.1');
  assert.equal(extractLessonAuthorTargetNumberPath('Tạo nội dung', 'chapter'), null);
});

test('matches only an explicit manual draft for the approved Blueprint chapter', () => {
  const chapterTitle = 'Nhận diện mối nguy và đánh giá rủi ro';
  assert.equal(
    matchesLessonAuthorBlueprintChapterDraft(
      'Soạn chi tiết Chương 2: Nhận diện mối nguy và đánh giá rủi ro đi',
      1,
      chapterTitle,
    ),
    true,
  );
  assert.equal(matchesLessonAuthorBlueprintChapterDraft('Soạn Chương 2', 1, chapterTitle), false);
  assert.equal(
    matchesLessonAuthorBlueprintChapterDraft(
      'Sửa nội dung Chương 2: Nhận diện mối nguy và đánh giá rủi ro',
      1,
      chapterTitle,
    ),
    false,
  );
  assert.equal(
    matchesLessonAuthorBlueprintChapterDraft(
      'Soạn chi tiết Chương 3: Nhận diện mối nguy và đánh giá rủi ro',
      1,
      chapterTitle,
    ),
    false,
  );
});
