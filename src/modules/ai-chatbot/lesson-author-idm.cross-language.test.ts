import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { CourseComponentType } from '../tenants/tenant-course-components.constants.js';
import type { GenerationJobDatabase, GenerationJobSql } from './lesson-author-generation-job.repository.js';
import { idmTextLength, readIdmCourseDesign, type IdmCourseDesignV1 } from './lesson-author-idm.contract.js';
import {
  IDM_BRIDGE_AVAILABLE,
  idmBridge,
  idmGoldenSource,
  type IdmBridgeMessage,
  type IdmGoldenSource,
} from './lesson-author-idm.fixture.js';
import { compileOrchestrationV2WorkspaceApply } from './lesson-author-orchestration-v2-apply.logic.js';
import { readOrchestrationV2ArchitectureAssembly,
  type OrchestrationV2ArchitectureAssembly } from './lesson-author-orchestration-v2-architecture.logic.js';
import { createOrchestrationV2ChapterRepository } from './lesson-author-orchestration-v2-chapter.repository.js';
import type { OrchestrationV2ChapterReceipt } from './lesson-author-orchestration-v2-chapter.logic.js';
import { ORCHESTRATION_V2_IDM_EXECUTION_POLICY } from './lesson-author-orchestration-v2-execution.config.js';
import {
  ORCHESTRATION_V2_COURSE_CONTRACT,
  ORCHESTRATION_V2_COURSE_REVIEW_CONTRACT,
  type OrchestrationV2CourseFinalization,
} from './lesson-author-orchestration-v2-finalization.logic.js';
import { createOrchestrationV2FinalizationRepository } from './lesson-author-orchestration-v2-finalization.repository.js';
import {
  prepareOrchestrationV2InventoryPublication,
  type OrchestrationV2InventoryNode,
  type OrchestrationV2StoredTask,
} from './lesson-author-orchestration-v2-inventory.logic.js';
import { orchestrationV2Hash } from './lesson-author-orchestration-v2.logic.js';
import { createOrchestrationV2PlanningRepository } from './lesson-author-orchestration-v2-planning.repository.js';
import { executeOrchestrationV2PlanningTask } from './lesson-author-orchestration-v2-planning.service.js';
import {
  readOrchestrationV2ChapterShardResponse,
  readOrchestrationV2CourseSkeletonResponse,
  type OrchestrationV2ChapterShardPlan,
  type OrchestrationV2CourseSkeleton,
} from './lesson-author-orchestration-v2-rag-contract.logic.js';
import { createOrchestrationV2UnitRepository } from './lesson-author-orchestration-v2-unit.repository.js';
import { readOrchestrationV2UnitProviderResponse,
  type OrchestrationV2UnitGenerationContract } from './lesson-author-orchestration-v2-unit.logic.js';
import { executeOrchestrationV2UnitTask } from './lesson-author-orchestration-v2-unit.service.js';
import type { OrchestrationV2TaskLease, createOrchestrationV2WorkerRepository } from './lesson-author-orchestration-v2-worker.repository.js';
import { workspaceApplyTargetHash, type WorkspaceApplyNode } from './lesson-author-workspace-apply.logic.js';

/**
 * Spec §15.3: the complete IDM chain with the real Python IDM code behind the
 * Node-built requests (`landa-ai-rag/tests/idm_contract_bridge.py`, offline fake
 * provider) and the real Node repositories/services over an in-memory SQL fake:
 * skeleton → shards → architecture → inventory → units → chapter receipts →
 * finalization → Apply compile.
 */

type Row = Record<string, any>;
type Worker = ReturnType<typeof createOrchestrationV2WorkerRepository>;
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const hash = (value: unknown) => orchestrationV2Hash(value);
const RUN = uuid(1), WORKSPACE = uuid(3), TENANT = uuid(4), SNAPSHOT_ID = uuid(5), KB = uuid(8);
const CONVERSATION = uuid(9), CORRELATION = uuid(10), COURSE = 'course-v1:idm+golden+2026';
const TYPES = ['html', 'problem', 'la_faq', 'la_sortable', 'la_crossword', 'la_diagram'] as const;
const ALLOWED = new Set<CourseComponentType>(TYPES);
const PLANNING_RUNTIME = { embedding_model: 'gemini-embedding-001', embedding_dimensions: 768,
  budgets: ORCHESTRATION_V2_IDM_EXECUTION_POLICY.planning, pipeline: 'idm-1' as const,
  allowed_component_types: new Set<string>(TYPES) };
const NO_SETTLE = async () => undefined;

function lease(kind: OrchestrationV2TaskLease['kind'], snapshotHash: string,
  overrides: Partial<OrchestrationV2TaskLease> = {}): OrchestrationV2TaskLease {
  const provider = ['course_skeleton', 'chapter_blueprint', 'generate_unit'].includes(kind);
  return { task_id: uuid(100), run_id: RUN, workspace_id: WORKSPACE, tenant_id: TENANT, course_id: COURSE,
    task_key: kind, kind, chapter_key: null, node_id: null, contract_hash: hash(`${kind}-contract`),
    input_context_hash: hash(`${kind}-input`), source_snapshot_id: SNAPSHOT_ID, source_snapshot_hash: snapshotHash,
    runtime_config_hash: hash('idm-runtime'), model: 'gemini-3.8-flash', locale: 'vi',
    max_output_tokens: provider ? 65_536 : 0, provider_max_attempts: provider ? 2 : 0, execution_budget_ms: 600_000,
    lease_token: uuid(101), dispatch_epoch: 1, provider_replay_required: false, routing_shard: 3,
    ai_reservation_id: provider ? uuid(102) : null, ...overrides };
}

