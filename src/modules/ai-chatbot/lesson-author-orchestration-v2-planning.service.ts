import type {
  RagLessonAuthorChapterShardV2Request,
  RagLessonAuthorCourseSkeletonV2Request,
  RagLessonAuthorSourceSnapshotV2Request,
} from './ai-rag-client.service.js';
import type { OrchestrationV2PlanningBudgets } from './lesson-author-orchestration-v2-planning.logic.js';
import type {
  OrchestrationV2ChapterShardResponse,
  OrchestrationV2CourseSkeletonResponse,
  OrchestrationV2SourceSnapshotPageResponse,
} from './lesson-author-orchestration-v2-rag-contract.logic.js';
import type { createOrchestrationV2PlanningRepository } from './lesson-author-orchestration-v2-planning.repository.js';
import type { OrchestrationV2TaskLease, createOrchestrationV2WorkerRepository } from './lesson-author-orchestration-v2-worker.repository.js';
import { assembleOrchestrationV2Architecture } from './lesson-author-orchestration-v2-architecture.logic.js';
import {
  IDM_PIPELINE_VERSION,
  buildIdmCourseSkeletonRequest,
  type OrchestrationV2RunPipeline,
} from './lesson-author-idm.contract.js';
import { IDM_V2_COMPONENT_TYPES, buildIdmModuleContext } from './lesson-author-idm-scope-view.logic.js';
import { assembleIdmOrchestrationArchitecture, assertIdmShardDesign } from './lesson-author-idm-architecture.logic.js';
import { idmProviderFailure } from './lesson-author-orchestration-v2-worker.logic.js';
import { withOrchestrationV2TransientRetry } from './lesson-author-orchestration-v2-lock-order.js';

type PlanningRepository = ReturnType<typeof createOrchestrationV2PlanningRepository>;
type WorkerRepository = ReturnType<typeof createOrchestrationV2WorkerRepository>;
type SettleProvider = Parameters<WorkerRepository['succeed']>[5];

export interface OrchestrationV2PlanningRuntime {
  embedding_model: string;
  embedding_dimensions: number;
  budgets: OrchestrationV2PlanningBudgets;
  /** Pipeline resolved from the run's stored runtime hash; absent means legacy. */
  pipeline?: OrchestrationV2RunPipeline;
  /** Tenant component types frozen in the runtime hash; limits the IDM module designer. */
  allowed_component_types?: ReadonlySet<string>;
}

export interface OrchestrationV2PlanningClients {
  source(request: RagLessonAuthorSourceSnapshotV2Request,
    execution: { timeoutMs: number; signal: AbortSignal },
    consumePage: (page: OrchestrationV2SourceSnapshotPageResponse, startOrdinal: number) => Promise<void>): Promise<{
      contract_version: 2; source_snapshot_hash: string; source_revision: string; page_count: number; fact_count: number;
      source_authority: import('./lesson-author-orchestration-v2-rag-contract.logic.js').OrchestrationV2SourceAuthority;
    }>;
  skeleton(request: RagLessonAuthorCourseSkeletonV2Request,
    execution: { timeoutMs: number; signal: AbortSignal;
      beforeProviderDispatch: () => Promise<void> }): Promise<OrchestrationV2CourseSkeletonResponse>;
  chapter(request: RagLessonAuthorChapterShardV2Request,
    execution: { timeoutMs: number; signal: AbortSignal;
      beforeProviderDispatch: () => Promise<void> }): Promise<OrchestrationV2ChapterShardResponse>;
}

export class OrchestrationV2PlanningServiceError extends Error {
  constructor(readonly code: 'ORCHESTRATION_V2_PLANNING_TASK_UNSUPPORTED' | 'ORCHESTRATION_V2_PLANNING_RUNTIME_INVALID') {
    super(code);
    this.name = 'OrchestrationV2PlanningServiceError';
  }
}

/** Retry only a rolled-back PostgreSQL transaction boundary (bounded
 * exponential backoff with jitter, abortable). Provider calls stay outside
 * this helper, so a deadlock can never duplicate paid AI work. */
function withTransientTransactionRetry<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return withOrchestrationV2TransientRetry(() => operation(), { signal });
}

