import assert from 'node:assert/strict';
import test from 'node:test';
import type { AuthUser } from '../../types/express.js';
import { RagServiceError } from './ai-rag-client.service.js';
import type { TenantAiRuntimeSettings } from './ai-engine.types.js';
import type { GenerationJobDatabase, GenerationJobSql } from './lesson-author-generation-job.repository.js';
import { IdmError, idmTextLength, type IdmCourseDesignV1 } from './lesson-author-idm.contract.js';
import { idmScopeViewOf, planIdmChapterShards } from './lesson-author-idm-scope-view.logic.js';
import {
  IDM_PYTHON_AVAILABLE,
  idmFixture,
  idmGoldenCourseDesign,
  idmGoldenSource,
  IDM_FIXTURE_DOCUMENT_ID,
  IDM_FIXTURE_SNAPSHOT_HASH,
} from './lesson-author-idm.fixture.js';
import { createOrchestrationV2AdmissionRepository } from './lesson-author-orchestration-v2-admission.repository.js';
import { createOrchestrationV2AdmissionService } from './lesson-author-orchestration-v2-admission.service.js';
import {
  ORCHESTRATION_V2_EXECUTION_POLICY,
  ORCHESTRATION_V2_IDM_EXECUTION_POLICY,
  loadOrchestrationV2AdmissionRuntime,
  loadOrchestrationV2ExecutionRuntime,
  orchestrationV2ExecutionRuntimeHash,
  orchestrationV2IdmAdmissionWarning,
  orchestrationV2IdmExecutionRuntimeHash,
  resolveOrchestrationV2RunPipeline,
  selectOrchestrationV2AdmissionPipeline,
  type OrchestrationV2RuntimeAuthorityReaders,
} from './lesson-author-orchestration-v2-execution.config.js';
import { orchestrationV2Hash } from './lesson-author-orchestration-v2.logic.js';
import { createOrchestrationV2PlanningRepository } from './lesson-author-orchestration-v2-planning.repository.js';
import { executeOrchestrationV2PlanningTask } from './lesson-author-orchestration-v2-planning.service.js';
import {
  readOrchestrationV2CourseSkeletonResponse,
  type OrchestrationV2CourseSkeletonResponse,
  type OrchestrationV2SourceFact,
  type OrchestrationV2SourceScope,
} from './lesson-author-orchestration-v2-rag-contract.logic.js';
import { lessonAuthorSourceSnapshotHash } from './lesson-author-source-snapshot.logic.js';
import { handleOrchestrationV2Delivery, type OrchestrationV2WorkerRuntimeDependencies } from './lesson-author-orchestration-v2-worker.service.js';
import { orchestrationV2DispatchEnvelope } from './lesson-author-orchestration-v2-dispatch.logic.js';
import type { OrchestrationV2TaskLease, createOrchestrationV2WorkerRepository } from './lesson-author-orchestration-v2-worker.repository.js';

type Worker = ReturnType<typeof createOrchestrationV2WorkerRepository>;
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const ALL_TYPES = new Set(['html', 'problem', 'la_faq', 'la_sortable', 'la_crossword', 'la_diagram'] as const);
const settings = { activeEngine: 'self_built_rag' as const, provider: 'google_ai_studio' as const,
  lessonAuthorModel: 'gemini-3.8-flash', embeddingModel: 'gemini-embedding-001', embeddingDimensions: 768,
  transitionState: 'idle' as const };
const hashInput = { settings, allowed_component_types: ALL_TYPES };
/** Pinned before IDM work: any change here breaks every admitted legacy run (spec R3). */
const LEGACY_RUNTIME_HASH = 'eff977ff7ab70d4804304441ccc618d4d3ed831d609801a42d44c0c2ba814bd9';
const LEGACY_POLICY_HASH = '8316e26e8c46ba2df89903beb88163601c5d2b2c71d0fdbb4b9a17ee06508d06';
/** Pinned so an accidental IDM policy edit is visible: it would strand every running IDM run. */
const IDM_RUNTIME_HASH = 'baa996b58f9d0e552d265f4a30ec14f989d587b098b76b33528257cb79075eeb';

function readers(overrides: Partial<TenantAiRuntimeSettings> = {}): OrchestrationV2RuntimeAuthorityReaders {
  return {
    settings: async tenantId => ({ tenantId, monthlyTokenLimit: null, tokenTimezone: 'Asia/Ho_Chi_Minh',
      chatModel: 'gemini-chat', activeTransitionJobId: null, hasGoogleAiStudioKey: true, apiKeyFingerprint: null,
      ...settings, lessonAuthorModel: 'gemini-3.5-flash', ...overrides }),
    allowedComponentTypes: async () => new Set(ALL_TYPES),
  };
}

function lease(overrides: Partial<OrchestrationV2TaskLease> = {}): OrchestrationV2TaskLease {
  return { task_id: uuid(1), run_id: uuid(2), workspace_id: uuid(3), tenant_id: uuid(4), course_id: 'course-v1:idm+1',
    task_key: 'architecture:course', kind: 'course_skeleton', chapter_key: null, node_id: null,
    contract_hash: orchestrationV2Hash('contract'), input_context_hash: orchestrationV2Hash('input'),
    source_snapshot_id: uuid(5), source_snapshot_hash: IDM_FIXTURE_SNAPSHOT_HASH, runtime_config_hash: IDM_RUNTIME_HASH,
    model: 'gemini-3.8-flash', locale: 'vi', max_output_tokens: 65_536, provider_max_attempts: 2,
    execution_budget_ms: 600_000, lease_token: uuid(6), dispatch_epoch: 1, provider_replay_required: false,
    routing_shard: 7, ai_reservation_id: uuid(7), ...overrides };
}