/** Durable state shared by the fake SQL and the fake worker across the chain. */
class Chain {
  readonly facts: Row[];
  readonly documentId: string;
  readonly artifacts: Array<{ lease: OrchestrationV2TaskLease; artifact: Row }> = [];
  readonly tasks: Row[] = [];
  readonly revisions = new Map<string, Row>();
  obligationRows: Row[] = [];
  skeletonPayload: Row | null = null;
  skeletonHash = '';
  shardArtifacts: Row[] = [];
  assembly: OrchestrationV2ArchitectureAssembly | null = null;
  inventoryNodes: readonly OrchestrationV2InventoryNode[] = [];
  inventoryHash = '';
  manifestHash = '';
  current: Row = {};
  unitArtifacts: Row[] = [];
  chapterReceipts: Row[] = [];
  finalTasks: Row[] = [];
  ordinal = 1;
  events = 0;
  sql: string[] = [];
  private next = 1_000;

  constructor(readonly golden: IdmGoldenSource, readonly variant: { hold_lessons: string[] }) {
    this.facts = golden.facts.map(fact => ({ ...fact, fact_hash: hash(`${fact.fact_key}:${fact.fact_text}`) }));
    this.documentId = golden.facts[0]!.document_id;
  }

  id = () => uuid(this.next++);

  get design(): IdmCourseDesignV1 { return readIdmCourseDesign(this.skeletonPayload!.idm); }

  db(): GenerationJobDatabase {
    const tx: GenerationJobSql = { query: async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => {
      this.sql.push(sql);
      const rows = this.route(sql, params) ?? assert.fail(`unexpected SQL: ${sql.slice(0, 160)}`);
      return { rows: rows as T[], rowCount: rows.length };
    } };
    return { transaction: work => work(tx) };
  }

  worker(): Worker {
    const tx = { query: async (sql: string, params: unknown[] = []) => {
      this.sql.push(sql);
      const rows = this.route(sql, params) ?? assert.fail(`unexpected SQL: ${sql.slice(0, 160)}`);
      return { rows, rowCount: rows.length };
    } } as unknown as GenerationJobSql;
    return {
      markProviderDispatched: async () => undefined,
      succeed: async (...args: unknown[]) => {
        this.artifacts.push({ lease: args[0] as OrchestrationV2TaskLease, artifact: args[4] as Row });
        const hooks = args[6] as { beforeSuccess?: (value: GenerationJobSql) => Promise<void>;
          afterSuccess?: (value: GenerationJobSql) => Promise<void> } | undefined;
        await hooks?.beforeSuccess?.(tx);
        await hooks?.afterSuccess?.(tx);
      },
    } as unknown as Worker;
  }

  private factsFor(keys: readonly string[], withHash: boolean): Row[] {
    const wanted = new Set(keys);
    return this.facts.filter(fact => wanted.has(fact.fact_key)).map(({ fact_hash: factHash, ...fact }) =>
      withHash ? { ...fact, fact_hash: factHash } : fact);
  }

