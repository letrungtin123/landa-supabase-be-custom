import type { CourseComponentType } from '../tenants/tenant-course-components.constants.js';
import type { LessonAuthorProposal } from '../course-authoring/course-authoring.service.js';
import type { RagLessonAuthorUnitV2Request } from './ai-rag-client.service.js';
import { acceptOrchestrationV2GeneratedUnit,
  type OrchestrationV2UnitProviderResponse } from './lesson-author-orchestration-v2-unit.logic.js';
import type { createOrchestrationV2UnitRepository } from './lesson-author-orchestration-v2-unit.repository.js';
import type {
  OrchestrationV2TaskLease,
  ReleaseUndispatched,
  createOrchestrationV2WorkerRepository,
} from './lesson-author-orchestration-v2-worker.repository.js';
import { idmProviderFailure } from './lesson-author-orchestration-v2-worker.logic.js';
import { withOrchestrationV2TransientRetry } from './lesson-author-orchestration-v2-lock-order.js';

type UnitRepository = ReturnType<typeof createOrchestrationV2UnitRepository>;
type WorkerRepository = ReturnType<typeof createOrchestrationV2WorkerRepository>;
type SettleProvider = Parameters<WorkerRepository['succeed']>[5];

export interface OrchestrationV2UnitRuntime {
  embedding_model: string;
  embedding_dimensions: number;
  allowed_component_types: ReadonlySet<CourseComponentType>;
  /** Optional only for direct unit tests and rolling callers; production config always supplies it. */
  unit_soft_deadline_ms?: number;
  /** Pipeline resolved from the run's runtime hash; absent means legacy. */
  pipeline?: 'v2-legacy' | 'idm-1';
  /** IDM units only (spec §12.5, `LESSON_AUTHOR_IDM_UNIT_SOFT_DEADLINE_MS`); defaults to 120 s. */
  idm_unit_soft_deadline_ms?: number;
}

const IDM_UNIT_SOFT_DEADLINE_DEFAULT_MS = 120_000;

export interface OrchestrationV2UnitClient {
  generate(request: RagLessonAuthorUnitV2Request,
    execution: { timeoutMs: number; signal: AbortSignal;
      beforeProviderDispatch?: () => Promise<void> }): Promise<OrchestrationV2UnitProviderResponse>;
}

export class OrchestrationV2UnitServiceError extends Error {
  constructor(readonly code: 'ORCHESTRATION_V2_UNIT_RUNTIME_INVALID') {
    super(code);
    this.name = 'OrchestrationV2UnitServiceError';
  }
}

/** PostgreSQL deadlock/serialization failures roll back the whole transaction.
 * Replaying only that DB boundary (bounded exponential backoff with jitter,
 * abortable) is safe and must never replay the provider. A boundary whose
 * repository already exhausted its own retries is not retried again. */
function withTransientTransactionRetry<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return withOrchestrationV2TransientRetry(() => operation(), { signal });
}

type OrchestrationV2UnitStage =
  | 'unit_authority_load'
  | 'provider_dispatch_fence'
  | 'provider_request'
  | 'unit_acceptance'
  | 'unit_publication';

function throwAtStage(error: unknown, stage: OrchestrationV2UnitStage): never {
  if (error && typeof error === 'object'
    && typeof (error as { orchestration_stage?: unknown }).orchestration_stage !== 'string') {
    try {
      Object.defineProperty(error, 'orchestration_stage', { value: stage, enumerable: true });
    } catch {
      // Some third-party errors may be frozen. Preserve the authoritative
      // error rather than replacing it only for telemetry metadata.
    }
  }
  throw error;
}

async function atStage<T>(stage: OrchestrationV2UnitStage, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    return throwAtStage(error, stage);
  }
}

