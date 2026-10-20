// Steps the orchestration V2 worker repository runs inside its transactions: the workspace
// lifecycle lock, the needs-action sync, stopping a run after a terminal task, and reading a task
// lease row. Split out of lesson-author-orchestration-v2-worker.repository.ts (move only).

import type { GenerationJobSql } from '../../shared/lesson-author-generation-job.repository.js';
import type { OrchestrationV2TaskKind } from '../../shared/lesson-author-orchestration-v2.logic.js';
import { ORCHESTRATION_V2_RUN_STOPPING_FAILURES } from '../lesson-author-orchestration-v2-worker.logic.js';
import { UUID_PATTERN, isUuid } from '../../../../../utils/uuid.js';
import { OrchestrationV2WorkerRepositoryError } from '../lesson-author-orchestration-v2-worker-repository.types.js';
import type {
  OrchestrationV2ReconcileBackoffOptions, OrchestrationV2TaskLease, ReconcileUnknown,
} from '../lesson-author-orchestration-v2-worker-repository.types.js';
import { isOrchestrationV2TransientTransactionError } from '../lesson-author-orchestration-v2-lock-order.js';

export const HASH = /^[0-9a-f]{64}$/;
export const providerKinds = `('course_skeleton','chapter_blueprint','generate_unit')`;
export const terminal = new Set(['succeeded', 'failed', 'timed_out', 'outcome_unknown', 'canceled']);
export const activeRun = new Set(['planning', 'executing', 'finalizing']);
export const fail = (code: OrchestrationV2WorkerRepositoryError['code']): never => {
  throw new OrchestrationV2WorkerRepositoryError(code);
};