  // eslint-disable-next-line complexity
  route(sql: string, params: unknown[]): Row[] | undefined {
    // --- writes ---------------------------------------------------------------------------------
    if (sql.includes('coalesce(max(ordinal)')) return [{ value: this.ordinal }];
    if (sql.includes('INSERT INTO lesson_author_workspace_v2_tasks')) {
      if (sql.includes('jsonb_to_recordset')) {
        const rows = JSON.parse(String(params[0])) as Row[];
        this.tasks.push(...rows);
        return rows.map(row => ({ id: row.id }));
      }
      this.tasks.push({ id: params[0], ordinal: params[5], task_key: params[6], kind: params[7],
        contract_hash: params[8], input_context_hash: params[9], execution_budget_ms: params[10] });
      return [{ id: params[0] }];
    }
    if (sql.includes('INSERT INTO lesson_author_workspace_v2_dependencies')) {
      return sql.includes('jsonb_to_recordset')
        ? (JSON.parse(String(params[0])) as Row[]).map(row => ({ task_id: row.task_id })) : [{ task_id: params[4] }];
    }
    if (sql.includes('candidate SET status=\'queued\'')) return [];
    if (sql.includes('SET status=\'queued\'')) {
      return sql.includes('id=ANY($2::uuid[])') ? (params[1] as string[]).map(id => ({ id })) : [{ id: params[0] }];
    }
    if (sql.includes('INSERT INTO lesson_author_workspace_v2_dispatch_outbox')) {
      return sql.includes('jsonb_to_recordset')
        ? (JSON.parse(String(params[0])) as Row[]).map(row => ({ id: row.id })) : [{ id: params[0] }];
    }
    if (sql.includes('INSERT INTO lesson_author_workspace_events')) return [{ sequence: ++this.events }];
    if (sql.includes('INSERT INTO lesson_author_workspace_v2_assessment_obligations')) {
      this.obligationRows = JSON.parse(String(params[0])) as Row[];
      return this.obligationRows.map(row => ({ id: row.id }));
    }
    if (sql.includes('INSERT INTO lesson_author_workspace_revisions')) {
      return (JSON.parse(String(params[0])) as Row[]).map(row => ({ node_id: row.node_id, revision: 0 }));
    }
    if (sql.includes('SET status=\'finalizing\'') || sql.includes('INSERT INTO lesson_author_workspace_v2_completion_receipts')
      || sql.includes('INSERT INTO lesson_author_workspace_v2_review_receipts')
      || sql.includes('SET status=\'ready\'') || sql.includes('SET status=\'needs_action\'')) return [{ id: uuid(900) }];
    // --- reads ----------------------------------------------------------------------------------
    if (sql.includes('t.id::text AS live_task')) return [{ kb_id: KB, conversation_id: CONVERSATION,
      correlation_id: CORRELATION, content_locale: 'vi', source_document_ids: [this.documentId], live_task: uuid(100) }];
    if (sql.includes('n.contract_hash AS node_contract_hash')) return [this.current.unitAuthority];
    if (sql.includes('FROM kb_documents')) return [{ document_id: this.documentId, kb_id: KB,
      name: 'quy-trinh-khieu-nai.pdf', type: 'file', status: 'learned' }];
    if (sql.includes('a.artifact_kind=\'source_catalog\'')) return [this.sourceCatalog()];
    if (sql.includes('SELECT t.input_tokens')) return [{ input_tokens: this.current.inputTokens,
      remaining_ms: 590_000, course_title: 'Xử lý khiếu nại khách hàng' }];
    if (sql.includes('count(*)::integer AS fact_count')) return [{ fact_count: this.facts.length,
      content_chars: this.facts.reduce((sum, fact) => sum + idmTextLength(fact.fact_text), 0) }];
    if (sql.includes('fact_key=ANY($5::text[])')) return this.factsFor(params[4] as string[], sql.includes('fact_hash'));
    if (sql.includes('FROM lesson_author_workspace_source_facts') && sql.includes('char_length(fact_text)::integer')) {
      return this.facts.map(fact => ({ fact_key: fact.fact_key, fact_chars: idmTextLength(fact.fact_text) }));
    }
    if (sql.includes('FROM lesson_author_workspace_source_facts') && sql.includes('ORDER BY ordinal')) {
      return this.factsFor(this.facts.map(fact => fact.fact_key), false);
    }
    if (sql.includes('SELECT id FROM lesson_author_workspace_v2_tasks WHERE')) return [{ id: uuid(100) }];
    if (sql.includes('producer.kind=\'course_skeleton\'')) return [{ payload: this.skeletonPayload,
      artifact_hash: this.skeletonHash }];
    if (sql.includes('a.artifact_kind=\'course_skeleton\'')) return [{ payload: this.skeletonPayload }];
    if (sql.includes('a.artifact_kind IN (\'course_skeleton\',\'chapter_blueprint\')')) return [
      { artifact_kind: 'course_skeleton', artifact_hash: this.skeletonHash, payload: this.skeletonPayload,
        task_key: 'architecture:course', kind: 'course_skeleton' },
      ...this.shardArtifacts];
    if (sql.includes('(\'architecture_validation\',\'inventory_receipt\',\'chapter_receipt\')')) return [
      { artifact_kind: 'architecture_validation', artifact_hash: this.assembly!.assembly_hash, payload: this.assembly,
        task_key: 'architecture:validate', kind: 'validate_architecture', chapter_key: null, node_id: null,
        result_hash: this.assembly!.assembly_hash, validation_contract: 'architecture-validation-v2', ordinal: 0 },
      { artifact_kind: 'inventory_receipt', artifact_hash: hash('inventory-receipt'), payload: this.inventoryPayload(),
        task_key: 'inventory:publish', kind: 'publish_inventory', chapter_key: null, node_id: null,
        result_hash: hash('inventory-receipt'), validation_contract: 'inventory-publication-v2', ordinal: 0 },
      ...this.chapterReceipts];
    if (sql.includes('a.artifact_kind IN (\'architecture_validation\',\'inventory_receipt\')')) return [
      { artifact_kind: 'architecture_validation', artifact_hash: this.assembly!.assembly_hash, payload: this.assembly },
      { artifact_kind: 'inventory_receipt', artifact_hash: hash('inventory-receipt'), payload: this.inventoryPayload() }];
    if (sql.includes('kind=\'component\'') && sql.includes('parent_id=$4')) {
      return this.inventoryNodes.filter(node => node.parent_id === params[3] && node.kind === 'component')
        .map(node => ({ id: node.id, canonical_path: node.canonical_path, sort_order: node.sort_order,
          protected_contract: node.protected_contract, contract_hash: node.contract_hash, content_state: 'planned',
          current_revision: null }));
    }
    if (sql.includes('SELECT id::text,canonical_path,kind,content_state,current_revision')) {
      return this.inventoryNodes.filter(node => (params[3] as string[]).includes(node.canonical_path))
        .map(node => ({ id: node.id, canonical_path: node.canonical_path, kind: node.kind, content_state: 'planned',
          current_revision: null }));
    }
    if (sql.includes('r.status AS run_status,r.manifest_hash,s.status AS snapshot_status,n.canonical_path')) {
      return [this.current.chapterAuthority];
    }
    if (sql.includes('parent.kind=\'generate_unit\'')) {
      return this.unitArtifacts.filter(unit => unit.chapter_key === params[2]);
    }
    if (sql.includes('r.revision=n.current_revision')) {
      return (params[3] as string[]).map(path => this.revisions.get(path)).filter(Boolean) as Row[];
    }
    if (sql.includes('r.task_count,r.chapter_count,r.admitted_fact_count')) return [this.current.finalAuthority];
    if (sql.includes('FROM lesson_author_workspace_v2_assessment_obligations')) {
      return this.obligationRows.map(row => ({ ...row, plan_revision_hash: this.assembly!.assembly_hash,
        status: 'open', resolution_kind: null, resolution_evidence_hash: null }));
    }
    if (sql.includes('status,result_hash,validation_contract') && sql.includes('FROM lesson_author_workspace_v2_tasks')) {
      return this.finalTasks;
    }
    if (sql.includes('SELECT child.task_key AS child_key')) {
      return this.finalTasks.flatMap(task => (task.depends_on as string[]).map(parent => ({ child_key: task.task_key,
        parent_key: parent, ordinal: 0 })));
    }
    return undefined;
  }

