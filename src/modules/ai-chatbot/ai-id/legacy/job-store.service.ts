// AI ID V1 / lesson-author legacy code, moved unchanged out of chat.service.ts.
// chat.service.ts re-exports its public symbols, so existing imports keep working.
import { query } from '../../../../config/database.js';
import { AppError } from '../../../../middleware/error-handler.js';
import { type LessonAuthorProposal } from '../../../course-authoring/course-authoring.service.js';
import { getTenantAllowedCourseComponentTypeSet } from '../../../tenants/tenant-course-components.service.js';
import { assertLessonAuthorProposalComponentsValid } from '../lesson-author-component-registry.logic.js';
import { assertLessonAuthorPedagogicalQuality } from '../lesson-author-pedagogical-validator.logic.js';
import { LESSON_AUTHOR_TARGET } from '../../chat/chat.constants.js';
import type { ConversationContext, LessonAuthorSourceDocument } from '../../chat/chat.types.js';
import { logLessonAuthorFlow } from '../../chat/chat-turn-runtime.service.js';
import { extractJsonObject } from './component-normalize.logic.js';
import type { LessonAuthorJobRow } from './types.js';
import { toSourceDocumentMetadata } from './context.service.js';
import { normalizeLessonAuthorProposal } from './proposal-normalize.logic.js';
import {
  looksLikeLessonAuthorProposalJsonResponse,
  getLessonAuthorProposalMetrics,
  formatProposalPreview,
  toLessonAuthorDisplayProposal,
  sanitizeInternalErrorReason,
  formatLessonAuthorFailurePreview,
  readLessonAuthorLocale,
} from './preview.logic.js';
import { createLessonAuthorRequestHash } from './blueprint-store.service.js';

export async function convertLessonAuthorChatJsonToProposalMessage(
  ctx: ConversationContext,
  userId: string,
  prompt: string,
  rawResponse: string,
  sourceDocuments: LessonAuthorSourceDocument[],
  locale: 'vi' | 'en' = 'vi',
): Promise<{
  content: string;
  metadata: Record<string, unknown>;
  proposal?: LessonAuthorProposal;
  jobId: string;
} | null> {
  if (ctx.target !== LESSON_AUTHOR_TARGET || !looksLikeLessonAuthorProposalJsonResponse(rawResponse)) return null;

  try {
    if (!ctx.botKbId) throw new AppError('Chưa cấu hình KB active cho chuyên gia tạo bài học', 409);
    const proposal = normalizeLessonAuthorProposal(extractJsonObject(rawResponse));
    assertLessonAuthorProposalComponentsValid(
      proposal,
      await getTenantAllowedCourseComponentTypeSet(ctx.tenantId),
    );
    assertLessonAuthorPedagogicalQuality({ proposal });
    const jobId = await createLessonAuthorJob(ctx, userId, prompt, ctx.botKbId, proposal, sourceDocuments);
    logLessonAuthorFlow('chat_json_intercepted_as_proposal', {
      conversation_id: ctx.conversationId,
      job_id: jobId,
      response_chars: rawResponse.length,
      ...getLessonAuthorProposalMetrics(proposal),
    });
    return {
      content: formatProposalPreview(proposal, 0, locale),
      metadata: {
        kind: 'lesson_author_proposal',
        lesson_author_job_id: jobId,
        lesson_author_job_status: 'proposed',
        locale,
        ...(sourceDocuments.length > 0 ? { source_documents: sourceDocuments.map(toSourceDocumentMetadata) } : {}),
      },
      proposal: toLessonAuthorDisplayProposal(proposal, locale),
      jobId,
    };
  } catch (err) {
    const errorReason = sanitizeInternalErrorReason(err);
    const jobId = await createFailedLessonAuthorJob(ctx, userId, prompt, ctx.botKbId ?? null, errorReason, sourceDocuments);
    logLessonAuthorFlow('chat_json_intercept_failed', {
      conversation_id: ctx.conversationId,
      job_id: jobId,
      response_chars: rawResponse.length,
      error: errorReason,
    });
    return {
      content: formatLessonAuthorFailurePreview(err, locale),
      metadata: {
        kind: 'lesson_author_generation_failed',
        lesson_author_job_id: jobId,
        ...(sourceDocuments.length > 0 ? { source_documents: sourceDocuments.map(toSourceDocumentMetadata) } : {}),
      },
      jobId,
    };
  }
}

