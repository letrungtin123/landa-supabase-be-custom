import assert from 'node:assert/strict';
import test from 'node:test';
import { RagServiceError } from './ai-rag-client.service.js';
import type { GenerationJobDatabase, GenerationJobSql } from './lesson-author-generation-job.repository.js';
import { assembleIdmOrchestrationArchitecture } from './lesson-author-idm-architecture.logic.js';
import { idmScopeViewOf, remapFactsToBlockScopes } from './lesson-author-idm-scope-view.logic.js';
import {
  IDM_FIXTURE_DOCUMENT_ID,
  IDM_FIXTURE_SNAPSHOT_HASH,
  idmFixture,
  idmShardFixtures,
} from './lesson-author-idm.fixture.js';
import { orchestrationV2DispatchEnvelope } from './lesson-author-orchestration-v2-dispatch.logic.js';
import {
  ORCHESTRATION_V2_EXECUTION_POLICY,
  ORCHESTRATION_V2_IDM_EXECUTION_POLICY,
} from './lesson-author-orchestration-v2-execution.config.js';
import { orchestrationV2Hash } from './lesson-author-orchestration-v2.logic.js';
import { executeOrchestrationV2PlanningTask } from './lesson-author-orchestration-v2-planning.service.js';
import { prepareOrchestrationV2UnitGenerationContract } from './lesson-author-orchestration-v2-unit.logic.js';
import { executeOrchestrationV2UnitTask } from './lesson-author-orchestration-v2-unit.service.js';
import {
  ORCHESTRATION_V2_RUN_STOPPING_FAILURES,
  OrchestrationV2ProviderStopError,
  idmProviderFailure,
  orchestrationV2RateLimitRequeueDelayMs,
  orchestrationV2StableJitterMs,
} from './lesson-author-orchestration-v2-worker.logic.js';
import {
  createOrchestrationV2WorkerRepository,
  type OrchestrationV2TaskLease,
} from './lesson-author-orchestration-v2-worker.repository.js';
import { handleOrchestrationV2Delivery } from './lesson-author-orchestration-v2-worker.service.js';

// QC course 234653 (2026-10-08): an exhausted Gemini key and a per-minute rate limit both became
// silent deterministic content and the run still ended `ready`. IDM runs now stop on an exhausted key
// and retry rate-limited planning tasks after the per-minute window; legacy V2 runs are unchanged.

type Worker = ReturnType<typeof createOrchestrationV2WorkerRepository>;
type Row = Record<string, any>;
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const SIX = ['html', 'problem', 'la_faq', 'la_sortable', 'la_crossword', 'la_diagram'] as const;
const quota = () => new RagServiceError('AI provider đã hết hạn mức.', 503, 'AI_PROVIDER_QUOTA_EXHAUSTED');
const rateLimited = () => new RagServiceError('AI provider đang giới hạn.', 503, 'AI_PROVIDER_RATE_LIMITED');

function lease(overrides: Partial<OrchestrationV2TaskLease> = {}): OrchestrationV2TaskLease {
  return { task_id: uuid(1), run_id: uuid(2), workspace_id: uuid(3), tenant_id: uuid(4), course_id: 'course-v1:idm+1',
    task_key: 'architecture:chapter:chapter-1:shard:1', kind: 'chapter_blueprint', chapter_key: 'chapter-1',
    node_id: null, contract_hash: orchestrationV2Hash('contract'), input_context_hash: orchestrationV2Hash('input'),
    source_snapshot_id: uuid(5), source_snapshot_hash: IDM_FIXTURE_SNAPSHOT_HASH,
    runtime_config_hash: orchestrationV2Hash('runtime'), model: 'gemini-3.8-flash', locale: 'vi',
    max_output_tokens: 65_536, provider_max_attempts: 2, execution_budget_ms: 600_000, lease_token: uuid(6),
    dispatch_epoch: 1, provider_replay_required: false, routing_shard: 7, ai_reservation_id: uuid(7), ...overrides };
}

function routed(route: (sql: string) => Row[] | undefined) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const tx: GenerationJobSql = {
    async query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
      queries.push({ sql, params });
      const rows = route(sql);
      assert.notEqual(rows, undefined, `unexpected SQL: ${sql}`);
      return { rows: rows as T[], rowCount: rows!.length };
    },
  };
  const db: GenerationJobDatabase = { transaction: work => work(tx) };
  return { repo: createOrchestrationV2WorkerRepository(db, () => uuid(9)), queries };
}

