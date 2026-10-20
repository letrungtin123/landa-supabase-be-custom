// SQL of the author recovery actions on an orchestration V2 run (stop,
// continue/rewrite, and the read-only snapshot the options are computed from).
//
// Lock order of every write transaction, matching recoverOne and
// lesson-author-orchestration-v2-lock-order.ts: the caller's permission rows
// (canEdit, FOR SHARE), then advisory W (la:v2:workspace) -> run -> workspace
// -> tasks (by ordinal) -> course fence (C) -> AI token rows. Course-scoped
// writes then take C/Q implicitly through their triggers.

import { randomUUID } from 'node:crypto';
import type { GenerationJobDatabase, GenerationJobSql } from '../../shared/lesson-author-generation-job.repository.js';
import {
  lockOrchestrationV2CourseFence,
  withOrchestrationV2TransactionRetry,
  type OrchestrationV2TransientRetryOptions,
} from '../lesson-author-orchestration-v2-lock-order.js';
import {
  ACTIVE_RUN_STATUSES,
  ORCHESTRATION_V2_RUN_STOPPED_BY_AUTHOR,
  OrchestrationV2RecoveryError,
  orchestrationV2RecoveryErrorFor,
  orchestrationV2RecoveryRequestHash,
  planOrchestrationV2Recovery,
  type OrchestrationV2RecoveryErrorCode,
  type OrchestrationV2RecoveryPlan,
  type OrchestrationV2RecoveryRun,
  type OrchestrationV2RecoveryScope,
  type OrchestrationV2RecoveryScopeKind,
  type OrchestrationV2RecoveryTask,
} from './lesson-author-orchestration-v2-recovery.logic.js';
import type { ReconcileUnknown } from '../lesson-author-orchestration-v2-worker-repository.types.js';
import { lockWorkspaceLifecycle, syncNeedsActionWorkspace } from '../worker/lesson-author-orchestration-v2-worker-steps.repository.js';
import type { WorkspaceReadOwner } from '../../workspace/read/lesson-author-workspace-read.repository.js';
import { UUID_PATTERN, isUuid } from '../../../../../utils/uuid.js';

