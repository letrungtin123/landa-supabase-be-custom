import type { OrchestrationV2DispatchEnvelope } from './lesson-author-orchestration-v2-dispatch.logic.js';
import { readOrchestrationV2DispatchEnvelope } from './lesson-author-orchestration-v2-dispatch.logic.js';
import {
  OrchestrationV2ProviderStopError,
  type OrchestrationV2WorkerLimits,
} from './lesson-author-orchestration-v2-worker.logic.js';
import type {
  OrchestrationV2TaskLease,
  createOrchestrationV2WorkerRepository,
} from './lesson-author-orchestration-v2-worker.repository.js';

type WorkerRepository = ReturnType<typeof createOrchestrationV2WorkerRepository>;
type ReserveProvider = Parameters<WorkerRepository['claimExact']>[2];
type ReleaseUndispatched = Parameters<WorkerRepository['recoverOne']>[0];
type HoldUnknown = Parameters<WorkerRepository['recoverOne']>[1];
type ReconcileUnknown = Parameters<WorkerRepository['recoverOne']>[2];
type ReleaseRejected = Parameters<WorkerRepository['failProviderRejected']>[2];

export type OrchestrationV2DeliveryDisposition =
  | 'claimed_succeeded'
  | 'claimed_failed'
  | 'duplicate'
  | 'deferred'
  | 'stale'
  | 'invalid';

export interface OrchestrationV2DeliveryResult {
  settlement: 'ack' | 'requeue';
  disposition: OrchestrationV2DeliveryDisposition | 'claim_unconfirmed';
  envelope?: Readonly<OrchestrationV2DispatchEnvelope>;
  error?: unknown;
}

function capacityJitterMs(envelope: Readonly<OrchestrationV2DispatchEnvelope>): number {
  // Stable per-message jitter spreads a saturated batch without making tests
  // or incident replay depend on process-local randomness.
  let hash = 0;
  for (const character of envelope.outbox_id) hash = ((hash * 31) + character.charCodeAt(0)) >>> 0;
  return hash % 5_000;
}

export interface OrchestrationV2WorkerRuntimeDependencies {
  repository: WorkerRepository;
  limits: OrchestrationV2WorkerLimits;
  reserveProvider: ReserveProvider;
  releaseUndispatched: ReleaseUndispatched;
  holdUnknown: HoldUnknown;
  reconcileUnknown?: ReconcileUnknown;
  releaseRejected: ReleaseRejected;
  execute(lease: OrchestrationV2TaskLease, signal: AbortSignal): Promise<unknown>;
  report(event: Record<string, unknown>): void;
}

function definitiveProviderRejection(error: unknown):
  'AI_PROVIDER_REQUEST_REJECTED' | 'AI_PROVIDER_AUTH_REJECTED' | 'AI_PROVIDER_QUOTA_EXHAUSTED' | null {
  if (!error || typeof error !== 'object') return null;
  // IDM provider calls only (the service layer raises it): an exhausted key stops the run.
  if (error instanceof OrchestrationV2ProviderStopError) return error.code;
  const code = (error as { code?: unknown }).code;
  return code === 'AI_PROVIDER_REQUEST_REJECTED' || code === 'AI_PROVIDER_AUTH_REJECTED' ? code : null;
}

function executionFailureCode(error: unknown): string {
  const candidate = error && typeof error === 'object'
    ? ((error as { code?: unknown; internal_failure_code?: unknown }).internal_failure_code
      ?? (error as { code?: unknown }).code)
    : null;
  if (candidate === '40P01') return 'ORCHESTRATION_V2_DB_DEADLOCK_RETRY_EXHAUSTED';
  if (candidate === '40001') return 'ORCHESTRATION_V2_DB_SERIALIZATION_RETRY_EXHAUSTED';
  if (typeof candidate === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(candidate)) return candidate;
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{0,99}$/.test(error.message)) return error.message;
  return 'ORCHESTRATION_V2_TASK_EXECUTION_FAILED';
}

