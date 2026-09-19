import { createHash, randomUUID } from 'crypto';
import { createReadStream } from 'fs';
import { query, withDatabaseTransaction } from '../../config/database.js';
import { env } from '../../config/env.js';
import { AppError } from '../../middleware/error-handler.js';
import {
  buildFileName,
  buildLessonAuthorPrivateStoragePath,
  deleteLessonAuthorPrivateFiles,
  downloadLessonAuthorPrivateText,
  uploadLessonAuthorPrivateFileFromPath,
} from '../../config/storage.js';
import {
  formatLessonAuthorTranscriptMessage,
  isSupportedLessonAuthorVideo,
  LESSON_AUTHOR_VIDEO_MIME_TYPE,
  normalizeTranscriptText,
  transcriptFileName,
  type LessonAuthorTranscriptLocale,
  type LessonAuthorTranscriptionStatus,
} from './lesson-author-transcription.logic.js';
import { getActiveKbAssignmentFresh } from './chat.service.js';
import { stageTextBackedDocumentSource, createQueuedDocumentFromStagedSource } from './kb.service.js';

export interface LessonAuthorTranscriptionJob {
  id: string;
  tenant_id: string;
  course_id: string | null;
  conversation_id: string | null;
  kb_id: string | null;
  requested_by: string | null;
  requested_locale: LessonAuthorTranscriptLocale;
  idempotency_key: string;
  original_file_name: string;
  original_mime_type: string;
  source_size_bytes: string;
  source_sha256: string;
  source_storage_path: string | null;
  transcript_file_name: string;
  transcript_storage_path: string | null;
  transcript_language: string | null;
  transcript_char_count: number | null;
  status: LessonAuthorTranscriptionStatus;
  attempt_count: number;
  next_attempt_at: string;
  lease_token: string | null;
  lease_expires_at: string | null;
  last_error: string | null;
  kb_document_id: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PublicLessonAuthorTranscriptionJob {
  id: string;
  conversation_id: string | null;
  original_file_name: string;
  transcript_file_name: string;
  status: LessonAuthorTranscriptionStatus;
  transcript_language: string | null;
  transcript_char_count: number | null;
  kb_document_id: string | null;
  can_add_to_kb: boolean;
  can_retry: boolean;
  error_reason: string | null;
  created_at: string;
  updated_at: string;
}

type ConversationForTranscript = {
  id: string;
  course_id: string;
  kb_id: string;
};

export type PreparedLessonAuthorTranscriptUpload = {
  job: LessonAuthorTranscriptionJob;
  already_exists: boolean;
};

export function toPublicLessonAuthorTranscriptionJob(job: LessonAuthorTranscriptionJob): PublicLessonAuthorTranscriptionJob {
  return {
    id: job.id,
    conversation_id: job.conversation_id,
    original_file_name: job.original_file_name,
    transcript_file_name: job.transcript_file_name,
    status: job.status,
    transcript_language: job.transcript_language,
    transcript_char_count: job.transcript_char_count,
    kb_document_id: job.kb_document_id,
    can_add_to_kb: job.status === 'succeeded' && !job.kb_document_id,
    can_retry: job.status === 'failed',
    error_reason: job.status === 'failed' ? job.last_error : null,
    created_at: job.created_at,
    updated_at: job.updated_at,
  };
}

function safeFileName(fileName: string): string {
  const normalized = fileName.replace(/[\\/\u0000]/g, '_').trim();
  if (!normalized || normalized.length > 255) throw new AppError('Tên file video không hợp lệ.', 400, 'VIDEO_FILE_NAME_INVALID');
  return normalized;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function findReusableTranscriptJob(
  tenantId: string,
  conversationId: string,
  sourceSha256: string,
): Promise<LessonAuthorTranscriptionJob | null> {
  const existing = await query<LessonAuthorTranscriptionJob>(
    `SELECT *
     FROM lesson_author_transcription_jobs
     WHERE tenant_id = $1::uuid
       AND conversation_id = $2::uuid
       AND source_sha256 = $3
       AND status IN ('queued', 'running', 'succeeded', 'committed')
     ORDER BY created_at DESC
     LIMIT 1`,
    [tenantId, conversationId, sourceSha256],
  );
  return existing.rows[0] || null;
}

async function loadConversationForTranscript(
  conversationId: string,
  userId: string,
  tenantId: string,
): Promise<ConversationForTranscript> {
  const result = await query<ConversationForTranscript>(
    `SELECT id::text, course_id, ''::text AS kb_id
     FROM chat_conversations
     WHERE id = $1::uuid
       AND tenant_id = $2::uuid
       AND user_id = $3::uuid
       AND target = 'lesson_author'
       AND course_id IS NOT NULL`,
    [conversationId, tenantId, userId],
  );
  const conversation = result.rows[0];
  if (!conversation) throw new AppError('Cuộc hội thoại chuyên gia bài học không tồn tại.', 404, 'LESSON_AUTHOR_CONVERSATION_NOT_FOUND');
  const assignment = await getActiveKbAssignmentFresh(tenantId);
  if (!assignment) throw new AppError('Chưa cấu hình Kho tri thức cho chuyên gia bài học.', 409, 'AI_RAG_KB_NOT_ASSIGNED');
  return { ...conversation, kb_id: assignment.kb_id };
}

function transcriptChatMetadata(job: LessonAuthorTranscriptionJob, locale: LessonAuthorTranscriptLocale): Record<string, unknown> {
  return {
    kind: 'lesson_author_video_transcript',
    locale,
    lesson_author_transcription_job_id: job.id,
    lesson_author_transcription_status: job.status,
    lesson_author_video_file_name: job.original_file_name,
    lesson_author_transcript_file_name: job.transcript_file_name,
    lesson_author_transcript_language: job.transcript_language,
    lesson_author_transcript_char_count: job.transcript_char_count,
    lesson_author_transcription_error: job.status === 'failed' ? job.last_error : null,
    lesson_author_kb_document_id: job.kb_document_id,
  };
}

/**
 * A retry or an idempotent re-upload may return an existing job. Keep exactly
 * one durable attachment message for it so the chat always exposes its state.
 */
async function ensureLessonAuthorTranscriptMessage(job: LessonAuthorTranscriptionJob, locale: LessonAuthorTranscriptLocale): Promise<void> {
  if (!job.conversation_id) return;
  const content = formatLessonAuthorTranscriptMessage(job.status, job.original_file_name, locale);
  const metadata = JSON.stringify(transcriptChatMetadata(job, locale));
  await withDatabaseTransaction(async () => {
    // The lock is acquired before observing messages. A single-statement CTE
    // could still use a pre-lock MVCC snapshot and emit duplicate attachments.
    await query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [job.id]);
    const existing = await query<{ id: string }>(
      `SELECT id
       FROM chat_messages
       WHERE conversation_id = $1::uuid
         AND metadata ->> 'kind' = 'lesson_author_video_transcript'
         AND metadata ->> 'lesson_author_transcription_job_id' = $2::text
       LIMIT 1
       FOR UPDATE`,
      [job.conversation_id, job.id],
    );
    if (existing.rows[0]) {
      await query(
        `UPDATE chat_messages
         SET content = $2,
             metadata = metadata || $3::jsonb
         WHERE id = $1::uuid`,
        [existing.rows[0].id, content, metadata],
      );
      return;
    }
    await query(
      `INSERT INTO chat_messages (conversation_id, role, content, metadata)
       VALUES ($1::uuid, 'assistant', $2, $3::jsonb)`,
      [job.conversation_id, content, metadata],
    );
  });
}

export async function syncLessonAuthorTranscriptMessage(job: LessonAuthorTranscriptionJob, locale: LessonAuthorTranscriptLocale): Promise<void> {
  await ensureLessonAuthorTranscriptMessage(job, locale);
}

export async function prepareLessonAuthorTranscriptionUpload(input: {
  tenantId: string;
  userId: string;
  conversationId: string;
  idempotencyKey: string;
  filePath: string;
  originalFileName: string;
  mimeType: string;
  size: number;
  locale: LessonAuthorTranscriptLocale;
}): Promise<PreparedLessonAuthorTranscriptUpload> {
  const originalFileName = safeFileName(input.originalFileName);
  if (!isSupportedLessonAuthorVideo(originalFileName, input.mimeType)) {
    throw new AppError('Chỉ hỗ trợ video .mp4.', 400, 'VIDEO_TYPE_UNSUPPORTED');
  }
  if (!Number.isSafeInteger(input.size) || input.size <= 0) {
    throw new AppError('Kích thước video không hợp lệ.', 400, 'VIDEO_SIZE_INVALID');
  }

  const conversation = await loadConversationForTranscript(input.conversationId, input.userId, input.tenantId);
  const existing = await query<LessonAuthorTranscriptionJob>(
    `SELECT *
     FROM lesson_author_transcription_jobs
     WHERE tenant_id = $1::uuid
       AND conversation_id = $2::uuid
       AND idempotency_key = $3::uuid
     LIMIT 1`,
    [input.tenantId, input.conversationId, input.idempotencyKey],
  );
  if (existing.rows[0]) {
    await ensureLessonAuthorTranscriptMessage(existing.rows[0], input.locale);
    return { job: existing.rows[0], already_exists: true };
  }

  const sourceSha256 = await sha256File(input.filePath);
  const reusable = await findReusableTranscriptJob(input.tenantId, input.conversationId, sourceSha256);
  if (reusable) {
    await ensureLessonAuthorTranscriptMessage(reusable, input.locale);
    return { job: reusable, already_exists: true };
  }

  const id = randomUUID();
  const storagePath = buildLessonAuthorPrivateStoragePath(
    input.tenantId,
    'videos',
    `${id}-${buildFileName(originalFileName)}`,
  );
  await uploadLessonAuthorPrivateFileFromPath(storagePath, input.filePath, LESSON_AUTHOR_VIDEO_MIME_TYPE);

  try {
    const inserted = await query<LessonAuthorTranscriptionJob>(
      `INSERT INTO lesson_author_transcription_jobs (
         id, tenant_id, course_id, conversation_id, kb_id, requested_by,
         requested_locale,
         idempotency_key, original_file_name, original_mime_type,
         source_size_bytes, source_sha256, source_storage_path,
         transcript_file_name, status, next_attempt_at
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, $6::uuid,
         $7, $8::uuid, $9, $10, $11::bigint, $12, $13, $14, 'queued', now()
       ) RETURNING *`,
      [
        id,
        input.tenantId,
        conversation.course_id,
        input.conversationId,
        conversation.kb_id,
        input.userId,
        input.locale,
        input.idempotencyKey,
        originalFileName,
        LESSON_AUTHOR_VIDEO_MIME_TYPE,
        input.size,
        sourceSha256,
        storagePath,
        transcriptFileName(originalFileName),
      ],
    );
    const job = inserted.rows[0];
    await ensureLessonAuthorTranscriptMessage(job, input.locale);
    return { job, already_exists: false };
  } catch (error: any) {
    await deleteLessonAuthorPrivateFiles([storagePath]).catch(() => undefined);
    if (error?.code === '23505') {
      const duplicate = await query<LessonAuthorTranscriptionJob>(
        `SELECT * FROM lesson_author_transcription_jobs
         WHERE tenant_id = $1::uuid AND conversation_id = $2::uuid AND idempotency_key = $3::uuid
         LIMIT 1`,
        [input.tenantId, input.conversationId, input.idempotencyKey],
      );
       if (duplicate.rows[0]) {
         await ensureLessonAuthorTranscriptMessage(duplicate.rows[0], input.locale);
         return { job: duplicate.rows[0], already_exists: true };
       }
       const reusable = await findReusableTranscriptJob(input.tenantId, input.conversationId, sourceSha256);
       if (reusable) {
         await ensureLessonAuthorTranscriptMessage(reusable, input.locale);
         return { job: reusable, already_exists: true };
       }
    }
    throw error;
  }
}

export async function getLessonAuthorTranscriptionJob(input: {
  jobId: string;
  conversationId: string;
  tenantId: string;
  userId: string;
}): Promise<PublicLessonAuthorTranscriptionJob> {
  const result = await query<LessonAuthorTranscriptionJob>(
    `SELECT job.*
     FROM lesson_author_transcription_jobs job
     JOIN chat_conversations conversation ON conversation.id = job.conversation_id
     JOIN courses course ON course.id = job.course_id AND course.deleted_at IS NULL
     WHERE job.id = $1::uuid
       AND job.conversation_id = $2::uuid
       AND job.tenant_id = $3::uuid
       AND conversation.user_id = $4::uuid
       AND conversation.target = 'lesson_author'`,
    [input.jobId, input.conversationId, input.tenantId, input.userId],
  );
  if (!result.rows[0]) throw new AppError('Không tìm thấy bản chép lời.', 404, 'TRANSCRIPTION_NOT_FOUND');
  return toPublicLessonAuthorTranscriptionJob(result.rows[0]);
}

export async function updateLessonAuthorTranscriptionJob(
  jobId: string,
  update: Partial<Pick<LessonAuthorTranscriptionJob,
    'status' | 'transcript_storage_path' | 'transcript_language' | 'transcript_char_count' | 'last_error' | 'source_storage_path' | 'expires_at' | 'kb_document_id'>>,
  locale: LessonAuthorTranscriptLocale,
): Promise<LessonAuthorTranscriptionJob> {
  const result = await query<LessonAuthorTranscriptionJob>(
    `UPDATE lesson_author_transcription_jobs
     SET status = COALESCE($2::text, status),
         transcript_storage_path = COALESCE($3::text, transcript_storage_path),
         transcript_language = COALESCE($4::text, transcript_language),
         transcript_char_count = COALESCE($5::integer, transcript_char_count),
         last_error = $6::text,
         source_storage_path = CASE WHEN $8::boolean THEN NULL ELSE COALESCE($7::text, source_storage_path) END,
         expires_at = COALESCE($9::timestamptz, expires_at),
         kb_document_id = COALESCE($10::uuid, kb_document_id),
         updated_at = now()
     WHERE id = $1::uuid
     RETURNING *`,
    [
      jobId,
      update.status ?? null,
      update.transcript_storage_path ?? null,
      update.transcript_language ?? null,
      update.transcript_char_count ?? null,
      update.last_error ?? null,
      update.source_storage_path ?? null,
      update.source_storage_path === null,
      update.expires_at ?? null,
      update.kb_document_id ?? null,
    ],
  );
  const job = result.rows[0];
  if (!job) throw new Error('Transcript job disappeared while processing.');
  await syncLessonAuthorTranscriptMessage(job, locale);
  return job;
}

export async function claimDueLessonAuthorTranscriptionJobs(
  limit = env.LESSON_AUTHOR_TRANSCRIPTION_WORKER_BATCH_SIZE,
): Promise<LessonAuthorTranscriptionJob[]> {
  const safeLimit = Math.max(1, Math.min(limit, env.LESSON_AUTHOR_TRANSCRIPTION_WORKER_BATCH_SIZE));
  return withDatabaseTransaction(async () => {
    const claimed = await query<LessonAuthorTranscriptionJob>(
      `WITH candidates AS (
         SELECT job.id
         FROM lesson_author_transcription_jobs job
         JOIN chat_conversations conversation ON conversation.id = job.conversation_id
         JOIN courses course ON course.id = job.course_id
         WHERE job.expires_at > now()
           AND course.deleted_at IS NULL
           AND ((job.status = 'queued' AND job.next_attempt_at <= now())
             OR (job.status = 'running' AND job.lease_expires_at <= now()))
         ORDER BY job.next_attempt_at ASC, job.id ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE lesson_author_transcription_jobs job
       SET status = 'running',
           attempt_count = attempt_count + 1,
           lease_token = gen_random_uuid(),
           lease_expires_at = now() + ($2::int * interval '1 second'),
           last_error = NULL,
           updated_at = now()
       FROM candidates
       WHERE job.id = candidates.id
       RETURNING job.*`,
      [safeLimit, env.LESSON_AUTHOR_TRANSCRIPTION_WORKER_LEASE_SECONDS],
    );
    return claimed.rows;
  });
}

export async function renewLessonAuthorTranscriptionLease(jobId: string, leaseToken: string): Promise<boolean> {
  const renewed = await query(
    `UPDATE lesson_author_transcription_jobs job
     SET lease_expires_at = now() + ($3::int * interval '1 second'), updated_at = now()
     FROM courses course
     WHERE job.id = $1::uuid
       AND job.status = 'running'
       AND job.lease_token = $2::uuid
       AND course.id = job.course_id
       AND course.deleted_at IS NULL
     RETURNING job.id`,
    [jobId, leaseToken, env.LESSON_AUTHOR_TRANSCRIPTION_WORKER_LEASE_SECONDS],
  );
  return Boolean(renewed.rowCount);
}

export async function completeLessonAuthorTranscriptionJob(input: {
  jobId: string;
  leaseToken: string;
  transcriptStoragePath: string;
  transcriptLanguage: string | null;
  transcriptCharCount: number;
  expiresAt: Date;
}): Promise<LessonAuthorTranscriptionJob | null> {
  const completed = await query<LessonAuthorTranscriptionJob>(
    `UPDATE lesson_author_transcription_jobs job
     SET status = 'succeeded',
         transcript_storage_path = $3,
         transcript_language = $4,
         transcript_char_count = $5,
         source_storage_path = NULL,
         expires_at = $6,
         lease_token = NULL,
         lease_expires_at = NULL,
         last_error = NULL,
         updated_at = now()
     FROM courses course
     WHERE job.id = $1::uuid
       AND job.status = 'running'
       AND job.lease_token = $2::uuid
       AND course.id = job.course_id
       AND course.deleted_at IS NULL
     RETURNING job.*`,
    [input.jobId, input.leaseToken, input.transcriptStoragePath, input.transcriptLanguage, input.transcriptCharCount, input.expiresAt],
  );
  return completed.rows[0] || null;
}

export async function failLessonAuthorTranscriptionJob(input: {
  jobId: string;
  leaseToken: string;
  reason: string;
}): Promise<LessonAuthorTranscriptionJob | null> {
  const safeReason = input.reason.replace(/[\r\n]+/g, ' ').slice(0, 500) || 'Không thể tạo bản chép lời.';
  const failed = await query<LessonAuthorTranscriptionJob>(
    `UPDATE lesson_author_transcription_jobs job
     SET status = CASE WHEN attempt_count >= $3::int THEN 'failed' ELSE 'queued' END,
         next_attempt_at = CASE
           WHEN attempt_count >= $3::int THEN next_attempt_at
           ELSE now() + (LEAST($4::int, GREATEST(1, (power(2::numeric, LEAST(attempt_count - 1, 10))::int * $5::int))) * interval '1 second')
         END,
         lease_token = NULL,
         lease_expires_at = NULL,
         last_error = $6,
         updated_at = now()
     FROM courses course
     WHERE job.id = $1::uuid
       AND job.status = 'running'
       AND job.lease_token = $2::uuid
       AND course.id = job.course_id
       AND course.deleted_at IS NULL
     RETURNING job.*`,
    [
      input.jobId,
      input.leaseToken,
      env.LESSON_AUTHOR_TRANSCRIPTION_WORKER_MAX_ATTEMPTS,
      env.LESSON_AUTHOR_TRANSCRIPTION_WORKER_RETRY_MAX_SECONDS,
      env.LESSON_AUTHOR_TRANSCRIPTION_WORKER_RETRY_BASE_SECONDS,
      safeReason,
    ],
  );
  return failed.rows[0] || null;
}

export async function commitLessonAuthorTranscriptToKnowledgebase(input: {
  jobId: string;
  conversationId: string;
  tenantId: string;
  userId: string;
  locale: LessonAuthorTranscriptLocale;
}): Promise<{ job: PublicLessonAuthorTranscriptionJob; created: boolean }> {
  const jobResult = await query<LessonAuthorTranscriptionJob>(
    `SELECT job.*
     FROM lesson_author_transcription_jobs job
     JOIN chat_conversations conversation ON conversation.id = job.conversation_id
     WHERE job.id = $1::uuid
       AND job.conversation_id = $2::uuid
       AND job.tenant_id = $3::uuid
       AND conversation.user_id = $4::uuid
       AND conversation.target = 'lesson_author'
    `,
    [input.jobId, input.conversationId, input.tenantId, input.userId],
  );
  const job = jobResult.rows[0];
  if (!job) throw new AppError('Không tìm thấy bản chép lời.', 404, 'TRANSCRIPTION_NOT_FOUND');
  if (job.kb_document_id) return { job: toPublicLessonAuthorTranscriptionJob(job), created: false };
  if (job.status !== 'succeeded' || !job.transcript_storage_path) {
    throw new AppError('Bản chép lời chưa sẵn sàng để đưa vào Kho tri thức.', 409, 'TRANSCRIPTION_NOT_READY');
  }
  const activeKb = await getActiveKbAssignmentFresh(input.tenantId);
  if (!activeKb || activeKb.kb_id !== job.kb_id) {
    throw new AppError('Kho tri thức đã thay đổi. Hãy tạo lại transcript cho nguồn hiện tại.', 409, 'TRANSCRIPTION_KB_CHANGED');
  }

  const transcript = normalizeTranscriptText(
    await downloadLessonAuthorPrivateText(job.transcript_storage_path),
    env.LESSON_AUTHOR_TRANSCRIPT_MAX_CHARS,
  );

  return withDatabaseTransaction(async () => {
    const lockedResult = await query<LessonAuthorTranscriptionJob>(
      `SELECT job.*
       FROM lesson_author_transcription_jobs job
       JOIN chat_conversations conversation ON conversation.id = job.conversation_id
       JOIN courses course ON course.id = job.course_id AND course.deleted_at IS NULL
       WHERE job.id = $1::uuid
         AND job.conversation_id = $2::uuid
         AND job.tenant_id = $3::uuid
         AND conversation.user_id = $4::uuid
         AND conversation.target = 'lesson_author'
       FOR UPDATE`,
      [input.jobId, input.conversationId, input.tenantId, input.userId],
    );
    const lockedJob = lockedResult.rows[0];
    if (!lockedJob) throw new AppError('Không tìm thấy bản chép lời.', 404, 'TRANSCRIPTION_NOT_FOUND');
    if (lockedJob.kb_document_id) {
      return { job: toPublicLessonAuthorTranscriptionJob(lockedJob), created: false };
    }
    const lockedActiveKb = await getActiveKbAssignmentFresh(input.tenantId);
    if (
      !lockedActiveKb
      || lockedJob.status !== 'succeeded'
      || !lockedJob.transcript_storage_path
      || lockedJob.kb_id !== lockedActiveKb.kb_id
    ) {
      throw new AppError('Bản chép lời không còn sẵn sàng cho Kho tri thức hiện tại.', 409, 'TRANSCRIPTION_NOT_READY');
    }

    const staged = await stageTextBackedDocumentSource(lockedJob.kb_id, input.tenantId, {
      name: lockedJob.transcript_file_name,
      content: transcript,
      sourceInfo: {
        origin: 'lesson_author_video_transcript',
        transcription_job_id: lockedJob.id,
        original_video_name: lockedJob.original_file_name,
        source_sha256: lockedJob.source_sha256,
        transcript_language: lockedJob.transcript_language,
        transcript_char_count: transcript.length,
      },
    });
    const document = await createQueuedDocumentFromStagedSource(lockedJob.kb_id, input.tenantId, input.userId, staged);
    const committed = await updateLessonAuthorTranscriptionJob(lockedJob.id, {
      status: 'committed',
      kb_document_id: document.id,
      last_error: null,
    }, input.locale);
    return { job: toPublicLessonAuthorTranscriptionJob(committed), created: true };
  });
}

type ExpiredLessonAuthorTranscriptionJob = LessonAuthorTranscriptionJob & {
  purged_source_storage_path: string | null;
  purged_transcript_storage_path: string | null;
};

/** Expire private artifacts after their retention window, including committed transcripts. */
export async function expireLessonAuthorTranscriptionJobs(limit = 100): Promise<number> {
  const expired = await withDatabaseTransaction(async () => {
    const result = await query<ExpiredLessonAuthorTranscriptionJob>(
      `WITH stale AS (
         SELECT job.id, job.source_storage_path, job.transcript_storage_path
         FROM lesson_author_transcription_jobs job
         JOIN courses course ON course.id = job.course_id
         WHERE job.expires_at <= now()
           AND course.deleted_at IS NULL
           AND job.status IN ('queued', 'running', 'succeeded', 'failed', 'committed')
         ORDER BY job.expires_at ASC, job.id ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE lesson_author_transcription_jobs job
       SET status = 'expired',
           source_storage_path = NULL,
           transcript_storage_path = NULL,
           lease_token = NULL,
           lease_expires_at = NULL,
           updated_at = now()
       FROM stale
       WHERE job.id = stale.id
       RETURNING job.*, stale.source_storage_path AS purged_source_storage_path,
                 stale.transcript_storage_path AS purged_transcript_storage_path`,
      [Math.max(1, Math.min(limit, 500))],
    );
    return result.rows;
  });

  for (const job of expired) {
    await deleteLessonAuthorPrivateFiles([
      ...(job.purged_source_storage_path ? [job.purged_source_storage_path] : []),
      ...(job.purged_transcript_storage_path ? [job.purged_transcript_storage_path] : []),
    ]).catch(error => console.error('[LessonAuthorTranscription] expiry cleanup failed', { job_id: job.id, error }));
    await syncLessonAuthorTranscriptMessage(job, job.requested_locale);
  }
  return expired.length;
}