function lockedTask(item: OrchestrationV2TaskLease, overrides: Row = {}): Row {
  return { id: item.task_id, run_id: item.run_id, workspace_id: item.workspace_id, tenant_id: item.tenant_id,
    course_id: item.course_id, task_key: item.task_key, kind: item.kind, chapter_key: item.chapter_key,
    node_id: item.node_id, status: 'running', lease_token: item.lease_token, attempt_count: 1, max_attempts: 2,
    dispatch_epoch: 1, dispatch_started_at: new Date(), ai_reservation_id: item.ai_reservation_id,
    accounting_state: 'reserved', routing_shard: 7, ...overrides };
}

test('exhausted key is a run stop only for IDM provider calls; other errors pass through unchanged', () => {
  const stop = idmProviderFailure(quota());
  assert.ok(stop instanceof OrchestrationV2ProviderStopError);
  assert.equal((stop as OrchestrationV2ProviderStopError).code, 'AI_PROVIDER_QUOTA_EXHAUSTED');
  const limited = rateLimited();
  assert.equal(idmProviderFailure(limited), limited);
  const other = new Error('x');
  assert.equal(idmProviderFailure(other), other);
  assert.deepEqual([...ORCHESTRATION_V2_RUN_STOPPING_FAILURES].sort(),
    ['AI_PROVIDER_AUTH_REJECTED', 'AI_PROVIDER_QUOTA_EXHAUSTED']);
});

test('rate-limited planning tasks wait for the per-minute window; units and other codes do not', () => {
  const jitter = orchestrationV2StableJitterMs(uuid(1));
  assert.ok(jitter >= 0 && jitter < 5_000 && jitter === orchestrationV2StableJitterMs(uuid(1)));
  assert.equal(orchestrationV2RateLimitRequeueDelayMs('course_skeleton', 'AI_PROVIDER_RATE_LIMITED', 1, 1_234), 61_234);
  assert.equal(orchestrationV2RateLimitRequeueDelayMs('chapter_blueprint', 'AI_PROVIDER_RATE_LIMITED', 2, 4_999), 120_000);
  assert.equal(orchestrationV2RateLimitRequeueDelayMs('generate_unit', 'AI_PROVIDER_RATE_LIMITED', 1, 0), 0);
  assert.equal(orchestrationV2RateLimitRequeueDelayMs('course_skeleton', 'AI_RAG_SERVICE_ERROR', 1, 0), 0);
});

test('IDM planning and unit calls stop on an exhausted key; legacy calls keep the original error', async () => {
  const fixture = idmFixture();
  const [shardFixture] = idmShardFixtures(fixture);
  const authority = { tenant_id: uuid(4), kb_id: uuid(8), conversation_id: uuid(9), correlation_id: uuid(10),
    locale: 'vi' as const, source_documents: [{ document_id: IDM_FIXTURE_DOCUMENT_ID, kb_id: uuid(8),
      name: 'nguon.pdf', type: 'file', status: 'learned' }] };
  const lessons = { task_key: 'architecture:chapter:chapter-1:shard:1', chapter_key: 'chapter-1', shard_index: 0,
    module_key: 'mod_01', lesson_keys: ['lsn_001', 'lsn_002'], lesson_index_offset: 0, chapter_lesson_offset: 0 };
  const planning = (idm: boolean) => ({
    loadAuthority: async () => authority,
    loadChapterInput: async () => ({ skeleton: fixture.skeleton, shard_plan: shardFixture!.plan,
      source_facts: fixture.facts,
      ...(idm ? { idm: { design: fixture.design, lessons, input_tokens: 400_000, remaining_ms: 300_000 } } : {}) }),
    completeChapter: async () => assert.fail('a failed call stores nothing'),
  });
  const failing = (error: Error) => ({ chapter: async (_request: Row,
    execution: { beforeProviderDispatch: () => Promise<void> }) => {
    await execution.beforeProviderDispatch(); throw error;
  } });
  const worker = { markProviderDispatched: async () => undefined };
  const signal = new AbortController().signal;
  const idmRuntime = { embedding_model: 'e', embedding_dimensions: 768,
    budgets: ORCHESTRATION_V2_IDM_EXECUTION_POLICY.planning, pipeline: 'idm-1' as const };
  await assert.rejects(executeOrchestrationV2PlanningTask(lease(), planning(true) as never, worker as never,
    failing(quota()) as never, idmRuntime, async () => undefined, signal),
  error => error instanceof OrchestrationV2ProviderStopError);
  await assert.rejects(executeOrchestrationV2PlanningTask(lease(), planning(true) as never, worker as never,
    failing(rateLimited()) as never, idmRuntime, async () => undefined, signal), { code: 'AI_PROVIDER_RATE_LIMITED' });
  await assert.rejects(executeOrchestrationV2PlanningTask(lease(), planning(false) as never, worker as never,
    failing(quota()) as never, { embedding_model: 'e', embedding_dimensions: 768,
      budgets: ORCHESTRATION_V2_EXECUTION_POLICY.planning }, async () => undefined, signal),
  error => error instanceof RagServiceError && error.code === 'AI_PROVIDER_QUOTA_EXHAUSTED');

  const view = idmScopeViewOf(fixture.design);
  const assembly = assembleIdmOrchestrationArchitecture(fixture.skeleton, view,
    idmShardFixtures(fixture).map(item => ({ artifact_hash: item.artifact_hash, shard: item.shard as never })));
  const keys = new Set(fixture.design.block_scopes[0]!.fact_keys);
  const idmContract = prepareOrchestrationV2UnitGenerationContract({ assembly, unit_path: 'chapter_1.lesson_1.unit_1',
    source_facts: remapFactsToBlockScopes(fixture.facts.filter(fact => keys.has(fact.fact_key)), view),
    idm: { design: fixture.design, lesson_facts: fixture.facts } });
  const unit = (contract: unknown, runtime: Row) => executeOrchestrationV2UnitTask(
    lease({ kind: 'generate_unit', node_id: uuid(30) }), { load: async () => ({ authority, contract }) } as never,
    worker as never, { generate: async (_request: Row, execution: { beforeProviderDispatch?: () => Promise<void> }) => {
      await execution.beforeProviderDispatch?.(); throw quota();
    } } as never, { embedding_model: 'e', embedding_dimensions: 768, allowed_component_types: new Set(SIX), ...runtime },
    (raw: unknown) => raw as never, async () => undefined, async () => undefined, signal);
  await assert.rejects(unit(idmContract, { pipeline: 'idm-1' }), error => error instanceof OrchestrationV2ProviderStopError);
  await assert.rejects(unit({ ...idmContract, idm_unit_brief: undefined }, {}),
    error => error instanceof RagServiceError && error.code === 'AI_PROVIDER_QUOTA_EXHAUSTED');
});