test('legacy runtime hash and policy are byte-for-byte unchanged; IDM hash is distinct and pinned', () => {
  assert.equal(orchestrationV2ExecutionRuntimeHash(hashInput), LEGACY_RUNTIME_HASH);
  assert.equal(orchestrationV2Hash(ORCHESTRATION_V2_EXECUTION_POLICY), LEGACY_POLICY_HASH);
  assert.equal(orchestrationV2IdmExecutionRuntimeHash(hashInput), IDM_RUNTIME_HASH);
  assert.equal(ORCHESTRATION_V2_IDM_EXECUTION_POLICY.authoring_pipeline, 'idm-1');
  assert.equal('authoring_pipeline' in ORCHESTRATION_V2_EXECUTION_POLICY, false);
});

test('IDM execution policy carries the §5.5 task budgets', () => {
  const budget = (input_tokens: number) => ({ input_tokens, embedding_tokens: 0, max_output_tokens: 65_536,
    max_provider_attempts: 2, execution_budget_ms: 600_000 });
  assert.deepEqual(ORCHESTRATION_V2_IDM_EXECUTION_POLICY.planning.skeleton, budget(1_800_000));
  assert.deepEqual(ORCHESTRATION_V2_IDM_EXECUTION_POLICY.planning.chapter, budget(400_000));
  assert.deepEqual(ORCHESTRATION_V2_IDM_EXECUTION_POLICY.inventory.unit, budget(200_000));
  assert.equal(ORCHESTRATION_V2_IDM_EXECUTION_POLICY.source_snapshot_budget_ms, 600_000);
  // Every IDM provider reservation stays under the SQL 2,000,000-token task ceiling.
  for (const value of [ORCHESTRATION_V2_IDM_EXECUTION_POLICY.planning.skeleton,
    ORCHESTRATION_V2_IDM_EXECUTION_POLICY.planning.chapter, ORCHESTRATION_V2_IDM_EXECUTION_POLICY.inventory.unit]) {
    assert.ok(value.input_tokens + value.max_output_tokens * value.max_provider_attempts <= 2_000_000);
  }
});

test('run pipeline is resolved from the stored runtime hash and stays fail-closed', () => {
  assert.equal(resolveOrchestrationV2RunPipeline(LEGACY_RUNTIME_HASH, hashInput), 'v2-legacy');
  assert.equal(resolveOrchestrationV2RunPipeline(IDM_RUNTIME_HASH, hashInput), 'idm-1');
  assert.throws(() => resolveOrchestrationV2RunPipeline('c'.repeat(64), hashInput),
    { code: 'ORCHESTRATION_V2_EXECUTION_RUNTIME_CHANGED' });
  const changed = { ...hashInput, allowed_component_types: new Set(['html'] as const) };
  assert.throws(() => resolveOrchestrationV2RunPipeline(LEGACY_RUNTIME_HASH, changed),
    { code: 'ORCHESTRATION_V2_EXECUTION_RUNTIME_CHANGED' });
  assert.throws(() => resolveOrchestrationV2RunPipeline(IDM_RUNTIME_HASH,
    { ...hashInput, settings: { ...settings, lessonAuthorModel: 'gemini-other' } }),
  { code: 'ORCHESTRATION_V2_EXECUTION_RUNTIME_CHANGED' });
});

test('admission pipeline selection honours the flag and the tenant allow-list', () => {
  const tenant = uuid(4);
  assert.equal(selectOrchestrationV2AdmissionPipeline(tenant), 'v2-legacy');
  assert.equal(selectOrchestrationV2AdmissionPipeline(tenant, { enabled: false, tenant_allowlist: [tenant] }), 'v2-legacy');
  assert.equal(selectOrchestrationV2AdmissionPipeline(tenant, { enabled: true, tenant_allowlist: [] }), 'idm-1');
  assert.equal(selectOrchestrationV2AdmissionPipeline(tenant, { enabled: true, tenant_allowlist: [uuid(9), tenant] }), 'idm-1');
  assert.equal(selectOrchestrationV2AdmissionPipeline(tenant.toUpperCase(), { enabled: true, tenant_allowlist: [tenant] }),
    'idm-1');
  assert.equal(selectOrchestrationV2AdmissionPipeline(tenant, { enabled: true, tenant_allowlist: [uuid(9)] }), 'v2-legacy');
});

test('an enabled IDM flag with an empty allow-list (= every tenant) produces a startup warning', () => {
  const warning = orchestrationV2IdmAdmissionWarning({ enabled: true, tenant_allowlist: [] });
  assert.match(String(warning), /LESSON_AUTHOR_IDM_PIPELINE_ENABLED=true/);
  assert.match(String(warning), /every tenant/);
  assert.equal(orchestrationV2IdmAdmissionWarning({ enabled: true, tenant_allowlist: [uuid(4)] }), null);
  assert.equal(orchestrationV2IdmAdmissionWarning({ enabled: false, tenant_allowlist: [] }), null);
});

