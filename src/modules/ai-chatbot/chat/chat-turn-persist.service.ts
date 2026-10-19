// Stage 6 of a chat turn, persist: the user message (once the turn is
// reserved), the input filter refusal, and the assistant answer as the
// client saw it. Moved from chat.service.ts / sendMessageStream (move only).

import { query } from '../../../config/database.js';
import { AppError } from '../../../middleware/error-handler.js';
import { toSourceDocumentMetadata } from '../ai-id/legacy/context.service.js';
import type { LessonAuthorTurnIntent } from '../ai-id/legacy/chat-turn-intent.service.js';
import { convertLessonAuthorChatJsonToProposalMessage } from '../ai-id/legacy/job-store.service.js';
import type { FilterResult } from '../ai-platform/input-filter/core/index.js';
import { stoppedByDeadline } from './chat-provider-turn.logic.js';
import { stripLeadingInternalChatRoutingLabels } from './chat-response-emitter.logic.js';
import { LESSON_AUTHOR_TARGET } from './chat.constants.js';
import type { ConversationContext } from './chat.types.js';
import { logLessonAuthorFlow } from './chat-turn-runtime.service.js';
import type { ChatTurn, ChatTurnAnswer, ChatTurnBudget } from './chat-turn.types.js';

export async function saveInputFilterRejectedTurn(
  ctx: ConversationContext,
  userContent: string,
  replyMessage: string,
  result: FilterResult,
): Promise<void> {
  await query(
    `INSERT INTO chat_messages (conversation_id, role, content, metadata)
     VALUES ($1, 'user', $2, $3)`,
    [
      ctx.conversationId,
      userContent,
      {
        input_filter_blocked: true,
        input_filter_code: result.code,
      },
    ],
  );

  await query(
    `INSERT INTO chat_messages (conversation_id, role, content, metadata)
     VALUES ($1, 'assistant', $2, $3)`,
    [
      ctx.conversationId,
      replyMessage,
      {
        kind: 'input_filter_rejection',
        input_filter_code: result.code,
        input_filter_detail: result.detail ?? null,
      },
    ],
  );

  const title = userContent.slice(0, 50) + (userContent.length > 50 ? '...' : '');
  await query(
    `UPDATE chat_conversations
     SET updated_at = now(),
         title = CASE WHEN $3::boolean THEN $2 ELSE title END
     WHERE id = $1 AND tenant_id = $4`,
    [ctx.conversationId, title, ctx.messageCount === 0, ctx.tenantId],
  );
}

/** The user message of a reserved turn, with what it was asked about. */
export async function persistChatTurnUserMessage(turn: ChatTurn): Promise<void> {
  const {
    conversationId, trimmed, options, ctx, courseId, isVoiceTurn, outlineMentions, outlineMentionSource,
    validatedEditorContext, sourceDocuments, sourceDocumentSource, blueprintDraftContext, lessonAuthorCorrelationId,
  } = turn;
  // 3. Save user message + update timestamp (2 queries, could batch but INSERT RETURNING is needed)
  await query(
    `INSERT INTO chat_messages (conversation_id, role, content, metadata)
     VALUES ($1, 'user', $2, $3)`,
    [
      conversationId,
      trimmed,
      {
        ...(isVoiceTurn ? { input_mode: 'voice' } : {}),
        ...(options.lessonAuthorAction ? { lesson_author_action: options.lessonAuthorAction } : {}),
        ...(outlineMentions.length > 0 ? { outline_mentions: outlineMentions, outline_mentions_source: outlineMentionSource } : {}),
        ...(validatedEditorContext ? { editor_context: validatedEditorContext.context } : {}),
        ...(sourceDocuments.length > 0 ? { source_documents: sourceDocuments.map(toSourceDocumentMetadata), source_documents_source: sourceDocumentSource } : {}),
        ...(blueprintDraftContext ? {
          lesson_author_blueprint_id: blueprintDraftContext.id,
          lesson_author_blueprint_chapter_index: blueprintDraftContext.chapterIndex,
        } : {}),
        ...(options.reportFilters ? { report_filters: options.reportFilters } : {}),
      },
    ],
  );
  await query(
    `UPDATE chat_conversations SET updated_at = now() WHERE id = $1`,
    [conversationId],
  );
  logLessonAuthorFlow('stream_user_message_saved', {
    correlation_id: lessonAuthorCorrelationId,
    conversation_id: conversationId,
    target: ctx.target,
      course_id: courseId ?? null,
      source_documents: sourceDocuments.length,
    });
}

