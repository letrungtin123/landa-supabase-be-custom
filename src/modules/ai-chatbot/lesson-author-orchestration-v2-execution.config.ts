import type { CourseComponentType } from '../tenants/tenant-course-components.constants.js';
import type { TenantAiRuntimeSettings } from './ai-engine.types.js';
import { getTenantAiRuntimeSettings } from './ai-settings.service.js';
import { getTenantAllowedCourseComponentTypeSet } from '../tenants/tenant-course-components.service.js';
import type { OrchestrationV2InventoryBudgets } from './lesson-author-orchestration-v2-inventory.logic.js';
import type { OrchestrationV2PlanningBudgets } from './lesson-author-orchestration-v2-planning.logic.js';
import { orchestrationV2Hash, type OrchestrationV2Budget } from './lesson-author-orchestration-v2.logic.js';
import type { OrchestrationV2TaskLease } from './lesson-author-orchestration-v2-worker.repository.js';
import {
  IDM_LEGACY_PIPELINE_VERSION,
  IDM_PIPELINE_VERSION,
  type OrchestrationV2RunPipeline,
} from './lesson-author-idm.contract.js';

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

/**
 * Separate immutable policy for runs admitted to the IDM pipeline (spec §5.4,
 * §5.5). Its hash is distinct from the legacy hash, so the stored
 * `runtime_config_hash` of a run identifies its pipeline without a new column.
 */
export const ORCHESTRATION_V2_IDM_EXECUTION_POLICY = Object.freeze({
  policy_version: 1,
  authoring_pipeline: IDM_PIPELINE_VERSION,
  source_snapshot_budget_ms: 600_000,
  planning: Object.freeze({
    skeleton: provider(1_800_000, 65_536),
    chapter: provider(400_000, 65_536),
    architecture_validation_budget_ms: 120_000,
    inventory_publish_budget_ms: 120_000,
  }) satisfies OrchestrationV2PlanningBudgets,
  inventory: Object.freeze({
    unit: provider(200_000, 65_536),
    chapter_validation_budget_ms: 120_000,
    finalization_budget_ms: 120_000,
  }) satisfies OrchestrationV2InventoryBudgets,
});

export type { OrchestrationV2RunPipeline };

export interface OrchestrationV2ExecutionRuntime {
  settings: TenantAiRuntimeSettings;
  allowed_component_types: ReadonlySet<CourseComponentType>;
  runtime_config_hash: string;
  planning_budgets: OrchestrationV2PlanningBudgets;
  inventory_budgets: OrchestrationV2InventoryBudgets;
  pipeline: OrchestrationV2RunPipeline;
}

export class OrchestrationV2ExecutionConfigError extends Error {
  constructor(readonly code: 'ORCHESTRATION_V2_EXECUTION_RUNTIME_CHANGED') {
    super(code);
    this.name = 'OrchestrationV2ExecutionConfigError';
  }
}

type RuntimeHashInput = {
  settings: Pick<TenantAiRuntimeSettings, 'activeEngine' | 'provider' | 'lessonAuthorModel'
    | 'embeddingModel' | 'embeddingDimensions' | 'transitionState'>;
  allowed_component_types: ReadonlySet<CourseComponentType>;
};