function common(
  lease: OrchestrationV2TaskLease,
  authority: Awaited<ReturnType<PlanningRepository['loadAuthority']>>,
  runtime: OrchestrationV2PlanningRuntime,
  maxOutputTokens: number,
) {
  if (!runtime.embedding_model.trim() || !Number.isSafeInteger(runtime.embedding_dimensions)
    || runtime.embedding_dimensions < 1 || runtime.embedding_dimensions > 4_096) {
    throw new OrchestrationV2PlanningServiceError('ORCHESTRATION_V2_PLANNING_RUNTIME_INVALID');
  }
  return {
    tenant_id: authority.tenant_id,
    kb_id: authority.kb_id,
    conversation_id: authority.conversation_id,
    target: 'lesson_author' as const,
    model: lease.model,
    max_output_tokens: maxOutputTokens,
    embedding_model: runtime.embedding_model,
    embedding_dimensions: runtime.embedding_dimensions,
    system_prompt: 'Server-owned AI ID orchestration V2 contract.',
    user_message: 'Build the admitted course from the selected immutable source documents.',
    history: [],
    source_documents: authority.source_documents,
    course_context: null,
    locale: authority.locale,
    correlation_id: authority.correlation_id,
  };
}

/** IDM provider calls stop the run on an exhausted key (`idmProviderFailure`); legacy calls are unchanged. */
async function providerCall<T>(idm: boolean, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw idm ? idmProviderFailure(error) : error;
  }
}