test('worker finalizes an IDM stop as a definitive rejection and leaves legacy quota errors to recovery', async () => {
  const envelope = orchestrationV2DispatchEnvelope({ outbox_id: uuid(11), run_id: uuid(2), task_id: uuid(1),
    dispatch_epoch: 0, routing_shard: 7 });
  for (const [error, expected] of [[new OrchestrationV2ProviderStopError(), 'rejected'], [quota(), 'recovered']] as const) {
    let rejected = '';
    let recovered = '';
    const repository = {
      claimExact: async () => ({ disposition: 'claimed', lease: lease({ kind: 'generate_unit' }) }),
      renew: async () => true, wakeOneCapacityDeferred: async () => null,
      failProviderRejected: async (_lease: unknown, code: string) => { rejected = code; },
      recoverClaimFailure: async (_lease: unknown, code: string) => { recovered = code; return 'outcome_unknown'; },
    } as unknown as Worker;
    const result = await handleOrchestrationV2Delivery(Buffer.from(JSON.stringify(envelope)), { repository,
      limits: { global_concurrency_limit: 8, provider_concurrency_limit: 2, lease_seconds: 30 },
      reserveProvider: async () => uuid(9), releaseUndispatched: async () => undefined,
      releaseRejected: async () => undefined, holdUnknown: async () => undefined,
      execute: async () => { throw error; }, report: () => undefined });
    assert.equal(result.disposition, 'claimed_failed');
    assert.deepEqual([rejected, recovered], expected === 'rejected' ? ['AI_PROVIDER_QUOTA_EXHAUSTED', '']
      : ['', 'AI_PROVIDER_QUOTA_EXHAUSTED']);
  }
});