test('admission runtime records the IDM hash and IDM budgets only for selected tenants', async () => {
  const legacy = await loadOrchestrationV2AdmissionRuntime(uuid(4), undefined, readers());
  assert.equal(legacy.pipeline, 'v2-legacy');
  assert.equal(legacy.runtime_config_hash, LEGACY_RUNTIME_HASH);
  assert.equal(legacy.planning_budgets, ORCHESTRATION_V2_EXECUTION_POLICY.planning);
  assert.equal(legacy.inventory_budgets, ORCHESTRATION_V2_EXECUTION_POLICY.inventory);
  assert.equal(legacy.settings.lessonAuthorModel, 'gemini-3.8-flash');
  const off = await loadOrchestrationV2AdmissionRuntime(uuid(4), { enabled: false, tenant_allowlist: [] }, readers());
  assert.equal(off.runtime_config_hash, LEGACY_RUNTIME_HASH);
  const other = await loadOrchestrationV2AdmissionRuntime(uuid(4), { enabled: true, tenant_allowlist: [uuid(9)] }, readers());
  assert.equal(other.runtime_config_hash, LEGACY_RUNTIME_HASH);
  const idm = await loadOrchestrationV2AdmissionRuntime(uuid(4), { enabled: true, tenant_allowlist: [uuid(4)] }, readers());
  assert.equal(idm.pipeline, 'idm-1');
  assert.equal(idm.runtime_config_hash, IDM_RUNTIME_HASH);
  assert.equal(idm.planning_budgets, ORCHESTRATION_V2_IDM_EXECUTION_POLICY.planning);
  assert.equal(idm.inventory_budgets, ORCHESTRATION_V2_IDM_EXECUTION_POLICY.inventory);
  await assert.rejects(loadOrchestrationV2AdmissionRuntime(uuid(4), { enabled: true, tenant_allowlist: [] },
    readers({ hasGoogleAiStudioKey: false })), { code: 'ORCHESTRATION_V2_EXECUTION_RUNTIME_CHANGED' });
});

test('execution runtime derives the pipeline from the lease hash, never from the admission flag', async () => {
  const legacy = await loadOrchestrationV2ExecutionRuntime(lease({ runtime_config_hash: LEGACY_RUNTIME_HASH }), readers());
  assert.equal(legacy.pipeline, 'v2-legacy');
  assert.equal(legacy.planning_budgets, ORCHESTRATION_V2_EXECUTION_POLICY.planning);
  const idm = await loadOrchestrationV2ExecutionRuntime(lease(), readers());
  assert.equal(idm.pipeline, 'idm-1');
  assert.equal(idm.runtime_config_hash, IDM_RUNTIME_HASH);
  assert.equal(idm.planning_budgets.chapter.input_tokens, 400_000);
  await assert.rejects(loadOrchestrationV2ExecutionRuntime(lease({ runtime_config_hash: 'd'.repeat(64) }), readers()),
    { code: 'ORCHESTRATION_V2_EXECUTION_RUNTIME_CHANGED' });
  await assert.rejects(loadOrchestrationV2ExecutionRuntime(lease({ model: 'gemini-other' }), readers()),
    { code: 'ORCHESTRATION_V2_EXECUTION_RUNTIME_CHANGED' });
  await assert.rejects(loadOrchestrationV2ExecutionRuntime(lease(), readers({ embeddingDimensions: 1_536 })),
    { code: 'ORCHESTRATION_V2_EXECUTION_RUNTIME_CHANGED' });
});

test('admission service + repository persist the selected runtime hash without any new column', async () => {
  const target = { workspaceId: uuid(1), tenantId: uuid(4), courseId: 'course-v1:idm+1', conversationId: uuid(3),
    userId: uuid(8) };
  const doc = { document_id: uuid(6), name: 'Nguồn.pdf', status: 'learned', type: 'file',
    updated_at: new Date('2026-10-01T00:00:00.000Z'), source_info: {} };
  const sourceHash = lessonAuthorSourceSnapshotHash({ tenantId: target.tenantId, courseId: target.courseId }, uuid(5), [{
    document_id: doc.document_id, name: doc.name, status: doc.status, updated_at: doc.updated_at.toISOString(),
    source_info: {} }]);
  const workspace = { id: target.workspaceId, status: 'designing', kb_id: uuid(5), source_snapshot_hash: sourceHash,
    source_document_ids: [doc.document_id] };
  async function admitWith(policy: { enabled: boolean; tenant_allowlist: string[] }) {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const responses: Array<Array<Record<string, unknown>>> = [[workspace], [doc], [], [{ id: uuid(20) }],
      [{ id: uuid(21) }], [{ id: uuid(22) }], [{ id: uuid(23) }]];
    const tx: GenerationJobSql = { async query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
      queries.push({ sql, params });
      const rows = responses.shift() ?? assert.fail(`unexpected SQL: ${sql}`);
      return { rows: rows as T[], rowCount: rows.length };
    } };
    const db: GenerationJobDatabase = { transaction: work => work(tx) };
    let nextId = 20;
    const admit = createOrchestrationV2AdmissionService({
      config: { tenant_concurrency_limit: 16, workspace_concurrency_limit: 4, routing_shard_count: 4_096 },
      verifySchema: async () => undefined,
      loadRuntime: tenantId => loadOrchestrationV2AdmissionRuntime(tenantId, policy, readers()),
      createRepository: () => createOrchestrationV2AdmissionRepository({ db, canEdit: async () => true,
        id: () => uuid(nextId++) }),
    });
    const receipt = await admit({ id: target.userId } as AuthUser, target);
    const run = queries.find(query => query.sql.includes('INSERT INTO lesson_author_workspace_v2_runs'))!;
    const sourceTask = queries.find(query => query.sql.includes("'source:snapshot','source_snapshot'"))!;
    return { receipt, runHash: run.params[6], sourceBudget: sourceTask.params[7] };
  }
  const legacy = await admitWith({ enabled: false, tenant_allowlist: [] });
  assert.equal(legacy.runHash, LEGACY_RUNTIME_HASH);
  assert.equal(legacy.sourceBudget, ORCHESTRATION_V2_EXECUTION_POLICY.source_snapshot_budget_ms);
  const idm = await admitWith({ enabled: true, tenant_allowlist: [uuid(4)] });
  assert.equal(idm.runHash, IDM_RUNTIME_HASH);
  assert.equal(idm.sourceBudget, ORCHESTRATION_V2_IDM_EXECUTION_POLICY.source_snapshot_budget_ms);
  assert.notEqual(idm.receipt.bootstrap_hash, legacy.receipt.bootstrap_hash, 'the bootstrap hash binds the pipeline');
});

