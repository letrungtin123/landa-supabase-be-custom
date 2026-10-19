import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { NextFunction, Request, Response } from 'express';

// Learner routes answer a malformed request with a 400, or read a bad page as
// the default, never a 500: a request without a JSON body on enroll and
// complete-blocks, a repeated courseIds on progress-batch, a page that is not
// a number on courses, library documents and notifications. pg double; no
// database, no Redis, no network.

process.env.REDIS_URL = 'redis://127.0.0.1:1';

const pg = await import('pg');
const redis = await import('../../config/redis.js');
const { pool } = await import('../../config/database.js');
const { errorHandler } = await import('../../middleware/error-handler.js');
const ctrl = await import('./learner.controller.js');

redis.installRedisClient(null);

test.after(async () => {
  await pool.end();
});

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = 'a0000000-0000-4000-8000-000000000001';

type Handler = (req: Request, res: Response, next: NextFunction) => Promise<void>;

interface FakeResponse {
  statusCode: number;
  body: unknown;
  headersSent: boolean;
  status(code: number): FakeResponse;
  json(body: unknown): FakeResponse;
  setHeader(): void;
}

/** The handler, then the global error handler for whatever it passed to next (as Express does). */
async function respond(handler: Handler, input: { query?: Record<string, unknown>; body?: unknown }) {
  const res: FakeResponse = {
    statusCode: 200,
    body: undefined,
    headersSent: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      this.headersSent = true;
      return this;
    },
    setHeader() {},
  };
  const req = {
    user: { id: USER, tenantId: TENANT, role: 'learner', username: 'learner01', sessionMode: 'normal' },
    query: input.query ?? {},
    params: {},
    body: input.body,
    method: 'GET',
    originalUrl: '/api/learner',
    get: () => undefined,
    headers: {},
  } as unknown as Request;
  let passed: unknown;
  await handler(req, res as unknown as Response, (error?: unknown) => {
    passed = error;
  });
  if (passed !== undefined) errorHandler(passed as Error, req, res as unknown as Response, () => undefined);
  return res;
}

function installDb(t: TestContext) {
  const statements: Array<{ text: string; params: unknown[] }> = [];
  t.mock.method(pg.default.Pool.prototype, 'query', async (text: string, params: unknown[] = []) => {
    statements.push({ text, params });
    // The unread count of a page past the end (getUnreadCount) reads one row.
    if (/\bCOUNT\s*\(/i.test(text) && !/OVER\s*\(/i.test(text)) return { rows: [{ count: '0' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  return statements;
}

test('enroll and complete-blocks without a JSON body answer their missing-field 400, not a 500', async t => {
  const statements = installDb(t);
  const quiet = t.mock.method(console, 'error', () => undefined);
  // No body parser ran (no body, or not JSON): Express 5 leaves req.body undefined.
  for (const body of [undefined, null, 'course_id=x', 42]) {
    const enroll = await respond(ctrl.enroll, { body });
    assert.equal(enroll.statusCode, 400, `enroll ${String(body)}`);
    assert.deepEqual(enroll.body, { success: false, message: 'Thiếu course_id', code: 'BAD_REQUEST' });

    const complete = await respond(ctrl.completeBlocks, { body });
    assert.equal(complete.statusCode, 400, `complete-blocks ${String(body)}`);
    assert.deepEqual(complete.body, { success: false, message: 'Thiếu course_id hoặc block_ids', code: 'BAD_REQUEST' });
  }
  assert.equal(statements.length, 0, 'nothing was read');
  assert.equal(quiet.mock.callCount(), 0, 'no unexpected error');
});

test('a repeated courseIds on progress-batch is a 400 LEARNER_COURSE_IDS_INVALID, not a 500 on .split()', async t => {
  const statements = installDb(t);
  const res = await respond(ctrl.getBatchProgress, { query: { courseIds: ['c1,c2', 'c3'] } });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, {
    success: false,
    message: 'Danh sách khóa học không hợp lệ.',
    code: 'LEARNER_COURSE_IDS_INVALID',
    error: 'LEARNER_COURSE_IDS_INVALID',
  });
  assert.equal(statements.length, 0);

  const missing = await respond(ctrl.getBatchProgress, { query: {} });
  assert.deepEqual(missing.body, { success: false, message: 'Thiếu courseIds', code: 'BAD_REQUEST' });
});

test('a page that is not a number reads as the default page, never a NaN LIMIT or OFFSET', async t => {
  const statements = installDb(t);
  const handlers: Array<[string, Handler]> = [
    ['courses', ctrl.listCourses],
    ['library documents', ctrl.getLibraryDocuments],
    ['notifications', ctrl.listNotifications],
  ];
  for (const [name, handler] of handlers) {
    statements.length = 0;
    const res = await respond(handler, { query: { page: 'x', page_size: 'y' } });
    assert.equal(res.statusCode, 200, name);
    const odd = statements.map(entry => entry.params);
    for (const params of odd) {
      for (const value of params) assert.ok(!Number.isNaN(value), `${name}: a NaN parameter`);
    }
    statements.length = 0;
    await respond(handler, { query: {} });
    assert.deepEqual(odd, statements.map(entry => entry.params), `${name}: same statements as without a page`);
  }
});
