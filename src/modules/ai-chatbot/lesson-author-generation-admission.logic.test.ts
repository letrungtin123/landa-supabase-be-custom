import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import express from 'express';
import { respondToGenerationAdmission } from './lesson-author-generation-admission.logic.js';
import { createGenerationStatusHandler } from './lesson-author-generation-status.controller.js';
import { runGenerationJob } from './lesson-author-generation-runner.logic.js';
import { GenerationJobError, generationJobStatusView, type GenerationJobRow } from './lesson-author-generation-job.logic.js';

const uuid = '11111111-1111-4111-8111-111111111111';

function captureResponse() {
  let status = 0;
  let body: any;
  const response = { setHeader: () => {}, status: (value: number) => { status = value; return response; },
    json: (value: unknown) => { body = value; return response; } };
  return { response: response as unknown as express.Response, read: () => ({ status, body }) };
}

test('pre-enqueue failure reports the exact stage/correlation and safe SQL metadata, not private exception text', async () => {
  const capture = captureResponse(); const records: Record<string, unknown>[] = [];
  let correlation: string | undefined;
  const error = Object.assign(new Error('PRIVATE_PROMPT_JWT_SQL_VALUES'), {
    code: '42703', detail: 'PRIVATE_PROMPT_JWT_SQL_VALUES', query: 'PRIVATE_PROMPT_JWT_SQL_VALUES',
  });
  await respondToGenerationAdmission(capture.response, async context => {
    correlation = context.correlationId; context.stage('history_context'); throw error;
  }, { conversationId: uuid, report: record => records.push(record) });
  assert.equal(capture.read().status, 503);
  assert.equal(capture.read().body.admission_status, 'rejected');
  assert.equal(capture.read().body.correlation_id, correlation);
  assert.equal(records[0].event, 'generation_admission_started');
  assert.equal(records.at(-1)?.failure_stage, 'history_context');
  assert.equal(records.at(-1)?.db_sqlstate, '42703');
  assert.ok(records.every(r => r.correlation_id === correlation && r.conversation_id === uuid));
  assert.doesNotMatch(JSON.stringify([records, capture.read()]), /PRIVATE_PROMPT_JWT_SQL_VALUES/);
});

test('transaction constraint rejection differs from unknown connection/commit outcome', async () => {
  for (const [code, expected] of [['23514', 'rejected'], ['08006', 'unknown'], ['ECONNRESET', 'unknown']]) {
    const capture = captureResponse(); const records: Record<string, unknown>[] = [];
    await respondToGenerationAdmission(capture.response, async context => {
      context.beginEnqueue(); context.stage('job_insert');
      throw Object.assign(new Error('PRIVATE_PATCH'), { code, constraint: 'la_generation_deadline_check' });
    }, { conversationId: uuid, report: r => records.push(r) });
    assert.equal(capture.read().body.admission_status, expected);
    assert.equal(records.at(-1)?.failure_stage, 'job_insert');
    assert.equal(records.at(-1)?.db_constraint, 'la_generation_deadline_check');
  }
});

test('failure after commit preserves the job correlation and never claims the request was rejected', async () => {
  const capture = captureResponse(); const records: Record<string, unknown>[] = [];
  await respondToGenerationAdmission(capture.response, async context => {
    context.beginEnqueue(); context.committed(uuid);
    throw new GenerationJobError('GENERATION_LEASE_LOST');
  }, { report: r => records.push(r) });
  assert.equal(capture.read().body.admission_status, 'unknown');
  assert.equal(capture.read().status, 503, 'even a typed guard error after commit must retain read-only recovery');
  assert.equal(capture.read().body.correlation_id, uuid);
  assert.equal(records.at(-1)?.failure_stage, 'enqueue_committed');
});

test('diagnostic sink failure cannot trigger fallback or replace the original admission result', async () => {
  const capture = captureResponse();
  assert.equal(await respondToGenerationAdmission(capture.response, async () => {
    throw new GenerationJobError('GENERATION_IDEMPOTENCY_CONFLICT');
  }, { report: () => { throw new Error('logger unavailable'); } }), true);
  assert.equal(capture.read().body.code, 'GENERATION_IDEMPOTENCY_CONFLICT');
});

test('production admission propagates one correlation and records preparation/transaction boundaries', () => {
  const service = readFileSync(new URL('./lesson-author-durable-blueprint.service.ts', import.meta.url), 'utf8');
  const chat = readFileSync(new URL('./chat.service.ts', import.meta.url), 'utf8');
  const controller = readFileSync(new URL('./chat.controller.ts', import.meta.url), 'utf8');
  assert.match(controller, /respondToGenerationAdmission\(res, admission =>/);
  assert.match(controller, /\}, admission\), \{ conversationId \}\)/);
  assert.match(service, /const correlationId = admission\?\.correlationId \?\? randomUUID\(\)/);
  assert.match(service, /admission\?\.committed\(result.job.correlation_id\)/);
  assert.match(service, /prior.rows\[0\], admission\?\.stage/);
  for (const stage of ['actor_authorization', 'runtime_settings', 'source_validation', 'history_context', 'quota_reservation', 'user_message_write']) {
    assert.ok(chat.includes(`admissionStage('${stage}')`));
  }
});

