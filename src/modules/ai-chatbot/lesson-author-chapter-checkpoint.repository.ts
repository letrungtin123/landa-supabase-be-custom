import { randomUUID } from 'node:crypto';
import type { GenerationJobDatabase, GenerationJobSql } from './lesson-author-generation-job.repository.js';
import { GENERATION_JOB_LEASE_MS, generationSnapshotHash } from './lesson-author-generation-job.logic.js';
import {
  ChapterCheckpointError, assertChapterCheckpointIndex, assertChapterCheckpoints, assertChapterSnapshot, assertChapterUnitPayload,
  chapterAttemptMatches, chapterCheckpointStatus, assertChapterResume, assertChapterUnitInventory,
  type ChapterAttemptRow, type ChapterCheckpointOwner, type ChapterCheckpointSnapshot,
  type ChapterDraftRow, type ChapterUnitContract, type ChapterUnitIdentity, type ChapterUnitPayload, type ChapterUnitRow,
} from './lesson-author-chapter-checkpoint.logic.js';

export interface ChapterExecutionLease extends ChapterCheckpointOwner {
  draftId: string;
  attemptId: string;
  leaseToken: string;
}
export interface ChapterExecutionFailure {
  stage: string;
  internalCode: string;
  externalCode: string;
}
export type ChapterAccountingAcknowledgement = 'settled' | 'pending_reconciliation';
export interface ChapterAdmission extends ChapterCheckpointOwner, ChapterCheckpointSnapshot {
  botId: string; kbId: string; blueprintId: string; chapterIndex: number;
  idempotencyKey: string; correlationId: string; locale: 'vi' | 'en'; model: string;
  sourceDocumentIds: string[]; unitContracts: ChapterUnitContract[];
  resume?: { draftId: string; previousAttemptId: string };
}

/** No connections, routes, polling or provider dispatch on import.
 * API adapter must perform the existing RBAC/source/editor/quota checks first.
 * Every write locks parent before attempt, matching the installed SQL guards.
 * All callbacks run in the transaction: Node-only validation/DB work, never AI.
 */
