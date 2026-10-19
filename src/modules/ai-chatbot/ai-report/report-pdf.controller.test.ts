import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { Request, Response } from 'express';
import { createReportPdfHandlers, REPORT_PDF_ERRORS, type ReportPdfCreditGate } from './report-pdf.controller.js';
import { ReportPdfExportError, type ReportPdfExportApi } from './report-pdf-export.service.js';

const CONVERSATION = '33333333-3333-4333-8333-333333333333';
const MESSAGE = '44444444-4444-4444-8444-444444444444';
const JOB = '55555555-5555-4555-8555-555555555555';
const TENANT = '11111111-1111-4111-8111-111111111111';
/** AI points left: the export goes ahead (the credit check itself is tested at the end of this file). */
const allowed: ReportPdfCreditGate = { exhausted: async () => false };

function request(input: { locale?: string; params?: Record<string, string>; body?: unknown; query?: Record<string, string>; sessionMode?: string }): Request {
  return {
    params: { id: CONVERSATION, ...input.params },
    body: input.body ?? {},
    query: input.query ?? {},
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
    user: { id: '22222222-2222-4222-8222-222222222222', tenantId: '11111111-1111-4111-8111-111111111111', role: 'staff', username: 'manager', sessionMode: input.sessionMode ?? 'normal' },
    get: (name: string) => (name.toLowerCase() === 'x-ui-locale' ? input.locale : undefined),
  } as unknown as Request;
}

function response() {
  const state: { status: number; headers: Record<string, string>; json: unknown; body: unknown } = { status: 200, headers: {}, json: null, body: null };
  const res = {
    get statusCode() { return state.status; },
    setHeader: (name: string, value: string) => { state.headers[name.toLowerCase()] = value; },
    status: (code: number) => { state.status = code; return res; },
    json: (payload: unknown) => { state.json = payload; return res; },
    send: (payload: unknown) => { state.body = payload; return res; },
  };
  return { res: res as unknown as Response, state };
}

function service(overrides: Partial<ReportPdfExportApi>): () => ReportPdfExportApi {
  return () => ({
    buildArtifact: async () => { throw new Error('unused'); },
    start: async () => { throw new Error('unused'); },
    get: async () => { throw new Error('unused'); },
    download: async () => { throw new Error('unused'); },
    exportNow: async () => { throw new Error('unused'); },
    ...overrides,
  }) as ReportPdfExportApi;
}

test('maps every export error code to [status, vi, en]', () => {
  for (const [code, [status, vi, en]] of Object.entries(REPORT_PDF_ERRORS)) {
    assert.ok(status >= 400 && status < 600, code);
    assert.ok(vi.trim() && en.trim() && vi !== en, code);
  }
});

test('rejects invalid identifiers with a localized message and request id', async () => {
  const handlers = createReportPdfHandlers(service({}));
  const { res, state } = response();
  await handlers.startReportPdfJob(request({ locale: 'en', params: { id: 'not-a-uuid' }, body: { assistant_message_id: MESSAGE } }), res);
  assert.equal(state.status, 400);
  assert.deepEqual({ ...(state.json as Record<string, unknown>), request_id: undefined }, { success: false, code: 'REPORT_PDF_INVALID_REQUEST', message: 'The PDF export request is invalid.', request_id: undefined });
  assert.equal(state.headers['x-request-id'], (state.json as { request_id: string }).request_id);
});

test('passes the requested PDF locale and returns 202 with the job status', async () => {
  let seenLocale: string | null = null;
  const handlers = createReportPdfHandlers(service({
    start: async (input) => { seenLocale = input.locale; return { id: JOB, phase: 'validating', locale: input.locale, fileName: null, expiresAt: null, errorCode: null, updatedAt: '2026-10-08T00:00:00.000Z' }; },
  }), allowed);
  const fromBody = response();
  await handlers.startReportPdfJob(request({ locale: 'vi', body: { assistant_message_id: MESSAGE, locale: 'en' } }), fromBody.res);
  assert.equal(fromBody.state.status, 202);
  assert.equal(seenLocale, 'en');
  const fromHeader = response();
  await handlers.startReportPdfJob(request({ locale: 'en-US', body: { assistant_message_id: MESSAGE } }), fromHeader.res);
  assert.equal(seenLocale, 'en');
  const fallback = response();
  await handlers.startReportPdfJob(request({ body: { assistant_message_id: MESSAGE } }), fallback.res);
  assert.equal(seenLocale, 'vi');
});