/** Execute one claimed unit. Dispatch is persisted before the only provider call. */
export async function executeOrchestrationV2UnitTask(
  lease: OrchestrationV2TaskLease,
  repository: UnitRepository,
  worker: WorkerRepository,
  client: OrchestrationV2UnitClient,
  runtime: OrchestrationV2UnitRuntime,
  normalizeProposal: (raw: unknown) => LessonAuthorProposal,
  settleProvider: SettleProvider,
  releaseUndispatched: ReleaseUndispatched,
  signal: AbortSignal,
): Promise<'generate_unit'> {
  if (!runtime.embedding_model.trim() || !Number.isSafeInteger(runtime.embedding_dimensions)
    || runtime.embedding_dimensions < 1 || runtime.embedding_dimensions > 4_096
    || !runtime.allowed_component_types.size
    || (runtime.unit_soft_deadline_ms !== undefined
      && (!Number.isSafeInteger(runtime.unit_soft_deadline_ms)
        || runtime.unit_soft_deadline_ms < 5_000 || runtime.unit_soft_deadline_ms > 120_000))
    || (runtime.idm_unit_soft_deadline_ms !== undefined
      && (!Number.isSafeInteger(runtime.idm_unit_soft_deadline_ms)
        || runtime.idm_unit_soft_deadline_ms < 30_000 || runtime.idm_unit_soft_deadline_ms > 300_000))) {
    throw new OrchestrationV2UnitServiceError('ORCHESTRATION_V2_UNIT_RUNTIME_INVALID');
  }
  const input = await atStage('unit_authority_load',
    () => withTransientTransactionRetry(() => repository.load(lease), signal));
  if (input.contract.component_plan.some(plan => !runtime.allowed_component_types.has(plan.type))) {
    throw new OrchestrationV2UnitServiceError('ORCHESTRATION_V2_UNIT_RUNTIME_INVALID');
  }
  // The assembly decides whether a unit carries an IDM brief; it must agree with the run pipeline.
  const idmUnit = input.contract.idm_unit_brief != null;
  if (runtime.pipeline !== undefined && (runtime.pipeline === 'idm-1') !== idmUnit) {
    throw new OrchestrationV2UnitServiceError('ORCHESTRATION_V2_UNIT_RUNTIME_INVALID');
  }
  // Only durable evidence of a previous provider dispatch can suppress a paid
  // call. dispatch_epoch also advances for a pre-dispatch DB failure, so using
  // the epoch here would incorrectly turn a safe retry into fallback content.
  const fallbackOnly = lease.provider_replay_required;
  let providerDispatchMarked = fallbackOnly;
  const beforeProviderDispatch = fallbackOnly ? undefined : async () => {
    if (providerDispatchMarked) {
      throw new OrchestrationV2UnitServiceError('ORCHESTRATION_V2_UNIT_RUNTIME_INVALID');
    }
    await atStage('provider_dispatch_fence',
      () => withTransientTransactionRetry(() => worker.markProviderDispatched(lease), signal));
    providerDispatchMarked = true;
  };
  const softDeadlineMs = idmUnit ? runtime.idm_unit_soft_deadline_ms ?? IDM_UNIT_SOFT_DEADLINE_DEFAULT_MS
    : runtime.unit_soft_deadline_ms ?? 45_000;
  const workflowBudgetMs = Math.min(480_000, lease.execution_budget_ms, softDeadlineMs);
  // Let Python cross its own deadline and serialize the validated fallback
  // before the transport aborts. Never exceed the durable task budget.
  const transportTimeoutMs = Math.min(lease.execution_budget_ms, workflowBudgetMs + 10_000);
  const response = await atStage('provider_request', () => client.generate({
    tenant_id: input.authority.tenant_id, kb_id: input.authority.kb_id,
    conversation_id: input.authority.conversation_id, target: 'lesson_author', model: lease.model,
    max_output_tokens: lease.max_output_tokens, embedding_model: runtime.embedding_model,
    embedding_dimensions: runtime.embedding_dimensions,
    system_prompt: 'Server-owned AI ID orchestration V2 unit contract.',
    user_message: 'Generate the admitted immutable unit from its exact source facts.', history: [],
    source_documents: input.authority.source_documents, course_context: null, locale: input.authority.locale,
    correlation_id: input.authority.correlation_id, contract_version: 2, unit_contract: input.contract,
    max_attempts: lease.provider_max_attempts as 1 | 2,
    remaining_workflow_budget_ms: workflowBudgetMs,
    fallback_only: fallbackOnly,
  }, { timeoutMs: transportTimeoutMs, signal, beforeProviderDispatch })
    // IDM: an exhausted provider key stops the run instead of a fallback unit (worker definitive path).
    .catch((error: unknown) => { throw idmUnit ? idmProviderFailure(error) : error; }));
  if (!providerDispatchMarked) {
    throw new OrchestrationV2UnitServiceError('ORCHESTRATION_V2_UNIT_RUNTIME_INVALID');
  }
  if ((fallbackOnly && response.usage_source !== 'deterministic_fallback')
    || (!fallbackOnly && response.usage_source === 'deterministic_fallback')) {
    throw new OrchestrationV2UnitServiceError('ORCHESTRATION_V2_UNIT_RUNTIME_INVALID');
  }
  let publication: ReturnType<typeof acceptOrchestrationV2GeneratedUnit>;
  try {
    publication = acceptOrchestrationV2GeneratedUnit({ contract: input.contract, response,
      normalizeProposal, allowed: runtime.allowed_component_types });
  } catch (error) {
    throwAtStage(error, 'unit_acceptance');
  }
  await atStage('unit_publication', () => withTransientTransactionRetry(
    () => repository.complete(lease, publication, response.usage ?? {},
      settleProvider, releaseUndispatched, response.usage_source, response.attempt_trace), signal));
  return 'generate_unit';
}
