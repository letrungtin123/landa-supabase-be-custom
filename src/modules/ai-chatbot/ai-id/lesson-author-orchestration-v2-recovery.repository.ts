// SQL of the author recovery actions on an orchestration V2 run (stop, and
// the read-only snapshot the recovery options are computed from).
//
// Lock order of every write transaction, matching recoverOne and
// lesson-author-orchestration-v2-lock-order.ts: the caller's permission rows
// (canEdit, FOR SHARE), then advisory W (la:v2:workspace) -> run -> workspace
// -> tasks (by ordinal) -> course fence (C) -> AI token rows. Course-scoped
// writes then take C/Q implicitly through their triggers.

import type { GenerationJobDatabase, GenerationJobSql } from './lesson-author-generation-job.repository.js';
import {
  withOrchestrationV2TransactionRetry,
  type OrchestrationV2TransientRetryOptions,
} from './lesson-author-orchestration-v2-lock-order.js';
import {
  ACTIVE_RUN_STATUSES,
  ORCHESTRATION_V2_RUN_STOPPED_BY_AUTHOR,
  OrchestrationV2RecoveryError,
  type OrchestrationV2RecoveryErrorCode,
  type OrchestrationV2RecoveryRun,
  type OrchestrationV2RecoveryTask,
} from './lesson-author-orchestration-v2-recovery.logic.js';
import { lockWorkspaceLifecycle, syncNeedsActionWorkspace } from './lesson-author-orchestration-v2-worker-steps.repository.js';
import type { WorkspaceReadOwner } from './lesson-author-workspace-read.repository.js';
import { UUID_PATTERN, isUuid } from '../../../utils/uuid.js';

export interface OrchestrationV2RecoverySnapshot {
  run: OrchestrationV2RecoveryRun | null;
  workspace_status: string;
  event_head: number;
  tasks: OrchestrationV2RecoveryTask[];
  course_node: { node_id: string; path: string } | null;
  /** Run authority used to refuse a recovery after the AI settings changed. */
  runtime: { runtime_config_hash: string; model: string } | null;
}

export interface OrchestrationV2RecoveryActionResult {
  recovery_id: string | null;
  run_id: string;
  action: 'stop' | 'resume' | 'regenerate';
  reopened_task_count: number;
  workspace_status: string;
  replayed: boolean;
}

const RUN_STATUSES = ['planning', 'executing', 'finalizing', 'ready', 'needs_action', 'canceled'];
const TASK_STATUSES = ['blocked', 'queued', 'running', 'succeeded', 'failed', 'timed_out', 'outcome_unknown', 'canceled'];
const TASK_KINDS = ['source_snapshot', 'course_skeleton', 'chapter_blueprint', 'validate_architecture',
  'publish_inventory', 'generate_unit', 'validate_chapter', 'finalize_course'];
const WORKSPACE_STATUSES = ['queued', 'designing', 'drafting', 'ready', 'needs_action', 'failed', 'canceled'];
const HASH = /^[0-9a-f]{64}$/;
const CODE = /^[A-Z][A-Z0-9_]{0,99}$/;

export const fail = (code: OrchestrationV2RecoveryErrorCode): never => {
  throw new OrchestrationV2RecoveryError(code);
};
const unavailable = (): never => fail('RECOVERY_UNAVAILABLE');

function integer(value: unknown, minimum: number, maximum: number): number {
  const number = typeof value === 'string' && /^-?[0-9]+$/.test(value) ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < minimum || number > maximum) unavailable();
  return number as number;
}
function oneOf<T extends string>(value: unknown, values: readonly string[]): T {
  if (typeof value !== 'string' || !values.includes(value)) unavailable();
  return value as T;
}
function nullableCode(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !CODE.test(value)) unavailable();
  return value as string;
}
function nullableId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (!isUuid(value)) unavailable();
  return (value as string).toLowerCase();
}

/** Ownership of a V2 workspace, as every workspace read/write binds it. */
const OWNED_WORKSPACE = `FROM lesson_author_workspaces w
  JOIN chat_conversations c ON c.id=w.conversation_id AND c.tenant_id=w.tenant_id AND c.user_id=w.requested_by
    AND c.course_id=w.course_id AND c.bot_id=w.bot_id AND c.target='lesson_author'
  JOIN courses course ON course.id=w.course_id AND course.tenant_id=w.tenant_id AND course.deleted_at IS NULL`;