export async function lockWorkspaceLifecycle(
  tx: GenerationJobSql,
  tenantId: unknown,
  workspaceId: unknown,
): Promise<void> {
  if (typeof tenantId !== 'string' || typeof workspaceId !== 'string'
    || !UUID_PATTERN.test(tenantId) || !UUID_PATTERN.test(workspaceId)) fail('ORCHESTRATION_V2_TASK_STATE_INVALID');
  // claimExact takes global -> tenant -> workspace. Lifecycle commits only
  // need the final workspace fence; they never wait for global/tenant, so this
  // cannot form a lock cycle with a claimant and serializes run/task changes.
  await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('la:v2:workspace:'||$1::text,0))`,
    [workspaceId]);
}

export async function syncNeedsActionWorkspace(
  tx: GenerationJobSql,
  task: Record<string, unknown>,
  cancelCode: 'RUN_STOPPED_AFTER_TASK_FAILURE' | 'RUN_STOPPED_BY_AUTHOR' = 'RUN_STOPPED_AFTER_TASK_FAILURE',
): Promise<void> {
  await tx.query(`UPDATE lesson_author_workspace_v2_tasks SET status='canceled',
      failure_code=$2,finished_at=clock_timestamp()
    WHERE run_id=$1 AND status IN ('blocked','queued')`, [task.run_id, cancelCode]);
  const live = await tx.query(`SELECT count(*)::integer AS count
    FROM lesson_author_workspace_v2_tasks WHERE run_id=$1 AND status='running'`, [task.run_id]);
  if (live.rows.length !== 1 || !Number.isSafeInteger(Number(live.rows[0]?.count))) {
    fail('ORCHESTRATION_V2_TASK_WRITE_UNCONFIRMED');
  }
  if (Number(live.rows[0]?.count) !== 0) return;

  const workspace = await tx.query(`UPDATE lesson_author_workspaces SET status='needs_action',updated_at=clock_timestamp()
    WHERE id=$1 AND tenant_id=$2 AND course_id=$3 AND status IN ('queued','designing','drafting') RETURNING id`,
  [task.workspace_id, task.tenant_id, task.course_id]);
  if (workspace.rows.length > 1) fail('ORCHESTRATION_V2_TASK_WRITE_UNCONFIRMED');
  if (workspace.rows.length === 0) return;
  const operationId = isUuid(task.id) ? task.id : task.run_id;
  const event = await tx.query(`INSERT INTO lesson_author_workspace_events
      (workspace_id,tenant_id,course_id,event_kind,operation_id)
    VALUES($1,$2,$3,'run_needs_action',$4) RETURNING sequence`,
  [task.workspace_id, task.tenant_id, task.course_id, operationId]);
  if (event.rows.length !== 1) fail('ORCHESTRATION_V2_TASK_WRITE_UNCONFIRMED');
}

export async function stopRunAfterTerminalTask(
  tx: GenerationJobSql,
  task: Record<string, unknown>,
): Promise<void> {
  const failureCode = typeof task.failure_code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(task.failure_code)
    ? task.failure_code
    : 'TASK_FAILED';
  const isolatedUnitFailure = task.kind === 'generate_unit'
    && !ORCHESTRATION_V2_RUN_STOPPING_FAILURES.has(failureCode);
  const lockedRun = await tx.query(`SELECT status,failure_code FROM lesson_author_workspace_v2_runs
    WHERE id=$1 AND workspace_id=$2 AND tenant_id=$3 AND course_id=$4 FOR UPDATE`,
  [task.run_id, task.workspace_id, task.tenant_id, task.course_id]);
  if (lockedRun.rows.length !== 1) fail('ORCHESTRATION_V2_TASK_WRITE_UNCONFIRMED');
  const runStatus = String(lockedRun.rows[0]?.status);
  const runIsActive = activeRun.has(runStatus);
  if (!runIsActive && !['needs_action', 'failed', 'canceled'].includes(runStatus)) {
    fail('ORCHESTRATION_V2_TASK_STATE_INVALID');
  }
  if (isolatedUnitFailure && runIsActive) {
    // A unit is an independent content shard. Cancel only its dependency
    // descendants (chapter receipt/finalizer), while unrelated units and
    // chapters continue to publish usable baselines.
    await tx.query(`WITH RECURSIVE descendants(id) AS (
        SELECT d.task_id FROM lesson_author_workspace_v2_dependencies d
          WHERE d.run_id=$1 AND d.depends_on_task_id=$2
        UNION
        SELECT d.task_id FROM lesson_author_workspace_v2_dependencies d
          JOIN descendants parent ON parent.id=d.depends_on_task_id WHERE d.run_id=$1
      )
      UPDATE lesson_author_workspace_v2_tasks candidate SET status='canceled',
        failure_code='UPSTREAM_UNIT_UNAVAILABLE',finished_at=clock_timestamp()
      WHERE candidate.run_id=$1 AND candidate.id IN (SELECT id FROM descendants)
        AND candidate.status IN ('blocked','queued')`, [task.run_id, task.id]);
    const remaining = await tx.query(`SELECT count(*)::integer AS count
      FROM lesson_author_workspace_v2_tasks
      WHERE run_id=$1 AND status IN ('blocked','queued','running')`, [task.run_id]);
    if (remaining.rows.length !== 1 || !Number.isSafeInteger(Number(remaining.rows[0]?.count))) {
      fail('ORCHESTRATION_V2_TASK_WRITE_UNCONFIRMED');
    }
    if (Number(remaining.rows[0]?.count) !== 0) return;
  }
  const run = await tx.query(`UPDATE lesson_author_workspace_v2_runs
    SET status='needs_action',failure_code=$2,finished_at=clock_timestamp()
    WHERE id=$1 AND status IN ('planning','executing','finalizing') RETURNING id`, [task.run_id, failureCode]);
  if (run.rows.length > 1) fail('ORCHESTRATION_V2_TASK_WRITE_UNCONFIRMED');
  await syncNeedsActionWorkspace(tx, task);
}

/** Same backoff bounds as the V2 retry defaults (LESSON_AUTHOR_ORCHESTRATION_V2_RETRY_BASE_MS / _MAX_MS). */
export const ORCHESTRATION_V2_RECONCILE_BACKOFF_DEFAULTS: Readonly<OrchestrationV2ReconcileBackoffOptions> =
  Object.freeze({ base_ms: 1_000, max_ms: 60_000 });
/** Bound of the per-process skip list (oldest entry dropped first). */
export const ORCHESTRATION_V2_RECONCILE_BACKOFF_MAX_ENTRIES = 500;
const RECONCILE_SAVEPOINT = 'la_v2_finished_run_unknown';
const LOGGED_CODE = /^(?:[0-9A-Z]{5}|[A-Z][A-Z0-9_]{0,99})$/;

export type OrchestrationV2ReconcileBackoff = ReturnType<typeof createOrchestrationV2ReconcileBackoff>;

/**
 * Per-process skip list of finished-run unknown outcomes whose settlement
 * failed: each failure doubles the wait (base, 2 x base, ... up to max) before
 * the same task is tried again, so one bad row is never retried in a tight
 * loop and cannot hide the next candidate or the stalled-run check. It is a
 * local pacing hint, not shared state: another worker process keeps its own
 * list and the database row stays the only authority.
 */
export function createOrchestrationV2ReconcileBackoff(
  options: OrchestrationV2ReconcileBackoffOptions = ORCHESTRATION_V2_RECONCILE_BACKOFF_DEFAULTS,
) {
  const { base_ms: base, max_ms: max } = options;
  if (!Number.isSafeInteger(base) || base < 1 || !Number.isSafeInteger(max) || max < base) {
    throw new Error('ORCHESTRATION_V2_RECONCILE_BACKOFF_INVALID');
  }
  const now = options.now ?? Date.now;
  const report = options.report
    ?? ((event: Record<string, unknown>) => console.warn('[LessonAuthorOrchestrationV2]', JSON.stringify(event)));
  const entries = new Map<string, { failures: number; retry_at: number }>();
  return {
    report(event: Record<string, unknown>): void {
      try { report(event); } catch { /* Logging never changes the recovery cycle. */ }
    },
    /** Task ids still waiting out their backoff. */
    waiting(): string[] {
      const at = now();
      return [...entries].filter(([, entry]) => entry.retry_at > at).map(([taskId]) => taskId);
    },
    /** Records one more failure; returns the wait before the next try. */
    failed(taskId: string): number {
      const failures = Math.min((entries.get(taskId)?.failures ?? 0) + 1, 32);
      const delay = Math.min(max, base * 2 ** (failures - 1));
      entries.delete(taskId);
      entries.set(taskId, { failures, retry_at: now() + delay });
      while (entries.size > ORCHESTRATION_V2_RECONCILE_BACKOFF_MAX_ENTRIES) entries.delete(entries.keys().next().value!);
      return delay;
    },
    succeeded(taskId: string): void { entries.delete(taskId); },
  };
}

function loggedCode(error: unknown): string {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && LOGGED_CODE.test(code) ? code : 'UNEXPECTED_ERROR';
}

/**
 * An outcome-unknown provider task of a run that already ended (needs_action
 * or canceled) is never replayed, so nothing else would ever settle its held
 * reservation. Settle it once at the pessimistic upper bound (the provider
 * call may have been paid): the reservation moves reserved -> finalized with
 * its single ledger row, and later scans no longer select it. The task keeps
 * its terminal evidence (pending_reconciliation is the only accounting state
 * an outcome_unknown task may hold). The candidate is driven by the small
 * set of reserved reservations (partial index) and only selects a row whose
 * reservation still matches the task budget exactly, so a malformed row is
 * left for an operator instead of failing every recovery cycle.
 *
 * A settlement that fails for one task (anything but a deadlock/serialization
 * victim, which re-runs the whole transaction) is rolled back to a savepoint
 * taken before its locks, logged with the task id and code, and skipped with a
 * backoff: the caller then runs the stalled-run check in the same cycle.
 * Lock order: W -> run, task -> (reconcile) C -> reservation -> M.
 */
export async function reconcileFinishedRunUnknown(
  tx: GenerationJobSql,
  reconcileUnknown?: ReconcileUnknown,
  backoff: OrchestrationV2ReconcileBackoff = createOrchestrationV2ReconcileBackoff(),
): Promise<'reconciled' | null> {
  if (!reconcileUnknown) return null;
  const candidate = await tx.query(`SELECT t.id::text AS task_id,t.run_id::text,
      t.workspace_id::text,t.tenant_id::text
    FROM ai_token_reservations reservation
    JOIN lesson_author_workspace_v2_tasks t ON t.ai_reservation_id=reservation.id
      AND t.tenant_id=reservation.tenant_id
    JOIN lesson_author_workspace_v2_runs r ON r.id=t.run_id AND r.workspace_id=t.workspace_id
    WHERE reservation.status='reserved' AND t.status='outcome_unknown'
      AND t.accounting_state='pending_reconciliation' AND r.status IN ('needs_action','canceled')
      AND reservation.estimated_tokens=t.input_tokens+t.embedding_tokens+t.max_output_tokens*t.provider_max_attempts
      AND t.id<>ALL($1::uuid[])
    ORDER BY t.finished_at,t.id LIMIT 1`, [backoff.waiting()]);
  const found = candidate.rows[0];
  if (!found) return null;
  const taskId = String(found.task_id);
  await tx.query(`SAVEPOINT ${RECONCILE_SAVEPOINT}`);
  try {
    await lockWorkspaceLifecycle(tx, found.tenant_id, found.workspace_id);
    const locked = await tx.query(`SELECT t.*,r.model
      FROM lesson_author_workspace_v2_runs r
      JOIN lesson_author_workspace_v2_tasks t ON t.run_id=r.id AND t.id=$2
        AND t.status='outcome_unknown' AND t.accounting_state='pending_reconciliation'
      JOIN ai_token_reservations reservation ON reservation.id=t.ai_reservation_id
        AND reservation.tenant_id=t.tenant_id AND reservation.status='reserved'
      WHERE r.id=$1 AND r.status IN ('needs_action','canceled')
      FOR UPDATE OF r,t`, [found.run_id, found.task_id]);
    if (locked.rows[0]) await reconcileUnknown(tx, locked.rows[0]);
    await tx.query(`RELEASE SAVEPOINT ${RECONCILE_SAVEPOINT}`);
    backoff.succeeded(taskId);
    return locked.rows[0] ? 'reconciled' : null;
  } catch (error) {
    if (isOrchestrationV2TransientTransactionError(error)) throw error;
    // Back to before this task's locks: nothing of it stays held or written.
    await tx.query(`ROLLBACK TO SAVEPOINT ${RECONCILE_SAVEPOINT}`);
    await tx.query(`RELEASE SAVEPOINT ${RECONCILE_SAVEPOINT}`);
    const retryAfterMs = backoff.failed(taskId);
    backoff.report({ event: 'worker_finished_run_unknown_reconcile_failed', task_id: taskId,
      run_id: String(found.run_id), tenant_id: String(found.tenant_id), failure_code: loggedCode(error),
      retry_after_ms: retryAfterMs });
    return null;
  }
}

/**
 * A recovered run whose reopened work drained while some task is still not
 * done (a lesson nobody asked to rewrite, a validation it blocks) would stay
 * executing forever: no live task is left to stop it. Publish needs_action
 * again with the most relevant remaining failure, so the author sees what is
 * left and can recover it next. Only runs with recovery evidence qualify; the
 * normal lifecycle never leaves an executing run without live work.
 */
export async function stopStalledRecoveredRun(tx: GenerationJobSql): Promise<'reconciled' | null> {
  const candidate = await tx.query(`SELECT r.id::text AS run_id,r.workspace_id::text,r.tenant_id::text
    FROM lesson_author_workspace_v2_runs r
    WHERE r.status='executing'
      AND EXISTS(SELECT 1 FROM lesson_author_workspace_v2_recoveries recovery WHERE recovery.run_id=r.id)
      AND NOT EXISTS(SELECT 1 FROM lesson_author_workspace_v2_tasks live
        WHERE live.run_id=r.id AND live.status IN ('blocked','queued','running'))
      AND EXISTS(SELECT 1 FROM lesson_author_workspace_v2_tasks open
        WHERE open.run_id=r.id AND open.status<>'succeeded')
    ORDER BY r.created_at,r.id LIMIT 1`);
  const found = candidate.rows[0];
  if (!found) return null;
  await lockWorkspaceLifecycle(tx, found.tenant_id, found.workspace_id);
  const locked = await tx.query(`SELECT r.id::text AS run_id,r.workspace_id::text,r.tenant_id::text,r.course_id,
      (SELECT left_over.failure_code FROM lesson_author_workspace_v2_tasks left_over
        WHERE left_over.run_id=r.id AND left_over.status IN ('failed','timed_out','outcome_unknown','canceled')
        ORDER BY CASE WHEN left_over.status='canceled' THEN 1 ELSE 0 END,left_over.finished_at DESC NULLS LAST,
          left_over.ordinal LIMIT 1) AS failure_code
    FROM lesson_author_workspace_v2_runs r
    WHERE r.id=$1 AND r.status='executing'
      AND NOT EXISTS(SELECT 1 FROM lesson_author_workspace_v2_tasks live
        WHERE live.run_id=r.id AND live.status IN ('blocked','queued','running'))
    FOR UPDATE OF r`, [found.run_id]);
  const run = locked.rows[0];
  if (!run) return null;
  // Not a unit: stops the run (no isolated-unit continuation) and syncs the workspace.
  await stopRunAfterTerminalTask(tx, { id: run.run_id, run_id: run.run_id, workspace_id: run.workspace_id,
    tenant_id: run.tenant_id, course_id: run.course_id, kind: 'finalize_course', failure_code: run.failure_code });
  return 'reconciled';
}

export function leaseFrom(row: Record<string, unknown>): OrchestrationV2TaskLease {
  const lease: OrchestrationV2TaskLease = {
    task_id: String(row.id), run_id: String(row.run_id), workspace_id: String(row.workspace_id),
    tenant_id: String(row.tenant_id), course_id: String(row.course_id), task_key: String(row.task_key),
    kind: String(row.kind) as OrchestrationV2TaskKind,
    chapter_key: row.chapter_key === null ? null : String(row.chapter_key),
    node_id: row.node_id === null ? null : String(row.node_id), contract_hash: String(row.contract_hash),
    input_context_hash: row.input_context_hash === null ? null : String(row.input_context_hash),
    source_snapshot_id: String(row.source_snapshot_id), source_snapshot_hash: String(row.source_snapshot_hash),
    runtime_config_hash: String(row.runtime_config_hash),
    model: String(row.model), locale: row.locale === 'en' ? 'en' : 'vi',
    max_output_tokens: Number(row.max_output_tokens), provider_max_attempts: Number(row.provider_max_attempts),
    execution_budget_ms: Number(row.execution_budget_ms), lease_token: String(row.lease_token),
    dispatch_epoch: Number(row.dispatch_epoch),
    provider_replay_required: row.provider_replay_required === true,
    routing_shard: Number(row.routing_shard),
    ai_reservation_id: row.ai_reservation_id === null ? null : String(row.ai_reservation_id),
  };
  if (![lease.task_id, lease.run_id, lease.workspace_id, lease.tenant_id, lease.source_snapshot_id, lease.lease_token]
    .every(value => UUID_PATTERN.test(value)) || !HASH.test(lease.contract_hash) || !HASH.test(lease.source_snapshot_hash)
    || !HASH.test(lease.runtime_config_hash)
    || (lease.input_context_hash !== null && !HASH.test(lease.input_context_hash))
    || typeof row.provider_replay_required !== 'boolean'
    || !Number.isSafeInteger(lease.routing_shard) || lease.routing_shard < 0 || lease.routing_shard > 4_095
    || !lease.course_id || !lease.task_key || !lease.model) fail('ORCHESTRATION_V2_TASK_STATE_INVALID');
  return Object.freeze(lease);
}
