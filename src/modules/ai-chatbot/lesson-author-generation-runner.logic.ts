import {
  GENERATION_JOB_HEARTBEAT_MS, GenerationJobError, generationDispatchBudgetMs,
  type GenerationJobLease, type GenerationJobRow,
} from './lesson-author-generation-job.logic.js';
import type { GenerationJobFailure } from './lesson-author-generation-job.repository.js';

export interface GenerationRunDependencies<Prepared, Result> {
  prepare(job: GenerationJobRow): Promise<Prepared>;
  /** Must commit the dispatch marker; never makes a provider call. */
  authorizeDispatch(lease: GenerationJobLease, prepared: Prepared): Promise<GenerationJobRow>;
  generate(prepared: Prepared, job: GenerationJobRow, signal: AbortSignal, budgetMs: number): Promise<Result>;
  /** Full Node validation + result/message/accounting + terminal CAS in one transaction. */
  complete(lease: GenerationJobLease, prepared: Prepared, result: Result): Promise<void>;
  fail(lease: GenerationJobLease, failure: GenerationJobFailure, error: unknown, result?: Result, prepared?: Prepared): Promise<void>;
  renew(lease: GenerationJobLease): Promise<boolean>;
  classify(error: unknown): GenerationJobFailure;
  report(event: Record<string, unknown>): void;
  now?: () => number;
  heartbeatMs?: number;
}

/** One delivery, one dispatch. Restart recovery belongs to the fenced repository. */
export async function runGenerationJob<Prepared, Result>(
  job: GenerationJobRow, deps: GenerationRunDependencies<Prepared, Result>, shutdown?: AbortSignal,
): Promise<void> {
  if (!job.lease_token || job.status !== 'running') throw new GenerationJobError('GENERATION_LEASE_LOST');
  const lease = { jobId: job.id, tenantId: job.tenant_id, leaseToken: job.lease_token };
  const now = deps.now ?? Date.now;
  const started = now();
  const controller = new AbortController();
  let stage = 'generation_prepare';
  let renewing = false;
  let leaseLost = false;
  let receivedResult: Result | undefined;
  let preparedContext: Prepared | undefined;
  const report = (event: string, extra: Record<string, unknown> = {}) => deps.report({
    event, correlation_id: job.correlation_id, job_id: job.id, conversation_id: job.conversation_id,
    failure_stage: stage, duration_ms: now() - started, ...extra,
  });
  const abort = (code: 'GENERATION_LEASE_LOST' | 'GENERATION_WORKFLOW_TIMEOUT') => {
    if (!controller.signal.aborted) controller.abort(new GenerationJobError(code));
  };
  const onShutdown = () => { leaseLost = true; abort('GENERATION_LEASE_LOST'); };
  shutdown?.addEventListener('abort', onShutdown, { once: true });
  if (shutdown?.aborted) onShutdown();
  const heartbeat = setInterval(() => {
    if (renewing || controller.signal.aborted) return;
    renewing = true;
    void deps.renew(lease).then(live => {
      if (!live) { leaseLost = true; abort('GENERATION_LEASE_LOST'); }
    }, () => { leaseLost = true; abort('GENERATION_LEASE_LOST'); }).finally(() => { renewing = false; });
  }, deps.heartbeatMs ?? GENERATION_JOB_HEARTBEAT_MS);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const interrupted = new Promise<never>((_, reject) => {
    abortListener = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', abortListener, { once: true });
    if (controller.signal.aborted) abortListener();
  });
  // A pre-aborted shutdown/invalid deadline must not leave an unhandled rejection.
  void interrupted.catch(() => undefined);
  // Always race awaited preparation/generation with the SAME total deadline.
  // Cancellation of our HTTP wait does not prove Python/Gemini stopped work.
  try {
    const budget = generationDispatchBudgetMs(job.deadline_at, now());
    deadline = setTimeout(() => abort('GENERATION_WORKFLOW_TIMEOUT'), budget);
    report('generation_worker_started');
    const prepared = await Promise.race([deps.prepare(job), interrupted]);
    preparedContext = prepared;
    controller.signal.throwIfAborted();
    stage = 'generation_dispatch';
    const dispatched = await Promise.race([deps.authorizeDispatch(lease, prepared), interrupted]);
    controller.signal.throwIfAborted();
    if (!dispatched.dispatch_started_at) throw new GenerationJobError('GENERATION_JOB_CONTRACT_INVALID');
    report('generation_dispatch_committed');
    const result = await Promise.race([
      deps.generate(prepared, dispatched, controller.signal, generationDispatchBudgetMs(dispatched.deadline_at, now())),
      interrupted,
    ]);
    receivedResult = result;
    controller.signal.throwIfAborted();
    stage = 'generation_acceptance';
    // Repository final CAS is authoritative if the deadline/lease crosses here.
    await deps.complete(lease, prepared, result);
    report('generation_succeeded');
  } catch (error) {
    const classified = deps.classify(error);
    const failure = { ...classified, stage: classified.stage === 'generation_execution' ? stage : classified.stage };
    report('generation_failed', { worker_stage: stage, failure_stage: failure.stage,
      internal_failure_code: failure.internalCode, external_failure_code: failure.externalCode });
    if (!leaseLost && !(error instanceof GenerationJobError && error.code === 'GENERATION_LEASE_LOST')) {
      try { await deps.fail(lease, failure, error, receivedResult, preparedContext); }
      catch { report('generation_terminal_write_deferred', { internal_failure_code: 'GENERATION_RECONCILIATION_REQUIRED' }); }
    }
    // No requeue/retry here. Expired/uncertain dispatch goes through recovery.
  } finally {
    clearInterval(heartbeat);
    if (deadline) clearTimeout(deadline);
    if (abortListener) controller.signal.removeEventListener('abort', abortListener);
    shutdown?.removeEventListener('abort', onShutdown);
  }
}
