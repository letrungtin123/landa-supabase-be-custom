// Stage 7 of a chat turn, settle: the token reservation is finalized once
// with the usage of the turn (provider usage, else an estimate), or, when the
// turn failed, finalized as billed when a provider call started, else
// released. Moved from chat.service.ts / sendMessageStream (move only).

import { invalidateTenantAiCaches } from '../../../config/cache-invalidation.js';
import { query } from '../../../config/database.js';
import { markKbGeminiStoreRemoteProblem } from '../ai-platform/gemini.service.js';
import type { AiUsage } from '../ai-platform/ai-engine.types.js';
import {
  estimateTokensFromText,
  finalizeTenantAiTokens,
  normalizeAiUsage,
  releaseTenantAiTokenReservation,
} from '../ai-platform/ai-token-quota.service.js';
import { isKbStorePermissionFailure } from '../ai-report/report-chat-error.logic.js';
import type { ConversationContext } from './chat.types.js';
import {
  invalidateGeminiStoreNameCache,
  logLessonAuthorFlow,
  redactGeminiApiKeys,
  sanitizeGeminiError,
} from './chat-turn-runtime.service.js';
import type { ChatTurn, ChatTurnAnswer, ChatTurnBudget, ChatTurnPrompt, ChatTurnState } from './chat-turn.types.js';

async function markKbStorePermissionProblemFromChat(ctx: ConversationContext | null, err: unknown): Promise<void> {
  // A report 403 (learner_plus outside their scope) is not a Gemini File
  // Search failure and must never mark the bot KB store as broken.
  if (!ctx?.botKbId || !isKbStorePermissionFailure(err)) return;
  try {
    await markKbGeminiStoreRemoteProblem(
      ctx.botKbId,
      'permission_denied',
      'PERMISSION_DENIED',
      'Gemini File Search store cannot be accessed with the current tenant API key. Restore this KB to rebuild the store.',
    );
    invalidateGeminiStoreNameCache(ctx.botKbId);
    await invalidateTenantAiCaches(ctx.tenantId);
  } catch (markErr: any) {
    console.error('[AI Chatbot] Failed to mark KB store permission problem:', markErr?.message || String(markErr));
  }
}

export function estimateAiTurnUsage(inputParts: Array<string | null | undefined>, outputText: string): AiUsage {
  return normalizeAiUsage({
    inputTokens: estimateTokensFromText(...inputParts),
    outputTokens: estimateTokensFromText(outputText),
  });
}

export function createChatTurnState(): ChatTurnState {
  return {
    ctxForError: null,
    aiReservationId: null,
    aiReservationTenantId: null,
    aiReservationEmbeddingModel: null,
    aiReservationFinalized: false,
    lessonAuthorCorrelationId: null,
    chatProviderMeter: null,
    chatProviderService: null,
  };
}

/** Finalizes the reservation of the turn once; later calls (and a turn without one) do nothing. */
export async function finalizeChatTurnReservation(
  state: ChatTurnState,
  usage: AiUsage,
  source: Record<string, unknown>,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  if (!state.aiReservationId || !state.aiReservationTenantId || state.aiReservationFinalized) return;
  await finalizeTenantAiTokens({
    reservationId: state.aiReservationId,
    tenantId: state.aiReservationTenantId,
    usage,
    embeddingModel: state.aiReservationEmbeddingModel,
    source,
    metadata,
  });
  state.aiReservationFinalized = true;
}

/** A normal chat answer: settle its usage, title a new conversation, end the stream. */
export async function settleChatTurn(
  turn: ChatTurn,
  budget: ChatTurnBudget,
  prompt: ChatTurnPrompt,
  answer: ChatTurnAnswer,
  assistantContent: string,
): Promise<void> {
  const { conversationId, trimmed, ctx, lessonAuthorCorrelationId, aiSettings, sourceDocuments, sourceDocumentContext, onDone, finalizeAiReservation } = turn;
  const { currentTurnText } = budget;
  const { enrichedPrompt, hasCourseContext } = prompt;
  const { fullResponse, providerMeter, chatUsage, geminiTurnUsage, chatSources, chatRetrieval } = answer;
  const stoppedUsage = providerMeter.anyStopped() ? providerMeter.billedUsage() : null;
  await finalizeAiReservation(
    stoppedUsage
      // Stopped part-way (client left or deadline): every call that started, as billed.
      ? normalizeAiUsage(stoppedUsage)
      : chatUsage
        ? normalizeAiUsage(chatUsage)
        : geminiTurnUsage
          ? normalizeAiUsage(geminiTurnUsage)
          : estimateAiTurnUsage([enrichedPrompt, currentTurnText, sourceDocumentContext], assistantContent || fullResponse),
    { service: aiSettings.activeEngine, operation: 'chat' },
    {
      source_document_count: sourceDocuments.length,
      has_course_context: hasCourseContext,
      rag_source_count: chatSources.length,
      ...(chatRetrieval ? { rag_retrieval: chatRetrieval } : {}),
      ...(stoppedUsage ? { stopped_early: true } : {}),
    },
  );

  // 8. Auto-title on first message pair ONLY (using pre-loaded msg_count from CTE)
  if (ctx.messageCount === 0) {
    const title = trimmed.slice(0, 50) + (trimmed.length > 50 ? '...' : '');
    await query(
      `UPDATE chat_conversations SET title = $1 WHERE id = $2`,
      [title, conversationId],
    );
  }

  logLessonAuthorFlow('stream_done', {
    correlation_id: lessonAuthorCorrelationId,
    conversation_id: conversationId,
    target: ctx.target,
    response_chars: fullResponse.length,
  });
  onDone();
}

/** A failed turn: settle what the provider billed, else release the reservation; then report the error. */
export async function failChatTurn(
  state: ChatTurnState,
  conversationId: string,
  err: any,
  onError: (err: Error) => void,
): Promise<void> {
  // A chat answer whose provider calls started is paid for, even when it
  // failed or was stopped; only an answer that never reached the provider
  // returns its reservation.
  const billedUsage = state.chatProviderMeter?.billedUsage() ?? null;
  if (billedUsage && state.aiReservationId && state.aiReservationTenantId && !state.aiReservationFinalized) {
    await finalizeChatTurnReservation(
      state,
      normalizeAiUsage(billedUsage),
      { service: state.chatProviderService, operation: 'chat' },
      { failed_after_billing: true, ...(state.chatProviderMeter?.anyStopped() ? { stopped_early: true } : {}) },
    ).catch((finalizeErr: any) => {
      console.error('[AI Chatbot] Failed to settle a billed chat answer:', finalizeErr?.message || String(finalizeErr));
    });
  }
  if (state.aiReservationId && state.aiReservationTenantId && !state.aiReservationFinalized) {
    await releaseTenantAiTokenReservation(state.aiReservationId, state.aiReservationTenantId).catch((releaseErr: any) => {
      console.error('[AI Chatbot] Failed to release token reservation:', releaseErr?.message || String(releaseErr));
    });
  }
  await markKbStorePermissionProblemFromChat(state.ctxForError, err);
  logLessonAuthorFlow('stream_error', {
    correlation_id: state.lessonAuthorCorrelationId,
    conversation_id: conversationId,
    error: redactGeminiApiKeys(err?.message || 'Unknown stream error'),
  });
  onError(sanitizeGeminiError(err));
}
