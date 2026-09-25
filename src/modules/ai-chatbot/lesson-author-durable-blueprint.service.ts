import { randomUUID } from 'node:crypto';
import { query, withDatabaseTransaction } from '../../config/database.js';
import { env } from '../../config/env.js';
import { AppError } from '../../middleware/error-handler.js';
import { prepareDurableBlueprint, withLessonAuthorConversationLock, type ChatStreamOptions } from './chat.service.js';
import { createGenerationJobRepository, type GenerationJobFailure } from './lesson-author-generation-job.repository.js';
import { GenerationJobError, generationJobStatusView, hasCompleteGenerationUsage, type GenerationJobRow } from './lesson-author-generation-job.logic.js';
import { runGenerationJob } from './lesson-author-generation-runner.logic.js';
import type { GenerationAdmissionContext } from './lesson-author-generation-admission.logic.js';
import { RagServiceError } from './ai-rag-client.service.js';
import { BlueprintAcceptanceError } from './lesson-author-blueprint-acceptance.logic.js';
import { finalizeTenantAiTokens, normalizeAiUsage, releaseTenantAiTokenReservation } from './ai-token-quota.service.js';

export const durableBlueprintRepository = createGenerationJobRepository({ transaction: withDatabaseTransaction });
type Prepared = NonNullable<Awaited<ReturnType<typeof prepareDurableBlueprint>>>;
const log = (record: Record<string, unknown>) => console.info('[LessonAuthorGeneration]', JSON.stringify(record));
let ready = false;

/** Read-only deployment gate. No schema creation or drift-tolerating fallback. */
export async function verifyDurableBlueprintSchema(): Promise<void> {
  const result = await query<{ guard_hash: string; can_write: boolean; rls: boolean; browser_access: boolean; safety_triggers: boolean; no_policies: boolean }>(`
    SELECT md5(btrim(replace(p.prosrc,chr(13),''),E' \\n\\t')) AS guard_hash,
      has_table_privilege(current_user,c.oid,'SELECT') AND has_table_privilege(current_user,c.oid,'INSERT')
      AND has_table_privilege(current_user,c.oid,'UPDATE') AND (c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)
        OR (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname=current_user)) AS can_write,
      c.relrowsecurity AS rls,
      NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid=c.oid) AS no_policies,
      (SELECT count(*)=6 FROM pg_trigger tr WHERE tr.tgrelid=c.oid AND NOT tr.tgisinternal AND tr.tgenabled IN ('O','A')
        AND (tr.tgname,tr.tgfoid) IN (
          ('trg_la_generation_state',to_regprocedure('public.guard_lesson_author_generation_state()')),
          ('trg_la_generation_scope',to_regprocedure('public.assert_lesson_author_generation_scope()')),
          ('trg_deletion_fence_course_write',to_regprocedure('public.assert_active_course_deletion_fence()')),
          ('tenant_data_quota_direct_insert',to_regprocedure('public.tenant_data_quota_apply_direct_delta()')),
          ('tenant_data_quota_direct_update',to_regprocedure('public.tenant_data_quota_apply_direct_delta()')),
          ('tenant_data_quota_direct_delete',to_regprocedure('public.tenant_data_quota_apply_direct_delta()')))) AS safety_triggers,
      has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE') OR
        has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE') AS browser_access
    FROM pg_proc p CROSS JOIN pg_class c
    WHERE p.oid=to_regprocedure('public.guard_lesson_author_generation_state()')
      AND c.oid=to_regclass('public.lesson_author_generation_jobs')`);
  const row = result.rows[0];
  if (!row || row.guard_hash !== '4770750161a360a49be0defcd3be4207' || !row.can_write || !row.rls
    || row.browser_access || !row.safety_triggers || !row.no_policies) {
    throw new GenerationJobError('GENERATION_JOB_CONTRACT_INVALID');
  }
}