const OWNED_WHERE = `w.id=$1 AND w.tenant_id=$2 AND w.course_id=$3 AND w.conversation_id=$4 AND w.requested_by=$5`;

export function ownerParams(owner: WorkspaceReadOwner, workspaceId: string): unknown[] {
  if (![workspaceId, owner.tenantId, owner.userId, owner.conversationId].every(value => UUID_PATTERN.test(value))
    || typeof owner.courseId !== 'string' || !owner.courseId.trim() || owner.courseId.length > 255) {
    fail('RECOVERY_INPUT_INVALID');
  }
  return [workspaceId, owner.tenantId, owner.courseId, owner.conversationId, owner.userId];
}

export function readRecoveryRun(row: Record<string, unknown>): OrchestrationV2RecoveryRun | null {
  if (row.run_id === null || row.run_id === undefined) return null;
  return {
    run_id: nullableId(row.run_id)!,
    status: oneOf(row.run_status, RUN_STATUSES),
    failure_code: nullableCode(row.failure_code),
    finished_at: row.finished_at === null || row.finished_at === undefined ? null : String(row.finished_at),
    manifest_sealed: row.manifest_hash !== null && row.manifest_hash !== undefined && HASH.test(String(row.manifest_hash)),
    completion_receipt: row.completion_receipt === true,
    review_receipt: row.review_receipt === true,
    workspace_status: oneOf(row.workspace_status, WORKSPACE_STATUSES),
    event_head: integer(row.event_head, 0, Number.MAX_SAFE_INTEGER),
  };
}

export function readRecoveryTasks(
  rows: Record<string, unknown>[],
  dependencies: Record<string, unknown>[],
  generations: ReadonlyMap<string, number> = new Map(),
): OrchestrationV2RecoveryTask[] {
  const dependsOn = new Map<string, string[]>();
  for (const dependency of dependencies) {
    const taskId = nullableId(dependency.task_id), parentId = nullableId(dependency.depends_on_task_id);
    if (!taskId || !parentId) unavailable();
    dependsOn.set(taskId!, [...(dependsOn.get(taskId!) ?? []), parentId!]);
  }
  return rows.map(row => {
    const taskId = nullableId(row.task_id);
    if (!taskId) unavailable();
    return {
      task_id: taskId!, ordinal: integer(row.ordinal, 0, 32_767),
      kind: oneOf(row.kind, TASK_KINDS), status: oneOf(row.status, TASK_STATUSES),
      failure_code: nullableCode(row.failure_code),
      attempt_count: integer(row.attempt_count, 0, 2), max_attempts: integer(row.max_attempts, 1, 2),
      dispatch_epoch: integer(row.dispatch_epoch, 0, 100),
      chapter_key: row.chapter_key === null || row.chapter_key === undefined ? null : String(row.chapter_key),
      node_id: nullableId(row.node_id),
      node_path: row.node_path === null || row.node_path === undefined ? null : String(row.node_path),
      node_has_content: row.node_has_content === true,
      ai_reservation_id: nullableId(row.ai_reservation_id),
      accounting_state: String(row.accounting_state),
      reservation_status: row.reservation_status === null || row.reservation_status === undefined
        ? null : String(row.reservation_status),
      generation: generations.get(taskId!) ?? 0,
      depends_on: dependsOn.get(taskId!) ?? [],
    };
  });
}

export const RECOVERY_TASKS_SQL = `SELECT t.id::text AS task_id,t.ordinal,t.kind,t.status,t.failure_code,
    t.attempt_count,t.max_attempts,t.dispatch_epoch,t.chapter_key,t.node_id::text,
    n.canonical_path AS node_path,
    (n.id IS NOT NULL AND n.content_state='content_ready' AND n.current_revision IS NOT NULL) AS node_has_content,
    t.ai_reservation_id::text,t.accounting_state,reservation.status AS reservation_status
  FROM lesson_author_workspace_v2_tasks t
  LEFT JOIN lesson_author_workspace_nodes n ON n.id=t.node_id AND n.workspace_id=t.workspace_id
    AND n.tenant_id=t.tenant_id AND n.course_id=t.course_id
  LEFT JOIN ai_token_reservations reservation ON reservation.id=t.ai_reservation_id
    AND reservation.tenant_id=t.tenant_id
  WHERE t.run_id=$1 AND t.workspace_id=$2 AND t.tenant_id=$3 AND t.course_id=$4
  ORDER BY t.ordinal`;
