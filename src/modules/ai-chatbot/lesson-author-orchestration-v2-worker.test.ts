import assert from 'node:assert/strict';
import test from 'node:test';
import type { GenerationJobDatabase, GenerationJobSql } from './lesson-author-generation-job.repository.js';
import { orchestrationV2DispatchEnvelope } from './lesson-author-orchestration-v2-dispatch.logic.js';
import { orchestrationV2Hash } from './lesson-author-orchestration-v2.logic.js';
import { createOrchestrationV2WorkerRepository } from './lesson-author-orchestration-v2-worker.repository.js';
import {
  assertOrchestrationV2WorkerLimits,
  isOrchestrationV2ProviderTask,
  orchestrationV2ObservedUsage,
} from './lesson-author-orchestration-v2-worker.logic.js';

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const hash = (value: string) => orchestrationV2Hash(value);
const envelope = orchestrationV2DispatchEnvelope({
  outbox_id: uuid(1), run_id: uuid(2), task_id: uuid(3), dispatch_epoch: 0, routing_shard: 19,
});
const limits = { global_concurrency_limit: 64, provider_concurrency_limit: 8, lease_seconds: 30 };

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: uuid(3), run_id: uuid(2), workspace_id: uuid(4), tenant_id: uuid(5), course_id: 'course-v1:test+1+2026',
    task_key: 'source:snapshot', kind: 'source_snapshot', chapter_key: null, node_id: null,
    contract_hash: hash('contract'), input_context_hash: hash('input'), source_snapshot_id: uuid(6), source_snapshot_hash: hash('source'),
    runtime_config_hash: hash('runtime'),
    model: 'gemini-test', locale: 'vi', max_output_tokens: 0, provider_max_attempts: 0,
    execution_budget_ms: 60_000, lease_token: null, dispatch_epoch: 0, ai_reservation_id: null,
    attempt_count: 0, max_attempts: 2, status: 'queued', run_status: 'planning', outbox_status: 'published',
    tenant_concurrency_limit: 16, workspace_concurrency_limit: 4, dispatch_started_at: null,
    accounting_state: 'not_required', routing_shard: 19,
    ...overrides,
  };
}

function fixture(responses: Array<Record<string, unknown>[]>) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const events: string[] = [];
  const tx: GenerationJobSql = {
    async query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
      queries.push({ sql, params });
      const rows = responses.shift();
      assert.notEqual(rows, undefined, `unexpected SQL: ${sql}`);
      return { rows: rows as T[], rowCount: rows!.length };
    },
  };
  const db: GenerationJobDatabase = {
    async transaction<T>(work: (value: GenerationJobSql) => Promise<T>) {
      events.push('BEGIN');
      try { const value = await work(tx); events.push('COMMIT'); return value; }
      catch (error) { events.push('ROLLBACK'); throw error; }
    },
  };
  return {
    repo: createOrchestrationV2WorkerRepository(db, () => uuid(9)), queries, events,
    done: () => assert.equal(responses.length, 0),
  };
}

function routedFixture(
  route: (sql: string, params: unknown[], index: number) => Record<string, unknown>[] | undefined,
) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const events: string[] = [];
  const tx: GenerationJobSql = {
    async query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
      const index = queries.length;
      queries.push({ sql, params });
      const rows = route(sql, params, index);
      assert.notEqual(rows, undefined, `unexpected SQL: ${sql}`);
      return { rows: rows as T[], rowCount: rows!.length };
    },
  };
  const db: GenerationJobDatabase = {
    async transaction<T>(work: (value: GenerationJobSql) => Promise<T>) {
      events.push('BEGIN');
      try { const value = await work(tx); events.push('COMMIT'); return value; }
      catch (error) { events.push('ROLLBACK'); throw error; }
    },
  };
  return { repo: createOrchestrationV2WorkerRepository(db, () => uuid(9)), queries, events };
}

test('worker bounds and usage contracts are strict and provider kinds are explicit', () => {
  assert.deepEqual(assertOrchestrationV2WorkerLimits(limits), limits);
  assert.throws(() => assertOrchestrationV2WorkerLimits({ ...limits, provider_concurrency_limit: 65 }),
    { code: 'ORCHESTRATION_V2_WORKER_CONFIG_INVALID' });
  assert.throws(() => assertOrchestrationV2WorkerLimits({ ...limits, lease_seconds: 46 }),
    { code: 'ORCHESTRATION_V2_WORKER_CONFIG_INVALID' });
  assert.equal(isOrchestrationV2ProviderTask('course_skeleton'), true);
  assert.equal(isOrchestrationV2ProviderTask('source_snapshot'), false);
  assert.deepEqual(orchestrationV2ObservedUsage({ inputTokens: 10, outputTokens: 2 }), { inputTokens: 10, outputTokens: 2 });
  assert.throws(() => orchestrationV2ObservedUsage({ secret: 1 }),
    { code: 'ORCHESTRATION_V2_WORKER_PAYLOAD_INVALID' });
});