// --- Planning service: course-skeleton request ----------------------------------------------------
function planningServiceFixture(input: { facts?: OrchestrationV2SourceFact[]; courseTitle?: string | null;
  loadError?: Error } = {}) {
  const { facts } = idmFixture();
  const events: string[] = [];
  const requests: Array<Record<string, unknown>> = [];
  const completions: unknown[][] = [];
  const scopes: OrchestrationV2SourceScope[] = [{ scope_key: 'scope3_00', title: 'Heading', source_ref: 'src-0',
    fact_count: facts.length, content_chars: 1_000 }];
  const authority = { tenant_id: uuid(4), kb_id: uuid(8), conversation_id: uuid(9), correlation_id: uuid(10),
    locale: 'vi' as const, source_documents: [{ document_id: IDM_FIXTURE_DOCUMENT_ID, kb_id: uuid(8), name: 'nguon.pdf',
      type: 'file', status: 'learned' }] };
  const sourceAuthority = { mode: 'model_designed' as const, source: 'none' as const, complete: true, confidence: 0,
    structure_hash: 'e'.repeat(64), reason_codes: [], chapters: [] };
  const planning = {
    loadAuthority: async () => { events.push('authority'); return authority; },
    loadSourceCatalog: async () => { events.push('catalog'); return scopes; },
    loadSourceAuthority: async () => { events.push('source-authority'); return sourceAuthority; },
    loadIdmSkeletonInput: async () => {
      events.push('idm-input');
      if (input.loadError) throw input.loadError;
      return { source_facts: input.facts ?? facts, course_title: input.courseTitle === undefined ? '  Khoá học IDM  '
        : input.courseTitle, input_tokens: 1_800_000, remaining_ms: 400_000 };
    },
    completeSkeleton: async (...args: unknown[]) => { events.push('complete-skeleton'); completions.push(args); },
  };
  const worker = { markProviderDispatched: async () => { events.push('dispatch-marker'); } };
  const clients = { skeleton: async (request: Record<string, unknown>,
    execution: { beforeProviderDispatch: () => Promise<void> }) => {
    events.push('skeleton-call'); requests.push(request); await execution.beforeProviderDispatch();
    return { contract_version: 2 as const, skeleton: idmFixture().skeleton };
  } };
  return { facts, events, requests, completions, planning, worker, clients };
}

async function runSkeleton(f: ReturnType<typeof planningServiceFixture>, pipeline?: 'v2-legacy' | 'idm-1') {
  const budgets = pipeline === 'idm-1' ? ORCHESTRATION_V2_IDM_EXECUTION_POLICY.planning
    : ORCHESTRATION_V2_EXECUTION_POLICY.planning;
  await executeOrchestrationV2PlanningTask(lease(), f.planning as never, f.worker as never, f.clients as never,
    { embedding_model: 'gemini-embedding-001', embedding_dimensions: 768, budgets,
      ...(pipeline ? { pipeline } : {}) }, async () => undefined, new AbortController().signal);
}

test('legacy skeleton request is unchanged: no idm key and no IDM snapshot load', async () => {
  for (const pipeline of [undefined, 'v2-legacy'] as const) {
    const f = planningServiceFixture();
    await runSkeleton(f, pipeline);
    assert.deepEqual(f.events, ['authority', 'catalog', 'source-authority', 'skeleton-call', 'dispatch-marker',
      'complete-skeleton']);
    assert.deepEqual(Object.keys(f.requests[0]!).sort(), ['contract_version', 'conversation_id', 'correlation_id',
      'course_context', 'embedding_dimensions', 'embedding_model', 'history', 'kb_id', 'locale', 'max_attempts',
      'max_output_tokens', 'model', 'scope_catalog', 'source_authority', 'source_documents', 'source_snapshot_hash',
      'system_prompt', 'target', 'tenant_id', 'user_message']);
    assert.equal(f.completions[0]![5], pipeline);
  }
});

