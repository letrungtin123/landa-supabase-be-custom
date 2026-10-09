import assert from 'node:assert/strict';
import test from 'node:test';
import { AUTHOR_ONLY_METADATA_KEYS, COURSE_AUTHOR_NOTES_KEY, preserveAuthorNotesSql, readCourseAuthorAssessmentReview,
  readCourseAuthorNotes, withoutAuthorOnlyBlockMetadata, withoutAuthorOnlyMetadata, withoutServerOwnedAuthorNotes,
  type CourseAuthorAssessmentReviewV1, type CourseAuthorNotesV1 } from './course-author-notes.logic.js';
import { buildCourseMarkdown } from '../courses/course-markdown-exporter.js';
import { toLearnerBlockRow } from '../learner/learner-block-row.logic.js';

const uuid = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SECRET = 'SME_ONLY_HOLD_REASON';

export function notesFixture(overrides: Partial<CourseAuthorNotesV1> = {}): CourseAuthorNotesV1 {
  return {
    version: 1, origin: 'ai_instructional_design', workspace_id: uuid(1), node_id: uuid(2), node_kind: 'unit',
    canonical_path: 'chapter_1.lesson_1.unit_1', revision: 3, content_hash: 'a'.repeat(64), content_locale: 'vi',
    title: 'Bài 1', purpose: 'Người học áp dụng được.', implementation_notes: `QA: ${SECRET}`,
    storyboard: null, author_review: null,
    media_briefs: [{ node_id: uuid(3), revision: 0, content_hash: 'b'.repeat(64), media_type: 'video', title: 'Video brief',
      rationale: 'Show the flow', content_points: ['Point A'], context_description: null, implementation_notes: null }],
    idm_guidance: null,
    ...overrides,
  };
}

test('strict versioned reader accepts v1 and rejects unknown versions, extra keys and oversize values', () => {
  const notes = notesFixture({ node_kind: 'course', canonical_path: 'course',
    storyboard: { summary: 'Tóm tắt', target_audience: 'CEO', prerequisites: ['A'], assessment_strategy: '' },
    idm_guidance: { hold_items: [{ name: 'Tam Hóa', reason: 'Thiếu tiêu chí', sme_question: 'Tiêu chí là gì?', blocked_must_dos: ['md_6'] }],
      pending_objectives: ['LO3'], nice_to_know: [{ name: '4 lực đẩy', summary: 'Bối cảnh' }] } });
  assert.deepEqual(readCourseAuthorNotes(structuredClone(notes)), notes);
  assert.equal(readCourseAuthorNotes({ ...notes, version: 2 }), null);
  assert.equal(readCourseAuthorNotes({ ...notes, learner_visible: true }), null);
  assert.equal(readCourseAuthorNotes({ ...notes, implementation_notes: 'x'.repeat(8001) }), null);
  assert.equal(readCourseAuthorNotes({ ...notes, workspace_id: 'not-a-uuid' }), null);
  for (const value of [null, undefined, 'notes', [], 7]) assert.equal(readCourseAuthorNotes(value), null);
});

export function reviewFixture(overrides: Partial<CourseAuthorAssessmentReviewV1> = {}): CourseAuthorAssessmentReviewV1 {
  return { obligation_id: uuid(40), unit_node_id: uuid(2), unit_path: 'chapter_1.lesson_2.unit_7', unit_title: 'Ma trận 4 trục',
    component_index: 2, required_kind: 'single_choice', learning_objective_refs: ['lo_1'],
    learning_objectives: ['Đánh giá hiện trạng theo 4 trục'], unresolved_reason: 'ASSESSMENT_SOURCE_CHECK_REQUIRED',
    evidence_fact_count: 9, ...overrides };
}

