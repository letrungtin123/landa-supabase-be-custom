import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { Request, Response } from 'express';

// POST /api/reports/refresh answers success only when the summary was really
// refreshed; a failed refresh is an error with a plain message and writes no
// "refreshed" audit record. The rebuild covers every tenant, so calls during a
// rebuild share it, and a call within a minute of a successful rebuild
// rebuilds nothing. pg double; no database, no Redis, no network.

const pg = await import('pg');
const { pool } = await import('../../config/database.js');
const { endReportsPool } = await import('../../config/reports-database.js');
const { errorHandler } = await import('../../middleware/error-handler.js');
const ctrl = await import('./reports.controller.js');
const refresh = await import('./report-summary-refresh.service.js');

test.beforeEach(() => refresh.forgetReportSummaryRefresh());

test.after(async () => {
  await endReportsPool();
  await pool.end();
});

const TENANT = '11111111-1111-4111-8111-111111111111';
const ADMIN = 'a0000000-0000-4000-8000-000000000001';

interface FakeResponse {
  statusCode: number;
  body: unknown;
  headersSent: boolean;
  status(code: number): FakeResponse;
  json(body: unknown): FakeResponse;
  setHeader(name: string, value: string): void;
}

function fakeResponse(): FakeResponse {
  return {
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
}

function fakeRequest(locale?: string): Request {
  return {
    user: { id: ADMIN, tenantId: TENANT, role: 'admin', username: 'admin' },
    query: {},
    params: {},
    ip: '127.0.0.1',
    socket: {},
    get: (name: string) => (name.toLowerCase() === 'x-ui-locale' ? locale : undefined),
  } as unknown as Request;
}

/** The handler, then the global error handler for whatever it threw (as Express does). */
async function respond(req: Request) {
  const res = fakeResponse();
  try {
    await ctrl.refreshSummary(req, res as unknown as Response);
  } catch (error) {
    errorHandler(error as Error, req, res as unknown as Response, () => undefined);
  }
  return res;
}

function installDb(t: TestContext, refresh: () => Promise<void>) {
  const statements: string[] = [];
  const handle = async (text: string | { text: string }) => {
    const sql = typeof text === 'string' ? text : text.text;
    statements.push(sql);
    if (sql.includes('refresh_report_summary()')) await refresh();
    return { rows: [], rowCount: 0 };
  };
  t.mock.method(pg.default.Pool.prototype, 'query', handle);
  t.mock.method(pg.default.Pool.prototype, 'connect', async () => ({ query: handle, release: () => undefined }));
  return statements;
}

function captureConsoleError(t: TestContext): string[] {
  const lines: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  return lines;
}

test('a successful refresh answers as before and records the audit event', async t => {
  const statements = installDb(t, async () => {});
  const res = await respond(fakeRequest());
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { success: true, data: { message: 'Report summary refreshed' } });
  assert.ok(statements.some(sql => sql.includes('refresh_report_summary()')));
  assert.ok(
    statements.some(sql => /INSERT INTO audit_logs/.test(sql)),
    'the refresh is audited',
  );
});

test('a failed refresh is a 503 with a plain message, not a success, and is not audited', async t => {
  const failure = Object.assign(new Error('function refresh_report_summary() does not exist'), { code: '42883' });
  const statements = installDb(t, async () => {
    throw failure;
  });
  const logged = captureConsoleError(t);

  const res = await respond(fakeRequest());
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, {
    success: false,
    message: 'Không làm mới được báo cáo, vui lòng thử lại sau.',
    code: 'REPORT_SUMMARY_REFRESH_FAILED',
  });
  assert.equal(
    statements.some(sql => /INSERT INTO audit_logs/.test(sql)),
    false,
    'no "refreshed" audit record',
  );

  // The failure is logged with its kind only: no database text.
  const line = logged.find(entry => entry.includes('report_summary_refresh_failed'));
  assert.ok(line, 'the failure is logged');
  assert.match(line, /"error_kind":"Error:42883"/);
  assert.match(line, new RegExp(`"tenant_id":"${TENANT}"`));
  assert.doesNotMatch(line, /does not exist/);

  const english = await respond(fakeRequest('en'));
  assert.equal(english.statusCode, 503);
  assert.deepEqual(english.body, {
    success: false,
    message: 'The report could not be refreshed. Please try again later.',
    code: 'REPORT_SUMMARY_REFRESH_FAILED',
  });
});

