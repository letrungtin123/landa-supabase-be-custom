import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConfirmChannel, ConsumeMessage } from 'amqplib';
import {
  orchestrationV2DispatchEnvelope,
  readOrchestrationV2DispatchEnvelope,
} from './lesson-author-orchestration-v2-dispatch.logic.js';
import {
  orchestrationV2ExecutionRuntimeHash,
  ORCHESTRATION_V2_EXECUTION_POLICY,
  resolveOrchestrationV2LessonAuthorModel,
} from './lesson-author-orchestration-v2-execution.config.js';
import { orchestrationV2Hash } from './lesson-author-orchestration-v2.logic.js';
import {
  handleOrchestrationV2Delivery,
  runOrchestrationV2WorkerRecoveryCycle,
  type OrchestrationV2WorkerRuntimeDependencies,
} from './lesson-author-orchestration-v2-worker.service.js';
import { startOrchestrationV2RabbitConsumer } from './lesson-author-orchestration-v2-rabbit.service.js';
import type { OrchestrationV2TaskLease, createOrchestrationV2WorkerRepository } from './lesson-author-orchestration-v2-worker.repository.js';

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const envelope = orchestrationV2DispatchEnvelope({
  outbox_id: uuid(1), run_id: uuid(2), task_id: uuid(3), dispatch_epoch: 0, routing_shard: 4,
});
const raw = Buffer.from(JSON.stringify(envelope));
const lease: OrchestrationV2TaskLease = {
  task_id: uuid(3), run_id: uuid(2), workspace_id: uuid(4), tenant_id: uuid(5), course_id: 'course-v1:test+1+2026',
  task_key: 'source:snapshot', kind: 'source_snapshot', chapter_key: null, node_id: null,
  contract_hash: orchestrationV2Hash('contract'), input_context_hash: orchestrationV2Hash('input'),
  source_snapshot_id: uuid(6), source_snapshot_hash: orchestrationV2Hash('source'),
  runtime_config_hash: orchestrationV2Hash('runtime'), model: 'gemini-test', locale: 'vi',
  max_output_tokens: 0, provider_max_attempts: 0, execution_budget_ms: 60_000,
  lease_token: uuid(7), dispatch_epoch: 1, provider_replay_required: false,
  routing_shard: 4, ai_reservation_id: null,
};

type Worker = ReturnType<typeof createOrchestrationV2WorkerRepository>;

function deps(claim: Worker['claimExact'], execute: OrchestrationV2WorkerRuntimeDependencies['execute']) {
  const events: Record<string, unknown>[] = [];
  const repository = {
    claimExact: claim,
    deferPublished: async () => ({ delay_ms: 5_000, deferral_count: 1 }),
    wakeOneCapacityDeferred: async () => null,
    renew: async () => true,
    recoverClaimFailure: async () => 'requeued' as const,
    recoverOne: async () => null,
  } as unknown as Worker;
  const value: OrchestrationV2WorkerRuntimeDependencies = {
    repository,
    limits: { global_concurrency_limit: 8, provider_concurrency_limit: 2, lease_seconds: 30 },
    reserveProvider: async () => uuid(9),
    releaseUndispatched: async () => undefined,
    releaseRejected: async () => undefined,
    holdUnknown: async () => undefined,
    execute,
    report: event => { events.push(event); },
  };
  return { value, events };
}

test('broker parser rejects extra fields and exact runtime hash is stable', () => {
  assert.deepEqual(readOrchestrationV2DispatchEnvelope(JSON.parse(raw.toString())), envelope);
  assert.throws(() => readOrchestrationV2DispatchEnvelope({ ...envelope, tenant_id: uuid(5) }),
    { code: 'ORCHESTRATION_V2_DISPATCH_IDENTITY_INVALID' });
  const settings = { activeEngine: 'self_built_rag' as const, provider: 'google_ai_studio' as const,
    lessonAuthorModel: 'gemini-test', embeddingModel: 'gemini-embedding-001', embeddingDimensions: 768,
    transitionState: 'idle' as const };
  const a = orchestrationV2ExecutionRuntimeHash({ settings, allowed_component_types: new Set(['html', 'problem']) });
  const b = orchestrationV2ExecutionRuntimeHash({ settings, allowed_component_types: new Set(['problem', 'html']) });
  assert.equal(a, b);
  assert.equal(ORCHESTRATION_V2_EXECUTION_POLICY.planning.chapter.max_provider_attempts, 2);
});

test('capacity saturation is durably deferred with database-authoritative backoff telemetry', async () => {
  const runtime = deps(async () => ({ disposition: 'deferred', reason: 'provider_capacity' }), async () => undefined);
  let observedJitter = -1;
  runtime.value.repository.deferPublished = async (_envelope, jitterMs) => {
    observedJitter = jitterMs;
    return { delay_ms: 40_777, deferral_count: 4 };
  };
  const result = await handleOrchestrationV2Delivery(raw, runtime.value);
  assert.equal(result.settlement, 'ack');
  assert.equal(result.disposition, 'deferred');
  assert.equal(Number.isSafeInteger(observedJitter) && observedJitter >= 0 && observedJitter <= 4_999, true);
  const event = runtime.events.find(item => item.event === 'worker_delivery_deferred_durably');
  assert.equal(event?.delay_ms, 40_777);
  assert.equal(event?.deferral_count, 4);
});

