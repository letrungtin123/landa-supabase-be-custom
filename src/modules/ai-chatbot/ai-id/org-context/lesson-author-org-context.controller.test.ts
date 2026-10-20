import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import type { AuthUser } from '../../../../types/express.js';
import { AppError } from '../../../../middleware/error-handler.js';
import { ORG_CONTEXT_ERRORS, createOrgContextHandlers, type OrgContextDiagnostic } from './lesson-author-org-context.controller.js';
import { OrgContextError } from './lesson-author-org-context.logic.js';
import { ORG_CONTEXT_BASE_PATH, mountOrgContextRoutes } from './lesson-author-org-context.routes.js';
import type { OrgContextService } from './lesson-author-org-context.service.js';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const user: AuthUser = { id: uuid(1), tenantId: uuid(2), role: 'staff', username: 'author', sessionMode: 'normal' };

type Calls = Array<[string, unknown[]]>;
function fakeService(calls: Calls, failWith?: Error): OrgContextService {
  const answer = (name: string, value: unknown) => async (...args: unknown[]) => {
    calls.push([name, args]);
    if (failWith !== undefined) throw failWith;
    return value;
  };
  const service = {
    enabledFor: () => true,
    getState: answer('getState', { enabled: false }),
    uploadDocument: answer('uploadDocument', { id: uuid(9), name: 'a.pdf' }),
    deleteDocument: answer('deleteDocument', undefined),
    requestDistill: answer('requestDistill', { revision: 2, distill: { status: 'queued' } }),
    saveProfile: answer('saveProfile', { revision: 3, current: null, confirmed_version: null }),
    restoreProfile: answer('restoreProfile', { revision: 4, current: null }),
    readVersion: answer('readVersion', { version: 1 }),
    confirmedContext: answer('confirmedContext', null),
  };
  return service as unknown as OrgContextService;
}

async function call(handler: (req: Request, res: Response) => Promise<void>, input: { body?: unknown; params?: Record<string,
  string>; query?: Record<string, string>; file?: Partial<Express.Multer.File> } = {}) {
  let status = 200; let payload: Record<string, unknown> = {}; const headers: Record<string, string> = {};
  const req = { user, body: input.body, params: input.params ?? {}, query: input.query ?? {}, file: input.file,
    get: () => undefined, ip: '127.0.0.1', socket: {} } as unknown as Request;
  const res = { setHeader(key: string, value: string) { headers[key] = value; },
    status(code: number) { status = code; return this; }, json(value: Record<string, unknown>) { payload = value; return this; },
  } as unknown as Response;
  await handler(req, res);
  return { status, payload, headers };
}

test('success answers use the envelope; the service receives the parsed input and the request actor', async () => {
  const calls: Calls = [];
  const handlers = createOrgContextHandlers({ service: fakeService(calls), report: () => undefined });
  const state = await call(handlers.state);
  assert.deepEqual([state.status, state.payload.success, state.payload.data], [200, true, { enabled: false }]);
  assert.equal(state.headers['Cache-Control'], 'no-store');
  assert.match(state.headers['X-Request-ID']!, /^[0-9a-f-]{36}$/);
  const distill = await call(handlers.distill, { body: { expected_revision: 1, locale: 'en' } });
  assert.deepEqual([distill.status, distill.payload.data], [202, { revision: 2, distill: { status: 'queued' } }]);
  assert.deepEqual(calls.at(-1), ['requestDistill', [{ tenantId: user.tenantId, userId: user.id, username: 'author',
    ipAddress: '127.0.0.1' }, { expected_revision: 1, locale: 'en' }]]);
  const removed = await call(handlers.deleteDocument, { params: { documentId: uuid(5) } });
  assert.deepEqual([removed.status, removed.payload.data], [202, { queued: true }]);
  const saved = await call(handlers.saveProfile, { body: { expected_revision: 2, profile: { a: 1 }, confirm: true } });
  assert.equal(saved.status, 200);
  assert.deepEqual(calls.at(-1)![1][1], { expected_revision: 2, profile: { a: 1 }, confirm: true });
  assert.equal((await call(handlers.restoreProfile, { body: { expected_revision: 3, version: 1 } })).status, 200);
  const version = await call(handlers.version, { params: { version: '12' } });
  assert.deepEqual([version.status, version.payload.data, calls.at(-1)], [200, { version: { version: 1 } },
    ['readVersion', [user.tenantId, 12]]]);
});

