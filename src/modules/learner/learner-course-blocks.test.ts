import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { toLearnerBlockRow } from './learner-block-row.logic.js';
import { buildLearnerCourseStructure, overlayLearnerBlockCompletions } from './learner-course-blocks.logic.js';

// H6: the learner course tree (GET /api/learner/courses/:id/blocks) is built
// once per course version and shared; each learner's completed blocks are
// overlaid. The answer must be the same, byte for byte, as the former
// per-learner query (which joined block_completions into the tree query).
// Block detail and course files share their content the same way; the
// access check stays per learner.

const TENANT = '11111111-1111-4111-8111-111111111111';
const COURSE = 'course-v1:A+blocks+2026';
const LEARNER_DONE = 'a0000000-0000-4000-8000-0000000000a1';
const LEARNER_NONE = 'a0000000-0000-4000-8000-0000000000a2';
const LEARNER_NOT_ENROLLED = 'a0000000-0000-4000-8000-0000000000a3';
const LEARNER_NO_ACCESS = 'a0000000-0000-4000-8000-0000000000a4';
const STAFF = 'a0000000-0000-4000-8000-0000000000a5';

type BlockFixture = {
  id: string; parent_id: string | null; block_type: string; display_name: string;
  published_data: unknown; published_metadata: unknown; sort_order: number;
  is_published: boolean; deleted: boolean;
};

