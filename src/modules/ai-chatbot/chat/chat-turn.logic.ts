// Pure chat turn helpers shared by chat.service.ts and the AI ID legacy code (ai-id/legacy/):
// token budget, RAG history and HTML stripping.
import { env } from '../../../config/env.js';
import type { AiOperation } from '../ai-platform/ai-engine.types.js';
import { estimateTokensFromText } from '../ai-platform/ai-token-quota.service.js';
import { type RagChatMessage } from '../ai-platform/ai-rag-client.service.js';
import {
  RAG_HISTORY_CONTEXT_LIMIT,
  RAG_HISTORY_MESSAGE_MAX_CHARS,
  RAG_LESSON_AUTHOR_BLUEPRINT_MIN_OUTPUT_TOKENS,
  RAG_LESSON_AUTHOR_MIN_OUTPUT_TOKENS,
  RAG_CHAT_MIN_OUTPUT_TOKENS,
  RAG_LESSON_AUTHOR_BLUEPRINT_MAX_OUTPUT_TOKENS,
  RAG_LESSON_AUTHOR_MAX_OUTPUT_TOKENS,
  RAG_CHAT_MAX_OUTPUT_TOKENS,
  RAG_RETRIEVAL_CONTEXT_TOKEN_BUDGET,
  BLUEPRINT_MAX_GENERATION_ATTEMPTS,
  LESSON_AUTHOR_MAX_GENERATION_ATTEMPTS,
  BLUEPRINT_RETRY_PROMPT_TOKEN_BUDGET,
} from './chat.constants.js';

/** Strip HTML tags → plain text, collapse whitespace */
export function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function toRagChatHistory(history: { role: string; parts: { text: string }[] }[]): RagChatMessage[] {
  return history.slice(-RAG_HISTORY_CONTEXT_LIMIT).map((item) => {
    const role: RagChatMessage['role'] = item.role === 'model' ? 'assistant' : 'user';
    return {
      role,
      content: item.parts.map(part => part.text).join('\n').trim().slice(0, RAG_HISTORY_MESSAGE_MAX_CHARS),
    };
  }).filter(item => item.content.length > 0);
}

interface AiTurnTokenBudget {
  fixedInputTokens: number;
  embeddingTokens: number;
  minimumOutputTokens: number;
  targetOutputTokens: number;
  maxGenerationAttempts: number;
  retryMinimumTokens: number;
  minimumTokens: number;
  maximumTokens: number;
}