const refreshCount = (statements: string[]) => statements.filter(sql => sql.includes('refresh_report_summary()')).length;
const auditCount = (statements: string[]) => statements.filter(sql => /INSERT INTO audit_logs/.test(sql)).length;

/** A rebuild that finishes only when `finish()` (or `fail(error)`) is called. */
function heldRebuild() {
  let finish: () => void = () => undefined;
  let fail: (error: Error) => void = () => undefined;
  let started = 0;
  const run = () => {
    started++;
    return new Promise<void>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
  };
  return { run, started: () => started, finish: () => finish(), fail: (error: Error) => fail(error) };
}

test('parallel refresh calls share one rebuild and all answer success', async t => {
  const rebuild = heldRebuild();
  const statements = installDb(t, rebuild.run);
  const calls = Array.from({ length: 6 }, () => respond(fakeRequest()));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(rebuild.started(), 1, 'one rebuild for six calls');
  rebuild.finish();
  const answers = await Promise.all(calls);
  for (const res of answers) {
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { success: true, data: { message: 'Report summary refreshed' } });
  }
  assert.equal(refreshCount(statements), 1);
  assert.equal(auditCount(statements), 6, 'every caller of the shared rebuild is audited');
});

test('a refresh within a minute of a successful one rebuilds nothing', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-19T01:00:00.000Z') });
  const statements = installDb(t, async () => {});
  assert.equal((await respond(fakeRequest())).statusCode, 200);
  assert.equal(refreshCount(statements), 1);

  t.mock.timers.tick(59_999);
  const recent = await respond(fakeRequest());
  assert.equal(recent.statusCode, 200);
  assert.deepEqual(recent.body, {
    success: true,
    data: { message: 'Report summary refreshed', skipped_recent: true },
  });
  assert.equal(refreshCount(statements), 1, 'no second rebuild');
  assert.equal(auditCount(statements), 1, 'a skipped call is not audited');

  t.mock.timers.tick(1);
  const later = await respond(fakeRequest());
  assert.deepEqual(later.body, { success: true, data: { message: 'Report summary refreshed' } });
  assert.equal(refreshCount(statements), 2, 'a minute after the last rebuild, it rebuilds again');
});

test('a failed shared rebuild fails every waiting call, and the next call rebuilds again', async t => {
  const rebuild = heldRebuild();
  const statements = installDb(t, rebuild.run);
  captureConsoleError(t);
  const calls = Array.from({ length: 4 }, () => respond(fakeRequest()));
  await new Promise(resolve => setImmediate(resolve));
  rebuild.fail(Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }));
  const answers = await Promise.all(calls);
  for (const res of answers) {
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.body, {
      success: false,
      message: 'Không làm mới được báo cáo, vui lòng thử lại sau.',
      code: 'REPORT_SUMMARY_REFRESH_FAILED',
    });
  }
  assert.equal(rebuild.started(), 1);
  assert.equal(auditCount(statements), 0);

  // No cooldown after a failure: the next call rebuilds.
  const next = respond(fakeRequest());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(rebuild.started(), 2);
  rebuild.finish();
  assert.equal((await next).statusCode, 200);
});

test('the refresher shares a running rebuild and honours the cooldown from its finish', async () => {
  let clock = 1_000;
  let rebuilds = 0;
  const refresher = refresh.createReportSummaryRefresher({
    rebuild: async () => {
      rebuilds++;
      clock += 5_000; // the rebuild takes 5 s
    },
    cooldownMs: 60_000,
    now: () => clock,
  });
  const outcomes = await Promise.all([refresher.refresh(), refresher.refresh(), refresher.refresh()]);
  assert.deepEqual(outcomes, [{ skippedRecent: false }, { skippedRecent: false }, { skippedRecent: false }]);
  assert.equal(rebuilds, 1);
  clock += 59_999;
  assert.deepEqual(await refresher.refresh(), { skippedRecent: true });
  clock += 1;
  assert.deepEqual(await refresher.refresh(), { skippedRecent: false });
  assert.equal(rebuilds, 2);
  assert.equal(refresh.REPORT_SUMMARY_REFRESH_COOLDOWN_MS, 60_000);
});
