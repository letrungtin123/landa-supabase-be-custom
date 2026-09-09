// ═══════════════════════════════════════════════════════════════
// Durable Knowledge Base operation outbox
// DB state is committed (with its Audit Log) before a worker touches Storage
// or Gemini.  Claims use SKIP LOCKED plus a lease token, so API replicas and
// worker restarts cannot execute the same remote operation concurrently.
// ═══════════════════════════════════════════════════════════════

import { randomUUID } from 'crypto';
import { query, withDatabaseTransaction } from '../../config/database.js';
import { env } from '../../config/env.js';

export type KbOperationType =
  | 'document_upload'
  | 'document_reupload'
  | 'document_delete'
  | 'knowledgebase_delete';

type KbOperationStatus = 'queued' | 'running' | 'failed';

export interface KbOperationJob {
  id: string;
  tenant_id: string;
  kb_id: string;
  document_id: string | null;
  target_document_id: string | null;
  operation: KbOperationType;
  payload: Record<string, unknown>;
  status: KbOperationStatus;
  attempt_count: number;
  next_attempt_at: string;
  lease_expires_at: string | null;
  lease_token: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface EnqueueKbOperationInput {
  tenantId: string;
  kbId: string;
  documentId?: string | null;
  targetDocumentId?: string | null;
  operation: KbOperationType;
  payload?: Record<string, unknown>;
}

function operationLockKey(input: EnqueueKbOperationInput, targetDocumentId: string | null): string {
  return `kb-operation:${input.tenantId}:${input.kbId}:${targetDocumentId || 'kb'}:${input.operation}`;
}

/**
 * Add or revive exactly one durable operation for its logical target. This
 * function deliberately uses the caller's AsyncLocalStorage transaction when
 * invoked from runAuditedTransaction.
 */
export async function enqueueKbOperation(input: EnqueueKbOperationInput): Promise<KbOperationJob> {
  const payload = input.payload || {};
  const targetDocumentId = input.targetDocumentId ?? input.documentId ?? null;
  await query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [operationLockKey(input, targetDocumentId)]);

  const existing = await query<KbOperationJob>(
    `SELECT *
     FROM kb_operation_jobs
     WHERE tenant_id = $1
       AND kb_id = $2
       AND target_document_id IS NOT DISTINCT FROM $3
       AND operation = $4
       AND status IN ('queued', 'running', 'failed')
     ORDER BY created_at DESC
     LIMIT 1
     FOR UPDATE`,
    [input.tenantId, input.kbId, targetDocumentId, input.operation],
  );