test('localizes service errors and forwards Retry-After for rate limits', async () => {
  const handlers = createReportPdfHandlers(service({
    start: async () => { throw new ReportPdfExportError('limited', 429, 'REPORT_PDF_RATE_LIMITED', 120); },
  }), allowed);
  const { res, state } = response();
  await handlers.startReportPdfJob(request({ body: { assistant_message_id: MESSAGE } }), res);
  assert.equal(state.status, 429);
  assert.equal(state.headers['retry-after'], '120');
  assert.equal((state.json as { message: string }).message, REPORT_PDF_ERRORS.REPORT_PDF_RATE_LIMITED[1]);
});

test('streams the PDF with a safe attachment file name and blocks demo sessions', async () => {
  const handlers = createReportPdfHandlers(service({
    download: async () => ({ pdf: Buffer.from('%PDF-1.7'), fileName: 'learning-performance-report_2026-08-01_to_2026-08-31.pdf' }),
  }));
  const ok = response();
  await handlers.downloadReportPdfJob(request({ params: { jobId: JOB }, query: { assistant_message_id: MESSAGE } }), ok.res);
  assert.equal(ok.state.headers['content-type'], 'application/pdf');
  assert.match(ok.state.headers['content-disposition'], /^attachment; filename="learning-performance-report_2026-08-01_to_2026-08-31\.pdf"/);
  assert.equal(ok.state.headers['cache-control'], 'no-store');
  const demo = response();
  await handlers.downloadReportPdfJob(request({ params: { jobId: JOB }, query: { assistant_message_id: MESSAGE }, sessionMode: 'demo_iframe', locale: 'en' }), demo.res);
  assert.equal(demo.state.status, 403);
  assert.equal((demo.state.json as { code: string }).code, 'REPORT_PDF_DEMO_SESSION');
});

// --- AI points: no new PDF export while the tenant's points of the month are spent ----------------

const LIMIT_VI = 'Đã dùng hết điểm AI của tháng này. Liên hệ quản trị viên để mua thêm điểm.';
const LIMIT_EN = "This month's AI points are used up. Contact your administrator to buy more points.";

