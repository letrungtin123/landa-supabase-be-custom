import type { OrchestrationV2TaskKind } from './lesson-author-orchestration-v2.logic.js';

export interface OrchestrationV2WorkerLimits {
  global_concurrency_limit: number;
  provider_concurrency_limit: number;
  lease_seconds: number;
}

export const ORCHESTRATION_V2_PROVIDER_TASKS = Object.freeze(new Set<OrchestrationV2TaskKind>([
  'course_skeleton', 'chapter_blueprint', 'generate_unit',
]));

export class OrchestrationV2WorkerContractError extends Error {
  constructor(readonly code: 'ORCHESTRATION_V2_WORKER_CONFIG_INVALID' | 'ORCHESTRATION_V2_WORKER_PAYLOAD_INVALID') {
    super(code);
    this.name = 'OrchestrationV2WorkerContractError';
  }
}

const integer = (value: number, minimum: number, maximum: number) => Number.isSafeInteger(value)
  && value >= minimum && value <= maximum;

export function assertOrchestrationV2WorkerLimits(
  input: OrchestrationV2WorkerLimits,
): Readonly<OrchestrationV2WorkerLimits> {
  if (!input || !integer(input.global_concurrency_limit, 1, 4_096)
    || !integer(input.provider_concurrency_limit, 1, input.global_concurrency_limit)
    || !integer(input.lease_seconds, 5, 45)) {
    throw new OrchestrationV2WorkerContractError('ORCHESTRATION_V2_WORKER_CONFIG_INVALID');
  }
  return Object.freeze({ ...input });
}

export function isOrchestrationV2ProviderTask(kind: OrchestrationV2TaskKind): boolean {
  return ORCHESTRATION_V2_PROVIDER_TASKS.has(kind);
}

export function orchestrationV2ObservedUsage(value: unknown): Readonly<Record<string, number>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OrchestrationV2WorkerContractError('ORCHESTRATION_V2_WORKER_PAYLOAD_INVALID');
  }
  const allowed = new Set(['inputTokens', 'outputTokens', 'embeddingTokens', 'totalTokens']);
  const output: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!allowed.has(key) || !integer(raw as number, 0, Number.MAX_SAFE_INTEGER)) {
      throw new OrchestrationV2WorkerContractError('ORCHESTRATION_V2_WORKER_PAYLOAD_INVALID');
    }
    output[key] = raw as number;
  }
  return Object.freeze(output);
}