function safeExecutionMetadata(error: unknown): Readonly<Record<string, string>> {
  if (!error || typeof error !== 'object') return {};
  const candidate = (error as { code?: unknown; orchestration_stage?: unknown;
    constraint?: unknown; table?: unknown }).code;
  const sqlstate = typeof candidate === 'string' && /^[0-9A-Z]{5}$/.test(candidate) ? candidate : null;
  const errorName = error instanceof Error && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(error.name)
    ? error.name : null;
  const stage = typeof (error as { orchestration_stage?: unknown }).orchestration_stage === 'string'
    && /^[a-z][a-z0-9_]{0,79}$/.test(String((error as { orchestration_stage: string }).orchestration_stage))
    ? String((error as { orchestration_stage: string }).orchestration_stage) : null;
  const constraint = typeof (error as { constraint?: unknown }).constraint === 'string'
    && /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(String((error as { constraint: string }).constraint))
    ? String((error as { constraint: string }).constraint) : null;
  const table = typeof (error as { table?: unknown }).table === 'string'
    && /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(String((error as { table: string }).table))
    ? String((error as { table: string }).table) : null;
  const databaseMessage = sqlstate && error instanceof Error
    && /^[A-Za-z0-9 _./:()'=-]{1,180}$/.test(error.message) ? error.message : null;
  return Object.freeze({ ...(sqlstate ? { sqlstate } : {}), ...(errorName ? { error_name: errorName } : {}),
    ...(stage ? { execution_stage: stage } : {}), ...(constraint ? { db_constraint: constraint } : {}),
    ...(table ? { db_table: table } : {}), ...(databaseMessage ? { db_message: databaseMessage } : {}) });
}

function reportSafely(
  report: OrchestrationV2WorkerRuntimeDependencies['report'],
  event: Record<string, unknown>,
): void {
  try {
    report(event);
  } catch {
    // Telemetry is deliberately non-authoritative. A logger/exporter failure
    // must never change a broker settlement or task lifecycle decision.
  }
}

function parse(raw: Buffer | string): Readonly<OrchestrationV2DispatchEnvelope> {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw;
  if (Buffer.byteLength(text, 'utf8') > 4_096) {
    throw new Error('ORCHESTRATION_V2_DELIVERY_TOO_LARGE');
  }
  return readOrchestrationV2DispatchEnvelope(JSON.parse(text));
}

function runLeaseHeartbeat(
  lease: OrchestrationV2TaskLease,
  repository: WorkerRepository,
  limits: OrchestrationV2WorkerLimits,
  controller: AbortController,
  report: OrchestrationV2WorkerRuntimeDependencies['report'],
): () => Promise<void> {
  const intervalMs = Math.max(1_000, Math.floor(limits.lease_seconds * 1_000 / 3));
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  const tick = () => {
    if (stopped || inFlight) return;
    inFlight = repository.renew(lease, limits.lease_seconds).then((renewed) => {
      if (!renewed && !controller.signal.aborted) {
        reportSafely(report, { event: 'worker_lease_lost', run_id: lease.run_id, task_id: lease.task_id });
        controller.abort(new Error('ORCHESTRATION_V2_TASK_LEASE_LOST'));
      }
    }).catch((error) => {
      reportSafely(report, { event: 'worker_heartbeat_failed', run_id: lease.run_id, task_id: lease.task_id,
        error: error instanceof Error ? error.message : String(error) });
      if (!controller.signal.aborted) controller.abort(error);
    }).finally(() => { inFlight = null; });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await inFlight;
  };
}

async function wakeCapacitySafely(
  deps: Pick<OrchestrationV2WorkerRuntimeDependencies, 'repository' | 'limits' | 'report'>,
  source: 'task_completion' | 'recovery_sweep',
): Promise<boolean> {
  try {
    const awakened = await deps.repository.wakeOneCapacityDeferred(deps.limits);
    if (!awakened) return false;
    reportSafely(deps.report, { event: 'worker_capacity_deferral_awakened', source,
      outbox_id: awakened.outbox_id, run_id: awakened.run_id, task_id: awakened.task_id,
      tenant_id: awakened.tenant_id, workspace_id: awakened.workspace_id, task_kind: awakened.task_kind });
    return true;
  } catch (error) {
    // Capacity wake-up only removes idle delay. It is never allowed to change
    // the authoritative success/failure decision of the task that freed a slot.
    reportSafely(deps.report, { event: 'worker_capacity_wake_failed', source,
      error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

async function executeClaimed(
  lease: OrchestrationV2TaskLease,
  deps: OrchestrationV2WorkerRuntimeDependencies,
  shutdownSignal?: AbortSignal,
): Promise<'claimed_succeeded' | 'claimed_failed'> {
  const controller = new AbortController();
  const abortFromShutdown = () => controller.abort(shutdownSignal?.reason ?? new Error('ORCHESTRATION_V2_SHUTDOWN'));
  if (shutdownSignal?.aborted) abortFromShutdown();
  else shutdownSignal?.addEventListener('abort', abortFromShutdown, { once: true });
  const deadline = setTimeout(() => controller.abort(new Error('ORCHESTRATION_V2_TASK_DEADLINE_EXCEEDED')),
    lease.execution_budget_ms);
  deadline.unref();
  const stopHeartbeat = runLeaseHeartbeat(lease, deps.repository, deps.limits, controller, deps.report);
  let disposition: 'claimed_succeeded' | 'claimed_failed';
  try {
    await deps.execute(lease, controller.signal);
    reportSafely(deps.report, { event: 'worker_task_succeeded', run_id: lease.run_id, task_id: lease.task_id,
      task_kind: lease.kind });
    disposition = 'claimed_succeeded';
  } catch (error) {
    const rejection = definitiveProviderRejection(error);
    if (rejection) {
      try {
        await deps.repository.failProviderRejected(lease, rejection, deps.releaseRejected);
        reportSafely(deps.report, { event: 'worker_provider_rejection_finalized', run_id: lease.run_id,
          task_id: lease.task_id, task_kind: lease.kind, failure_code: rejection });
      } catch (finalizationError) {
        reportSafely(deps.report, { event: 'worker_provider_rejection_finalization_failed', run_id: lease.run_id,
          task_id: lease.task_id, task_kind: lease.kind,
          error: finalizationError instanceof Error ? finalizationError.message : String(finalizationError) });
      }
    } else {
      const failureCode = executionFailureCode(error);
      try {
        const recovery = await deps.repository.recoverClaimFailure(
          lease, failureCode, deps.releaseUndispatched, deps.holdUnknown, deps.reconcileUnknown,
        );
        reportSafely(deps.report, { event: 'worker_claim_failure_finalized', run_id: lease.run_id,
          workspace_id: lease.workspace_id, task_id: lease.task_id, task_kind: lease.kind,
          chapter_key: lease.chapter_key, dispatch_epoch: lease.dispatch_epoch,
          failure_code: failureCode, recovery, ...safeExecutionMetadata(error) });
      } catch (finalizationError) {
        reportSafely(deps.report, { event: 'worker_claim_failure_finalization_failed', run_id: lease.run_id,
          workspace_id: lease.workspace_id, task_id: lease.task_id, task_kind: lease.kind,
          chapter_key: lease.chapter_key, dispatch_epoch: lease.dispatch_epoch,
          failure_code: failureCode,
          error: finalizationError instanceof Error ? finalizationError.message : String(finalizationError) });
      }
    }
    // The DB lease/recovery state is authoritative. Never broker-retry a
    // claimed task: a paid call may already have crossed dispatch_started_at.
    reportSafely(deps.report, { event: 'worker_task_failed', run_id: lease.run_id,
      workspace_id: lease.workspace_id, task_id: lease.task_id, task_kind: lease.kind,
      chapter_key: lease.chapter_key, dispatch_epoch: lease.dispatch_epoch,
      failure_code: executionFailureCode(error), ...safeExecutionMetadata(error) });
    disposition = 'claimed_failed';
  } finally {
    clearTimeout(deadline);
    shutdownSignal?.removeEventListener('abort', abortFromShutdown);
    await stopHeartbeat();
  }
  await wakeCapacitySafely(deps, 'task_completion');
  return disposition;
}

/**
 * Resolve one broker delivery against durable DB authority. An unconfirmed
 * claim or a capacity deferral requests delayed broker requeue; every
 * post-claim failure is left to the fenced lease recovery path.
 */
export async function handleOrchestrationV2Delivery(
  raw: Buffer | string,
  deps: OrchestrationV2WorkerRuntimeDependencies,
  shutdownSignal?: AbortSignal,
): Promise<Readonly<OrchestrationV2DeliveryResult>> {
  let envelope: Readonly<OrchestrationV2DispatchEnvelope>;
  try {
    envelope = parse(raw);
  } catch (error) {
    reportSafely(deps.report, { event: 'worker_delivery_invalid',
      error: error instanceof Error ? error.message : String(error) });
    return Object.freeze({ settlement: 'ack', disposition: 'invalid', error });
  }
  let claim: Awaited<ReturnType<WorkerRepository['claimExact']>>;
  try {
    claim = await deps.repository.claimExact(envelope, deps.limits, deps.reserveProvider);
  } catch (error) {
    reportSafely(deps.report, { event: 'worker_claim_unconfirmed', outbox_id: envelope.outbox_id,
      run_id: envelope.run_id, task_id: envelope.task_id,
      error: error instanceof Error ? error.message : String(error) });
    return Object.freeze({ settlement: 'requeue', disposition: 'claim_unconfirmed', envelope, error });
  }
  if (claim.disposition !== 'claimed') {
    reportSafely(deps.report, { event: 'worker_delivery_resolved', outbox_id: envelope.outbox_id,
      run_id: envelope.run_id, task_id: envelope.task_id, disposition: claim.disposition,
      ...(claim.disposition === 'deferred' ? { defer_reason: claim.reason } : {}) });
    if (claim.disposition === 'deferred') {
      if (claim.reason === 'publication_race') {
        return Object.freeze({ settlement: 'requeue', disposition: 'deferred', envelope });
      }
      const jitterMs = capacityJitterMs(envelope);
      try {
        const deferred = await deps.repository.deferPublished(envelope, jitterMs);
        if (!deferred) {
          const error = new Error('ORCHESTRATION_V2_DEFER_UNCONFIRMED');
          return Object.freeze({ settlement: 'requeue', disposition: 'claim_unconfirmed', envelope, error });
        }
        reportSafely(deps.report, { event: 'worker_delivery_deferred_durably', outbox_id: envelope.outbox_id,
          run_id: envelope.run_id, task_id: envelope.task_id, delay_ms: deferred.delay_ms,
          deferral_count: deferred.deferral_count, defer_reason: claim.reason });
        return Object.freeze({ settlement: 'ack', disposition: 'deferred', envelope });
      } catch (error) {
        reportSafely(deps.report, { event: 'worker_delivery_defer_unconfirmed', outbox_id: envelope.outbox_id,
          run_id: envelope.run_id, task_id: envelope.task_id,
          error: error instanceof Error ? error.message : String(error) });
        return Object.freeze({ settlement: 'requeue', disposition: 'claim_unconfirmed', envelope, error });
      }
    }
    return Object.freeze({ settlement: 'ack', disposition: claim.disposition, envelope });
  }
  const disposition = await executeClaimed(claim.lease, deps, shutdownSignal);
  return Object.freeze({ settlement: 'ack', disposition, envelope });
}

/** One bounded recovery tick. No polling or sleeping occurs in this function. */
export async function runOrchestrationV2WorkerRecoveryCycle(
  deps: Pick<OrchestrationV2WorkerRuntimeDependencies,
    'repository' | 'limits' | 'releaseUndispatched' | 'holdUnknown' | 'report'>
    & { reconcileUnknown?: ReconcileUnknown },
  batchSize: number,
): Promise<Readonly<Record<'requeued' | 'failed' | 'outcome_unknown' | 'reconciled' | 'capacity_woken', number>>> {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 500) {
    throw new Error('ORCHESTRATION_V2_WORKER_RECOVERY_CONFIG_INVALID');
  }
  const result = { requeued: 0, failed: 0, outcome_unknown: 0, reconciled: 0, capacity_woken: 0 };
  for (let index = 0; index < batchSize; index += 1) {
    const state = await deps.repository.recoverOne(
      deps.releaseUndispatched, deps.holdUnknown, deps.reconcileUnknown,
    );
    if (!state) break;
    result[state] += 1;
  }
  if (await wakeCapacitySafely(deps, 'recovery_sweep')) {
    result.capacity_woken = 1;
  }
  return Object.freeze(result);
}