test('exact deterministic claim serializes limits and consumes delivery atomically without quota reservation', async () => {
  const claimed = task({ status: 'running', lease_token: uuid(9), dispatch_epoch: 1, attempt_count: 1 });
  const f = fixture([
    [{ tenant_id: uuid(5), workspace_id: uuid(4) }], [], [task()], [{ count: 0 }],
    [{ global_running: 0, provider_running: 0, tenant_running: 0, workspace_running: 0 }],
    [claimed], [{ id: envelope.outbox_id }],
  ]);
  const result = await f.repo.claimExact(envelope, limits, async () => assert.fail('deterministic task must not reserve'));
  assert.equal(result.disposition, 'claimed');
  if (result.disposition === 'claimed') {
    assert.equal(result.lease.kind, 'source_snapshot');
    assert.equal(result.lease.dispatch_epoch, 1);
    assert.equal(result.lease.ai_reservation_id, null);
  }
  assert.match(f.queries[1]!.sql, /pg_advisory_xact_lock/);
  assert.match(f.queries[4]!.sql, /provider_running/);
  assert.match(f.queries[5]!.sql, /attempt_count=attempt_count\+1,dispatch_epoch=dispatch_epoch\+1/);
  assert.match(f.queries[5]!.sql, /FROM \(SELECT clock_timestamp\(\) AS claimed_at\) claim_clock/);
  assert.equal((f.queries[5]!.sql.match(/clock_timestamp\(\)/g) ?? []).length, 1,
    'claim timestamps must come from one database instant');
  assert.match(f.queries[6]!.sql, /status='consumed'/);
  assert.deepEqual(f.events, ['BEGIN', 'COMMIT']); f.done();
});

test('provider claim reserves inside the transaction and binds the reservation to its lease', async () => {
  const provider = task({ task_key: 'architecture:course', kind: 'course_skeleton', max_output_tokens: 65_536,
    provider_max_attempts: 2, accounting_state: 'reserved' });
  const claimed = { ...provider, status: 'running', lease_token: uuid(9), dispatch_epoch: 1,
    attempt_count: 1, ai_reservation_id: uuid(10) };
  const f = fixture([
    [{ tenant_id: uuid(5), workspace_id: uuid(4) }], [], [provider], [{ count: 0 }],
    [{ global_running: 4, provider_running: 2, tenant_running: 1, workspace_running: 0 }],
    [claimed], [{ id: envelope.outbox_id }],
  ]);
  const result = await f.repo.claimExact(envelope, limits, async (tx, row) => {
    assert.equal(tx === (tx as GenerationJobSql), true);
    assert.equal(row.kind, 'course_skeleton');
    return uuid(10);
  });
  assert.equal(result.disposition, 'claimed');
  if (result.disposition === 'claimed') assert.equal(result.lease.ai_reservation_id, uuid(10));
  assert.equal(f.queries[5]!.params[4], uuid(10)); f.done();
});

test('saturated claim is deferred without reservation, task mutation or delivery consumption', async () => {
  const f = fixture([
    [{ tenant_id: uuid(5), workspace_id: uuid(4) }], [], [task()], [{ count: 0 }],
    [{ global_running: 64, provider_running: 8, tenant_running: 16, workspace_running: 4 }],
  ]);
  const result = await f.repo.claimExact(envelope, limits, async () => assert.fail('must not reserve'));
  assert.deepEqual(result, { disposition: 'deferred' });
  assert.equal(f.queries.length, 5); f.done();
});

test('broker delivery racing the published CAS is requeued instead of acknowledged stale', async () => {
  const f = fixture([
    [{ tenant_id: uuid(5), workspace_id: uuid(4) }], [],
    [task({ outbox_status: 'publishing' })],
  ]);
  assert.deepEqual(await f.repo.claimExact(envelope, limits, async () => assert.fail('must not reserve')),
    { disposition: 'deferred' });
  assert.equal(f.queries.length, 3);
  f.done();
});

test('duplicate published delivery is consumed only for already claimed or terminal task', async () => {
  const f = fixture([
    [{ tenant_id: uuid(5), workspace_id: uuid(4) }], [],
    [task({ status: 'running', outbox_status: 'published' })], [{ id: envelope.outbox_id }],
  ]);
  assert.deepEqual(await f.repo.claimExact(envelope, limits, async () => assert.fail('must not reserve')),
    { disposition: 'duplicate' });
  assert.match(f.queries[3]!.sql, /status='consumed'/); f.done();
});