  private sourceCatalog(): Row {
    const keys = [...new Set(this.facts.map(fact => fact.scope_key as string))];
    return { artifact_hash: hash('source-catalog'), payload: { contract_version: 2,
      source_snapshot_hash: this.golden.snapshot_hash, source_authority: { mode: 'model_designed', source: 'none',
        complete: true, confidence: 0, structure_hash: 'e'.repeat(64), reason_codes: [], chapters: [] },
      scopes: keys.map(scopeKey => {
        const owned = this.facts.filter(fact => fact.scope_key === scopeKey);
        return { scope_key: scopeKey, title: scopeKey, source_ref: owned[0]!.source_ref, fact_count: owned.length,
          content_chars: owned.reduce((sum, fact) => sum + idmTextLength(fact.fact_text), 0) };
      }) } };
  }

  private inventoryPayload(): Row {
    return { inventory_hash: this.inventoryHash, admitted_fact_count: this.facts.length, manifest_hash: this.manifestHash };
  }
}

/** Run one task in two passes: collect its provider request, call Python in a batch, replay with the answer. */
async function twoPass<T>(run: (answer: (request: Row) => Promise<unknown>) => Promise<T>,
  stage: IdmBridgeMessage['stage'], options: Record<string, unknown>, decode: (raw: Row, request: Row) => unknown,
  requests: Row[]): Promise<T> {
  const collected = new Error('IDM_REQUEST_COLLECTED');
  await assert.rejects(run(async request => { requests.push(request); throw collected; }), error => error === collected);
  const request = requests.at(-1)!;
  const [result] = idmBridge([{ stage, request: { ...request, api_key: 'offline-test-key' }, options }]);
  assert.equal(result!.status, 200, JSON.stringify(result!.response).slice(0, 400));
  return run(async () => decode(result!.response, request));
}

