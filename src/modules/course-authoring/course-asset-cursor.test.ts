import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

// Course > Manage files lists a course's assets page by page (cursor
// pagination, newest first): the cursor of page 1 must open page 2. In-memory
// pg double; no database, storage or network.

const TENANT = '11111111-1111-4111-8111-111111111111';
const COURSE = 'course-v1:TEST+ASSETS+2026';

interface FakeAsset {
  id: string;
  created_at: string;
  display_name: string;
}

// Two assets share a timestamp, so the id breaks the tie (ORDER BY created_at DESC, id DESC).
const ASSETS: FakeAsset[] = [
  { id: 'a0000000-0000-4000-8000-000000000005', created_at: '2026-10-05T08:00:00.000000Z', display_name: 'e.pdf' },
  { id: 'a0000000-0000-4000-8000-000000000004', created_at: '2026-10-04T08:00:00.000000Z', display_name: 'd.pdf' },
  { id: 'a0000000-0000-4000-8000-000000000003', created_at: '2026-10-04T08:00:00.000000Z', display_name: 'c.pdf' },
  { id: 'a0000000-0000-4000-8000-000000000002', created_at: '2026-10-02T08:00:00.000000Z', display_name: 'b.pdf' },
  { id: 'a0000000-0000-4000-8000-000000000001', created_at: '2026-10-01T08:00:00.000000Z', display_name: 'a.pdf' },
];

interface Call {
  sql: string;
  params: unknown[];
}

const newestFirst = (a: FakeAsset, b: FakeAsset) =>
  b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id);

/** Answers the course check and the keyset page query the way PostgreSQL would. */
async function installFakeDb(t: TestContext): Promise<Call[]> {
  const pg = await import('pg');
  const calls: Call[] = [];
  const handle = async (text: string | { text: string }, params: unknown[] = []) => {
    const sql = typeof text === 'string' ? text : text.text;
    calls.push({ sql, params });
    if (/SELECT id FROM courses WHERE id = \$1/.test(sql)) {
      const found = params[0] === COURSE && params[1] === TENANT;
      return { rows: found ? [{ id: COURSE }] : [], rowCount: found ? 1 : 0 };
    }
    if (sql.includes('FROM course_assets ca') && sql.includes('ORDER BY ca.created_at DESC, ca.id DESC')) {
      const hasCursor = sql.includes('ca.created_at < $3');
      const [cursorAt, cursorId] = hasCursor ? [String(params[2]), String(params[3])] : [null, null];
      const limit = Number(params[params.length - 1]);
      const rows = [...ASSETS]
        .sort(newestFirst)
        .filter(
          asset => !cursorAt || asset.created_at < cursorAt || (asset.created_at === cursorAt && asset.id < cursorId!),
        )
        .slice(0, limit)
        .map(asset => ({
          ...asset,
          course_id: COURSE,
          content_type: 'application/pdf',
          storage_path: '',
          file_size: '1',
          url: asset.id,
          thumbnail_url: null,
          is_locked: false,
          is_reference: false,
          date_added: asset.created_at,
          cursor_created_at: asset.created_at,
        }));
      return { rows, rowCount: rows.length };
    }
    throw new Error(`unexpected SQL in test: ${sql.slice(0, 80)}`);
  };
  t.mock.method(pg.default.Pool.prototype, 'query', handle);
  t.mock.method(pg.default.Pool.prototype, 'connect', async () => ({ query: handle, release: () => undefined }));
  return calls;
}

test.after(async () => {
  const { pool } = await import('../../config/database.js');
  await pool.end();
});

test('the cursor of page 1 opens page 2, and the last page has no cursor', async t => {
  const calls = await installFakeDb(t);
  const { getCourseAssets } = await import('./course-authoring.service.js');

  const first = await getCourseAssets(COURSE, TENANT, 0, 2, '', { cursorPagination: true });
  assert.deepEqual(
    first.assets.map(asset => asset.display_name),
    ['e.pdf', 'd.pdf'],
  );
  assert.equal(first.hasMore, true);
  assert.equal(typeof first.nextCursor, 'string');

  const second = await getCourseAssets(COURSE, TENANT, 0, 2, '', { cursor: first.nextCursor, cursorPagination: true });
  assert.deepEqual(
    second.assets.map(asset => asset.display_name),
    ['c.pdf', 'b.pdf'],
    'same timestamp as the last row of page 1: the id decides',
  );
  const pageQuery = calls.filter(call => call.sql.includes('FROM course_assets ca')).at(-1)!;
  assert.deepEqual(pageQuery.params.slice(0, 4), [
    COURSE,
    TENANT,
    '2026-10-04T08:00:00.000000Z',
    'a0000000-0000-4000-8000-000000000004',
  ]);

  const third = await getCourseAssets(COURSE, TENANT, 0, 2, '', { cursor: second.nextCursor, cursorPagination: true });
  assert.deepEqual(
    third.assets.map(asset => asset.display_name),
    ['a.pdf'],
  );
  assert.equal(third.hasMore, false);
  assert.equal(third.nextCursor, null);
});

test('a cursor that is not ours is still refused with 400', async t => {
  await installFakeDb(t);
  const { getCourseAssets } = await import('./course-authoring.service.js');
  const { AppError } = await import('../../middleware/error-handler.js');
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  const refused = [
    'not-base64-json',
    encode({ created_at: '2026-10-04T08:00:00.000000Z', id: 'not-a-uuid' }),
    encode({ created_at: '2026-10-04T08:00:00.000000Z', id: 'a0000000-0000-4000-000000000004' }),
    encode({ created_at: 'yesterday', id: 'a0000000-0000-4000-8000-000000000004' }),
    encode({ created_at: '2026-10-04T08:00:00.000000Z', id: 42 }),
    // Date.parse accepts these, PostgreSQL does not: they must not reach the query (would be a 500).
    encode({ created_at: '1', id: 'a0000000-0000-4000-8000-000000000004' }),
    encode({ created_at: 'Oct 4 2026', id: 'a0000000-0000-4000-8000-000000000004' }),
    encode({ created_at: '2026-10-04', id: 'a0000000-0000-4000-8000-000000000004' }),
  ];
  for (const cursor of refused) {
    await assert.rejects(
      getCourseAssets(COURSE, TENANT, 0, 2, '', { cursor, cursorPagination: true }),
      (error: unknown) =>
        error instanceof AppError && error.statusCode === 400 && error.message === 'Cursor không hợp lệ',
      cursor,
    );
  }
});