/** The assistant answer of a normal chat turn; returns the saved content ('' when nothing was saved). */
export async function persistChatTurnAnswer(
  turn: ChatTurn,
  budget: ChatTurnBudget,
  intent: LessonAuthorTurnIntent,
  answer: ChatTurnAnswer,
): Promise<string> {
  const { conversationId, userId, trimmed, ctx, aiSettings, sourceDocuments, onChunk, onSideEvent } = turn;
  const { requestedLocale } = budget;
  const { resolvedOperationPlan } = intent;
  const { fullResponse, lastError, answerSignal, responseEmitter, shouldBufferLessonAuthorChat, chatSources, chatRetrieval } = answer;
  if (lastError && !fullResponse) {
    if (stoppedByDeadline(answerSignal)) {
      throw new AppError('Trợ lý AI trả lời quá lâu. Vui lòng thử lại sau ít phút.', 504, 'AI_CHAT_TIMEOUT');
    }
    throw lastError;
  }

  responseEmitter?.flush();

  let assistantContent = shouldBufferLessonAuthorChat
    ? fullResponse
    : stripLeadingInternalChatRoutingLabels(fullResponse);
  let assistantMetadata: Record<string, unknown> = {};
  if (shouldBufferLessonAuthorChat) {
    // The normal chat branch must never create a lesson-author job merely
    // because the model happened to emit proposal-shaped JSON. All mutation
    // intents are handled by the deterministic router above and return
    // before this branch. Keep the legacy converter behind that same gate
    // for compatibility with an explicit mutation operation only.
    const canConvertLegacyProposal = ctx.target === LESSON_AUTHOR_TARGET
      && ['course_blueprint', 'create', 'update_content'].includes(resolvedOperationPlan.operation);
    const converted = canConvertLegacyProposal
      ? await convertLessonAuthorChatJsonToProposalMessage(
        ctx,
        userId,
        trimmed,
        fullResponse,
        sourceDocuments,
        requestedLocale,
      )
      : null;
    if (converted) {
      assistantContent = converted.content;
      assistantMetadata = converted.metadata;
      if (converted.proposal) {
        onSideEvent?.({ type: 'proposal', job_id: converted.jobId, proposal: converted.proposal });
      }
    }
    if (assistantContent.trim()) onChunk(assistantContent);
  }
  assistantMetadata = {
    ...assistantMetadata,
    ai_engine: aiSettings.activeEngine,
    ai_model: aiSettings.chatModel,
    ...(chatSources.length > 0 ? { rag_sources: chatSources } : {}),
    ...(chatRetrieval ? { rag_retrieval: chatRetrieval } : {}),
  };

  // 7. Save assistant message (only if we got content)
  if (assistantContent.trim()) {
    await query(
      `INSERT INTO chat_messages (conversation_id, role, content, metadata) VALUES ($1, 'assistant', $2, $3)`,
      [conversationId, assistantContent, assistantMetadata],
    );
    logLessonAuthorFlow('chat_branch_assistant_message_saved', {
      conversation_id: conversationId,
      target: ctx.target,
      response_chars: assistantContent.length,
      raw_response_chars: fullResponse.length,
      metadata_kind: assistantMetadata.kind ?? null,
    });
  } else {
    logLessonAuthorFlow('chat_branch_empty_response', {
      conversation_id: conversationId,
      target: ctx.target,
    });
  }
  return assistantContent;
}