export async function tryEnqueueDurableBlueprint(
  conversationId: string, userId: string, tenantId: string, content: string,
  idempotencyKey: string, options: ChatStreamOptions, admission?: GenerationAdmissionContext,
) {
  if (!env.LESSON_AUTHOR_GENERATION_ENABLED || options.target !== 'lesson_author') return null;
  admission?.stage('worker_readiness');
  if (!ready) throw new AppError('Dịch vụ tạo khóa học chưa sẵn sàng.', 503, 'GENERATION_WORKER_UNAVAILABLE');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idempotencyKey)) {
    throw new AppError('Idempotency key không hợp lệ.', 400, 'GENERATION_IDENTIFIER_INVALID');
  }
  admission?.stage('conversation_lock');
  return withLessonAuthorConversationLock(conversationId, async () => {
    // On replay reconstruct the original history boundary, not its newly saved user turn.
    admission?.stage('idempotency_lookup');
    const prior = await query<GenerationJobRow>(`SELECT * FROM lesson_author_generation_jobs
      WHERE tenant_id=$1 AND conversation_id=$2 AND requested_by=$3 AND idempotency_key=$4`,
      [tenantId, conversationId, userId, idempotencyKey]);
    const prepared = await prepareDurableBlueprint(conversationId, userId, tenantId, content, options, prior.rows[0], admission?.stage);
    if (!prepared) {
      if (prior.rows.length) throw new GenerationJobError('GENERATION_IDEMPOTENCY_CONFLICT');
      return null;
    }
    admission?.stage('input_filter');
    if (!prior.rows.length) await prepared.filterInput();
    const correlationId = admission?.correlationId ?? randomUUID();
    admission?.beginEnqueue();
    const result = await durableBlueprintRepository.enqueue({ ...prepared.identity, idempotencyKey, correlationId },
      async () => {
        const grant = await prepared.reserveAndCreateMessage(correlationId);
        admission?.stage('job_insert');
        return grant;
      });
    admission?.committed(result.job.correlation_id);
    if (result.created) prepared.markAccepted();
    log({ event: result.created ? 'generation_enqueued' : 'generation_idempotent_replay', job_id: result.job.id,
      correlation_id: result.job.correlation_id, conversation_id: conversationId,
      max_output_tokens: result.job.max_output_tokens, max_attempts: result.job.max_attempts });
    return generationJobStatusView(result.job);
  });
}

async function reconstruct(job: GenerationJobRow): Promise<Prepared> {
  const message = await query<{ content: string; metadata: Record<string, unknown> }>(
    `SELECT content,metadata FROM chat_messages WHERE id=$1 AND conversation_id=$2 AND role='user'`,
    [job.user_message_id, job.conversation_id]);
  const row = message.rows[0];
  if (!row) throw new GenerationJobError('GENERATION_SNAPSHOT_CHANGED');
  const prepared = await prepareDurableBlueprint(job.conversation_id, job.requested_by, job.tenant_id, row.content, {
    target: 'lesson_author', courseId: job.course_id, mode: 'course_blueprint', locale: job.locale,
    sourceDocuments: job.source_document_ids.map(document_id => ({ document_id })),
    editorContext: Object.keys(job.editor_context).length ? job.editor_context : undefined,
    outlineMentions: Array.isArray(row.metadata?.outline_mentions) ? row.metadata.outline_mentions as ChatStreamOptions['outlineMentions'] : [],
  }, job);
  if (!prepared) throw new GenerationJobError('GENERATION_SNAPSHOT_CHANGED');
  assertSnapshot(job, prepared);
  return prepared;
}

function assertSnapshot(job: GenerationJobRow, prepared: Prepared): void {
  const p = prepared.identity;
  if (p.requestHash !== job.request_hash || p.sourceSnapshotHash !== job.source_snapshot_hash
    || p.courseOutlineHash !== job.course_outline_hash || p.runtimeConfigHash !== job.runtime_config_hash
    || p.model !== job.model || p.botId !== job.bot_id || p.kbId !== job.kb_id) {
    throw new GenerationJobError('GENERATION_SNAPSHOT_CHANGED');
  }
}

async function verifyReservation(job: GenerationJobRow): Promise<void> {
  const result = await query(`SELECT id FROM ai_token_reservations WHERE id=$1 AND tenant_id=$2
    AND user_id=$3 AND conversation_id=$4 AND model=$5 AND engine='self_built_rag'
    AND operation='lesson_author' AND target='lesson_author' AND status='reserved'
    AND expires_at >= $6 AND expires_at > clock_timestamp()
    AND budget_metadata ->> 'durable_generation'='true' FOR SHARE`,
    [job.ai_reservation_id, job.tenant_id, job.requested_by, job.conversation_id, job.model, job.deadline_at]);
  if (!result.rows.length) throw new GenerationJobError('GENERATION_BUDGET_CHANGED');
}

function classify(error: unknown): GenerationJobFailure {
  if (error instanceof BlueprintAcceptanceError) return { stage: error.failure_stage,
    internalCode: error.internal_failure_code, externalCode: error.code! };
  if (error instanceof RagServiceError) {
    const code = error.diagnostics.internal_failure_code;
    const stage = error.diagnostics.failure_stage;
    return { stage: typeof stage === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(stage) ? stage : 'python_blueprint',
      internalCode: typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(code) ? code : 'AI_RAG_BLUEPRINT_FAILED',
      externalCode: error.code && /^[A-Z][A-Z0-9_]{0,99}$/.test(error.code) ? error.code : 'LESSON_AUTHOR_BLUEPRINT_FAILED' };
  }
  const candidate = error instanceof GenerationJobError ? error.code : error instanceof AppError ? error.code : null;
  const internalCode = candidate && /^[A-Z][A-Z0-9_]{0,99}$/.test(candidate) ? candidate : 'GENERATION_EXECUTION_FAILED';
  return { stage: 'generation_execution', internalCode,
    externalCode: error instanceof GenerationJobError ? error.code : 'LESSON_AUTHOR_BLUEPRINT_FAILED' };
}

