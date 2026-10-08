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

/** The provider key cannot pay for more calls; no retry of any task of the run can succeed. */
export const ORCHESTRATION_V2_PROVIDER_QUOTA_EXHAUSTED = 'AI_PROVIDER_QUOTA_EXHAUSTED' as const;
/** The provider kept rate limiting after the AI service's bounded wait; a later attempt can succeed. */
export const ORCHESTRATION_V2_PROVIDER_RATE_LIMITED = 'AI_PROVIDER_RATE_LIMITED' as const;

/** Definitive provider failures that stop the whole run, units included (no isolated unit failure). */
export const ORCHESTRATION_V2_RUN_STOPPING_FAILURES: ReadonlySet<string> = Object.freeze(new Set([
  'AI_PROVIDER_AUTH_REJECTED', ORCHESTRATION_V2_PROVIDER_QUOTA_EXHAUSTED,
]));

/**
 * IDM runs only: an exhausted key reported by the AI service ends the run with
 * that code instead of the ambiguous-outcome path (pessimistic charge, replay,
 * deterministic fallback content). Legacy V2 runs keep their existing path, so
 * the service layer raises this error only for `idm-1` provider calls.
 */
export class OrchestrationV2ProviderStopError extends Error {
  readonly code = ORCHESTRATION_V2_PROVIDER_QUOTA_EXHAUSTED;

  constructor() {
    super(ORCHESTRATION_V2_PROVIDER_QUOTA_EXHAUSTED);
    this.name = 'OrchestrationV2ProviderStopError';
  }
}

/** Re-raise an IDM provider call's exhausted-key failure as a run stop; any other error is unchanged. */
export function idmProviderFailure(error: unknown): unknown {
  return error && typeof error === 'object'
    && (error as { code?: unknown }).code === ORCHESTRATION_V2_PROVIDER_QUOTA_EXHAUSTED
    ? new OrchestrationV2ProviderStopError() : error;
}

const RATE_LIMIT_REQUEUE_BASE_MS = 60_000;
const RATE_LIMIT_REQUEUE_MAX_MS = 120_000;

/** Stable 0..4999 ms jitter so a rate-limited batch does not wake up at the same instant. */
export function orchestrationV2StableJitterMs(seed: string): number {
  let hash = 0;
  for (const character of seed) hash = ((hash * 31) + character.charCodeAt(0)) >>> 0;
  return hash % 5_000;
}

/**
 * Delay before a rate-limited planning task (course skeleton, chapter blueprint) is
 * dispatched again: a per-minute window needs about a minute, the second retry
 * waits longer, both within the outbox's 120 s deferral bound. Units are not
 * delayed: after a dispatched attempt the replay fence only allows their
 * deterministic fallback, which makes no provider call.
 */
export function orchestrationV2RateLimitRequeueDelayMs(
  kind: string, failureCode: string, attemptCount: number, jitterMs: number,
): number {
  if (failureCode !== ORCHESTRATION_V2_PROVIDER_RATE_LIMITED
    || (kind !== 'course_skeleton' && kind !== 'chapter_blueprint')) return 0;
  const attempts = Number.isSafeInteger(attemptCount) && attemptCount > 0 ? attemptCount : 1;
  return Math.min(RATE_LIMIT_REQUEUE_MAX_MS, RATE_LIMIT_REQUEUE_BASE_MS * attempts + Math.max(0, jitterMs));
}