async function runChain(t: TestContext, golden: IdmGoldenSource, variant: { hold_lessons: string[] }) {
  const pg = await import('pg');
  t.mock.method(pg.default.Pool.prototype, 'query', () => { throw new Error('TEST_DATABASE_ACCESS_FORBIDDEN'); });
  t.mock.method(pg.default.Pool.prototype, 'connect', () => { throw new Error('TEST_DATABASE_ACCESS_FORBIDDEN'); });
  t.mock.method(globalThis, 'fetch', () => { throw new Error('TEST_HTTP_ACCESS_FORBIDDEN'); });
  const nativeInterval = globalThis.setInterval;
  t.mock.method(globalThis, 'setInterval', (...args: Parameters<typeof setInterval>) => {
    const timer = nativeInterval(...args); timer.unref(); t.after(() => clearInterval(timer)); return timer;
  });
  const { normalizeLessonAuthorProposal } = await import('./chat.service.js');
  const chain = new Chain(golden, variant);
  const snapshotHash = golden.snapshot_hash;
  const signal = new AbortController().signal;
  const planning = () => createOrchestrationV2PlanningRepository(chain.db(), chain.worker(), chain.id);

  // 1. course_skeleton -------------------------------------------------------------------------------
  chain.current = { inputTokens: 1_800_000 };
  const skeletonRequests: Row[] = [];
  await twoPass(answer => executeOrchestrationV2PlanningTask(lease('course_skeleton', snapshotHash,
    { task_key: 'architecture:course' }), planning(), chain.worker(), {
    skeleton: async (request: Row, execution: { beforeProviderDispatch: () => Promise<void> }) => {
      await execution.beforeProviderDispatch(); return answer(request);
    } } as never, PLANNING_RUNTIME, NO_SETTLE, signal), 'course_skeleton', {}, (raw, request) => ({
    ...readOrchestrationV2CourseSkeletonResponse(raw, String(request.source_snapshot_hash)), idm: raw.idm }),
  skeletonRequests);
  const skeletonArtifact = chain.artifacts.find(item => item.artifact.artifact_kind === 'course_skeleton')!.artifact;
  chain.skeletonPayload = skeletonArtifact.payload as Row;
  chain.skeletonHash = String(skeletonArtifact.artifact_hash);
  assert.equal(chain.skeletonHash, hash(chain.skeletonPayload));
  const design = chain.design;
  const skeleton = chain.skeletonPayload.skeleton as OrchestrationV2CourseSkeleton;
  const plans = chain.skeletonPayload.shard_plans as OrchestrationV2ChapterShardPlan[];
  assert.equal(plans.length, 3);

  // 2. chapter_blueprint × shard ------------------------------------------------------------------
  chain.ordinal = Math.max(...chain.tasks.map(task => Number(task.ordinal)));
  const chapterTasks = chain.tasks.filter(task => task.kind === 'chapter_blueprint');
  const shardRequests: Row[] = [];
  chain.current = { inputTokens: 400_000 };
  for (const task of chapterTasks) {
    await twoPass(answer => executeOrchestrationV2PlanningTask(lease('chapter_blueprint', snapshotHash, {
      task_id: task.id, task_key: task.task_key, chapter_key: task.chapter_key, contract_hash: task.contract_hash,
      input_context_hash: task.input_context_hash }), planning(), chain.worker(), {
      chapter: async (request: Row, execution: { beforeProviderDispatch: () => Promise<void> }) => {
        await execution.beforeProviderDispatch(); return answer(request);
      } } as never, PLANNING_RUNTIME, NO_SETTLE, signal), 'chapter_shard', variant,
    (raw, request) => readOrchestrationV2ChapterShardResponse(raw, request.skeleton, request.shard_plan), shardRequests);
    const stored = chain.artifacts.at(-1)!;
    assert.equal(stored.artifact.artifact_kind, 'chapter_blueprint');
    chain.shardArtifacts.push({ artifact_kind: 'chapter_blueprint', artifact_hash: stored.artifact.artifact_hash,
      payload: stored.artifact.payload, task_key: task.task_key, kind: 'chapter_blueprint' });
  }
  for (const request of shardRequests) {
    const context = request.idm_module_context as Row;
    assert.equal(context.design_hash, design.design_hash);
    assert.deepEqual(context.token_allowance, { input_tokens: 400_000, output_tokens: 131_072 });
    assert.equal(context.remaining_budget_ms, 575_000);
    assert.ok((request.source_facts as Row[]).every(fact => String(fact.scope_key).startsWith('idmcb_')));
  }
  assert.deepEqual(shardRequests.map(request => (request.idm_module_context as Row).lesson_index_offset), [0, 2, 3]);

  // 3. validate_architecture ----------------------------------------------------------------------
  const validateTask = chain.tasks.find(task => task.kind === 'validate_architecture')!;
  await executeOrchestrationV2PlanningTask(lease('validate_architecture', snapshotHash, { task_id: validateTask.id,
    task_key: 'architecture:validate' }), planning(), chain.worker(), {} as never, PLANNING_RUNTIME, NO_SETTLE, signal);
  const assemblyArtifact = chain.artifacts.find(item => item.artifact.artifact_kind === 'architecture_validation')!.artifact;
  const assembly = readOrchestrationV2ArchitectureAssembly(assemblyArtifact.payload);
  chain.assembly = assembly;
  assert.equal(assembly.admitted_fact_count, 46);
  assert.equal(assembly.idm?.excluded_fact_count, 15);
  assert.equal(assembly.idm?.design_hash, design.design_hash);

  // 4. publish_inventory (deterministic, same identity as Apply) --------------------------------------
  const deterministic = (ms: number) => ({ input_tokens: 0, embedding_tokens: 0, max_output_tokens: 0,
    max_provider_attempts: 0, execution_budget_ms: ms });
  const budgetOf = (task: Row) => ({ input_tokens: Number(task.input_tokens ?? 0), embedding_tokens: 0,
    max_output_tokens: Number(task.max_output_tokens ?? 0), max_provider_attempts: Number(task.provider_max_attempts ?? 0),
    execution_budget_ms: Number(task.execution_budget_ms) });
  const skeletonBudget = ORCHESTRATION_V2_IDM_EXECUTION_POLICY.planning.skeleton;
  const existing: OrchestrationV2StoredTask[] = [
    { id: uuid(200), ordinal: 0, task_key: 'source:snapshot', kind: 'source_snapshot', chapter_key: null, node_id: null,
      contract_hash: hash('source-task'), input_context_hash: snapshotHash, priority: 0, max_attempts: 2, depends_on: [],
      budget: deterministic(600_000) },
    { id: uuid(201), ordinal: 1, task_key: 'architecture:course', kind: 'course_skeleton', chapter_key: null,
      node_id: null, contract_hash: hash('skeleton-task'), input_context_hash: hash('source-catalog'), priority: 10,
      max_attempts: 2, depends_on: ['source:snapshot'], budget: { ...skeletonBudget } },
    ...chapterTasks.map(task => ({ id: task.id, ordinal: Number(task.ordinal), task_key: task.task_key,
      kind: 'chapter_blueprint' as const, chapter_key: task.chapter_key, node_id: null, contract_hash: task.contract_hash,
      input_context_hash: task.input_context_hash, priority: 20, max_attempts: 2, depends_on: ['architecture:course'],
      budget: budgetOf(task) })),
    { id: validateTask.id, ordinal: Number(validateTask.ordinal), task_key: 'architecture:validate',
      kind: 'validate_architecture', chapter_key: null, node_id: null, contract_hash: validateTask.contract_hash,
      input_context_hash: validateTask.input_context_hash, priority: 30, max_attempts: 2,
      depends_on: chapterTasks.map(task => task.task_key), budget: budgetOf(validateTask) },
  ];
  const publishTask = chain.tasks.find(task => task.kind === 'publish_inventory')!;
  existing.push({ id: publishTask.id, ordinal: Number(publishTask.ordinal), task_key: 'inventory:publish',
    kind: 'publish_inventory', chapter_key: null, node_id: null, contract_hash: publishTask.contract_hash,
    input_context_hash: publishTask.input_context_hash, priority: 40, max_attempts: 2,
    depends_on: ['architecture:validate'], budget: deterministic(Number(publishTask.execution_budget_ms)) });
  const publication = prepareOrchestrationV2InventoryPublication({ run_id: RUN, assembly, existing_tasks: existing,
    budgets: ORCHESTRATION_V2_IDM_EXECUTION_POLICY.inventory });
  assert.equal(publication.admitted_fact_count, 61);
  chain.inventoryNodes = publication.nodes;
  chain.inventoryHash = publication.inventory_hash;
  chain.manifestHash = publication.manifest.manifest_hash;

  // 5. generate_unit for every unit --------------------------------------------------------------------
  const unitTasks = publication.new_tasks.filter(task => task.kind === 'generate_unit');
  const unitRequests: Row[] = [];
  const contracts: OrchestrationV2UnitGenerationContract[] = [];
  const unitRepository = createOrchestrationV2UnitRepository(chain.db(), chain.worker(), chain.id);
  for (const task of unitTasks) {
    const node = publication.nodes.find(candidate => candidate.id === task.node_id)!;
    chain.current = { unitAuthority: { kb_id: KB, conversation_id: CONVERSATION, correlation_id: CORRELATION,
      content_locale: 'vi', source_document_ids: [chain.documentId], canonical_path: node.canonical_path,
      node_contract_hash: node.contract_hash, content_state: 'planned', current_revision: null, task_key: task.task_key } };
    const unitLease = lease('generate_unit', snapshotHash, { task_id: task.id, task_key: task.task_key,
      chapter_key: task.chapter_key, node_id: task.node_id, contract_hash: task.contract_hash,
      input_context_hash: task.input_context_hash });
    await twoPass(answer => executeOrchestrationV2UnitTask(unitLease, unitRepository, chain.worker(), {
      generate: async (request: Row, execution: { beforeProviderDispatch?: () => Promise<void> }) => {
        await execution.beforeProviderDispatch?.(); return answer(request);
      } } as never, { embedding_model: 'gemini-embedding-001', embedding_dimensions: 768, allowed_component_types: ALLOWED,
      unit_soft_deadline_ms: 45_000, pipeline: 'idm-1', idm_unit_soft_deadline_ms: 120_000 },
    normalizeLessonAuthorProposal, NO_SETTLE, async () => undefined, signal), 'unit', {},
    (raw, request) => readOrchestrationV2UnitProviderResponse(raw, request.unit_contract), unitRequests);
    const request = unitRequests.at(-1)!;
    contracts.push(request.unit_contract as OrchestrationV2UnitGenerationContract);
    const stored = chain.artifacts.at(-1)!;
    assert.equal(stored.artifact.artifact_kind, 'unit_baseline');
    const payload = stored.artifact.payload as Row;
    chain.unitArtifacts.push({ task_id: task.id, task_key: task.task_key, node_id: task.node_id,
      artifact_hash: stored.artifact.artifact_hash, payload, chapter_key: task.chapter_key });
    for (const [index, value] of (payload.nodes as Row[]).entries()) {
      chain.revisions.set(value.path, { canonical_path: value.path, kind: index === 0 ? 'unit' : 'component',
        content_hash: value.content_hash, revision: 0, operation_id: task.id });
    }
  }
  for (const request of unitRequests) {
    assert.equal(request.remaining_workflow_budget_ms, 120_000, 'IDM units use the IDM soft deadline');
    const contract = request.unit_contract as Row;
    assert.ok(contract.idm_unit_brief, 'IDM unit contracts carry the brief');
    assert.ok((contract.component_plan as Row[]).every(plan => (plan.required_artifacts as unknown[]).length === 0));
  }

  // 6. validate_chapter ---------------------------------------------------------------------------
  const chapterRepository = createOrchestrationV2ChapterRepository(chain.db(), chain.worker(), chain.id);
  const receipts: OrchestrationV2ChapterReceipt[] = [];
  for (const task of publication.new_tasks.filter(candidate => candidate.kind === 'validate_chapter')) {
    chain.current = { chapterAuthority: { workspace_status: 'drafting', blueprint_id: null, run_status: 'executing',
      manifest_hash: chain.manifestHash, snapshot_status: 'sealed', canonical_path: 'chapter', kind: 'chapter',
      content_state: 'content_ready', current_revision: 0, task_key: task.task_key,
      execution_budget_ms: task.budget.execution_budget_ms } };
    const chapterLease = lease('validate_chapter', snapshotHash, { task_id: task.id, task_key: task.task_key,
      chapter_key: task.chapter_key, node_id: task.node_id, contract_hash: task.contract_hash,
      input_context_hash: task.input_context_hash });
    const receipt = await chapterRepository.load(chapterLease);
    await chapterRepository.complete(chapterLease, receipt);
    receipts.push(receipt);
    chain.chapterReceipts.push({ artifact_kind: 'chapter_receipt', artifact_hash: receipt.receipt_hash,
      payload: { contract_version: 2, ...receipt }, task_key: task.task_key, kind: 'validate_chapter',
      chapter_key: task.chapter_key, node_id: task.node_id, result_hash: receipt.receipt_hash,
      validation_contract: 'orchestration-chapter-receipt-v2', ordinal: task.ordinal });
  }

  // 7. finalize_course ------------------------------------------------------------------------------
  const finalizeTask = publication.new_tasks.find(task => task.kind === 'finalize_course')!;
  chain.finalTasks = publication.manifest.tasks.map(task => {
    const stored = [...existing, ...publication.new_tasks].find(candidate => candidate.task_key === task.task_key)!;
    const receipt = receipts.find(item => item.chapter_key === task.chapter_key && task.kind === 'validate_chapter');
    return { id: stored.id, ordinal: task.ordinal, task_key: task.task_key, kind: task.kind, chapter_key: task.chapter_key,
      node_id: task.node_id, contract_hash: task.contract_hash, input_context_hash: task.input_context_hash,
      priority: task.priority, max_attempts: task.max_attempts, input_tokens: task.budget.input_tokens,
      embedding_tokens: task.budget.embedding_tokens, max_output_tokens: task.budget.max_output_tokens,
      provider_max_attempts: task.budget.max_provider_attempts, execution_budget_ms: task.budget.execution_budget_ms,
      status: task.kind === 'finalize_course' ? 'running' : 'succeeded',
      result_hash: task.kind === 'finalize_course' ? null : receipt?.receipt_hash ?? hash(task.task_key),
      validation_contract: task.kind === 'finalize_course' ? null : receipt ? 'orchestration-chapter-receipt-v2' : 'done',
      depends_on: task.depends_on };
  });
  chain.current = { finalAuthority: { workspace_status: 'drafting', blueprint_id: null, run_status: 'executing',
    manifest_hash: chain.manifestHash, task_count: publication.manifest.tasks.length,
    chapter_count: receipts.length, admitted_fact_count: 61, snapshot_status: 'sealed', snapshot_fact_count: 61,
    execution_budget_ms: finalizeTask.budget.execution_budget_ms } };
  const finalizationRepository = createOrchestrationV2FinalizationRepository(chain.db(), chain.worker(), chain.id);
  const finalLease = lease('finalize_course', snapshotHash, { task_id: finalizeTask.id, task_key: 'course:finalize',
    contract_hash: finalizeTask.contract_hash, input_context_hash: finalizeTask.input_context_hash });
  const finalization: OrchestrationV2CourseFinalization = await finalizationRepository.load(finalLease);
  await finalizationRepository.complete(finalLease, finalization);

  // 8. Apply compile over the whole course -----------------------------------------------------------
  const unitContent = new Map<string, Row>();
  for (const artifact of chain.unitArtifacts) {
    for (const value of (artifact.payload as Row).nodes as Row[]) unitContent.set(value.path, value);
  }
  const nodes: WorkspaceApplyNode[] = publication.nodes.filter(node => node.kind !== 'course').map(node => {
    const generated = unitContent.get(node.canonical_path);
    const content = (generated?.content ?? node.baseline) as Row;
    const contentHash = generated?.content_hash ?? hash(content);
    return { node_id: node.id, parent_id: node.parent_id!, kind: node.kind as WorkspaceApplyNode['kind'],
      canonical_path: node.canonical_path, sort_order: node.sort_order, content_state: 'content_ready',
      current_revision: 0, protected_contract: node.protected_contract, contract_hash: node.contract_hash,
      baseline: { content, content_hash: contentHash }, current: { content, content_hash: contentHash } } as WorkspaceApplyNode;
  });
  const lastChapter = publication.nodes.filter(node => node.kind === 'chapter').at(-1)!;
  const targets = { course_root_id: uuid(950), course_root_hash: hash('course-root'), mappings: [] };
  /** Apply compile over the course; `edits` (canonical path → content) become author revision 1. */
  const compileApply = (edits: ReadonlyMap<string, Row> = new Map()) => {
    const current = nodes.map(node => {
      const edit = edits.get(node.canonical_path);
      return edit ? { ...node, current_revision: 1, current: { content: edit, content_hash: hash(edit) } } : node;
    });
    return compileOrchestrationV2WorkspaceApply({ workspace_id: WORKSPACE,
      course_node_id: publication.nodes[0]!.id, run_id: RUN, content_locale: 'vi', event_head: 7,
      source_snapshot_hash: snapshotHash, runtime_config_hash: hash('idm-runtime'), architecture: assembly,
      architecture_hash: assembly.assembly_hash, inventory_hash: publication.inventory_hash, nodes: current as never,
      unit_artifacts: chain.unitArtifacts as never,
      chapter_receipts: receipts.map(receipt => ({ chapter_key: receipt.chapter_key, artifact_hash: receipt.receipt_hash,
        payload: { contract_version: 2, ...receipt } })),
      allowed: ALLOWED, targets, request: { scope_node_id: lastChapter.id, expected_workspace_revision: 7,
        expected_revision_manifest: current.map(node => ({ node_id: node.node_id, revision: node.current_revision!,
          content_hash: node.current!.content_hash })), expected_target_snapshot_hash: workspaceApplyTargetHash(targets) } });
  };
  const apply = compileApply();
  return { chain, design, skeleton, assembly, publication, unitRequests, contracts, receipts, finalization, apply,
    compileApply, unitContent, skeletonRequests, shardRequests };
}

