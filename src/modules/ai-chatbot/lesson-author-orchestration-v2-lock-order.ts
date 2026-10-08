import type { GenerationJobDatabase, GenerationJobSql } from './lesson-author-generation-job.repository.js';

/*
 * Lesson Author orchestration V2 — global PostgreSQL lock order.
 *
 * Two database-owned locks are taken implicitly by triggers on every V2 write:
 *
 *  C  courses row FOR UPDATE — assert_active_course_deletion_fence(), a BEFORE
 *     INSERT/UPDATE row trigger on every course-scoped V2 table (runs, tasks,
 *     outbox, artifacts, attempt events, workspace rows/events/revisions...).
 *     It fires after the statement has locked its own target row.
 *  Q  pg_advisory_xact_lock(hashtextextended(tenant_id::text,20260907)) plus
 *     tenant_data_quota_usage FOR UPDATE — tenant_data_quota_apply_direct_delta(),
 *     an AFTER STATEMENT trigger on every quota-registered table whose physical
 *     row size changed (course-scoped V2 tables and the AI token tables).
 *
 * A single write statement therefore always acquires: own row -> C -> Q.
 * Every V2 transaction must keep that order for its whole lifetime:
 *
 *   1. advisory G (la:v2:global) -> T (la:v2:tenant) -> W (la:v2:workspace)
 *   2. the transaction's own V2 rows (run -> task -> outbox; scheduler picks
 *      use SKIP LOCKED and never wait)
 *   3. C, the course fence (implicit at the first course-scoped write, explicit
 *      before any write to a quota-registered table that is NOT course-scoped)
 *   4. course-scoped rows (workspace, nodes, revisions, events, sibling tasks)
 *   5. AI token reservation row -> M (ai_token_monthly_usage FOR UPDATE)
 *   6. Q, the tenant quota lock — only ever implicit (trigger), never explicit.
 *
 * Production deadlocks (SQLSTATE 40P01) came from transactions that broke this
 * order: deferPublished/markPublished took Q explicitly *before* their outbox
 * row and C, while claims, dispatch fences and completions took C before Q;
 * provider claims/settlements wrote AI token tables (Q) before their first
 * course-scoped write (C). See lesson-author-orchestration-v2-lock-order.test.ts.
 */

/** SQLSTATEs PostgreSQL raises after it has rolled back the whole transaction. */
export const ORCHESTRATION_V2_TRANSIENT_SQLSTATES: ReadonlySet<string> = Object.freeze(new Set(['40P01', '40001']));

/** Task failure codes produced when a transient transaction failure survived every bounded retry. */
export const ORCHESTRATION_V2_DB_DEADLOCK_RETRY_EXHAUSTED = 'ORCHESTRATION_V2_DB_DEADLOCK_RETRY_EXHAUSTED' as const;
export const ORCHESTRATION_V2_DB_SERIALIZATION_RETRY_EXHAUSTED = 'ORCHESTRATION_V2_DB_SERIALIZATION_RETRY_EXHAUSTED' as const;
export const ORCHESTRATION_V2_TRANSIENT_DB_FAILURE_CODES: ReadonlySet<string> = Object.freeze(new Set<string>([
  ORCHESTRATION_V2_DB_DEADLOCK_RETRY_EXHAUSTED, ORCHESTRATION_V2_DB_SERIALIZATION_RETRY_EXHAUSTED,
]));

/**
 * A claimed task whose only failure was a rolled-back transaction before any
 * provider dispatch is requeued with its attempt refunded. The dispatch epoch
 * still advances on every claim, so this bound keeps the refund loop finite
 * (the schema caps dispatch_epoch at 100).
 */
export const ORCHESTRATION_V2_TRANSIENT_DB_REQUEUE_EPOCH_LIMIT = 12;

export interface OrchestrationV2TransientRetryPolicy {
  /** Total attempts including the first one. */
  readonly max_attempts: number;
  readonly base_delay_ms: number;
  readonly max_delay_ms: number;
}

