import assert from 'node:assert/strict';
import test from 'node:test';
import { RagServiceError } from './ai-rag-client.service.js';
import type { GenerationJobDatabase, GenerationJobSql } from './lesson-author-generation-job.repository.js';
import { IdmError } from './lesson-author-idm.contract.js';
import { assembleIdmOrchestrationArchitecture } from './lesson-author-idm-architecture.logic.js';
import { buildIdmModuleContext, idmScopeViewOf, remapFactsToBlockScopes } from './lesson-author-idm-scope-view.logic.js';
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
import { createOrchestrationV2PlanningRepository } from './lesson-author-orchestration-v2-planning.repository.js';
import { executeOrchestrationV2PlanningTask } from './lesson-author-orchestration-v2-planning.service.js';
import { prepareOrchestrationV2UnitGenerationContract } from './lesson-author-orchestration-v2-unit.logic.js';
import { executeOrchestrationV2UnitTask } from './lesson-author-orchestration-v2-unit.service.js';
import { handleOrchestrationV2Delivery } from './lesson-author-orchestration-v2-worker.service.js';
import type { OrchestrationV2TaskLease, createOrchestrationV2WorkerRepository } from './lesson-author-orchestration-v2-worker.repository.js';

type Worker = ReturnType<typeof createOrchestrationV2WorkerRepository>;
type Row = Record<string, any>;
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const SIX = ['html', 'problem', 'la_faq', 'la_sortable', 'la_crossword', 'la_diagram'] as const;

function lease(overrides: Partial<OrchestrationV2TaskLease> = {}): OrchestrationV2TaskLease {
  return { task_id: uuid(1), run_id: uuid(2), workspace_id: uuid(3), tenant_id: uuid(4), course_id: 'course-v1:idm+1',
    task_key: 'architecture:chapter:chapter-1:shard:1', kind: 'chapter_blueprint', chapter_key: 'chapter-1',
    node_id: null, contract_hash: orchestrationV2Hash('contract'), input_context_hash: orchestrationV2Hash('input'),
    source_snapshot_id: uuid(5), source_snapshot_hash: IDM_FIXTURE_SNAPSHOT_HASH,
    runtime_config_hash: orchestrationV2Hash('runtime'), model: 'gemini-3.8-flash', locale: 'vi',
    max_output_tokens: 65_536, provider_max_attempts: 2, execution_budget_ms: 600_000, lease_token: uuid(6),
    dispatch_epoch: 1, provider_replay_required: false, routing_shard: 7, ai_reservation_id: uuid(7), ...overrides };
}

function idmAssembly() {
  const fixture = idmFixture();
  const shards = idmShardFixtures(fixture);
  const view = idmScopeViewOf(fixture.design);
  const assembly = assembleIdmOrchestrationArchitecture(fixture.skeleton, view,
    shards.map(item => ({ artifact_hash: item.artifact_hash, shard: item.shard as never })));
  return { fixture, shards, view, assembly };
}

test('IDM 422s from /chapter-shard and /unit surface as task failure codes, not crashes', async () => {
  const envelope = orchestrationV2DispatchEnvelope({ outbox_id: uuid(11), run_id: uuid(2), task_id: uuid(1),
    dispatch_epoch: 0, routing_shard: 7 });
  const cases = [
    ['chapter_blueprint', new RagServiceError('Không thể hoàn tất.', 422, 'IDM_MODULE_CONTEXT_INVALID')],
    ['generate_unit', new RagServiceError('Không thể hoàn tất.', 422, 'IDM_W5_BRIEF_CONTRACT_MISMATCH')],
    ['generate_unit', new RagServiceError('Không thể hoàn tất.', 422, 'ORCHESTRATION_V2_UNIT_FALLBACK_INVALID')],
    ['chapter_blueprint', new IdmError('IDM_SHARD_DESIGN_INVALID')],
    ['chapter_blueprint', new IdmError('IDM_REMAINING_BUDGET_INSUFFICIENT')],
    ['course_skeleton', new IdmError('IDM_REMAINING_BUDGET_INSUFFICIENT')],
    ['generate_unit', new IdmError('IDM_UNIT_QUALITY_INVALID')],
  ] as const;
  for (const [kind, error] of cases) {
    const events: Row[] = [];
    let recorded = '';
    const repository = {
      claimExact: async () => ({ disposition: 'claimed', lease: lease({ kind }) }),
      renew: async () => true, wakeOneCapacityDeferred: async () => null,
      recoverClaimFailure: async (_lease: unknown, code: string) => { recorded = code; return 'outcome_unknown'; },
    } as unknown as Worker;
    const result = await handleOrchestrationV2Delivery(Buffer.from(JSON.stringify(envelope)), { repository,
      limits: { global_concurrency_limit: 8, provider_concurrency_limit: 2, lease_seconds: 30 },
      reserveProvider: async () => uuid(9), releaseUndispatched: async () => undefined,
      releaseRejected: async () => undefined, holdUnknown: async () => undefined,
      execute: async () => { throw error; }, report: event => { events.push(event); } });
    assert.equal(result.disposition, 'claimed_failed');
    assert.match(recorded, /^[A-Z][A-Z0-9_]*$/);
    assert.equal(recorded, error.code);
    assert.equal(events.find(event => event.event === 'worker_task_failed')?.failure_code, error.code);
  }
});

