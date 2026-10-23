import assert from 'node:assert/strict';
import test from 'node:test';

// The leaf-first block deletion loop of the course purge, against an
// in-memory block tree that answers deleteLeafCourseBlockBatch exactly like
// its SQL: up to `limit` leaves with an id after the cursor, in id order.
// No database, RabbitMQ, Redis or network (the service module only creates
// its pool lazily).

const { deleteCourseBlocksLeafFirst } = await import('./course-deletion.service.js');
const { FIRST_UUID } = await import('./course-deletion.constants.js');

type Tree = Map<string, string | null>;

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

function fakeRepository(tree: Tree) {
  const calls: Array<{ afterId: string; deleted: number }> = [];
  return {
    calls,
    async deleteLeafCourseBlockBatch(_courseId: string, afterId: string, limit: number) {
      const parents = new Set([...tree.values()].filter((parent): parent is string => parent !== null));
      const doomed = [...tree.keys()]
        .filter(id => id > afterId && !parents.has(id))
        .sort()
        .slice(0, limit);
      for (const id of doomed) tree.delete(id);
      calls.push({ afterId, deleted: doomed.length });
      return { deleted: doomed.length, lastId: doomed.at(-1) ?? null };
    },
  };
}

/** A course root with `chapters` chapters of `units` units of `leaves` components each. */
function courseTree(chapters: number, units: number, leaves: number): Tree {
  const tree: Tree = new Map();
  let next = 1;
  const root = uuid(next++);
  tree.set(root, null);
  for (let c = 0; c < chapters; c += 1) {
    const chapter = uuid(next++);
    tree.set(chapter, root);
    for (let u = 0; u < units; u += 1) {
      const unit = uuid(next++);
      tree.set(unit, chapter);
      for (let l = 0; l < leaves; l += 1) tree.set(uuid(next++), unit);
    }
  }
  return tree;
}

test('every block goes, leaves first, in bounded batches, one pass per tree level plus one', async () => {
  const tree = courseTree(3, 4, 5); // 1 + 3 + 12 + 60 = 76 blocks, depth 4
  const repository = fakeRepository(tree);
  assert.equal(await deleteCourseBlocksLeafFirst(repository, 'course-v1:x+y+2026', 10), 76);
  assert.equal(tree.size, 0);
  assert.ok(repository.calls.every(call => call.deleted <= 10));
  // A pass restarts from the first id; the last pass deletes nothing and ends the loop.
  const passes = repository.calls.filter(call => call.afterId === FIRST_UUID).length;
  assert.equal(passes, 5);
  assert.deepEqual(repository.calls.at(-1), { afterId: FIRST_UUID, deleted: 0 });
});

test('a full batch moves the cursor to its last id; a short batch ends the pass', async () => {
  const tree: Tree = new Map([[uuid(1), null], [uuid(2), null], [uuid(3), null]]);
  const repository = fakeRepository(tree);
  assert.equal(await deleteCourseBlocksLeafFirst(repository, 'c', 2), 3);
  assert.deepEqual(repository.calls, [
    { afterId: FIRST_UUID, deleted: 2 },
    { afterId: uuid(2), deleted: 1 },
    { afterId: FIRST_UUID, deleted: 0 },
  ]);
});

test('an empty course is one statement', async () => {
  const repository = fakeRepository(new Map());
  assert.equal(await deleteCourseBlocksLeafFirst(repository, 'c', 500), 0);
  assert.equal(repository.calls.length, 1);
});

test('a parent cycle (broken data) ends the loop instead of spinning; the course delete removes the rest', async () => {
  const tree: Tree = new Map([[uuid(1), uuid(2)], [uuid(2), uuid(1)], [uuid(3), uuid(1)]]);
  const repository = fakeRepository(tree);
  assert.equal(await deleteCourseBlocksLeafFirst(repository, 'c', 500), 1);
  assert.deepEqual([...tree.keys()], [uuid(1), uuid(2)]);
});
