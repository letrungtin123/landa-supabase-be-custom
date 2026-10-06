import assert from 'node:assert/strict';
import test from 'node:test';
import type { GenerationJobDatabase, GenerationJobSql } from './lesson-author-generation-job.repository.js';
import {
  assertOrchestrationV2RuntimeIsolation,
  orchestrationV2DispatchEnvelope,
  orchestrationV2RetryDelayMs,
} from './lesson-author-orchestration-v2-dispatch.logic.js';
import {
  assertOrchestrationV2OutboxConfig,
  createOrchestrationV2OutboxRepository,
  type OrchestrationV2OutboxLease,
} from './lesson-author-orchestration-v2-outbox.repository.js';
import {
  dispatchOneOrchestrationV2Outbox,
  runOrchestrationV2DispatcherCycle,
} from './lesson-author-orchestration-v2-dispatch.service.js';

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const config = { lane_count: 16, lane_index: 3, lease_seconds: 30, max_attempts: 5,
  retry_base_ms: 1_000, retry_max_ms: 60_000, published_recovery_seconds: 120 };
const claim: OrchestrationV2OutboxLease = { outbox_id: uuid(1), run_id: uuid(2), task_id: uuid(3),
  dispatch_epoch: 0, routing_shard: 19, lease_token: uuid(4), attempt_count: 1 };

function fixture(responses: Array<Record<string, unknown>[]>) {
  const events: string[] = [], queries: Array<{ sql: string; params: unknown[] }> = [];
  const tx: GenerationJobSql = { async query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
    queries.push({ sql, params }); const rows = responses.shift(); assert.notEqual(rows, undefined, `unexpected SQL: ${sql}`);
    return { rows: rows as T[], rowCount: rows!.length };
  } };
  const db: GenerationJobDatabase = { async transaction<T>(work: (value: GenerationJobSql) => Promise<T>) {
    events.push('BEGIN'); try { const value = await work(tx); events.push('COMMIT'); return value; }
    catch (error) { events.push('ROLLBACK'); throw error; }
  } };
  return { repo: createOrchestrationV2OutboxRepository(db, () => uuid(4)), events, queries,
    done: () => assert.equal(responses.length, 0) };
}

test('runtime role is exclusive and disabled stays the API-safe default', () => {
  assert.deepEqual(assertOrchestrationV2RuntimeIsolation({ enabled: false, role: 'disabled', lane_count: 1, lane_index: 0 }),
    { enabled: false, role: 'disabled', lane_count: 1, lane_index: 0 });
  assert.deepEqual(assertOrchestrationV2RuntimeIsolation({ enabled: true, role: 'dispatcher', lane_count: 16, lane_index: 3 }).role,
    'dispatcher');
  assert.throws(() => assertOrchestrationV2RuntimeIsolation({ enabled: false, role: 'worker', lane_count: 1, lane_index: 0 }),
    { code: 'ORCHESTRATION_V2_RUNTIME_ROLE_INVALID' });
  assert.throws(() => assertOrchestrationV2RuntimeIsolation({ enabled: true, role: 'dispatcher', lane_count: 2, lane_index: 2 }),
    { code: 'ORCHESTRATION_V2_RUNTIME_ROLE_INVALID' });
});

test('broker envelope contains identity only and retry delay is bounded', () => {
  const envelope = orchestrationV2DispatchEnvelope(claim);
  assert.deepEqual(Object.keys(envelope).sort(), ['contract_version', 'dispatch_epoch', 'outbox_id', 'routing_shard', 'run_id', 'task_id']);
  for (const privateField of ['tenant_id', 'course_id', 'prompt', 'source', 'api_key', 'payload']) {
    assert.ok(!(privateField in envelope));
  }
  assert.equal(orchestrationV2RetryDelayMs(1, 1_000, 60_000), 1_000);
  assert.equal(orchestrationV2RetryDelayMs(20, 1_000, 60_000), 60_000);
});

test('outbox config rejects unsafe cross-field bounds before database access', () => {
  assert.deepEqual(assertOrchestrationV2OutboxConfig(config), config);
  assert.throws(() => assertOrchestrationV2OutboxConfig({ ...config, lane_index: 16 }),
    { code: 'ORCHESTRATION_V2_OUTBOX_CONFIG_INVALID' });
  assert.throws(() => assertOrchestrationV2OutboxConfig({ ...config, retry_max_ms: 999 }),
    { code: 'ORCHESTRATION_V2_OUTBOX_CONFIG_INVALID' });
  assert.throws(() => assertOrchestrationV2OutboxConfig({ ...config, published_recovery_seconds: 29 }),
    { code: 'ORCHESTRATION_V2_OUTBOX_CONFIG_INVALID' });
});