test('IDM skeleton request adds the §12.4 idm field built from the persisted snapshot', async () => {
  const f = planningServiceFixture();
  await runSkeleton(f, 'idm-1');
  assert.deepEqual(f.events, ['authority', 'catalog', 'source-authority', 'idm-input', 'skeleton-call',
    'dispatch-marker', 'complete-skeleton']);
  const request = f.requests[0]!;
  assert.deepEqual(request.idm, {
    pipeline_version: 'idm-1',
    project_context: { locale: 'vi', course_title_hint: 'Khoá học IDM',
      source_documents: [{ document_id: IDM_FIXTURE_DOCUMENT_ID, name: 'nguon.pdf', type: 'file' }],
      target_audience: null, learning_objectives: [], duration_target_minutes: null },
    source_facts: f.facts,
    token_allowance: { input_tokens: 1_800_000, output_tokens: 131_072 },
    remaining_budget_ms: 385_000,
  });
  assert.equal(request.locale, 'vi');
  assert.equal(request.max_attempts, 2);
  assert.equal(f.completions[0]![5], 'idm-1');
  const untitled = planningServiceFixture({ courseTitle: null });
  await runSkeleton(untitled, 'idm-1');
  assert.equal((untitled.requests[0]!.idm as { project_context: { course_title_hint: unknown } })
    .project_context.course_title_hint, null);
});

test('oversize IDM sources fail before the dispatch fence and without calling Python', async () => {
  const { facts } = idmFixture();
  const oversize = planningServiceFixture({ facts: [...facts, { ...facts[0]!, fact_key: 'big',
    fact_text: 'x'.repeat(384_000) }] });
  await assert.rejects(runSkeleton(oversize, 'idm-1'), { code: 'IDM_SOURCE_EXCEEDS_SINGLE_TASK_CAPACITY' });
  const counted = planningServiceFixture({ loadError: new IdmError('IDM_SOURCE_EXCEEDS_SINGLE_TASK_CAPACITY') });
  await assert.rejects(runSkeleton(counted, 'idm-1'), { code: 'IDM_SOURCE_EXCEEDS_SINGLE_TASK_CAPACITY' });
  for (const f of [oversize, counted]) {
    assert.equal(f.events.includes('skeleton-call'), false);
    assert.equal(f.events.includes('dispatch-marker'), false);
    assert.equal(f.events.includes('complete-skeleton'), false);
  }
});

test('Python IDM 422 codes and Node IDM failures surface as task failure codes, not crashes', async () => {
  const envelope = orchestrationV2DispatchEnvelope({ outbox_id: uuid(11), run_id: uuid(2), task_id: uuid(1),
    dispatch_epoch: 0, routing_shard: 7 });
  for (const error of [
    new RagServiceError('Không thể hoàn tất.', 422, 'IDM_SOURCE_EXCEEDS_SINGLE_TASK_CAPACITY'),
    new RagServiceError('Không thể hoàn tất.', 422, 'IDM_ACCOUNTING_INVALID'),
    new RagServiceError('Không thể hoàn tất.', 422, 'IDM_COURSE_HAS_NO_TEACHABLE_CONTENT'),
    new IdmError('IDM_COURSE_DESIGN_INVALID', 'idm.design_hash'),
    new IdmError('IDM_LESSON_EXCEEDS_SHARD'),
  ]) {
    const events: Record<string, unknown>[] = [];
    let recorded = '';
    const repository = {
      claimExact: async () => ({ disposition: 'claimed', lease: lease() }),
      renew: async () => true, wakeOneCapacityDeferred: async () => null,
      recoverClaimFailure: async (_lease: unknown, code: string) => { recorded = code; return 'requeued'; },
    } as unknown as Worker;
    const deps: OrchestrationV2WorkerRuntimeDependencies = { repository,
      limits: { global_concurrency_limit: 8, provider_concurrency_limit: 2, lease_seconds: 30 },
      reserveProvider: async () => uuid(9), releaseUndispatched: async () => undefined,
      releaseRejected: async () => undefined, holdUnknown: async () => undefined,
      execute: async () => { throw error; }, report: event => { events.push(event); } };
    const result = await handleOrchestrationV2Delivery(Buffer.from(JSON.stringify(envelope)), deps);
    assert.equal(result.disposition, 'claimed_failed');
    assert.match(recorded, /^[A-Z][A-Z0-9_]*$/);
    assert.equal(recorded, error.code);
    assert.equal(events.find(event => event.event === 'worker_task_failed')?.failure_code, error.code);
  }
});

// --- Planning repository: IDM completeSkeleton ---------------------------------------------------
function sqlFixture(handler: (sql: string, params: unknown[]) => Array<Record<string, unknown>> | undefined) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const tx: GenerationJobSql = { async query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
    queries.push({ sql, params });
    const fanOut = fanOutRows(sql, params);
    const rows = fanOut ?? handler(sql, params) ?? assert.fail(`unexpected SQL: ${sql}`);
    return { rows: rows as T[], rowCount: rows.length };
  } };
  const db: GenerationJobDatabase = { transaction: work => work(tx) };
  const artifacts: Array<Record<string, unknown>> = [];
  const succeeded: unknown[][] = [];
  const worker = {
    markProviderDispatched: async () => undefined,
    succeed: async (...args: unknown[]) => {
      succeeded.push(args);
      artifacts.push(args[4] as Record<string, unknown>);
      await (args[6] as { afterSuccess?: (value: GenerationJobSql) => Promise<void> } | undefined)?.afterSuccess?.(tx);
    },
  } as unknown as Worker;
  let next = 100;
  const repository = createOrchestrationV2PlanningRepository(db, worker, () => uuid(next++));
  return { queries, artifacts, succeeded, repository, worker };
}

