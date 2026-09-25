import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import express, { type Request, type Response } from 'express';
import type { AuthUser } from '../../types/express.js';
import type { GenerationJobRow } from './lesson-author-generation-job.logic.js';
import { createGenerationStatusHandler } from './lesson-author-generation-status.controller.js';

const conversationId = '00000000-0000-4000-8000-000000000001';
const jobId = '00000000-0000-4000-8000-000000000002';
const user: AuthUser = { id: 'user-id', tenantId: 'tenant-id', role: 'staff', username: 'test', sessionMode: 'normal' };
// Synthetic row only; repository SQL predicates are tested separately.
const job: GenerationJobRow = {
  tenant_id: user.tenantId!, conversation_id: conversationId, requested_by: user.id,
  course_id: 'course-v1:ORG+TEST+2026', bot_id: 'bot', kb_id: 'kb', user_message_id: 'message',
  idempotency_key: 'key', request_hash: 'request-hash', source_snapshot_hash: 'source-hash',
  course_outline_hash: 'course-hash', runtime_config_hash: 'config-hash', contract_version: 1,
  operation: 'course_blueprint', engine: 'self_built_rag', locale: 'vi', model: 'existing-model',
  max_output_tokens: 65536, max_attempts: 2, source_document_ids: ['source-id'], claim_count: 1,
  lease_expires_at: null, heartbeat_at: new Date('2026-09-25T00:02:50Z'),
  started_at: new Date('2026-09-25T00:00:01Z'), dispatch_started_at: new Date('2026-09-25T00:00:02Z'),
  created_at: new Date('2026-09-25T00:00:00Z'), updated_at: new Date('2026-09-25T00:03:00Z'),
  failure_stage: null, external_failure_code: null,
  id: jobId, correlation_id: 'original-correlation', status: 'succeeded', progress_code: 'BLUEPRINT_READY',
  deadline_at: new Date('2026-09-25T00:10:00Z'), finished_at: new Date('2026-09-25T00:03:00Z'),
  result_blueprint_id: 'blueprint-id', assistant_message_id: 'assistant-id',
  lease_token: 'private-lease', editor_context: { private: 'PRIVATE_CONTENT' },
  ai_reservation_id: 'private-reservation', internal_failure_code: 'PRIVATE_CODE',
};

function fixture() {
  let enabled = true;
  let allowed = true;
  let result: GenerationJobRow | null = job;
  let failure: Error | null = null;
  const permissionUsers: AuthUser[] = [];
  const lookups: unknown[] = [];
  const logs: unknown[] = [];
  const handler = createGenerationStatusHandler({
    enabled: () => enabled,
    canRead: async value => { permissionUsers.push(value); return allowed; },
    findOwned: async (owner, id) => {
      lookups.push({ owner, id });
      if (failure) throw failure;
      return result;
    },
    reportFailure: record => { logs.push(record); },
  });
  const request = { user, params: { conversationId, jobId } } as unknown as Request;
  const output = { status: 0, body: {} as Record<string, any>, headers: {} as Record<string, unknown> };
  const response = {
    setHeader: (key: string, value: unknown) => { output.headers[key] = value; },
    status: (status: number) => { output.status = status; return response; },
    json: (body: Record<string, any>) => { output.body = body; return response; },
  } as unknown as Response;
  return { handler, request, response, output, permissionUsers, lookups, logs,
    disable: () => { enabled = false; }, deny: () => { allowed = false; },
    missing: () => { result = null; }, fail: () => { failure = new Error('PRIVATE_SQL_CREDENTIAL_SOURCE'); },
    run: () => handler(request, response),
  };
}

test('status returns safe review references with no-store and original execution correlation', async () => {
  const f = fixture();
  await f.run();
  assert.equal(f.output.status, 200);
  assert.equal(f.output.headers['Cache-Control'], 'no-store');
  assert.equal(f.output.body.data.correlation_id, 'original-correlation');
  assert.equal(f.output.body.data.blueprint_id, 'blueprint-id');
  assert.deepEqual(f.lookups, [{ owner: { tenantId: user.tenantId, userId: user.id, conversationId }, id: jobId }]);
  assert.doesNotMatch(JSON.stringify(f.output), /PRIVATE|private-|lease_token|editor_context|ai_reservation_id|internal_failure_code/);
});

test('unauthenticated status returns 401 without permission or DB lookup', async () => {
  const f = fixture();
  f.request.user = undefined;
  await f.run();
  assert.equal(f.output.status, 401);
  assert.equal(f.permissionUsers.length + f.lookups.length, 0);
});

