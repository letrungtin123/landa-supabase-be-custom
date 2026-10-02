import assert from 'node:assert/strict';
import test from 'node:test';
import express, { type Request, type Response } from 'express';
import type { AddressInfo } from 'node:net';
import type { AuthUser } from '../../types/express.js';
import { createOrchestrationV2AdmissionHandler } from './lesson-author-orchestration-v2-admission.controller.js';
import type { OrchestrationV2AdmissionConfig } from './lesson-author-orchestration-v2-admission.logic.js';
import type {
  OrchestrationV2AdmissionReceipt,
  OrchestrationV2AdmissionTarget,
} from './lesson-author-orchestration-v2-admission.repository.js';
import { createOrchestrationV2AdmissionService } from './lesson-author-orchestration-v2-admission.service.js';
import type { OrchestrationV2ExecutionRuntime } from './lesson-author-orchestration-v2-execution.config.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const hash = (character: string) => character.repeat(64);
const user: AuthUser = { id: id(1), tenantId: id(2), role: 'staff', username: 'fixture', sessionMode: 'normal' };
const params = { courseId: 'course-v1:TEST+V2+2026', conversationId: id(3), workspaceId: id(4) };
const target: OrchestrationV2AdmissionTarget = {
  workspaceId: params.workspaceId, tenantId: user.tenantId!, courseId: params.courseId,
  conversationId: params.conversationId, userId: user.id,
};
const receipt: OrchestrationV2AdmissionReceipt = {
  created: true, run_id: id(5), snapshot_id: id(6), task_id: id(7), outbox_id: id(8),
  bootstrap_hash: hash('a'), source_snapshot_hash: hash('b'),
};
const executionRuntime = {
  settings: { lessonAuthorModel: 'gemini-test' },
  runtime_config_hash: hash('c'),
  planning_budgets: {},
  inventory_budgets: {},
  allowed_component_types: new Set(['html']),
} as unknown as OrchestrationV2ExecutionRuntime;

test('admission service verifies schema once and freezes only server-owned runtime configuration', async () => {
  let schemaChecks = 0;
  let runtimeLoads = 0;
  const admitted: Array<{ actor: AuthUser; target: OrchestrationV2AdmissionTarget;
    config: OrchestrationV2AdmissionConfig }> = [];
  const service = createOrchestrationV2AdmissionService({
    config: { tenant_concurrency_limit: 16, workspace_concurrency_limit: 4, routing_shard_count: 4_096 },
    verifySchema: async () => { schemaChecks += 1; },
    loadRuntime: async tenantId => {
      runtimeLoads += 1;
      assert.equal(tenantId, user.tenantId);
      return executionRuntime;
    },
    createRepository: actor => ({ admit: async (admissionTarget, config) => {
      admitted.push({ actor, target: admissionTarget, config });
      return receipt;
    } }),
  });
  assert.deepEqual(await service(user, target), receipt);
  assert.deepEqual(await service(user, target), receipt);
  assert.equal(schemaChecks, 1);
  assert.equal(runtimeLoads, 2, 'runtime authority must be fresh for each admission attempt');
  assert.equal(admitted.length, 2);
  assert.deepEqual(admitted[0]!.actor, user);
  assert.deepEqual(admitted[0]!.target, target);
  assert.deepEqual(admitted[0]!.config, {
    runtime_config_hash: hash('c'), model: 'gemini-test', source_snapshot_budget_ms: 600_000,
    tenant_concurrency_limit: 16, workspace_concurrency_limit: 4, routing_shard_count: 4_096,
  });
});

test('admission service retries failed schema verification and rejects invalid limits before admission', async () => {
  let checks = 0;
  let repositoryCalls = 0;
  const service = createOrchestrationV2AdmissionService({
    config: { tenant_concurrency_limit: 16, workspace_concurrency_limit: 4, routing_shard_count: 4_096 },
    verifySchema: async () => { checks += 1; if (checks === 1) throw new Error('catalog unavailable'); },
    loadRuntime: async () => executionRuntime,
    createRepository: () => ({ admit: async () => { repositoryCalls += 1; return receipt; } }),
  });
  await assert.rejects(() => service(user, target), /catalog unavailable/);
  assert.deepEqual(await service(user, target), receipt);
  assert.equal(checks, 2);
  assert.equal(repositoryCalls, 1);

  let touched = false;
  const invalid = createOrchestrationV2AdmissionService({
    config: { tenant_concurrency_limit: 2, workspace_concurrency_limit: 4, routing_shard_count: 4_096 },
    verifySchema: async () => { touched = true; }, loadRuntime: async () => executionRuntime,
    createRepository: () => ({ admit: async () => receipt }),
  });
  await assert.rejects(() => invalid(user, target), { code: 'ORCHESTRATION_V2_ADMISSION_CONFIG_INVALID' });
  assert.equal(touched, false);
});