test('module context is restricted to the shard lessons and the tenant component types', () => {
  const fixture = idmFixture([[[[100]], [[200]], [[300]]], [[[50]]]]);
  const shardLessons = { task_key: 'architecture:chapter:chapter-1:shard:2',
    chapter_key: 'chapter-1', shard_index: 1, module_key: 'mod_01', lesson_keys: ['lsn_002', 'lsn_003'],
    lesson_index_offset: 1, chapter_lesson_offset: 1 };
  const context = buildIdmModuleContext({ design: fixture.design, lessons: shardLessons,
    allowed_component_types: ['problem', 'html', 'unknown'],
    input_tokens: 400_000, max_output_tokens: 65_536, provider_max_attempts: 2, remaining_ms: 45_000 });
  // Below Python's 30 s floor (+15 s margin) the context is never built, so nothing is dispatched.
  assert.throws(() => buildIdmModuleContext({ design: fixture.design, lessons: shardLessons,
    allowed_component_types: ['html'], input_tokens: 400_000, max_output_tokens: 65_536, provider_max_attempts: 2,
    remaining_ms: 44_999 }), { code: 'IDM_REMAINING_BUDGET_INSUFFICIENT' });
  assert.deepEqual(context.module.lessons.map(lesson => lesson.lesson_key), ['lsn_002', 'lsn_003']);
  assert.deepEqual(context.blocks.map(block => block.block_id), ['cb_0002', 'cb_0003']);
  assert.deepEqual(context.blueprint.map(row => row.block_id), ['cb_0002', 'cb_0003']);
  assert.deepEqual(context.block_scopes.map(scope => scope.block_id), ['cb_0002', 'cb_0003']);
  assert.deepEqual(context.allowed_component_types, ['html', 'problem']);
  assert.equal(context.remaining_budget_ms, 30_000, 'exactly the Python minimum');
  assert.equal(context.lesson_index_offset, 1);
  assert.equal(context.design_hash, fixture.design.design_hash);
  assert.throws(() => buildIdmModuleContext({ design: fixture.design, lessons: { task_key: 'x', chapter_key: 'chapter-1',
    shard_index: 0, module_key: 'mod_09', lesson_keys: ['lsn_001'], lesson_index_offset: 0, chapter_lesson_offset: 0 },
  allowed_component_types: [...SIX], input_tokens: 1, max_output_tokens: 1, provider_max_attempts: 1, remaining_ms: 60_000 }),
  { code: 'IDM_COURSE_DESIGN_INVALID' });
  assert.throws(() => buildIdmModuleContext({ design: fixture.design, lessons: { task_key: 'x', chapter_key: 'chapter-1',
    shard_index: 0, module_key: 'mod_01', lesson_keys: ['lsn_001'], lesson_index_offset: 0, chapter_lesson_offset: 0 },
  allowed_component_types: ['unknown'], input_tokens: 1, max_output_tokens: 1, provider_max_attempts: 1,
  remaining_ms: 60_000 }), { code: 'IDM_CONTRACT_INVALID' });
});