function fanOutRows(sql: string, params: unknown[]): Array<Record<string, unknown>> | undefined {
  if (sql.includes('coalesce(max(ordinal)')) return [{ value: 1 }];
  if (sql.includes('INSERT INTO lesson_author_workspace_v2_tasks')) {
    return (JSON.parse(String(params[0])) as Array<{ id: string }>).map(row => ({ id: row.id }));
  }
  if (sql.includes('INSERT INTO lesson_author_workspace_v2_dependencies')) {
    return (JSON.parse(String(params[0])) as Array<{ task_id: string }>).map(row => ({ task_id: row.task_id }));
  }
  if (sql.includes("SET status='queued'")) return (params[1] as string[]).map(id => ({ id }));
  if (sql.includes('INSERT INTO lesson_author_workspace_v2_dispatch_outbox')) {
    return (JSON.parse(String(params[0])) as Array<{ id: string }>).map(row => ({ id: row.id }));
  }
  if (sql.includes("'architecture_progressed'")) return [{ sequence: 3 }];
  return undefined;
}

function snapshotRows(snapshotFacts: Array<{ fact_key: string; fact_chars: number }>) {
  return (sql: string) => {
    if (sql.includes('SELECT id FROM lesson_author_workspace_v2_tasks WHERE')) return [{ id: uuid(1) }];
    if (sql.includes('char_length(fact_text)::integer AS fact_chars')) return snapshotFacts;
    return undefined;
  };
}

const legacyScopes: OrchestrationV2SourceScope[] = [{ scope_key: 'scope3_00', title: 'Heading', source_ref: 'src-0',
  fact_count: 9, content_chars: 1_000 }];

test('IDM completeSkeleton stores payload.idm, block-scope catalogue and IDM shard plans in the artifact hash', async () => {
  const fixture = idmFixture();
  const f = sqlFixture(snapshotRows(fixture.snapshotFacts));
  const response: OrchestrationV2CourseSkeletonResponse = { contract_version: 2, skeleton: fixture.skeleton,
    usage: { inputTokens: 10, outputTokens: 5, embeddingTokens: 0, totalTokens: 15 }, usage_complete: true,
    usage_source: 'provider', content_origin: 'provider_validated', quality_state: 'validated',
    idm: JSON.parse(JSON.stringify(fixture.design)) };
  await f.repository.completeSkeleton(lease(), response, legacyScopes, ORCHESTRATION_V2_IDM_EXECUTION_POLICY.planning,
    async () => undefined, 'idm-1');
  assert.equal(f.artifacts.length, 1);
  const artifact = f.artifacts[0]!;
  const payload = artifact.payload as Record<string, unknown>;
  assert.deepEqual(Object.keys(payload), ['contract_version', 'skeleton', 'scopes', 'shard_plans', 'content_origin',
    'quality_state', 'idm']);
  assert.deepEqual(payload.idm, fixture.design);
  assert.deepEqual(payload.scopes, idmScopeViewOf(fixture.design).scopeCatalog);
  const plan = planIdmChapterShards(fixture.skeleton, fixture.design, ORCHESTRATION_V2_IDM_EXECUTION_POLICY.planning,
    orchestrationV2Hash({ skeleton: fixture.skeleton, idm: fixture.design }));
  assert.deepEqual(payload.shard_plans, plan.chapter_tasks.map(task => task.shard_plan));
  assert.equal(artifact.artifact_hash, orchestrationV2Hash(payload));
  assert.equal(artifact.artifact_kind, 'course_skeleton');
  assert.equal(artifact.validation_contract, 'course-skeleton-v2');
  assert.equal(f.succeeded[0]![1], artifact.artifact_hash);
  assert.deepEqual(f.succeeded[0]![7], { mode: 'provider' });
  const insert = f.queries.find(query => query.sql.includes('INSERT INTO lesson_author_workspace_v2_tasks'))!;
  const rows = JSON.parse(String(insert.params[0])) as Array<Record<string, unknown>>;
  assert.deepEqual(rows.map(row => [row.task_key, row.input_tokens, row.contract_hash]), [
    ...plan.chapter_tasks.map(task => [task.task_key, 400_000, task.contract_hash]),
    ['architecture:validate', 0, plan.validation_task.contract_hash],
  ]);
  // The snapshot facts were read for the invariant check, scoped to the run snapshot.
  const factRead = f.queries.find(query => query.sql.includes('char_length(fact_text)'))!;
  assert.deepEqual(factRead.params, [uuid(5), uuid(3), uuid(4), 'course-v1:idm+1']);
});

