import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import type { CourseComponentType } from '../../../../tenants/tenant-course-components.constants.js';
import type { GenerationJobDatabase, GenerationJobSql } from '../../shared/lesson-author-generation-job.repository.js';
import { idmTextLength, readIdmCourseDesign, type IdmCourseDesignV1 } from '../../contracts/lesson-author-idm.contract.js';
import { idmBridge, type IdmBridgeMessage, type IdmGoldenSource } from './lesson-author-idm.fixture.js';
import { compileOrchestrationV2WorkspaceApply } from '../../workspace/apply/lesson-author-orchestration-v2-apply.logic.js';
import { readOrchestrationV2ArchitectureAssembly,
  type OrchestrationV2ArchitectureAssembly } from '../lesson-author-orchestration-v2-architecture.logic.js';
import { createOrchestrationV2ChapterRepository } from '../steps/lesson-author-orchestration-v2-chapter.repository.js';
import type { OrchestrationV2ChapterReceipt } from '../steps/lesson-author-orchestration-v2-chapter.logic.js';
import { ORCHESTRATION_V2_IDM_EXECUTION_POLICY } from '../lesson-author-orchestration-v2-execution.config.js';
import type { OrchestrationV2CourseFinalization } from '../finalize/lesson-author-orchestration-v2-finalization.logic.js';
import { createOrchestrationV2FinalizationRepository } from '../finalize/lesson-author-orchestration-v2-finalization.repository.js';
import {
  prepareOrchestrationV2InventoryPublication,
  type OrchestrationV2InventoryNode,
  type OrchestrationV2StoredTask,
} from '../steps/lesson-author-orchestration-v2-inventory.logic.js';
import { orchestrationV2Hash } from '../../shared/lesson-author-orchestration-v2.logic.js';
import { createOrchestrationV2PlanningRepository } from '../steps/lesson-author-orchestration-v2-planning.repository.js';
import { executeOrchestrationV2PlanningTask } from '../steps/lesson-author-orchestration-v2-planning.service.js';
import {
  readOrchestrationV2ChapterShardResponse,
  readOrchestrationV2CourseSkeletonResponse,
  type OrchestrationV2ChapterShardPlan,
  type OrchestrationV2CourseSkeleton,
} from '../../contracts/lesson-author-orchestration-v2-rag-contract.logic.js';
import { createOrchestrationV2UnitRepository } from '../steps/lesson-author-orchestration-v2-unit.repository.js';
import { readOrchestrationV2UnitProviderResponse,
  type OrchestrationV2UnitGenerationContract } from '../steps/lesson-author-orchestration-v2-unit.logic.js';
import { executeOrchestrationV2UnitTask } from '../steps/lesson-author-orchestration-v2-unit.service.js';
import type { OrchestrationV2TaskLease, createOrchestrationV2WorkerRepository } from '../worker/lesson-author-orchestration-v2-worker.repository.js';
import { workspaceApplyTargetHash, type WorkspaceApplyNode } from '../../workspace/apply/lesson-author-workspace-apply.logic.js';

/**
 * Test-only harness of the complete IDM chain (spec §15.3): the real Python IDM code behind the
 * Node-built requests (`landa-ai-rag/tests/idm_contract_bridge.py`, offline fake provider) and the
 * real Node repositories/services over an in-memory SQL fake: skeleton → shards → architecture →
 * inventory → units → chapter receipts → finalization → Apply compile. Shared by the IDM and the
 * QLT-6 preserve_source cross-language tests; never imported by the app.
 */

export type Row = Record<string, any>;
type Worker = ReturnType<typeof createOrchestrationV2WorkerRepository>;
export const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
export const hash = (value: unknown) => orchestrationV2Hash(value);
export const RUN = uuid(1), WORKSPACE = uuid(3), TENANT = uuid(4), SNAPSHOT_ID = uuid(5), KB = uuid(8);
const CONVERSATION = uuid(9), CORRELATION = uuid(10), COURSE = 'course-v1:idm+golden+2026';
export const TYPES = ['html', 'problem', 'la_faq', 'la_sortable', 'la_crossword', 'la_diagram'] as const;
export const ALLOWED = new Set<CourseComponentType>(TYPES);
const PLANNING_RUNTIME = { embedding_model: 'gemini-embedding-001', embedding_dimensions: 768,
  budgets: ORCHESTRATION_V2_IDM_EXECUTION_POLICY.planning, pipeline: 'idm-1' as const,
  allowed_component_types: new Set<string>(TYPES) };