test('V2 resolves only the legacy Lesson Author model to Gemini 3.8', () => {
  assert.equal(resolveOrchestrationV2LessonAuthorModel('gemini-3.5-flash'), 'gemini-3.8-flash');
  assert.equal(resolveOrchestrationV2LessonAuthorModel('models/gemini-3.5-flash'), 'gemini-3.8-flash');
  assert.equal(resolveOrchestrationV2LessonAuthorModel(' gemini-3.5-flash '), 'gemini-3.8-flash');
  assert.equal(resolveOrchestrationV2LessonAuthorModel('gemini-custom'), 'gemini-custom');
});

test('definitive provider rejection is finalized immediately instead of waiting for lease recovery', async () => {
  const providerLease = { ...lease, kind: 'course_skeleton' as const, task_key: 'architecture:course',
    max_output_tokens: 65_536, provider_max_attempts: 1, ai_reservation_id: uuid(9) };
  let finalized = '';
  const rejected = deps(async () => ({ disposition: 'claimed', lease: providerLease }), async () => {
    throw Object.assign(new Error('safe provider rejection'), { code: 'AI_PROVIDER_REQUEST_REJECTED' });
  });
  rejected.value.repository.failProviderRejected = async (_lease, code) => { finalized = code; };
  const result = await handleOrchestrationV2Delivery(raw, rejected.value);
  assert.equal(result.settlement, 'ack');
  assert.equal(result.disposition, 'claimed_failed');
  assert.equal(finalized, 'AI_PROVIDER_REQUEST_REJECTED');
  assert.ok(rejected.events.some(event => event.event === 'worker_provider_rejection_finalized'));
});

test('delivery ACK matrix is DB-authoritative and never broker-retries post-claim execution', async () => {
  const deferred = deps(async () => ({ disposition: 'deferred', reason: 'provider_capacity' }),
    async () => assert.fail('must not execute'));
  assert.deepEqual(await handleOrchestrationV2Delivery(raw, deferred.value),
    { settlement: 'ack', disposition: 'deferred', envelope });

  const publicationRace = deps(async () => ({ disposition: 'deferred', reason: 'publication_race' }),
    async () => assert.fail('must not execute'));
  publicationRace.value.repository.deferPublished = async () => assert.fail('publication race is not capacity');
  assert.deepEqual(await handleOrchestrationV2Delivery(raw, publicationRace.value),
    { settlement: 'requeue', disposition: 'deferred', envelope });

  const uncertain = deps(async () => { throw new Error('db unavailable'); }, async () => assert.fail('must not execute'));
  const uncertainResult = await handleOrchestrationV2Delivery(raw, uncertain.value);
  assert.equal(uncertainResult.settlement, 'requeue');
  assert.equal(uncertainResult.disposition, 'claim_unconfirmed');

  const failed = deps(async () => ({ disposition: 'claimed', lease }), async () => { throw new Error('provider failed'); });
  const failedResult = await handleOrchestrationV2Delivery(raw, failed.value);
  assert.equal(failedResult.settlement, 'ack');
  assert.equal(failedResult.disposition, 'claimed_failed');
  assert.ok(failed.events.some(event => event.event === 'worker_claim_failure_finalized'
    && event.failure_code === 'ORCHESTRATION_V2_TASK_EXECUTION_FAILED' && event.recovery === 'requeued'));

  const invalid = deps(async () => assert.fail('must not claim'), async () => assert.fail('must not execute'));
  const invalidResult = await handleOrchestrationV2Delivery('{"contract_version":2}', invalid.value);
  assert.equal(invalidResult.settlement, 'ack');
  assert.equal(invalidResult.disposition, 'invalid');
});

test('claimed execution failure passes the configured accounting reconciler to atomic recovery', async () => {
  const failed = deps(async () => ({ disposition: 'claimed', lease }), async () => {
    throw new Error('provider failed');
  });
  const reconciler = async () => undefined;
  failed.value.reconcileUnknown = reconciler;
  let received: unknown;
  failed.value.repository.recoverClaimFailure = async (_lease, _code, _release, _hold, reconcile) => {
    received = reconcile;
    return 'requeued';
  };
  await handleOrchestrationV2Delivery(raw, failed.value);
  assert.equal(received, reconciler);
});

