// Stage 3 of a chat turn, reserve: the bounded history and the token budget
// of the turn, reserved against the tenant's AI points before anything is
// saved. A grant of only the minimum gives a shorter answer (one attempt).
// Moved from sendMessageStream (chat.service.ts).

import { query } from '../../../config/database.js';
import { composeV5BlueprintPolicy } from '../ai-id/v1/lesson-author-prompt-policy.logic.js';
import { resolveLessonAuthorDraftLocale } from '../ai-id/shared/lesson-author-intent.logic.js';
import { buildCurrentTurnText } from '../ai-id/legacy/context.service.js';
import { getLessonAuthorBlueprintSystemInstruction } from '../ai-id/legacy/generation-schema.logic.js';
import type { AiOperation } from '../ai-platform/ai-engine.types.js';
import { reserveTenantAiTokens } from '../ai-platform/ai-token-quota.service.js';
import { HISTORY_CONTEXT_LIMIT, HISTORY_MESSAGE_MAX_CHARS, LESSON_AUTHOR_TARGET } from './chat.constants.js';
import { buildAiTurnTokenBudget, grantedOutputTokenLimit } from './chat-turn.logic.js';
import { logLessonAuthorFlow } from './chat-turn-runtime.service.js';
import type { ChatTurn, ChatTurnBudget, ChatTurnState } from './chat-turn.types.js';

async function loadHistory(conversationId: string): Promise<{ role: string; parts: { text: string }[] }[]> {
  const result = await query<{ role: string; content: string }>(
    `SELECT role, content FROM chat_messages
     WHERE conversation_id = $1
     ORDER BY created_at DESC LIMIT $2`,
    [conversationId, HISTORY_CONTEXT_LIMIT],
  );
  return result.rows.reverse().map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    // Prompt context is intentionally bounded independently of message storage.
    // This prevents a single historical answer from silently consuming a tenant's full quota.
    parts: [{ text: m.content.slice(0, HISTORY_MESSAGE_MAX_CHARS) }],
  }));
}

export async function reserveChatTurn(turn: ChatTurn, state: ChatTurnState): Promise<ChatTurnBudget> {
  const {
    conversationId, userId, trimmed, options, ctx, lessonAuthorCorrelationId, aiSettings,
    outlineMentions, mentionContext, sourceDocuments, preClassify, blueprintDraftContext,
    targetScopeInstruction, sourceDocumentContext,
  } = turn;
  // Read and bound the existing conversation before reserving quota. The
  // current user turn is added in memory so a rejected request is never
  // persisted merely because its token reservation failed.
  const currentTurnText = buildCurrentTurnText(trimmed, outlineMentions, mentionContext, sourceDocuments);
  const historyBeforeCurrent = (await loadHistory(conversationId)).slice(-(HISTORY_CONTEXT_LIMIT - 1));
  const historyForTurn = [
    ...historyBeforeCurrent,
    { role: 'user', parts: [{ text: currentTurnText }] },
  ];

  const aiOperation: AiOperation = ctx.target === LESSON_AUTHOR_TARGET
    && (preClassify?.intent === 'draft_lesson' || preClassify?.intent === 'course_blueprint')
    ? 'lesson_author'
    : 'chat';
  const aiModel = aiOperation === 'lesson_author'
    ? aiSettings.lessonAuthorModel
    : aiSettings.chatModel;
  const requestedLocale = ctx.target === LESSON_AUTHOR_TARGET
    ? resolveLessonAuthorDraftLocale(trimmed, options.locale ?? 'vi', blueprintDraftContext?.outputLocale)
    : options.locale ?? 'vi';
  const isCourseBlueprint = preClassify?.intent === 'course_blueprint';
  const v5Policy = isCourseBlueprint && aiSettings.activeEngine === 'self_built_rag'
    ? composeV5BlueprintPolicy(requestedLocale, ctx.systemPrompt ?? '') : null;
  if (v5Policy) logLessonAuthorFlow('blueprint_policy_composed', {
    correlation_id: lessonAuthorCorrelationId, conversation_id: conversationId,
    ...v5Policy.diagnostics,
  });
  const blueprintSystemPrompt = isCourseBlueprint
    ? v5Policy?.prompt ?? getLessonAuthorBlueprintSystemInstruction(requestedLocale, ctx.systemPrompt)
    : null;
  const budgetSystemPrompt = blueprintSystemPrompt ?? ctx.systemPrompt;
  const historyPromptParts = aiSettings.activeEngine === 'gemini_file_search' && aiOperation === 'lesson_author'
    ? []
    : historyBeforeCurrent.map((message) => message.parts.map((part) => part.text).join('\n'));
  const aiTurnBudget = buildAiTurnTokenBudget({
    engine: aiSettings.activeEngine,
    operation: aiOperation,
    isCourseBlueprint,
    promptParts: [
      budgetSystemPrompt,
      currentTurnText,
      mentionContext,
      targetScopeInstruction,
      sourceDocumentContext,
      ...historyPromptParts,
    ],
  });
  state.aiReservationTenantId = ctx.tenantId;
  state.aiReservationEmbeddingModel = aiSettings.activeEngine === 'self_built_rag'
    ? aiSettings.embeddingModel
    : null;
  const aiReservation = await reserveTenantAiTokens({
    tenantId: ctx.tenantId,
    userId,
    conversationId,
    target: ctx.target,
    engine: aiSettings.activeEngine,
    provider: aiSettings.provider,
    model: aiModel,
    operation: aiOperation,
    minimumTokens: aiTurnBudget.minimumTokens,
    maximumTokens: aiTurnBudget.maximumTokens,
    budget: {
      inputTokens: aiTurnBudget.fixedInputTokens,
      outputTokens: aiTurnBudget.targetOutputTokens,
      embeddingTokens: aiTurnBudget.embeddingTokens,
      maxOutputTokens: aiTurnBudget.targetOutputTokens,
      metadata: {
        budget_version: 2,
        operation: aiOperation,
        engine: aiSettings.activeEngine,
      },
    },
  });
  state.aiReservationId = aiReservation.id;
  const generationAttempts = aiTurnBudget.maxGenerationAttempts > 1
    && aiReservation.reservedTokens >= aiTurnBudget.retryMinimumTokens
    ? aiTurnBudget.maxGenerationAttempts
    : 1;
  const maxOutputTokens = grantedOutputTokenLimit(aiTurnBudget, aiReservation.reservedTokens, generationAttempts);
  logLessonAuthorFlow('ai_token_reserved', {
    correlation_id: lessonAuthorCorrelationId,
    conversation_id: conversationId,
    tenant_id: ctx.tenantId,
    target: ctx.target,
    active_engine: aiSettings.activeEngine,
    operation: aiOperation,
    model: aiModel,
    minimum_tokens: aiTurnBudget.minimumTokens,
    reserved_tokens: aiReservation.reservedTokens,
    maximum_tokens: aiTurnBudget.maximumTokens,
    max_output_tokens: maxOutputTokens,
    max_generation_attempts: generationAttempts,
    partial_grant: aiReservation.isPartialGrant,
  });

  return { currentTurnText, historyForTurn, requestedLocale, blueprintSystemPrompt, maxOutputTokens, generationAttempts };
}
