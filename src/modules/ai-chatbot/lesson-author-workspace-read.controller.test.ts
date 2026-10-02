import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import express, { type Request, type Response } from 'express';
import type { AuthUser } from '../../types/express.js';
import type { GenerationJobSql } from './lesson-author-generation-job.repository.js';
import { generationSnapshotHash } from './lesson-author-generation-job.logic.js';
import { createWorkspaceReadHandlers, type WorkspaceReadDiagnostic } from './lesson-author-workspace-read.controller.js';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const workspaceId = uuid(1), conversationId = uuid(2), nodeId = uuid(3);
const courseId = 'course-v1:TEST+WORKSPACE+2026';
const user: AuthUser = { id: uuid(4), tenantId: uuid(5), role: 'staff', username: 'synthetic', sessionMode: 'normal' };
const content = { title: 'Synthetic / Tổng quan', purpose: null, data: { html: '<p>Synthetic only.</p>' }, implementation_notes: null };
const row = { id: workspaceId, correlation_id: uuid(6), contract_version: 1, content_locale: 'vi', status: 'drafting',
  overview_ready: false, structure_ready: false, cursor_exists: true, graph_node_count: '0', nodes: [],
  event_head: '1', updated_at: new Date('2026-09-29T12:00:00Z'), node_count: '1', unit_count: '0', ready_unit_count: '0',
  first_sequence: '1', events: [{ sequence: 1, event_kind: 'node_revision_saved', node_id: nodeId, node_revision: 0,
    operation_id: uuid(7), created_at: '2026-09-29T12:00:00Z' }],
  node_id: nodeId, parent_id: null, kind: 'course', content_state: 'content_ready', current_revision: '0',
  content, content_hash: generationSnapshotHash(content), user_modified: false, validation_contract: 'fixture-v1' };

function fixture() {
  let enabled = true, permitted = true, missing = false, failDb = false, failLogger = false;
  let result: Record<string, unknown> = { ...row };
  const queries: Array<{ sql: string; params: unknown[] }> = [], permissions: AuthUser[] = [], logs: WorkspaceReadDiagnostic[] = [];
  const db: GenerationJobSql = { async query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
    queries.push({ sql, params });
    if (failDb) throw new Error('SECRET_SQL_PROVIDER_SOURCE');
    return { rows: (missing ? [] : [structuredClone(result)]) as T[], rowCount: missing ? 0 : 1 };
  } };
  const handlers = createWorkspaceReadHandlers({ enabled: () => enabled, db,
    canRead: async actor => { permissions.push(actor); return permitted; },
    report: value => { if (failLogger) throw new Error('PRIVATE LOGGER FAILURE'); logs.push(value); } });
  const request = { user: { ...user }, params: { courseId, conversationId, workspaceId, nodeId }, query: {} } as unknown as Request;
  const output = { status: 0, body: {} as Record<string, any>, headers: {} as Record<string, unknown> };
  const response = { setHeader(key: string, value: unknown) { output.headers[key] = value; },
    status(value: number) { output.status = value; return response; },
    json(value: Record<string, any>) { output.body = value; return response; } } as unknown as Response;
  return { handlers, request, response, output, queries, permissions, logs,
    disable: () => { enabled = false; }, deny: () => { permitted = false; },
    missing: () => { missing = true; }, failDb: () => { failDb = true; }, failLogger: () => { failLogger = true; },
    row: (value: Record<string, unknown>) => { result = value; },
    run: (kind: keyof typeof handlers = 'status') => handlers[kind](request, response) };
}

test('authorized status uses authenticated identity and no-store; root correlation is not replaced by read request ID', async () => {
  const f = fixture(); await f.run();
  assert.equal(f.output.status, 200); assert.equal(f.output.headers['Cache-Control'], 'no-store');
  assert.deepEqual(f.queries[0].params.slice(0, 5), [workspaceId, user.tenantId, conversationId, user.id, courseId]);
  assert.equal(f.permissions[0].id, user.id);
  assert.equal(f.output.body.data.correlation_id, row.correlation_id);
  assert.notEqual(f.output.body.request_id, row.correlation_id);
  assert.equal(f.logs[0].correlation_id, row.correlation_id);
  assert.equal(f.logs[0].failure_stage, null);
});

test('missing auth and learner/demo/tenantless sessions never access permissions or DB', async () => {
  for (const actor of [undefined, { ...user, role: 'learner' }, { ...user, role: 'learner_plus' },
    { ...user, sessionMode: 'demo_iframe' }, { ...user, tenantId: null }]) {
    const f = fixture(); f.request.user = actor as AuthUser | undefined; await f.run();
    assert.equal(f.output.status, actor ? 403 : 401);
    assert.equal(f.queries.length, 0); assert.equal(f.permissions.length, 0);
    assert.equal(f.output.headers['Cache-Control'], 'no-store');
  }
});