export function buildAiTurnTokenBudget(input: {
  engine: 'gemini_file_search' | 'self_built_rag';
  operation: AiOperation;
  isCourseBlueprint?: boolean;
  promptParts: Array<string | null | undefined>;
}): AiTurnTokenBudget {
  const isLessonAuthor = input.operation === 'lesson_author';
  const isCourseBlueprint = isLessonAuthor && input.isCourseBlueprint === true;
  const minimumOutputTokens = isCourseBlueprint
    ? RAG_LESSON_AUTHOR_BLUEPRINT_MIN_OUTPUT_TOKENS
    : isLessonAuthor
      ? RAG_LESSON_AUTHOR_MIN_OUTPUT_TOKENS
      : RAG_CHAT_MIN_OUTPUT_TOKENS;
  const targetOutputTokens = isCourseBlueprint
    ? RAG_LESSON_AUTHOR_BLUEPRINT_MAX_OUTPUT_TOKENS
    : isLessonAuthor
      ? RAG_LESSON_AUTHOR_MAX_OUTPUT_TOKENS
      : RAG_CHAT_MAX_OUTPUT_TOKENS;
  const baseInputTokens = estimateTokensFromText(...input.promptParts);
  const fixedInputTokens = input.engine === 'self_built_rag'
    ? baseInputTokens + RAG_RETRIEVAL_CONTEXT_TOKEN_BUDGET
    : isLessonAuthor
      // File Search can make a skeleton call plus multiple content calls.
      ? Math.max(10_000, baseInputTokens + 2_000)
      : baseInputTokens + Math.min(2_000, Math.max(500, Math.ceil(baseInputTokens / 2)));
  const embeddingTokens = input.engine === 'self_built_rag'
    ? estimateTokensFromText(
      ...(isLessonAuthor ? input.promptParts.slice(1, 4) : [input.promptParts[1]]),
    )
    : 0;
  const maxGenerationAttempts = isLessonAuthor
    ? (isCourseBlueprint ? BLUEPRINT_MAX_GENERATION_ATTEMPTS : LESSON_AUTHOR_MAX_GENERATION_ATTEMPTS)
    : 1;
  const retryPromptTokens = Math.max(0, maxGenerationAttempts - 1) * BLUEPRINT_RETRY_PROMPT_TOKEN_BUDGET;
  const minimumTokens = fixedInputTokens + embeddingTokens + minimumOutputTokens;
  const retryMinimumTokens = maxGenerationAttempts > 1
    ? (fixedInputTokens + minimumOutputTokens) * maxGenerationAttempts + embeddingTokens + retryPromptTokens
    : minimumTokens;
  const modelBudget = (fixedInputTokens + targetOutputTokens) * maxGenerationAttempts
    + embeddingTokens
    + retryPromptTokens;
  const configuredMaximum = isLessonAuthor
    ? env.AI_LESSON_AUTHOR_TOKEN_RESERVE_ESTIMATE
    : env.AI_CHAT_TOKEN_RESERVE_ESTIMATE;
  // A self-built RAG chat answer always reserves its retrieval context plus a
  // full answer (the output a Gemini chat answer gets): an estimate below that
  // would leave only the minimum answer. Nearly spent AI points still shorten
  // it (reserveTenantAiTokens falls back to the minimum hold).
  const chatMaximum = input.engine === 'self_built_rag' && !isLessonAuthor
    ? Math.max(configuredMaximum, fixedInputTokens + embeddingTokens + targetOutputTokens)
    : configuredMaximum;
  // A Blueprint is the whole-course design contract. Do not split the
  // provider's supported output window because of a server-side estimate;
  // tenant quota remains the authoritative capacity control.
  const maximumTokens = isCourseBlueprint
    ? modelBudget
    : Math.max(minimumTokens, Math.min(chatMaximum, modelBudget));
  return {
    fixedInputTokens,
    embeddingTokens,
    minimumOutputTokens,
    targetOutputTokens,
    maxGenerationAttempts,
    retryMinimumTokens,
    minimumTokens,
    maximumTokens,
  };
}

export function grantedOutputTokenLimit(
  budget: AiTurnTokenBudget,
  reservedTokens: number,
  generationAttempts: number,
): number {
  const retryPromptTokens = generationAttempts > 1 ? budget.retryMinimumTokens - (
    (budget.fixedInputTokens + budget.minimumOutputTokens) * generationAttempts + budget.embeddingTokens
  ) : 0;
  const availableForOutput = Math.max(
    0,
    Math.floor((reservedTokens - budget.embeddingTokens - retryPromptTokens) / generationAttempts) - budget.fixedInputTokens,
  );
  return Math.max(
    budget.minimumOutputTokens,
    Math.min(budget.targetOutputTokens, availableForOutput),
  );
}

/**
 * The startup warning (one JSON line) when AI_CHAT_TOKEN_RESERVE_ESTIMATE is
 * below the RAG retrieval context plus a full chat answer, else null. Such an
 * estimate no longer shortens a self-built RAG chat answer (see
 * buildAiTurnTokenBudget), but it still bounds Gemini chat answers.
 */
export function chatReserveEstimateWarning(configuredTokens: number): string | null {
  const ragFloorTokens = RAG_RETRIEVAL_CONTEXT_TOKEN_BUDGET + RAG_CHAT_MAX_OUTPUT_TOKENS;
  if (configuredTokens >= ragFloorTokens) return null;
  return JSON.stringify({
    event: 'ai_chat_reserve_estimate_below_rag_floor',
    configured_tokens: configuredTokens,
    rag_floor_tokens: ragFloorTokens,
  });
}
