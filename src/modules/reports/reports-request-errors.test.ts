import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { Request, Response } from 'express';

// Reports routes answer a bad request with its 4xx and a plain message, never
// a 500: the date range and chart window checks throw AppErrors, the shared
// scope check's `{ status, message, code }` objects become AppErrors on these
// routes, and the learner list refuses a missing status instead of filtering
// on the text 'undefined'. pg double; no database, no Redis, no network.

const pg = await import('pg');
const { pool } = await import('../../config/database.js');
const { endReportsPool } = await import('../../config/reports-database.js');
const { errorHandler, AppError } = await import('../../middleware/error-handler.js');
const ctrl = await import('./reports.controller.js');
const svc = await import('./reports.service.js');

test.after(async () => {
  await endReportsPool();
  await pool.end();
});

const TENANT = '11111111-1111-4111-8111-111111111111';
const GROUP = 'a0000000-0000-4000-8000-000000000001';
const OTHER_GROUP = 'a0000000-0000-4000-8000-000000000002';
const UNKNOWN_GROUP = 'a0000000-0000-4000-8000-000000000009';

interface FakeResponse {
  statusCode: number;
  body: any;
  headersSent: boolean;
  headers: Record<string, string>;
  status(code: number): FakeResponse;
  json(body: unknown): FakeResponse;
  setHeader(name: string, value: string): void;
}

function fakeResponse(): FakeResponse {
  return {
    statusCode: 200,
    body: undefined,
    headersSent: false,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; this.headersSent = true; return this; },
    setHeader(name, value) { this.headers[name] = value; },
  };
}

function fakeRequest(query: Record<string, string>, role = 'admin'): Request {
  return {
    user: { id: 'u-admin', tenantId: TENANT, role },
    query,
    params: {},
    get: () => undefined,
  } as unknown as Request;
}

/** The handler, then the global error handler for whatever it threw (as Express does). */
async function respond(handler: (req: Request, res: Response) => Promise<unknown>, req: Request) {
  const res = fakeResponse();
  try {
    await handler(req, res as unknown as Response);
  } catch (error) {
    errorHandler(error as Error, req, res as unknown as Response, () => undefined);
  }
  return res;
}

function installDb(t: TestContext, answer: (text: string, params: unknown[]) => unknown = () => undefined) {
  const statements: Array<{ text: string; params: unknown[] }> = [];
  t.mock.method(pg.default.Pool.prototype, 'query', async (text: string, params: unknown[] = []) => {
    statements.push({ text, params });
    return answer(text, params) ?? { rows: [], rowCount: 0 };
  });
  return statements;
}

test('a date range or chart window the checks refuse is a 400 with a plain message, not a 500', async (t) => {
  installDb(t);
  const cases: Array<[(req: Request, res: Response) => Promise<unknown>, Record<string, string>, string]> = [
    [ctrl.getSummary, { date_from: '2026-09-01' }, 'Vui lòng chọn cả ngày bắt đầu và ngày kết thúc.'],
    [ctrl.getSummary, { date_from: '2026-9-1', date_to: '2026-09-30' }, 'Ngày bắt đầu hoặc ngày kết thúc không hợp lệ.'],
    [ctrl.getSummary, { date_from: '2026-13-01', date_to: '2026-13-31' }, 'Khoảng ngày không hợp lệ.'],
    [ctrl.getSummary, { date_from: '2026-09-30', date_to: '2026-09-01' }, 'Ngày bắt đầu không được sau ngày kết thúc.'],
    [ctrl.getChart, { date_from: '2026-09-01', date_to: '2026-09-30', mode: 'window', direction: 'sideways' }, 'Hướng xem tiếp của biểu đồ không hợp lệ.'],
    [ctrl.getChart, { date_from: '2026-09-01', date_to: '2026-09-30', mode: 'window', anchor_bucket: '09/2026' }, 'Mốc thời gian của biểu đồ không hợp lệ.'],
    [ctrl.getLearners, { date_to: '2026-09-30', status: 'all' }, 'Vui lòng chọn cả ngày bắt đầu và ngày kết thúc.'],
  ];
  for (const [handler, query, message] of cases) {
    const res = await respond(handler, fakeRequest(query));
    assert.equal(res.statusCode, 400, JSON.stringify(query));
    assert.deepEqual(res.body, { success: false, message }, JSON.stringify(query));
  }
});