test('disabled read flag cannot query, enqueue or call a provider', async () => {
  const f = fixture(); f.disable(); await f.run();
  assert.equal(f.output.body.code, 'WORKSPACE_READ_DISABLED'); assert.equal(f.output.status, 503);
  assert.equal(f.queries.length, 0); assert.equal(f.permissions.length, 0);
  assert.equal(f.logs[0].failure_stage, 'workspace_read_gate');
});

test('every poll rechecks courses permission; revocation stops subsequent reads', async () => {
  const f = fixture(); await f.run(); f.deny(); await f.run();
  assert.equal(f.output.status, 403); assert.equal(f.permissions.length, 2); assert.equal(f.queries.length, 1);
});

test('superadmin still binds exact tenant, actor, conversation and course; inaccessible is 404', async () => {
  const f = fixture(); f.request.user = { ...user, role: 'superadmin' }; f.missing(); await f.run();
  assert.equal(f.output.body.code, 'WORKSPACE_NOT_FOUND'); assert.equal(f.output.status, 404);
  assert.deepEqual(f.queries[0].params, [workspaceId, user.tenantId, conversationId, user.id, courseId]);
});

test('unknown query fields, forged identity and unsupported locale are rejected before SQL', async () => {
  for (const query of [{ tenant_id: uuid(99) }, { user_id: uuid(99) }, { ui_locale: 'fr' },
    { ui_locale: ['en', 'vi'] }, { after_sequence: '0' }]) {
    const f = fixture(); f.request.query = query; await f.run();
    assert.equal(f.output.status, 400); assert.equal(f.queries.length, 0);
  }
  const f = fixture(); f.request.params.workspaceId = 'PRIVATE INVALID'; await f.run();
  assert.equal(f.output.status, 400); assert.equal(f.logs[0].workspace_id, null);
  assert.equal(JSON.stringify(f.logs).includes('PRIVATE INVALID'), false);
});

test('events require an exact nonnegative safe integer cursor, not coercion/default replay', async () => {
  for (const after of [undefined, '-1', '1e2', ' 0', '00', '9007199254740992', ['0', '1']]) {
    const f = fixture(); f.request.query = { after_sequence: after }; await f.run('events');
    assert.equal(f.output.status, 400); assert.equal(f.queries.length, 0);
  }
  const f = fixture(); f.request.query = { after_sequence: '0' }; await f.run('events');
  assert.equal(f.output.status, 200); assert.equal(f.output.body.data.events.length, 1);
  assert.deepEqual(f.queries[0].params.slice(5), [0, 100]);
});

test('future event cursor is actionable 409, never an AI retry', async () => {
  const f = fixture(); f.request.query = { after_sequence: '3', ui_locale: 'en' }; await f.run('events');
  assert.equal(f.output.status, 409); assert.equal(f.output.body.code, 'WORKSPACE_EVENT_RESNAPSHOT_REQUIRED');
  assert.equal(f.output.body.message, 'Please reload the draft snapshot.');
  assert.equal(f.logs[0].internal_failure_code, 'WORKSPACE_EVENT_RESNAPSHOT_REQUIRED');
});

test('detail requires expected revision; none is explicit for a planned node', async () => {
  const f = fixture(); await f.run('detail'); assert.equal(f.output.status, 400);
  f.request.query = { expected_revision: '0' }; await f.run('detail');
  assert.equal(f.output.status, 200); assert.deepEqual(f.output.body.data.content, content);
  f.request.query = { expected_revision: '1', ui_locale: 'en' }; await f.run('detail');
  assert.equal(f.output.status, 409); assert.equal(f.output.body.code, 'WORKSPACE_REVISION_CONFLICT');
  f.row({ ...row, current_revision: null, content_state: 'planned', content: null, content_hash: null });
  f.request.query = { expected_revision: 'none' }; await f.run('detail');
  assert.equal(f.output.status, 200); assert.equal(f.output.body.data.content, null);
});

test('UI locale controls safe error copy but never rewrites frozen course content locale', async () => {
  const f = fixture(); f.request.query = { ui_locale: 'en' }; await f.run();
  assert.equal(f.output.body.data.content_locale, 'vi');
  f.row({ ...row, content_locale: 'en' }); f.request.query = { ui_locale: 'vi' }; await f.run();
  assert.equal(f.output.body.data.content_locale, 'en');
  f.deny(); await f.run(); assert.match(f.output.body.message, /Bạn không có quyền/);
  f.request.query = { ui_locale: 'en' }; await f.run(); assert.match(f.output.body.message, /do not have permission/);
});