const NO_SETTLE = async () => undefined;
/**
 * A chain variant: held practices (Python module answers), the workspace's stored launch brief (QLT-6), its frozen
 * organization context and, to exercise the finalizer's fallback-share rule, every unit counted as a whole
 * source-locked fallback.
 */
export type Variant = { hold_lessons: string[]; launch_brief?: Row | null; organization_context?: Row | null;
  all_units_fallback?: boolean };

export function lease(kind: OrchestrationV2TaskLease['kind'], snapshotHash: string,
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
export class Chain {
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

  constructor(readonly golden: IdmGoldenSource, readonly variant: Variant) {
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
      remaining_ms: 590_000, course_title: String(this.golden.project_context.course_title_hint),
      launch_brief: this.variant.launch_brief ?? null, organization_context: this.variant.organization_context ?? null }];
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
    if (sql.includes('AND r.revision=0') && sql.includes('n.current_revision IS NOT NULL')) {
      return (params[3] as string[]).map(path => this.revisions.get(path)).filter(Boolean) as Row[];
    }
    if (sql.includes('r.task_count,r.chapter_count,r.admitted_fact_count')) return [this.current.finalAuthority];
    if (sql.includes('AS whole_fallback_count')) return [{ unit_count: this.unitArtifacts.length,
      whole_fallback_count: this.variant.all_units_fallback ? this.unitArtifacts.length
        : this.unitArtifacts.filter(unit => ((unit.payload as Row).generated_unit as Row)
          .source_locked_fallback === true).length }];
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
export async function twoPass<T>(run: (answer: (request: Row) => Promise<unknown>) => Promise<T>,
  stage: IdmBridgeMessage['stage'], options: Record<string, unknown>, decode: (raw: Row, request: Row) => unknown,
  requests: Row[]): Promise<T> {
  const collected = new Error('IDM_REQUEST_COLLECTED');
  await assert.rejects(run(async request => { requests.push(request); throw collected; }), error => error === collected);
  const request = requests.at(-1)!;
  const [result] = idmBridge([{ stage, request: { ...request, api_key: 'offline-test-key' }, options }]);
  assert.equal(result!.status, 200, JSON.stringify(result!.response).slice(0, 400));
  return run(async () => decode(result!.response, request));
}

export async function runChain(t: TestContext, golden: IdmGoldenSource, variant: Variant) {
  const pg = await import('pg');
  t.mock.method(pg.default.Pool.prototype, 'query', () => { throw new Error('TEST_DATABASE_ACCESS_FORBIDDEN'); });
  t.mock.method(pg.default.Pool.prototype, 'connect', () => { throw new Error('TEST_DATABASE_ACCESS_FORBIDDEN'); });
  t.mock.method(globalThis, 'fetch', () => { throw new Error('TEST_HTTP_ACCESS_FORBIDDEN'); });
  const nativeInterval = globalThis.setInterval;
  t.mock.method(globalThis, 'setInterval', (...args: Parameters<typeof setInterval>) => {
    const timer = nativeInterval(...args); timer.unref(); t.after(() => clearInterval(timer)); return timer;
  });
  const { normalizeLessonAuthorProposal } = await import('../../../chat/chat.service.js');
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
      } } as never, PLANNING_RUNTIME, NO_SETTLE, signal), 'chapter_shard', { hold_lessons: variant.hold_lessons },
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

  // 3. validate_architecture ----------------------------------------------------------------------
  const validateTask = chain.tasks.find(task => task.kind === 'validate_architecture')!;
  await executeOrchestrationV2PlanningTask(lease('validate_architecture', snapshotHash, { task_id: validateTask.id,
    task_key: 'architecture:validate' }), planning(), chain.worker(), {} as never, PLANNING_RUNTIME, NO_SETTLE, signal);
  const assemblyArtifact = chain.artifacts.find(item => item.artifact.artifact_kind === 'architecture_validation')!.artifact;
  const assembly = readOrchestrationV2ArchitectureAssembly(assemblyArtifact.payload);
  chain.assembly = assembly;
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
  assert.equal(publication.admitted_fact_count, chain.facts.length);
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
    chapter_count: receipts.length, admitted_fact_count: chain.facts.length, snapshot_status: 'sealed',
    snapshot_fact_count: chain.facts.length,
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
  return { chain, design, skeleton, plans, assembly, publication, unitRequests, contracts, receipts, finalization,
    apply, compileApply, unitContent, skeletonRequests, shardRequests };
}
