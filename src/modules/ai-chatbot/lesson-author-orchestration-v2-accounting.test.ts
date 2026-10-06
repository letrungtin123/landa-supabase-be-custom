import assert from 'node:assert/strict';
import test from 'node:test';
import type { GenerationJobSql } from './lesson-author-generation-job.repository.js';
import { createOrchestrationV2QuotaAccounting } from './lesson-author-orchestration-v2-accounting.service.js';
import { orchestrationV2Hash } from './lesson-author-orchestration-v2.logic.js';
import type { OrchestrationV2TaskLease } from './lesson-author-orchestration-v2-worker.repository.js';

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const settings = {
  tenantId: uuid(4), activeEngine: 'self_built_rag' as const, provider: 'google_ai_studio' as const,
  monthlyTokenLimit: null, tokenTimezone: 'Asia/Saigon', chatModel: 'chat', lessonAuthorModel: 'model',
  embeddingModel: 'gemini-embedding-001', embeddingDimensions: 768, transitionState: 'idle' as const,
  activeTransitionJobId: null, hasGoogleAiStudioKey: true, apiKeyFingerprint: 'fingerprint',
};
const providerTask = {
  id: uuid(1), run_id: uuid(2), workspace_id: uuid(3), tenant_id: uuid(4), model: 'model',
  kind: 'generate_unit', input_tokens: 200_000, embedding_tokens: 0, max_output_tokens: 65_536,
  provider_max_attempts: 2, ai_reservation_id: uuid(8),
};
const lease: OrchestrationV2TaskLease = {
  task_id: uuid(1), run_id: uuid(2), workspace_id: uuid(3), tenant_id: uuid(4), course_id: 'course',
  task_key: 'content:chapter-1:unit:1', kind: 'generate_unit', chapter_key: 'chapter-1', node_id: uuid(6),
  contract_hash: orchestrationV2Hash('contract'), input_context_hash: orchestrationV2Hash('input'),
  source_snapshot_id: uuid(7), source_snapshot_hash: orchestrationV2Hash('source'),
  runtime_config_hash: orchestrationV2Hash('runtime'), model: 'model', locale: 'vi', max_output_tokens: 65_536,
  provider_max_attempts: 2, execution_budget_ms: 600_000, lease_token: uuid(9), dispatch_epoch: 1,
  provider_replay_required: false,
  routing_shard: 0, ai_reservation_id: uuid(8),
};

function sql(responses: Record<string, unknown>[][]): GenerationJobSql {
  return { async query<T extends Record<string, unknown>>() {
    const rows = responses.shift();
    assert.notEqual(rows, undefined);
    return { rows: rows as T[], rowCount: rows!.length };
  } };
}

test('quota reserve is exact, task-bound and rejects partial grants', async () => {
  let requested = 0;
  const accounting = createOrchestrationV2QuotaAccounting({
    settings: async () => settings,
    reserve: async input => {
      requested = input.maximumTokens ?? 0;
      return { id: uuid(8), reservedTokens: requested, minimumTokens: requested, maximumTokens: requested,
        remainingTokens: null, isPartialGrant: false };
    },
    finalize: async () => undefined,
    release: async () => undefined,
  });
  const total = 200_000 + 65_536 * 2;
  const tx = sql([
    [{ requested_by: uuid(10), conversation_id: uuid(11), correlation_id: uuid(12) }],
    [{ id: uuid(8), status: 'reserved', estimated_tokens: String(total),
      budget_metadata: { orchestration_task_id: uuid(1), orchestration_run_id: uuid(2) } }],
  ]);
  assert.equal(await accounting.reserveProvider(tx, providerTask), uuid(8));
  assert.equal(requested, total);
});

