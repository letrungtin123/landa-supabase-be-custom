// Stage 5 of a chat turn, stream provider: the answer from the AI RAG service
// or Gemini File Search (course router call, lesson content, retries on
// provider overload), stopped when the client leaves or the deadline passes,
// every started call metered (H10). Moved from sendMessageStream
// (chat.service.ts).

import { env } from '../../../config/env.js';
import { estimateTokensFromText, normalizeAiUsage } from '../ai-platform/ai-token-quota.service.js';
import { addAiUsage, aiUsageFromGeminiMetadata, createStreamUsageTracker } from '../ai-platform/ai-usage.logic.js';
import { RagServiceError, sendRagChat } from '../ai-platform/ai-rag-client.service.js';
import { toRagSourceDocuments } from '../ai-id/legacy/context.service.js';
import {
  abortableSleep,
  chatAnswerSignal,
  chatRetryDelayMs,
  createChatProviderMeter,
  mayRetryChatAttempt,
} from './chat-provider-turn.logic.js';
import { COURSE_TOOLS, fetchLessonContent } from './chat-course-context.service.js';
import { createChatResponseEmitter, emitTextAsSseChunks } from './chat-response-emitter.logic.js';
import { LESSON_AUTHOR_TARGET } from './chat.constants.js';
import { toRagChatHistory } from './chat-turn.logic.js';
import { logChatCourseFlow } from './chat-turn-runtime.service.js';
import type { ChatTurn, ChatTurnAnswer, ChatTurnBudget, ChatTurnPrompt, ChatTurnState } from './chat-turn.types.js';

const GEMINI_MAX_RETRIES = 3;
const GEMINI_RETRY_DELAY_MS = 5_000;       // base delay, actual may be longer for 429

/** Helper: parse retry delay from Gemini 429 error message */
function parseRetryDelay(err: any): number | null {
  try {
    const msg = err?.message || err?.toString() || '';
    const match = msg.match(/retry in (\d+(?:\.\d+)?)s/i);
    if (match) {
      const seconds = parseFloat(match[1]);
      if (seconds > 0 && seconds < 120) return Math.ceil(seconds * 1000);
    }
  } catch { /* a message without a retry hint: the default backoff applies */ }
  return null;
}

export async function streamChatTurnAnswer(
  turn: ChatTurn,
  budget: ChatTurnBudget,
  prompt: ChatTurnPrompt,
  state: ChatTurnState,
): Promise<ChatTurnAnswer> {
  const { ctx, options, aiSettings, sourceDocumentContext, onChunk } = turn;
  const { currentTurnText } = budget;
  const { enrichedPrompt } = prompt;
  // 6. Stream Gemini response with retry on 503
  //    Gemini constraint: fileSearch + functionDeclarations CANNOT be in the same request.
  //    Strategy when course context is active:
  //      Step 1: non-streaming call with ONLY functionDeclarations → check if function call
  //      Step 2a: if function call → fetch lesson content → streaming call with function result (no tools)
  //      Step 2b: if no function call → streaming call with fileSearch tools (KB fallback)
  //    Without course context: direct streaming with fileSearch (original flow).
  const shouldBufferLessonAuthorChat = ctx.target === LESSON_AUTHOR_TARGET;
  const responseEmitter = shouldBufferLessonAuthorChat ? null : createChatResponseEmitter(onChunk);
  // H10: the answer stops when the client leaves or the deadline passes.
  // Every provider call that started is metered, even when it is stopped.
  const answerSignal = chatAnswerSignal(options.abortSignal, env.AI_CHAT_ANSWER_DEADLINE_MS);
  const providerMeter = createChatProviderMeter({
    inputTokens: () => estimateTokensFromText(enrichedPrompt, currentTurnText, sourceDocumentContext),
    estimateTokens: (text) => estimateTokensFromText(text),
  });
  const answer: ChatTurnAnswer = {
    fullResponse: '',
    lastError: null,
    shouldBufferLessonAuthorChat,
    responseEmitter,
    appendChatChunk: (text: string) => {
      if (!text) return;
      answer.fullResponse += text;
      responseEmitter?.push(text);
    },
    chatUsage: null,
    geminiTurnUsage: null,
    chatSources: [],
    chatRetrieval: null,
    answerSignal,
    providerMeter,
  };
  state.chatProviderMeter = providerMeter;
  state.chatProviderService = aiSettings.activeEngine;

  if (aiSettings.activeEngine === 'self_built_rag') {
    await streamRagChatAnswer(turn, budget, prompt, answer);
  } else {
    await streamGeminiChatAnswer(turn, budget, prompt, answer);
  }
  return answer;
}