test('IDM completeSkeleton fails with IDM_COURSE_DESIGN_INVALID before any durable write', async () => {
  const fixture = idmFixture();
  const base: OrchestrationV2CourseSkeletonResponse = { contract_version: 2, skeleton: fixture.skeleton,
    idm: fixture.design };
  const cases: Array<[string, OrchestrationV2CourseSkeletonResponse, Array<{ fact_key: string; fact_chars: number }>]> = [
    ['missing idm', { ...base, idm: undefined }, fixture.snapshotFacts],
    ['bad design hash', { ...base, idm: { ...fixture.design, design_hash: 'f'.repeat(64) } }, fixture.snapshotFacts],
    ['extra key', { ...base, idm: { ...fixture.design, extra: true } }, fixture.snapshotFacts],
    ['snapshot fact without disposition', base, [...fixture.snapshotFacts, { fact_key: 'late', fact_chars: 3 }]],
    ['scope size differs from snapshot', base, fixture.snapshotFacts.map((fact, index) => index === 0
      ? { ...fact, fact_chars: fact.fact_chars + 1 } : fact)],
    ['chapters do not mirror modules', { ...base, skeleton: { ...fixture.skeleton,
      chapters: [...fixture.skeleton.chapters].reverse().map((chapter, order) => ({ ...chapter, order })) } },
    fixture.snapshotFacts],
  ];
  for (const [name, response, snapshotFacts] of cases) {
    const f = sqlFixture(snapshotRows(snapshotFacts));
    await assert.rejects(f.repository.completeSkeleton(lease(), response, legacyScopes,
      ORCHESTRATION_V2_IDM_EXECUTION_POLICY.planning, async () => undefined, 'idm-1'),
    { code: 'IDM_COURSE_DESIGN_INVALID' }, name);
    assert.equal(f.succeeded.length, 0, name);
    assert.equal(f.queries.some(query => query.sql.includes('INSERT')), false, name);
  }
  const big = idmFixture([[[[50_000], [45_000]]]]);
  const f = sqlFixture(snapshotRows(big.snapshotFacts));
  await assert.rejects(f.repository.completeSkeleton(lease(), { contract_version: 2, skeleton: big.skeleton,
    idm: big.design }, legacyScopes, ORCHESTRATION_V2_IDM_EXECUTION_POLICY.planning, async () => undefined, 'idm-1'),
  { code: 'IDM_LESSON_EXCEEDS_SHARD' });
  assert.equal(f.succeeded.length, 0);
});

test('legacy completeSkeleton ignores a stray idm key and keeps the legacy artifact shape', async () => {
  const fixture = idmFixture();
  const legacySkeleton = { ...fixture.skeleton, chapters: [{ ...fixture.skeleton.chapters[0]!,
    source_scope_ids: ['scope3_00'] }] };
  const f = sqlFixture(() => undefined);
  await f.repository.completeSkeleton(lease({ runtime_config_hash: LEGACY_RUNTIME_HASH }),
    { contract_version: 2, skeleton: legacySkeleton, idm: fixture.design }, legacyScopes,
    ORCHESTRATION_V2_EXECUTION_POLICY.planning, async () => undefined);
  const payload = f.artifacts[0]!.payload as Record<string, unknown>;
  assert.deepEqual(Object.keys(payload), ['contract_version', 'skeleton', 'scopes', 'shard_plans', 'content_origin',
    'quality_state']);
  assert.equal(f.queries.some(query => query.sql.includes('char_length(fact_text)')), false);
  await assert.rejects(f.repository.completeSkeleton(lease(), { contract_version: 2, skeleton: legacySkeleton },
    legacyScopes, ORCHESTRATION_V2_EXECUTION_POLICY.planning, async () => undefined, 'v9' as never),
  { code: 'ORCHESTRATION_V2_PLANNING_ARTIFACT_INVALID' });
});

test('IDM skeleton input loads budget, course title and every fact in snapshot order with a SQL capacity guard', async () => {
  const fixture = idmFixture();
  const rows = fixture.facts.map(fact => ({ ...fact }));
  const handler = (contentChars: number) => (sql: string) => {
    if (sql.includes('SELECT t.input_tokens')) {
      return [{ input_tokens: 1_800_000, remaining_ms: 412_345, course_title: 'Khoá học IDM' }];
    }
    if (sql.includes('count(*)::integer AS fact_count')) return [{ fact_count: rows.length, content_chars: String(contentChars) }];
    if (sql.includes('SELECT document_id::text,fact_key,scope_key,fact_text')) return rows;
    return undefined;
  };
  const ok = sqlFixture(handler(1_000));
  const input = await ok.repository.loadIdmSkeletonInput(lease());
  assert.deepEqual(input, { source_facts: fixture.facts, course_title: 'Khoá học IDM', input_tokens: 1_800_000,
    remaining_ms: 412_345 });
  assert.match(ok.queries[0]!.sql, /LEFT JOIN courses course ON course.id=t.course_id AND course.tenant_id=t.tenant_id/);
  assert.match(ok.queries[2]!.sql, /ORDER BY ordinal/);
  const over = sqlFixture(handler(384_001));
  await assert.rejects(over.repository.loadIdmSkeletonInput(lease()), { code: 'IDM_SOURCE_EXCEEDS_SINGLE_TASK_CAPACITY' });
  assert.equal(over.queries.length, 2, 'fact rows are never loaded for an oversize snapshot');
  await assert.rejects(ok.repository.loadIdmSkeletonInput(lease({ kind: 'chapter_blueprint' })),
    { code: 'ORCHESTRATION_V2_PLANNING_ARTIFACT_INVALID' });
});