const id = (n: number) => `b0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const blocks: BlockFixture[] = [
  { id: id(1), parent_id: null, block_type: 'course', display_name: 'Course', published_data: {}, published_metadata: {}, sort_order: 0, is_published: true, deleted: false },
  { id: id(2), parent_id: id(1), block_type: 'chapter', display_name: 'Chapter', published_data: {}, published_metadata: {}, sort_order: 1, is_published: true, deleted: false },
  { id: id(3), parent_id: id(2), block_type: 'sequential', display_name: 'Lesson', published_data: {}, published_metadata: {}, sort_order: 2, is_published: true, deleted: false },
  { id: id(4), parent_id: id(3), block_type: 'vertical', display_name: 'Unit', published_data: {}, published_metadata: {}, sort_order: 3, is_published: true, deleted: false },
  {
    id: id(5), parent_id: id(4), block_type: 'html', display_name: 'Reading', published_data: '<p>Hello</p>',
    published_metadata: { html_media: { images: [] }, ai_id_author_notes: { notes: ["author only"] } },
    sort_order: 4, is_published: true, deleted: false,
  },
  {
    id: id(6), parent_id: id(4), block_type: 'problem', display_name: 'Quiz',
    published_data: '<problem><multiplechoiceresponse><choicegroup><choice correct="true">A</choice><choice correct="false">B</choice></choicegroup></multiplechoiceresponse><solution>Because A</solution></problem>',
    published_metadata: {}, sort_order: 5, is_published: true, deleted: false,
  },
  {
    id: id(7), parent_id: id(4), block_type: 'la_sortable', display_name: 'Order',
    published_data: { sortable_data: { items: [{ id: 1, text: 'one' }, { id: 2, text: 'two' }, { id: 3, text: 'three' }] } },
    published_metadata: JSON.stringify({ sortable_data: { items: [{ id: 1, text: 'one' }, { id: 2, text: 'two' }] } }),
    sort_order: 6, is_published: true, deleted: false,
  },
  {
    id: id(8), parent_id: id(4), block_type: 'la_crossword', display_name: 'Words',
    published_data: {}, published_metadata: { crossword_data: { words: [{ clue: 'pet', answer: 'CAT' }] } },
    sort_order: 7, is_published: true, deleted: false,
  },
  { id: id(9), parent_id: id(4), block_type: 'video', display_name: 'Video', published_data: { url: 'v.mp4' }, published_metadata: null, sort_order: 8, is_published: true, deleted: false },
  // Never in the learner tree: unpublished, deleted, or under an unpublished parent.
  { id: id(10), parent_id: id(4), block_type: 'html', display_name: 'Draft', published_data: 'x', published_metadata: {}, sort_order: 9, is_published: false, deleted: false },
  { id: id(11), parent_id: id(4), block_type: 'html', display_name: 'Deleted', published_data: 'x', published_metadata: {}, sort_order: 10, is_published: true, deleted: true },
  { id: id(12), parent_id: id(10), block_type: 'html', display_name: 'Under draft', published_data: 'x', published_metadata: {}, sort_order: 11, is_published: true, deleted: false },
];

const enrollments: Record<string, string> = {
  [LEARNER_DONE]: 'e-done',
  [LEARNER_NONE]: 'e-none',
  [STAFF]: 'e-staff',
};
// Completions also exist for blocks that are no longer in the tree.
const completions: Record<string, string[]> = {
  'e-done': [id(5), id(7), id(9), id(11)],
  'e-none': [],
  'e-staff': [id(6)],
};
const learnersWithAccess = new Set([LEARNER_DONE, LEARNER_NONE, LEARNER_NOT_ENROLLED]);

/** The published tree as the recursive query returns it (sort_order is unique here). */
function publishedTree(): BlockFixture[] {
  const out: BlockFixture[] = [];
  const visit = (parentId: string | null) => {
    for (const block of blocks.filter((b) => b.parent_id === parentId && b.is_published && !b.deleted)) {
      out.push(block);
      visit(block.id);
    }
  };
  visit(null);
  return out.sort((a, b) => a.sort_order - b.sort_order);
}

const treeRow = (b: BlockFixture) => ({
  id: b.id, parent_id: b.parent_id, block_type: b.block_type, display_name: b.display_name,
  data: b.published_data, metadata: b.published_metadata, sort_order: b.sort_order, is_published: b.is_published,
});

/** The former path: one query with `completed` from the LEFT JOIN, then toLearnerBlockRow. */
function formerCourseBlocks(userId: string, demo = false) {
  const enrollment = demo ? null : enrollments[userId] ?? null;
  const done = new Set(enrollment ? completions[enrollment] : []);
  const rows = publishedTree().map((b) => ({ ...treeRow(b), completed: enrollment ? done.has(b.id) : false }));
  const result = rows.map(toLearnerBlockRow);
  const root = result.find((b: { block_type?: string }) => b.block_type === 'course') ?? null;
  return { root_id: root?.id ?? null, blocks: result };
}

const assets = [
  { id: 'f1', display_name: 'Guide.PDF', content_type: 'application/pdf', file_size: '1200', url: 'tenant/a/guide.pdf', is_locked: false, is_reference: true, created_at: new Date('2026-10-02T00:00:00Z') },
  { id: 'f2', display_name: 'Answers.xlsx', content_type: 'application/vnd.ms-excel', file_size: '99', url: 'tenant/a/answers.xlsx', is_locked: true, is_reference: true, created_at: new Date('2026-10-01T00:00:00Z') },
];

/** The former files payload for a role. */
function formerCourseFiles(learnerView: boolean) {
  const rows = assets.filter((a) => !learnerView || !a.is_locked);
  return {
    files: rows.map((r) => ({
      id: r.id, display_name: r.display_name, url: r.url,
      extension: r.display_name?.split('.').pop()?.toLowerCase() || '',
      content_type: r.content_type, size: parseInt(r.file_size) || 0, date_added: r.created_at,
    })),
    total: rows.length,
  };
}

async function installFakeDb(t: TestContext): Promise<string[]> {
  const sqls: string[] = [];
  const pg = await import('pg');
  t.mock.method(pg.default.Pool.prototype, 'query', async (text: string, params: unknown[] = []) => {
    sqls.push(text);
    // Overlap concurrent requests so the in-process load sharing is exercised.
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (text.includes('FROM courses c') && text.includes('c.id = $1') && !text.includes('course_blocks')) {
      const userId = params[2] as string | undefined; // only learners get the assignment condition
      const ok = params[0] === COURSE && params[1] === TENANT && (userId === undefined || learnersWithAccess.has(userId));
      return { rows: ok ? [{ id: COURSE }] : [], rowCount: ok ? 1 : 0 };
    }
    if (text.includes('WITH RECURSIVE active_tree')) {
      const rows = params[0] === COURSE ? publishedTree().map(treeRow) : [];
      return { rows, rowCount: rows.length };
    }
    if (text.includes('WITH enrollment AS')) {
      const enrollment = enrollments[params[1] as string];
      const rows = (enrollment ? completions[enrollment] : []).map((block_id) => ({ block_id }));
      return { rows, rowCount: rows.length };
    }
    if (text.includes('WITH RECURSIVE ancestors') && text.includes('b.course_id')) {
      const block = blocks.find((b) => b.id === params[0] && !b.deleted);
      const rows = block ? [{ ...treeRow(block), course_id: COURSE }].map(({ id: blockId, course_id, ...rest }) => ({ id: blockId, course_id, ...rest })) : [];
      return { rows, rowCount: rows.length };
    }
    if (text.includes('FROM course_assets')) {
      const rows = assets.filter((a) => !text.includes('is_locked = false') || !a.is_locked);
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 0 };
  });
  return sqls;
}

const count = (sqls: string[], fragment: string) => sqls.filter((sql) => sql.includes(fragment)).length;

test('overlay on the shared structure (also after a JSON round trip) equals the former per-learner rows', () => {
  const structure = buildLearnerCourseStructure(publishedTree().map(treeRow));
  for (const userId of [LEARNER_DONE, LEARNER_NONE, LEARNER_NOT_ENROLLED, STAFF]) {
    const enrollment = enrollments[userId];
    const ids = enrollment ? completions[enrollment] : [];
    for (const shared of [structure, JSON.parse(JSON.stringify(structure))]) {
      const next = overlayLearnerBlockCompletions(shared, ids);
      assert.deepEqual(next, formerCourseBlocks(userId));
      assert.equal(JSON.stringify(next), JSON.stringify(formerCourseBlocks(userId)), 'same bytes, same key order');
    }
  }
  assert.equal(structure.blocks.some((block) => 'completed' in block), false, 'the shared structure carries no learner state');
});

test('learners with completions, without completions, not enrolled, staff and demo get the former answer', async (t) => {
  await installFakeDb(t);
  const svc = await import('./learner.service.js');
  const cases: Array<[string, string, boolean]> = [
    [LEARNER_DONE, 'learner', false],
    [LEARNER_NONE, 'learner', false],
    [LEARNER_NOT_ENROLLED, 'learner', false],
    [STAFF, 'staff', false],
    [LEARNER_DONE, 'learner', true],
  ];
  for (const [userId, role, demo] of cases) {
    const next = await svc.getCourseBlocks(COURSE, userId, role, TENANT, demo);
    const former = formerCourseBlocks(userId, demo);
    assert.deepEqual(next, former, `${userId} ${role} demo=${demo}`);
    assert.equal(JSON.stringify(next), JSON.stringify(former));
  }
  const done = await svc.getCourseBlocks(COURSE, LEARNER_DONE, 'learner', TENANT);
  const completed = done.blocks.filter((block) => block.completed).map((block) => block.id);
  assert.deepEqual(completed, [id(5), id(7), id(9)], 'completed/incomplete per block; a removed block is not listed');
  assert.equal(JSON.stringify(done).includes('author only'), false, 'author notes removed');
  assert.equal(JSON.stringify(done).includes('correct='), false, 'answer key removed');
});

test('concurrent learners share one structure load; access and completions stay per learner', async (t) => {
  const sqls = await installFakeDb(t);
  const svc = await import('./learner.service.js');
  const [done, none, denied] = await Promise.allSettled([
    svc.getCourseBlocks(COURSE, LEARNER_DONE, 'learner', TENANT),
    svc.getCourseBlocks(COURSE, LEARNER_NONE, 'learner', TENANT),
    svc.getCourseBlocks(COURSE, LEARNER_NO_ACCESS, 'learner', TENANT),
  ]);
  assert.equal(done.status, 'fulfilled');
  assert.equal(none.status, 'fulfilled');
  assert.equal(denied.status, 'rejected');
  assert.equal((denied as PromiseRejectedResult).reason.statusCode, 403);
  assert.equal(count(sqls, 'WITH RECURSIVE active_tree'), 1, 'one tree query for both learners');
  assert.equal(count(sqls, 'FROM courses c'), 3, 'one access check per learner');
  assert.equal(count(sqls, 'WITH enrollment AS'), 2);
  if (done.status === 'fulfilled' && none.status === 'fulfilled') {
    assert.deepEqual(done.value, formerCourseBlocks(LEARNER_DONE));
    assert.deepEqual(none.value, formerCourseBlocks(LEARNER_NONE));
    assert.equal(none.value.blocks.every((block) => block.completed === false), true);
  }
});

test('a learner without access gets 403 and the tree is not read', async (t) => {
  const sqls = await installFakeDb(t);
  const svc = await import('./learner.service.js');
  await assert.rejects(svc.getCourseBlocks(COURSE, LEARNER_NO_ACCESS, 'learner', TENANT), (err: { statusCode?: number }) => err.statusCode === 403);
  assert.equal(count(sqls, 'WITH RECURSIVE active_tree'), 0);
});

test('block detail is loaded once for concurrent learners; each learner is checked', async (t) => {
  const sqls = await installFakeDb(t);
  const svc = await import('./learner.service.js');
  const [allowed, denied] = await Promise.allSettled([
    svc.getBlockDetail(id(6), LEARNER_DONE, 'learner', TENANT),
    svc.getBlockDetail(id(6), LEARNER_NO_ACCESS, 'learner', TENANT),
  ]);
  assert.equal(allowed.status, 'fulfilled');
  assert.equal(denied.status, 'rejected');
  assert.equal(count(sqls, 'WITH RECURSIVE ancestors'), 1);
  assert.equal(count(sqls, 'FROM courses c'), 2);
  const block = blocks.find((b) => b.id === id(6))!;
  const { id: blockId, ...rest } = treeRow(block);
  assert.deepEqual((allowed as PromiseFulfilledResult<unknown>).value, toLearnerBlockRow({ id: blockId, course_id: COURSE, ...rest }));
  await assert.rejects(svc.getBlockDetail(id(11), LEARNER_DONE, 'learner', TENANT), (err: { statusCode?: number }) => err.statusCode === 404);
});

test('course files: learners see unlocked files only, staff see locked ones too, each caller is checked', async (t) => {
  const sqls = await installFakeDb(t);
  const svc = await import('./learner.service.js');
  const [learnerA, learnerB, staff, denied] = await Promise.allSettled([
    svc.getCourseFiles(COURSE, LEARNER_DONE, 'learner', TENANT),
    svc.getCourseFiles(COURSE, LEARNER_NONE, 'learner', TENANT),
    svc.getCourseFiles(COURSE, STAFF, 'staff', TENANT),
    svc.getCourseFiles(COURSE, LEARNER_NO_ACCESS, 'learner', TENANT),
  ]);
  assert.deepEqual((learnerA as PromiseFulfilledResult<unknown>).value, formerCourseFiles(true));
  assert.deepEqual((learnerB as PromiseFulfilledResult<unknown>).value, formerCourseFiles(true));
  assert.deepEqual((staff as PromiseFulfilledResult<unknown>).value, formerCourseFiles(false));
  assert.equal(denied.status, 'rejected');
  assert.equal(count(sqls, 'FROM course_assets'), 2, 'one list for learners, one for staff');
  assert.equal(count(sqls, 'FROM courses c') - count(sqls, 'FROM course_assets'), 4, 'one access check per caller');
});