test('malformed input is refused before the service with plain messages in the request locale', async () => {
  const calls: Calls = [];
  const handlers = createOrgContextHandlers({ service: fakeService(calls), report: () => undefined });
  for (const body of [undefined, { expected_revision: 1 }, { expected_revision: -1, locale: 'vi' },
    { expected_revision: 1.5, locale: 'vi' }, { expected_revision: 1, locale: 'fr' }, { expected_revision: 1, locale: 'vi', x: 1 }]) {
    const answer = await call(handlers.distill, { body });
    assert.deepEqual([answer.status, answer.payload.code], [400, 'ORG_CONTEXT_INPUT_INVALID'], JSON.stringify(body));
  }
  assert.equal((await call(handlers.saveProfile, { body: { expected_revision: 1, profile: {}, confirm: 'yes' } })).status, 400);
  assert.equal((await call(handlers.restoreProfile, { body: { expected_revision: 1, version: 0 } })).status, 400);
  for (const value of ['0', '-1', 'abc', '1.5', '99999999999']) {
    const answer = await call(handlers.version, { params: { version: value } });
    assert.deepEqual([answer.status, answer.payload.code], [404, 'ORG_CONTEXT_VERSION_NOT_FOUND'], value);
  }
  const document = await call(handlers.deleteDocument, { params: { documentId: "1' OR 1=1" } });
  assert.deepEqual([document.status, document.payload.code], [404, 'ORG_CONTEXT_DOCUMENT_NOT_FOUND']);
  const huge = await call(handlers.saveProfile, { body: { expected_revision: 1, profile: { organization_summary: 'x'.repeat(300_000) },
    confirm: false } });
  assert.deepEqual([huge.status, huge.payload.code, huge.payload.details], [422, 'ORG_CONTEXT_PROFILE_INVALID',
    { path: 'profile', reason: 'total_too_long' }]);
  const none = await call(handlers.upload, {});
  assert.deepEqual([none.status, none.payload.code, none.payload.message], [400, 'ORG_CONTEXT_FILE_INVALID',
    'Hãy chọn một tệp tài liệu để tải lên.']);
  const video = await call(handlers.upload, { file: { originalname: 'clip.mp4', size: 10, path: '/tmp/x' },
    query: { ui_locale: 'en' } });
  assert.deepEqual([video.status, video.payload.message], [400, 'Only PDF, Word, PowerPoint, text or CSV files are supported.']);
  assert.equal(calls.length, 0, 'the service was never called');
  const uploaded = await call(handlers.upload, { file: { originalname: 'so-tay.docx', size: 10, path: '/tmp/x',
    mimetype: 'application/octet-stream' } });
  assert.deepEqual([uploaded.status, uploaded.payload.data], [201, { document: { id: uuid(9), name: 'a.pdf' } }]);
});

test('domain errors map to their status, code, details and message; unknown failures are logged by code only', async () => {
  const cases: Array<[Error, number, string, Record<string, unknown> | undefined]> = [
    [new OrgContextError('ORG_CONTEXT_REVISION_CONFLICT', { revision: 3 }), 409, 'ORG_CONTEXT_REVISION_CONFLICT', undefined],
    [new OrgContextError('ORG_CONTEXT_LIMIT_REACHED', { used_bytes: 52_428_800, limit_bytes: 52_428_800 }), 409,
      'ORG_CONTEXT_LIMIT_REACHED', { used_bytes: 52_428_800, limit_bytes: 52_428_800 }],
    [new OrgContextError('ORG_CONTEXT_PROFILE_INVALID', { path: 'profile.glossary[1].term', reason: 'too_long' }), 422,
      'ORG_CONTEXT_PROFILE_INVALID', { path: 'profile.glossary[1].term', reason: 'too_long' }],
    [new OrgContextError('ORG_CONTEXT_DISABLED'), 404, 'ORG_CONTEXT_DISABLED', undefined],
    [new OrgContextError('ORG_CONTEXT_DISTILL_RUNNING'), 409, 'ORG_CONTEXT_DISTILL_RUNNING', undefined],
    [Object.assign(new Error('quota'), { code: 'LQ001' }), 409, 'TENANT_DATA_LIMIT_REACHED', undefined],
    [Object.assign(new Error('reconciling'), { code: 'LQ002' }), 503, 'TENANT_DATA_QUOTA_RECONCILING', undefined],
    [new AppError('points', 429, 'AI_CREDIT_LIMIT_REACHED'), 429, 'AI_CREDIT_LIMIT_REACHED', undefined],
    [new AppError('Kho tri thuc dang khoi phuc', 409), 409, 'ORG_CONTEXT_NOT_READY', undefined],
    [new AppError('learning', 409, 'KB_DOCUMENT_LEARNING'), 409, 'KB_DOCUMENT_LEARNING', undefined],
  ];
  for (const [error, status, code, details] of cases) {
    const handlers = createOrgContextHandlers({ service: fakeService([], error), report: () => undefined });
    const answer = await call(handlers.saveProfile, { body: { expected_revision: 1, profile: {}, confirm: false } });
    assert.deepEqual([answer.status, answer.payload.code, answer.payload.details], [status, code, details], code);
    // The fixed messages; a profile problem has one per reason (below).
    if (code !== 'ORG_CONTEXT_PROFILE_INVALID') {
      assert.equal(answer.payload.message, ORG_CONTEXT_ERRORS[code as keyof typeof ORG_CONTEXT_ERRORS][1], code);
    }
  }
  const empty = createOrgContextHandlers({ service: fakeService([], new OrgContextError('ORG_CONTEXT_PROFILE_INVALID',
    { path: 'profile', reason: 'empty' })), report: () => undefined });
  const refused = await call(empty.saveProfile, { body: { expected_revision: 1, profile: {}, confirm: true },
    query: { ui_locale: 'en' } });
  assert.equal(refused.payload.message, 'The profile is empty, so it cannot be confirmed. Fill in at least one part.');
  const reports: OrgContextDiagnostic[] = [];
  const broken = createOrgContextHandlers({ service: fakeService([], Object.assign(new Error('relation "x" does not exist'),
    { code: '42P01' })), report: record => reports.push(record) });
  const failed = await call(broken.state);
  assert.deepEqual([failed.status, failed.payload.code], [503, 'ORG_CONTEXT_UNAVAILABLE']);
  assert.doesNotMatch(JSON.stringify(failed.payload), /relation/);
  assert.deepEqual({ ...reports[0], request_id: 'x' }, { event: 'org_context_request_failed', action: 'state', request_id: 'x',
    tenant_id: user.tenantId, error_code: 'ORG_CONTEXT_UNAVAILABLE', http_status: 503, internal_code: '42P01' });
});

