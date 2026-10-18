import assert from 'node:assert/strict';
import test from 'node:test';

// The learner repositories pick the learner scope by the user id they get, so
// a learner role must never reach them without one (it would read as staff).

test.after(async () => {
  const { pool } = await import('../../config/database.js');
  await pool.end();
});

test('staff roles get no learner scope', async () => {
  const { learnerScope } = await import('./learner.service.js');
  for (const role of ['staff', 'superuser', 'superadmin']) {
    assert.equal(learnerScope(role, 'u-1'), undefined, role);
    assert.equal(learnerScope(role, undefined), undefined, role);
  }
});

test('learner roles are scoped to their own user id', async () => {
  const { learnerScope } = await import('./learner.service.js');
  assert.equal(learnerScope('learner', 'u-1'), 'u-1');
  assert.equal(learnerScope('learner_plus', 'u-2'), 'u-2');
});

test('a learner role without a user id is refused, never widened to the staff scope', async () => {
  const { learnerScope } = await import('./learner.service.js');
  const { AppError } = await import('../../middleware/error-handler.js');
  for (const role of ['learner', 'learner_plus']) {
    for (const userId of [undefined, null, '', '   ']) {
      assert.throws(
        () => learnerScope(role, userId),
        (error: unknown) => error instanceof AppError && error.statusCode === 401,
        `${role} ${JSON.stringify(userId)}`,
      );
    }
  }
});
