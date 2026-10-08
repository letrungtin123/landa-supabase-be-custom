import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Source-level boundary contract for AI ID author notes (QC 364564, N6). The
// behavior of each helper is covered in course-author-notes.logic.test.ts;
// this file pins that every non-editor read/copy path actually uses them.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const learner = read('../learner/learner.service.ts');
const learnerRow = read('../learner/learner-block-row.logic.ts');
const controller = read('./course-authoring.controller.ts');
const routes = read('./course-authoring.routes.ts');
const service = read('./course-authoring.service.ts');
const transfer = read('./course-outline-transfer.service.ts');
const courses = read('../courses/courses.service.ts');
const chat = read('../ai-chatbot/chat.service.ts');

test('learner tree and block detail serialize every row through the stripping boundary', () => {
  assert.match(learnerRow, /export function toLearnerBlockRow\(input: any\) \{\n  const row = input && typeof input === 'object' \? withoutAuthorOnlyBlockMetadata\(input\) : input;/);
  assert.equal((learner.match(/\$\{metaCol\} AS metadata/g) ?? []).length, 3, 'tree (enrolled + not enrolled) and detail');
  assert.match(learner, /const blocks = result\.rows\.map\(toLearnerBlockRow\);/);
  assert.match(learner, /return toLearnerBlockRow\(result\.rows\[0\]\);/);
  // Grading reads published metadata but never returns it.
  assert.equal((learner.match(/b\.published_metadata AS metadata/g) ?? []).length, 1);
  assert.doesNotMatch(learner, /return \{[^}]*metadata: block\.metadata/);
});

test('CMS reads, browser writes, transfers, exports and chat prompts cannot expose or forge notes', () => {
  assert.match(routes, /router\.get\('\/author-notes\/:courseId', checkPermission\('courses', 'can_edit'\), ctrl\.getAuthorNotes\);/);
  assert.match(routes, /router\.get\('\/blocks\/:blockId', checkPermission\('courses', 'can_view'\), ctrl\.getBlock\);/);
  assert.match(controller, /sendSuccess\(res, \{ \.\.\.block, metadata: withoutServerOwnedAuthorNotes\(block\.metadata\) \}\);/);
  assert.match(controller, /const next = \{ \.\.\.withoutServerOwnedAuthorNotes\(metadata\) \};/);
  assert.match(service, /`metadata = \$\{preserveAuthorNotesSql\(`\$\$\{paramIdx\+\+\}`\)\}`/);
  assert.match(service, /\.\.\.\(withoutServerOwnedAuthorNotes\(metadata\) \?\? \{\}\),/);
  assert.match(service, /export async function getCourseAuthorNotes\(courseId: string, tenantId: string\)/);
  assert.match(service, /FROM courses WHERE id = \$1 AND tenant_id = \$2::uuid AND deleted_at IS NULL/);
  assert.match(transfer, /THEN source\.metadata - '\$\{COURSE_AUTHOR_NOTES_KEY\}' ELSE COALESCE\(source\.metadata, '\{\}'::jsonb\) END/);
  assert.match(courses, /buildCourseMarkdown\(courseResult\.rows\[0\], blocksResult\.rows\.map\(withoutAuthorOnlyBlockMetadata\)\)/);
  assert.match(chat, /const promptMetadata = withoutAuthorOnlyMetadata\(metadata\);/);
});