/** Execute exactly one already-claimed planning task; never schedules or polls. */
export async function executeOrchestrationV2PlanningTask(
  lease: OrchestrationV2TaskLease,
  planning: PlanningRepository,
  worker: WorkerRepository,
  clients: OrchestrationV2PlanningClients,
  runtime: OrchestrationV2PlanningRuntime,
  settleProvider: SettleProvider,
  signal: AbortSignal,
): Promise<'source_snapshot' | 'course_skeleton' | 'chapter_blueprint' | 'validate_architecture'> {
  const idmRun = runtime.pipeline === IDM_PIPELINE_VERSION;
  // Every repository load/persist below is one lease-fenced transaction with
  // no external side effect, so a deadlock victim is simply re-run.
  const db = <T>(operation: () => Promise<T>) => withTransientTransactionRetry(operation, signal);
  if (lease.kind === 'validate_architecture') {
    const input = idmRun ? await db(() => planning.loadArchitectureInput(lease, IDM_PIPELINE_VERSION))
      : await db(() => planning.loadArchitectureInput(lease));
    if (idmRun && !input.idm_view) throw new OrchestrationV2PlanningServiceError('ORCHESTRATION_V2_PLANNING_RUNTIME_INVALID');
    const assembly = input.idm_view
      ? assembleIdmOrchestrationArchitecture(input.skeleton, input.idm_view, input.shard_artifacts)
      : assembleOrchestrationV2Architecture(input.skeleton, input.scopes, input.shard_artifacts);
    await withTransientTransactionRetry(
      () => planning.completeArchitecture(lease, assembly, runtime.budgets.inventory_publish_budget_ms), signal);
    return 'validate_architecture';
  }
  const authority = await db(() => planning.loadAuthority(lease));
  const execution = { timeoutMs: lease.execution_budget_ms, signal };
  if (lease.kind === 'source_snapshot') {
    let pageAuthority: OrchestrationV2SourceSnapshotPageResponse['source_authority'] | null = null;
    const response = await clients.source({
      ...common(lease, authority, runtime, 1), contract_version: 2,
      source_snapshot_hash: lease.source_snapshot_hash,
    }, execution, async (page, startOrdinal) => {
      if (pageAuthority && pageAuthority.structure_hash !== page.source_authority.structure_hash) {
        throw new OrchestrationV2PlanningServiceError('ORCHESTRATION_V2_PLANNING_RUNTIME_INVALID');
      }
      pageAuthority ??= page.source_authority;
      await db(() => planning.persistSourcePage(lease, page, startOrdinal));
    });
    const persistedAuthority = pageAuthority as OrchestrationV2SourceSnapshotPageResponse['source_authority'] | null;
    if (!persistedAuthority || response.source_authority.structure_hash !== persistedAuthority.structure_hash) {
      throw new OrchestrationV2PlanningServiceError('ORCHESTRATION_V2_PLANNING_RUNTIME_INVALID');
    }
    const scopes = await db(() => planning.loadPersistedSourceCatalog(lease));
    await planning.completeSource(lease, { ...response, source_authority: persistedAuthority }, scopes,
      runtime.budgets.skeleton);
    return 'source_snapshot';
  }
  if (lease.kind === 'course_skeleton') {
    const scopes = await db(() => planning.loadSourceCatalog(lease));
    const sourceAuthority = await db(() => planning.loadSourceAuthority(lease));
    const idm = runtime.pipeline === IDM_PIPELINE_VERSION ? await (async () => {
      // Capacity is enforced here, before the dispatch fence, so an oversize
      // snapshot fails the task without any provider call (spec §12.4).
      const input = await db(() => planning.loadIdmSkeletonInput(lease));
      return buildIdmCourseSkeletonRequest({
        locale: authority.locale, course_title: input.course_title, source_documents: authority.source_documents,
        source_facts: input.source_facts, input_tokens: input.input_tokens,
        max_output_tokens: lease.max_output_tokens, provider_max_attempts: lease.provider_max_attempts,
        remaining_ms: input.remaining_ms,
      });
    })() : undefined;
    let providerDispatchMarked = false;
    const response = await providerCall(idm !== undefined, () => clients.skeleton({
      ...common(lease, authority, runtime, lease.max_output_tokens), contract_version: 2,
      source_snapshot_hash: lease.source_snapshot_hash, scope_catalog: scopes, source_authority: sourceAuthority,
      max_attempts: lease.provider_max_attempts as 1 | 2,
      ...(idm === undefined ? {} : { idm }),
    }, { ...execution, beforeProviderDispatch: async () => {
      if (providerDispatchMarked) {
        throw new OrchestrationV2PlanningServiceError('ORCHESTRATION_V2_PLANNING_RUNTIME_INVALID');
      }
      await db(() => worker.markProviderDispatched(lease));
      providerDispatchMarked = true;
    } }));
    if (!providerDispatchMarked) {
      throw new OrchestrationV2PlanningServiceError('ORCHESTRATION_V2_PLANNING_RUNTIME_INVALID');
    }
    await withTransientTransactionRetry(
      () => planning.completeSkeleton(lease, response, scopes, runtime.budgets, settleProvider,
        runtime.pipeline), signal);
    return 'course_skeleton';
  }
  if (lease.kind === 'chapter_blueprint') {
    const input = idmRun ? await db(() => planning.loadChapterInput(lease, IDM_PIPELINE_VERSION))
      : await db(() => planning.loadChapterInput(lease));
    if (idmRun && !input.idm) throw new OrchestrationV2PlanningServiceError('ORCHESTRATION_V2_PLANNING_RUNTIME_INVALID');
    // IDM: the module context is built before the dispatch fence, so an invalid
    // design fails the task without a provider call (spec §7.6.1, §11.2).
    const idmModuleContext = input.idm ? buildIdmModuleContext({ design: input.idm.design,
      lessons: input.idm.lessons,
      allowed_component_types: runtime.allowed_component_types ? [...runtime.allowed_component_types]
        : [...IDM_V2_COMPONENT_TYPES],
      input_tokens: input.idm.input_tokens, max_output_tokens: lease.max_output_tokens,
      provider_max_attempts: lease.provider_max_attempts, remaining_ms: input.idm.remaining_ms }) : undefined;
    let providerDispatchMarked = false;
    const response = await providerCall(idmModuleContext !== undefined, () => clients.chapter({
      ...common(lease, authority, runtime, lease.max_output_tokens), contract_version: 2,
      skeleton: input.skeleton, shard_plan: input.shard_plan, source_facts: input.source_facts,
      max_attempts: lease.provider_max_attempts as 1 | 2,
      ...(idmModuleContext === undefined ? {} : { idm_module_context: idmModuleContext }),
    }, { ...execution, beforeProviderDispatch: async () => {
      if (providerDispatchMarked) {
        throw new OrchestrationV2PlanningServiceError('ORCHESTRATION_V2_PLANNING_RUNTIME_INVALID');
      }
      await db(() => worker.markProviderDispatched(lease));
      providerDispatchMarked = true;
    } }));
    if (!providerDispatchMarked) {
      throw new OrchestrationV2PlanningServiceError('ORCHESTRATION_V2_PLANNING_RUNTIME_INVALID');
    }
    // IDM shards must carry a design that matches the plan and its own V2 projection
    // (IDM_SHARD_DESIGN_INVALID); it is stored inside the chapter_blueprint artifact.
    if (input.idm) assertIdmShardDesign(response.shard, input.idm.design, input.shard_plan);
    await withTransientTransactionRetry(() => planning.completeChapter(lease, response, settleProvider), signal);
    return 'chapter_blueprint';
  }
  throw new OrchestrationV2PlanningServiceError('ORCHESTRATION_V2_PLANNING_TASK_UNSUPPORTED');
}