export async function createLessonAuthorJob(
  ctx: ConversationContext,
  userId: string,
  prompt: string,
  kbId: string | null,
  proposal: LessonAuthorProposal,
  sourceDocuments: LessonAuthorSourceDocument[] = [],
  blueprintId: string | null = null,
): Promise<string> {
  if (!ctx.courseId) throw new Error('courseId is required for lesson author');
  const requestHash = createLessonAuthorRequestHash(ctx, kbId, prompt, sourceDocuments, blueprintId);
  const sourceDocumentMetadata = sourceDocuments.map(toSourceDocumentMetadata);

  const result = await query<{ id: string }>(
    `INSERT INTO lesson_author_jobs (
       tenant_id, course_id, conversation_id, bot_id, kb_id,
       requested_by, request_hash, prompt, proposal, status, source_documents, blueprint_id
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'proposed', $10::jsonb, $11)
     RETURNING id`,
    [
      ctx.tenantId,
      ctx.courseId,
      ctx.conversationId,
      ctx.botId,
      kbId,
      userId,
      requestHash,
      prompt,
      proposal,
      JSON.stringify(sourceDocumentMetadata),
      blueprintId,
    ],
  );
  logLessonAuthorFlow('proposal_job_created', {
    conversation_id: ctx.conversationId,
    course_id: ctx.courseId,
    job_id: result.rows[0].id,
    request_hash: requestHash,
    source_documents: sourceDocuments.length,
    ...getLessonAuthorProposalMetrics(proposal),
  });
  return result.rows[0].id;
}

export async function createFailedLessonAuthorJob(
  ctx: ConversationContext,
  userId: string,
  prompt: string,
  kbId: string | null,
  errorReason: string,
  sourceDocuments: LessonAuthorSourceDocument[] = [],
): Promise<string> {
  if (!ctx.courseId) throw new Error('courseId is required for lesson author');
  const requestHash = createLessonAuthorRequestHash(ctx, kbId, prompt, sourceDocuments);
  const sourceDocumentMetadata = sourceDocuments.map(toSourceDocumentMetadata);

  const result = await query<{ id: string }>(
    `INSERT INTO lesson_author_jobs (
       tenant_id, course_id, conversation_id, bot_id, kb_id,
       requested_by, request_hash, prompt, proposal, status, error_reason, source_documents
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '{}'::jsonb, 'failed', $9, $10::jsonb)
     RETURNING id`,
    [
      ctx.tenantId,
      ctx.courseId,
      ctx.conversationId,
      ctx.botId,
      kbId,
      userId,
      requestHash,
      prompt,
      errorReason,
      JSON.stringify(sourceDocumentMetadata),
    ],
  );
  logLessonAuthorFlow('proposal_failed_job_created', {
    conversation_id: ctx.conversationId,
    course_id: ctx.courseId,
    job_id: result.rows[0].id,
    request_hash: requestHash,
    source_documents: sourceDocuments.length,
    error: errorReason,
  });
  return result.rows[0].id;
}

export async function getLessonAuthorJobLocale(
  job: Pick<LessonAuthorJobRow, 'id' | 'conversation_id'>,
  tenantId: string,
): Promise<'vi' | 'en'> {
  if (!job.conversation_id) return 'vi';
  const result = await query<{ locale: string | null }>(
    `SELECT proposal_message.metadata ->> 'locale' AS locale
     FROM chat_messages proposal_message
     JOIN chat_conversations conversation
       ON conversation.id = proposal_message.conversation_id
     WHERE proposal_message.conversation_id = $1
       AND conversation.tenant_id = $2
       AND proposal_message.role = 'assistant'
       AND proposal_message.metadata ->> 'kind' = 'lesson_author_proposal'
       AND proposal_message.metadata ->> 'lesson_author_job_id' = $3
     ORDER BY proposal_message.created_at DESC, proposal_message.id DESC
     LIMIT 1`,
    [job.conversation_id, tenantId, job.id],
  );
  return readLessonAuthorLocale(result.rows[0]?.locale);
}