function runtimeHash(
  policy: typeof ORCHESTRATION_V2_EXECUTION_POLICY | typeof ORCHESTRATION_V2_IDM_EXECUTION_POLICY,
  input: RuntimeHashInput,
): string {
  return orchestrationV2Hash({
    contract_version: 2,
    execution_policy: policy,
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

export function orchestrationV2ExecutionRuntimeHash(input: RuntimeHashInput): string {
  return runtimeHash(ORCHESTRATION_V2_EXECUTION_POLICY, input);
}

/** Runtime hash of an IDM run: same AI settings and allowed types, IDM policy. */
export function orchestrationV2IdmExecutionRuntimeHash(input: RuntimeHashInput): string {
  return runtimeHash(ORCHESTRATION_V2_IDM_EXECUTION_POLICY, input);
}

/**
 * Identify the pipeline of a durable run from its stored runtime hash and the
 * current settings: legacy match → legacy, IDM match → IDM, otherwise the run's
 * authority changed and execution stays fail-closed. The admission flag is
 * deliberately not consulted, so disabling IDM never strands a running IDM run.
 */
export function resolveOrchestrationV2RunPipeline(
  storedHash: string,
  input: RuntimeHashInput,
): OrchestrationV2RunPipeline {
  if (storedHash === orchestrationV2ExecutionRuntimeHash(input)) return IDM_LEGACY_PIPELINE_VERSION;
  if (storedHash === orchestrationV2IdmExecutionRuntimeHash(input)) return IDM_PIPELINE_VERSION;
  throw new OrchestrationV2ExecutionConfigError('ORCHESTRATION_V2_EXECUTION_RUNTIME_CHANGED');
}

/** Admission-time IDM rollout switch (`LESSON_AUTHOR_IDM_PIPELINE_*`). */
export interface OrchestrationV2IdmAdmissionPolicy {
  enabled: boolean;
  /** Tenant UUIDs; empty means every tenant once enabled. */
  tenant_allowlist: readonly string[];
}

/**
 * Startup warning for operators: an enabled flag with an empty allow-list
 * admits EVERY tenant to IDM (intended by the spec, but easy to do by mistake).
 */
export function orchestrationV2IdmAdmissionWarning(policy: OrchestrationV2IdmAdmissionPolicy): string | null {
  return policy.enabled && policy.tenant_allowlist.length === 0
    ? '[LessonAuthorOrchestrationV2] LESSON_AUTHOR_IDM_PIPELINE_ENABLED=true with an empty '
      + 'LESSON_AUTHOR_IDM_PIPELINE_TENANT_ALLOWLIST: every tenant is admitted to the IDM pipeline.'
    : null;
}

export function selectOrchestrationV2AdmissionPipeline(
  tenantId: string,
  policy?: OrchestrationV2IdmAdmissionPolicy,
): OrchestrationV2RunPipeline {
  if (!policy?.enabled) return IDM_LEGACY_PIPELINE_VERSION;
  if (!policy.tenant_allowlist.length) return IDM_PIPELINE_VERSION;
  const tenant = tenantId.trim().toLowerCase();
  return policy.tenant_allowlist.some(candidate => candidate.trim().toLowerCase() === tenant)
    ? IDM_PIPELINE_VERSION : IDM_LEGACY_PIPELINE_VERSION;
}

/** Durable authority readers; injectable so the selection logic is testable without PostgreSQL. */
export interface OrchestrationV2RuntimeAuthorityReaders {
  settings(tenantId: string): Promise<TenantAiRuntimeSettings>;
  allowedComponentTypes(tenantId: string): Promise<ReadonlySet<CourseComponentType>>;
}

const DEFAULT_AUTHORITY_READERS: OrchestrationV2RuntimeAuthorityReaders = {
  settings: tenantId => getTenantAiRuntimeSettings(tenantId, { requireExisting: true }),
  allowedComponentTypes: tenantId => getTenantAllowedCourseComponentTypeSet(tenantId),
};

async function loadRuntimeInputs(
  tenantId: string,
  readers: OrchestrationV2RuntimeAuthorityReaders,
): Promise<{ settings: Readonly<TenantAiRuntimeSettings>; allowed: ReadonlySet<CourseComponentType> }> {
  // These reads can run inside an AsyncLocalStorage-bound PostgreSQL
  // transaction. A pg client accepts one query at a time, so keep the two
  // authority reads sequential instead of issuing concurrent client.query()
  // calls on the same checked-out connection.
  const storedSettings = await readers.settings(tenantId);
  const allowed = await readers.allowedComponentTypes(tenantId);
  const settings = Object.freeze({
    ...storedSettings,
    lessonAuthorModel: resolveOrchestrationV2LessonAuthorModel(storedSettings.lessonAuthorModel),
  });
  if (settings.activeEngine !== 'self_built_rag' || !settings.hasGoogleAiStudioKey || !allowed.size) {
    throw new OrchestrationV2ExecutionConfigError('ORCHESTRATION_V2_EXECUTION_RUNTIME_CHANGED');
  }
  return { settings, allowed };
}

function runtimeFor(
  pipeline: OrchestrationV2RunPipeline,
  settings: Readonly<TenantAiRuntimeSettings>,
  allowed: ReadonlySet<CourseComponentType>,
): Readonly<OrchestrationV2ExecutionRuntime> {
  const policy = pipeline === IDM_PIPELINE_VERSION ? ORCHESTRATION_V2_IDM_EXECUTION_POLICY
    : ORCHESTRATION_V2_EXECUTION_POLICY;
  return Object.freeze({ settings, allowed_component_types: allowed,
    runtime_config_hash: runtimeHash(policy, { settings, allowed_component_types: allowed }),
    planning_budgets: policy.planning, inventory_budgets: policy.inventory, pipeline });
}

/** Server-owned runtime snapshot used before a V2 run is admitted. */
export async function loadOrchestrationV2AdmissionRuntime(
  tenantId: string,
  idm?: OrchestrationV2IdmAdmissionPolicy,
  readers: OrchestrationV2RuntimeAuthorityReaders = DEFAULT_AUTHORITY_READERS,
): Promise<Readonly<OrchestrationV2ExecutionRuntime>> {
  const { settings, allowed } = await loadRuntimeInputs(tenantId, readers);
  return runtimeFor(selectOrchestrationV2AdmissionPipeline(tenantId, idm), settings, allowed);
}

export async function loadOrchestrationV2ExecutionRuntime(
  lease: OrchestrationV2TaskLease,
  readers: OrchestrationV2RuntimeAuthorityReaders = DEFAULT_AUTHORITY_READERS,
): Promise<Readonly<OrchestrationV2ExecutionRuntime>> {
  const { settings, allowed } = await loadRuntimeInputs(lease.tenant_id, readers);
  if (settings.lessonAuthorModel !== lease.model) {
    throw new OrchestrationV2ExecutionConfigError('ORCHESTRATION_V2_EXECUTION_RUNTIME_CHANGED');
  }
  const pipeline = resolveOrchestrationV2RunPipeline(lease.runtime_config_hash,
    { settings, allowed_component_types: allowed });
  return runtimeFor(pipeline, settings, allowed);
}
