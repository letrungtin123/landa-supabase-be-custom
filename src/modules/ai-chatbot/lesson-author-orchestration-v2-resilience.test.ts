import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import type { ConfirmChannel, ConsumeMessage } from 'amqplib';
import { orchestrationV2Hash } from './lesson-author-orchestration-v2.logic.js';
import {
  isOrchestrationV2TransientPostgresError,
  runOrchestrationV2TransientSqlCycle,
  startOrchestrationV2RabbitConsumer,
} from './lesson-author-orchestration-v2-rabbit.service.js';
import {
  handleOrchestrationV2Delivery,
  type OrchestrationV2WorkerRuntimeDependencies,
} from './lesson-author-orchestration-v2-worker.service.js';
import type {
  OrchestrationV2TaskLease,
  createOrchestrationV2WorkerRepository,
} from './lesson-author-orchestration-v2-worker.repository.js';

type WorkerRepository = ReturnType<typeof createOrchestrationV2WorkerRepository>;
type Claim = WorkerRepository['claimExact'];

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const limits = { global_concurrency_limit: 64, provider_concurrency_limit: 8, lease_seconds: 5 };

function envelope(index = 1): string {
  return JSON.stringify({
    contract_version: 2,
    outbox_id: uuid(100_000 + index),
    run_id: uuid(200_000 + index),
    task_id: uuid(300_000 + index),
    dispatch_epoch: 0,
    routing_shard: index % 4_096,
  });
}

function lease(index = 1, overrides: Partial<OrchestrationV2TaskLease> = {}): OrchestrationV2TaskLease {
  return {
    task_id: uuid(300_000 + index),
    run_id: uuid(200_000 + index),
    workspace_id: uuid(400_000 + index),
    tenant_id: uuid(500_000 + index),
    course_id: `course-v1:test+${index}+2026`,
    task_key: `unit:${index}`,
    kind: 'generate_unit',
    chapter_key: `chapter_${index}`,
    node_id: uuid(600_000 + index),
    contract_hash: orchestrationV2Hash(`contract:${index}`),
    input_context_hash: orchestrationV2Hash(`input:${index}`),
    source_snapshot_id: uuid(700_000 + index),
    source_snapshot_hash: orchestrationV2Hash(`source:${index}`),
    runtime_config_hash: orchestrationV2Hash('runtime'),
    model: 'gemini-test',
    locale: 'vi',
    max_output_tokens: 65_536,
    provider_max_attempts: 2,
    execution_budget_ms: 10_000,
    lease_token: uuid(800_000 + index),
    dispatch_epoch: 1,
    ai_reservation_id: uuid(900_000 + index),
    routing_shard: index % 4_096,
    ...overrides,
  };
}

function runtime(input: {
  claimExact: Claim;
  execute?: OrchestrationV2WorkerRuntimeDependencies['execute'];
  renew?: WorkerRepository['renew'];
  report?: OrchestrationV2WorkerRuntimeDependencies['report'];
}): OrchestrationV2WorkerRuntimeDependencies {
  const repository = {
    claimExact: input.claimExact,
    renew: input.renew ?? (async () => true),
    recoverOne: async () => null,
  } as unknown as WorkerRepository;
  return {
    repository,
    limits,
    reserveProvider: async () => uuid(999_999),
    releaseUndispatched: async () => undefined,
    releaseRejected: async () => undefined,
    holdUnknown: async () => undefined,
    execute: input.execute ?? (async () => undefined),
    report: input.report ?? (() => undefined),
  } as OrchestrationV2WorkerRuntimeDependencies;
}

test('telemetry failure remains non-authoritative for all delivery decisions', async () => {
  const throwingReport = () => { throw new Error('telemetry unavailable'); };
  const duplicate = runtime({ claimExact: async () => ({ disposition: 'duplicate' }), report: throwingReport });
  const invalid = await handleOrchestrationV2Delivery('{not-json', duplicate);
  assert.equal(invalid.settlement, 'ack');
  assert.equal(invalid.disposition, 'invalid');
  assert.ok(invalid.error instanceof Error);
  const resolved = await handleOrchestrationV2Delivery(envelope(), duplicate);
  assert.equal(resolved.settlement, 'ack');
  assert.equal(resolved.disposition, 'duplicate');

  let executions = 0;
  const claimed = runtime({
    claimExact: async () => ({ disposition: 'claimed', lease: lease() }),
    execute: async () => { executions += 1; },
    report: throwingReport,
  });
  const completed = await handleOrchestrationV2Delivery(envelope(), claimed);
  assert.equal(completed.settlement, 'ack');
  assert.equal(completed.disposition, 'claimed_succeeded');
  assert.equal(executions, 1);
});

