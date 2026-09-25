import { randomUUID } from 'node:crypto';
import type { ValidatedLessonAuthorEditorContext } from './lesson-author-command.logic.js';
import {
  GENERATION_JOB_LEASE_MS, GenerationJobError, generationRecoveryAction,
  type GenerationJobLease, type GenerationJobOwner, type GenerationJobRow,
} from './lesson-author-generation-job.logic.js';

/** Injected DB boundary: importing this module never connects, polls or dispatches. */
export interface GenerationJobSql {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string, params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

export interface GenerationJobDatabase {
  transaction<T>(work: (tx: GenerationJobSql) => Promise<T>): Promise<T>;
}

/** All values must come from the existing authorized Node preparation path. */
export interface PreparedGenerationJob extends GenerationJobOwner {
  courseId: string;
  botId: string;
  kbId: string;
  idempotencyKey: string;
  correlationId: string;
  requestHash: string;
  sourceSnapshotHash: string;
  courseOutlineHash: string;
  runtimeConfigHash: string;
  locale: 'vi' | 'en';
  model: string;
  sourceDocumentIds: string[];
  editorContext: ValidatedLessonAuthorEditorContext | null;
}

/** Created inside enqueue's transaction, AFTER idempotency/active-job checks. */
export interface GenerationEnqueueGrant {
  userMessageId: string;
  reservationId: string;
  maxOutputTokens: number;
  maxAttempts: number;
}

export interface GenerationJobFailure {
  stage: string;
  internalCode: string;
  externalCode: string;
}

export interface GenerationDispatchAuthorization {
  reservationId: string;
  requestHash: string;
  sourceSnapshotHash: string;
  courseOutlineHash: string;
  runtimeConfigHash: string;
  model: string;
  maxOutputTokens: number;
  maxAttempts: number;
}

function assertDispatchSnapshot(job: GenerationJobRow, authorization: GenerationDispatchAuthorization): void {
  if (authorization.requestHash !== job.request_hash
    || authorization.sourceSnapshotHash !== job.source_snapshot_hash
    || authorization.courseOutlineHash !== job.course_outline_hash
    || authorization.runtimeConfigHash !== job.runtime_config_hash
    || authorization.model !== job.model) {
    throw new GenerationJobError('GENERATION_SNAPSHOT_CHANGED');
  }
  // The existing quota service can grant a partial budget. Never dispatch using
  // a different budget/retry count from the immutable queued execution contract.
  if (authorization.maxOutputTokens !== job.max_output_tokens || authorization.maxAttempts !== job.max_attempts) {
    throw new GenerationJobError('GENERATION_BUDGET_CHANGED');
  }
}

const LIVE_LEASE = `id = $1 AND tenant_id = $2 AND status = 'running'
  AND lease_token = $3 AND lease_expires_at > clock_timestamp()
  AND deadline_at > clock_timestamp()`;

function leaseParams(lease: GenerationJobLease): unknown[] {
  return [lease.jobId, lease.tenantId, lease.leaseToken];
}

function requireRow(rows: GenerationJobRow[]): GenerationJobRow {
  if (!rows[0]) throw new GenerationJobError('GENERATION_LEASE_LOST');
  return rows[0];
}

function checkFailure(failure: GenerationJobFailure): void {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(failure.stage)
    || !/^[A-Z][A-Z0-9_]{0,99}$/.test(failure.internalCode)
    || !/^[A-Z][A-Z0-9_]{0,99}$/.test(failure.externalCode)) {
    throw new GenerationJobError('GENERATION_JOB_CONTRACT_INVALID');
  }
}

/**
 * Persistence/fencing boundary used by the gated API/worker; no startup side effects here.
 * Callers must reuse conversation/RBAC/source/editor authorization. The scoped
 * SQL below is defense in depth, not a replacement for those business checks.
 * Every callback MUST use tx (or the same transaction-aware query context), never
 * autocommit. Callbacks are short DB work, not provider calls.
 */