test('worker failure telemetry exposes only bounded stage and PostgreSQL diagnostics', async () => {
  const failure = Object.assign(new Error('Provider V2 success requires dispatch and settled accounting'), {
    code: '23514', orchestration_stage: 'unit_publication',
    table: 'lesson_author_workspace_v2_tasks', constraint: 'trg_la_ws_v2_task_guard',
  });
  const failed = deps(async () => ({ disposition: 'claimed', lease }), async () => { throw failure; });
  await handleOrchestrationV2Delivery(raw, failed.value);
  const event = failed.events.find(candidate => candidate.event === 'worker_task_failed');
  assert.deepEqual(event && {
    sqlstate: event.sqlstate, stage: event.execution_stage, table: event.db_table,
    constraint: event.db_constraint, message: event.db_message,
  }, {
    sqlstate: '23514', stage: 'unit_publication', table: 'lesson_author_workspace_v2_tasks',
    constraint: 'trg_la_ws_v2_task_guard',
    message: 'Provider V2 success requires dispatch and settled accounting',
  });
});

test('worker failure telemetry carries the unit acceptance reason (check, code, path) and never content', async () => {
  const { OrchestrationV2UnitError } = await import('./lesson-author-orchestration-v2-unit.logic.js');
  const rejection = Object.assign(new OrchestrationV2UnitError('ORCHESTRATION_V2_UNIT_BASELINE_INVALID',
    { check: 'coverage', code: 'HTML_DUPLICATE_BLOCK', path: 'components[0]' }), { orchestration_stage: 'unit_acceptance' });
  const failed = deps(async () => ({ disposition: 'claimed', lease }), async () => { throw rejection; });
  await handleOrchestrationV2Delivery(raw, failed.value);
  for (const name of ['worker_claim_failure_finalized', 'worker_task_failed']) {
    const event = failed.events.find(candidate => candidate.event === name)!;
    assert.deepEqual({ code: event.failure_code, stage: event.execution_stage, check: event.acceptance_check,
      reason: event.acceptance_code, path: event.acceptance_path }, { code: 'ORCHESTRATION_V2_UNIT_BASELINE_INVALID',
      stage: 'unit_acceptance', check: 'coverage', reason: 'HTML_DUPLICATE_BLOCK', path: 'components[0]' });
  }
  // Anything that is not a safe token (e.g. provider text smuggled into a reason) is dropped, not logged.
  const smuggled = Object.assign(new Error('x'), { acceptance: { check: 'coverage', code: 'Generated HTML <p>', path: 'c' } });
  const unsafe = deps(async () => ({ disposition: 'claimed', lease }), async () => { throw smuggled; });
  await handleOrchestrationV2Delivery(raw, unsafe.value);
  const event = unsafe.events.find(candidate => candidate.event === 'worker_task_failed')!;
  assert.equal('acceptance_code' in event || 'acceptance_check' in event || 'acceptance_path' in event, false);
});

test('worker recovery cycle is bounded and counts durable outcomes', async () => {
  const states: Array<'requeued' | 'outcome_unknown' | 'failed' | 'reconciled' | null> =
    ['requeued', 'outcome_unknown', 'failed', 'reconciled', null];
  const repository = { recoverOne: async () => states.shift() ?? null,
    wakeOneCapacityDeferred: async () => null } as unknown as Worker;
  const recoveryDeps = { repository,
    limits: { global_concurrency_limit: 8, provider_concurrency_limit: 2, lease_seconds: 30 },
    releaseUndispatched: async () => undefined, holdUnknown: async () => undefined,
    report: () => undefined };
  const result = await runOrchestrationV2WorkerRecoveryCycle(recoveryDeps, 10);
  assert.deepEqual(result, { requeued: 1, failed: 1, outcome_unknown: 1, reconciled: 1, capacity_woken: 0 });
  await assert.rejects(() => runOrchestrationV2WorkerRecoveryCycle(recoveryDeps, 0),
  /ORCHESTRATION_V2_WORKER_RECOVERY_CONFIG_INVALID/);
});

test('dedicated Rabbit consumer ACKs resolved deliveries and delays requeue for unresolved claims', async () => {
  async function run(claim: Worker['claimExact']) {
    const settlements: string[] = [];
    let onMessage: ((message: ConsumeMessage | null) => void) | undefined;
    const channel = {
      prefetch: async () => undefined,
      consume: async (_queue: string, callback: (message: ConsumeMessage | null) => void) => {
        onMessage = callback; return { consumerTag: 'consumer' };
      },
      ack: () => { settlements.push('ack'); },
      nack: (_message: ConsumeMessage, _allUpTo: boolean, requeue: boolean) => {
        settlements.push(requeue ? 'requeue' : 'drop');
      },
      cancel: async () => undefined,
    } as unknown as ConfirmChannel;
    const runtime = deps(claim, async () => undefined).value;
    const consumer = await startOrchestrationV2RabbitConsumer(channel, 'queue', 4, 100, runtime,
      new AbortController().signal);
    onMessage?.({ content: raw } as ConsumeMessage);
    await consumer.stop();
    return settlements;
  }
  assert.deepEqual(await run(async () => ({ disposition: 'duplicate' })), ['ack']);
  assert.deepEqual(await run(async () => { throw new Error('db unavailable'); }), ['requeue']);
});
