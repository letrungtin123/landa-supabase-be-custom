// Steps the orchestration V2 worker repository runs inside its transactions: the workspace
// lifecycle lock, the needs-action sync, stopping a run after a terminal task, and reading a task
// lease row. Split out of lesson-author-orchestration-v2-worker.repository.ts (move only).

import type { GenerationJobSql } from './lesson-author-generation-job.repository.js';
import type { OrchestrationV2TaskKind } from './lesson-author-orchestration-v2.logic.js';
import { ORCHESTRATION_V2_RUN_STOPPING_FAILURES } from './lesson-author-orchestration-v2-worker.logic.js';
import { UUID_PATTERN, isUuid } from '../../../utils/uuid.js';
import { OrchestrationV2WorkerRepositoryError } from './lesson-author-orchestration-v2-worker-repository.types.js';
import type { OrchestrationV2TaskLease, ReconcileUnknown } from './lesson-author-orchestration-v2-worker-repository.types.js';

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
 * Lock order: W -> run, task -> (reconcile) C -> reservation -> M.
 */
export async function reconcileFinishedRunUnknown(
  tx: GenerationJobSql,
  reconcileUnknown?: ReconcileUnknown,
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
    ORDER BY t.finished_at,t.id LIMIT 1`);
  const found = candidate.rows[0];
  if (!found) return null;
  await lockWorkspaceLifecycle(tx, found.tenant_id, found.workspace_id);
  const locked = await tx.query(`SELECT t.*,r.model
    FROM lesson_author_workspace_v2_runs r
    JOIN lesson_author_workspace_v2_tasks t ON t.run_id=r.id AND t.id=$2
      AND t.status='outcome_unknown' AND t.accounting_state='pending_reconciliation'
    JOIN ai_token_reservations reservation ON reservation.id=t.ai_reservation_id
      AND reservation.tenant_id=t.tenant_id AND reservation.status='reserved'
    WHERE r.id=$1 AND r.status IN ('needs_action','canceled')
    FOR UPDATE OF r,t`, [found.run_id, found.task_id]);
  if (!locked.rows[0]) return null;
  await reconcileUnknown(tx, locked.rows[0]);
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