export interface OrchestrationV2RecoverySnapshot {
  run: OrchestrationV2RecoveryRun | null;
  workspace_status: string;
  event_head: number;
  tasks: OrchestrationV2RecoveryTask[];
  course_node: { node_id: string; path: string } | null;
  /** Run authority used to refuse a recovery after the AI settings changed. */
  runtime: { runtime_config_hash: string; model: string } | null;
  /** The requested rewrite scope node, when one was asked for and exists in this workspace. */
  scope_node: OrchestrationV2RecoveryScope | null;
  /** A recovery with this operation id is already recorded (the POST replays it). */
  recorded: boolean;
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

/** Reopens already recorded per task (its rewrite generation), batched for the whole run. */
async function readGenerations(tx: GenerationJobSql, rows: Record<string, unknown>[]): Promise<Map<string, number>> {
  const ids = rows.map(row => nullableId(row.task_id)).filter((value): value is string => value !== null);
  if (!ids.length) return new Map();
  const result = await tx.query(`SELECT task_id::text,count(*)::integer AS reopens
    FROM lesson_author_workspace_v2_recovery_tasks WHERE task_id=ANY($1::uuid[]) GROUP BY task_id`, [ids]);
  return new Map(result.rows.map(row => [nullableId(row.task_id)!, integer(row.reopens, 0, 10)]));
}

const SCOPE_KINDS: readonly OrchestrationV2RecoveryScopeKind[] = ['unit', 'lesson', 'chapter', 'course'];

/** A node of this workspace that can scope a rewrite; null when absent; NOTHING_TO_DO for other kinds. */
async function readScopeNode(tx: GenerationJobSql, owner: WorkspaceReadOwner, workspaceId: string, nodeId: string)
  : Promise<OrchestrationV2RecoveryScope | null> {
  const result = await tx.query(`SELECT id::text AS node_id,kind,canonical_path FROM lesson_author_workspace_nodes
    WHERE workspace_id=$1 AND tenant_id=$2 AND course_id=$3 AND id=$4`, [workspaceId, owner.tenantId, owner.courseId, nodeId]);
  const row = result.rows[0];
  if (!row) return null;
  if (!SCOPE_KINDS.includes(row.kind as OrchestrationV2RecoveryScopeKind)) fail('RECOVERY_NOTHING_TO_DO');
  return { node_id: nullableId(row.node_id)!, kind: row.kind as OrchestrationV2RecoveryScopeKind,
    path: String(row.canonical_path) };
}

export type OrchestrationV2RecoveryRequestInput =
  | { action: 'resume' }
  | { action: 'regenerate'; node_id: string };

export interface OrchestrationV2RecoverInput {
  operation_id: string;
  expected_workspace_revision: number;
  request: OrchestrationV2RecoveryRequestInput;
  /** AI units the caller checked credit for; more under the lock means the run changed. */
  max_ai_unit_count: number;
  estimated_cost_usd: number;
  reconcileUnknown: ReconcileUnknown;
}

interface ApplyRecoveryContext {
  owner: WorkspaceReadOwner;
  workspaceId: string;
  runId: string;
  action: 'resume' | 'regenerate';
  scope: OrchestrationV2RecoveryScope | null;
  plan: OrchestrationV2RecoveryPlan;
  requestHash: string;
  operationId: string;
  estimatedCostUsd: number;
  reconcileUnknown: ReconcileUnknown;
}

/** The writes of one accepted recovery, in guard order (log -> run -> tasks -> dispatch -> workspace -> event). */
async function applyRecovery(tx: GenerationJobSql, context: ApplyRecoveryContext): Promise<string> {
  for (const item of context.plan.items.filter(candidate => candidate.needs_reconcile)) {
    const unknown = await tx.query(`SELECT t.*,r.model FROM lesson_author_workspace_v2_tasks t
      JOIN lesson_author_workspace_v2_runs r ON r.id=t.run_id
      WHERE t.id=$1 AND t.run_id=$2 AND t.status='outcome_unknown' AND t.accounting_state='pending_reconciliation'`,
    [item.task_id, context.runId]);
    if (unknown.rows.length !== 1) fail('RECOVERY_STATE_CHANGED');
    await context.reconcileUnknown(tx, unknown.rows[0]!);
  }
  const shards = await tx.query(`SELECT DISTINCT routing_shard FROM lesson_author_workspace_v2_dispatch_outbox
    WHERE run_id=$1`, [context.runId]);
  if (shards.rows.length !== 1) unavailable();
  const routingShard = integer(shards.rows[0]!.routing_shard, 0, 4_095);

  const recoveryId = randomUUID();
  const inserted = await tx.query(`INSERT INTO lesson_author_workspace_v2_recoveries
      (id,run_id,workspace_id,tenant_id,course_id,action,scope_kind,scope_node_id,requested_by,idempotency_key,
       request_hash,prior_status,prior_failure_code,prior_finished_at,reopened_task_count,ai_unit_count,estimated_cost_usd)
    SELECT $1,r.id,r.workspace_id,r.tenant_id,r.course_id,$2,$3,$4,$5,$6,$7,'needs_action',r.failure_code,r.finished_at,
      $8,$9,$10
    FROM lesson_author_workspace_v2_runs r WHERE r.id=$11 AND r.status='needs_action' RETURNING id::text`,
  [recoveryId, context.action, context.scope?.kind ?? null, context.scope?.node_id ?? null, context.owner.userId,
    context.operationId, context.requestHash, context.plan.items.length, context.plan.ai_unit_count,
    context.action === 'regenerate' ? context.estimatedCostUsd : 0, context.runId]);
  if (inserted.rows.length !== 1) unavailable();
  const reopenRows = context.plan.items.map(item => ({ task_id: item.task_id, generation: item.generation,
    prior_status: item.prior_status, prior_failure_code: item.prior_failure_code,
    prior_attempt_count: item.prior_attempt_count, prior_dispatch_epoch: item.prior_dispatch_epoch,
    reopen_epoch: item.reopen_epoch, reopened_status: item.reopened_status,
    prior_ai_reservation_id: item.prior_ai_reservation_id }));
  const logged = await tx.query(`INSERT INTO lesson_author_workspace_v2_recovery_tasks
      (recovery_id,task_id,run_id,workspace_id,tenant_id,course_id,generation,prior_status,prior_failure_code,
       prior_attempt_count,prior_dispatch_epoch,reopen_epoch,reopened_status,prior_ai_reservation_id)
    SELECT $1,x.task_id,$2,$3,$4,$5,x.generation,x.prior_status,x.prior_failure_code,x.prior_attempt_count,
      x.prior_dispatch_epoch,x.reopen_epoch,x.reopened_status,x.prior_ai_reservation_id
    FROM jsonb_to_recordset($6::jsonb) AS x(task_id uuid,generation smallint,prior_status text,prior_failure_code text,
      prior_attempt_count smallint,prior_dispatch_epoch integer,reopen_epoch integer,reopened_status text,
      prior_ai_reservation_id uuid)
    RETURNING task_id::text`, [recoveryId, context.runId, context.workspaceId, context.owner.tenantId,
    context.owner.courseId, JSON.stringify(reopenRows)]);
  if (logged.rows.length !== reopenRows.length) unavailable();

  const resumed = await tx.query(`UPDATE lesson_author_workspace_v2_runs
    SET status='executing',failure_code=NULL,finished_at=NULL
    WHERE id=$1 AND status='needs_action' RETURNING id`, [context.runId]);
  if (resumed.rows.length !== 1) unavailable();
  const reopened = await tx.query(`UPDATE lesson_author_workspace_v2_tasks t SET status=x.reopened_status,
      attempt_count=0,dispatch_epoch=x.reopen_epoch,failure_code=NULL,finished_at=NULL,started_at=NULL,
      deadline_at=NULL,dispatch_started_at=NULL,ai_reservation_id=NULL,accounting_state='not_required',
      observed_usage='{}'::jsonb,result_hash=NULL,validation_contract=NULL,next_attempt_at=clock_timestamp()
    FROM jsonb_to_recordset($2::jsonb) AS x(task_id uuid,prior_status text,prior_dispatch_epoch integer,
      reopen_epoch integer,reopened_status text)
    WHERE t.run_id=$1 AND t.id=x.task_id AND t.status=x.prior_status AND t.dispatch_epoch=x.prior_dispatch_epoch
    RETURNING t.id::text,t.status,t.dispatch_epoch`, [context.runId, JSON.stringify(reopenRows)]);
  if (reopened.rows.length !== reopenRows.length) unavailable();
  const queued = context.plan.items.filter(item => item.reopened_status === 'queued');
  if (queued.length) {
    const outbox = await tx.query(`INSERT INTO lesson_author_workspace_v2_dispatch_outbox
        (id,run_id,workspace_id,tenant_id,course_id,task_id,dispatch_epoch,routing_shard)
      SELECT x.id,$1,$2,$3,$4,x.task_id,x.dispatch_epoch,$5
      FROM jsonb_to_recordset($6::jsonb) AS x(id uuid,task_id uuid,dispatch_epoch integer) RETURNING id`,
    [context.runId, context.workspaceId, context.owner.tenantId, context.owner.courseId, routingShard,
      JSON.stringify(queued.map(item => ({ id: randomUUID(), task_id: item.task_id, dispatch_epoch: item.reopen_epoch })))]);
    if (outbox.rows.length !== queued.length) unavailable();
  }
  const workspace = await tx.query(`UPDATE lesson_author_workspaces SET status='drafting',updated_at=clock_timestamp()
    WHERE id=$1 AND tenant_id=$2 AND course_id=$3 AND status='needs_action' RETURNING status`,
  [context.workspaceId, context.owner.tenantId, context.owner.courseId]);
  if (workspace.rows.length !== 1) unavailable();
  const event = await tx.query(`INSERT INTO lesson_author_workspace_events
      (workspace_id,tenant_id,course_id,event_kind,operation_id)
    VALUES($1,$2,$3,'run_resumed',$4) RETURNING sequence`,
  [context.workspaceId, context.owner.tenantId, context.owner.courseId, context.operationId]);
  if (event.rows.length !== 1) unavailable();
  return recoveryId;
}

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
  async function snapshot(owner: WorkspaceReadOwner, workspaceId: string,
    options: { scopeNodeId?: string; operationId?: string } = {}): Promise<OrchestrationV2RecoverySnapshot> {
    const params = ownerParams(owner, workspaceId);
    if ((options.scopeNodeId !== undefined && !isUuid(options.scopeNodeId))
      || (options.operationId !== undefined && !isUuid(options.operationId))) fail('RECOVERY_INPUT_INVALID');
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
      const recorded = options.operationId === undefined ? false : (await tx.query(`SELECT 1 AS recorded
        FROM lesson_author_workspace_v2_recoveries WHERE workspace_id=$1 AND idempotency_key=$2`,
      [workspaceId, options.operationId])).rows.length > 0;
      const scopeNode = options.scopeNodeId === undefined ? null
        : await readScopeNode(tx, owner, workspaceId, options.scopeNodeId);
      if (!run) {
        return { run: null, workspace_status: workspaceStatus, event_head: eventHead, tasks: [],
          course_node: null, runtime: null, scope_node: scopeNode, recorded };
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
        tasks: readRecoveryTasks(tasks.rows, dependencies.rows, await readGenerations(tx, tasks.rows)),
        course_node: courseRow ? { node_id: nullableId(courseRow.node_id)!, path: String(courseRow.canonical_path) } : null,
        runtime: { runtime_config_hash: String(row.runtime_config_hash), model: String(row.model) },
        scope_node: scopeNode, recorded,
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

  /**
   * Continue or rewrite a stopped run in ONE transaction: settle unknown
   * outcomes being reopened (upper bound, exactly once), record the recovery
   * and every task reopen, move the run back to executing, reopen the tasks
   * with a fresh attempt budget at epoch + 1, dispatch the runnable ones,
   * resume the workspace and append run_resumed. The SQL guards re-check each
   * step and a deferred check refuses a partial commit. The same operation id
   * replays the stored result; with another body it is refused.
   */
  async function recover(owner: WorkspaceReadOwner, workspaceId: string, input: OrchestrationV2RecoverInput)
    : Promise<OrchestrationV2RecoveryActionResult> {
    const params = ownerParams(owner, workspaceId);
    const scopeNodeId = input.request.action === 'regenerate' ? input.request.node_id : null;
    if (!isUuid(input.operation_id) || (scopeNodeId !== null && !isUuid(scopeNodeId))
      || !Number.isSafeInteger(input.expected_workspace_revision) || input.expected_workspace_revision < 0
      || !Number.isSafeInteger(input.max_ai_unit_count) || input.max_ai_unit_count < 0
      || !Number.isFinite(input.estimated_cost_usd) || input.estimated_cost_usd < 0) fail('RECOVERY_INPUT_INVALID');
    const action = input.request.action;
    const requestHash = orchestrationV2RecoveryRequestHash({ action, node_id: scopeNodeId,
      expected_workspace_revision: input.expected_workspace_revision });
    return db.transaction(async tx => {
      await tx.query(`SET LOCAL lock_timeout='3000ms'`);
      if (!await deps.canEdit(tx, owner)) fail('RECOVERY_FORBIDDEN');
      await lockWorkspaceLifecycle(tx, owner.tenantId, workspaceId);
      const locked = await tx.query(`SELECT r.id::text AS run_id,r.status AS run_status,r.failure_code,
          r.finished_at::text AS finished_at,r.manifest_hash,w.status AS workspace_status,w.event_head,
          EXISTS(SELECT 1 FROM lesson_author_workspace_v2_completion_receipts receipt WHERE receipt.run_id=r.id)
            AS completion_receipt,
          EXISTS(SELECT 1 FROM lesson_author_workspace_v2_review_receipts review WHERE review.run_id=r.id)
            AS review_receipt
        ${OWNED_WORKSPACE}
        JOIN lesson_author_workspace_v2_runs r ON r.workspace_id=w.id AND r.tenant_id=w.tenant_id
          AND r.course_id=w.course_id
        WHERE ${OWNED_WHERE} AND w.blueprint_id IS NULL
        FOR UPDATE OF r,w`, params);
      if (locked.rows.length !== 1) fail('RECOVERY_NOT_FOUND');
      const head = locked.rows[0]!;
      const run = readRecoveryRun(head)!;

      const recorded = await tx.query(`SELECT id::text,run_id::text,action,request_hash,requested_by::text,
          reopened_task_count FROM lesson_author_workspace_v2_recoveries
        WHERE workspace_id=$1 AND idempotency_key=$2`, [workspaceId, input.operation_id]);
      if (recorded.rows.length) {
        const prior = recorded.rows[0]!;
        if (prior.request_hash !== requestHash || prior.action !== action || prior.run_id !== run.run_id
          || prior.requested_by !== owner.userId) fail('RECOVERY_IDEMPOTENCY_CONFLICT');
        return { recovery_id: nullableId(prior.id)!, run_id: run.run_id, action,
          reopened_task_count: integer(prior.reopened_task_count, 1, 32_768),
          workspace_status: run.workspace_status, replayed: true };
      }
      await assertSessionNotDeleting(tx, owner);
      if (run.event_head !== input.expected_workspace_revision) fail('RECOVERY_STATE_CHANGED');

      const tasks = await tx.query(`${RECOVERY_TASKS_SQL} FOR UPDATE OF t`,
        [run.run_id, workspaceId, owner.tenantId, owner.courseId]);
      const dependencies = await tx.query(RECOVERY_DEPENDENCIES_SQL, [run.run_id]);
      const snapshotTasks = readRecoveryTasks(tasks.rows, dependencies.rows, await readGenerations(tx, tasks.rows));
      const scope = scopeNodeId === null ? null : await readScopeNode(tx, owner, workspaceId, scopeNodeId);
      if (scopeNodeId !== null && !scope) fail('RECOVERY_NOT_FOUND');
      const planned = planOrchestrationV2Recovery({ run, tasks: snapshotTasks,
        request: scope ? { action: 'regenerate', scope } : { action: 'resume' } });
      if (!planned.ok) fail(orchestrationV2RecoveryErrorFor(planned.reason));
      const plan = planned.ok ? planned.plan : fail('RECOVERY_UNAVAILABLE');
      if (plan.ai_unit_count > input.max_ai_unit_count) fail('RECOVERY_STATE_CHANGED');

      // Course fence (C) before any AI token write and before reading other drafts of this course.
      await lockOrchestrationV2CourseFence(tx, owner.courseId);
      const otherActive = await tx.query(`SELECT id FROM lesson_author_workspaces
        WHERE tenant_id=$1 AND course_id=$2 AND requested_by=$3 AND id<>$4
          AND status IN ('queued','designing','drafting') LIMIT 1`,
      [owner.tenantId, owner.courseId, owner.userId, workspaceId]);
      if (otherActive.rows.length) fail('RECOVERY_OTHER_RUN_ACTIVE');

      const recoveryId = await applyRecovery(tx, { owner, workspaceId, runId: run.run_id, action, scope, plan, requestHash,
        operationId: input.operation_id, estimatedCostUsd: input.estimated_cost_usd,
        reconcileUnknown: input.reconcileUnknown });
      return { recovery_id: recoveryId, run_id: run.run_id, action, reopened_task_count: plan.items.length,
        workspace_status: 'drafting', replayed: false };
    });
  }

  return { snapshot, stop, recover };
}

/** A session being deleted accepts no new work (same rule as edits and launches). */
export async function assertSessionNotDeleting(tx: GenerationJobSql, owner: WorkspaceReadOwner): Promise<void> {
  const deleting = await tx.query(`SELECT id FROM lesson_author_session_deletion_jobs
    WHERE tenant_id=$1 AND course_id=$2 AND requested_by=$3 AND conversation_id=$4
      AND is_terminal=false AND status IN ('queued','running','failed') FOR SHARE`,
  [owner.tenantId, owner.courseId, owner.userId, owner.conversationId]);
  if (deleting.rows.length) fail('RECOVERY_STATE_CHANGED');
}