const WORKSPACE_TEXT = /[<>]/;

function assertWorkspaceContent(content: Row, kind: string, path: string) {
  assert.deepEqual(Object.keys(content).sort(), ['data', 'implementation_notes', 'purpose', 'title'], path);
  assert.ok(typeof content.title === 'string' && content.title.trim() && content.title.length <= 500, path);
  for (const field of ['purpose', 'implementation_notes']) {
    assert.ok(content[field] === null || (typeof content[field] === 'string' && content[field].length <= 8_000), path);
  }
  for (const field of ['title', 'purpose', 'implementation_notes']) {
    assert.ok(!WORKSPACE_TEXT.test(String(content[field] ?? '')), `${path}.${field}`);
  }
  const data = content.data as Row;
  const keys = Object.keys(data).sort();
  if (kind === 'course') assert.deepEqual(keys, ['assessment_strategy', 'prerequisites', 'summary', 'target_audience'], path);
  if (kind === 'chapter') assert.deepEqual(keys, ['learning_outcomes', 'objective'], path);
  if (kind === 'lesson') {
    assert.deepEqual(keys, ['assessment', 'learning_activities', 'learning_objectives', 'objective'], path);
    assert.ok((data.learning_objectives as string[]).length <= 12, path);
  }
  if (kind === 'unit') assert.deepEqual(keys, [], path);
  if (kind === 'media_brief') assert.deepEqual(keys, ['content_points', 'context_description'], path);
  if (kind !== 'component') assert.ok(!WORKSPACE_TEXT.test(JSON.stringify(data)), `${path}.data`);
}