test('a scope the shared check refuses keeps its 4xx, message and code on the Reports routes', async (t) => {
  installDb(t, (text, params) => {
    if (text.includes('FROM team_members tm')) return { rows: [{ group_id: GROUP }], rowCount: 1 };
    if (text.includes('FROM org_groups WHERE id = $1')) {
      return params[0] === UNKNOWN_GROUP ? { rows: [], rowCount: 0 } : { rows: [{ group_id: params[0] }], rowCount: 1 };
    }
    return undefined;
  });
  const unknownGroup = await respond(ctrl.getSummary, fakeRequest({ group_id: UNKNOWN_GROUP }));
  assert.equal(unknownGroup.statusCode, 400);
  assert.deepEqual(unknownGroup.body, {
    success: false, message: 'Nhóm không hợp lệ hoặc không thuộc doanh nghiệp hiện tại', code: 'REPORT_SCOPE_INVALID',
  });

  const notTheirGroup = await respond(ctrl.getLearners, fakeRequest({ group_id: OTHER_GROUP, status: 'all' }, 'learner_plus'));
  assert.equal(notTheirGroup.statusCode, 403);
  assert.deepEqual(notTheirGroup.body, {
    success: false, message: 'Bạn không có quyền xem báo cáo của nhóm này', code: 'REPORT_SCOPE_FORBIDDEN',
  });

  // Only plain 4xx objects are converted; errors and anything else pass through unchanged.
  const failure = new Error('database down');
  assert.equal(ctrl.asReportRequestError(failure), failure);
  const notClient = { status: 500, message: 'x' };
  assert.equal(ctrl.asReportRequestError(notClient), notClient);
  const converted = ctrl.asReportRequestError({ status: 404, message: 'Không tìm thấy' });
  assert.ok(converted instanceof AppError);
  assert.equal((converted as InstanceType<typeof AppError>).statusCode, 404);
});

test('the learner list needs a status (the dashboard always sends one); a missing one is a 400', async (t) => {
  const statements = installDb(t);
  const missing: Array<Record<string, string>> = [
    { date_from: '2026-09-01', date_to: '2026-09-30' },
    { date_from: '2026-09-01', date_to: '2026-09-30', status: '' },
  ];
  for (const query of missing) {
    const res = await respond(ctrl.getLearners, fakeRequest(query));
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, { success: false, message: 'Vui lòng chọn trạng thái học tập để xem danh sách học viên.' });
  }
  assert.equal(statements.length, 0, 'nothing was read');

  const listed = await respond(ctrl.getLearners, fakeRequest({ date_from: '2026-09-01', date_to: '2026-09-30', status: 'all' }));
  assert.equal(listed.statusCode, 200);
  const learnerSql = statements.find((entry) => entry.text.includes('learner_status'))!.text;
  assert.doesNotMatch(learnerSql, /WHERE learner_status\.status = /, "'all' adds no status filter");
});

test('the learner list service never filters on the text undefined', async (t) => {
  const statements = installDb(t);
  const range = {
    startDate: new Date('2026-08-01T00:00:00.000+07:00'), endDate: new Date('2026-08-31T23:59:59.999+07:00'),
    dateFrom: '2026-08-01', dateTo: '2026-08-31',
  };
  await svc.getReportLearners(TENANT, 1, 20, undefined, undefined, undefined, undefined, undefined, undefined, undefined, range);
  const learnerSql = statements.find((entry) => entry.text.includes('learner_status'))!.text;
  assert.doesNotMatch(learnerSql, /'undefined'/);
  assert.doesNotMatch(learnerSql, /WHERE learner_status\.status = /);

  statements.length = 0;
  await svc.getReportLearners(TENANT, 1, 20, undefined, undefined, undefined, undefined, undefined, undefined, 'completed', range);
  assert.match(statements.find((entry) => entry.text.includes('learner_status'))!.text, /WHERE learner_status\.status = 'completed'/);
});
