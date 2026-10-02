import type { CourseComponentType } from '../tenants/tenant-course-components.constants.js';
import type { TenantAiRuntimeSettings } from './ai-engine.types.js';
import { getTenantAiRuntimeSettings } from './ai-settings.service.js';
import { getTenantAllowedCourseComponentTypeSet } from '../tenants/tenant-course-components.service.js';
import type { OrchestrationV2InventoryBudgets } from './lesson-author-orchestration-v2-inventory.logic.js';
import type { OrchestrationV2PlanningBudgets } from './lesson-author-orchestration-v2-planning.logic.js';
import { orchestrationV2Hash, type OrchestrationV2Budget } from './lesson-author-orchestration-v2.logic.js';
import type { OrchestrationV2TaskLease } from './lesson-author-orchestration-v2-worker.repository.js';

const provider = (input_tokens: number, max_output_tokens: number): Readonly<OrchestrationV2Budget> => Object.freeze({
  input_tokens,
  embedding_tokens: 0,
  max_output_tokens,
  max_provider_attempts: 2,
  execution_budget_ms: 600_000,
});

const LEGACY_LESSON_AUTHOR_MODEL_ALIASES = new Map<string, string>([
  ['gemini-3.5-flash', 'gemini-3.8-flash'],
  ['models/gemini-3.5-flash', 'gemini-3.8-flash'],
]);

/**
 * Resolve only the retired Lesson Author default at the V2 admission boundary.
 * Explicit non-legacy tenant choices and the normal chatbot model are not
 * changed. The resolved value is frozen into the run/lease runtime hash, so an
 * in-flight run can never switch models midway through execution.
 */
export function resolveOrchestrationV2LessonAuthorModel(model: string): string {
  const normalized = model.trim();
  return LEGACY_LESSON_AUTHOR_MODEL_ALIASES.get(normalized.toLowerCase()) ?? normalized;
}

/**
 * Versioned policy used by both future admission and the dedicated executor.
 * Values are immutable code policy, not mutable process-local guesses.
 */
export const ORCHESTRATION_V2_EXECUTION_POLICY = Object.freeze({
  policy_version: 1,
  source_snapshot_budget_ms: 600_000,
  planning: Object.freeze({
    skeleton: provider(1_800_000, 65_536),
    chapter: provider(200_000, 65_536),
    architecture_validation_budget_ms: 120_000,
    inventory_publish_budget_ms: 120_000,
  }) satisfies OrchestrationV2PlanningBudgets,
  inventory: Object.freeze({
    unit: provider(200_000, 65_536),
    chapter_validation_budget_ms: 120_000,
    finalization_budget_ms: 120_000,
  }) satisfies OrchestrationV2InventoryBudgets,
});

export interface OrchestrationV2ExecutionRuntime {
  settings: TenantAiRuntimeSettings;
  allowed_component_types: ReadonlySet<CourseComponentType>;
  runtime_config_hash: string;
  planning_budgets: OrchestrationV2PlanningBudgets;
  inventory_budgets: OrchestrationV2InventoryBudgets;
}

export class OrchestrationV2ExecutionConfigError extends Error {
  constructor(readonly code: 'ORCHESTRATION_V2_EXECUTION_RUNTIME_CHANGED') {
    super(code);
    this.name = 'OrchestrationV2ExecutionConfigError';
  }
}

export function orchestrationV2ExecutionRuntimeHash(input: {
  settings: Pick<TenantAiRuntimeSettings, 'activeEngine' | 'provider' | 'lessonAuthorModel'
    | 'embeddingModel' | 'embeddingDimensions' | 'transitionState'>;
  allowed_component_types: ReadonlySet<CourseComponentType>;
}): string {
  return orchestrationV2Hash({
    contract_version: 2,
    execution_policy: ORCHESTRATION_V2_EXECUTION_POLICY,
    ai: {
      active_engine: input.settings.activeEngine,
      provider: input.settings.provider,
      lesson_author_model: input.settings.lessonAuthorModel,
      embedding_model: input.settings.embeddingModel,
      embedding_dimensions: input.settings.embeddingDimensions,
      transition_state: input.settings.transitionState,
    },
    allowed_component_types: [...input.allowed_component_types].sort(),
  });
}

async function loadRuntimeAuthority(
  tenantId: string,
): Promise<Readonly<OrchestrationV2ExecutionRuntime>> {
  // These reads can run inside an AsyncLocalStorage-bound PostgreSQL
  // transaction. A pg client accepts one query at a time, so keep the two
  // authority reads sequential instead of issuing concurrent client.query()
  // calls on the same checked-out connection.
  const storedSettings = await getTenantAiRuntimeSettings(tenantId, { requireExisting: true });
  const allowed = await getTenantAllowedCourseComponentTypeSet(tenantId);
  const settings = Object.freeze({
    ...storedSettings,
    lessonAuthorModel: resolveOrchestrationV2LessonAuthorModel(storedSettings.lessonAuthorModel),
  });
  const runtimeHash = orchestrationV2ExecutionRuntimeHash({ settings, allowed_component_types: allowed });
  if (settings.activeEngine !== 'self_built_rag' || !settings.hasGoogleAiStudioKey || !allowed.size) {
    throw new OrchestrationV2ExecutionConfigError('ORCHESTRATION_V2_EXECUTION_RUNTIME_CHANGED');
  }
  return Object.freeze({ settings, allowed_component_types: allowed, runtime_config_hash: runtimeHash,
    planning_budgets: ORCHESTRATION_V2_EXECUTION_POLICY.planning,
    inventory_budgets: ORCHESTRATION_V2_EXECUTION_POLICY.inventory });
}

/** Server-owned runtime snapshot used before a V2 run is admitted. */
export async function loadOrchestrationV2AdmissionRuntime(
  tenantId: string,
): Promise<Readonly<OrchestrationV2ExecutionRuntime>> {
  return loadRuntimeAuthority(tenantId);
}

export async function loadOrchestrationV2ExecutionRuntime(
  lease: OrchestrationV2TaskLease,
): Promise<Readonly<OrchestrationV2ExecutionRuntime>> {
  const runtime = await loadRuntimeAuthority(lease.tenant_id);
  if (runtime.settings.lessonAuthorModel !== lease.model || runtime.runtime_config_hash !== lease.runtime_config_hash) {
    throw new OrchestrationV2ExecutionConfigError('ORCHESTRATION_V2_EXECUTION_RUNTIME_CHANGED');
  }
  return runtime;
}