test('every route needs the course data permission and an AI ID author before its handler', async () => {
  const calls: Calls = [];
  const router = Router();
  const gate = { permission: true, author: true };
  const coursePermission = async (_req: Request, res: Response, next: NextFunction) => {
    if (gate.permission) next(); else res.status(403).json({ code: 'FORBIDDEN' });
  };
  const author = async (_req: Request, res: Response, next: NextFunction) => {
    if (gate.author) next(); else res.status(403).json({ code: 'LESSON_AUTHOR_SESSION_COURSE_EDIT_REQUIRED' });
  };
  mountOrgContextRoutes(router, { coursePermission, author, service: fakeService(calls) });
  const routes = router.stack.map(layer => ({ path: layer.route?.path, methods: Object.keys(
    (layer.route as unknown as { methods: Record<string, boolean> }).methods), first: layer.route!.stack[0]!.handle }));
  assert.deepEqual(routes.map(route => `${route.methods.join()} ${route.path}`), [
    `get ${ORG_CONTEXT_BASE_PATH}`, `post ${ORG_CONTEXT_BASE_PATH}/documents`,
    `delete ${ORG_CONTEXT_BASE_PATH}/documents/:documentId`, `post ${ORG_CONTEXT_BASE_PATH}/profile/distill`,
    `put ${ORG_CONTEXT_BASE_PATH}/profile`, `post ${ORG_CONTEXT_BASE_PATH}/profile/restore`,
    `get ${ORG_CONTEXT_BASE_PATH}/profile/versions/:version`]);
  assert.ok(routes.every(route => route.first.name === 'coursePermission'), 'the permission guard runs first');
  assert.ok(router.stack.every(layer => layer.route!.stack[1]!.handle.name === 'author'), 'then the author guard');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use('/api/ai-chatbot', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ai-chatbot${ORG_CONTEXT_BASE_PATH}`;
  try {
    const requests: Array<[string, string, unknown?]> = [['GET', ''], ['POST', '/profile/distill', { expected_revision: 0, locale: 'vi' }],
      ['PUT', '/profile', { expected_revision: 0, profile: {}, confirm: false }], ['POST', '/profile/restore',
        { expected_revision: 0, version: 1 }], ['GET', '/profile/versions/1'], ['DELETE', `/documents/${uuid(4)}`],
      ['POST', '/documents']];
    for (const denied of ['permission', 'author'] as const) {
      gate.permission = denied !== 'permission'; gate.author = denied !== 'author';
      for (const [method, path, body] of requests) {
        const reply = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' },
          ...(body ? { body: JSON.stringify(body) } : {}) });
        assert.equal(reply.status, 403, `${denied}: ${method} ${path}`);
        await reply.arrayBuffer();
      }
    }
    assert.equal(calls.length, 0);
    gate.permission = true; gate.author = true;
    const allowed = await fetch(base);
    assert.equal(allowed.status, 200);
    assert.deepEqual(calls.map(([name]) => name), ['getState']);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