export const RECOVERY_DEPENDENCIES_SQL = `SELECT task_id::text,depends_on_task_id::text
  FROM lesson_author_workspace_v2_dependencies WHERE run_id=$1 ORDER BY task_id,depends_on_task_id`;

export interface OrchestrationV2RecoveryRepositoryOptions {
  retry?: OrchestrationV2TransientRetryOptions;
}

export function createOrchestrationV2RecoveryRepository(deps: {
  db: GenerationJobDatabase;
  /** Write fence of the authenticated author (createWorkspaceAuthority(user).canEdit). */
  canEdit(tx: GenerationJobSql, owner: Readonly<WorkspaceReadOwner>): Promise<boolean>;
}, options: OrchestrationV2RecoveryRepositoryOptions = {}) {
  const db = withOrchestrationV2TransactionRetry(deps.db, options.retry);

  /** One consistent read of the run, its tasks and the course node. No lock, no write. */
  async function snapshot(owner: WorkspaceReadOwner, workspaceId: string): Promise<OrchestrationV2RecoverySnapshot> {
    const params = ownerParams(owner, workspaceId);
    return db.transaction(async tx => {
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      const head = await tx.query(`SELECT w.status AS workspace_status,w.event_head,
          r.id::text AS run_id,r.status AS run_status,r.failure_code,r.finished_at::text AS finished_at,
          r.manifest_hash,r.runtime_config_hash,r.model,
          EXISTS(SELECT 1 FROM lesson_author_workspace_v2_completion_receipts receipt WHERE receipt.run_id=r.id)
            AS completion_receipt,
          EXISTS(SELECT 1 FROM lesson_author_workspace_v2_review_receipts review WHERE review.run_id=r.id)
            AS review_receipt
        ${OWNED_WORKSPACE}
        LEFT JOIN lesson_author_workspace_v2_runs r ON r.workspace_id=w.id AND r.tenant_id=w.tenant_id
          AND r.course_id=w.course_id AND w.blueprint_id IS NULL
        WHERE ${OWNED_WHERE}`, params);
      if (head.rows.length !== 1) fail('RECOVERY_NOT_FOUND');
      const row = head.rows[0]!;
      const run = readRecoveryRun(row);
      const workspaceStatus = oneOf<string>(row.workspace_status, WORKSPACE_STATUSES);
      const eventHead = integer(row.event_head, 0, Number.MAX_SAFE_INTEGER);
      if (!run) {
        return { run: null, workspace_status: workspaceStatus, event_head: eventHead, tasks: [],
          course_node: null, runtime: null };
      }
      const taskParams = [run.run_id, workspaceId, owner.tenantId, owner.courseId];
      const tasks = await tx.query(RECOVERY_TASKS_SQL, taskParams);
      const dependencies = await tx.query(RECOVERY_DEPENDENCIES_SQL, [run.run_id]);
      const course = await tx.query(`SELECT id::text AS node_id,canonical_path FROM lesson_author_workspace_nodes
        WHERE workspace_id=$1 AND tenant_id=$2 AND course_id=$3 AND kind='course' ORDER BY id LIMIT 2`,
      [workspaceId, owner.tenantId, owner.courseId]);
      const courseRow = course.rows.length === 1 ? course.rows[0]! : null;
      if (!HASH.test(String(row.runtime_config_hash)) || typeof row.model !== 'string' || !row.model) unavailable();
      return {
        run, workspace_status: workspaceStatus, event_head: eventHead,
        tasks: readRecoveryTasks(tasks.rows, dependencies.rows),
        course_node: courseRow ? { node_id: nullableId(courseRow.node_id)!, path: String(courseRow.canonical_path) } : null,
        runtime: { runtime_config_hash: String(row.runtime_config_hash), model: String(row.model) },
      };
    });
  }

  /**
   * Stop-and-keep: an active run becomes needs_action (RUN_STOPPED_BY_AUTHOR),
   * its waiting tasks are canceled, in-flight AI calls finish and settle, and a
   * claim that has not crossed the dispatch fence releases its credit
   * (markProviderDispatched refuses a stopped run). The workspace publishes
   * needs_action once the last running task settled (here, or in recoverOne).
   * Idempotent by state: a run the author already stopped is a replay.
   */
  async function stop(owner: WorkspaceReadOwner, workspaceId: string, operationId: string)
    : Promise<OrchestrationV2RecoveryActionResult> {
    const params = ownerParams(owner, workspaceId);
    if (!isUuid(operationId)) fail('RECOVERY_INPUT_INVALID');
    return db.transaction(async tx => {
      await tx.query(`SET LOCAL lock_timeout='3000ms'`);
      if (!await deps.canEdit(tx, owner)) fail('RECOVERY_FORBIDDEN');
      await lockWorkspaceLifecycle(tx, owner.tenantId, workspaceId);
      const locked = await tx.query(`SELECT r.id::text AS run_id,r.status AS run_status,r.failure_code,
          w.status AS workspace_status
        ${OWNED_WORKSPACE}
        JOIN lesson_author_workspace_v2_runs r ON r.workspace_id=w.id AND r.tenant_id=w.tenant_id
          AND r.course_id=w.course_id
        WHERE ${OWNED_WHERE} AND w.blueprint_id IS NULL
        FOR UPDATE OF r,w`, params);
      if (locked.rows.length !== 1) fail('RECOVERY_NOT_FOUND');
      const row = locked.rows[0]!;
      const runId = nullableId(row.run_id)!;
      await assertSessionNotDeleting(tx, owner);
      const runStatus = oneOf<string>(row.run_status, RUN_STATUSES);
      if (!ACTIVE_RUN_STATUSES.has(runStatus)) {
        if (runStatus === 'needs_action' && row.failure_code === ORCHESTRATION_V2_RUN_STOPPED_BY_AUTHOR) {
          return { recovery_id: null, run_id: runId, action: 'stop', reopened_task_count: 0,
            workspace_status: oneOf<string>(row.workspace_status, WORKSPACE_STATUSES), replayed: true };
        }
        fail('RUN_STOP_NOT_ACTIVE');
      }
      const stopped = await tx.query(`UPDATE lesson_author_workspace_v2_runs
        SET status='needs_action',failure_code=$2,finished_at=clock_timestamp()
        WHERE id=$1 AND status IN ('planning','executing','finalizing') RETURNING id`,
      [runId, ORCHESTRATION_V2_RUN_STOPPED_BY_AUTHOR]);
      if (stopped.rows.length !== 1) unavailable();
      await syncNeedsActionWorkspace(tx, { id: operationId, run_id: runId, workspace_id: workspaceId,
        tenant_id: owner.tenantId, course_id: owner.courseId }, ORCHESTRATION_V2_RUN_STOPPED_BY_AUTHOR);
      const workspace = await tx.query(`SELECT status FROM lesson_author_workspaces
        WHERE id=$1 AND tenant_id=$2 AND course_id=$3`, [workspaceId, owner.tenantId, owner.courseId]);
      if (workspace.rows.length !== 1) unavailable();
      return { recovery_id: null, run_id: runId, action: 'stop', reopened_task_count: 0,
        workspace_status: oneOf<string>(workspace.rows[0]!.status, WORKSPACE_STATUSES), replayed: false };
    });
  }

  return { snapshot, stop };
}

/** A session being deleted accepts no new work (same rule as edits and launches). */
export async function assertSessionNotDeleting(tx: GenerationJobSql, owner: WorkspaceReadOwner): Promise<void> {
  const deleting = await tx.query(`SELECT id FROM lesson_author_session_deletion_jobs
    WHERE tenant_id=$1 AND course_id=$2 AND requested_by=$3 AND conversation_id=$4
      AND is_terminal=false AND status IN ('queued','running','failed') FOR SHARE`,
  [owner.tenantId, owner.courseId, owner.userId, owner.conversationId]);
  if (deleting.rows.length) fail('RECOVERY_STATE_CHANGED');
}