test('QLT-3 fields: open obligations and the full SME list are optional v1 fields, strictly validated', () => {
  const legacy = notesFixture();
  assert.equal('assessment_reviews' in legacy, false);
  assert.deepEqual(readCourseAuthorNotes(structuredClone(legacy)), legacy, 'notes applied before QLT-3 stay readable');
  const unit = notesFixture({ assessment_reviews: [reviewFixture()] });
  assert.deepEqual(readCourseAuthorNotes(structuredClone(unit)), unit);
  const course = notesFixture({ node_kind: 'course', canonical_path: 'course', assessment_reviews: [],
    idm_guidance: { hold_items: [], pending_objectives: [], nice_to_know: [], sme_questions: ['Q1?', 'Q2?'] } });
  assert.deepEqual(readCourseAuthorNotes(structuredClone(course)), course);
  const oldGuidance = notesFixture({ idm_guidance: { hold_items: [], pending_objectives: [], nice_to_know: [] } });
  assert.deepEqual(readCourseAuthorNotes(structuredClone(oldGuidance)), oldGuidance, 'guidance without sme_questions');
  for (const bad of [{ obligation_id: 'x' }, { unit_node_id: 'not-a-uuid' }, { component_index: 0 }, { required_kind: 'Single Choice' },
    { unresolved_reason: 'free text reason' }, { evidence_fact_count: -1 }, { learning_objective_refs: ['x'.repeat(33)] }]) {
    assert.equal(readCourseAuthorAssessmentReview(reviewFixture(bad as Partial<CourseAuthorAssessmentReviewV1>)), null, JSON.stringify(bad));
    assert.equal(readCourseAuthorNotes({ ...unit, assessment_reviews: [{ ...reviewFixture(), ...bad }] }), null);
  }
  assert.equal(readCourseAuthorNotes({ ...unit, assessment_reviews: [{ ...reviewFixture(), extra: true }] }), null);
  assert.equal(readCourseAuthorNotes({ ...course, idm_guidance: { ...course.idm_guidance, sme_questions: [7] } }), null);
});

test('learner rows never carry open obligations or SME questions from the notes key', () => {
  const metadata = { display_name: 'Unit 7', [COURSE_AUTHOR_NOTES_KEY]: notesFixture({ assessment_reviews: [reviewFixture({ unit_title: SECRET })],
    idm_guidance: { hold_items: [], pending_objectives: [], nice_to_know: [], sme_questions: [SECRET] } }) };
  for (const block_type of ['course', 'vertical', 'html', 'problem']) {
    const row = toLearnerBlockRow({ id: uuid(20), block_type, display_name: 'X', data: '<p>Học</p>', metadata: structuredClone(metadata),
      sort_order: 0, is_published: true, completed: false });
    assert.equal(JSON.stringify(row).includes(SECRET), false, block_type);
    assert.equal(JSON.stringify(row).includes('ASSESSMENT_SOURCE_CHECK_REQUIRED'), false, block_type);
    assert.deepEqual(row.metadata, { display_name: 'Unit 7' });
  }
});

test('author-only metadata keys are removed without touching learner metadata', () => {
  assert.deepEqual([...AUTHOR_ONLY_METADATA_KEYS], [COURSE_AUTHOR_NOTES_KEY, 'workspace_storyboard']);
  const learner = { display_name: 'Unit', html_media: { url: 'x' }, problem_media: null };
  assert.equal(withoutAuthorOnlyMetadata(learner), learner, 'untouched metadata keeps its identity');
  const stored = { ...learner, [COURSE_AUTHOR_NOTES_KEY]: notesFixture(), workspace_storyboard: { objective: SECRET } };
  assert.deepEqual(withoutAuthorOnlyMetadata(stored), learner);
  assert.ok(COURSE_AUTHOR_NOTES_KEY in stored, 'the stored value is not mutated');
  assert.deepEqual(withoutAuthorOnlyMetadata(JSON.stringify(stored)), learner, 'jsonb surfaced as JSON text');
  for (const value of [null, undefined, 'plain', 4, ['a']]) assert.equal(withoutAuthorOnlyMetadata(value), value);
});

