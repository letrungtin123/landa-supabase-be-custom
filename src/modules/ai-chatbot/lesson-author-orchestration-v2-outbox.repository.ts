import { randomUUID } from 'node:crypto';
import type { GenerationJobDatabase } from './lesson-author-generation-job.repository.js';
import { orchestrationV2RetryDelayMs, type OrchestrationV2DispatchIdentity } from './lesson-author-orchestration-v2-dispatch.logic.js';

export interface OrchestrationV2OutboxLease extends OrchestrationV2DispatchIdentity {
  lease_token: string;
  attempt_count: number;
}

export interface OrchestrationV2OutboxConfig {
  lane_count: number;
  lane_index: number;
  lease_seconds: number;
  max_attempts: number;
  retry_base_ms: number;
  retry_max_ms: number;
  published_recovery_seconds: number;
}

export class OrchestrationV2OutboxError extends Error {
  constructor(readonly code:
    | 'ORCHESTRATION_V2_OUTBOX_CONFIG_INVALID'
    | 'ORCHESTRATION_V2_OUTBOX_LEASE_LOST') {
    super(code);
    this.name = 'OrchestrationV2OutboxError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const integer = (value: number, min: number, max: number) => Number.isSafeInteger(value) && value >= min && value <= max;
const fail = (code: OrchestrationV2OutboxError['code']): never => { throw new OrchestrationV2OutboxError(code); };

export function assertOrchestrationV2OutboxConfig(
  config: OrchestrationV2OutboxConfig,
): Readonly<OrchestrationV2OutboxConfig> {
  if (!config || !integer(config.lane_count, 1, 4_096) || !integer(config.lane_index, 0, config.lane_count - 1)
    || !integer(config.lease_seconds, 5, 300) || !integer(config.max_attempts, 1, 100)
    || !integer(config.retry_base_ms, 1, 3_600_000) || !integer(config.retry_max_ms, config.retry_base_ms, 86_400_000)
    || !integer(config.published_recovery_seconds, config.lease_seconds, 3_600)) {
    fail('ORCHESTRATION_V2_OUTBOX_CONFIG_INVALID');
  }
  return Object.freeze({ ...config });
}

function lease(row: Record<string, unknown>): OrchestrationV2OutboxLease {
  const output = {
    outbox_id: String(row.outbox_id), run_id: String(row.run_id), task_id: String(row.task_id),
    dispatch_epoch: Number(row.dispatch_epoch), routing_shard: Number(row.routing_shard),
    lease_token: String(row.lease_token), attempt_count: Number(row.attempt_count),
  };
  if (![output.outbox_id, output.run_id, output.task_id, output.lease_token].every(value => UUID.test(value))
    || !integer(output.dispatch_epoch, 0, 100) || !integer(output.routing_shard, 0, 4_095)
    || !integer(output.attempt_count, 1, 100)) fail('ORCHESTRATION_V2_OUTBOX_LEASE_LOST');
  return output;
}

export function createOrchestrationV2OutboxRepository(db: GenerationJobDatabase, id: () => string = randomUUID) {
  async function claimNext(config: OrchestrationV2OutboxConfig): Promise<OrchestrationV2OutboxLease | null> {
    assertOrchestrationV2OutboxConfig(config);
    return db.transaction(async tx => {
      const leaseToken = id();
      if (!UUID.test(leaseToken)) fail('ORCHESTRATION_V2_OUTBOX_CONFIG_INVALID');
      const result = await tx.query(`WITH ranked AS (
          SELECT id,available_at,created_at,
            row_number() OVER(PARTITION BY tenant_id ORDER BY available_at,created_at,id) AS tenant_rank
          FROM lesson_author_workspace_v2_dispatch_outbox
          WHERE status='pending' AND available_at<=clock_timestamp()
            AND mod(routing_shard,$1::integer)=$2::integer AND attempt_count<$3::integer
        ), candidate AS (
          SELECT o.id FROM lesson_author_workspace_v2_dispatch_outbox o JOIN ranked r ON r.id=o.id
          ORDER BY r.tenant_rank,r.available_at,r.created_at,r.id
          FOR UPDATE OF o SKIP LOCKED LIMIT 1
        ) UPDATE lesson_author_workspace_v2_dispatch_outbox o
        SET status='publishing',attempt_count=o.attempt_count+1,lease_token=$4::uuid,
          lease_expires_at=clock_timestamp()+($5::integer*interval '1 second'),failure_code=NULL,updated_at=clock_timestamp()
        FROM candidate c WHERE o.id=c.id AND o.status='pending'
        RETURNING o.id::text AS outbox_id,o.run_id::text,o.task_id::text,o.dispatch_epoch,o.routing_shard,
          o.lease_token::text,o.attempt_count`,
      [config.lane_count, config.lane_index, config.max_attempts, leaseToken, config.lease_seconds]);
      return result.rows.length ? lease(result.rows[0]) : null;
    });
  }

  async function markPublished(current: OrchestrationV2OutboxLease): Promise<void> {
    await db.transaction(async tx => {
      // The tenant-data-quota trigger acquires this advisory lock after an
      // UPDATE has already locked the row. Acquire it first so dispatcher
      // publication and worker claim transactions cannot invert lock order.
      const quotaLock = await tx.query(`SELECT pg_advisory_xact_lock(
          hashtextextended(tenant_id::text,20260907)) AS locked
        FROM lesson_author_workspace_v2_dispatch_outbox
        WHERE id=$1 AND run_id=$2 AND task_id=$3 AND dispatch_epoch=$4`,
      [current.outbox_id, current.run_id, current.task_id, current.dispatch_epoch]);
      if (quotaLock.rows.length !== 1) fail('ORCHESTRATION_V2_OUTBOX_LEASE_LOST');
      const result = await tx.query(`UPDATE lesson_author_workspace_v2_dispatch_outbox
        SET status='published',published_at=clock_timestamp(),lease_token=NULL,lease_expires_at=NULL,
          failure_code=NULL,updated_at=clock_timestamp()
        WHERE id=$1 AND run_id=$2 AND task_id=$3 AND dispatch_epoch=$4 AND status='publishing'
          AND lease_token=$5::uuid AND lease_expires_at>clock_timestamp() RETURNING id`,
      [current.outbox_id, current.run_id, current.task_id, current.dispatch_epoch, current.lease_token]);
      if (result.rows.length !== 1) fail('ORCHESTRATION_V2_OUTBOX_LEASE_LOST');
    });
  }

  async function releaseAfterPublishFailure(
    current: OrchestrationV2OutboxLease, config: OrchestrationV2OutboxConfig,
  ): Promise<'pending' | 'dead'> {
    assertOrchestrationV2OutboxConfig(config);
    const exhausted = current.attempt_count >= config.max_attempts;
    const delayMs = orchestrationV2RetryDelayMs(current.attempt_count, config.retry_base_ms, config.retry_max_ms);
    return db.transaction(async tx => {
      const result = await tx.query(`UPDATE lesson_author_workspace_v2_dispatch_outbox SET
          status=CASE WHEN $6::boolean THEN 'dead' ELSE 'pending' END,
          available_at=CASE WHEN $6::boolean THEN available_at ELSE clock_timestamp()+($7::bigint*interval '1 millisecond') END,
          lease_token=NULL,lease_expires_at=NULL,failure_code=CASE WHEN $6::boolean THEN 'BROKER_PUBLISH_EXHAUSTED' ELSE NULL END,
          updated_at=clock_timestamp()
        WHERE id=$1 AND run_id=$2 AND task_id=$3 AND dispatch_epoch=$4 AND status='publishing'
          AND lease_token=$5::uuid RETURNING status`,
      [current.outbox_id, current.run_id, current.task_id, current.dispatch_epoch, current.lease_token, exhausted, delayMs]);
      if (result.rows.length !== 1) fail('ORCHESTRATION_V2_OUTBOX_LEASE_LOST');
      return result.rows[0].status === 'dead' ? 'dead' : 'pending';
    });
  }

  async function recoverOne(config: OrchestrationV2OutboxConfig): Promise<'pending' | 'dead' | null> {
    assertOrchestrationV2OutboxConfig(config);
    return db.transaction(async tx => {
      const result = await tx.query(`WITH candidate AS (
          SELECT id,status,attempt_count FROM lesson_author_workspace_v2_dispatch_outbox
          WHERE ((status='publishing' AND lease_expires_at<=clock_timestamp())
            OR (status='published' AND consumed_at IS NULL
              AND published_at<=clock_timestamp()-($1::integer*interval '1 second')))
            AND mod(routing_shard,$2::integer)=$3::integer
          ORDER BY updated_at,id FOR UPDATE SKIP LOCKED LIMIT 1
        ) UPDATE lesson_author_workspace_v2_dispatch_outbox o SET
          status=CASE WHEN c.attempt_count>=$4::integer THEN 'dead' ELSE 'pending' END,
          available_at=CASE WHEN c.attempt_count>=$4::integer THEN o.available_at ELSE clock_timestamp() END,
          lease_token=NULL,lease_expires_at=NULL,
          failure_code=CASE WHEN c.attempt_count>=$4::integer THEN 'BROKER_DELIVERY_EXHAUSTED' ELSE NULL END,
          updated_at=clock_timestamp()
        FROM candidate c WHERE o.id=c.id RETURNING o.status`,
      [config.published_recovery_seconds, config.lane_count, config.lane_index, config.max_attempts]);
      if (!result.rows.length) return null;
      return result.rows[0].status === 'dead' ? 'dead' : 'pending';
    });
  }

  return { claimNext, markPublished, releaseAfterPublishFailure, recoverOne };
}