test('provider dispatch marker precedes artifact/accounting success in lease-fenced transactions', async () => {
  const lease = {
    task_id: uuid(3), run_id: uuid(2), workspace_id: uuid(4), tenant_id: uuid(5), course_id: 'course',
    task_key: 'architecture:course', kind: 'course_skeleton' as const, chapter_key: null, node_id: null,
    contract_hash: hash('contract'), input_context_hash: hash('input'), source_snapshot_id: uuid(6), source_snapshot_hash: hash('source'),
    runtime_config_hash: hash('runtime'),
    model: 'gemini-test', locale: 'vi' as const, max_output_tokens: 65_536, provider_max_attempts: 2,
    execution_budget_ms: 60_000, lease_token: uuid(9), dispatch_epoch: 1, ai_reservation_id: uuid(10),
    routing_shard: 19,
  };
  const marker = fixture([[{ id: lease.task_id }]]);
  await marker.repo.markProviderDispatched(lease);
  assert.match(marker.queries[0]!.sql, /dispatch_started_at=clock_timestamp\(\)/); marker.done();

  const resultHash = hash('artifact');
  const success = routedFixture(sql => {
    if (/pg_advisory_xact_lock/.test(sql)) return [];
    if (/SELECT \* FROM lesson_author_workspace_v2_tasks/.test(sql)) {
      return [{ ...task(), dispatch_started_at: new Date(), accounting_state: 'reserved' }];
    }
    if (/INSERT INTO lesson_author_workspace_v2_artifacts/.test(sql)) return [{ id: uuid(11) }];
    if (/SET status='succeeded'/.test(sql)) return [{ id: lease.task_id }];
  });
  const events: string[] = [];
  await success.repo.succeed(lease, resultHash, 'course-skeleton-v2', { inputTokens: 10, outputTokens: 4 }, {
    artifact_kind: 'course_skeleton', artifact_hash: resultHash, payload: { contract_version: 2 },
    validation_contract: 'course-skeleton-v2',
  }, async (_tx, _lease, usage) => { events.push('settled'); assert.equal(usage.outputTokens, 4); }, {
    beforeSuccess: async () => {
      events.push('before-success');
      assert.equal(success.queries.length, 3, 'workspace fence and artifact must exist before the pre-success hook');
    },
    afterSuccess: async () => {
      events.push('after-success');
      assert.equal(success.queries.length, 4, 'task must be succeeded before the post-success hook');
    },
  });
  assert.deepEqual(events, ['settled', 'before-success', 'after-success']);
  assert.match(success.queries[0]!.sql, /pg_advisory_xact_lock/);
  assert.deepEqual(success.queries[0]!.params, [lease.workspace_id]);
  assert.match(success.queries[0]!.sql, /\$1::text/);
  assert.ok(success.queries.some(query => /INSERT INTO lesson_author_workspace_v2_artifacts/.test(query.sql)));
  assert.ok(success.queries.some(query => /accounting_state=CASE WHEN \$7::boolean AND \$8::text<>'deterministic_fallback'/.test(query.sql)));
});

test('deterministic fallback releases undispatched quota and cannot settle a paid call', async () => {
  const lease = {
    task_id: uuid(3), run_id: uuid(2), workspace_id: uuid(4), tenant_id: uuid(5), course_id: 'course',
    task_key: 'content:chapter-1:unit:1', kind: 'generate_unit' as const, chapter_key: 'chapter-1', node_id: uuid(6),
    contract_hash: hash('contract'), input_context_hash: hash('input'), source_snapshot_id: uuid(7),
    source_snapshot_hash: hash('source'), runtime_config_hash: hash('runtime'), model: 'gemini-test', locale: 'vi' as const,
    max_output_tokens: 65_536, provider_max_attempts: 2, execution_budget_ms: 60_000,
    lease_token: uuid(9), dispatch_epoch: 2, ai_reservation_id: uuid(10), routing_shard: 19,
  };
  const fallback = routedFixture(sql => {
    if (/pg_advisory_xact_lock/.test(sql)) return [];
    if (/SELECT \* FROM lesson_author_workspace_v2_tasks/.test(sql)) {
      return [{ ...task(), id: lease.task_id, run_id: lease.run_id, workspace_id: lease.workspace_id,
        tenant_id: lease.tenant_id, kind: lease.kind, dispatch_started_at: null,
        accounting_state: 'reserved', ai_reservation_id: lease.ai_reservation_id }];
    }
    if (/SET status='succeeded'/.test(sql)) return [{ id: lease.task_id }];
  });
  const events: string[] = [];
  await fallback.repo.succeed(lease, hash('fallback'), 'unit-baseline-v2', {}, null,
    async () => assert.fail('must not settle provider usage'), {}, {
      mode: 'deterministic_fallback',
      releaseUndispatched: async () => { events.push('released'); },
    });
  assert.deepEqual(events, ['released']);
  const completed = fallback.queries.find(query => /SET status='succeeded'/.test(query.sql));
  assert.equal(completed?.params[7], 'deterministic_fallback');
  assert.match(completed?.sql ?? '', /ai_reservation_id=CASE WHEN \$8::text='deterministic_fallback' THEN NULL/);
});

