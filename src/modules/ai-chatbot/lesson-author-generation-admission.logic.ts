import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import { AppError } from '../../middleware/error-handler.js';
import { GenerationJobError, type generationJobStatusView } from './lesson-author-generation-job.logic.js';

export type GenerationAdmissionStage = 'admission_start' | 'worker_readiness' | 'conversation_lock'
  | 'idempotency_lookup' | 'actor_authorization' | 'conversation_context' | 'runtime_settings'
  | 'editor_context' | 'intent_routing' | 'source_validation' | 'course_context' | 'history_context'
  | 'snapshot_preparation' | 'input_filter' | 'enqueue_transaction' | 'quota_reservation'
  | 'user_message_write' | 'conversation_update' | 'job_insert' | 'enqueue_committed';

export interface GenerationAdmissionContext {
  correlationId: string;
  stage(value: GenerationAdmissionStage): void;
  beginEnqueue(): void;
  committed(correlationId: string): void;
}

/** Called only after existing HTTP authentication/tenant/body checks. */
export async function respondToGenerationAdmission(
  res: Response,
  enqueue: (context: GenerationAdmissionContext) => Promise<ReturnType<typeof generationJobStatusView> | null>,
  options: { conversationId?: string; report?: (record: Record<string, unknown>) => void } = {},
): Promise<boolean> {
  const started = Date.now();
  let stage: GenerationAdmissionStage = 'admission_start';
  let transactionStarted = false;
  let committed = false;
  const context: GenerationAdmissionContext = {
    correlationId: randomUUID(), stage: value => { stage = value; },
    beginEnqueue: () => { transactionStarted = true; stage = 'enqueue_transaction'; },
    committed: correlationId => { committed = true; context.correlationId = correlationId; stage = 'enqueue_committed'; },
  };
  const sink = options.report ?? (record => console.info('[LessonAuthorGeneration]', JSON.stringify(record)));
  const report = (record: Record<string, unknown>) => { try { sink(record); } catch { /* logging cannot change admission outcome */ } };
  report({ event: 'generation_admission_started', correlation_id: context.correlationId,
    conversation_id: options.conversationId ?? null });
  try {
    const job = await enqueue(context);
    if (!job) return false; // explicitly ineligible/disabled, not a failure fallback
    res.setHeader('Cache-Control', 'no-store');
    res.status(202).json({ success: true, data: job });
    return true;
  } catch (error) {
    const candidate = error instanceof GenerationJobError || error instanceof AppError ? error.code : null;
    const code = candidate && /^[A-Z][A-Z0-9_]{0,99}$/.test(candidate) ? candidate : 'GENERATION_ENQUEUE_FAILED';
    const status = error instanceof GenerationJobError ? 409 : error instanceof AppError ? error.statusCode : 503;
    const db = error && typeof error === 'object' ? error as Record<string, unknown> : {};
    const sqlstate = typeof db.code === 'string' && /^[0-9A-Z]{5}$/.test(db.code) ? db.code : null;
    // A server-reported statement rejection rolls back. Connection/COMMIT loss is not proof of rejection.
    const knownRollback = error instanceof GenerationJobError || error instanceof AppError
      || (sqlstate !== null && /^(22|23|40|42|P0)/.test(sqlstate));
    const outcome = !committed && (!transactionStarted || knownRollback) ? 'rejected' : 'unknown';
    const httpStatus = outcome === 'unknown' ? 503 : status;
    const constraint = typeof db.constraint === 'string' && /^(la_generation_|ai_token_)[a-z0-9_]{1,100}$/.test(db.constraint) ? db.constraint : null;
    const origin = error instanceof Error
      ? error.stack?.match(/(?:chat\.service|lesson-author-[a-z-]+|ai-token-quota\.service)\.(?:ts|js):\d+:\d+/)?.[0] ?? null : null;
    report({ event: 'generation_admission_failed', correlation_id: context.correlationId,
      conversation_id: options.conversationId ?? null, failure_stage: stage,
      internal_failure_code: sqlstate ? 'GENERATION_DATABASE_ERROR' : code, external_failure_code: code,
      http_status: httpStatus, admission_status: outcome, duration_ms: Date.now() - started,
      db_sqlstate: sqlstate, db_constraint: constraint, error_origin: origin });
    res.setHeader('Cache-Control', 'no-store');
    res.status(httpStatus).json({ success: false, code, kind: 'lesson_author_admission_error',
      correlation_id: context.correlationId, admission_status: outcome,
      message: error instanceof AppError ? error.message : 'Chưa thể tiếp nhận tác vụ tạo khóa học. Vui lòng kiểm tra trạng thái cuộc hội thoại.' });
    return true; // never retry/fallback to synchronous paid work after uncertainty
  }
}