async function streamRagChatAnswer(turn: ChatTurn, budget: ChatTurnBudget, prompt: ChatTurnPrompt, answer: ChatTurnAnswer): Promise<void> {
  const { conversationId, trimmed, ctx, aiSettings, sourceDocuments } = turn;
  const { maxOutputTokens, requestedLocale } = budget;
  const { history, ragSystemPrompt, ragCourseContext, hasCourseContext } = prompt;
  const { answerSignal, providerMeter, responseEmitter } = answer;
  logChatCourseFlow('rag_chat_start', {
    conversation_id: conversationId,
    target: ctx.target,
    kb_id: ctx.botKbId,
    has_course_context: hasCourseContext,
    source_documents: sourceDocuments.length,
  });
  const ragCall = providerMeter.start();
  const ragResponse = await sendRagChat({
    tenant_id: ctx.tenantId,
    kb_id: ctx.botKbId,
    conversation_id: conversationId,
    target: ctx.target,
    model: aiSettings.chatModel,
    max_output_tokens: maxOutputTokens,
    embedding_model: aiSettings.embeddingModel,
    embedding_dimensions: aiSettings.embeddingDimensions,
    system_prompt: ragSystemPrompt,
    user_message: trimmed,
    // The current message is passed separately as user_message. Keeping it
    // out of history avoids paying for the same input twice.
    history: toRagChatHistory(history.slice(0, -1)),
    source_documents: toRagSourceDocuments(sourceDocuments),
    course_context: ragCourseContext,
    locale: requestedLocale,
  }, { signal: answerSignal }).catch((error: unknown) => {
    // A failed answer that the service still billed reports its usage.
    if (error instanceof RagServiceError && error.usage) ragCall.setUsage(normalizeAiUsage(error.usage));
    ragCall.fail(answerSignal.aborted);
    throw error;
  });
  answer.fullResponse = ragResponse.text ?? '';
  answer.chatUsage = ragResponse.usage ?? null;
  const { fullResponse, chatUsage } = answer;
  ragCall.addOutput(fullResponse);
  if (chatUsage) ragCall.setUsage(normalizeAiUsage(chatUsage));
  answer.chatSources = ragResponse.sources ?? [];
  answer.chatRetrieval = ragResponse.retrieval ?? null;
  const { chatSources, chatRetrieval } = answer;
  if (fullResponse) {
    emitTextAsSseChunks(fullResponse, responseEmitter?.push ?? (() => {}));
    responseEmitter?.flush();
  }
  logChatCourseFlow('rag_chat_done', {
    conversation_id: conversationId,
    response_chars: fullResponse.length,
    source_count: chatSources.length,
    retrieved_count: chatRetrieval?.retrieved_count ?? null,
    returned_source_count: chatRetrieval?.returned_source_count ?? null,
    top_score: chatRetrieval?.top_score ?? null,
    methods: chatRetrieval?.methods ?? [],
    reason: chatRetrieval?.reason ?? null,
  });
}

/** Up to GEMINI_MAX_RETRIES retries on provider overload (503/429), never once text reached the client. */
async function streamGeminiChatAnswer(turn: ChatTurn, budget: ChatTurnBudget, prompt: ChatTurnPrompt, answer: ChatTurnAnswer): Promise<void> {
  const { conversationId } = turn;
  const { hasCourseContext } = prompt;
  const { answerSignal, shouldBufferLessonAuthorChat } = answer;
  for (let attempt = 0; attempt <= GEMINI_MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        const delay = chatRetryDelayMs(attempt, parseRetryDelay(answer.lastError), GEMINI_RETRY_DELAY_MS);
        logChatCourseFlow('retry_wait', {
          conversation_id: conversationId,
          attempt,
          max_retries: GEMINI_MAX_RETRIES,
          wait_seconds: Math.round(delay / 1000),
          last_error: answer.lastError?.message ?? null,
        });
        await abortableSleep(delay, answerSignal);
        // A buffered answer (never sent yet) starts over instead of appending to the failed attempt.
        answer.fullResponse = '';
      }

      if (hasCourseContext) {
        await streamGeminiCourseAttempt(turn, budget, prompt, answer, attempt);
      } else {
        await streamGeminiDirectAttempt(turn, budget, prompt, answer);
      }

      answer.lastError = null;
      break; // Success — exit retry loop

    } catch (err: any) {
      answer.lastError = err;
      const status = err?.status || err?.code || 0;
      // Only provider overload (503/429) is retried; never once the answer
      // was stopped or text reached the client (a retry would repeat it).
      if (!mayRetryChatAttempt({
        status,
        attempt,
        maxRetries: GEMINI_MAX_RETRIES,
        stopped: answerSignal.aborted,
        textSentToClient: !shouldBufferLessonAuthorChat && answer.fullResponse.length > 0,
      })) break;
    }
  }
}