test('definitive provider rejection releases accounting and stops the run immediately', async () => {
  const lease = {
    task_id: uuid(3), run_id: uuid(2), workspace_id: uuid(4), tenant_id: uuid(5), course_id: 'course',
    task_key: 'architecture:course', kind: 'course_skeleton' as const, chapter_key: null, node_id: null,
    contract_hash: hash('contract'), input_context_hash: hash('input'), source_snapshot_id: uuid(6),
    source_snapshot_hash: hash('source'), runtime_config_hash: hash('runtime'), model: 'gemini-test', locale: 'vi' as const,
    max_output_tokens: 65_536, provider_max_attempts: 1, execution_budget_ms: 60_000,
    lease_token: uuid(9), dispatch_epoch: 1, ai_reservation_id: uuid(10), routing_shard: 19,
  };
  const locked = task({ id: lease.task_id, run_id: lease.run_id, workspace_id: lease.workspace_id,
    tenant_id: lease.tenant_id, course_id: lease.course_id, kind: lease.kind,
    dispatch_started_at: new Date(), accounting_state: 'reserved', ai_reservation_id: lease.ai_reservation_id });
  const f = routedFixture(sql => {
    if (/pg_advisory_xact_lock/.test(sql)) return [];
    if (/SELECT \* FROM lesson_author_workspace_v2_tasks/.test(sql)) return [locked];
    if (/SET status='failed'/.test(sql)) return [{ id: lease.task_id }];
    if (/SELECT status,failure_code FROM lesson_author_workspace_v2_runs/.test(sql)) return [{ status: 'planning' }];
    if (/UPDATE lesson_author_workspace_v2_runs/.test(sql)) return [{ id: lease.run_id }];
    if (/SET status='canceled'/.test(sql)) return [];
    if (/status='running'/.test(sql) && /count\(\*\)/.test(sql)) return [{ count: 0 }];
    if (/UPDATE lesson_author_workspaces SET status='needs_action'/.test(sql)) return [{ id: lease.workspace_id }];
    if (/INSERT INTO lesson_author_workspace_events/.test(sql)) return [{ sequence: 3 }];
  });
  const released: string[] = [];
  await f.repo.failProviderRejected(lease, 'AI_PROVIDER_REQUEST_REJECTED', async (_tx, row) => {
    released.push(String(row.ai_reservation_id));
  });
  assert.deepEqual(released, [uuid(10)]);
  const failedQuery = f.queries.find(query => /SET status='failed'/.test(query.sql))!;
  assert.equal(failedQuery.params[3], 'AI_PROVIDER_REQUEST_REJECTED');
  assert.ok(f.queries.some(query => /UPDATE lesson_author_workspace_v2_runs/.test(query.sql)));
  assert.ok(f.queries.some(query => /run_needs_action/.test(query.sql)));
  assert.match(f.queries[0]!.sql, /pg_advisory_xact_lock/);
});

test('claimed pre-dispatch failure releases reservation and retries immediately without waiting for lease expiry', async () => {
  const lease = {
    task_id: uuid(3), run_id: uuid(2), workspace_id: uuid(4), tenant_id: uuid(5), course_id: 'course',
    task_key: 'architecture:chapter:chapter-2', kind: 'chapter_blueprint' as const, chapter_key: 'chapter-2', node_id: uuid(12),
    contract_hash: hash('contract'), input_context_hash: hash('input'), source_snapshot_id: uuid(6), source_snapshot_hash: hash('source'),
    runtime_config_hash: hash('runtime'), model: 'gemini-test', locale: 'vi' as const, max_output_tokens: 65_536,
    provider_max_attempts: 2, execution_budget_ms: 60_000, lease_token: uuid(9), dispatch_epoch: 1,
    ai_reservation_id: uuid(10), routing_shard: 19,
  };
  const locked = task({ id: lease.task_id, run_id: lease.run_id, workspace_id: lease.workspace_id,
    tenant_id: lease.tenant_id, course_id: lease.course_id, task_key: lease.task_key, kind: lease.kind,
    chapter_key: lease.chapter_key, node_id: lease.node_id, status: 'running', lease_token: lease.lease_token,
    attempt_count: 1, max_attempts: 2, dispatch_epoch: 1, ai_reservation_id: lease.ai_reservation_id,
    accounting_state: 'reserved' });
  const f = routedFixture(sql => {
    if (/pg_advisory_xact_lock/.test(sql)) return [];
    if (/SELECT status FROM lesson_author_workspace_v2_runs/.test(sql)) return [{ status: 'planning' }];
    if (/SELECT t\.\*,coalesce/.test(sql)) return [locked];
    if (/SET status='queued'/.test(sql)) return [{ id: lease.task_id }];
    if (/INSERT INTO lesson_author_workspace_v2_dispatch_outbox/.test(sql)) return [{ id: uuid(9) }];
  });
  const released: string[] = [];
  const disposition = await f.repo.recoverClaimFailure(lease, 'ORCHESTRATION_V2_EXECUTION_RUNTIME_CHANGED',
    async (_tx, row) => { released.push(String(row.ai_reservation_id)); },
    async () => assert.fail('an undispatched call must not be held'));
  assert.equal(disposition, 'requeued');
  assert.deepEqual(released, [uuid(10)]);
  assert.ok(f.queries.some(query => /status='queued'/.test(query.sql) && /failure_code=NULL/.test(query.sql)));
  assert.ok(f.queries.some(query => /INSERT INTO lesson_author_workspace_v2_dispatch_outbox/.test(query.sql)));
  assert.match(f.queries[0]!.sql, /pg_advisory_xact_lock/);
});