  if (existing.rows[0]) {
    // Never steal a live worker's lease. Repeated HTTP requests are
    // idempotent and return the already-running durable operation instead.
    if (existing.rows[0].status === 'running') return existing.rows[0];
    const revived = await query<KbOperationJob>(
      `UPDATE kb_operation_jobs
       SET payload = $2::jsonb,
           status = 'queued',
           next_attempt_at = now(),
           lease_expires_at = NULL,
           lease_token = NULL,
           last_error = NULL,
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [existing.rows[0].id, JSON.stringify(payload)],
    );
    return revived.rows[0];
  }

  const inserted = await query<KbOperationJob>(
    `INSERT INTO kb_operation_jobs
       (id, tenant_id, kb_id, document_id, target_document_id, operation, payload, status, next_attempt_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'queued', now())
     RETURNING *`,
    [randomUUID(), input.tenantId, input.kbId, input.documentId || null, targetDocumentId, input.operation, JSON.stringify(payload)],
  );
  return inserted.rows[0];
}

/** Claim due jobs atomically. The database is the source of truth; no queue publish is required for recovery. */
export async function claimDueKbOperations(limit = env.KB_OPERATION_WORKER_BATCH_SIZE): Promise<KbOperationJob[]> {
  const safeLimit = Math.max(1, Math.min(limit, env.KB_OPERATION_WORKER_BATCH_SIZE));
  return withDatabaseTransaction(async () => {
    const claimed = await query<KbOperationJob>(
      `WITH ranked AS (
         SELECT id, tenant_id, next_attempt_at,
                row_number() OVER (PARTITION BY tenant_id ORDER BY next_attempt_at ASC, id ASC) AS tenant_position
         FROM kb_operation_jobs
         WHERE (status = 'queued' AND next_attempt_at <= now())
            OR (status = 'running' AND lease_expires_at <= now())
       ), candidates AS (
         SELECT job.id
         FROM kb_operation_jobs job
         JOIN ranked ON ranked.id = job.id
         ORDER BY ranked.tenant_position ASC, ranked.next_attempt_at ASC, job.id ASC
         LIMIT $1
         FOR UPDATE OF job SKIP LOCKED
       )
       UPDATE kb_operation_jobs job
       SET status = 'running',
           attempt_count = job.attempt_count + 1,
           lease_token = gen_random_uuid(),
           lease_expires_at = now() + ($2::int * interval '1 second'),
           last_error = NULL,
           updated_at = now()
       FROM candidates
       WHERE job.id = candidates.id
       RETURNING job.*`,
      [safeLimit, env.KB_OPERATION_WORKER_LEASE_SECONDS],
    );
    return claimed.rows;
  });
}

export async function renewKbOperationLease(jobId: string, leaseToken: string): Promise<boolean> {
  const renewed = await query(
    `UPDATE kb_operation_jobs
     SET lease_expires_at = now() + ($3::int * interval '1 second'), updated_at = now()
     WHERE id = $1 AND status = 'running' AND lease_token = $2
       AND lease_expires_at > now()`,
    [jobId, leaseToken, env.KB_OPERATION_WORKER_LEASE_SECONDS],
  );
  return (renewed.rowCount || 0) === 1;
}

export async function completeKbOperation(jobId: string, leaseToken: string): Promise<boolean> {
  const completed = await query(
    `DELETE FROM kb_operation_jobs
     WHERE id = $1 AND status = 'running' AND lease_token = $2
       AND lease_expires_at > now()`,
    [jobId, leaseToken],
  );
  return (completed.rowCount || 0) === 1;
}

export async function failKbOperation(
  job: Pick<KbOperationJob, 'id' | 'lease_token' | 'attempt_count' | 'operation'>,
  error: unknown,
): Promise<{ terminal: boolean; updated: boolean }> {
  if (!job.lease_token) return { terminal: false, updated: false };
  const reason = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
  // Destructive work has already removed the tenant row to release quota.
  // It must keep retrying (with a capped delay) until external cleanup is
  // confirmed; otherwise a failed terminal job would become an orphan leak
  // that the user can no longer retry from the UI.
  const terminal = !['document_delete', 'knowledgebase_delete'].includes(job.operation)
    && job.attempt_count >= env.KB_OPERATION_WORKER_MAX_ATTEMPTS;
  const backoffSeconds = Math.min(
    env.KB_OPERATION_WORKER_RETRY_MAX_SECONDS,
    env.KB_OPERATION_WORKER_RETRY_BASE_SECONDS * (2 ** Math.min(Math.max(job.attempt_count - 1, 0), 10)),
  );
  const result = await query(
    `UPDATE kb_operation_jobs
     SET status = CASE WHEN $3 THEN 'failed' ELSE 'queued' END,
         next_attempt_at = CASE WHEN $3 THEN next_attempt_at ELSE now() + ($4::int * interval '1 second') END,
         lease_expires_at = NULL,
         lease_token = NULL,
         last_error = $5,
         updated_at = now()
     WHERE id = $1 AND status = 'running' AND lease_token = $2
       AND lease_expires_at > now()`,
    [job.id, job.lease_token, terminal, backoffSeconds, reason],
  );
  return { terminal, updated: (result.rowCount || 0) === 1 };
}

export async function hasQueuedKnowledgebaseDeletion(kbId: string, tenantId: string): Promise<boolean> {
  const result = await query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM kb_operation_jobs
       WHERE kb_id = $1 AND tenant_id = $2
         AND operation = 'knowledgebase_delete'
         AND status IN ('queued', 'running')
     ) AS exists`,
    [kbId, tenantId],
  );
  return result.rows[0]?.exists === true;
}