/** Course context: a forced router call (get_lesson_content or respond_directly), then the streamed answer. */
async function streamGeminiCourseAttempt(
  turn: ChatTurn,
  budget: ChatTurnBudget,
  prompt: ChatTurnPrompt,
  answer: ChatTurnAnswer,
  attempt: number,
): Promise<void> {
  const { conversationId, ctx, courseId, aiSettings } = turn;
  const { maxOutputTokens } = budget;
  const { history, aiClient, enrichedPrompt, fileSearchTools } = prompt;
  const { answerSignal, providerMeter, appendChatChunk } = answer;
  const { fnCallPart, fnCall } = await callGeminiCourseRouter(turn, budget, prompt, answer, attempt);

  if (fnCall?.name === 'get_lesson_content' && fnCall.args?.lesson_id) {
    // Gemini identified a course-related question → fetch lesson content
    const lessonContent = await fetchLessonContent(
      courseId!,
      fnCall.args.lesson_id as string,
      ctx.tenantId,
      ctx.target === LESSON_AUTHOR_TARGET,
    );
    logChatCourseFlow('lesson_content_fetched', {
      conversation_id: conversationId,
      course_id: courseId ?? null,
      lesson_id: fnCall.args.lesson_id,
      include_draft: ctx.target === LESSON_AUTHOR_TARGET,
      content_chars: lessonContent.length,
    });

    // Step 2: streaming with function result (no tools needed)
    const secondCall = providerMeter.start();
    let secondUsage: ReturnType<typeof createStreamUsageTracker> | null = null;
    try {
      const secondResponse = await aiClient.models.generateContentStream({
        model: aiSettings.chatModel,
        contents: [
          ...history,
          { role: 'model', parts: [fnCallPart ?? { functionCall: fnCall }] },
          { role: 'user', parts: [{ functionResponse: { name: 'get_lesson_content', response: { content: lessonContent } } }] },
        ],
        config: { systemInstruction: enrichedPrompt, maxOutputTokens, abortSignal: answerSignal },
      });
      const secondTracker = createStreamUsageTracker();
      secondUsage = secondTracker;
      for await (const chunk of secondResponse) {
        secondTracker.observe(chunk);
        const text = chunk.text ?? '';
        secondCall.addOutput(text);
        appendChatChunk(text);
      }
    } catch (error) {
      secondCall.fail(answerSignal.aborted);
      throw error;
    } finally {
      const secondUsed = secondUsage?.usage() ?? null;
      answer.geminiTurnUsage = addAiUsage(answer.geminiTurnUsage, secondUsed);
      secondCall.setUsage(secondUsed);
    }
  } else {
    // respond_directly OR no function call → not about course content
    // Stream with fileSearch KB (if available)
    logChatCourseFlow('stream_fallback_with_filesearch', {
      conversation_id: conversationId,
      file_search_enabled: fileSearchTools.length > 0,
    });
    const fallbackConfig: any = {
      systemInstruction: enrichedPrompt,
      maxOutputTokens,
      ...(fileSearchTools.length > 0 ? { tools: fileSearchTools } : {}),
      abortSignal: answerSignal,
    };
    const fallbackCall = providerMeter.start();
    let fallbackUsage: ReturnType<typeof createStreamUsageTracker> | null = null;
    try {
      const fallbackResponse = await aiClient.models.generateContentStream({
        model: aiSettings.chatModel,
        contents: history,
        config: fallbackConfig,
      });
      const fallbackTracker = createStreamUsageTracker();
      fallbackUsage = fallbackTracker;
      for await (const chunk of fallbackResponse) {
        fallbackTracker.observe(chunk);
        const text = chunk.text ?? '';
        fallbackCall.addOutput(text);
        appendChatChunk(text);
      }
    } catch (error) {
      fallbackCall.fail(answerSignal.aborted);
      throw error;
    } finally {
      const fallbackUsed = fallbackUsage?.usage() ?? null;
      answer.geminiTurnUsage = addAiUsage(answer.geminiTurnUsage, fallbackUsed);
      fallbackCall.setUsage(fallbackUsed);
    }
  }
}