test('claimed exhausted pre-dispatch failure preserves the real code and stops the run immediately', async () => {
  const lease = {
    task_id: uuid(3), run_id: uuid(2), workspace_id: uuid(4), tenant_id: uuid(5), course_id: 'course',
    task_key: 'architecture:chapter:chapter-2', kind: 'chapter_blueprint' as const, chapter_key: 'chapter-2', node_id: uuid(12),
    contract_hash: hash('contract'), input_context_hash: hash('input'), source_snapshot_id: uuid(6), source_snapshot_hash: hash('source'),
    runtime_config_hash: hash('runtime'), model: 'gemini-test', locale: 'vi' as const, max_output_tokens: 65_536,
    provider_max_attempts: 2, execution_budget_ms: 60_000, lease_token: uuid(9), dispatch_epoch: 2,
    ai_reservation_id: uuid(10), routing_shard: 19,
  };
  const locked = task({ id: lease.task_id, run_id: lease.run_id, workspace_id: lease.workspace_id,
    tenant_id: lease.tenant_id, course_id: lease.course_id, task_key: lease.task_key, kind: lease.kind,
    chapter_key: lease.chapter_key, node_id: lease.node_id, status: 'running', lease_token: lease.lease_token,
    attempt_count: 2, max_attempts: 2, dispatch_epoch: 2, ai_reservation_id: lease.ai_reservation_id,
    accounting_state: 'reserved' });
  const f = routedFixture(sql => {
    if (/pg_advisory_xact_lock/.test(sql)) return [];
    if (/SELECT status FROM lesson_author_workspace_v2_runs/.test(sql)) return [{ status: 'planning' }];
    if (/SELECT t\.\*,coalesce/.test(sql)) return [locked];
    if (/SET status='failed'/.test(sql)) return [{ id: lease.task_id }];
    if (/SELECT status,failure_code FROM lesson_author_workspace_v2_runs/.test(sql)) return [{ status: 'planning' }];
    if (/UPDATE lesson_author_workspace_v2_runs/.test(sql)) return [{ id: lease.run_id }];
    if (/SET status='canceled'/.test(sql)) return [];
    if (/status='running'/.test(sql) && /count\(\*\)/.test(sql)) return [{ count: 0 }];
    if (/UPDATE lesson_author_workspaces SET status='needs_action'/.test(sql)) return [{ id: lease.workspace_id }];
    if (/INSERT INTO lesson_author_workspace_events/.test(sql)) return [{ sequence: 3 }];
  });
  const disposition = await f.repo.recoverClaimFailure(lease, 'ORCHESTRATION_V2_EXECUTION_RUNTIME_CHANGED',
    async () => undefined, async () => assert.fail('an undispatched call must not be held'));
  assert.equal(disposition, 'failed');
  const failedQuery = f.queries.find(query => /SET status='failed'/.test(query.sql))!;
  assert.equal(failedQuery.params[3], 'ORCHESTRATION_V2_EXECUTION_RUNTIME_CHANGED');
  const runQuery = f.queries.find(query => /UPDATE lesson_author_workspace_v2_runs/.test(query.sql))!;
  assert.equal(runQuery.params[1], 'ORCHESTRATION_V2_EXECUTION_RUNTIME_CHANGED');
  assert.ok(f.queries.some(query => /run_needs_action/.test(query.sql)));
});

test('claimed post-dispatch failure reconciles and creates its only retry in the same fenced transaction', async () => {
  const lease = {
    task_id: uuid(3), run_id: uuid(2), workspace_id: uuid(4), tenant_id: uuid(5), course_id: 'course',
    task_key: 'unit:chapter-1:unit-1', kind: 'generate_unit' as const, chapter_key: 'chapter-1', node_id: uuid(12),
    contract_hash: hash('contract'), input_context_hash: hash('input'), source_snapshot_id: uuid(6), source_snapshot_hash: hash('source'),
    runtime_config_hash: hash('runtime'), model: 'gemini-test', locale: 'vi' as const, max_output_tokens: 65_536,
    provider_max_attempts: 2, execution_budget_ms: 60_000, lease_token: uuid(9), dispatch_epoch: 1,
    ai_reservation_id: uuid(10), routing_shard: 19,
  };
  const locked = task({ id: lease.task_id, run_id: lease.run_id, workspace_id: lease.workspace_id,
    tenant_id: lease.tenant_id, course_id: lease.course_id, task_key: lease.task_key, kind: lease.kind,
    chapter_key: lease.chapter_key, node_id: lease.node_id, status: 'running', lease_token: lease.lease_token,
    attempt_count: 1, max_attempts: 2, dispatch_epoch: 1, dispatch_started_at: new Date(),
    ai_reservation_id: lease.ai_reservation_id, accounting_state: 'reserved' });
  const f = routedFixture(sql => {
    if (/pg_advisory_xact_lock/.test(sql)) return [];
    if (/SELECT status FROM lesson_author_workspace_v2_runs/.test(sql)) return [{ status: 'executing' }];
    if (/SELECT t\.\*,coalesce/.test(sql)) return [locked];
    if (/SET status='outcome_unknown'/.test(sql)) return [{ id: uuid(3) }];
    if (/SET status='queued'/.test(sql)) return [{ id: uuid(3) }];
    if (/INSERT INTO lesson_author_workspace_v2_dispatch_outbox/.test(sql)) return [{ id: uuid(9) }];
  });
  const accounting: string[] = [];
  const disposition = await f.repo.recoverClaimFailure(lease, 'AI_RAG_SERVICE_ERROR',
    async () => assert.fail('dispatched work must not release'),
    async () => { accounting.push('held'); },
    async (_tx, row) => { accounting.push('reconciled'); assert.equal(row.status, 'outcome_unknown'); });
  assert.equal(disposition, 'requeued');
  assert.deepEqual(accounting, ['held', 'reconciled']);
  assert.equal(f.events.filter(event => event === 'BEGIN').length, 1);
  assert.equal(f.events.filter(event => event === 'COMMIT').length, 1);
  assert.ok(f.queries.some(query => /INSERT INTO lesson_author_workspace_v2_dispatch_outbox/.test(query.sql)));
});