export function createChapterCheckpointRepository(db: GenerationJobDatabase) {
  async function ownedDraft(tx: GenerationJobSql, owner: ChapterCheckpointOwner, id: string, lock: boolean) {
    const result = await tx.query<ChapterDraftRow>(
      `SELECT * FROM lesson_author_chapter_drafts
       WHERE id=$1 AND tenant_id=$2 AND conversation_id=$3 AND requested_by=$4 AND course_id=$5
       ${lock ? 'FOR UPDATE' : ''}`,
      [id, owner.tenantId, owner.conversationId, owner.userId, owner.courseId],
    );
    if (!result.rows[0]) throw new ChapterCheckpointError('CHAPTER_CHECKPOINT_NOT_FOUND');
    return result.rows[0];
  }
  async function clock(tx: GenerationJobSql) {
    const { rows } = await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now');
    if (!(rows[0]?.now instanceof Date) || !Number.isFinite(rows[0].now.getTime())) {
      throw new ChapterCheckpointError('CHAPTER_CHECKPOINT_CONTRACT_INVALID');
    }
    return rows[0].now;
  }
  async function execution(tx: GenerationJobSql, lease: ChapterExecutionLease, requireLive = true) {
    const draft = await ownedDraft(tx, lease, lease.draftId, true);
    const { rows } = await tx.query<ChapterAttemptRow>(
      `SELECT * FROM lesson_author_chapter_attempts
       WHERE id=$1 AND draft_id=$2 AND tenant_id=$3 AND course_id=$4 AND lease_token=$5 FOR UPDATE`,
      [lease.attemptId, lease.draftId, lease.tenantId, lease.courseId, lease.leaseToken],
    );
    const attempt = rows[0];
    const now = await clock(tx);
    if (!attempt || !chapterAttemptMatches(draft, attempt) || attempt.status !== 'running'
      || draft.status !== 'open' || (requireLive && (draft.expires_at <= now
        || attempt.lease_expires_at <= now || attempt.deadline_at <= now))) {
      throw new ChapterCheckpointError('CHAPTER_CHECKPOINT_LEASE_LOST');
    }
    return { draft, attempt, now };
  }
  async function checkpoints(tx: GenerationJobSql, draft: ChapterDraftRow) {
    const { rows } = await tx.query<ChapterUnitRow>(
      `SELECT * FROM lesson_author_chapter_units WHERE draft_id=$1 AND tenant_id=$2 AND course_id=$3 ORDER BY unit_index`,
      [draft.id, draft.tenant_id, draft.course_id],
    );
    assertChapterCheckpoints(draft, rows);
    return rows;
  }
  async function checkpointIndex(tx: GenerationJobSql, draft: ChapterDraftRow) {
    const { rows } = await tx.query<ChapterUnitIdentity>(
      `SELECT draft_id,tenant_id,course_id,unit_index,contract_hash,evidence_hash FROM lesson_author_chapter_units
       WHERE draft_id=$1 AND tenant_id=$2 AND course_id=$3 ORDER BY unit_index`,
      [draft.id, draft.tenant_id, draft.course_id],
    );
    assertChapterCheckpointIndex(draft, rows);
    return rows;
  }
  function requireWrite(rowCount: number | null) {
    if (rowCount !== 1) throw new ChapterCheckpointError('CHAPTER_CHECKPOINT_LEASE_LOST');
  }
  const live = `id=$1 AND draft_id=$2 AND tenant_id=$3 AND course_id=$4 AND lease_token=$5
    AND status='running' AND lease_expires_at>clock_timestamp() AND deadline_at>clock_timestamp()`;
  const keys = (lease: ChapterExecutionLease) => [lease.attemptId, lease.draftId, lease.tenantId, lease.courseId, lease.leaseToken];

  return {
    async load(owner: ChapterCheckpointOwner, draftId: string) {
      return db.transaction(async tx => {
        const draft = await ownedDraft(tx, owner, draftId, false);
        const { rows } = await tx.query<ChapterAttemptRow>(`SELECT * FROM lesson_author_chapter_attempts
          WHERE draft_id=$1 AND tenant_id=$2 AND course_id=$3 ORDER BY attempt_number`, [draft.id, owner.tenantId, owner.courseId]);
        return { draft, attempts: rows, units: await checkpoints(tx, draft) };
      });
    },

    async admit(input: ChapterAdmission,
      grant: (tx: GenerationJobSql, draftId: string, attemptId: string) => Promise<{
        userMessageId: string; reservationId: string; maxOutputTokens: number; maxAttempts: number;
      }>) {
      assertChapterUnitInventory(input.unitContracts);
      return db.transaction(async tx => {
        // Serialize even across independent Node processes; same lock order as caller.
        const conversation = await tx.query(`SELECT id FROM chat_conversations WHERE id=$1 AND tenant_id=$2
          AND user_id=$3 AND course_id=$4 FOR UPDATE`, [input.conversationId, input.tenantId, input.userId, input.courseId]);
        if (!conversation.rows.length) throw new ChapterCheckpointError('CHAPTER_CHECKPOINT_NOT_FOUND');
        let draft: ChapterDraftRow;
        if (input.resume) draft = await ownedDraft(tx, input, input.resume.draftId, true);
        else {
          const prior = await tx.query<ChapterDraftRow>(`SELECT * FROM lesson_author_chapter_drafts
            WHERE tenant_id=$1 AND conversation_id=$2 AND requested_by=$3 AND idempotency_key=$4 FOR UPDATE`,
          [input.tenantId, input.conversationId, input.userId, input.idempotencyKey]);
          if (prior.rows[0]) draft = prior.rows[0];
          else {
            const open = await tx.query(`SELECT id FROM lesson_author_chapter_drafts WHERE tenant_id=$1
              AND conversation_id=$2 AND status='open' FOR UPDATE`, [input.tenantId, input.conversationId]);
            if (open.rows.length) throw new ChapterCheckpointError('CHAPTER_CHECKPOINT_RESUME_NOT_ALLOWED');
            const result = await tx.query<ChapterDraftRow>(`INSERT INTO lesson_author_chapter_drafts
              (tenant_id,course_id,conversation_id,requested_by,bot_id,kb_id,blueprint_id,chapter_index,
               idempotency_key,request_hash,blueprint_hash,source_snapshot_hash,course_outline_hash,runtime_config_hash,
               locale,model,source_document_ids,total_units,unit_contracts)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb) RETURNING *`,
            [input.tenantId,input.courseId,input.conversationId,input.userId,input.botId,input.kbId,input.blueprintId,
              input.chapterIndex,input.idempotencyKey,input.request_hash,input.blueprint_hash,input.source_snapshot_hash,
              input.course_outline_hash,input.runtime_config_hash,input.locale,input.model,input.sourceDocumentIds,
              input.unitContracts.length,JSON.stringify(input.unitContracts)]);
            draft = result.rows[0];
          }
        }
        assertChapterSnapshot(draft, input);
        if (draft.blueprint_id !== input.blueprintId || draft.chapter_index !== input.chapterIndex
          || draft.course_id !== input.courseId || draft.model !== input.model || draft.locale !== input.locale
          || generationSnapshotHash(draft.unit_contracts) !== generationSnapshotHash(input.unitContracts)) {
          throw new ChapterCheckpointError('CHAPTER_CHECKPOINT_SNAPSHOT_CHANGED');
        }
        const attempts = await tx.query<ChapterAttemptRow>(`SELECT * FROM lesson_author_chapter_attempts
          WHERE draft_id=$1 AND tenant_id=$2 AND course_id=$3 ORDER BY attempt_number DESC FOR UPDATE`,
        [draft.id,input.tenantId,input.courseId]);
        const prior = attempts.rows.find(a => a.idempotency_key === input.idempotencyKey);
        if (prior) {
          if ((prior.previous_attempt_id ?? null) !== (input.resume?.previousAttemptId ?? null)) {
            throw new ChapterCheckpointError('CHAPTER_CHECKPOINT_RESUME_NOT_ALLOWED');
          }
          return { draft, attempt: prior, created: false, units: await checkpoints(tx, draft) };
        }
        const now = await clock(tx);
        if (input.resume) {
          if (!attempts.rows[0]) throw new ChapterCheckpointError('CHAPTER_CHECKPOINT_RESUME_NOT_ALLOWED');
          assertChapterResume(draft, attempts.rows[0], input.resume.previousAttemptId, now);
        }
        else if (attempts.rows.length || draft.status !== 'open' || draft.expires_at <= now) {
          throw new ChapterCheckpointError('CHAPTER_CHECKPOINT_RESUME_NOT_ALLOWED');
        }
        const attemptId = randomUUID();
        const budget = await grant(tx, draft.id, attemptId);
        const inserted = await tx.query<ChapterAttemptRow>(`INSERT INTO lesson_author_chapter_attempts
          (id,draft_id,tenant_id,course_id,attempt_number,previous_attempt_id,idempotency_key,correlation_id,
           user_message_id,ai_reservation_id,max_output_tokens,max_provider_attempts,lease_token,heartbeat_at,lease_expires_at,deadline_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now(),now()+interval '45 seconds',now()+interval '10 minutes') RETURNING *`,
        [attemptId,draft.id,input.tenantId,input.courseId,Number(attempts.rows[0]?.attempt_number ?? 0)+1,
          input.resume?.previousAttemptId ?? null,input.idempotencyKey,input.correlationId,budget.userMessageId,
          budget.reservationId,budget.maxOutputTokens,budget.maxAttempts,randomUUID()]);
        return { draft, attempt: inserted.rows[0], created: true, units: await checkpoints(tx, draft) };
      });
    },
    async status(owner: ChapterCheckpointOwner, draftId: string) {
      return db.transaction(async tx => {
        // One statement gives a coherent parent/count/latest attempt under READ COMMITTED.
        // Never fetch unit payloads for browser status.
        const { rows } = await tx.query<ChapterDraftRow & { latest: ChapterAttemptRow | null; completed: number; database_now: Date }>(
          `SELECT d.*, (SELECT row_to_json(a) FROM lesson_author_chapter_attempts a
            WHERE a.draft_id=d.id AND a.tenant_id=d.tenant_id AND a.course_id=d.course_id
            ORDER BY a.attempt_number DESC LIMIT 1) AS latest,
           (SELECT count(*)::int FROM lesson_author_chapter_units
            WHERE draft_id=d.id AND tenant_id=d.tenant_id AND course_id=d.course_id) AS completed,
           clock_timestamp() AS database_now FROM lesson_author_chapter_drafts d
           WHERE d.id=$1 AND d.tenant_id=$2 AND d.conversation_id=$3 AND d.requested_by=$4 AND d.course_id=$5`,
          [draftId, owner.tenantId, owner.conversationId, owner.userId, owner.courseId],
        );
        if (!rows[0]) throw new ChapterCheckpointError('CHAPTER_CHECKPOINT_NOT_FOUND');
        // Dates nested in JSON are strings; public projection uses no attempt dates.
        return chapterCheckpointStatus(rows[0], rows[0].latest, rows[0].completed, rows[0].database_now);
      });
    },

    async renew(lease: ChapterExecutionLease): Promise<void> {
      await db.transaction(async tx => {
        await execution(tx, lease);
        const result = await tx.query(
          `WITH tick AS MATERIALIZED (SELECT clock_timestamp() AS ts)
           UPDATE lesson_author_chapter_attempts SET heartbeat_at=tick.ts,
           lease_expires_at=LEAST(deadline_at,tick.ts+($6::int * interval '1 millisecond')) FROM tick
           WHERE ${live} RETURNING id`, [...keys(lease), GENERATION_JOB_LEASE_MS],
        );
        requireWrite(result.rowCount);
      });
    },

    async markDispatched(lease: ChapterExecutionLease, snapshot: ChapterCheckpointSnapshot, unitIndex: number): Promise<void> {
      await db.transaction(async tx => {
        const { draft, attempt } = await execution(tx, lease);
        assertChapterSnapshot(draft, snapshot);
        // Same index is NOT permission to replay a call whose outcome is unknown.
        if (attempt.in_flight_unit_index !== null) throw new ChapterCheckpointError('CHAPTER_CHECKPOINT_ALREADY_DISPATCHED');
        const stored = await checkpointIndex(tx, draft);
        const done = new Set(stored.map(unit => unit.unit_index));
        if (done.has(unitIndex)) throw new ChapterCheckpointError('CHAPTER_CHECKPOINT_ALREADY_COMMITTED');
        if (!Number.isSafeInteger(unitIndex) || draft.unit_contracts.find(c => !done.has(c.index))?.index !== unitIndex) {
          throw new ChapterCheckpointError('CHAPTER_CHECKPOINT_CONTRACT_INVALID');
        }
        const result = await tx.query(
          `UPDATE lesson_author_chapter_attempts SET dispatch_started_at=COALESCE(dispatch_started_at,clock_timestamp()),
           in_flight_unit_index=$6 WHERE ${live} AND in_flight_unit_index IS NULL RETURNING id`,
          [...keys(lease), unitIndex],
        );
        requireWrite(result.rowCount);
      });
    },

    async markFinalValidation(lease: ChapterExecutionLease, snapshot: ChapterCheckpointSnapshot): Promise<void> {
      await db.transaction(async tx=>{
        const {draft,attempt}=await execution(tx,lease);
        assertChapterSnapshot(draft,snapshot);
        if (attempt.in_flight_unit_index!==null || (await checkpointIndex(tx,draft)).length!==draft.total_units) {
          throw new ChapterCheckpointError('CHAPTER_CHECKPOINT_INCOMPLETE');
        }
        // No content generation, but evidence retrieval may incur embedding usage.
        requireWrite((await tx.query(`UPDATE lesson_author_chapter_attempts
          SET dispatch_started_at=COALESCE(dispatch_started_at,clock_timestamp()) WHERE ${live} RETURNING id`,keys(lease))).rowCount);
      });
    },

    async commitUnit(lease: ChapterExecutionLease, snapshot: ChapterCheckpointSnapshot, unitIndex: number,
      value: ChapterUnitPayload, validationContract: string,
      validate: (payload: ChapterUnitPayload, contract: ChapterUnitContract) => void | Promise<void>): Promise<void> {
      // Clone caller-owned objects before the first await; mutation while awaiting a
      // lock cannot change what was validated. Provider never supplies storage hashes.
      assertChapterUnitPayload(value);
      const payload = structuredClone(value);
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(validationContract)) {
        throw new ChapterCheckpointError('CHAPTER_CHECKPOINT_CONTRACT_INVALID');
      }
      await db.transaction(async tx => {
        const { draft, attempt } = await execution(tx, lease);
        assertChapterSnapshot(draft, snapshot);
        const stored = await checkpointIndex(tx, draft);
        if (stored.some(unit => unit.unit_index === unitIndex)) throw new ChapterCheckpointError('CHAPTER_CHECKPOINT_ALREADY_COMMITTED');
        const contract = draft.unit_contracts[unitIndex];
        if (!Number.isSafeInteger(unitIndex) || !contract || attempt.in_flight_unit_index !== unitIndex) {
          throw new ChapterCheckpointError('CHAPTER_CHECKPOINT_CONTRACT_INVALID');
        }
        // Mandatory adapter for existing authoritative registry/source/unit validation.
        await validate(payload, structuredClone(contract));
        assertChapterUnitPayload(payload);
        const result = await tx.query(
          `INSERT INTO lesson_author_chapter_units
           (draft_id,tenant_id,course_id,unit_index,attempt_id,lease_token,contract_hash,evidence_hash,payload_hash,validation_contract,payload)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) RETURNING unit_index`,
          [draft.id, draft.tenant_id, draft.course_id, unitIndex, attempt.id, lease.leaseToken,
            contract.contract_hash, contract.evidence_hash, generationSnapshotHash(payload), validationContract, JSON.stringify(payload)],
        );
        requireWrite(result.rowCount);
        const cleared = await tx.query(
          `UPDATE lesson_author_chapter_attempts SET in_flight_unit_index=NULL
           WHERE ${live} AND in_flight_unit_index=$6 RETURNING id`, [...keys(lease), unitIndex],
        );
        requireWrite(cleared.rowCount);
      });
    },

    async interrupt(lease: ChapterExecutionLease, status: 'timed_out' | 'outcome_unknown' | 'failed',
      failure: ChapterExecutionFailure,
      acknowledgeAccounting: (tx: GenerationJobSql, attempt: ChapterAttemptRow,
        requiresHold: boolean) => Promise<ChapterAccountingAcknowledgement>): Promise<void> {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(failure.stage)
        || !/^[A-Z][A-Z0-9_]{0,99}$/.test(failure.internalCode)
        || !/^[A-Z][A-Z0-9_]{0,99}$/.test(failure.externalCode)) {
        throw new ChapterCheckpointError('CHAPTER_CHECKPOINT_CONTRACT_INVALID');
      }
      await db.transaction(async tx => {
        const { draft, attempt, now } = await execution(tx, lease, false);
        if (status === 'outcome_unknown' && attempt.lease_expires_at > now && attempt.deadline_at > now) {
          throw new ChapterCheckpointError('CHAPTER_CHECKPOINT_LEASE_LOST');
        }
        const requiresHold = status !== 'failed' && attempt.dispatch_started_at !== null;
        const accounting = await acknowledgeAccounting(tx, attempt, requiresHold);
        if (!['settled', 'pending_reconciliation'].includes(accounting) || (requiresHold && accounting !== 'pending_reconciliation')) {
          throw new ChapterCheckpointError('CHAPTER_CHECKPOINT_CONTRACT_INVALID');
        }
        const result = await tx.query(
          `UPDATE lesson_author_chapter_attempts SET status=$6,finished_at=clock_timestamp(),
           failure_stage=$7,internal_failure_code=$8,external_failure_code=$9,accounting_state=$10
           WHERE id=$1 AND draft_id=$2 AND tenant_id=$3 AND course_id=$4 AND lease_token=$5 AND status='running' RETURNING id`,
          [...keys(lease), status, failure.stage, failure.internalCode, failure.externalCode, accounting],
        );
        requireWrite(result.rowCount);
        if (status === 'failed') {
          requireWrite((await tx.query(`UPDATE lesson_author_chapter_drafts SET status='failed'
            WHERE id=$1 AND tenant_id=$2 AND status='open' RETURNING id`, [draft.id, draft.tenant_id])).rowCount);
        }
      });
    },

    async publish(lease: ChapterExecutionLease, snapshot: ChapterCheckpointSnapshot,
      acceptAndPersist: (tx: GenerationJobSql, draft: ChapterDraftRow, units: readonly ChapterUnitRow[])
        => Promise<{ jobId: string; accounting: ChapterAccountingAcknowledgement }>): Promise<string> {
      return db.transaction(async tx => {
        const { draft } = await execution(tx, lease);
        assertChapterSnapshot(draft, snapshot);
        const stored = await checkpoints(tx, draft);
        if (stored.length !== draft.total_units) throw new ChapterCheckpointError('CHAPTER_CHECKPOINT_INCOMPLETE');
        // Caller must have completed Python full-chapter validation and MUST rerun
        // Node acceptance/current permissions here before creating the complete job.
        const result = await acceptAndPersist(tx, draft, stored);
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result.jobId)
          || !['settled', 'pending_reconciliation'].includes(result.accounting)) {
          throw new ChapterCheckpointError('CHAPTER_CHECKPOINT_CONTRACT_INVALID');
        }
        requireWrite((await tx.query(`UPDATE lesson_author_chapter_attempts
          SET status='completed',finished_at=clock_timestamp(),accounting_state=$6
          WHERE ${live} AND in_flight_unit_index IS NULL RETURNING id`, [...keys(lease), result.accounting])).rowCount);
        requireWrite((await tx.query(`UPDATE lesson_author_chapter_drafts SET status='ready',result_job_id=$3
          WHERE id=$1 AND tenant_id=$2 AND status='open' RETURNING id`, [draft.id, draft.tenant_id, result.jobId])).rowCount);
        return result.jobId;
      });
    },
  };
}
