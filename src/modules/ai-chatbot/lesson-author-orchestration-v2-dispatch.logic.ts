export type OrchestrationV2RuntimeRole = 'disabled' | 'dispatcher' | 'worker';

export interface OrchestrationV2RuntimeIsolationInput {
  enabled: boolean;
  role: OrchestrationV2RuntimeRole;
  lane_count: number;
  lane_index: number;
}

export interface OrchestrationV2DispatchIdentity {
  outbox_id: string;
  run_id: string;
  task_id: string;
  dispatch_epoch: number;
  routing_shard: number;
}

export interface OrchestrationV2DispatchEnvelope {
  contract_version: 2;
  outbox_id: string;
  run_id: string;
  task_id: string;
  dispatch_epoch: number;
  routing_shard: number;
}

export class OrchestrationV2DispatchContractError extends Error {
  constructor(readonly code:
    | 'ORCHESTRATION_V2_RUNTIME_ROLE_INVALID'
    | 'ORCHESTRATION_V2_DISPATCH_IDENTITY_INVALID') {
    super(code);
    this.name = 'OrchestrationV2DispatchContractError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const integer = (value: number, min: number, max: number) => Number.isSafeInteger(value) && value >= min && value <= max;

/** A process owns exactly one role. API replicas remain disabled by default. */
export function assertOrchestrationV2RuntimeIsolation(
  input: OrchestrationV2RuntimeIsolationInput,
): Readonly<OrchestrationV2RuntimeIsolationInput> {
  if (!input || !['disabled', 'dispatcher', 'worker'].includes(input.role)
    || !integer(input.lane_count, 1, 4_096) || !integer(input.lane_index, 0, input.lane_count - 1)
    || (input.enabled && input.role === 'disabled') || (!input.enabled && input.role !== 'disabled')) {
    throw new OrchestrationV2DispatchContractError('ORCHESTRATION_V2_RUNTIME_ROLE_INVALID');
  }
  return Object.freeze({ ...input });
}

/** Queue payload is task identity only. DB rows remain the execution authority. */
export function orchestrationV2DispatchEnvelope(
  input: OrchestrationV2DispatchIdentity,
): Readonly<OrchestrationV2DispatchEnvelope> {
  if (!input || !UUID.test(input.outbox_id) || !UUID.test(input.run_id) || !UUID.test(input.task_id)
    || !integer(input.dispatch_epoch, 0, 100) || !integer(input.routing_shard, 0, 4_095)) {
    throw new OrchestrationV2DispatchContractError('ORCHESTRATION_V2_DISPATCH_IDENTITY_INVALID');
  }
  // Do not spread a lease row here. Lease tokens, attempt counters and any
  // future database-only fields must never become broker payload fields.
  return Object.freeze({
    contract_version: 2,
    outbox_id: input.outbox_id,
    run_id: input.run_id,
    task_id: input.task_id,
    dispatch_epoch: input.dispatch_epoch,
    routing_shard: input.routing_shard,
  });
}

/**
 * Parse an untrusted broker body without permitting database-only or provider
 * fields to hitchhike on the delivery contract.
 */
export function readOrchestrationV2DispatchEnvelope(value: unknown): Readonly<OrchestrationV2DispatchEnvelope> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OrchestrationV2DispatchContractError('ORCHESTRATION_V2_DISPATCH_IDENTITY_INVALID');
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set(['contract_version', 'outbox_id', 'run_id', 'task_id', 'dispatch_epoch', 'routing_shard']);
  if (input.contract_version !== 2 || Object.keys(input).some(key => !allowed.has(key))
    || Object.keys(input).length !== allowed.size) {
    throw new OrchestrationV2DispatchContractError('ORCHESTRATION_V2_DISPATCH_IDENTITY_INVALID');
  }
  return orchestrationV2DispatchEnvelope({
    outbox_id: input.outbox_id as string,
    run_id: input.run_id as string,
    task_id: input.task_id as string,
    dispatch_epoch: input.dispatch_epoch as number,
    routing_shard: input.routing_shard as number,
  });
}

export function orchestrationV2RetryDelayMs(
  attemptCount: number, baseDelayMs: number, maxDelayMs: number,
): number {
  if (!integer(attemptCount, 1, 100) || !integer(baseDelayMs, 1, 3_600_000)
    || !integer(maxDelayMs, baseDelayMs, 86_400_000)) {
    throw new OrchestrationV2DispatchContractError('ORCHESTRATION_V2_DISPATCH_IDENTITY_INVALID');
  }
  return Math.min(maxDelayMs, baseDelayMs * 2 ** Math.min(attemptCount - 1, 20));
}