test('legacy chapter requests carry no idm_module_context; IDM shard designs are verified after the call', async () => {
  const fixture = idmFixture();
  const [shardFixture] = idmShardFixtures(fixture);
  const requests: Row[] = [];
  const completed: unknown[] = [];
  const authority = { tenant_id: uuid(4), kb_id: uuid(8), conversation_id: uuid(9), correlation_id: uuid(10),
    locale: 'vi' as const, source_documents: [{ document_id: IDM_FIXTURE_DOCUMENT_ID, kb_id: uuid(8), name: 'nguon.pdf',
      type: 'file', status: 'learned' }] };
  const lessons = { task_key: 'architecture:chapter:chapter-1:shard:1', chapter_key: 'chapter-1', shard_index: 0,
    module_key: 'mod_01', lesson_keys: ['lsn_001', 'lsn_002'], lesson_index_offset: 0, chapter_lesson_offset: 0 };
  const planning = (idm: boolean, remainingMs = 300_000) => ({
    loadAuthority: async () => authority,
    loadChapterInput: async (...args: unknown[]) => {
      assert.equal(args.length, idm ? 2 : 1, 'legacy keeps the one-argument call');
      return { skeleton: fixture.skeleton, shard_plan: shardFixture!.plan, source_facts: fixture.facts,
        ...(idm ? { idm: { design: fixture.design, lessons, input_tokens: 400_000, remaining_ms: remainingMs } } : {}) };
    },
    completeChapter: async (...args: unknown[]) => { completed.push(args); },
  });
  const clients = (shard: Row) => ({ chapter: async (request: Row,
    execution: { beforeProviderDispatch: () => Promise<void> }) => {
    requests.push(request); await execution.beforeProviderDispatch();
    return { contract_version: 2 as const, shard };
  } });
  const worker = { markProviderDispatched: async () => undefined };
  const signal = new AbortController().signal;
  const legacyShard = (({ idm_design: _design, ...rest }) => rest)(shardFixture!.shard);
  await executeOrchestrationV2PlanningTask(lease(), planning(false) as never, worker as never,
    clients(legacyShard) as never, { embedding_model: 'e', embedding_dimensions: 768,
      budgets: ORCHESTRATION_V2_EXECUTION_POLICY.planning }, async () => undefined, signal);
  assert.equal('idm_module_context' in requests[0]!, false);
  const idmRuntime = { embedding_model: 'e', embedding_dimensions: 768,
    budgets: ORCHESTRATION_V2_IDM_EXECUTION_POLICY.planning, pipeline: 'idm-1' as const };
  await executeOrchestrationV2PlanningTask(lease(), planning(true) as never, worker as never,
    clients(shardFixture!.shard) as never, { ...idmRuntime,
      allowed_component_types: new Set(['html', 'problem', 'la_faq']) }, async () => undefined, signal);
  const context = requests[1]!.idm_module_context as Row;
  assert.deepEqual(context.allowed_component_types, ['html', 'problem', 'la_faq']);
  assert.deepEqual(context.module.lessons.map((lesson: Row) => lesson.lesson_key), ['lsn_001', 'lsn_002']);
  assert.deepEqual(context.token_allowance, { input_tokens: 400_000, output_tokens: 131_072 });
  assert.equal(context.remaining_budget_ms, 285_000);
  assert.equal(completed.length, 2);
  const broken = structuredClone(shardFixture!.shard);
  broken.idm_design.lesson_index_offset = 5;
  await assert.rejects(executeOrchestrationV2PlanningTask(lease(), planning(true) as never, worker as never,
    clients(broken) as never, idmRuntime, async () => undefined, signal), { code: 'IDM_SHARD_DESIGN_INVALID' });
  assert.equal(completed.length, 2, 'an invalid shard design is never stored');
  // Lease time left − 15 s under Python's 30 s floor: fail before the provider-dispatch fence.
  let dispatched = 0;
  const fenced = { markProviderDispatched: async () => { dispatched++; } };
  await assert.rejects(executeOrchestrationV2PlanningTask(lease(), planning(true, 44_999) as never, fenced as never,
    clients(shardFixture!.shard) as never, idmRuntime, async () => undefined, signal),
  { code: 'IDM_REMAINING_BUDGET_INSUFFICIENT' });
  assert.deepEqual([requests.length, dispatched, completed.length], [3, 0, 2], 'no provider call, nothing stored');
});