test('claim uses tenant round-robin ranking, lane partition and skip-locked lease', async () => {
  const f = fixture([[{ ...claim }]]);
  assert.deepEqual(await f.repo.claimNext(config), claim); f.done();
  const query = f.queries[0]!;
  assert.match(query.sql, /row_number\(\) OVER\(PARTITION BY tenant_id/);
  assert.match(query.sql, /mod\(pending\.routing_shard,\$1::integer\)=\$2::integer/);
  assert.match(query.sql, /FOR UPDATE OF o SKIP LOCKED LIMIT 1/);
  assert.match(query.sql, /status='publishing'/);
  assert.match(query.sql, /pending\.attempt_count>=\$3::integer AND pending\.failure_code IS NULL/);
  assert.match(query.sql, /task\.status='queued'/);
  assert.match(query.sql, /task\.dispatch_epoch=pending\.dispatch_epoch/);
  assert.match(query.sql, /run\.status IN \('planning','executing'\)/);
  assert.match(query.sql, /CASE WHEN o\.attempt_count>=\$3::integer THEN 1 ELSE o\.attempt_count\+1 END/);
  assert.deepEqual(query.params.slice(0, 3), [16, 3, 5]);
  assert.deepEqual(f.events, ['BEGIN', 'COMMIT']);
});

test('publisher confirm happens before the published database CAS', async () => {
  const events: string[] = [];
  const repo = {
    claimNext: async () => { events.push('claim'); return claim; },
    markPublished: async () => { events.push('published-cas'); },
    releaseAfterPublishFailure: async () => { events.push('release'); return 'pending' as const; },
    recoverOne: async () => null,
  } as ReturnType<typeof createOrchestrationV2OutboxRepository>;
  const result = await dispatchOneOrchestrationV2Outbox(repo, config, 'queue', async (_queue, payload) => {
    events.push('broker-confirm'); assert.equal(payload.outbox_id, claim.outbox_id);
  });
  assert.equal(result, 'published');
  assert.deepEqual(events, ['claim', 'broker-confirm', 'published-cas']);
});

test('broker failure schedules durable retry and never marks published', async () => {
  const events: string[] = [];
  const repo = {
    claimNext: async () => { events.push('claim'); return claim; },
    markPublished: async () => { assert.fail('must not mark published'); },
    releaseAfterPublishFailure: async () => { events.push('release'); return 'pending' as const; },
    recoverOne: async () => null,
  } as ReturnType<typeof createOrchestrationV2OutboxRepository>;
  const result = await dispatchOneOrchestrationV2Outbox(repo, config, 'queue', async () => {
    events.push('publish-failed'); throw new Error('broker unavailable');
  });
  assert.equal(result, 'retry_scheduled'); assert.deepEqual(events, ['claim', 'publish-failed', 'release']);
});

test('published CAS and expired publishing recovery are lease/state fenced', async () => {
  const published = fixture([[{ locked: '' }], [{ id: claim.outbox_id }]]);
  await published.repo.markPublished(claim);
  assert.match(published.queries[0]!.sql, /pg_advisory_xact_lock/);
  assert.match(published.queries[0]!.sql, /20260907/);
  assert.match(published.queries[1]!.sql, /status='publishing'/);
  assert.match(published.queries[1]!.sql, /lease_token=\$5::uuid AND lease_expires_at>clock_timestamp\(\)/);
  const recovered = fixture([[{ status: 'pending' }]]);
  assert.equal(await recovered.repo.recoverOne(config), 'pending');
  assert.match(recovered.queries[0]!.sql, /status='publishing' AND lease_expires_at<=clock_timestamp\(\)/);
  assert.doesNotMatch(recovered.queries[0]!.sql, /status='published'/);
  assert.doesNotMatch(recovered.queries[0]!.sql, /published_at/);
  assert.match(recovered.queries[0]!.sql, /FOR UPDATE SKIP LOCKED LIMIT 1/);
  assert.deepEqual(recovered.queries[0]!.params, [16, 3, 5]);
});

test('dispatcher cycle is bounded, recovers first and stops on idle', async () => {
  const events: string[] = [];
  const recovery = ['pending', 'dead', null] as Array<'pending' | 'dead' | null>;
  const claims = [claim, null];
  const repo = {
    recoverOne: async () => { events.push('recover'); return recovery.shift() ?? null; },
    claimNext: async () => { events.push('claim'); return claims.shift() ?? null; },
    markPublished: async () => { events.push('published-cas'); },
    releaseAfterPublishFailure: async () => 'pending' as const,
  } as ReturnType<typeof createOrchestrationV2OutboxRepository>;
  const result = await runOrchestrationV2DispatcherCycle(repo, {
    queue: 'test', outbox: config, recovery_batch_size: 20, dispatch_batch_size: 20,
  }, async () => { events.push('broker-confirm'); });
  assert.deepEqual(result, { recovered: 1, recovery_dead: 1, published: 1, retry_scheduled: 0, publish_dead: 0 });
  assert.deepEqual(events, ['recover', 'recover', 'recover', 'claim', 'broker-confirm', 'published-cas', 'claim']);
});
