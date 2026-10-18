import assert from 'node:assert/strict';
import test from 'node:test';
import type { AiUsage, TenantAiRuntimeSettings } from './ai-engine.types.js';
import { withMeteredAiCall, type MeteredAiCall, type MeteredAiDeps } from './ai-metered-call.service.js';

const TENANT = '11111111-1111-4111-8111-111111111111';

function harness(overrides: Partial<MeteredAiDeps> = {}) {
  const calls: Array<{ kind: string; input: any }> = [];
  const deps: MeteredAiDeps = {
    settings: async () => ({ activeEngine: 'self_built_rag', provider: 'google_ai_studio' }) as TenantAiRuntimeSettings,
    reserve: (async (input: any) => { calls.push({ kind: 'reserve', input }); return { id: 'r-1', reservedTokens: input.maximumTokens, minimumTokens: input.minimumTokens, maximumTokens: input.maximumTokens, remainingTokens: null, isPartialGrant: false }; }) as any,
    finalize: (async (input: any) => { calls.push({ kind: 'finalize', input }); }) as any,
    release: (async (id: string, tenantId: string) => { calls.push({ kind: 'release', input: { id, tenantId } }); }) as any,
    ...overrides,
  };
  return { deps, calls };
}

const call: MeteredAiCall = {
  tenantId: TENANT, userId: 'u-1', conversationId: 'c-1', target: 'admin', operation: 'chat',
  model: 'gemini-3.8-flash', feature: 'report_chat_router', promptParts: ['x'.repeat(300)], maxOutputTokens: 1_280,
};

test('reserves the most the call can cost, then settles with the provider usage', async () => {
  const { deps, calls } = harness();
  const usage: AiUsage = { inputTokens: 90, outputTokens: 200, embeddingTokens: 0, totalTokens: 290, cachedInputTokens: 40 };
  const value = await withMeteredAiCall(call, async () => ({ value: 'answer', usage }), deps);
  assert.equal(value, 'answer');
  assert.deepEqual(calls.map(c => c.kind), ['reserve', 'finalize']);
  const reserve = calls[0]!.input;
  assert.equal(reserve.minimumTokens, 100 + 1_280);
  assert.equal(reserve.maximumTokens, 100 + 1_280);
  assert.equal(reserve.engine, 'self_built_rag');
  assert.equal(reserve.budget.metadata.feature, 'report_chat_router');
  assert.equal(reserve.budget.metadata.durable_generation, undefined, 'short calls stay sweepable');
  const finalize = calls[1]!.input;
  assert.deepEqual(finalize.usage, usage);
  assert.equal(finalize.source.usage_source, 'provider');
  assert.equal(finalize.metadata.feature, 'report_chat_router');
});

test('without provider usage the settlement is an estimate, labelled as such', async () => {
  const { deps, calls } = harness();
  await withMeteredAiCall(call, async () => ({ value: 1, usage: null, outputText: 'y'.repeat(30) }), deps);
  const finalize = calls.find(c => c.kind === 'finalize')!.input;
  assert.deepEqual(finalize.usage, { inputTokens: 100, outputTokens: 10, embeddingTokens: 0, totalTokens: 110 });
  assert.equal(finalize.source.usage_source, 'local_estimate');
});

test('a failed call releases its reservation and rethrows', async () => {
  const { deps, calls } = harness();
  await assert.rejects(withMeteredAiCall(call, async () => { throw new Error('provider down'); }, deps), /provider down/);
  assert.deepEqual(calls.map(c => c.kind), ['reserve', 'release']);
});

test('used-up AI points stop the call before the provider is asked', async () => {
  let ran = false;
  const { deps } = harness({ reserve: (async () => { throw Object.assign(new Error('limit'), { code: 'AI_CREDIT_LIMIT_REACHED' }); }) as any });
  await assert.rejects(withMeteredAiCall(call, async () => { ran = true; return { value: 1, usage: null }; }, deps), /limit/);
  assert.equal(ran, false);
});

test('a settlement failure keeps the paid answer', async () => {
  const { deps } = harness({ finalize: (async () => { throw new Error('db busy'); }) as any });
  const original = console.error;
  console.error = () => undefined;
  try {
    assert.equal(await withMeteredAiCall(call, async () => ({ value: 'kept', usage: null }), deps), 'kept');
  } finally {
    console.error = original;
  }
});

test('long calls (audio) add the unseen input and are never swept while running', async () => {
  const { deps, calls } = harness();
  await withMeteredAiCall({ ...call, promptParts: [], extraInputTokens: 3_200, maxOutputTokens: 1_824, longRunning: true },
    async () => ({ value: 'transcript', usage: null, outputText: '' }), deps);
  const reserve = calls[0]!.input;
  assert.equal(reserve.maximumTokens, 1 + 3_200 + 1_824);
  assert.equal(reserve.budget.metadata.durable_generation, true);
});

test('a call that failed after billing settles the provider usage, then rethrows the original error', async () => {
  const { BilledAiCallError } = await import('./ai-metered-call.service.js');
  const { deps, calls } = harness();
  const billed = { inputTokens: 120_000, outputTokens: 0, embeddingTokens: 0, totalTokens: 120_000 };
  const original = new Error('empty transcript');
  await assert.rejects(withMeteredAiCall(call, async () => { throw new BilledAiCallError(billed, original); }, deps),
    (error: unknown) => error === original);
  assert.deepEqual(calls.map(c => c.kind), ['reserve', 'finalize']);
  const finalize = calls[1]!.input;
  assert.deepEqual(finalize.usage, billed);
  assert.equal(finalize.metadata.failed_after_billing, true);
});

test('when the billed usage cannot be recorded, the reservation is released and the failure is logged by kind only', async (t) => {
  const { BilledAiCallError } = await import('./ai-metered-call.service.js');
  const finalizeFailure = Object.assign(new Error(`ledger insert failed for tenant ${TENANT}`), { code: '40P01' });
  const { deps, calls } = harness();
  deps.finalize = async input => { calls.push({ kind: 'finalize', input }); throw finalizeFailure; };
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); });
  const original = new Error('empty transcript');
  await assert.rejects(withMeteredAiCall(call, async () => { throw new BilledAiCallError({ inputTokens: 10, outputTokens: 0, embeddingTokens: 0, totalTokens: 10 }, original); }, deps),
    (error: unknown) => error === original);
  // The billing decision is unchanged: settle first, release only when that fails.
  assert.deepEqual(calls.map(c => c.kind), ['reserve', 'finalize', 'release']);
  assert.deepEqual(warnings, ['[BestEffort] {"event":"best_effort_failed","tag":"ai_tokens.billed_usage_finalize","error_kind":"Error:40P01"}']);
  assert.ok(warnings.every(line => !line.includes(TENANT) && !line.includes('ledger')), 'no data in the log');
});