test('an exhausted key on one unit stops the whole run instead of isolating that unit', async () => {
  const unitLease = lease({ kind: 'generate_unit', task_key: 'content:chapter-1:unit:1', node_id: uuid(12) });
  const f = routed(sql => {
    if (/pg_advisory_xact_lock/.test(sql)) return [];
    if (/SELECT \* FROM lesson_author_workspace_v2_tasks/.test(sql)) return [lockedTask(unitLease)];
    if (/SET status='failed'/.test(sql)) return [{ id: unitLease.task_id }];
    if (/SELECT status,failure_code FROM lesson_author_workspace_v2_runs/.test(sql)) return [{ status: 'executing' }];
    if (/UPDATE lesson_author_workspace_v2_runs/.test(sql)) return [{ id: unitLease.run_id }];
    if (/SET status='canceled'/.test(sql)) return [];
    if (/status='running'/.test(sql) && /count\(\*\)/.test(sql)) return [{ count: 0 }];
    if (/UPDATE lesson_author_workspaces SET status='needs_action'/.test(sql)) return [{ id: unitLease.workspace_id }];
    if (/INSERT INTO lesson_author_workspace_events/.test(sql)) return [{ sequence: 4 }];
  });
  await f.repo.failProviderRejected(unitLease, 'AI_PROVIDER_QUOTA_EXHAUSTED', async () => undefined);
  assert.doesNotMatch(f.queries.map(query => query.sql).join('\n'), /WITH RECURSIVE descendants/);
  const run = f.queries.find(query => /UPDATE lesson_author_workspace_v2_runs/.test(query.sql))!;
  assert.equal(run.params[1], 'AI_PROVIDER_QUOTA_EXHAUSTED');
  const recovery = routed(sql => (/t\.status IN \('failed','timed_out','outcome_unknown'\)/.test(sql) ? [] : undefined));
  await assert.rejects(recovery.repo.recoverOne(async () => undefined, async () => undefined), /unexpected SQL/);
  assert.match(recovery.queries[0]!.sql,
    /NOT IN \('AI_PROVIDER_AUTH_REJECTED','AI_PROVIDER_QUOTA_EXHAUSTED'\)/);
});

test('a rate-limited planning task keeps its code and is requeued after the per-minute window', async () => {
  const skeleton = lease({ kind: 'course_skeleton', task_key: 'architecture:course', chapter_key: null });
  const recover = async (item: OrchestrationV2TaskLease, attempt: number, runStatus = 'planning') => {
    const f = routed(sql => {
      if (/pg_advisory_xact_lock/.test(sql)) return [];
      if (/SELECT status FROM lesson_author_workspace_v2_runs/.test(sql)) return [{ status: runStatus }];
      if (/SELECT t\.\*,coalesce/.test(sql)) return [lockedTask(item, { attempt_count: attempt })];
      if (/SET status='outcome_unknown'/.test(sql)) return [{ id: item.task_id }];
      if (/SET status='queued'/.test(sql)) return [{ id: item.task_id }];
      if (/INSERT INTO lesson_author_workspace_v2_dispatch_outbox/.test(sql)) return [{ id: uuid(9) }];
      if (/SELECT status,failure_code FROM lesson_author_workspace_v2_runs/.test(sql)) return [{ status: runStatus }];
      if (/UPDATE lesson_author_workspace_v2_runs/.test(sql)) return [{ id: item.run_id }];
      if (/SET status='canceled'/.test(sql)) return [];
      if (/status='running'/.test(sql) && /count\(\*\)/.test(sql)) return [{ count: 0 }];
      if (/UPDATE lesson_author_workspaces SET status='needs_action'/.test(sql)) return [{ id: item.workspace_id }];
      if (/INSERT INTO lesson_author_workspace_events/.test(sql)) return [{ sequence: 5 }];
    });
    const disposition = await f.repo.recoverClaimFailure(item, 'AI_PROVIDER_RATE_LIMITED', async () => undefined,
      async () => undefined, async () => undefined);
    return { disposition, queries: f.queries };
  };
  const first = await recover(skeleton, 1);
  assert.equal(first.disposition, 'requeued');
  assert.equal(first.queries.find(query => /SET status='outcome_unknown'/.test(query.sql))!.params[3],
    'AI_PROVIDER_RATE_LIMITED');
  const outbox = first.queries.find(query => /INSERT INTO lesson_author_workspace_v2_dispatch_outbox/.test(query.sql))!;
  assert.match(outbox.sql, /available_at/);
  assert.ok(Number(outbox.params[8]) >= 60_000 && Number(outbox.params[8]) < 65_000);
  const exhausted = await recover(skeleton, 2);
  assert.equal(exhausted.disposition, 'outcome_unknown');
  assert.equal(exhausted.queries.find(query => /UPDATE lesson_author_workspace_v2_runs/.test(query.sql))!.params[1],
    'AI_PROVIDER_RATE_LIMITED');
  // Units keep the ambiguous-outcome path unchanged: their replay can only be the deterministic fallback.
  const unit = await recover(lease({ kind: 'generate_unit', node_id: uuid(12) }), 1, 'executing');
  assert.equal(unit.queries.find(query => /SET status='outcome_unknown'/.test(query.sql))!.params[3],
    'PROVIDER_OUTCOME_UNKNOWN');
  assert.doesNotMatch(unit.queries.find(query => /INSERT INTO lesson_author_workspace_v2_dispatch_outbox/
    .test(query.sql))!.sql, /available_at/);
});
