import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runGenerationJob, type GenerationRunDependencies } from './lesson-author-generation-runner.logic.js';
import { GenerationJobError, type GenerationJobRow } from './lesson-author-generation-job.logic.js';

function fixture(overrides: Partial<GenerationRunDependencies<string, string>> = {}, budget = 60_000) {
  const events: string[] = [];
  const records: Record<string, unknown>[] = [];
  const job = { id: 'job', tenant_id: 'tenant', conversation_id: 'conversation', correlation_id: 'correlation',
    lease_token: 'lease', status: 'running', dispatch_started_at: null, deadline_at: new Date(Date.now() + budget + 5_000) } as GenerationJobRow;
  const deps: GenerationRunDependencies<string, string> = {
    prepare: async () => { events.push('prepare'); return 'prepared'; },
    authorizeDispatch: async () => { events.push('dispatch-commit'); return { ...job, dispatch_started_at: new Date() }; },
    generate: async (_, current, signal, ms) => {
      assert.ok(current.dispatch_started_at); assert.equal(signal.aborted, false); assert.ok(ms <= budget);
      events.push('provider'); return 'valid';
    },
    complete: async (_, __, result) => { assert.equal(result, 'valid'); events.push('validated-atomic-commit'); },
    fail: async (_, failure) => { events.push(`fail:${failure.internalCode}`); },
    renew: async () => true,
    classify: error => ({ stage: 'test', internalCode: error instanceof GenerationJobError ? error.code : 'PROVIDER_ERROR', externalCode: 'PROVIDER_ERROR' }),
    report: record => records.push(record),
    ...overrides,
  };
  return { job, deps, events, records, run: (signal?: AbortSignal) => runGenerationJob(job, deps, signal) };
}

test('happy path dispatch commit precedes exactly one provider call and atomic validated persistence', async () => {
  const f = fixture(); await f.run();
  assert.deepEqual(f.events, ['prepare', 'dispatch-commit', 'provider', 'validated-atomic-commit']);
  assert.equal(f.records.at(-1)?.event, 'generation_succeeded');
  assert.ok(f.records.every(r => r.correlation_id === 'correlation' && r.job_id === 'job'));
});

test('changed scope/permission fails before dispatch, no paid retry', async () => {
  const f = fixture({ prepare: async () => { throw new GenerationJobError('GENERATION_SNAPSHOT_CHANGED'); } });
  await f.run(); assert.deepEqual(f.events, ['fail:GENERATION_SNAPSHOT_CHANGED']);
});

test('dispatch transaction failure never invokes provider', async () => {
  const f = fixture({ authorizeDispatch: async () => { throw new GenerationJobError('GENERATION_BUDGET_CHANGED'); } });
  await f.run(); assert.deepEqual(f.events, ['prepare', 'fail:GENERATION_BUDGET_CHANGED']);
});

test('provider failure is terminal once, logs exclude raw error text', async () => {
  let calls = 0;
  const f = fixture({ generate: async () => { calls++; throw new Error('PRIVATE_SOURCE_TOKEN_SECRET'); } });
  await f.run(); assert.equal(calls, 1);
  assert.ok(f.events.includes('fail:PROVIDER_ERROR'));
  assert.ok(!f.events.includes('validated-atomic-commit'));
  assert.doesNotMatch(JSON.stringify(f.records), /PRIVATE_SOURCE_TOKEN_SECRET/);
});

test('slow provider hits total deadline, aborts wait, does not accept a late result or retry', async () => {
  let providerSignal: AbortSignal | undefined;
  let finish!: (result: string) => void;
  let calls = 0;
  const f = fixture({ generate: async (_, __, signal) => {
    calls++; providerSignal = signal; return new Promise(resolve => { finish = resolve; });
  } }, 25);
  await f.run();
  assert.equal(providerSignal?.aborted, true); assert.equal(calls, 1);
  finish('valid'); await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(f.events.includes('fail:GENERATION_WORKFLOW_TIMEOUT'));
  assert.ok(!f.events.includes('validated-atomic-commit'));
});

test('preparation consumes the same total deadline and cannot dispatch after expiry', async () => {
  const f = fixture({ prepare: async () => new Promise(() => {}) }, 15);
  await f.run(); assert.deepEqual(f.events, ['fail:GENERATION_WORKFLOW_TIMEOUT']);
});

test('lease loss during generation aborts wait and cannot finalize or write a stale failure', async () => {
  const f = fixture({ generate: async () => new Promise(() => {}), renew: async () => false, heartbeatMs: 5 });
  await f.run(); assert.deepEqual(f.events, ['prepare', 'dispatch-commit']);
  assert.equal(f.records.at(-1)?.internal_failure_code, 'GENERATION_LEASE_LOST');
});

test('shutdown before claim execution cannot call provider or write a result', async () => {
  const stop = new AbortController(); stop.abort();
  const f = fixture(); await f.run(stop.signal);
  assert.ok(!f.events.includes('provider')); assert.ok(!f.events.includes('validated-atomic-commit'));
});

test('Node acceptance failure cannot report success and never regenerates', async () => {
  let received: string | undefined;
  let accountingContext: string | undefined;
  const f = fixture({ complete: async () => { throw new Error('VALIDATOR_REJECTED'); },
    fail: async (_, __, ___, result, prepared) => { received = result; accountingContext = prepared; } });
  await f.run(); assert.equal(f.events.filter(x => x === 'provider').length, 1);
  assert.equal(received, 'valid', 'known provider usage must remain available to accounting after Node rejection');
  assert.equal(accountingContext, 'prepared', 'original embedding-model/accounting context must survive rejection');
  assert.ok(!f.records.some(r => r.event === 'generation_succeeded'));
});

test('terminal DB write failure defers recovery rather than replaying paid generation', async () => {
  const f = fixture({ generate: async () => { throw new Error('provider unavailable'); },
    fail: async () => { throw new Error('database unavailable'); } });
  await f.run(); assert.equal(f.records.at(-1)?.event, 'generation_terminal_write_deferred');
});

test('production wiring keeps quota holds, acceptance, auth and default-off deployment gate', () => {
  const service = readFileSync(new URL('./lesson-author-durable-blueprint.service.ts', import.meta.url), 'utf8');
  const chat = readFileSync(new URL('./chat.service.ts', import.meta.url), 'utf8');
  const quota = readFileSync(new URL('./ai-token-quota.service.ts', import.meta.url), 'utf8');
  const config = readFileSync(new URL('../../config/env.ts', import.meta.url), 'utf8');
  assert.match(service, /await reconstruct\(current\)/);
  assert.match(service, /await verifyReservation\(current\)/);
  assert.match(service, /durableBlueprintRepository.succeed/);
  assert.match(service, /generation_usage_pending_reconciliation/);
  assert.doesNotMatch(service, /estimateAiTurnUsage|applyLessonAuthorProposalToCourse/);
  assert.match(chat, /acceptAndPersistLessonAuthorBlueprint/);
  assert.match(chat, /assertDurableBlueprintActor/);
  assert.match(chat, /durable_generation: true/);
  assert.match(quota, /budget_metadata ->> 'durable_generation' IS DISTINCT FROM 'true'/);
  assert.match(config, /LESSON_AUTHOR_GENERATION_ENABLED: optionalBoolean\('LESSON_AUTHOR_GENERATION_ENABLED', false\)/);
});
