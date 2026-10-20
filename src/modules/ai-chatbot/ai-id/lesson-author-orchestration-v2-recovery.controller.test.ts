import assert from 'node:assert/strict';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { AuthUser } from '../../../types/express.js';
import {
  ORCHESTRATION_V2_RECOVERY_ERRORS,
  createOrchestrationV2RecoveryHandlers,
  orchestrationV2RecoveryRoute,
  type OrchestrationV2RecoveryDiagnostic,
} from './lesson-author-orchestration-v2-recovery.controller.js';
import {
  ORCHESTRATION_V2_RECOVERY_ERROR_CODES,
  OrchestrationV2RecoveryError,
} from './lesson-author-orchestration-v2-recovery.logic.js';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const staff: AuthUser = { id: uuid(1), tenantId: uuid(2), role: 'staff', sessionMode: 'normal', username: 'author' };
const WORKSPACE = uuid(3), CONVERSATION = uuid(4), COURSE = 'course-v1:TEST+RECOVERY+2026', OPERATION = uuid(9);
const base = `/courses/${encodeURIComponent(COURSE)}/conversations/${CONVERSATION}/workspaces/${WORKSPACE}`;

async function server(service: Record<string, (...args: never[]) => Promise<unknown>>, user: AuthUser | null = staff) {
  const logs: OrchestrationV2RecoveryDiagnostic[] = [];
  const handlers = createOrchestrationV2RecoveryHandlers({ service: service as never, report: record => logs.push(record) });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (user) req.user = user; next(); });
  app.get('/courses/:courseId/conversations/:conversationId/workspaces/:workspaceId/recovery', orchestrationV2RecoveryRoute(handlers.describe));
  app.post('/courses/:courseId/conversations/:conversationId/workspaces/:workspaceId/stop', orchestrationV2RecoveryRoute(handlers.stop));
  const listener = app.listen(0);
  await new Promise(resolve => listener.once('listening', resolve));
  const url = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  return {
    logs,
    close: () => new Promise(resolve => listener.close(resolve)),
    call: async (method: 'GET' | 'POST', path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const response = await fetch(url + path, { method, headers: { 'content-type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, headers: response.headers, json: await response.json() as Record<string, unknown> };
    },
  };
}

test('error table: every recovery code has a status and plain VI/EN words without codes or jargon', () => {
  for (const code of ORCHESTRATION_V2_RECOVERY_ERROR_CODES) {
    const [status, vi, en] = ORCHESTRATION_V2_RECOVERY_ERRORS[code];
    assert.ok(status >= 400 && status < 600, code);
    for (const text of [vi, en]) {
      assert.ok(text.trim().length > 10, code);
      assert.doesNotMatch(text, /[A-Z]{2,}_[A-Z_]+|\b(?:40\d|42\d|50\d)\b|workspace|revision|hash|lock|snapshot|run_id/i,
        `${code}: ${text}`);
    }
  }
  assert.equal(ORCHESTRATION_V2_RECOVERY_ERRORS.RECOVERY_DISABLED[0], 503);
  assert.equal(ORCHESTRATION_V2_RECOVERY_ERRORS.RECOVERY_FORBIDDEN[0], 403);
  assert.equal(ORCHESTRATION_V2_RECOVERY_ERRORS.RECOVERY_STATE_CHANGED[0], 409);
  assert.equal(ORCHESTRATION_V2_RECOVERY_ERRORS.RUN_STOP_NOT_ACTIVE[0], 409);
  assert.equal(ORCHESTRATION_V2_RECOVERY_ERRORS.AI_CREDIT_INSUFFICIENT_FOR_RECOVERY[0], 429);
  assert.equal(ORCHESTRATION_V2_RECOVERY_ERRORS.RECOVERY_UNAVAILABLE[0], 503);
});

test('describe and stop: success envelope, request id, no-store and one log line', async () => {
  const seen: unknown[][] = [];
  const view = { run_id: uuid(20), run_status: 'executing' };
  const app = await server({
    describe: async (...args: never[]) => { seen.push(args); return view; },
    stop: async (...args: never[]) => { seen.push(args); return { recovery_id: null, run_id: uuid(20), action: 'stop',
      reopened_task_count: 0, workspace_status: 'drafting', replayed: false }; },
  });
  try {
    const read = await app.call('GET', `${base}/recovery?ui_locale=en`);
    assert.equal(read.status, 200);
    assert.deepEqual(read.json.data, view);
    assert.equal(read.headers.get('cache-control'), 'no-store');
    assert.equal(read.headers.get('x-request-id'), read.json.request_id);
    const stopped = await app.call('POST', `${base}/stop`, { operation_id: OPERATION });
    assert.equal(stopped.status, 200);
    assert.equal((stopped.json.data as Record<string, unknown>).action, 'stop');
    assert.deepEqual(seen[1]!.slice(1), [{ workspaceId: WORKSPACE, conversationId: CONVERSATION, courseId: COURSE },
      OPERATION]);
    assert.deepEqual(app.logs.map(log => [log.operation, log.event, log.http_status, log.run_id]),
      [['describe', 'workspace_recovery_completed', 200, uuid(20)], ['stop', 'workspace_recovery_completed', 200, uuid(20)]]);
    assert.equal(app.logs[1]!.operation_id, OPERATION);
    assert.match(String(app.logs[1]!.course_id_hash), /^[0-9a-f]{64}$/);
  } finally { await app.close(); }
});

test('input, actor and service errors map to the localized table', async () => {
  const app = await server({
    describe: async () => { throw new OrchestrationV2RecoveryError('RECOVERY_DISABLED'); },
    stop: async () => { throw new OrchestrationV2RecoveryError('RUN_STOP_NOT_ACTIVE'); },
  });
  try {
    const disabled = await app.call('GET', `${base}/recovery`, undefined, { 'X-UI-Locale': 'en' });
    assert.equal(disabled.status, 503);
    assert.equal(disabled.json.code, 'RECOVERY_DISABLED');
    assert.equal(disabled.json.message, ORCHESTRATION_V2_RECOVERY_ERRORS.RECOVERY_DISABLED[2]);
    const notActive = await app.call('POST', `${base}/stop`, { operation_id: OPERATION });
    assert.equal(notActive.status, 409);
    assert.equal(notActive.json.message, ORCHESTRATION_V2_RECOVERY_ERRORS.RUN_STOP_NOT_ACTIVE[1]);
    for (const [path, body] of [[`${base}/stop`, {}], [`${base}/stop`, { operation_id: 'x' }],
      [`${base}/stop`, { operation_id: OPERATION, extra: 1 }],
      [`/courses/${COURSE}/conversations/not-a-uuid/workspaces/${WORKSPACE}/stop`, { operation_id: OPERATION }]] as const) {
      const invalid = await app.call('POST', path, body);
      assert.equal(invalid.status, 400, JSON.stringify(body));
      assert.equal(invalid.json.code, 'RECOVERY_INPUT_INVALID');
    }
    const query = await app.call('GET', `${base}/recovery?debug=1`);
    assert.equal(query.status, 400);
  } finally { await app.close(); }

  const crash = await server({ describe: async () => { throw Object.assign(new Error('boom'), { code: '55P03' }); },
    stop: async () => { throw new Error('unexpected'); } });
  try {
    const timeout = await crash.call('GET', `${base}/recovery`);
    assert.equal(timeout.status, 503);
    assert.equal(timeout.json.code, 'RECOVERY_UNAVAILABLE');
    assert.equal(crash.logs[0]!.internal_failure_code, 'SQLSTATE_55P03');
    assert.doesNotMatch(JSON.stringify(timeout.json), /boom|55P03/);
  } finally { await crash.close(); }

  for (const user of [null, { ...staff, role: 'learner' as const }, { ...staff, sessionMode: 'demo_iframe' as const }]) {
    const refused = await server({ describe: async () => assert.fail('never reached'), stop: async () => assert.fail('never') },
      user);
    try {
      const response = await refused.call('POST', `${base}/stop`, { operation_id: OPERATION });
      assert.equal(response.status, user ? 403 : 401);
    } finally { await refused.close(); }
  }
});