function recoveryFixture(expiredTask: Record<string, unknown>, extra?: {
  runStatus?: string;
  onSql?: (sql: string) => Record<string, unknown>[] | undefined;
}) {
  return routedFixture(sql => {
    const custom = extra?.onSql?.(sql);
    if (custom !== undefined) return custom;
    if (/SELECT r\.id::text AS run_id,r\.workspace_id::text/.test(sql)
      && /t\.status IN \('failed','timed_out','outcome_unknown'\)/.test(sql)) return [];
    if (/SELECT r\.id::text AS run_id,r\.workspace_id::text/.test(sql)
      && /r\.status='needs_action'/.test(sql)) return [];
    if (/SELECT t\.id::text AS task_id/.test(sql)) return [{ task_id: uuid(3), run_id: uuid(2),
      workspace_id: uuid(4), tenant_id: uuid(5) }];
    if (/pg_advisory_xact_lock/.test(sql)) return [];
    if (/SELECT t\.\*,r\.status AS run_status/.test(sql)) {
      return [{ ...expiredTask, run_status: extra?.runStatus ?? 'planning' }];
    }
    if (/SET status='outcome_unknown'/.test(sql)) return [{ id: uuid(3) }];
    if (/SET status='queued'/.test(sql)) return [{ id: uuid(3) }];
    if (/INSERT INTO lesson_author_workspace_v2_dispatch_outbox/.test(sql)) return [{ id: uuid(9) }];
  });
}

test('recovery fences workspace before task and requeues only active pre-dispatch work', async () => {
  const f = recoveryFixture(task({ status: 'running', lease_token: uuid(9), attempt_count: 1, dispatch_epoch: 1 }));
  assert.equal(await f.repo.recoverOne(async () => undefined,
    async () => assert.fail('pre-dispatch work must not hold usage')), 'requeued');
  const fence = f.queries.findIndex(query => /pg_advisory_xact_lock/.test(query.sql));
  const taskLock = f.queries.findIndex(query => /SELECT t\.\*,r\.status AS run_status/.test(query.sql));
  assert.ok(fence >= 0 && fence < taskLock);
  assert.ok(f.queries.some(query => /SET status='queued'/.test(query.sql)));
  assert.ok(f.queries.some(query => /INSERT INTO lesson_author_workspace_v2_dispatch_outbox/.test(query.sql)));
});

test('dispatched failure is held, pessimistically reconciled and requeued atomically while run is active', async () => {
  const provider = task({ status: 'running', kind: 'generate_unit', lease_token: uuid(9),
    dispatch_started_at: new Date(), accounting_state: 'reserved', ai_reservation_id: uuid(10),
    attempt_count: 1, max_attempts: 2, dispatch_epoch: 1 });
  const f = recoveryFixture(provider);
  const events: string[] = [];
  assert.equal(await f.repo.recoverOne(
    async () => assert.fail('a dispatched reservation must not release'),
    async () => { events.push('held'); },
    async (_tx, row) => { events.push('reconciled'); assert.equal(row.status, 'outcome_unknown'); },
  ), 'requeued');
  assert.deepEqual(events, ['held', 'reconciled']);
  assert.ok(f.queries.some(query => /accounting_state='pending_reconciliation'/.test(query.sql)));
  assert.ok(f.queries.some(query => /status='queued'/.test(query.sql)));
  assert.doesNotMatch(f.queries.map(query => query.sql).join('\n'), /UPDATE lesson_author_workspace_v2_runs/);
});