test('IDM units use LESSON_AUTHOR_IDM_UNIT_SOFT_DEADLINE_MS; legacy keeps its own bounds', async () => {
  const { fixture, view, assembly } = idmAssembly();
  const keys = new Set(fixture.design.block_scopes[0]!.fact_keys);
  const idmContract = prepareOrchestrationV2UnitGenerationContract({ assembly, unit_path: 'chapter_1.lesson_1.unit_1',
    source_facts: remapFactsToBlockScopes(fixture.facts.filter(fact => keys.has(fact.fact_key)), view),
    idm: { design: fixture.design, lesson_facts: fixture.facts } });
  const legacyContract = { ...idmContract, idm_unit_brief: undefined };
  const authority = { tenant_id: uuid(4), kb_id: uuid(8), conversation_id: uuid(9), correlation_id: uuid(10),
    locale: 'vi' as const, source_documents: [] };
  const collected = new Error('IDM_REQUEST_COLLECTED');
  const unitLease = lease({ kind: 'generate_unit', node_id: uuid(30) });
  const dispatch = (contract: unknown, runtime: Row, seen: Row[]) => executeOrchestrationV2UnitTask(unitLease,
    { load: async () => ({ authority, contract }) } as never,
    { markProviderDispatched: async () => undefined } as never, { generate: async (request: Row,
      execution: { beforeProviderDispatch?: () => Promise<void> }) => {
      await execution.beforeProviderDispatch?.(); seen.push(request); throw collected;
    } } as never, { embedding_model: 'e', embedding_dimensions: 768, allowed_component_types: new Set(SIX), ...runtime },
    (raw: unknown) => raw as never, async () => undefined, async () => undefined, new AbortController().signal);
  const run = async (contract: unknown, runtime: Row): Promise<Row> => {
    const seen: Row[] = [];
    await assert.rejects(dispatch(contract, runtime, seen), error => error === collected);
    return seen[0]!;
  };
  assert.equal((await run(idmContract, { pipeline: 'idm-1', idm_unit_soft_deadline_ms: 120_000,
    unit_soft_deadline_ms: 45_000 })).remaining_workflow_budget_ms, 120_000);
  assert.equal((await run(idmContract, { pipeline: 'idm-1', idm_unit_soft_deadline_ms: 300_000 }))
    .remaining_workflow_budget_ms, 300_000);
  assert.equal((await run(idmContract, {})).remaining_workflow_budget_ms, 120_000, 'IDM default');
  assert.equal((await run(legacyContract, { idm_unit_soft_deadline_ms: 300_000, unit_soft_deadline_ms: 45_000 }))
    .remaining_workflow_budget_ms, 45_000);
  assert.equal((await run({ ...idmContract, idm_unit_brief: null }, { unit_soft_deadline_ms: 45_000 }))
    .remaining_workflow_budget_ms, 45_000, 'a null brief is legacy');
  const invalid = { code: 'ORCHESTRATION_V2_UNIT_RUNTIME_INVALID' };
  for (const runtime of [{ idm_unit_soft_deadline_ms: 29_999 }, { idm_unit_soft_deadline_ms: 300_001 },
    { unit_soft_deadline_ms: 120_001 }]) {
    await assert.rejects(executeOrchestrationV2UnitTask(unitLease, {} as never, {} as never, {} as never,
      { embedding_model: 'e', embedding_dimensions: 768, allowed_component_types: new Set(SIX), ...runtime },
      (raw: unknown) => raw as never, async () => undefined, async () => undefined, new AbortController().signal), invalid);
  }
  const mismatched: Row[] = [];
  await assert.rejects(dispatch(legacyContract, { pipeline: 'idm-1' }, mismatched), invalid);
  await assert.rejects(dispatch(idmContract, { pipeline: 'v2-legacy' }, mismatched), invalid);
  assert.equal(mismatched.length, 0, 'a pipeline mismatch never reaches the provider');
});