test('quota accounting accepts the V2 model resolved from a legacy tenant setting', async () => {
  const legacySettings = { ...settings, lessonAuthorModel: 'gemini-3.5-flash' };
  const resolvedTask = { ...providerTask, model: 'gemini-3.8-flash' };
  const resolvedLease = { ...lease, model: 'gemini-3.8-flash' };
  const total = 200_000 + 65_536 * 2;
  let finalized = false;
  const accounting = createOrchestrationV2QuotaAccounting({
    settings: async () => legacySettings,
    reserve: async () => ({ id: uuid(8), reservedTokens: total,
      minimumTokens: total, maximumTokens: total,
      remainingTokens: null, isPartialGrant: false }),
    finalize: async () => { finalized = true; },
    release: async () => undefined,
  });
  assert.equal(await accounting.reserveProvider(sql([
    [{ requested_by: uuid(10), conversation_id: uuid(11), correlation_id: uuid(12) }],
    [{ id: uuid(8), status: 'reserved', estimated_tokens: String(total),
      budget_metadata: { orchestration_task_id: uuid(1), orchestration_run_id: uuid(2) } }],
  ]), resolvedTask), uuid(8));
  await accounting.settleProvider(sql([
    [{ id: uuid(8), status: 'reserved' }],
    [{ status: 'finalized', ledger_count: 1 }],
  ]), resolvedLease, { inputTokens: 10, outputTokens: 20, embeddingTokens: 0, totalTokens: 30 });
  assert.equal(finalized, true);
});

test('settlement requires complete provider usage and confirms one ledger row', async () => {
  let finalized = false;
  const accounting = createOrchestrationV2QuotaAccounting({
    settings: async () => settings,
    reserve: async () => assert.fail('must not reserve'),
    finalize: async input => { finalized = true; assert.equal(input.reservationId, uuid(8)); },
    release: async () => undefined,
  });
  await assert.rejects(() => accounting.settleProvider(sql([]), lease, { inputTokens: 1 }),
    { code: 'ORCHESTRATION_V2_ACCOUNTING_USAGE_INCOMPLETE' });
  await accounting.settleProvider(sql([
    [{ id: uuid(8), status: 'reserved' }],
    [{ status: 'finalized', ledger_count: 1 }],
  ]), lease, { inputTokens: 10, outputTokens: 20, embeddingTokens: 0, totalTokens: 30 });
  assert.equal(finalized, true);
});

test('uncertain provider response settles once at the reserved upper bound', async () => {
  let finalizedUsage: unknown = null;
  let finalizedSource = '';
  const accounting = createOrchestrationV2QuotaAccounting({
    settings: async () => settings,
    reserve: async () => assert.fail('must not reserve'),
    finalize: async input => {
      finalizedUsage = input.usage;
      finalizedSource = String(input.source?.usage_source);
    },
    release: async () => assert.fail('must not release'),
  });
  await accounting.settleProvider(sql([
    [{ id: uuid(8), status: 'reserved', estimated_tokens: '331072',
      budget_input_tokens: '200000', budget_output_tokens: '131072', budget_embedding_tokens: '0' }],
    [{ status: 'finalized', ledger_count: 1 }],
  ]), lease, {}, 'reserved_upper_bound');
  assert.deepEqual(finalizedUsage, {
    inputTokens: 200_000, outputTokens: 131_072, embeddingTokens: 0, totalTokens: 331_072,
  });
  assert.equal(finalizedSource, 'reserved_upper_bound');
});

test('recovery releases only reserved undispatched quota and preserves unknown quota', async () => {
  let released = false;
  const accounting = createOrchestrationV2QuotaAccounting({
    settings: async () => settings,
    reserve: async () => assert.fail('must not reserve'),
    finalize: async () => assert.fail('must not finalize'),
    release: async () => { released = true; },
  });
  await accounting.releaseUndispatched(sql([[{ id: uuid(8) }], [{ status: 'released' }]]), providerTask);
  assert.equal(released, true);
  await accounting.holdUnknown(sql([[{ id: uuid(8), status: 'reserved', budget_metadata: {
    orchestration_v2_accounting: { state: 'pending_reconciliation', task_id: uuid(1) },
  } }]]), providerTask);
});
