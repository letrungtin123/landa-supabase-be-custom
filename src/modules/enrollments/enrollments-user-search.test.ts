import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

// GET /api/enrollments/user/:userId?search=… used to answer 500 every time:
// the count statement named $5 but was sent three parameters, which Postgres
// refuses (on the local database: 42P18 "could not determine data type of
// parameter $3"). The pg double below refuses any statement whose highest
// placeholder differs from the number of parameters it receives, as Postgres
// does. No database, no Redis, no network.

process.env.REDIS_URL = 'redis://127.0.0.1:1';

const pg = await import('pg');
const redis = await import('../../config/redis.js');
const { pool } = await import('../../config/database.js');
const svc = await import('./enrollments.service.js');

redis.installRedisClient(null);

test.after(async () => {
  await pool.end();
});

const TENANT = '11111111-1111-4111-8111-111111111111';
const LEARNER = 'a0000000-0000-4000-8000-000000000002';

/** The highest $n a statement names (Postgres requires exactly that many parameters). */
function placeholderCount(text: string): number {
  return Math.max(0, ...[...text.matchAll(/\$(\d+)/g)].map(match => Number(match[1])));
}

function installStrictDb(t: TestContext): Array<{ text: string; params: unknown[] }> {
  const statements: Array<{ text: string; params: unknown[] }> = [];
  t.mock.method(pg.default.Pool.prototype, 'query', async (text: string, params: unknown[] = []) => {
    const required = placeholderCount(text);
    if (required !== params.length) {
      throw Object.assign(
        new Error(`the statement names ${required} parameters but receives ${params.length}`),
        { code: '42P18' },
      );
    }
    statements.push({ text, params });
    if (/COUNT\(\*\) AS count/.test(text)) return { rows: [{ count: '3' }], rowCount: 1 };
    return { rows: [{ id: 'e1', course_name: 'Excel cơ bản' }], rowCount: 1 };
  });
  return statements;
}

test('the user enrollment list with a search sends every statement the parameters it names', async t => {
  const statements = installStrictDb(t);

  const result = await svc.getUserEnrollments(LEARNER, TENANT, 2, 5, 'Excel');

  assert.equal(result.total, 3);
  assert.equal(result.data.length, 1);
  assert.equal(statements.length, 2);
  const [count, page] = statements;
  assert.match(count.text, /ILIKE '%' \|\| \$3 \|\| '%'/);
  assert.deepEqual(count.params, [LEARNER, TENANT, 'Excel']);
  assert.match(page.text, /ILIKE '%' \|\| \$5 \|\| '%'/);
  assert.deepEqual(page.params, [LEARNER, TENANT, 5, 5, 'Excel']);
});

test('the user enrollment list without a search is unchanged', async t => {
  const statements = installStrictDb(t);

  const result = await svc.getUserEnrollments(LEARNER, TENANT, 1, 10, '');

  assert.equal(result.total, 3);
  assert.equal(statements.length, 2);
  assert.doesNotMatch(statements[0].text, /ILIKE/);
  assert.deepEqual(statements[0].params, [LEARNER, TENANT]);
  assert.deepEqual(statements[1].params, [LEARNER, TENANT, 10, 0]);
});
