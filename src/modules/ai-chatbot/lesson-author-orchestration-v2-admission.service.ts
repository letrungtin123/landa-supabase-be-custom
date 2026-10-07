import type { AuthUser } from '../../types/express.js';
import type {
  OrchestrationV2AdmissionReceipt,
  OrchestrationV2AdmissionTarget,
  createOrchestrationV2AdmissionRepository,
} from './lesson-author-orchestration-v2-admission.repository.js';
import {
  ORCHESTRATION_V2_EXECUTION_POLICY,
  ORCHESTRATION_V2_IDM_EXECUTION_POLICY,
  type OrchestrationV2ExecutionRuntime,
} from './lesson-author-orchestration-v2-execution.config.js';

type AdmissionRepository = Pick<ReturnType<typeof createOrchestrationV2AdmissionRepository>, 'admit'>;

export interface OrchestrationV2AdmissionServiceConfig {
  tenant_concurrency_limit: number;
  workspace_concurrency_limit: number;
  routing_shard_count: number;
}

export class OrchestrationV2AdmissionServiceError extends Error {
  constructor(readonly code: 'ORCHESTRATION_V2_ADMISSION_CONFIG_INVALID') {
    super(code);
    this.name = 'OrchestrationV2AdmissionServiceError';
  }
}

type Dependencies = {
  config: OrchestrationV2AdmissionServiceConfig;
  verifySchema(): Promise<unknown>;
  loadRuntime(tenantId: string): Promise<Readonly<OrchestrationV2ExecutionRuntime>>;
  createRepository(user: AuthUser): AdmissionRepository;
};

const integer = (value: number, minimum: number, maximum: number) => Number.isSafeInteger(value)
  && value >= minimum && value <= maximum;

/**
 * Compose one server-authorized V2 admission. Schema verification is cached
 * only after success for the lifetime of this API process; workers still run
 * their own independent startup verification.
 */
export function createOrchestrationV2AdmissionService(deps: Dependencies) {
  const config = deps.config;
  const configValid = integer(config.tenant_concurrency_limit, 1, 1_024)
    && integer(config.workspace_concurrency_limit, 1, 128)
    && config.workspace_concurrency_limit <= config.tenant_concurrency_limit
    && integer(config.routing_shard_count, 1, 4_096);
  let schemaReady: Promise<void> | null = null;
  const ensureSchema = (): Promise<void> => {
    if (!schemaReady) {
      const candidate = deps.verifySchema().then(() => undefined);
      schemaReady = candidate;
      void candidate.catch(() => {
        if (schemaReady === candidate) schemaReady = null;
      });
    }
    return schemaReady;
  };

  return async function admit(
    user: AuthUser,
    target: OrchestrationV2AdmissionTarget,
  ): Promise<OrchestrationV2AdmissionReceipt> {
    if (!configValid) {
      throw new OrchestrationV2AdmissionServiceError('ORCHESTRATION_V2_ADMISSION_CONFIG_INVALID');
    }
    const [, runtime] = await Promise.all([ensureSchema(), deps.loadRuntime(target.tenantId)]);
    const repository = deps.createRepository(user);
    return repository.admit(target, {
      runtime_config_hash: runtime.runtime_config_hash,
      model: runtime.settings.lessonAuthorModel,
      // The runtime hash selects the pipeline (legacy or IDM); the matching policy owns the source budget.
      source_snapshot_budget_ms: runtime.pipeline === 'idm-1'
        ? ORCHESTRATION_V2_IDM_EXECUTION_POLICY.source_snapshot_budget_ms
        : ORCHESTRATION_V2_EXECUTION_POLICY.source_snapshot_budget_ms,
      tenant_concurrency_limit: config.tenant_concurrency_limit,
      workspace_concurrency_limit: config.workspace_concurrency_limit,
      routing_shard_count: config.routing_shard_count,
    });
  };
}
