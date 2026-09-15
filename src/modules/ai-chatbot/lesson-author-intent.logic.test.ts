import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyLessonAuthorIntent,
  detectLessonAuthorInputLocale,
  extractRequestedTitle,
  formatChapterTitle,
  stripLessonAuthorSourceRangeSuffix,
} from './lesson-author-intent.logic.js';

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

test('does not treat a broad course reference as a blueprint request', () => {
  const plan = classifyLessonAuthorIntent({
    message: 'Tạo nội dung cho khóa học',
  });

  assert.equal(plan.operation, 'clarify');
  assert.equal(plan.target_type, 'course');
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
});