/** Four retries with 0.375-0.75 s cumulative backoff (plus PostgreSQL's own
 * deadlock_timeout per detection): far below any task lease or broker delay. */
export const ORCHESTRATION_V2_TRANSACTION_RETRY_POLICY: Readonly<OrchestrationV2TransientRetryPolicy> = Object.freeze({
  max_attempts: 5, base_delay_ms: 50, max_delay_ms: 800,
});

export interface OrchestrationV2TransientRetryEvent {
  code: string;
  attempt: number;
  delay_ms: number;
}

export interface OrchestrationV2TransientRetryOptions {
  policy?: Readonly<OrchestrationV2TransientRetryPolicy>;
  /** Uniform [0,1) source for jitter; injectable for deterministic tests. */
  random?: () => number;
  /** Abortable wait; injectable for tests. */
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  onRetry?: (event: Readonly<OrchestrationV2TransientRetryEvent>) => void;
}

const RETRY_EXHAUSTED = Symbol.for('landa.lesson_author.orchestration_v2.transient_retry_exhausted');

export function orchestrationV2TransientSqlState(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && ORCHESTRATION_V2_TRANSIENT_SQLSTATES.has(code) ? code : null;
}

export function isOrchestrationV2TransientTransactionError(error: unknown): boolean {
  return orchestrationV2TransientSqlState(error) !== null;
}

/** True when an inner boundary already spent its whole retry budget on this error. */
export function isOrchestrationV2TransientRetryExhausted(error: unknown): boolean {
  return !!error && typeof error === 'object'
    && (error as Record<symbol, unknown>)[RETRY_EXHAUSTED] === true;
}

function markRetryExhausted(error: unknown): void {
  if (!error || typeof error !== 'object') return;
  try {
    Object.defineProperty(error, RETRY_EXHAUSTED, { value: true, enumerable: false, configurable: true });
  } catch {
    // A frozen third-party error stays authoritative; outer layers may retry it once more.
  }
}

export function isOrchestrationV2TransientDbFailureCode(code: unknown): boolean {
  return typeof code === 'string' && ORCHESTRATION_V2_TRANSIENT_DB_FAILURE_CODES.has(code);
}

function assertPolicy(policy: Readonly<OrchestrationV2TransientRetryPolicy>): Readonly<OrchestrationV2TransientRetryPolicy> {
  const integer = (value: number, minimum: number, maximum: number) => Number.isSafeInteger(value)
    && value >= minimum && value <= maximum;
  if (!policy || !integer(policy.max_attempts, 1, 10) || !integer(policy.base_delay_ms, 0, 5_000)
    || !integer(policy.max_delay_ms, policy.base_delay_ms, 30_000)) {
    throw new Error('ORCHESTRATION_V2_RETRY_POLICY_INVALID');
  }
  return policy;
}

/**
 * Exponential backoff with "equal jitter": the n-th retry waits in
 * [cap/2, cap) where cap = min(max_delay, base * 2^(n-1)). Never above max_delay.
 */
export function orchestrationV2TransientRetryDelayMs(
  failedAttempts: number,
  policy: Readonly<OrchestrationV2TransientRetryPolicy> = ORCHESTRATION_V2_TRANSACTION_RETRY_POLICY,
  random: () => number = Math.random,
): number {
  assertPolicy(policy);
  const exponent = Math.max(0, Math.min(20, Math.floor(failedAttempts) - 1));
  const cap = Math.min(policy.max_delay_ms, policy.base_delay_ms * (2 ** exponent));
  const ratio = Math.max(0, Math.min(0.999_999, Number(random()) || 0));
  return Math.min(policy.max_delay_ms, Math.floor(cap / 2 + (cap / 2) * ratio));
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error('ORCHESTRATION_V2_TASK_ABORTED');
}

function defaultSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(abortReason(signal!)); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, delayMs);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Re-run a whole database boundary after PostgreSQL rolled it back as a
 * deadlock (40P01) or serialization (40001) victim. The operation must be a
 * complete transaction (or an idempotent read) without external side effects:
 * provider calls always stay outside, so a retry never duplicates paid work.
 * An error that already exhausted an inner retry budget is rethrown at once,
 * so nested boundaries never multiply their attempts.
 */
export async function withOrchestrationV2TransientRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: OrchestrationV2TransientRetryOptions = {},
): Promise<T> {
  const policy = assertPolicy(options.policy ?? ORCHESTRATION_V2_TRANSACTION_RETRY_POLICY);
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  for (let attempt = 1; ; attempt += 1) {
    if (options.signal?.aborted) throw abortReason(options.signal);
    try {
      return await operation(attempt);
    } catch (error) {
      const code = orchestrationV2TransientSqlState(error);
      if (!code || isOrchestrationV2TransientRetryExhausted(error)) throw error;
      if (attempt >= policy.max_attempts) {
        markRetryExhausted(error);
        throw error;
      }
      const delayMs = orchestrationV2TransientRetryDelayMs(attempt, policy, random);
      try {
        options.onRetry?.({ code, attempt, delay_ms: delayMs });
      } catch {
        // Telemetry never changes a retry decision.
      }
      await sleep(delayMs, options.signal);
    }
  }
}

/**
 * Decorate a transaction factory so every transaction it opens is retried from
 * BEGIN when PostgreSQL rolls it back for 40P01/40001. Each call of `work`
 * receives a fresh transaction; nothing from a rolled-back attempt survives.
 */
export function withOrchestrationV2TransactionRetry(
  db: GenerationJobDatabase,
  options: OrchestrationV2TransientRetryOptions = {},
): GenerationJobDatabase {
  return {
    transaction: work => withOrchestrationV2TransientRetry(() => db.transaction(work), options),
  };
}

/**
 * Take the course deletion-fence lock exactly as the trigger does. Call it
 * before the first write to a quota-registered table that is not course-scoped
 * (AI token reservations/usage/ledger), so C is held before Q in every V2
 * transaction. Re-locking a row this transaction already holds never waits.
 * A missing/deleted course is left to the authoritative trigger at the write.
 */
export async function lockOrchestrationV2CourseFence(tx: GenerationJobSql, courseId: unknown): Promise<void> {
  if (typeof courseId !== 'string' || !courseId.trim() || courseId.length > 255) {
    throw new Error('ORCHESTRATION_V2_COURSE_FENCE_INVALID');
  }
  await tx.query(`SELECT 1 AS locked FROM courses WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, [courseId]);
}

/**
 * Lock the tenant's monthly AI token counter (M) for a reservation before the
 * reservation row is mutated. reserveTenantAiTokens() locks M before its
 * quota-registered insert; settlement/release/hold must not invert that by
 * taking Q (reservation update) before M (usage update).
 */
export async function lockOrchestrationV2AiTokenUsage(
  tx: GenerationJobSql,
  tenantId: string,
  reservationId: string,
): Promise<void> {
  await tx.query(`SELECT usage.tenant_id::text FROM ai_token_monthly_usage usage
    JOIN ai_token_reservations reservation ON reservation.tenant_id=usage.tenant_id
      AND reservation.period_start=usage.period_start
    WHERE reservation.id=$1 AND reservation.tenant_id=$2 FOR UPDATE OF usage`, [reservationId, tenantId]);
}

/** Delay of a transient-DB requeue: 1 s doubling per dispatch epoch, capped at 30 s, plus jitter. */
export function orchestrationV2TransientDbRequeueDelayMs(dispatchEpoch: number, jitterMs: number): number {
  const epoch = Number.isSafeInteger(dispatchEpoch) && dispatchEpoch > 0 ? dispatchEpoch : 1;
  const jitter = Number.isSafeInteger(jitterMs) && jitterMs > 0 ? jitterMs % 1_000 : 0;
  return Math.min(30_000, 1_000 * (2 ** Math.min(epoch - 1, 5))) + jitter;
}
