import assert from 'node:assert/strict';
import test from 'node:test';
import type { Request, Response } from 'express';
import { createReportPdfHandlers, REPORT_PDF_ERRORS } from './report-pdf.controller.js';
import { ReportPdfExportError, type ReportPdfExportApi } from './report-pdf-export.service.js';

const CONVERSATION = '33333333-3333-4333-8333-333333333333';
const MESSAGE = '44444444-4444-4444-8444-444444444444';
const JOB = '55555555-5555-4555-8555-555555555555';

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
  }));
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
  }));
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