test('offline HTTP journey: POST 202 → one mocked provider → atomic result → owned GET; replay does not dispatch again', async () => {
  let enqueues = 0; let providerCalls = 0; let persisted = false;
  let finishProvider!: (value: string) => void;
  const providerResult = new Promise<string>(resolve => { finishProvider = resolve; });
  let job = { id: uuid, tenant_id: 'tenant', requested_by: 'user', conversation_id: uuid,
    correlation_id: uuid, status: 'queued', deadline_at: new Date(Date.now() + 600_000),
    finished_at: null, result_blueprint_id: null, assistant_message_id: null,
    external_failure_code: null, progress_code: 'QUEUED', lease_token: null } as GenerationJobRow;
  const app = express(); app.use(express.json());
  // Synthetic authentication only. This is not a real JWT/PostgreSQL/Gemini UAT.
  app.use((req, res, next) => {
    if (req.header('Authorization') !== 'Bearer offline-test') { res.sendStatus(401); return; }
    req.user = { id: 'user', tenantId: req.header('X-Tenant-Id') ?? 'tenant', role: 'staff', username: 'test', sessionMode: 'normal' };
    next();
  });
  app.post('/messages', async (_req, res) => {
    await respondToGenerationAdmission(res, async () => { if (!enqueues) enqueues++; return generationJobStatusView(job); });
  });
  app.get('/conversations/:conversationId/jobs/:jobId', createGenerationStatusHandler({
    enabled: () => true, canRead: async () => true,
    findOwned: async owner => owner.tenantId === job.tenant_id && owner.userId === job.requested_by
      && owner.conversationId === job.conversation_id ? job : null,
    reportFailure: () => assert.fail('no status error'),
  }));
  const server = app.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const headers = { Authorization: 'Bearer offline-test', 'Content-Type': 'application/json' };
    const post: Awaited<ReturnType<typeof fetch>> = await fetch(`${base}/messages`, { method: 'POST', headers, body: '{}' });
    assert.equal(post.status, 202); assert.equal(post.headers.get('cache-control'), 'no-store');
    const accepted = await post.json() as { data: { correlation_id: string } }; assert.equal(accepted.data.correlation_id, uuid);
    assert.equal(providerCalls, 0);
    job = { ...job, status: 'running', lease_token: 'lease' };
    const running = runGenerationJob(job, {
      prepare: async () => 'authorized',
      authorizeDispatch: async () => { job = { ...job, dispatch_started_at: new Date() }; return job; },
      generate: async () => { providerCalls++; return providerResult; },
      complete: async () => { persisted = true; job = { ...job, status: 'succeeded', result_blueprint_id: uuid,
        assistant_message_id: uuid, finished_at: new Date(), lease_token: null }; },
      fail: async () => assert.fail('not expected'), renew: async () => true,
      classify: () => ({ stage: 'generation_execution', internalCode: 'FAILED', externalCode: 'FAILED' }), report: () => {},
    });
    const replay: Awaited<ReturnType<typeof fetch>> = await fetch(`${base}/messages`, { method: 'POST', headers, body: '{}' });
    assert.equal(replay.status, 202); assert.equal(enqueues, 1);
    const hidden: Awaited<ReturnType<typeof fetch>> = await fetch(`${base}/conversations/${uuid}/jobs/${uuid}`, { headers: { ...headers, 'X-Tenant-Id': 'foreign' } });
    assert.equal(hidden.status, 404);
    const pending: Awaited<ReturnType<typeof fetch>> = await fetch(`${base}/conversations/${uuid}/jobs/${uuid}`, { headers });
    const pendingBody = await pending.json() as { data: { blueprint_id: string | null } };
    assert.equal(pendingBody.data.blueprint_id, null); assert.equal(persisted, false);
    finishProvider('valid'); await running;
    const done: Awaited<ReturnType<typeof fetch>> = await fetch(`${base}/conversations/${uuid}/jobs/${uuid}`, { headers });
    const complete = await done.json() as { data: { status: string; blueprint_id: string } };
    assert.equal(complete.data.status, 'succeeded'); assert.equal(complete.data.blueprint_id, uuid);
    assert.equal(providerCalls, 1); assert.equal(persisted, true);
  } finally {
    server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  }
});

test('admission error is terminal, safe and never falls back to synchronous generation', async () => {
  const output: Record<string, unknown> = {};
  const response = { setHeader: () => {}, status: (status: number) => { output.status = status; return response; },
    json: (body: unknown) => { output.body = body; return response; } };
  for (const error of [new GenerationJobError('GENERATION_IDEMPOTENCY_CONFLICT'), new Error('PRIVATE_DB_SOURCE_SECRET')]) {
    const handled = await respondToGenerationAdmission(response as unknown as express.Response, async () => { throw error; });
    assert.equal(handled, true); assert.doesNotMatch(JSON.stringify(output), /PRIVATE_DB_SOURCE_SECRET/);
    assert.equal(output.status, error instanceof GenerationJobError ? 409 : 503);
  }
  assert.equal(await respondToGenerationAdmission(response as unknown as express.Response, async () => null), false);
});
