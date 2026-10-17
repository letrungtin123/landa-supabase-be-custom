import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Source-level boundary contract for AI ID author notes (QC 364564, N6). The
// behavior of each helper is covered in course-author-notes.logic.test.ts;
// this file pins that every non-editor read/copy path actually uses them.
// Checkouts may use CRLF (core.autocrlf); compare normalized source.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const learner = read('../learner/learner.service.ts');
const learnerRow = read('../learner/learner-block-row.logic.ts');
const learnerTree = read('../learner/learner-course-blocks.logic.ts');
const controller = read('./course-authoring.controller.ts');
const routes = read('./course-authoring.routes.ts');
const service = read('./course-authoring.service.ts');
const transfer = read('./course-outline-transfer.service.ts');
const courses = read('../courses/courses.service.ts');
const chat = read('../ai-chatbot/chat.service.ts');

test('learner tree and block detail serialize every row through the stripping boundary', async () => {
  assert.match(learnerRow, /export function toLearnerBlockRow\(input: any\) \{\n  const row = input && typeof input === 'object' \? withoutAuthorOnlyBlockMetadata\(input\) : input;/);
  // Block detail.
  assert.equal((learner.match(/\$\{metaCol\} AS metadata/g) ?? []).length, 1, 'block detail');
  assert.match(learner, /return toLearnerBlockRow\(result\.rows\[0\]\);/);
  // Course tree: one shared published copy per course version, built from
  // every row of the published tree query through the same boundary.
  assert.match(learner, /return buildLearnerCourseStructure\(result\.rows\);/);
  assert.match(learnerTree, /const blocks = rows\.map\(\(row\) => toLearnerBlockRow\(row\)/);
  // The shared tree and grading read published metadata; grading never returns it.
  assert.equal((learner.match(/b\.published_metadata AS metadata/g) ?? []).length, 2, 'shared tree and grading');
  assert.doesNotMatch(learner, /return \{[^}]*metadata: block\.metadata/);

  const { COURSE_AUTHOR_NOTES_KEY } = await import('./course-author-notes.logic.js');
  const { buildLearnerCourseStructure } = await import('../learner/learner-course-blocks.logic.js');
  const { blocks } = buildLearnerCourseStructure([{
    id: 'unit-1', block_type: 'vertical',
    metadata: { [COURSE_AUTHOR_NOTES_KEY]: { version: 1 }, workspace_storyboard: { objective: 'x' }, kept: true },
  }]);
  assert.deepEqual(blocks[0]?.metadata, { kept: true }, 'the shared tree drops author-only keys');
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