function controllerFixture() {
  const state = { enabled: true, created: true, loggerThrows: false, errorCode: '' };
  const calls: Array<{ actor: AuthUser; target: OrchestrationV2AdmissionTarget }> = [];
  const logs: Record<string, unknown>[] = [];
  const handler = createOrchestrationV2AdmissionHandler({
    enabled: () => state.enabled,
    admit: async (actor, admissionTarget) => {
      calls.push({ actor, target: admissionTarget });
      if (state.errorCode) throw Object.assign(new Error('PRIVATE SOURCE OR PROVIDER BODY'), { code: state.errorCode });
      return { ...receipt, created: state.created };
    },
    report: event => { logs.push(event); if (state.loggerThrows) throw new Error('logger unavailable'); },
  });
  async function invoke(overrides: Partial<Request> = {}) {
    let status = 200;
    let payload: any;
    const headers: Record<string, string> = {};
    const req = { user, params, query: { ui_locale: 'en' }, body: {}, ...overrides } as Request;
    const res = { setHeader(key: string, value: string) { headers[key] = value; },
      status(value: number) { status = value; return this; }, json(value: unknown) { payload = value; return this; } } as unknown as Response;
    await handler(req, res);
    return { status, payload, headers };
  }
  return { state, calls, logs, handler, invoke };
}

test('HTTP admission returns a minimal 202 receipt and an idempotent 200 replay', async () => {
  const fixture = controllerFixture();
  const created = await fixture.invoke();
  fixture.state.created = false;
  const replayed = await fixture.invoke();
  assert.equal(created.status, 202);
  assert.equal(replayed.status, 200);
  assert.deepEqual(created.payload.data, {
    workspace_id: params.workspaceId, run_id: receipt.run_id, status: 'planning', replayed: false,
  });
  assert.equal(replayed.payload.data.replayed, true);
  assert.equal(created.headers['Cache-Control'], 'no-store');
  assert.match(created.headers['X-Request-ID'], /^[0-9a-f-]{36}$/i);
  assert.deepEqual(fixture.calls[0], { actor: user, target });
  assert.doesNotMatch(JSON.stringify(created.payload), /snapshot|task|outbox|bootstrap|source_snapshot|model|token/i);
});

test('HTTP admission rejects disabled, untrusted and authority-shaped browser input before writes', async () => {
  const disabled = controllerFixture();
  disabled.state.enabled = false;
  assert.equal((await disabled.invoke()).status, 503);
  assert.equal(disabled.calls.length, 0);

  const cases: Array<Partial<Request>> = [
    { user: undefined },
    { user: { ...user, role: 'learner' } as AuthUser },
    { user: { ...user, sessionMode: 'demo_iframe' } as AuthUser },
    { params: { ...params, workspaceId: 'bad' } },
    { params: { ...params, conversationId: 'bad' } },
    { params: { ...params, courseId: '' } },
    { query: { ui_locale: 'fr' } },
    { query: { ui_locale: 'vi', tenant_id: id(99) } },
    { body: { model: 'attacker-model' } },
    { body: { source_document_ids: [id(99)] } },
    { body: { token_budget: Number.MAX_SAFE_INTEGER } },
  ];
  for (const input of cases) {
    const fixture = controllerFixture();
    assert.ok([400, 401, 403].includes((await fixture.invoke(input)).status));
    assert.equal(fixture.calls.length, 0);
  }
});

test('HTTP admission maps authority/conflict/runtime failures safely and logging cannot change success', async () => {
  for (const [code, expected] of [
    ['ORCHESTRATION_V2_ADMISSION_FORBIDDEN', 403],
    ['ORCHESTRATION_V2_ADMISSION_SOURCE_CHANGED', 409],
    ['ORCHESTRATION_V2_ADMISSION_CONFLICT', 409],
    ['ORCHESTRATION_V2_SCHEMA_MISSING', 503],
  ] as const) {
    const fixture = controllerFixture();
    fixture.state.errorCode = code;
    const result = await fixture.invoke({ query: { ui_locale: 'vi' } });
    assert.equal(result.status, expected);
    assert.doesNotMatch(JSON.stringify([result.payload, fixture.logs]), /PRIVATE SOURCE|PROVIDER BODY/);
  }
  const committed = controllerFixture();
  committed.state.loggerThrows = true;
  assert.equal((await committed.invoke()).status, 202);
  assert.equal(committed.calls.length, 1);
});

test('Express route accepts an encoded course ID and remains ordinary JSON, never SSE', async () => {
  const fixture = controllerFixture();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.post('/courses/:courseId/conversations/:conversationId/workspaces/:workspaceId/orchestration-v2/runs', fixture.handler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/courses/${encodeURIComponent(params.courseId)}`
      + `/conversations/${params.conversationId}/workspaces/${params.workspaceId}/orchestration-v2/runs?ui_locale=en`;
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 202);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    assert.doesNotMatch(response.headers.get('content-type') ?? '', /event-stream/);
    assert.equal((await response.json() as any).data.run_id, receipt.run_id);
    assert.equal(fixture.calls[0]!.target.courseId, params.courseId);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
