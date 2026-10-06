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

type PlanningRepository = ReturnType<typeof createOrchestrationV2PlanningRepository>;
type WorkerRepository = ReturnType<typeof createOrchestrationV2WorkerRepository>;
type SettleProvider = Parameters<WorkerRepository['succeed']>[5];

export interface OrchestrationV2PlanningRuntime {
  embedding_model: string;
  embedding_dimensions: number;
  budgets: OrchestrationV2PlanningBudgets;
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

const TRANSIENT_TRANSACTION_CODES = new Set(['40P01', '40001']);

function transactionCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

async function waitForTransactionRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason ?? new Error('ORCHESTRATION_V2_TASK_ABORTED');
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(signal.reason ?? new Error('ORCHESTRATION_V2_TASK_ABORTED')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, delayMs);
    timer.unref();
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Retry only a rolled-back PostgreSQL transaction boundary. Provider calls
 * stay outside this helper, so a deadlock can never duplicate paid AI work. */
async function withTransientTransactionRetry<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!TRANSIENT_TRANSACTION_CODES.has(transactionCode(error) ?? '') || attempt >= 3) throw error;
      await waitForTransactionRetry(attempt * 20, signal);
    }
  }
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
  if (lease.kind === 'validate_architecture') {
    const input = await planning.loadArchitectureInput(lease);
    const assembly = assembleOrchestrationV2Architecture(input.skeleton, input.scopes, input.shard_artifacts);
    await withTransientTransactionRetry(
      () => planning.completeArchitecture(lease, assembly, runtime.budgets.inventory_publish_budget_ms), signal);
    return 'validate_architecture';
  }
  const authority = await planning.loadAuthority(lease);
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
      await planning.persistSourcePage(lease, page, startOrdinal);
    });
    const persistedAuthority = pageAuthority as OrchestrationV2SourceSnapshotPageResponse['source_authority'] | null;
    if (!persistedAuthority || response.source_authority.structure_hash !== persistedAuthority.structure_hash) {
      throw new OrchestrationV2PlanningServiceError('ORCHESTRATION_V2_PLANNING_RUNTIME_INVALID');
    }
    const scopes = await planning.loadPersistedSourceCatalog(lease);
    await planning.completeSource(lease, { ...response, source_authority: persistedAuthority }, scopes,
      runtime.budgets.skeleton);
    return 'source_snapshot';
  }
  if (lease.kind === 'course_skeleton') {
    const scopes = await planning.loadSourceCatalog(lease);
    const sourceAuthority = await planning.loadSourceAuthority(lease);
    let providerDispatchMarked = false;
    const response = await clients.skeleton({
      ...common(lease, authority, runtime, lease.max_output_tokens), contract_version: 2,
      source_snapshot_hash: lease.source_snapshot_hash, scope_catalog: scopes, source_authority: sourceAuthority,
      max_attempts: lease.provider_max_attempts as 1 | 2,
    }, { ...execution, beforeProviderDispatch: async () => {
      if (providerDispatchMarked) {
        throw new OrchestrationV2PlanningServiceError('ORCHESTRATION_V2_PLANNING_RUNTIME_INVALID');
      }
      await worker.markProviderDispatched(lease);
      providerDispatchMarked = true;
    } });
    if (!providerDispatchMarked) {
      throw new OrchestrationV2PlanningServiceError('ORCHESTRATION_V2_PLANNING_RUNTIME_INVALID');
    }
    await withTransientTransactionRetry(
      () => planning.completeSkeleton(lease, response, scopes, runtime.budgets, settleProvider), signal);
    return 'course_skeleton';
  }
  if (lease.kind === 'chapter_blueprint') {
    const input = await planning.loadChapterInput(lease);
    let providerDispatchMarked = false;
    const response = await clients.chapter({
      ...common(lease, authority, runtime, lease.max_output_tokens), contract_version: 2,
      skeleton: input.skeleton, shard_plan: input.shard_plan, source_facts: input.source_facts,
      max_attempts: lease.provider_max_attempts as 1 | 2,
    }, { ...execution, beforeProviderDispatch: async () => {
      if (providerDispatchMarked) {
        throw new OrchestrationV2PlanningServiceError('ORCHESTRATION_V2_PLANNING_RUNTIME_INVALID');
      }
      await worker.markProviderDispatched(lease);
      providerDispatchMarked = true;
    } });
    if (!providerDispatchMarked) {
      throw new OrchestrationV2PlanningServiceError('ORCHESTRATION_V2_PLANNING_RUNTIME_INVALID');
    }
    await withTransientTransactionRetry(() => planning.completeChapter(lease, response, settleProvider), signal);
    return 'chapter_blueprint';
  }
  throw new OrchestrationV2PlanningServiceError('ORCHESTRATION_V2_PLANNING_TASK_UNSUPPORTED');
}
