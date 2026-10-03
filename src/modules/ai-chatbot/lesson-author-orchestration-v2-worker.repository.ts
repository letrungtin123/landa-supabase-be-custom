import { randomUUID } from 'node:crypto';
import type { GenerationJobDatabase, GenerationJobSql } from './lesson-author-generation-job.repository.js';
import type { OrchestrationV2DispatchEnvelope } from './lesson-author-orchestration-v2-dispatch.logic.js';
import type { OrchestrationV2TaskKind } from './lesson-author-orchestration-v2.logic.js';
import {
  assertOrchestrationV2WorkerLimits,
  isOrchestrationV2ProviderTask,
  orchestrationV2ObservedUsage,
  type OrchestrationV2WorkerLimits,
} from './lesson-author-orchestration-v2-worker.logic.js';

export interface OrchestrationV2TaskLease {
  task_id: string;
  run_id: string;
  workspace_id: string;
  tenant_id: string;
  course_id: string;
  task_key: string;
  kind: OrchestrationV2TaskKind;
  chapter_key: string | null;
  node_id: string | null;
  contract_hash: string;
  input_context_hash: string | null;
  source_snapshot_id: string;
  source_snapshot_hash: string;
  runtime_config_hash: string;
  model: string;
  locale: 'vi' | 'en';
  max_output_tokens: number;
  provider_max_attempts: number;
  execution_budget_ms: number;
  lease_token: string;
  dispatch_epoch: number;
  routing_shard: number;
  ai_reservation_id: string | null;
}

export type OrchestrationV2ClaimResult =
  | { disposition: 'claimed'; lease: OrchestrationV2TaskLease }
  | { disposition: 'duplicate' | 'deferred' | 'stale' };

export interface OrchestrationV2ArtifactCommit {
  artifact_kind: 'source_catalog' | 'course_skeleton' | 'chapter_blueprint' | 'architecture_validation'
    | 'inventory_receipt' | 'unit_baseline' | 'chapter_receipt' | 'course_receipt';
  artifact_hash: string;
  payload: Record<string, unknown>;
  validation_contract: string;
}

export class OrchestrationV2WorkerRepositoryError extends Error {
  constructor(readonly code:
    | 'ORCHESTRATION_V2_TASK_LEASE_LOST'
    | 'ORCHESTRATION_V2_TASK_STATE_INVALID'
    | 'ORCHESTRATION_V2_TASK_WRITE_UNCONFIRMED') {
    super(code);
    this.name = 'OrchestrationV2WorkerRepositoryError';
  }
}

type ReserveProvider = (tx: GenerationJobSql, task: Record<string, unknown>) => Promise<string>;
export type OrchestrationV2ProviderUsageSource = 'provider' | 'reserved_upper_bound';
type SettleProvider = (tx: GenerationJobSql, lease: OrchestrationV2TaskLease,
  usage: Readonly<Record<string, number>>, usageSource?: OrchestrationV2ProviderUsageSource) => Promise<void>;
type HoldUnknown = (tx: GenerationJobSql, task: Record<string, unknown>) => Promise<void>;
type ReconcileUnknown = (tx: GenerationJobSql, task: Record<string, unknown>) => Promise<void>;
export type ReleaseUndispatched = (tx: GenerationJobSql, task: Record<string, unknown>) => Promise<void>;
type ReleaseRejected = (tx: GenerationJobSql, task: Record<string, unknown>) => Promise<void>;
export type OrchestrationV2ClaimFailureDisposition = 'requeued' | 'failed' | 'outcome_unknown' | 'stale';
export interface OrchestrationV2SuccessHooks {
  beforeSuccess?(tx: GenerationJobSql, task: Record<string, unknown>): Promise<void>;
  afterSuccess?(tx: GenerationJobSql, task: Record<string, unknown>): Promise<void>;
}
export type OrchestrationV2ProviderCompletion =
  | Readonly<{ mode: OrchestrationV2ProviderUsageSource }>
  | Readonly<{ mode: 'deterministic_fallback'; releaseUndispatched: ReleaseUndispatched }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const providerKinds = `('course_skeleton','chapter_blueprint','generate_unit')`;
const terminal = new Set(['succeeded', 'failed', 'timed_out', 'outcome_unknown', 'canceled']);
const activeRun = new Set(['planning', 'executing', 'finalizing']);
const fail = (code: OrchestrationV2WorkerRepositoryError['code']): never => {
  throw new OrchestrationV2WorkerRepositoryError(code);
};