test('server-owned notes cannot be supplied by browser metadata; PATCH SQL carries the stored value', () => {
  const browser = { display_name: 'Renamed', [COURSE_AUTHOR_NOTES_KEY]: { forged: true }, workspace_storyboard: { kept: true } };
  assert.deepEqual(withoutServerOwnedAuthorNotes(browser), { display_name: 'Renamed', workspace_storyboard: { kept: true } });
  const sql = preserveAuthorNotesSql('$3');
  assert.match(sql, /\(\$3::jsonb - 'ai_id_author_notes'\)/);
  assert.match(sql, /metadata \? 'ai_id_author_notes' THEN jsonb_build_object\('ai_id_author_notes', metadata->'ai_id_author_notes'\)/);
  assert.match(sql, /ELSE '\{\}'::jsonb END/);
});

test('learner block responses never carry AI ID author notes (tree, detail and published snapshots)', () => {
  const publishedMetadata = { display_name: 'Unit 1', crossword_data: { words: [] },
    [COURSE_AUTHOR_NOTES_KEY]: notesFixture(), workspace_storyboard: { objective: SECRET } };
  for (const block_type of ['course', 'chapter', 'sequential', 'vertical', 'html', 'la_crossword', 'la_media_quiz']) {
    const row = toLearnerBlockRow({ id: uuid(9), block_type, display_name: 'X', data: block_type === 'la_media_quiz' ? { questions: [] } : '<p>Học</p>',
      metadata: structuredClone(publishedMetadata), sort_order: 0, is_published: true, completed: false });
    assert.equal(JSON.stringify(row).includes(SECRET), false, block_type);
    assert.equal(JSON.stringify(row).includes(COURSE_AUTHOR_NOTES_KEY), false, block_type);
    assert.deepEqual(row.metadata, { display_name: 'Unit 1', crossword_data: { words: [] } });
  }
  const legacy = { id: uuid(10), block_type: 'html', data: '<p>A</p>', metadata: { display_name: 'A' } };
  assert.equal(toLearnerBlockRow(legacy), legacy, 'rows without notes stay byte-identical');
});

test('row-level strip covers both draft and published metadata columns', () => {
  const row = { id: uuid(11), metadata: { a: 1, [COURSE_AUTHOR_NOTES_KEY]: notesFixture() },
    published_metadata: { a: 1, workspace_storyboard: {} }, data: { [COURSE_AUTHOR_NOTES_KEY]: 'learner data is never rewritten' } };
  const stripped = withoutAuthorOnlyBlockMetadata(row);
  assert.deepEqual(stripped.metadata, { a: 1 });
  assert.deepEqual(stripped.published_metadata, { a: 1 });
  assert.equal(stripped.data, row.data);
});

test('course markdown export never prints AI ID author notes', () => {
  const metadata = { [COURSE_AUTHOR_NOTES_KEY]: notesFixture(), workspace_storyboard: { objective: SECRET } };
  const course = { id: 'course-v1:Org+1+2026', display_name: 'Course', description: 'D', org: 'Org',
    start_date: null, end_date: null, created_at: null, updated_at: null };
  const blocks = [
    { id: uuid(12), parent_id: null, block_type: 'course', display_name: 'Course', data: {}, metadata, sort_order: 0, created_at: null },
    { id: uuid(13), parent_id: uuid(12), block_type: 'html', display_name: 'Theory', data: '<p>Lý thuyết</p>', metadata, sort_order: 0, created_at: null },
  ];
  // exportCourseMarkdown strips first; the exporter itself also ignores the key.
  for (const rows of [blocks.map(withoutAuthorOnlyBlockMetadata), blocks]) {
    const markdown = buildCourseMarkdown(course, rows as never);
    assert.equal(markdown.includes(SECRET), false);
    assert.match(markdown, /Lý thuyết/);
  }
});
