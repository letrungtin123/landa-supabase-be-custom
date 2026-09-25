import fs from 'fs/promises';
import type { Request, Response } from 'express';
import { fixMulterFilename } from '../../config/storage.js';
import { sendError, sendSuccess } from '../../utils/response.js';
import {
  commitLessonAuthorTranscriptToKnowledgebase,
  downloadLessonAuthorTranscriptFile,
  getLessonAuthorTranscriptionJob,
  prepareLessonAuthorTranscriptionUpload,
  toPublicLessonAuthorTranscriptionJob,
} from './lesson-author-transcription.service.js';
import { normalizeLessonAuthorUploadAttemptId } from './lesson-author-transcription.logic.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function locale(value: unknown): 'vi' | 'en' {
  return value === 'en' ? 'en' : 'vi';
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code || '') || undefined : undefined;
}

function errorStatus(error: unknown): number {
  return error && typeof error === 'object' && 'statusCode' in error
    ? Number((error as { statusCode?: unknown }).statusCode) || 400
    : 400;
}

export async function createLessonAuthorTranscription(req: Request, res: Response): Promise<void> {
  const file = req.file;
  const conversationId = req.params.conversationId;
  const idempotencyKey = typeof req.body?.idempotency_key === 'string' ? req.body.idempotency_key : '';
  const clientAttemptId = normalizeLessonAuthorUploadAttemptId(req.get('x-lesson-author-upload-attempt'))
    ?? normalizeLessonAuthorUploadAttemptId(idempotencyKey);
  const startedAt = Date.now();
  if (!UUID_REGEX.test(conversationId) || !UUID_REGEX.test(idempotencyKey)) {
    console.warn('[LessonAuthorTranscription] upload rejected', {
      client_attempt_id: clientAttemptId,
      conversation_id: conversationId,
      error_code: 'VIDEO_UPLOAD_IDENTIFIER_INVALID',
      source_size_bytes: file?.size ?? null,
      duration_ms: Date.now() - startedAt,
    });
    if (file?.path) await fs.unlink(file.path).catch(() => undefined);
    sendError(res, 'conversationId hoặc idempotency_key không hợp lệ', 400);
    return;
  }
  if (!file) {
    console.warn('[LessonAuthorTranscription] upload rejected', {
      client_attempt_id: clientAttemptId,
      conversation_id: conversationId,
      error_code: 'VIDEO_FILE_MISSING',
      source_size_bytes: null,
      duration_ms: Date.now() - startedAt,
    });
    sendError(res, 'Chưa chọn video .mp4', 400);
    return;
  }

  try {
    const result = await prepareLessonAuthorTranscriptionUpload({
      tenantId: req.user!.tenantId!,
      userId: req.user!.id,
      conversationId,
      idempotencyKey,
      filePath: file.path,
      originalFileName: fixMulterFilename(file.originalname),
      mimeType: file.mimetype,
      size: file.size,
      locale: locale(req.body?.locale),
    });
    console.info('[LessonAuthorTranscription] upload accepted', {
      client_attempt_id: clientAttemptId,
      conversation_id: conversationId,
      job_id: result.job.id,
      status: result.job.status,
      already_exists: result.already_exists,
      source_size_bytes: file.size,
      duration_ms: Date.now() - startedAt,
    });
    sendSuccess(res, {
      job: toPublicLessonAuthorTranscriptionJob(result.job),
      already_exists: result.already_exists,
    }, undefined, result.already_exists ? 200 : 202);
  } catch (error: unknown) {
    console.warn('[LessonAuthorTranscription] upload rejected', {
      client_attempt_id: clientAttemptId,
      conversation_id: conversationId,
      error_code: errorCode(error) ?? null,
      status_code: errorStatus(error),
      source_size_bytes: file.size,
      duration_ms: Date.now() - startedAt,
    });
    sendError(res, error instanceof Error ? error.message : 'Không thể nhận video để tạo bản chép lời.', errorStatus(error), errorCode(error));
  } finally {
    if (file.path) await fs.unlink(file.path).catch(() => undefined);
  }
}

export async function getLessonAuthorTranscription(req: Request, res: Response): Promise<void> {
  const { conversationId, jobId } = req.params;
  if (!UUID_REGEX.test(conversationId) || !UUID_REGEX.test(jobId)) {
    sendError(res, 'ID không hợp lệ', 400);
    return;
  }
  try {
    const job = await getLessonAuthorTranscriptionJob({
      jobId,
      conversationId,
      tenantId: req.user!.tenantId!,
      userId: req.user!.id,
    });
    sendSuccess(res, job);
  } catch (error: unknown) {
    sendError(res, error instanceof Error ? error.message : 'Không thể tải trạng thái transcript.', errorStatus(error), errorCode(error));
  }
}

export async function downloadLessonAuthorTranscript(req: Request, res: Response): Promise<void> {
  const { conversationId, jobId } = req.params;
  if (!UUID_REGEX.test(conversationId) || !UUID_REGEX.test(jobId)) {
    sendError(res, 'ID không hợp lệ', 400);
    return;
  }
  try {
    const transcript = await downloadLessonAuthorTranscriptFile({
      jobId,
      conversationId,
      tenantId: req.user!.tenantId!,
      userId: req.user!.id,
    });
    res.attachment(transcript.fileName);
    res.type('text/plain; charset=utf-8');
    res.send(transcript.content);
  } catch (error: unknown) {
    sendError(res, error instanceof Error ? error.message : 'Không thể tải bản chép lời.', errorStatus(error), errorCode(error));
  }
}

export async function commitLessonAuthorTranscript(req: Request, res: Response): Promise<void> {
  const { conversationId, jobId } = req.params;
  if (!UUID_REGEX.test(conversationId) || !UUID_REGEX.test(jobId)) {
    sendError(res, 'ID không hợp lệ', 400);
    return;
  }
  try {
    const result = await commitLessonAuthorTranscriptToKnowledgebase({
      jobId,
      conversationId,
      tenantId: req.user!.tenantId!,
      userId: req.user!.id,
      locale: locale(req.body?.locale),
    });
    sendSuccess(res, result, undefined, result.created ? 202 : 200);
  } catch (error: unknown) {
    sendError(res, error instanceof Error ? error.message : 'Không thể đưa transcript vào Kho tri thức.', errorStatus(error), errorCode(error));
  }
}