test('tenantless, learner, learner_plus and demo sessions fail before DB access', async () => {
  for (const patch of [{ tenantId: null }, { role: 'learner' as const }, { role: 'learner_plus' as const },
    { sessionMode: 'demo_iframe' as const }]) {
    const f = fixture();
    f.request.user = { ...user, ...patch };
    await f.run();
    assert.equal(f.output.status, 403);
    assert.equal(f.permissionUsers.length + f.lookups.length, 0);
  }
});

test('invalid route IDs fail before lookup and are not logged', async () => {
  for (const key of ['jobId', 'conversationId']) {
    const f = fixture();
    f.request.params = { conversationId, jobId, [key]: 'PRIVATE_BAD_IDENTIFIER' };
    await f.run();
    assert.equal(f.output.status, 400);
    assert.equal(f.lookups.length + f.logs.length, 0);
  }
});

test('feature disabled means zero DB work and a safe 503, not generation fallback', async () => {
  const f = fixture();
  f.disable();
  await f.run();
  assert.equal(f.output.status, 503);
  assert.equal(f.output.body.code, 'GENERATION_STATUS_DISABLED');
  assert.equal(f.permissionUsers.length + f.lookups.length, 0);
});

test('permission is checked on every poll; denied request never reads a job', async () => {
  const f = fixture();
  await f.run();
  f.deny();
  await f.run();
  assert.equal(f.output.status, 403);
  assert.equal(f.permissionUsers.length, 2);
  assert.equal(f.lookups.length, 1);
});

test('missing or inaccessible job has one non-disclosing 404 response', async () => {
  const f = fixture();
  f.missing();
  await f.run();
  assert.equal(f.output.status, 404);
  assert.equal(f.output.body.code, 'GENERATION_JOB_NOT_FOUND');
  assert.ok(!('data' in f.output.body));
});

test('superadmin still uses resolved tenant and own conversation-user scope', async () => {
  const f = fixture();
  f.request.user = { ...user, role: 'superadmin' };
  await f.run();
  assert.deepEqual(f.lookups, [{ owner: { tenantId: user.tenantId, userId: user.id, conversationId }, id: jobId }]);
});

test('database failure emits only safe structured diagnostics and never raw error text', async () => {
  const f = fixture();
  f.fail();
  await f.run();
  assert.equal(f.output.status, 503);
  assert.equal(f.output.body.code, 'GENERATION_STATUS_UNAVAILABLE');
  assert.deepEqual(f.logs, [{ event: 'generation_status_read_failed', failure_stage: 'node_generation_status',
    internal_failure_code: 'GENERATION_STATUS_READ_FAILED', job_id: jobId, conversation_id: conversationId }]);
  assert.doesNotMatch(JSON.stringify([f.output, f.logs]), /PRIVATE_SQL_CREDENTIAL_SOURCE/);
});

test('actual Express GET returns JSON status; repeated reads do not trigger any generation', async () => {
  const f = fixture();
  const app = express();
  // Synthetic authenticated subject only; no real JWT, DB or provider in this test.
  app.use((req, _res, next) => { req.user = user; next(); });
  app.get('/conversations/:conversationId/jobs/:jobId', f.handler);
  const server = app.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    for (let index = 0; index < 2; index++) {
      const response: Awaited<ReturnType<typeof fetch>> = await fetch(`http://127.0.0.1:${address.port}/conversations/${conversationId}/jobs/${jobId}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const body = await response.json() as { data: { job_id: string } };
      assert.equal(body.data.job_id, jobId);
    }
    assert.equal(f.lookups.length, 2);
    assert.equal(f.permissionUsers.length, 2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('production wiring retains auth/tenant middleware, edit permission, and default-off flag', () => {
  const routes = readFileSync(new URL('./ai-chatbot.routes.ts', import.meta.url), 'utf8');
  const config = readFileSync(new URL('../../config/env.ts', import.meta.url), 'utf8');
  const routeIndex = routes.indexOf("router.get('/chat/lesson-author/conversations/:conversationId/generation-jobs/:jobId'");
  assert.ok(routeIndex > routes.indexOf('router.use(authenticate)'));
  assert.ok(routeIndex > routes.indexOf('router.use(tenantContext)'));
  assert.match(routes, /canRead: user => hasPermission\(user, 'courses', 'can_edit'\)/);
  assert.match(config, /LESSON_AUTHOR_GENERATION_STATUS_ENABLED: optionalBoolean\('LESSON_AUTHOR_GENERATION_STATUS_ENABLED', false\)/);
  assert.doesNotMatch(routes, /router.post\([^\n]*generation-jobs/);
});