test('IDM cross-language chain reaches ready with accounted-for facts, hash parity and Apply parity',
  { skip: IDM_BRIDGE_AVAILABLE ? false : 'landa-ai-rag/.venv-dev or tests/idm_contract_bridge.py is not available',
    timeout: 300_000 }, async t => {
    const golden = idmGoldenSource();
    const result = await runChain(t, golden, { hold_lessons: [] });
    const { publication, finalization, apply, chain, design } = result;

    // (a) Every workspace node content honours the UI contract (§4.1).
    for (const node of publication.nodes) {
      if (node.baseline) assertWorkspaceContent(node.baseline as unknown as Row, node.kind, node.canonical_path);
      if (node.kind === 'component') {
        const review = (node.protected_contract.metadata as Row).author_review as Row;
        assert.deepEqual(Object.keys(review).sort(), ['example_scenario', 'purpose', 'user_behavior_navigation',
          'visual_asset']);
      }
    }
    for (const artifact of chain.unitArtifacts) {
      for (const [index, value] of ((artifact.payload as Row).nodes as Row[]).entries()) {
        assertWorkspaceContent(value.content, index === 0 ? 'unit' : 'component', value.path);
      }
    }
    // §8.4 author notes: course/chapter/lesson from the design, unit from the W6 quality note.
    const course = publication.nodes.find(node => node.kind === 'course')!;
    assert.equal(course.baseline?.implementation_notes, design.notes.course);
    const chapters = publication.nodes.filter(node => node.kind === 'chapter');
    assert.deepEqual(chapters.map(node => node.baseline?.implementation_notes),
      design.modules.map(module => design.notes.modules[module.module_key]));
    const lessons = publication.nodes.filter(node => node.kind === 'lesson');
    assert.equal(lessons.length, 5);
    assert.ok(lessons.every(node => typeof node.baseline?.implementation_notes === 'string'
      && node.baseline.implementation_notes.startsWith(design.notes.lessons[`lsn_00${lessons.indexOf(node) + 1}`]!)));
    for (const artifact of chain.unitArtifacts) {
      const payload = artifact.payload as Row;
      const quality = (payload.generated_unit as Row).idm_quality as Row;
      assert.ok(quality, 'generated_unit keeps idm_quality');
      assert.equal((payload.nodes as Row[])[0]!.content.implementation_notes, quality.author_note || null);
      assert.equal(payload.content_origin, 'provider_validated');
    }

    // (b) accounted-for: allocated = covered = admitted = 61.
    assert.equal(finalization.contract, ORCHESTRATION_V2_COURSE_CONTRACT);
    if (finalization.contract !== ORCHESTRATION_V2_COURSE_CONTRACT) return;
    assert.deepEqual([finalization.completion.admitted_fact_count, finalization.completion.allocated_fact_count,
      finalization.completion.covered_fact_count], [61, 61, 61]);
    assert.deepEqual(finalization.idm_accounting,
      { course: 36, reference_job_aid: 10, nice_to_know: 1, remove: 4, hold: 6, noise: 4 });
    assert.equal(result.receipts.reduce((sum, receipt) => sum + receipt.allocated_fact_count, 0), 46);
    assert.ok(chain.sql.some(sql => sql.includes('INSERT INTO lesson_author_workspace_v2_completion_receipts')));

    // (c) contract_hash / brief_hash parity: Python accepted every Node contract (UnitGenerationContractV2
    // re-hashes it, storyboard.parse_brief re-hashes the brief) and answered from the brief.
    assert.equal(result.contracts.length, 7);
    for (const contract of result.contracts) {
      const { contract_hash: contractHash, ...base } = contract;
      assert.equal(contractHash, hash(base));
      const { brief_hash: briefHash, ...brief } = contract.idm_unit_brief!;
      assert.equal(briefHash, hash(brief));
    }

    // (d) Apply compile parity: the Apply identity (with notes) equals the published inventory.
    assert.equal(apply.inventory_hash, publication.inventory_hash);
    assert.equal(apply.validation_contract, 'workspace-scoped-apply-2');
    const chapterWrite = apply.writes.find(write => write.kind === 'chapter')!;
    assert.equal(chapterWrite.author_metadata.implementation_notes,
      design.notes.modules[design.modules[chapters.length - 1]!.module_key]);
    assert.ok(apply.writes.some(write => write.kind === 'unit'));

    // (f) Author edits inside an IDM unit still Apply. The unit's revision 0 carries the W6 author note,
    // which its inventory binding (fixed before generate_unit) does not cover.
    // Inside the Apply scope (the last chapter), so the edit is written, not only validated.
    const unitPath = `${chapters.at(-1)!.canonical_path}.lesson_1.unit_1`;
    const unitNode = result.unitContent.get(unitPath)!;
    assert.ok(unitNode.content.implementation_notes, 'the generated unit carries its author note');
    const componentPath = `${unitPath}.component_1`;
    const component = result.unitContent.get(componentPath)!.content as Row;
    const editedComponent = { ...component, title: `${component.title} (tác giả sửa)` };
    const componentApply = result.compileApply(new Map([[componentPath, editedComponent]]));
    assert.equal(componentApply.inventory_hash, publication.inventory_hash);
    const componentWrite = componentApply.writes.find(write => write.canonical_path === componentPath)!;
    assert.deepEqual([componentWrite.revision, componentWrite.title], [1, editedComponent.title]);
    // The workspace API only edits components; Apply still accepts an edited unit revision consistently.
    const editedUnit = { ...unitNode.content, title: 'Tiêu đề đơn vị do tác giả sửa' };
    const unitApply = result.compileApply(new Map([[unitPath, editedUnit], [componentPath, editedComponent]]));
    assert.equal(unitApply.inventory_hash, publication.inventory_hash);
    const unitWrite = unitApply.writes.find(write => write.canonical_path === unitPath)!;
    assert.deepEqual([unitWrite.revision, unitWrite.title, unitWrite.author_metadata.implementation_notes],
      [1, editedUnit.title, unitNode.content.implementation_notes]);
  });

test('IDM cross-language chain with a held practice ends needs_action through the assessment obligation',
  { skip: IDM_BRIDGE_AVAILABLE ? false : 'landa-ai-rag/.venv-dev or tests/idm_contract_bridge.py is not available',
    timeout: 300_000 }, async t => {
    const golden = idmGoldenSource();
    const { finalization, chain, assembly } = await runChain(t, golden, { hold_lessons: ['lsn_002'] });
    assert.equal(assembly.assessment_obligation_count, 1);
    assert.equal(chain.obligationRows.length, 1);
    assert.equal(chain.obligationRows[0]!.unit_path, 'chapter_1.lesson_2.unit_1');
    assert.equal(finalization.contract, ORCHESTRATION_V2_COURSE_REVIEW_CONTRACT);
    if (finalization.contract !== ORCHESTRATION_V2_COURSE_REVIEW_CONTRACT) return;
    assert.equal(finalization.review.open_assessment_obligation_count, 1);
    assert.deepEqual([finalization.review.allocated_fact_count, finalization.review.covered_fact_count], [61, 61]);
    assert.ok(chain.sql.some(sql => sql.includes('failure_code=\'ASSESSMENT_REVIEW_REQUIRED\'')));
  });