test('dispatched exhausted failure becomes needs-action without another provider dispatch', async () => {
  const provider = task({ status: 'running', kind: 'course_skeleton', lease_token: uuid(9),
    dispatch_started_at: new Date(), accounting_state: 'reserved', ai_reservation_id: uuid(10),
    attempt_count: 2, max_attempts: 2, dispatch_epoch: 2 });
  const f = recoveryFixture(provider, { onSql: sql => {
    if (/accounting_state='pending_reconciliation'/.test(sql)) return [{ id: uuid(3) }];
    if (/SELECT status,failure_code FROM lesson_author_workspace_v2_runs/.test(sql)) return [{ status: 'planning' }];
    if (/UPDATE lesson_author_workspace_v2_runs/.test(sql)) return [{ id: uuid(2) }];
    if (/SET status='canceled'/.test(sql)) return [];
    if (/count\(\*\)/.test(sql) && /status='running'/.test(sql)) return [{ count: 0 }];
    if (/UPDATE lesson_author_workspaces SET status='needs_action'/.test(sql)) return [{ id: uuid(4) }];
    if (/INSERT INTO lesson_author_workspace_events/.test(sql)) return [{ sequence: 3 }];
  } });
  assert.equal(await f.repo.recoverOne(async () => assert.fail('must not release'), async () => undefined),
    'outcome_unknown');
  assert.ok(f.queries.some(query => /UPDATE lesson_author_workspace_v2_runs/.test(query.sql)));
  assert.doesNotMatch(f.queries.map(query => query.sql).join('\n'), /INSERT INTO lesson_author_workspace_v2_dispatch_outbox/);
});

test('legacy active outcome-unknown task is requeued only after the run is locked active', async () => {
  const terminalTask = task({ status: 'outcome_unknown', kind: 'generate_unit', accounting_state: 'pending_reconciliation',
    attempt_count: 1, max_attempts: 2, dispatch_epoch: 1, failure_code: 'PROVIDER_OUTCOME_UNKNOWN',
    run_status: 'planning' });
  const f = routedFixture(sql => {
    if (/SELECT r\.id::text AS run_id,r\.workspace_id::text/.test(sql)) {
      return [{ run_id: uuid(2), workspace_id: uuid(4), tenant_id: uuid(5), task_id: uuid(3) }];
    }
    if (/pg_advisory_xact_lock/.test(sql)) return [];
    if (/SELECT t\.\*,r\.status AS run_status/.test(sql)) return [terminalTask];
    if (/SET status='queued'/.test(sql)) return [{ id: uuid(3) }];
    if (/SELECT routing_shard/.test(sql)) return [{ routing_shard: 19 }];
    if (/INSERT INTO lesson_author_workspace_v2_dispatch_outbox/.test(sql)) return [{ id: uuid(9) }];
  });
  assert.equal(await f.repo.recoverOne(async () => assert.fail('no release'), async () => assert.fail('no hold'),
    async () => undefined), 'requeued');
  assert.match(f.queries[2]!.sql, /r\.status IN \('planning','executing','finalizing'\)/);
  assert.ok(f.queries.some(query => /INSERT INTO lesson_author_workspace_v2_dispatch_outbox/.test(query.sql)));
});

test('one rejected unit cancels only descendants while sibling shards continue', async () => {
  const lease = {
    task_id: uuid(3), run_id: uuid(2), workspace_id: uuid(4), tenant_id: uuid(5), course_id: 'course',
    task_key: 'unit:chapter-1:unit-1', kind: 'generate_unit' as const, chapter_key: 'chapter-1', node_id: uuid(12),
    contract_hash: hash('contract'), input_context_hash: hash('input'), source_snapshot_id: uuid(6),
    source_snapshot_hash: hash('source'), runtime_config_hash: hash('runtime'), model: 'gemini-test', locale: 'vi' as const,
    max_output_tokens: 65_536, provider_max_attempts: 2, execution_budget_ms: 60_000,
    lease_token: uuid(9), dispatch_epoch: 1, ai_reservation_id: uuid(10), routing_shard: 19,
  };
  const locked = task({ id: lease.task_id, kind: lease.kind, task_key: lease.task_key, chapter_key: lease.chapter_key,
    node_id: lease.node_id, status: 'running', lease_token: lease.lease_token, dispatch_started_at: new Date(),
    accounting_state: 'reserved', ai_reservation_id: lease.ai_reservation_id });
  const f = routedFixture(sql => {
    if (/pg_advisory_xact_lock/.test(sql)) return [];
    if (/SELECT \* FROM lesson_author_workspace_v2_tasks/.test(sql)) return [locked];
    if (/SET status='failed'/.test(sql)) return [{ id: uuid(3) }];
    if (/SELECT status,failure_code FROM lesson_author_workspace_v2_runs/.test(sql)) return [{ status: 'planning' }];
    if (/WITH RECURSIVE descendants/.test(sql)) return [];
    if (/status IN \('blocked','queued','running'\)/.test(sql)) return [{ count: 2 }];
  });
  await f.repo.failProviderRejected(lease, 'AI_PROVIDER_REQUEST_REJECTED', async () => undefined);
  assert.ok(f.queries.some(query => /WITH RECURSIVE descendants/.test(query.sql)));
  assert.doesNotMatch(f.queries.map(query => query.sql).join('\n'), /UPDATE lesson_author_workspace_v2_runs/);
});