function sqlFixture(handler: (sql: string, params: unknown[]) => Row[] | undefined) {
  const queries: string[] = [];
  const artifacts: Row[] = [];
  const tx: GenerationJobSql = { async query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
    queries.push(sql);
    const rows = handler(sql, params) ?? assert.fail(`unexpected SQL: ${sql}`);
    return { rows: rows as T[], rowCount: rows.length };
  } };
  const db: GenerationJobDatabase = { transaction: work => work(tx) };
  const worker = { succeed: async (...args: unknown[]) => {
    artifacts.push(args[4] as Row);
    await (args[6] as { afterSuccess?: (value: GenerationJobSql) => Promise<void> } | undefined)?.afterSuccess?.(tx);
  } } as unknown as Worker;
  let next = 100;
  return { queries, artifacts, repository: createOrchestrationV2PlanningRepository(db, worker, () => uuid(next++)) };
}

test('completeArchitecture hashes the IDM extension; a tampered idm is rejected', async () => {
  const { assembly } = idmAssembly();
  const f = sqlFixture(sql => {
    if (sql.includes('coalesce(max(ordinal)')) return [{ value: 4 }];
    if (sql.includes('INSERT INTO lesson_author_workspace_v2_tasks')) return [{ id: uuid(60) }];
    if (sql.includes('INSERT INTO lesson_author_workspace_v2_dependencies')) return [{ task_id: uuid(60) }];
    if (sql.includes('SET status=\'queued\'')) return [{ id: uuid(60) }];
    if (sql.includes('INSERT INTO lesson_author_workspace_v2_dispatch_outbox')) return [{ id: uuid(61) }];
    return undefined;
  });
  const current = lease({ kind: 'validate_architecture', task_key: 'architecture:validate', chapter_key: null,
    max_output_tokens: 0, provider_max_attempts: 0, ai_reservation_id: null });
  await f.repository.completeArchitecture(current, assembly, 120_000);
  assert.deepEqual(f.artifacts[0]!.payload, assembly);
  await assert.rejects(f.repository.completeArchitecture(current,
    { ...assembly, idm: { ...assembly.idm!, excluded_fact_count: 0 } }, 120_000),
  { code: 'ORCHESTRATION_V2_PLANNING_ARTIFACT_INVALID' });
});

test('IDM chapter input re-keys the shard facts to block scopes and reads the live task budget', async () => {
  const fixture = idmFixture();
  const [shardFixture] = idmShardFixtures(fixture);
  const view = idmScopeViewOf(fixture.design);
  const payload = { contract_version: 2, skeleton: fixture.skeleton, scopes: view.scopeCatalog,
    shard_plans: [shardFixture!.plan], content_origin: 'provider_validated', quality_state: 'validated',
    idm: fixture.design };
  const f = sqlFixture((sql, params) => {
    if (sql.includes('a.artifact_kind=\'course_skeleton\'')) return [{ payload }];
    if (sql.includes('fact_key=ANY($5::text[])')) {
      return fixture.facts.filter(fact => (params[4] as string[]).includes(fact.fact_key));
    }
    if (sql.includes('SELECT t.input_tokens')) return [{ input_tokens: 400_000, remaining_ms: 321_000 }];
    return undefined;
  });
  const input = await f.repository.loadChapterInput(lease(), 'idm-1');
  assert.ok(input.idm);
  assert.deepEqual(input.idm!.lessons.lesson_keys, ['lsn_001', 'lsn_002']);
  assert.deepEqual([input.idm!.input_tokens, input.idm!.remaining_ms], [400_000, 321_000]);
  assert.ok(input.source_facts.every(fact => shardFixture!.plan.source_scope_ids.includes(fact.scope_key)));
  assert.equal(input.source_facts.length, shardFixture!.plan.source_fact_count);
  assert.ok(f.queries.every(sql => !sql.includes('scope_key=ANY')), 'IDM never filters by legacy scope keys');
  const wrong = sqlFixture(sql => sql.includes('a.artifact_kind=\'course_skeleton\'')
    ? [{ payload: { ...payload, scopes: [] } }] : undefined);
  await assert.rejects(wrong.repository.loadChapterInput(lease(), 'idm-1'), { code: 'IDM_COURSE_DESIGN_INVALID' });
});