async function lockWorkspaceLifecycle(
  tx: GenerationJobSql,
  tenantId: unknown,
  workspaceId: unknown,
): Promise<void> {
  if (typeof tenantId !== 'string' || typeof workspaceId !== 'string'
    || !UUID.test(tenantId) || !UUID.test(workspaceId)) fail('ORCHESTRATION_V2_TASK_STATE_INVALID');
  // claimExact takes global -> tenant -> workspace. Lifecycle commits only
  // need the final workspace fence; they never wait for global/tenant, so this
  // cannot form a lock cycle with a claimant and serializes run/task changes.
  await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('la:v2:workspace:'||$1::text,0))`,
    [workspaceId]);
}

async function syncNeedsActionWorkspace(
  tx: GenerationJobSql,
  task: Record<string, unknown>,
): Promise<void> {
  await tx.query(`UPDATE lesson_author_workspace_v2_tasks SET status='canceled',
      failure_code='RUN_STOPPED_AFTER_TASK_FAILURE',finished_at=clock_timestamp()
    WHERE run_id=$1 AND status IN ('blocked','queued')`, [task.run_id]);
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
  const operationId = typeof task.id === 'string' && UUID.test(task.id) ? task.id : task.run_id;
  const event = await tx.query(`INSERT INTO lesson_author_workspace_events
      (workspace_id,tenant_id,course_id,event_kind,operation_id)
    VALUES($1,$2,$3,'run_needs_action',$4) RETURNING sequence`,
  [task.workspace_id, task.tenant_id, task.course_id, operationId]);
  if (event.rows.length !== 1) fail('ORCHESTRATION_V2_TASK_WRITE_UNCONFIRMED');
}

async function stopRunAfterTerminalTask(
  tx: GenerationJobSql,
  task: Record<string, unknown>,
): Promise<void> {
  const failureCode = typeof task.failure_code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(task.failure_code)
    ? task.failure_code
    : 'TASK_FAILED';
  const isolatedUnitFailure = task.kind === 'generate_unit'
    && !['AI_PROVIDER_AUTH_REJECTED'].includes(failureCode);
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

function leaseFrom(row: Record<string, unknown>): OrchestrationV2TaskLease {
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
    routing_shard: Number(row.routing_shard),
    ai_reservation_id: row.ai_reservation_id === null ? null : String(row.ai_reservation_id),
  };
  if (![lease.task_id, lease.run_id, lease.workspace_id, lease.tenant_id, lease.source_snapshot_id, lease.lease_token]
    .every(value => UUID.test(value)) || !HASH.test(lease.contract_hash) || !HASH.test(lease.source_snapshot_hash)
    || !HASH.test(lease.runtime_config_hash)
    || (lease.input_context_hash !== null && !HASH.test(lease.input_context_hash))
    || !Number.isSafeInteger(lease.routing_shard) || lease.routing_shard < 0 || lease.routing_shard > 4_095
    || !lease.course_id || !lease.task_key || !lease.model) fail('ORCHESTRATION_V2_TASK_STATE_INVALID');
  return Object.freeze(lease);
}

export function createOrchestrationV2WorkerRepository(db: GenerationJobDatabase, id: () => string = randomUUID) {
  async function claimExact(
    envelope: OrchestrationV2DispatchEnvelope,
    limitsInput: OrchestrationV2WorkerLimits,
    reserveProvider: ReserveProvider,
  ): Promise<OrchestrationV2ClaimResult> {
    const limits = assertOrchestrationV2WorkerLimits(limitsInput);
    return db.transaction(async tx => {
      const identity = await tx.query(`SELECT o.tenant_id::text,o.workspace_id::text
        FROM lesson_author_workspace_v2_dispatch_outbox o
        WHERE o.id=$1 AND o.run_id=$2 AND o.task_id=$3 AND o.dispatch_epoch=$4 AND o.routing_shard=$5`,
      [envelope.outbox_id, envelope.run_id, envelope.task_id, envelope.dispatch_epoch, envelope.routing_shard]);
      if (identity.rows.length !== 1) return { disposition: 'stale' };
      const tenantId = String(identity.rows[0].tenant_id), workspaceId = String(identity.rows[0].workspace_id);
      if (!UUID.test(tenantId) || !UUID.test(workspaceId)) fail('ORCHESTRATION_V2_TASK_STATE_INVALID');

      // Every claimant takes these transaction locks in the same order. The
      // short global lock makes global/provider admission exact across replicas;
      // provider calls happen only after COMMIT and never hold this lock.
      await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('la:v2:global',0)),
        pg_advisory_xact_lock(hashtextextended('la:v2:tenant:'||$1,0)),
        pg_advisory_xact_lock(hashtextextended('la:v2:workspace:'||$2,0))`, [tenantId, workspaceId]);
      const locked = await tx.query(`SELECT t.*,r.source_snapshot_id::text,s.source_snapshot_hash,r.runtime_config_hash,r.model,
          w.content_locale AS locale,r.status AS run_status,r.tenant_concurrency_limit,r.workspace_concurrency_limit,
          o.status AS outbox_status,o.routing_shard
        FROM lesson_author_workspace_v2_dispatch_outbox o
        JOIN lesson_author_workspace_v2_tasks t ON t.id=o.task_id AND t.run_id=o.run_id
        JOIN lesson_author_workspace_v2_runs r ON r.id=t.run_id AND r.workspace_id=t.workspace_id
        JOIN lesson_author_workspace_source_snapshots s ON s.id=r.source_snapshot_id
        JOIN lesson_author_workspaces w ON w.id=t.workspace_id AND w.tenant_id=t.tenant_id AND w.course_id=t.course_id
        WHERE o.id=$1 AND o.run_id=$2 AND o.task_id=$3 AND o.dispatch_epoch=$4 AND o.routing_shard=$5
        FOR UPDATE OF r,t,o`,
      [envelope.outbox_id, envelope.run_id, envelope.task_id, envelope.dispatch_epoch, envelope.routing_shard]);
      const task = locked.rows[0];
      if (!task) return { disposition: 'stale' };
      if (task.outbox_status === 'consumed') return { disposition: 'duplicate' };
      // RabbitMQ may deliver immediately after broker confirm while the
      // dispatcher is still committing the published CAS. Requeue instead of
      // acknowledging that valid delivery as stale; the durable task identity
      // still prevents duplicate paid work.
      if (task.outbox_status === 'publishing') return { disposition: 'deferred' };
      if (task.outbox_status !== 'published') return { disposition: 'stale' };
      if (task.status === 'running' || terminal.has(String(task.status))) {
        const consumed = await tx.query(`UPDATE lesson_author_workspace_v2_dispatch_outbox
          SET status='consumed',consumed_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE id=$1 AND status='published' RETURNING id`, [envelope.outbox_id]);
        if (consumed.rows.length !== 1) fail('ORCHESTRATION_V2_TASK_WRITE_UNCONFIRMED');
        return { disposition: 'duplicate' };
      }
      if (task.status !== 'queued' || Number(task.dispatch_epoch) !== envelope.dispatch_epoch
        || !['planning', 'executing'].includes(String(task.run_status))
        || Number(task.attempt_count) >= Number(task.max_attempts)) return { disposition: 'stale' };
      const unmet = await tx.query(`SELECT count(*)::integer AS count
        FROM lesson_author_workspace_v2_dependencies d
        JOIN lesson_author_workspace_v2_tasks p ON p.id=d.depends_on_task_id AND p.run_id=d.run_id
        WHERE d.run_id=$1 AND d.task_id=$2 AND p.status<>'succeeded'`, [envelope.run_id, envelope.task_id]);
      if (Number(unmet.rows[0]?.count) !== 0) return { disposition: 'stale' };
      const running = await tx.query(`SELECT count(*)::integer AS global_running,
          count(*) FILTER(WHERE kind IN ${providerKinds})::integer AS provider_running,
          count(*) FILTER(WHERE tenant_id=$1)::integer AS tenant_running,
          count(*) FILTER(WHERE workspace_id=$2)::integer AS workspace_running
        FROM lesson_author_workspace_v2_tasks WHERE status='running'`, [tenantId, workspaceId]);
      const counts = running.rows[0] ?? {};
      const provider = isOrchestrationV2ProviderTask(String(task.kind) as OrchestrationV2TaskKind);
      if (Number(counts.global_running) >= limits.global_concurrency_limit
        || (provider && Number(counts.provider_running) >= limits.provider_concurrency_limit)
        || Number(counts.tenant_running) >= Number(task.tenant_concurrency_limit)
        || Number(counts.workspace_running) >= Number(task.workspace_concurrency_limit)) {
        return { disposition: 'deferred' };
      }
      const reservationId = provider ? await reserveProvider(tx, task) : null;
      if (provider && !UUID.test(String(reservationId))) fail('ORCHESTRATION_V2_TASK_STATE_INVALID');
      const leaseToken = id();
      if (!UUID.test(leaseToken)) fail('ORCHESTRATION_V2_TASK_STATE_INVALID');
      const claimed = await tx.query(`UPDATE lesson_author_workspace_v2_tasks SET status='running',
          attempt_count=attempt_count+1,dispatch_epoch=dispatch_epoch+1,lease_token=$3::uuid,
          heartbeat_at=claim_clock.claimed_at,
          lease_expires_at=claim_clock.claimed_at+($4::integer*interval '1 second'),
          deadline_at=claim_clock.claimed_at+(execution_budget_ms*interval '1 millisecond'),
          started_at=coalesce(started_at,claim_clock.claimed_at),ai_reservation_id=$5::uuid,
          accounting_state=CASE WHEN $5::uuid IS NULL THEN 'not_required' ELSE 'reserved' END
        FROM (SELECT clock_timestamp() AS claimed_at) claim_clock
        WHERE id=$1 AND run_id=$2 AND status='queued' AND dispatch_epoch=$6 AND attempt_count<max_attempts
        RETURNING *`, [envelope.task_id, envelope.run_id, leaseToken, limits.lease_seconds, reservationId, envelope.dispatch_epoch]);
      if (claimed.rows.length !== 1) fail('ORCHESTRATION_V2_TASK_WRITE_UNCONFIRMED');
      const consumed = await tx.query(`UPDATE lesson_author_workspace_v2_dispatch_outbox
        SET status='consumed',consumed_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE id=$1 AND status='published' RETURNING id`, [envelope.outbox_id]);
      if (consumed.rows.length !== 1) fail('ORCHESTRATION_V2_TASK_WRITE_UNCONFIRMED');
      return { disposition: 'claimed', lease: leaseFrom({ ...task, ...claimed.rows[0] }) };
    });
  }

  async function renew(lease: OrchestrationV2TaskLease, leaseSeconds: number): Promise<boolean> {
    assertOrchestrationV2WorkerLimits({ global_concurrency_limit: 1, provider_concurrency_limit: 1, lease_seconds: leaseSeconds });
    return db.transaction(async tx => {
      const result = await tx.query(`UPDATE lesson_author_workspace_v2_tasks SET heartbeat_at=clock_timestamp(),
          lease_expires_at=LEAST(deadline_at,clock_timestamp()+($4::integer*interval '1 second'))
        WHERE id=$1 AND run_id=$2 AND status='running' AND lease_token=$3::uuid
          AND lease_expires_at>clock_timestamp() AND deadline_at>clock_timestamp() RETURNING id`,
      [lease.task_id, lease.run_id, lease.lease_token, leaseSeconds]);
      return result.rows.length === 1;
    });
  }

  async function markProviderDispatched(lease: OrchestrationV2TaskLease): Promise<void> {
    if (!isOrchestrationV2ProviderTask(lease.kind) || !lease.ai_reservation_id) fail('ORCHESTRATION_V2_TASK_STATE_INVALID');
    await db.transaction(async tx => {
      const result = await tx.query(`UPDATE lesson_author_workspace_v2_tasks SET dispatch_started_at=clock_timestamp()
        WHERE id=$1 AND run_id=$2 AND status='running' AND lease_token=$3::uuid
          AND lease_expires_at>clock_timestamp() AND deadline_at>clock_timestamp()
          AND dispatch_started_at IS NULL AND accounting_state='reserved' RETURNING id`,
      [lease.task_id, lease.run_id, lease.lease_token]);
      if (result.rows.length !== 1) fail('ORCHESTRATION_V2_TASK_LEASE_LOST');
    });
  }

  async function succeed(
    lease: OrchestrationV2TaskLease,
    resultHash: string,
    validationContract: string,
    observedUsage: unknown,
    artifact: OrchestrationV2ArtifactCommit | null,
    settleProvider: SettleProvider,
    hooks: OrchestrationV2SuccessHooks = {},
    providerCompletion: OrchestrationV2ProviderCompletion = { mode: 'provider' },
  ): Promise<void> {
    if (!HASH.test(resultHash) || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(validationContract)) {
      fail('ORCHESTRATION_V2_TASK_STATE_INVALID');
    }
    const usage = orchestrationV2ObservedUsage(observedUsage);
    await db.transaction(async tx => {
      await lockWorkspaceLifecycle(tx, lease.tenant_id, lease.workspace_id);
      const locked = await tx.query(`SELECT * FROM lesson_author_workspace_v2_tasks
        WHERE id=$1 AND run_id=$2 AND status='running' AND lease_token=$3::uuid
          AND lease_expires_at>clock_timestamp() AND deadline_at>clock_timestamp() FOR UPDATE`,
      [lease.task_id, lease.run_id, lease.lease_token]);
      const task = locked.rows[0];
      if (!task) fail('ORCHESTRATION_V2_TASK_LEASE_LOST');
      const provider = isOrchestrationV2ProviderTask(lease.kind);
      if (provider) {
        if (task.accounting_state !== 'reserved') fail('ORCHESTRATION_V2_TASK_STATE_INVALID');
        if (providerCompletion.mode === 'deterministic_fallback') {
          if (task.dispatch_started_at) fail('ORCHESTRATION_V2_TASK_STATE_INVALID');
          await providerCompletion.releaseUndispatched(tx, task);
        } else {
          if (!task.dispatch_started_at) fail('ORCHESTRATION_V2_TASK_STATE_INVALID');
          await settleProvider(tx, lease, usage, providerCompletion.mode);
        }
      }
      if (artifact) {
        if (!HASH.test(artifact.artifact_hash) || artifact.artifact_hash !== resultHash
          || artifact.validation_contract !== validationContract) fail('ORCHESTRATION_V2_TASK_STATE_INVALID');
        const inserted = await tx.query(`INSERT INTO lesson_author_workspace_v2_artifacts
            (run_id,workspace_id,tenant_id,course_id,task_id,artifact_kind,artifact_hash,payload,validation_contract)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) RETURNING id`,
        [lease.run_id, lease.workspace_id, lease.tenant_id, lease.course_id, lease.task_id,
          artifact.artifact_kind, artifact.artifact_hash, JSON.stringify(artifact.payload), artifact.validation_contract]);
        if (inserted.rows.length !== 1) fail('ORCHESTRATION_V2_TASK_WRITE_UNCONFIRMED');
      }
      await hooks.beforeSuccess?.(tx, task);
      const completed = await tx.query(`UPDATE lesson_author_workspace_v2_tasks SET status='succeeded',
          result_hash=$4,validation_contract=$5,observed_usage=$6::jsonb,
          accounting_state=CASE WHEN $7::boolean AND $8::text<>'deterministic_fallback'
            THEN 'settled' ELSE 'not_required' END,
          ai_reservation_id=CASE WHEN $8::text='deterministic_fallback' THEN NULL ELSE ai_reservation_id END,
          finished_at=clock_timestamp(),lease_token=NULL,heartbeat_at=NULL,lease_expires_at=NULL
        WHERE id=$1 AND run_id=$2 AND status='running' AND lease_token=$3::uuid RETURNING id`,
      [lease.task_id, lease.run_id, lease.lease_token, resultHash, validationContract,
        JSON.stringify(usage), provider, providerCompletion.mode]);
      if (completed.rows.length !== 1) fail('ORCHESTRATION_V2_TASK_WRITE_UNCONFIRMED');
      await hooks.afterSuccess?.(tx, task);
    });
  }

  async function failProviderRejected(
    lease: OrchestrationV2TaskLease,
    failureCode: 'AI_PROVIDER_REQUEST_REJECTED' | 'AI_PROVIDER_AUTH_REJECTED',
    releaseRejected: ReleaseRejected,
  ): Promise<void> {
    if (!isOrchestrationV2ProviderTask(lease.kind) || !lease.ai_reservation_id) {
      fail('ORCHESTRATION_V2_TASK_STATE_INVALID');
    }
    await db.transaction(async tx => {
      await lockWorkspaceLifecycle(tx, lease.tenant_id, lease.workspace_id);
      const locked = await tx.query(`SELECT * FROM lesson_author_workspace_v2_tasks
        WHERE id=$1 AND run_id=$2 AND status='running' AND lease_token=$3::uuid
          AND dispatch_started_at IS NOT NULL AND accounting_state='reserved' FOR UPDATE`,
      [lease.task_id, lease.run_id, lease.lease_token]);
      const task = locked.rows[0];
      if (!task) fail('ORCHESTRATION_V2_TASK_LEASE_LOST');
      await releaseRejected(tx, task);
      const failed = await tx.query(`UPDATE lesson_author_workspace_v2_tasks SET status='failed',
          failure_code=$4,finished_at=clock_timestamp(),lease_token=NULL,heartbeat_at=NULL,lease_expires_at=NULL,
          ai_reservation_id=NULL,accounting_state='not_required'
        WHERE id=$1 AND run_id=$2 AND status='running' AND lease_token=$3::uuid RETURNING id`,
      [lease.task_id, lease.run_id, lease.lease_token, failureCode]);
      if (failed.rows.length !== 1) fail('ORCHESTRATION_V2_TASK_WRITE_UNCONFIRMED');
      await stopRunAfterTerminalTask(tx, { ...task, status: 'failed', failure_code: failureCode });
    });
  }

  /**
   * Finalize an execution exception while the exact claim lease is still
   * authoritative. Pre-dispatch failures are safe to release/requeue; once a
   * provider dispatch marker exists the outcome is ambiguous and must enter
   * reconciliation instead of being blindly replayed.
   */
  async function recoverClaimFailure(
    lease: OrchestrationV2TaskLease,
    failureCode: string,
    releaseUndispatched: ReleaseUndispatched,
    holdUnknown: HoldUnknown,
    reconcileUnknown?: ReconcileUnknown,
  ): Promise<OrchestrationV2ClaimFailureDisposition> {
    if (!/^[A-Z][A-Z0-9_]{0,99}$/.test(failureCode)) fail('ORCHESTRATION_V2_TASK_STATE_INVALID');
    return db.transaction(async tx => {
      await lockWorkspaceLifecycle(tx, lease.tenant_id, lease.workspace_id);
      const run = await tx.query(`SELECT status FROM lesson_author_workspace_v2_runs
        WHERE id=$1 AND workspace_id=$2 AND tenant_id=$3 AND course_id=$4 FOR UPDATE`,
      [lease.run_id, lease.workspace_id, lease.tenant_id, lease.course_id]);
      if (run.rows.length !== 1) fail('ORCHESTRATION_V2_TASK_WRITE_UNCONFIRMED');
      const runIsActive = activeRun.has(String(run.rows[0]?.status));
      const locked = await tx.query(`SELECT t.*,coalesce(o.routing_shard,0)::integer AS routing_shard
        FROM lesson_author_workspace_v2_tasks t
        LEFT JOIN LATERAL (SELECT routing_shard FROM lesson_author_workspace_v2_dispatch_outbox
          WHERE task_id=t.id ORDER BY dispatch_epoch DESC LIMIT 1) o ON true
        WHERE t.id=$1 AND t.run_id=$2 AND t.status='running' AND t.lease_token=$3::uuid
        FOR UPDATE OF t`, [lease.task_id, lease.run_id, lease.lease_token]);
      const task = locked.rows[0];
      if (!task) return 'stale';

      if (task.dispatch_started_at) {
        if (!isOrchestrationV2ProviderTask(String(task.kind) as OrchestrationV2TaskKind)
          || !task.ai_reservation_id || task.accounting_state !== 'reserved') {
          fail('ORCHESTRATION_V2_TASK_STATE_INVALID');
        }
        await holdUnknown(tx, task);
        const unknown = await tx.query(`UPDATE lesson_author_workspace_v2_tasks SET status='outcome_unknown',
            accounting_state='pending_reconciliation',failure_code='PROVIDER_OUTCOME_UNKNOWN',finished_at=clock_timestamp(),
            lease_token=NULL,heartbeat_at=NULL,lease_expires_at=NULL
          WHERE id=$1 AND run_id=$2 AND status='running' AND lease_token=$3::uuid RETURNING id`,
        [lease.task_id, lease.run_id, lease.lease_token]);
        if (unknown.rows.length !== 1) fail('ORCHESTRATION_V2_TASK_WRITE_UNCONFIRMED');
        if (runIsActive && reconcileUnknown && Number(task.attempt_count) < Number(task.max_attempts)) {
          const unknownTask = { ...task, status: 'outcome_unknown',
            accounting_state: 'pending_reconciliation', failure_code: 'PROVIDER_OUTCOME_UNKNOWN' };
          await reconcileUnknown(tx, unknownTask);
          const queued = await tx.query(`UPDATE lesson_author_workspace_v2_tasks SET status='queued',
              failure_code=NULL,finished_at=NULL,next_attempt_at=clock_timestamp(),dispatch_started_at=NULL,
              started_at=NULL,deadline_at=NULL,lease_token=NULL,heartbeat_at=NULL,lease_expires_at=NULL,
              ai_reservation_id=NULL,accounting_state='not_required',observed_usage='{}'::jsonb
            WHERE id=$1 AND run_id=$2 AND status='outcome_unknown'
              AND accounting_state='pending_reconciliation' AND attempt_count<max_attempts RETURNING id`,
          [lease.task_id, lease.run_id]);
          if (queued.rows.length !== 1) fail('ORCHESTRATION_V2_TASK_WRITE_UNCONFIRMED');
          const outbox = await tx.query(`INSERT INTO lesson_author_workspace_v2_dispatch_outbox
              (id,run_id,workspace_id,tenant_id,course_id,task_id,dispatch_epoch,routing_shard)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [id(), task.run_id, task.workspace_id, task.tenant_id, task.course_id, task.id,
            task.dispatch_epoch, task.routing_shard]);
          if (outbox.rows.length !== 1) fail('ORCHESTRATION_V2_TASK_WRITE_UNCONFIRMED');
          return 'requeued';
        }
        if (!runIsActive || Number(task.attempt_count) >= Number(task.max_attempts)) {
          await stopRunAfterTerminalTask(tx, { ...task, status: 'outcome_unknown',
            failure_code: 'PROVIDER_OUTCOME_UNKNOWN' });
        }
        return 'outcome_unknown';
      }

      const provider = isOrchestrationV2ProviderTask(String(task.kind) as OrchestrationV2TaskKind);
      if (provider) {
        if (!task.ai_reservation_id || task.accounting_state !== 'reserved') {
          fail('ORCHESTRATION_V2_TASK_STATE_INVALID');
        }
        await releaseUndispatched(tx, task);
      }
      if (!runIsActive || Number(task.attempt_count) >= Number(task.max_attempts)) {
        const failed = await tx.query(`UPDATE lesson_author_workspace_v2_tasks SET status='failed',
            failure_code=$4,finished_at=clock_timestamp(),lease_token=NULL,heartbeat_at=NULL,lease_expires_at=NULL,
            ai_reservation_id=NULL,accounting_state='not_required'
          WHERE id=$1 AND run_id=$2 AND status='running' AND lease_token=$3::uuid
            AND dispatch_started_at IS NULL RETURNING id`,
        [lease.task_id, lease.run_id, lease.lease_token, failureCode]);
        if (failed.rows.length !== 1) fail('ORCHESTRATION_V2_TASK_WRITE_UNCONFIRMED');
        await stopRunAfterTerminalTask(tx, { ...task, status: 'failed', failure_code: failureCode });
        return 'failed';
      }

      const queued = await tx.query(`UPDATE lesson_author_workspace_v2_tasks SET status='queued',
          failure_code=NULL,next_attempt_at=clock_timestamp(),lease_token=NULL,heartbeat_at=NULL,
          lease_expires_at=NULL,deadline_at=NULL,ai_reservation_id=NULL,accounting_state='not_required'
        WHERE id=$1 AND run_id=$2 AND status='running' AND lease_token=$3::uuid
          AND dispatch_started_at IS NULL AND attempt_count<max_attempts RETURNING id`,
      [lease.task_id, lease.run_id, lease.lease_token]);
      if (queued.rows.length !== 1) fail('ORCHESTRATION_V2_TASK_WRITE_UNCONFIRMED');
      const outbox = await tx.query(`INSERT INTO lesson_author_workspace_v2_dispatch_outbox
          (id,run_id,workspace_id,tenant_id,course_id,task_id,dispatch_epoch,routing_shard)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [id(), task.run_id, task.workspace_id, task.tenant_id, task.course_id, task.id,
        task.dispatch_epoch, task.routing_shard]);
      if (outbox.rows.length !== 1) fail('ORCHESTRATION_V2_TASK_WRITE_UNCONFIRMED');
      return 'requeued';
    });
  }

  async function recoverOne(
    releaseUndispatched: ReleaseUndispatched,
    holdUnknown: HoldUnknown,
    reconcileUnknown?: ReconcileUnknown,
  ): Promise<'requeued' | 'failed' | 'outcome_unknown' | 'reconciled' | null> {
    return db.transaction(async tx => {
      const terminalCandidate = await tx.query(`SELECT r.id::text AS run_id,r.workspace_id::text,
          r.tenant_id::text,t.id::text AS task_id
        FROM lesson_author_workspace_v2_runs r
        JOIN lesson_author_workspace_v2_tasks t ON t.run_id=r.id
          AND t.status IN ('failed','timed_out','outcome_unknown')
        WHERE r.status IN ('planning','executing','finalizing')
          AND NOT (t.kind='generate_unit' AND coalesce(t.failure_code,'')<>'AI_PROVIDER_AUTH_REJECTED'
            AND NOT (t.status='outcome_unknown' AND t.attempt_count<t.max_attempts)
            AND EXISTS(SELECT 1 FROM lesson_author_workspace_v2_tasks live
              WHERE live.run_id=r.id AND live.status IN ('blocked','queued','running')))
        ORDER BY r.created_at,r.id,t.finished_at,t.ordinal,t.id LIMIT 1`);
      if (terminalCandidate.rows[0]) {
        const candidate = terminalCandidate.rows[0];
        await lockWorkspaceLifecycle(tx, candidate.tenant_id, candidate.workspace_id);
        const terminalRun = await tx.query(`SELECT t.*,r.status AS run_status
          FROM lesson_author_workspace_v2_runs r
          JOIN lesson_author_workspaces w ON w.id=r.workspace_id AND w.tenant_id=r.tenant_id AND w.course_id=r.course_id
          JOIN lesson_author_workspace_v2_tasks t ON t.run_id=r.id AND t.id=$2
            AND t.status IN ('failed','timed_out','outcome_unknown')
          WHERE r.id=$1 AND r.status IN ('planning','executing','finalizing')
          FOR UPDATE OF r,w,t`, [candidate.run_id, candidate.task_id]);
        const terminalTask = terminalRun.rows[0];
        if (!terminalTask) return null;
        if (reconcileUnknown && terminalTask.status === 'outcome_unknown'
          && terminalTask.accounting_state === 'pending_reconciliation'
          && Number(terminalTask.attempt_count) < Number(terminalTask.max_attempts)) {
          await reconcileUnknown(tx, terminalTask);
          const queued = await tx.query(`UPDATE lesson_author_workspace_v2_tasks SET status='queued',
              failure_code=NULL,finished_at=NULL,next_attempt_at=clock_timestamp(),dispatch_started_at=NULL,
              started_at=NULL,deadline_at=NULL,lease_token=NULL,heartbeat_at=NULL,lease_expires_at=NULL,
              ai_reservation_id=NULL,accounting_state='not_required',observed_usage='{}'::jsonb
            WHERE id=$1 AND status='outcome_unknown' AND accounting_state='pending_reconciliation'
              AND attempt_count<max_attempts RETURNING id`, [terminalTask.id]);
          if (queued.rows.length !== 1) fail('ORCHESTRATION_V2_TASK_WRITE_UNCONFIRMED');
          const route = await tx.query(`SELECT routing_shard FROM lesson_author_workspace_v2_dispatch_outbox
            WHERE task_id=$1 ORDER BY dispatch_epoch DESC LIMIT 1`, [terminalTask.id]);
          if (route.rows.length !== 1 || !Number.isSafeInteger(Number(route.rows[0]?.routing_shard))) {
            fail('ORCHESTRATION_V2_TASK_WRITE_UNCONFIRMED');
          }
          const outbox = await tx.query(`INSERT INTO lesson_author_workspace_v2_dispatch_outbox
              (id,run_id,workspace_id,tenant_id,course_id,task_id,dispatch_epoch,routing_shard)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [id(), terminalTask.run_id, terminalTask.workspace_id, terminalTask.tenant_id,
            terminalTask.course_id, terminalTask.id, terminalTask.dispatch_epoch, route.rows[0].routing_shard]);
          if (outbox.rows.length !== 1) fail('ORCHESTRATION_V2_TASK_WRITE_UNCONFIRMED');
          return 'requeued';
        }
        await stopRunAfterTerminalTask(tx, terminalTask);
        return 'reconciled';
      }

      // A run can become needs_action while another claimed task is draining.
      // Once no task is running, cancel every stranded queued/blocked task and
      // publish the workspace terminal state even if no terminal task remains.
      const needsActionCandidate = await tx.query(`SELECT r.id::text AS run_id,r.workspace_id::text,
          r.tenant_id::text,r.course_id
        FROM lesson_author_workspace_v2_runs r
        JOIN lesson_author_workspaces w ON w.id=r.workspace_id AND w.tenant_id=r.tenant_id AND w.course_id=r.course_id
        WHERE r.status='needs_action' AND w.status IN ('queued','designing','drafting')
          AND NOT EXISTS(SELECT 1 FROM lesson_author_workspace_v2_tasks live
            WHERE live.run_id=r.id AND live.status='running')
        ORDER BY r.created_at,r.id LIMIT 1`);
      if (needsActionCandidate.rows[0]) {
        const candidate = needsActionCandidate.rows[0];
        await lockWorkspaceLifecycle(tx, candidate.tenant_id, candidate.workspace_id);
        const authority = await tx.query(`SELECT r.id::text AS run_id,r.id::text AS id,
            r.workspace_id::text,r.tenant_id::text,r.course_id,r.failure_code,
            'source_snapshot'::text AS kind
          FROM lesson_author_workspace_v2_runs r
          JOIN lesson_author_workspaces w ON w.id=r.workspace_id AND w.tenant_id=r.tenant_id AND w.course_id=r.course_id
          WHERE r.id=$1 AND r.status='needs_action' AND w.status IN ('queued','designing','drafting')
            AND NOT EXISTS(SELECT 1 FROM lesson_author_workspace_v2_tasks live
              WHERE live.run_id=r.id AND live.status='running')
          FOR UPDATE OF r,w`, [candidate.run_id]);
        if (!authority.rows[0]) return null;
        await syncNeedsActionWorkspace(tx, authority.rows[0]);
        return 'reconciled';
      }

      const expiredCandidate = await tx.query(`SELECT t.id::text AS task_id,t.run_id::text,
          t.workspace_id::text,t.tenant_id::text
        FROM lesson_author_workspace_v2_tasks t
        WHERE t.status='running' AND (t.lease_expires_at<=clock_timestamp() OR t.deadline_at<=clock_timestamp())
        ORDER BY t.deadline_at,t.id LIMIT 1`);
      if (!expiredCandidate.rows[0]) return null;
      const candidate = expiredCandidate.rows[0];
      await lockWorkspaceLifecycle(tx, candidate.tenant_id, candidate.workspace_id);
      const locked = await tx.query(`SELECT t.*,r.status AS run_status,
          coalesce(o.routing_shard,0)::integer AS routing_shard
        FROM lesson_author_workspace_v2_tasks t
        JOIN lesson_author_workspace_v2_runs r ON r.id=t.run_id AND r.workspace_id=t.workspace_id
        LEFT JOIN LATERAL (SELECT routing_shard FROM lesson_author_workspace_v2_dispatch_outbox
          WHERE task_id=t.id ORDER BY dispatch_epoch DESC LIMIT 1) o ON true
        WHERE t.id=$1 AND t.run_id=$2 AND t.status='running'
          AND (t.lease_expires_at<=clock_timestamp() OR t.deadline_at<=clock_timestamp())
        FOR UPDATE OF r,t`, [candidate.task_id, candidate.run_id]);
      const task = locked.rows[0];
      if (!task) return null;
      if (task.dispatch_started_at) {
        await holdUnknown(tx, task);
        const unknown = await tx.query(`UPDATE lesson_author_workspace_v2_tasks SET status='outcome_unknown',
            accounting_state='pending_reconciliation',failure_code='PROVIDER_OUTCOME_UNKNOWN',finished_at=clock_timestamp(),
            lease_token=NULL,heartbeat_at=NULL,lease_expires_at=NULL
          WHERE id=$1 AND status='running' AND lease_token=$2::uuid RETURNING id`, [task.id, task.lease_token]);
        if (unknown.rows.length !== 1) fail('ORCHESTRATION_V2_TASK_WRITE_UNCONFIRMED');
        const replayEligible = activeRun.has(String(task.run_status)) && !!reconcileUnknown
          && Number(task.attempt_count) < Number(task.max_attempts);
        if (replayEligible) {
          const unknownTask = { ...task, status: 'outcome_unknown',
            accounting_state: 'pending_reconciliation', failure_code: 'PROVIDER_OUTCOME_UNKNOWN' };
          await reconcileUnknown!(tx, unknownTask);
          const queued = await tx.query(`UPDATE lesson_author_workspace_v2_tasks SET status='queued',
              failure_code=NULL,finished_at=NULL,next_attempt_at=clock_timestamp(),dispatch_started_at=NULL,
              started_at=NULL,deadline_at=NULL,lease_token=NULL,heartbeat_at=NULL,lease_expires_at=NULL,
              ai_reservation_id=NULL,accounting_state='not_required',observed_usage='{}'::jsonb
            WHERE id=$1 AND status='outcome_unknown' AND accounting_state='pending_reconciliation'
              AND attempt_count<max_attempts RETURNING id`, [task.id]);
          if (queued.rows.length !== 1) fail('ORCHESTRATION_V2_TASK_WRITE_UNCONFIRMED');
          const outbox = await tx.query(`INSERT INTO lesson_author_workspace_v2_dispatch_outbox
              (id,run_id,workspace_id,tenant_id,course_id,task_id,dispatch_epoch,routing_shard)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [id(), task.run_id, task.workspace_id, task.tenant_id, task.course_id, task.id,
            task.dispatch_epoch, task.routing_shard]);
          if (outbox.rows.length !== 1) fail('ORCHESTRATION_V2_TASK_WRITE_UNCONFIRMED');
          return 'requeued';
        }
        await stopRunAfterTerminalTask(tx, { ...task, status: 'outcome_unknown',
          failure_code: 'PROVIDER_OUTCOME_UNKNOWN' });
        return 'outcome_unknown';
      }
      if (isOrchestrationV2ProviderTask(String(task.kind) as OrchestrationV2TaskKind)) {
        if (!task.ai_reservation_id || task.accounting_state !== 'reserved') {
          fail('ORCHESTRATION_V2_TASK_STATE_INVALID');
        }
        await releaseUndispatched(tx, task);
      }
      if (!activeRun.has(String(task.run_status)) || Number(task.attempt_count) >= Number(task.max_attempts)) {
        const failed = await tx.query(`UPDATE lesson_author_workspace_v2_tasks SET status='failed',
            failure_code=CASE WHEN $3::boolean THEN 'TASK_ATTEMPTS_EXHAUSTED' ELSE 'RUN_ALREADY_TERMINAL' END,
            finished_at=clock_timestamp(),
            lease_token=NULL,heartbeat_at=NULL,lease_expires_at=NULL,ai_reservation_id=NULL,accounting_state='not_required'
          WHERE id=$1 AND status='running' AND lease_token=$2::uuid RETURNING id`,
        [task.id, task.lease_token, activeRun.has(String(task.run_status))]);
        if (failed.rows.length !== 1) fail('ORCHESTRATION_V2_TASK_WRITE_UNCONFIRMED');
        const failureCode = activeRun.has(String(task.run_status)) ? 'TASK_ATTEMPTS_EXHAUSTED' : 'RUN_ALREADY_TERMINAL';
        await stopRunAfterTerminalTask(tx, { ...task, status: 'failed', failure_code: failureCode });
        return 'failed';
      }
      const queued = await tx.query(`UPDATE lesson_author_workspace_v2_tasks SET status='queued',
          next_attempt_at=clock_timestamp(),lease_token=NULL,heartbeat_at=NULL,lease_expires_at=NULL,deadline_at=NULL,
          ai_reservation_id=NULL,accounting_state='not_required'
        WHERE id=$1 AND status='running' AND lease_token=$2::uuid AND dispatch_started_at IS NULL RETURNING id`,
      [task.id, task.lease_token]);
      if (queued.rows.length !== 1) fail('ORCHESTRATION_V2_TASK_WRITE_UNCONFIRMED');
      const outboxId = id();
      const outbox = await tx.query(`INSERT INTO lesson_author_workspace_v2_dispatch_outbox
          (id,run_id,workspace_id,tenant_id,course_id,task_id,dispatch_epoch,routing_shard)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [outboxId, task.run_id, task.workspace_id, task.tenant_id, task.course_id, task.id,
        task.dispatch_epoch, task.routing_shard]);
      if (outbox.rows.length !== 1) fail('ORCHESTRATION_V2_TASK_WRITE_UNCONFIRMED');
      return 'requeued';
    });
  }

  return { claimExact, renew, markProviderDispatched, succeed, failProviderRejected, recoverClaimFailure, recoverOne };
}