test('runtime cycles retry bounded PostgreSQL contention but fail fast on schema errors', async () => {
  assert.equal(isOrchestrationV2TransientPostgresError(Object.assign(new Error('lock'), { code: '55P03' })), true);
  assert.equal(isOrchestrationV2TransientPostgresError(Object.assign(new Error('schema'), { code: '42702' })), false);
  const reports: Record<string, unknown>[] = [];
  let attempts = 0;
  const result = await runOrchestrationV2TransientSqlCycle(async () => {
    attempts += 1;
    if (attempts < 3) throw Object.assign(new Error('deadlock'), { code: attempts === 1 ? '40P01' : '40001' });
    return 'recovered';
  }, new AbortController().signal, event => reports.push(event), 'dispatcher', () => 0);
  assert.equal(result, 'recovered');
  assert.equal(attempts, 3);
  assert.deepEqual(reports.map(event => event.event), [
    'dispatcher_transient_sql_retry', 'dispatcher_transient_sql_retry',
  ]);

  let schemaAttempts = 0;
  await assert.rejects(() => runOrchestrationV2TransientSqlCycle(async () => {
    schemaAttempts += 1;
    throw Object.assign(new Error('ambiguous column'), { code: '42702' });
  }, new AbortController().signal, () => undefined, 'worker_recovery', () => 0), { code: '42702' });
  assert.equal(schemaAttempts, 1);
});

test('20k duplicate-delivery storm executes one paid task exactly once', async t => {
  const deliveries = 20_000;
  let authorityClaimed = false;
  let executions = 0;
  const deps = runtime({
    claimExact: async () => {
      if (authorityClaimed) return { disposition: 'duplicate' };
      authorityClaimed = true;
      return { disposition: 'claimed', lease: lease() };
    },
    execute: async () => { executions += 1; },
  });
  const started = performance.now();
  const results = await Promise.all(Array.from({ length: deliveries },
    () => handleOrchestrationV2Delivery(envelope(), deps)));
  const durationMs = performance.now() - started;
  assert.equal(executions, 1);
  assert.equal(results.filter(result => result.disposition === 'claimed_succeeded').length, 1);
  assert.equal(results.filter(result => result.disposition === 'duplicate').length, deliveries - 1);
  assert.ok(results.every(result => result.settlement === 'ack'));
  t.diagnostic(JSON.stringify({ profile: 'duplicate_storm', deliveries, executions, duration_ms: durationMs }));
});

test('synthetic saturation never exceeds the provider concurrency ceiling', async t => {
  const deliveries = 512;
  let active = 0;
  let maximumActive = 0;
  let claimed = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const deps = runtime({
    claimExact: async raw => {
      if (active >= limits.provider_concurrency_limit) return { disposition: 'deferred' };
      active += 1;
      claimed += 1;
      maximumActive = Math.max(maximumActive, active);
      return { disposition: 'claimed', lease: lease(Number(raw.routing_shard) + 1) };
    },
    execute: async () => {
      try { await gate; } finally { active -= 1; }
    },
  });
  const started = performance.now();
  const pending = Promise.all(Array.from({ length: deliveries }, (_, index) =>
    handleOrchestrationV2Delivery(envelope(index + 1), deps)));
  await new Promise<void>(resolve => setImmediate(resolve));
  release();
  const results = await pending;
  const durationMs = performance.now() - started;
  assert.equal(claimed, limits.provider_concurrency_limit);
  assert.equal(maximumActive, limits.provider_concurrency_limit);
  assert.equal(active, 0);
  assert.equal(results.filter(result => result.disposition === 'claimed_succeeded').length,
    limits.provider_concurrency_limit);
  assert.equal(results.filter(result => result.disposition === 'deferred').length,
    deliveries - limits.provider_concurrency_limit);
  assert.ok(results.filter(result => result.disposition === 'deferred')
    .every(result => result.settlement === 'requeue'));
  t.diagnostic(JSON.stringify({ profile: 'provider_saturation', deliveries,
    provider_limit: limits.provider_concurrency_limit, maximum_active: maximumActive, duration_ms: durationMs }));
});

