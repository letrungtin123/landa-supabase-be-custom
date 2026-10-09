import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { Request, Response } from 'express';

// S1 C2: course assets can only be stored for, and listed from, the course's
// own tenant. In-memory pg double; storage/network calls are forbidden.

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const COURSE_A = 'c0000000-0000-4000-8000-00000000000a';
const COURSE_B = 'c0000000-0000-4000-8000-00000000000b';
const STAFF_A = 'a0000000-0000-4000-8000-000000000001';
const LEARNER_B = 'a0000000-0000-4000-8000-000000000002';

const courses = new Map([[COURSE_A, TENANT_A], [COURSE_B, TENANT_B]]);
interface Call { sql: string; params: unknown[] }

async function installFakeDb(t: TestContext, calls: Call[]): Promise<void> {
  const pg = await import('pg');
  const assets = [
    { id: 'asset-b', course_id: COURSE_B, tenant_id: TENANT_B, display_name: 'b.pdf' },
    // Injected earlier from tenant A into tenant B's course.
    { id: 'asset-injected', course_id: COURSE_B, tenant_id: TENANT_A, display_name: 'evil.pdf' },
  ];
  const handle = async (text: string | { text: string }, params: unknown[] = []) => {
    const sql = typeof text === 'string' ? text : text.text;
    calls.push({ sql, params });
    const empty = { rows: [] as unknown[], rowCount: 0 };
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) return empty;
    if (/SELECT (c\.)?id\s+FROM courses/.test(sql)) {
      return courses.get(String(params[0])) === params[1] ? { rows: [{ id: params[0] }], rowCount: 1 } : empty;
    }
    if (/^\s*INSERT INTO course_assets/.test(sql)) {
      const allowed = sql.includes('WHERE EXISTS') && courses.get(String(params[0])) === params[1];
      return allowed ? { rows: [{ id: 'new-asset', course_id: params[0], display_name: params[2] }], rowCount: 1 } : empty;
    }
    if (sql.includes('FROM course_assets') && sql.includes('is_reference = true')) {
      const tenantGuard = /c\.tenant_id = course_assets\.tenant_id/.test(sql);
      const rows = assets
        .filter((asset) => asset.course_id === params[0])
        .filter((asset) => !tenantGuard || courses.get(asset.course_id) === asset.tenant_id)
        .map((asset) => ({ ...asset, content_type: 'application/pdf', file_size: '1', url: asset.id, is_locked: false, is_reference: true, created_at: '' }));
      return { rows, rowCount: rows.length };
    }
    return empty;
  };
  t.mock.method(pg.default.Pool.prototype, 'query', handle);
  t.mock.method(pg.default.Pool.prototype, 'connect', async () => ({ query: handle, release: () => undefined }));
}

test('uploading an asset into another tenant\'s course is refused before anything is stored', async (t) => {
  const calls: Call[] = [];
  await installFakeDb(t, calls);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('no network in tests'); });
  const { uploadAsset } = await import('./course-authoring.controller.js');

  const req = {
    params: { courseId: COURSE_B },
    user: { id: STAFF_A, tenantId: TENANT_A, role: 'staff' },
    file: { size: 4, originalname: 'evil.pdf', mimetype: 'application/pdf', buffer: Buffer.from('test') },
  } as unknown as Request;
  t.mock.method(console, 'error', () => undefined);
  t.mock.method(console, 'info', () => undefined);
  await assert.rejects(uploadAsset(req, {} as Response), { statusCode: 404 });
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.equal(calls.some((call) => /INSERT INTO course_assets/.test(call.sql)), false);
});

test('createAssetRecord inserts only when the course belongs to the tenant', async (t) => {
  const calls: Call[] = [];
  await installFakeDb(t, calls);
  const { createAssetRecord } = await import('./course-authoring.service.js');
  await assert.rejects(
    createAssetRecord(COURSE_B, TENANT_A, 'x.pdf', 'application/pdf', 1, `${TENANT_A}/courses/${COURSE_B}/x.pdf`, 'x', STAFF_A),
    { statusCode: 404 },
  );
  const created = await createAssetRecord(COURSE_A, TENANT_A, 'ok.pdf', 'application/pdf', 1, `${TENANT_A}/courses/${COURSE_A}/ok.pdf`, 'ok', STAFF_A);
  assert.equal(created.course_id, COURSE_A);
});

test('learners see only reference files whose tenant matches the course', async (t) => {
  const calls: Call[] = [];
  await installFakeDb(t, calls);
  const { getCourseFiles } = await import('../learner/learner.service.js');
  const result = await getCourseFiles(COURSE_B, LEARNER_B, 'staff', TENANT_B);
  assert.deepEqual(result.files.map((file: { id: string }) => file.id), ['asset-b']);
});