test('DB errors and malformed stored content return safe external error while preserving typed diagnostic code', async () => {
  const f = fixture(); f.failDb(); await f.run();
  assert.equal(f.output.status, 503); assert.equal(f.logs[0].internal_failure_code, 'WORKSPACE_READ_UNAVAILABLE');
  assert.equal(JSON.stringify([f.output.body, f.logs]).includes('SECRET'), false);
  const bad = fixture(); bad.row({ ...row, content_hash: 'bad' }); bad.request.query = { expected_revision: '0' }; await bad.run('detail');
  assert.equal(bad.output.status, 503); assert.equal(bad.output.body.code, 'WORKSPACE_READ_UNAVAILABLE');
  assert.equal(bad.logs[0].internal_failure_code, 'WORKSPACE_READ_CONTRACT_INVALID');
  assert.equal(JSON.stringify(bad.logs).includes(content.title), false);
  // No guessed root correlation when authorized repository read did not return one.
  assert.equal(bad.logs[0].correlation_id, null);
});

test('logging failure cannot fail a valid read or bypass a rejection', async () => {
  const f = fixture(); f.failLogger(); await f.run(); assert.equal(f.output.status, 200);
  f.deny(); await f.run(); assert.equal(f.output.status, 403);
});

test('real Express HTTP status/events/graph/detail journey is read-only with injected authentication and synthetic DB', async () => {
  const f = fixture();
  const app = express();
  // Test principal only, NOT a replacement for production JWT middleware.
  app.use((req, _res, next) => { req.user = { ...user }; next(); });
  const base = '/courses/:courseId/conversations/:conversationId/workspaces/:workspaceId';
  app.get(base, f.handlers.status); app.get(`${base}/events`, f.handlers.events); app.get(`${base}/nodes/:nodeId`, f.handlers.detail);
  app.get(`${base}/graph`, f.handlers.graph);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}/courses/${encodeURIComponent(courseId)}/conversations/${conversationId}/workspaces/${workspaceId}`;
    for (const suffix of ['', '/events?after_sequence=0', '/graph', `/nodes/${nodeId}?expected_revision=0&ui_locale=en`]) {
      const response = await fetch(url + suffix);
      assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
      const body = await response.json() as any; assert.equal(body.data.correlation_id, row.correlation_id);
    }
    const invalid = await fetch(`${url}/events?after_sequence=0&after_sequence=1`);
    assert.equal(invalid.status, 400);
    assert.equal(f.queries.length, 4);
    for (const call of f.queries) assert.doesNotMatch(call.sql, /\b(?:INSERT|UPDATE|DELETE)\b/i);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test('production routes retain auth/tenant order, current courses permission and default-off read-only gate', () => {
  const routes = readFileSync(new URL('./ai-chatbot.routes.ts', import.meta.url), 'utf8');
  const env = readFileSync(new URL('../../config/env.ts', import.meta.url), 'utf8');
  const before = routes.slice(0, routes.indexOf('const workspaceReads'));
  assert.match(before, /router\.use\(authenticate\)/); assert.match(before, /router\.use\(tenantContext\)/);
  const wiring = routes.slice(routes.indexOf('const workspaceReads'), routes.indexOf('const workspaceEdits'));
  assert.match(wiring, /hasPermission\(user, 'courses', 'can_edit'\)/);
  assert.match(wiring, /env\.LESSON_AUTHOR_WORKSPACE_READ_ENABLED/);
  assert.equal((wiring.match(/router\.get/g) ?? []).length, 5);
  assert.match(wiring, /workspaceReadPath\}\/stream/);
  assert.doesNotMatch(wiring, /router\.(?:post|put|patch|delete)/);
  assert.match(env, /LESSON_AUTHOR_WORKSPACE_READ_ENABLED: optionalBoolean\('LESSON_AUTHOR_WORKSPACE_READ_ENABLED', false\)/);
});

test('graph HTTP contract rejects incomplete cursor, supports empty snapshot and localizes stale-snapshot 409', async () => {
  const f = fixture();
  f.row({ ...row, overview_ready: false, structure_ready: false, cursor_exists: true, graph_node_count: '0', nodes: [] });
  await f.run('graph'); assert.equal(f.output.status, 200); assert.deepEqual(f.output.body.data.nodes, []);
  f.request.query = { after_node_id: nodeId }; await f.run('graph'); assert.equal(f.output.status, 400);
  f.request.query = { snapshot_sequence: '0', after_node_id: nodeId, ui_locale: 'en' };
  await f.run('graph'); assert.equal(f.output.status, 409);
  assert.equal(f.output.body.code, 'WORKSPACE_EVENT_RESNAPSHOT_REQUIRED');
  assert.equal(f.logs.at(-1)?.operation, 'graph');
});