async function accountFailure(job: GenerationJobRow, error?: unknown, receivedUsage?: unknown, embeddingModel?: string) {
  const usage = error instanceof RagServiceError ? error.usage : receivedUsage;
  if (!job.dispatch_started_at) await releaseTenantAiTokenReservation(job.ai_reservation_id, job.tenant_id);
  else if (hasCompleteGenerationUsage(usage)) {
    await finalizeTenantAiTokens({ reservationId: job.ai_reservation_id!, tenantId: job.tenant_id,
      embeddingModel,
      usage: normalizeAiUsage(usage), source: { service: 'self_built_rag', usage_source: 'rag_response' },
      metadata: { generation_job_id: job.id } });
  } else {
    // Approved policy: retain reserved amount. Never fabricate usage or replay.
    log({ event: 'generation_usage_pending_reconciliation', job_id: job.id, correlation_id: job.correlation_id,
      conversation_id: job.conversation_id, reservation_id: job.ai_reservation_id, usage_source: 'unavailable' });
  }
  const saved = await query<{ id: string }>(`INSERT INTO chat_messages(conversation_id,role,content,metadata)
    VALUES ($1,'assistant',$2,$3) RETURNING id`, [job.conversation_id,
    job.locale === 'en'
      ? 'The course blueprint could not be completed. No course changes were applied. This request will not be retried automatically.'
      : 'Chưa thể hoàn tất Bản thiết kế khóa học. Chưa có thay đổi nào được áp dụng vào khóa học. Hệ thống không tự gửi lại yêu cầu AI này.',
    { kind: 'lesson_author_generation_failed', locale: job.locale, generation_job_id: job.id, correlation_id: job.correlation_id }]);
  await query('UPDATE chat_conversations SET updated_at=now() WHERE id=$1 AND tenant_id=$2', [job.conversation_id, job.tenant_id]);
  return { assistantMessageId: saved.rows[0].id };
}

let timer: ReturnType<typeof setTimeout> | null = null;
let stopping: AbortController | null = null;
let draining: Promise<void> | null = null;

export async function startDurableBlueprintWorker(): Promise<void> {
  if (!env.LESSON_AUTHOR_GENERATION_ENABLED || stopping) return;
  await verifyDurableBlueprintSchema();
  if (env.AI_TOKEN_RESERVATION_SECONDS < 600) throw new GenerationJobError('GENERATION_JOB_CONTRACT_INVALID');
  stopping = new AbortController();
  ready = true;
  const signal = stopping.signal;
  const tick = async () => {
    if (signal.aborted) return;
    try {
      await durableBlueprintRepository.recoverOne(async (_, job) => accountFailure(job));
      const job = await durableBlueprintRepository.claimNext();
      if (job) await runGenerationJob(job, {
        prepare: reconstruct,
        authorizeDispatch: (lease, prepared) => durableBlueprintRepository.prepareDispatch(lease, async (_, current) => {
          const fresh = await reconstruct(current);
          assertSnapshot(current, prepared); assertSnapshot(current, fresh);
          await verifyReservation(current);
          return { ...fresh.identity, reservationId: current.ai_reservation_id!,
            maxOutputTokens: current.max_output_tokens, maxAttempts: current.max_attempts };
        }),
        generate: (prepared, current, abort, budget) => prepared.generate(current, abort, budget),
        complete: async (lease, _, response) => {
          const completed = await durableBlueprintRepository.succeed(lease, async (_, current) => {
            const fresh = await reconstruct(current);
            await verifyReservation(current);
            signal.throwIfAborted();
            return fresh.persist(current, response);
          });
          log({ event: 'blueprint_created', correlation_id: completed.correlation_id, job_id: completed.id,
            conversation_id: completed.conversation_id, blueprint_id: completed.result_blueprint_id, committed: true });
        },
        fail: async (lease, failure, error, response, prepared) => {
          await durableBlueprintRepository.fail(lease, failure, (_, current) => accountFailure(current, error, response?.usage, prepared?.embeddingModel));
        },
        renew: lease => durableBlueprintRepository.renew(lease), classify, report: log,
      }, signal);
    } catch { log({ event: 'generation_worker_poll_failed', internal_failure_code: 'GENERATION_WORKER_POLL_FAILED' }); }
    finally { if (!signal.aborted) timer = setTimeout(schedule, 1_000); }
  };
  const schedule = () => { draining = tick(); };
  timer = setTimeout(schedule, 0);
  log({ event: 'generation_worker_ready', concurrency_per_process: 1, deadline_ms: 600_000, replay_after_dispatch: false });
}

export async function stopDurableBlueprintWorker(): Promise<void> {
  ready = false;
  stopping?.abort();
  if (timer) clearTimeout(timer);
  // An uncertain dispatched call is left for fenced recovery, never requeued.
  await draining;
  stopping = null;
}