/** The credit month row the database answers (null: no row this month); every SQL text is kept. */
function creditMonth(t: TestContext, row: Record<string, unknown> | null) {
  const sqls: string[] = [];
  return import('pg').then((pg) => {
    t.mock.method(pg.default.Pool.prototype, 'query', async (text: string, values: unknown[] = []) => {
      sqls.push(text);
      if (text.includes('FROM tenant_ai_settings')) return { rows: [{ token_timezone: 'Asia/Ho_Chi_Minh' }], rowCount: 1 };
      if (text.includes('FROM ai_credit_monthly')) {
        assert.equal(values[0], TENANT);
        assert.match(String(values[1]), /^\d{4}-\d{2}-01$/);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    return sqls;
  });
}
const MONTH = { plan_id: null, plan_code: 'basic', plan_name: 'Basic', plan_points: '1000', topup_points: '0', is_unlimited: false,
  fx_vnd_per_usd: '25000', point_value_usd: '0.01', budget_usd: '10', used_usd: '0', reserved_usd: '0', revenue_vnd: '0',
  warned_80_at: null, warned_100_at: null };

function recordingService() {
  const calls = { start: 0, exportNow: 0, get: 0, download: 0 };
  const api = service({
    start: async (input) => { calls.start++; return { id: JOB, phase: 'validating', locale: input.locale, fileName: null, expiresAt: null, errorCode: null, updatedAt: '2026-10-19T00:00:00.000Z' }; },
    exportNow: async () => { calls.exportNow++; return { pdf: Buffer.from('%PDF-1.7'), fileName: 'report.pdf' }; },
    get: async () => { calls.get++; return { id: JOB, phase: 'ready', locale: 'vi', fileName: 'report.pdf', expiresAt: null, errorCode: null, updatedAt: '2026-10-19T00:00:00.000Z' }; },
    download: async () => { calls.download++; return { pdf: Buffer.from('%PDF-1.7'), fileName: 'report.pdf' }; },
  });
  return { calls, api };
}

test('AI points spent: a new PDF export (job or direct) is a 429 AI_CREDIT_LIMIT_REACHED and no job is created', async (t) => {
  const sqls = await creditMonth(t, { ...MONTH, used_usd: '9.5', reserved_usd: '0.5' });
  const logs: string[] = [];
  t.mock.method(console, 'info', (line: string) => { logs.push(line); });
  const { calls, api } = recordingService();
  const handlers = createReportPdfHandlers(api);
  for (const [locale, message] of [['vi', LIMIT_VI], ['en', LIMIT_EN]] as const) {
    for (const handle of [handlers.startReportPdfJob, handlers.exportReportPdf]) {
      const { res, state } = response();
      await handle(request({ locale, body: { assistant_message_id: MESSAGE } }), res);
      assert.equal(state.status, 429);
      const body = state.json as Record<string, unknown>;
      assert.deepEqual({ ...body, request_id: undefined }, { success: false, code: 'AI_CREDIT_LIMIT_REACHED', message, request_id: undefined });
      assert.equal(state.body, null, 'no PDF sent');
    }
  }
  assert.deepEqual(calls, { start: 0, exportNow: 0, get: 0, download: 0 });
  assert.equal(sqls.every((sql) => /^\s*SELECT\b/.test(sql)), true, 'read-only: no month row created, nothing reserved');
  const refusal = JSON.parse(logs.at(-1)!.replace('[ReportPdf] ', '')) as Record<string, unknown>;
  assert.equal(refusal.code, 'AI_CREDIT_LIMIT_REACHED');
  assert.equal(refusal.http_status, 429);
  assert.doesNotMatch(logs.join('\n'), /điểm AI|AI points|9\.5/);
});

test('AI points: an unlimited, an unvalued, an under-budget month or no month row yet allows the export', async (t) => {
  const months: Array<[string, Record<string, unknown> | null]> = [
    ['unlimited', { ...MONTH, is_unlimited: true, budget_usd: null, point_value_usd: null, used_usd: '99', reserved_usd: '5' }],
    ['unvalued', { ...MONTH, budget_usd: null, point_value_usd: null, used_usd: '99', reserved_usd: '5' }],
    ['under budget', { ...MONTH, used_usd: '9', reserved_usd: '0.5' }],
    ['no month row', null],
  ];
  for (const [name, row] of months) {
    await t.test(name, async (st) => {
      await creditMonth(st, row);
      const { calls, api } = recordingService();
      const handlers = createReportPdfHandlers(api);
      const job = response();
      await handlers.startReportPdfJob(request({ body: { assistant_message_id: MESSAGE } }), job.res);
      assert.equal(job.state.status, 202, name);
      const direct = response();
      await handlers.exportReportPdf(request({ body: { assistant_message_id: MESSAGE } }), direct.res);
      assert.equal(direct.state.headers['content-type'], 'application/pdf', name);
      assert.deepEqual(calls, { start: 1, exportNow: 1, get: 0, download: 0 });
    });
  }
});

test('AI points spent: a job that already finished keeps its status and download', async (t) => {
  const sqls = await creditMonth(t, { ...MONTH, used_usd: '10', reserved_usd: '0' });
  const { calls, api } = recordingService();
  const handlers = createReportPdfHandlers(api);
  const status = response();
  await handlers.getReportPdfJob(request({ params: { jobId: JOB }, query: { assistant_message_id: MESSAGE } }), status.res);
  assert.equal(status.state.status, 200);
  assert.equal(((status.state.json as { data: { phase: string } }).data).phase, 'ready');
  const download = response();
  await handlers.downloadReportPdfJob(request({ params: { jobId: JOB }, query: { assistant_message_id: MESSAGE } }), download.res);
  assert.equal(download.state.headers['content-type'], 'application/pdf');
  assert.deepEqual(calls, { start: 0, exportNow: 0, get: 1, download: 1 });
  assert.equal(sqls.length, 0, 'the AI points month is not read for status or download');
});