export function createGenerationJobRepository(db: GenerationJobDatabase) {
  return {
    async enqueue(
      input: PreparedGenerationJob,
      reserveAndCreateMessage: (tx: GenerationJobSql) => Promise<GenerationEnqueueGrant>,
    ): Promise<{ job: GenerationJobRow; created: boolean }> {
      return db.transaction(async tx => {
        // Serialize competing enqueue requests before inserting either message.
        // Ordinary chat must additionally share the conversation lock in the adapter.
        const conversation = await tx.query(
          `SELECT id FROM chat_conversations
           WHERE id = $1 AND tenant_id = $2 AND user_id = $3
             AND course_id = $4 AND bot_id = $5 AND target = 'lesson_author'
           FOR UPDATE`,
          [input.conversationId, input.tenantId, input.userId, input.courseId, input.botId],
        );
        if (!conversation.rows.length) throw new GenerationJobError('GENERATION_JOB_NOT_FOUND');
        const existing = await tx.query<GenerationJobRow>(
          `SELECT * FROM lesson_author_generation_jobs
           WHERE tenant_id = $1 AND conversation_id = $2 AND requested_by = $3 AND idempotency_key = $4`,
          [input.tenantId, input.conversationId, input.userId, input.idempotencyKey],
        );
        if (existing.rows[0]) {
          if (existing.rows[0].request_hash !== input.requestHash) {
            throw new GenerationJobError('GENERATION_IDEMPOTENCY_CONFLICT');
          }
          return { job: existing.rows[0], created: false };
        }
        const active = await tx.query(
          `SELECT id FROM lesson_author_generation_jobs
           WHERE tenant_id = $1 AND conversation_id = $2 AND status IN ('queued', 'running')`,
          [input.tenantId, input.conversationId],
        );
        if (active.rows.length) throw new GenerationJobError('GENERATION_ALREADY_ACTIVE');
        const grant = await reserveAndCreateMessage(tx);
        if (!grant.userMessageId || !grant.reservationId
          || !Number.isInteger(grant.maxOutputTokens) || grant.maxOutputTokens < 1 || grant.maxOutputTokens > 65_536
          || !Number.isInteger(grant.maxAttempts) || grant.maxAttempts < 1 || grant.maxAttempts > 2) {
          throw new GenerationJobError('GENERATION_JOB_CONTRACT_INVALID');
        }
        const inserted = await tx.query<GenerationJobRow>(
          `INSERT INTO lesson_author_generation_jobs (
             tenant_id, course_id, conversation_id, requested_by, bot_id, kb_id,
             user_message_id, idempotency_key, correlation_id, request_hash,
             source_snapshot_hash, course_outline_hash, runtime_config_hash,
             locale, model, max_output_tokens, max_attempts, source_document_ids, editor_context, ai_reservation_id
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::uuid[],$19::jsonb,$20)
           RETURNING *`,
          [input.tenantId, input.courseId, input.conversationId, input.userId, input.botId, input.kbId,
            grant.userMessageId, input.idempotencyKey, input.correlationId, input.requestHash,
            input.sourceSnapshotHash, input.courseOutlineHash, input.runtimeConfigHash,
            input.locale, input.model, grant.maxOutputTokens, grant.maxAttempts,
            input.sourceDocumentIds, JSON.stringify(input.editorContext ?? {}), grant.reservationId],
        );
        const job = inserted.rows[0];
        if (!job) throw new GenerationJobError('GENERATION_JOB_CONTRACT_INVALID');
        return { job, created: true };
      });
    },

    /** Reauthorize through the existing service before each public status read. */
    async findOwned(owner: GenerationJobOwner, jobId: string): Promise<GenerationJobRow | null> {
      return db.transaction(async tx => {
        const result = await tx.query<GenerationJobRow>(
          `SELECT j.* FROM lesson_author_generation_jobs j
           JOIN chat_conversations c ON c.id = j.conversation_id AND c.tenant_id = j.tenant_id
             AND c.user_id = j.requested_by AND c.course_id = j.course_id AND c.bot_id = j.bot_id
           JOIN courses course ON course.id = j.course_id AND course.tenant_id = j.tenant_id
             AND course.deleted_at IS NULL
           JOIN tenant_bot_assignments bot_assignment ON bot_assignment.tenant_id = j.tenant_id
             AND bot_assignment.target = 'lesson_author' AND bot_assignment.bot_id = j.bot_id
           JOIN chatbots bot ON bot.id = j.bot_id AND bot.tenant_id = j.tenant_id
           JOIN tenant_kb_assignments kb_assignment ON kb_assignment.tenant_id = j.tenant_id
             AND kb_assignment.target = 'lesson_author' AND kb_assignment.kb_id = j.kb_id
           JOIN knowledgebases kb ON kb.id = j.kb_id AND kb.tenant_id = j.tenant_id
           WHERE j.id = $1 AND j.tenant_id = $2 AND j.conversation_id = $3
             AND j.requested_by = $4 AND c.target = 'lesson_author'`,
          [jobId, owner.tenantId, owner.conversationId, owner.userId],
        );
        return result.rows[0] ?? null;
      });
    },

    async claimNext(): Promise<GenerationJobRow | null> {
      return db.transaction(async tx => {
        const result = await tx.query<GenerationJobRow>(
          `WITH candidate AS (
             SELECT id FROM lesson_author_generation_jobs
             WHERE status = 'queued' AND dispatch_started_at IS NULL AND deadline_at > clock_timestamp()
             ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED
           ) UPDATE lesson_author_generation_jobs j SET
             status = 'running', claim_count = j.claim_count + 1, lease_token = $1,
             started_at = COALESCE(j.started_at, clock_timestamp()), heartbeat_at = clock_timestamp(),
             lease_expires_at = LEAST(j.deadline_at, clock_timestamp() + ($2 * interval '1 millisecond')),
             progress_code = 'PREPARING_BLUEPRINT'
           FROM candidate WHERE j.id = candidate.id RETURNING j.*`,
          [randomUUID(), GENERATION_JOB_LEASE_MS],
        );
        return result.rows[0] ?? null;
      });
    },

    async renew(lease: GenerationJobLease): Promise<boolean> {
      return db.transaction(async tx => {
        const result = await tx.query(
          `UPDATE lesson_author_generation_jobs SET heartbeat_at = clock_timestamp(),
             lease_expires_at = LEAST(deadline_at, clock_timestamp() + ($4 * interval '1 millisecond'))
           WHERE ${LIVE_LEASE} RETURNING id`,
          [...leaseParams(lease), GENERATION_JOB_LEASE_MS],
        );
        return result.rows.length === 1;
      });
    },

    /** Await this transaction's COMMIT before dispatching Python. No job-level retry. */
    async prepareDispatch(
      lease: GenerationJobLease,
      reauthorizeAndVerifyReservation: (tx: GenerationJobSql, job: GenerationJobRow) => Promise<GenerationDispatchAuthorization>,
    ): Promise<GenerationJobRow> {
      return db.transaction(async tx => {
        const locked = await tx.query<GenerationJobRow>(
          `SELECT * FROM lesson_author_generation_jobs WHERE ${LIVE_LEASE} FOR UPDATE`, leaseParams(lease),
        );
        const job = requireRow(locked.rows);
        if (job.dispatch_started_at !== null) throw new GenerationJobError('GENERATION_ALREADY_DISPATCHED');
        // Reuse the enqueue-time grant; dispatch must NEVER reserve again.
        if (!job.ai_reservation_id) throw new GenerationJobError('GENERATION_JOB_CONTRACT_INVALID');
        const authorization = await reauthorizeAndVerifyReservation(tx, job);
        assertDispatchSnapshot(job, authorization);
        const reservationId = authorization.reservationId;
        if (job.ai_reservation_id !== reservationId) {
          throw new GenerationJobError('GENERATION_JOB_CONTRACT_INVALID');
        }
        const marked = await tx.query<GenerationJobRow>(
          `UPDATE lesson_author_generation_jobs SET ai_reservation_id = $4,
             dispatch_started_at = clock_timestamp(), progress_code = 'DESIGNING_COURSE'
           WHERE ${LIVE_LEASE} AND dispatch_started_at IS NULL RETURNING *`,
          [...leaseParams(lease), reservationId],
        );
        return requireRow(marked.rows);
      });
    },

    async succeed(
      lease: GenerationJobLease,
      revalidatePersistAndAccount: (tx: GenerationJobSql, job: GenerationJobRow) => Promise<{
        blueprintId: string; assistantMessageId: string;
      }>,
    ): Promise<GenerationJobRow> {
      return db.transaction(async tx => {
        const locked = await tx.query<GenerationJobRow>(
          `SELECT * FROM lesson_author_generation_jobs WHERE ${LIVE_LEASE}
           AND dispatch_started_at IS NOT NULL FOR UPDATE`, leaseParams(lease),
        );
        const job = requireRow(locked.rows);
        // Recheck ownership/snapshots; use authoritative Node acceptance, then
        // persist Blueprint + assistant + accounting in this SAME transaction.
        const result = await revalidatePersistAndAccount(tx, job);
        const completed = await tx.query<GenerationJobRow>(
          `UPDATE lesson_author_generation_jobs SET status = 'succeeded',
             result_blueprint_id = $4, assistant_message_id = $5, finished_at = clock_timestamp(),
             progress_code = 'BLUEPRINT_READY', lease_token = NULL, lease_expires_at = NULL
           WHERE ${LIVE_LEASE} AND dispatch_started_at IS NOT NULL RETURNING *`,
          [...leaseParams(lease), result.blueprintId, result.assistantMessageId],
        );
        // A lease/deadline lost while persisting rolls back ALL output writes.
        return requireRow(completed.rows);
      });
    },

    async fail(
      lease: GenerationJobLease,
      failure: GenerationJobFailure,
      account: (tx: GenerationJobSql, job: GenerationJobRow) => Promise<void | { assistantMessageId: string }>,
    ): Promise<GenerationJobRow> {
      checkFailure(failure);
      return db.transaction(async tx => {
        const locked = await tx.query<GenerationJobRow>(
          `SELECT * FROM lesson_author_generation_jobs WHERE ${LIVE_LEASE} FOR UPDATE`, leaseParams(lease),
        );
        const result = await account(tx, requireRow(locked.rows));
        const failed = await tx.query<GenerationJobRow>(
          `UPDATE lesson_author_generation_jobs SET status = 'failed', failure_stage = $4,
             internal_failure_code = $5, external_failure_code = $6, finished_at = clock_timestamp(),
             progress_code = 'BLUEPRINT_FAILED', lease_token = NULL, lease_expires_at = NULL,
             assistant_message_id = $7
           WHERE ${LIVE_LEASE} RETURNING *`,
          [...leaseParams(lease), failure.stage, failure.internalCode, failure.externalCode, result?.assistantMessageId ?? null],
        );
        return requireRow(failed.rows);
      });
    },

    /**
     * Reconcile one locked expired row per short transaction. The accounting hook
     * is REQUIRED; unknown dispatched usage must not be released/recorded as zero.
     * There is deliberately no implicit reservation release or provider callback.
     */
    async recoverOne(
      reconcileAccounting: (tx: GenerationJobSql, job: GenerationJobRow,
        outcome: 'timeout' | 'outcome_unknown') => Promise<void | { assistantMessageId: string }>,
    ): Promise<GenerationJobRow | null> {
      return db.transaction(async tx => {
        const locked = await tx.query<GenerationJobRow>(
          `SELECT * FROM lesson_author_generation_jobs WHERE status IN ('queued', 'running')
             AND (deadline_at <= clock_timestamp() OR (status = 'running' AND lease_expires_at <= clock_timestamp()))
           ORDER BY deadline_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`,
        );
        const job = locked.rows[0];
        if (!job) return null;
        const clock = await tx.query<{ database_now: Date }>('SELECT clock_timestamp() AS database_now');
        const action = generationRecoveryAction(job, clock.rows[0].database_now);
        if (action === 'none') return null;
        if (action === 'requeue') {
          const result = await tx.query<GenerationJobRow>(
            `UPDATE lesson_author_generation_jobs SET status = 'queued', lease_token = NULL,
               lease_expires_at = NULL, progress_code = 'QUEUED'
             WHERE id = $1 AND tenant_id = $2 AND status = 'running' AND lease_token = $3
               AND lease_expires_at <= clock_timestamp() AND deadline_at > clock_timestamp()
               AND dispatch_started_at IS NULL RETURNING *`,
            [job.id, job.tenant_id, job.lease_token],
          );
          // A deadline crossed during this short transaction is handled next poll.
          return result.rows[0] ?? null;
        }
        const accounting = await reconcileAccounting(tx, job, action);
        const code = action === 'outcome_unknown' ? 'GENERATION_OUTCOME_UNKNOWN' : 'GENERATION_WORKFLOW_TIMEOUT';
        const result = await tx.query<GenerationJobRow>(
          `UPDATE lesson_author_generation_jobs SET status = 'failed', failure_stage = 'generation_recovery',
             internal_failure_code = $4, external_failure_code = $4, finished_at = clock_timestamp(),
             progress_code = 'BLUEPRINT_FAILED', lease_token = NULL, lease_expires_at = NULL,
             assistant_message_id = $6
           WHERE id = $1 AND tenant_id = $2 AND status = $5 AND lease_token IS NOT DISTINCT FROM $3::uuid
             AND (deadline_at <= clock_timestamp() OR (status = 'running' AND lease_expires_at <= clock_timestamp()))
           RETURNING *`,
          [job.id, job.tenant_id, job.lease_token, code, job.status, accounting?.assistantMessageId ?? null],
        );
        return requireRow(result.rows);
      });
    },
  };
}