test('needs-action recovery cancels stranded queued work and publishes workspace terminal state', async () => {
  const f = routedFixture(sql => {
    if (/t\.status IN \('failed','timed_out','outcome_unknown'\)/.test(sql)) return [];
    if (/SELECT r\.id::text AS run_id,r\.workspace_id::text/.test(sql) && /r\.status='needs_action'/.test(sql)) {
      return [{ run_id: uuid(2), workspace_id: uuid(4), tenant_id: uuid(5), course_id: 'course' }];
    }
    if (/pg_advisory_xact_lock/.test(sql)) return [];
    if (/SELECT r\.id::text AS run_id,r\.id::text AS id/.test(sql)) return [{ run_id: uuid(2), id: uuid(2),
      workspace_id: uuid(4), tenant_id: uuid(5), course_id: 'course', failure_code: 'PROVIDER_OUTCOME_UNKNOWN',
      kind: 'source_snapshot' }];
    if (/SET status='canceled'/.test(sql)) return [];
    if (/count\(\*\)/.test(sql) && /status='running'/.test(sql)) return [{ count: 0 }];
    if (/UPDATE lesson_author_workspaces SET status='needs_action'/.test(sql)) return [{ id: uuid(4) }];
    if (/INSERT INTO lesson_author_workspace_events/.test(sql)) return [{ sequence: 4 }];
  });
  assert.equal(await f.repo.recoverOne(async () => assert.fail('no release'), async () => assert.fail('no hold')),
    'reconciled');
  assert.ok(f.queries.some(query => /RUN_STOPPED_AFTER_TASK_FAILURE/.test(query.sql)));
  assert.ok(f.queries.some(query => /run_needs_action/.test(query.sql)));
  assert.doesNotMatch(f.queries.map(query => query.sql).join('\n'), /INSERT INTO lesson_author_workspace_v2_dispatch_outbox/);
});

test('terminal run never requeues an expired task or creates a new outbox', async () => {
  const expired = task({ status: 'running', lease_token: uuid(9), attempt_count: 1, dispatch_epoch: 1 });
  const f = recoveryFixture(expired, { runStatus: 'needs_action', onSql: sql => {
    if (/failure_code=CASE/.test(sql)) return [{ id: uuid(3) }];
    if (/SELECT status,failure_code FROM lesson_author_workspace_v2_runs/.test(sql)) return [{ status: 'needs_action' }];
    if (/UPDATE lesson_author_workspace_v2_runs/.test(sql)) return [];
    if (/SET status='canceled'/.test(sql)) return [];
    if (/count\(\*\)/.test(sql) && /status='running'/.test(sql)) return [{ count: 0 }];
    if (/UPDATE lesson_author_workspaces SET status='needs_action'/.test(sql)) return [{ id: uuid(4) }];
    if (/INSERT INTO lesson_author_workspace_events/.test(sql)) return [{ sequence: 5 }];
  } });
  assert.equal(await f.repo.recoverOne(async () => undefined, async () => assert.fail('no hold')), 'failed');
  assert.doesNotMatch(f.queries.map(query => query.sql).join('\n'), /INSERT INTO lesson_author_workspace_v2_dispatch_outbox/);
  assert.ok(f.queries.some(query => /RUN_ALREADY_TERMINAL/.test(query.sql)));
});

test('exhausted active pre-dispatch task stops run and workspace in the same transaction', async () => {
  const exhausted = task({ status: 'running', lease_token: uuid(9), attempt_count: 2, max_attempts: 2,
    dispatch_epoch: 2 });
  const f = recoveryFixture(exhausted, { onSql: sql => {
    if (/failure_code=CASE/.test(sql)) return [{ id: uuid(3) }];
    if (/SELECT status,failure_code FROM lesson_author_workspace_v2_runs/.test(sql)) return [{ status: 'planning' }];
    if (/UPDATE lesson_author_workspace_v2_runs/.test(sql)) return [{ id: uuid(2) }];
    if (/SET status='canceled'/.test(sql)) return [];
    if (/count\(\*\)/.test(sql) && /status='running'/.test(sql)) return [{ count: 0 }];
    if (/UPDATE lesson_author_workspaces SET status='needs_action'/.test(sql)) return [{ id: uuid(4) }];
    if (/INSERT INTO lesson_author_workspace_events/.test(sql)) return [{ sequence: 3 }];
  } });
  assert.equal(await f.repo.recoverOne(async () => undefined,
    async () => assert.fail('pre-dispatch exhaustion must not hold usage')), 'failed');
  assert.ok(f.queries.some(query => /TASK_ATTEMPTS_EXHAUSTED/.test(query.sql)));
  assert.ok(f.queries.some(query => /run_needs_action/.test(query.sql)));
});