/** The forced router call of a course question: get_lesson_content or respond_directly. */
async function callGeminiCourseRouter(
  turn: ChatTurn,
  budget: ChatTurnBudget,
  prompt: ChatTurnPrompt,
  answer: ChatTurnAnswer,
  attempt: number,
) {
  const { conversationId, ctx, courseId, aiSettings } = turn;
  const { maxOutputTokens } = budget;
  const { history, aiClient, enrichedPrompt } = prompt;
  const { answerSignal, providerMeter } = answer;
  logChatCourseFlow('function_router_start', {
    conversation_id: conversationId,
    target: ctx.target,
    course_id: courseId ?? null,
    attempt,
  });
  // ── Two-step flow: forced function calling (mode=ANY) ──
  // Gemini MUST choose: get_lesson_content OR respond_directly
  const routerCall = providerMeter.start();
  const firstResponse = await aiClient.models.generateContent({
    model: aiSettings.chatModel,
    contents: history,
    config: {
      systemInstruction: enrichedPrompt,
      maxOutputTokens,
      tools: [COURSE_TOOLS] as any,
      toolConfig: { functionCallingConfig: { mode: 'ANY' as any } },
      abortSignal: answerSignal,
    },
  }).catch((error: unknown) => { routerCall.fail(answerSignal.aborted); throw error; });
  answer.geminiTurnUsage = addAiUsage(answer.geminiTurnUsage, aiUsageFromGeminiMetadata(firstResponse.usageMetadata));
  routerCall.setUsage(aiUsageFromGeminiMetadata(firstResponse.usageMetadata));

  const fnCallPart = firstResponse.candidates?.[0]?.content?.parts?.find((part: any) => part.functionCall) as any;
  const fnCall = fnCallPart?.functionCall ?? firstResponse.functionCalls?.[0];
  logChatCourseFlow('function_router_chosen', {
    conversation_id: conversationId,
    function_name: fnCall?.name || 'none',
    args: fnCall?.args || {},
    has_thought_signature: Boolean(fnCallPart?.thoughtSignature),
  });
  return { fnCallPart, fnCall };
}

/** No course context: the streamed answer with File Search (the original flow). */
async function streamGeminiDirectAttempt(turn: ChatTurn, budget: ChatTurnBudget, prompt: ChatTurnPrompt, answer: ChatTurnAnswer): Promise<void> {
  const { conversationId, aiSettings } = turn;
  const { maxOutputTokens } = budget;
  const { history, aiClient, enrichedPrompt, fileSearchTools, hasCourseContext } = prompt;
  const { answerSignal, providerMeter, appendChatChunk } = answer;
  // ── Original flow: direct streaming with fileSearch (no course context) ──
  logChatCourseFlow('direct_stream_start', {
    conversation_id: conversationId,
    file_search_enabled: fileSearchTools.length > 0,
    has_course_context: hasCourseContext,
  });
  const config: any = {
    systemInstruction: enrichedPrompt,
    maxOutputTokens,
    ...(fileSearchTools.length > 0 ? { tools: fileSearchTools } : {}),
    abortSignal: answerSignal,
  };
  const directCall = providerMeter.start();
  let streamUsage: ReturnType<typeof createStreamUsageTracker> | null = null;
  try {
    const response = await aiClient.models.generateContentStream({
      model: aiSettings.chatModel,
      contents: history,
      config,
    });
    const streamTracker = createStreamUsageTracker();
    streamUsage = streamTracker;
    for await (const chunk of response) {
      streamTracker.observe(chunk);
      const text = chunk.text ?? '';
      directCall.addOutput(text);
      appendChatChunk(text);
    }
  } catch (error) {
    directCall.fail(answerSignal.aborted);
    throw error;
  } finally {
    const streamUsed = streamUsage?.usage() ?? null;
    answer.geminiTurnUsage = addAiUsage(answer.geminiTurnUsage, streamUsed);
    directCall.setUsage(streamUsed);
  }
}