test('offline IDM-2 chain: snapshot rows → Node request → Python course design → completeSkeleton → chapter tasks',
  { skip: IDM_PYTHON_AVAILABLE ? false : 'landa-ai-rag/.venv-dev is not available' }, async () => {
    const golden = idmGoldenSource();
    const documentId = golden.facts[0]!.document_id;
    const snapshotFacts = golden.facts.map(fact => ({ fact_key: fact.fact_key, fact_chars: idmTextLength(fact.fact_text) }));
    const catalog = [...new Set(golden.facts.map(fact => fact.scope_key))].map(scopeKey => {
      const owned = golden.facts.filter(fact => fact.scope_key === scopeKey);
      return { scope_key: scopeKey, title: scopeKey, source_ref: owned[0]!.source_ref, fact_count: owned.length,
        content_chars: owned.reduce((sum, fact) => sum + idmTextLength(fact.fact_text), 0) };
    });
    const sourceAuthority = { mode: 'model_designed', source: 'none', complete: true, confidence: 0,
      structure_hash: 'e'.repeat(64), reason_codes: [], chapters: [] };
    const f = sqlFixture((sql: string) => {
      if (sql.includes('SELECT w.kb_id::text')) return [{ kb_id: uuid(8), conversation_id: uuid(9),
        correlation_id: uuid(10), content_locale: 'vi', source_document_ids: [documentId], live_task: uuid(1) }];
      if (sql.includes('FROM kb_documents')) return [{ document_id: documentId, kb_id: uuid(8),
        name: 'quy-trinh-khieu-nai.pdf', type: 'file', status: 'learned' }];
      if (sql.includes("a.artifact_kind='source_catalog'")) return [{ artifact_hash: 'a'.repeat(64),
        payload: { contract_version: 2, source_snapshot_hash: golden.snapshot_hash, source_authority: sourceAuthority,
          scopes: catalog } }];
      if (sql.includes('SELECT t.input_tokens')) return [{ input_tokens: 1_800_000, remaining_ms: 590_000,
        course_title: 'Xử lý khiếu nại khách hàng' }];
      if (sql.includes('count(*)::integer AS fact_count')) return [{ fact_count: golden.facts.length,
        content_chars: snapshotFacts.reduce((sum, fact) => sum + fact.fact_chars, 0) }];
      if (sql.includes('SELECT document_id::text,fact_key,scope_key,fact_text')) return golden.facts.map(fact => ({ ...fact }));
      return snapshotRows(snapshotFacts)(sql);
    });
    let pythonCalls = 0;
    let sentRequest: Record<string, unknown> | null = null;
    const clients = { skeleton: async (request: Record<string, unknown>,
      execution: { beforeProviderDispatch: () => Promise<void> }) => {
      await execution.beforeProviderDispatch();
      sentRequest = request;
      // Same envelope handling as generateRagLessonAuthorCourseSkeletonV2 (api_key added by the HTTP client).
      const result = idmGoldenCourseDesign({ ...request, api_key: 'offline-test-key' });
      pythonCalls = result.provider_calls;
      return { ...readOrchestrationV2CourseSkeletonResponse(result.response, String(request.source_snapshot_hash)),
        idm: result.response.idm };
    } };
    const currentLease = lease({ source_snapshot_hash: golden.snapshot_hash });
    await executeOrchestrationV2PlanningTask(currentLease, f.repository, f.worker, clients as never,
      { embedding_model: 'gemini-embedding-001', embedding_dimensions: 768,
        budgets: ORCHESTRATION_V2_IDM_EXECUTION_POLICY.planning, pipeline: 'idm-1' },
      async () => undefined, new AbortController().signal);

    assert.equal(pythonCalls, 4, 'W1-map, W1-reduce, W2 and W4 ran against the fake provider');
    const idmRequest = (sentRequest as unknown as { idm: Record<string, unknown> }).idm;
    assert.deepEqual(idmRequest.source_facts, golden.facts);
    assert.deepEqual(idmRequest.token_allowance, { input_tokens: 1_800_000, output_tokens: 131_072 });
    assert.equal(idmRequest.remaining_budget_ms, 575_000);
    const payload = f.artifacts[0]!.payload as { idm: IdmCourseDesignV1; scopes: OrchestrationV2SourceScope[];
      shard_plans: Array<{ chapter_key: string; shard_count: number; source_scope_ids: string[] }>;
      skeleton: { chapters: Array<{ chapter_key: string; source_scope_ids: string[] }> } };
    assert.equal(payload.idm.project_context.course_title_hint, 'Xử lý khiếu nại khách hàng');
    assert.equal(payload.scopes.length, 10);
    assert.deepEqual(payload.shard_plans.map(plan => [plan.chapter_key, plan.shard_count, plan.source_scope_ids]),
      payload.skeleton.chapters.map(chapter => [chapter.chapter_key, 1, chapter.source_scope_ids]));
    const insert = f.queries.find(query => query.sql.includes('INSERT INTO lesson_author_workspace_v2_tasks'))!;
    assert.deepEqual((JSON.parse(String(insert.params[0])) as Array<Record<string, unknown>>)
      .map(row => [row.task_key, row.kind, row.input_tokens, row.max_output_tokens]), [
      ['architecture:chapter:chapter-1:shard:1', 'chapter_blueprint', 400_000, 65_536],
      ['architecture:chapter:chapter-2:shard:1', 'chapter_blueprint', 400_000, 65_536],
      ['architecture:chapter:chapter-3:shard:1', 'chapter_blueprint', 400_000, 65_536],
      ['architecture:validate', 'validate_architecture', 0, 0],
    ]);
  });