test('shutdown aborts claimed work but never broker-retries a possibly dispatched call', async () => {
  const shutdown = new AbortController();
  shutdown.abort(new Error('shutdown'));
  let sawAbort = false;
  const deps = runtime({
    claimExact: async () => ({ disposition: 'claimed', lease: lease() }),
    execute: async (_lease, signal) => {
      sawAbort = signal.aborted;
      throw signal.reason;
    },
  });
  const result = await handleOrchestrationV2Delivery(envelope(), deps, shutdown.signal);
  assert.equal(sawAbort, true);
  assert.equal(result.disposition, 'claimed_failed');
  assert.equal(result.settlement, 'ack');
});

test('lease loss aborts active execution and leaves recovery, not RabbitMQ, in authority', async () => {
  let renewals = 0;
  let abortReason = '';
  const deps = runtime({
    claimExact: async () => ({ disposition: 'claimed', lease: lease() }),
    renew: async () => { renewals += 1; return false; },
    execute: async (_lease, signal) => {
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => {
        abortReason = signal.reason instanceof Error ? signal.reason.message : String(signal.reason);
        reject(signal.reason);
      }, { once: true }));
    },
  });
  const result = await handleOrchestrationV2Delivery(envelope(), deps);
  assert.equal(renewals, 1);
  assert.equal(abortReason, 'ORCHESTRATION_V2_TASK_LEASE_LOST');
  assert.equal(result.disposition, 'claimed_failed');
  assert.equal(result.settlement, 'ack');
});

test('consumer does not attempt a second settlement when ACK itself fails', async () => {
  let callback: ((message: ConsumeMessage | null) => void) | undefined;
  let acknowledgements = 0;
  let negativeAcknowledgements = 0;
  const events: string[] = [];
  const channel = {
    prefetch: async () => undefined,
    consume: async (_queue: string, onMessage: (message: ConsumeMessage | null) => void) => {
      callback = onMessage;
      return { consumerTag: 'consumer' };
    },
    ack: () => { acknowledgements += 1; throw new Error('channel closed'); },
    nack: () => { negativeAcknowledgements += 1; },
    cancel: async () => undefined,
  } as unknown as ConfirmChannel;
  const deps = runtime({
    claimExact: async () => ({ disposition: 'duplicate' }),
    report: event => { events.push(String(event.event)); },
  });
  const consumer = await startOrchestrationV2RabbitConsumer(channel, 'queue', 8, 100, deps,
    new AbortController().signal);
  callback?.({ content: Buffer.from(envelope()) } as ConsumeMessage);
  await consumer.stop();
  assert.equal(acknowledgements, 1);
  assert.equal(negativeAcknowledgements, 0);
  assert.ok(events.includes('worker_delivery_settlement_failed'));
});

test('consumer stop is idempotent and both callers wait for the same in-flight drain', async () => {
  let callback: ((message: ConsumeMessage | null) => void) | undefined;
  let cancellations = 0;
  let acknowledgements = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const channel = {
    prefetch: async () => undefined,
    consume: async (_queue: string, onMessage: (message: ConsumeMessage | null) => void) => {
      callback = onMessage;
      return { consumerTag: 'consumer' };
    },
    ack: () => { acknowledgements += 1; },
    nack: () => assert.fail('successful drain must not requeue'),
    cancel: async () => { cancellations += 1; },
  } as unknown as ConfirmChannel;
  const deps = runtime({
    claimExact: async () => ({ disposition: 'claimed', lease: lease() }),
    execute: async () => gate,
  });
  const consumer = await startOrchestrationV2RabbitConsumer(channel, 'queue', 8, 100, deps,
    new AbortController().signal);
  callback?.({ content: Buffer.from(envelope()) } as ConsumeMessage);
  assert.equal(consumer.inFlight(), 1);
  const first = consumer.stop();
  const second = consumer.stop();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(acknowledgements, 0);
  release();
  await Promise.all([first, second]);
  assert.equal(cancellations, 1);
  assert.equal(acknowledgements, 1);
  assert.equal(consumer.inFlight(), 0);
});
