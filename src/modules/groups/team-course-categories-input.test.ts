import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { callHandler, installDb } from '../../test-support/staff-sql-characterization.js';

// POST /api/groups/teams/:teamId/course-categories checks category_ids before
// anything is read: every id a UUID (anything else used to reach Postgres,
// fail the uuid cast with 22P02 and answer 500) and at most 500 ids (each id
// is one insert; the list had no limit). pg double; no database, no Redis.

process.env.REDIS_URL = 'redis://127.0.0.1:1';

const redis = await import('../../config/redis.js');
const { pool } = await import('../../config/database.js');
const ctrl = await import('./groups.controller.js');
const { TEAM_COURSE_CATEGORY_MAX_IDS } = await import('./groups.validator.js');

redis.installRedisClient(null);

test.after(async () => {
  await pool.end();
});

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = 'a0000000-0000-4000-8000-000000000001';
const TEAM = 'c0000000-0000-4000-8000-000000000001';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = 'TEAM_COURSE_CATEGORY_IDS_INVALID';
const INVALID = 'Danh sách danh mục khóa học không hợp lệ. Vui lòng tải lại trang và chọn lại.';

const categoryId = (index: number) => `d0000000-0000-4000-8000-${String(index).padStart(12, '0')}`;

/** Postgres refuses a non-UUID in `$2::uuid` (SQLSTATE 22P02); the double does the same. */
function install(t: TestContext) {
  t.mock.method(console, 'error', () => undefined);
  return installDb(t, pool, { id: TEAM, name: 'Team A', tenant_id: TENANT, exists: true }, (text, _index, params) =>
    /INSERT INTO team_course_categories/.test(text) && !UUID.test(String(params[1]))
      ? { error: { code: '22P02', message: 'invalid input syntax for type uuid' } }
      : undefined,
  );
}

async function assign(body: unknown) {
  const req = {
    user: { id: USER, tenantId: TENANT, role: 'superadmin', username: 'admin01', sessionMode: 'normal' },
    params: { teamId: TEAM },
    query: {},
    body,
    originalUrl: `/api/groups/teams/${TEAM}/course-categories`,
    method: 'POST',
    get: () => undefined,
    headers: {},
    ip: '127.0.0.1',
  };
  const outcome = (await callHandler(ctrl.assignTeamCourseCategoriesController, req)) as {
    status?: number;
    body?: unknown;
    next?: unknown;
  };
  // An error passed to next reaches the global handler as a 500 (the old behavior on a non-UUID).
  return outcome.next ? { status: 500, body: outcome.next } : (outcome as { status: number; body: unknown });
}

test('a category id that is not a UUID is a 400, and nothing is read or written', async t => {
  for (const ids of [['not-a-uuid'], [categoryId(1), 'x'], [42], [categoryId(1), null], [{ id: categoryId(1) }]]) {
    const statements = install(t);
    const outcome = await assign({ category_ids: ids });
    assert.equal(outcome.status, 400, JSON.stringify(ids));
    assert.deepEqual(outcome.body, { success: false, message: INVALID, code: CODE, error: CODE });
    assert.deepEqual(statements, []);
    t.mock.restoreAll();
  }
});

test(`more than ${TEAM_COURSE_CATEGORY_MAX_IDS} category ids is a 400`, async t => {
  const statements = install(t);
  const ids = Array.from({ length: TEAM_COURSE_CATEGORY_MAX_IDS + 1 }, (_, index) => categoryId(index));
  const outcome = await assign({ category_ids: ids });
  assert.equal(outcome.status, 400);
  assert.deepEqual(outcome.body, {
    success: false,
    message: `Mỗi lần chỉ gán được tối đa ${TEAM_COURSE_CATEGORY_MAX_IDS} danh mục khóa học.`,
    code: CODE,
    error: CODE,
  });
  assert.deepEqual(statements, []);
});

test('no JSON body is a 400; a category_ids that is not a list keeps its answer', async t => {
  for (const body of [undefined, null, [], 'x']) {
    const statements = install(t);
    const outcome = await assign(body);
    assert.equal(outcome.status, 400);
    assert.deepEqual(outcome.body, { success: false, message: INVALID, code: CODE, error: CODE });
    assert.deepEqual(statements, []);
    t.mock.restoreAll();
  }
  install(t);
  const notAList = await assign({ category_ids: categoryId(1) });
  assert.deepEqual(notAList.body, { success: false, message: 'category_ids phải là mảng', code: 'BAD_REQUEST' });
});

test(`${TEAM_COURSE_CATEGORY_MAX_IDS} UUIDs are assigned as before, one insert each`, async t => {
  const statements = install(t);
  const ids = Array.from({ length: TEAM_COURSE_CATEGORY_MAX_IDS }, (_, index) => categoryId(index));
  const outcome = await assign({ category_ids: ids });
  assert.equal(outcome.status, 200);
  assert.equal(statements.filter(statement => /INSERT INTO team_course_categories/.test(statement.text)).length, ids.length);
});
