// Stage 2 of a chat turn, resolve context: the conversation and its course,
// the input filter, the tenant AI settings, then the AI ID context
// (ai-id/legacy/chat-turn-context.service.ts). Moved from sendMessageStream
// (chat.service.ts).

import { randomUUID } from 'crypto';
import { query } from '../../../config/database.js';
import { env } from '../../../config/env.js';
import { getRedisClient } from '../../../config/redis.js';
import { AppError } from '../../../middleware/error-handler.js';
import { ChapterCheckpointError } from '../ai-id/lesson-author-chapter-checkpoint.logic.js';
import { executeChapterCheckpoint } from '../ai-id/legacy/chapter-checkpoint.service.js';
import { resolveLessonAuthorTurnContext } from '../ai-id/legacy/chat-turn-context.service.js';
import { getTenantAiRuntimeSettings } from '../ai-platform/ai-settings.service.js';
import { runStoredInputFilter } from '../ai-platform/input-filter/input-filter.service.js';
import { assertChatCourseAccess } from './chat-course-scope.service.js';
import { LESSON_AUTHOR_TARGET } from './chat.constants.js';
import type { ConversationContext } from './chat.types.js';
import { saveInputFilterRejectedTurn } from './chat-turn-persist.service.js';
import { loadConversationContext, logLessonAuthorFlow, markRateLimit } from './chat-turn-runtime.service.js';
import type { ChatTurn, ChatTurnRequest, ChatTurnState } from './chat-turn.types.js';

/** The turn with its context, or null when it was answered here (input filter refusal, chapter checkpoint). */
export async function resolveChatTurnContext(request: ChatTurnRequest, state: ChatTurnState): Promise<ChatTurn | null> {
  const { conversationId, userId, tenantId, trimmed, options, onChunk, onDone, onSideEvent } = request;
  // 1. Load context (CTE: 1 query for conversation + persona + prompt + msg count)
  const ctx = await loadConversationContext(conversationId, userId, tenantId, options.target);
  state.ctxForError = ctx;
  if (env.LESSON_AUTHOR_GENERATION_ENABLED && ctx.target === LESSON_AUTHOR_TARGET) {
    const active = await query(`SELECT id FROM lesson_author_generation_jobs
      WHERE tenant_id=$1 AND conversation_id=$2 AND status IN ('queued','running') LIMIT 1`, [tenantId, conversationId]);
    if (active.rows.length) throw new AppError('Đang tạo Bản thiết kế khóa học. Vui lòng đợi kết quả.', 409, 'GENERATION_ALREADY_ACTIVE');
  }
  // One correlation ID is owned by Node and follows a Blueprint through the
  // internal Python workflow. It is diagnostics-only and is never persisted
  // as a user-controlled target or authorization input.
  state.lessonAuthorCorrelationId = ctx.target === LESSON_AUTHOR_TARGET ? options.correlationId ?? randomUUID() : null;
  const lessonAuthorCorrelationId = state.lessonAuthorCorrelationId;
  const inputMode = options.inputMode === 'voice' ? 'voice' : 'text';
  const isVoiceTurn = inputMode === 'voice';
  logLessonAuthorFlow('stream_context_loaded', {
    correlation_id: lessonAuthorCorrelationId,
    conversation_id: conversationId,
    tenant_id: tenantId,
    user_id: userId,
    target: ctx.target,
    bot_id: ctx.botId,
    course_id: ctx.courseId,
    has_bot_kb: Boolean(ctx.botKbId),
    requested_mode: options.mode ?? 'auto',
    input_mode: inputMode,
    message_chars: trimmed.length,
    message_count_before: ctx.messageCount,
  });
  if (options.target && options.target !== ctx.target) {
    throw new Error('Conversation target mismatch');
  }
  if (options.courseId && ctx.courseId && options.courseId !== ctx.courseId) {
    throw new Error('Conversation course mismatch');
  }
  const courseId = options.courseId ?? ctx.courseId ?? undefined;
  // Client value or stored row alike: only a course this actor may use in chat.
  if (courseId) await assertChatCourseAccess(courseId, { tenantId: ctx.tenantId, userId, role: options.reportActorRole });

  if (await answerInputFilterRefusal(ctx, request)) return null;

  const aiSettings = await getTenantAiRuntimeSettings(ctx.tenantId);
  if (options.chapterResume) {
    if (ctx.target!==LESSON_AUTHOR_TARGET) throw new ChapterCheckpointError('CHAPTER_CHECKPOINT_CONTRACT_INVALID');
    await executeChapterCheckpoint(ctx,userId,trimmed,options,null,onChunk,onDone,onSideEvent);
    return null;
  }
  if (!aiSettings.hasGoogleAiStudioKey) {
    throw new AppError(
      'Chưa cấu hình API key Google AI Studio cho doanh nghiệp này.',
      400,
      'AI_PROVIDER_KEY_MISSING',
    );
  }
  logLessonAuthorFlow('ai_runtime_settings_loaded', {
    correlation_id: lessonAuthorCorrelationId,
    conversation_id: conversationId,
    tenant_id: ctx.tenantId,
    target: ctx.target,
    active_engine: aiSettings.activeEngine,
    transition_state: aiSettings.transitionState,
    chat_model: aiSettings.chatModel,
    lesson_author_model: aiSettings.lessonAuthorModel,
    embedding_model: aiSettings.embeddingModel,
  });
  if (aiSettings.activeEngine === 'self_built_rag'
    && ctx.target !== LESSON_AUTHOR_TARGET
    && !ctx.botKbId
    && !options.canAccessReports) {
    throw new AppError(
      'Bot này chưa được gắn Kho tri thức. Vui lòng gắn Kho tri thức cho bot trước khi chat bằng AI RAG.',
      400,
      'AI_RAG_KB_NOT_ASSIGNED',
    );
  }

  const base = { ...request, ctx, lessonAuthorCorrelationId, isVoiceTurn, courseId, aiSettings };
  const lessonAuthor = await resolveLessonAuthorTurnContext(base);
  return lessonAuthor ? { ...base, ...lessonAuthor } : null;
}

/** The bot's input filter: true when it refused the message and answered with its reply. */
async function answerInputFilterRefusal(ctx: ConversationContext, request: ChatTurnRequest): Promise<boolean> {
  const { conversationId, userId, trimmed, onChunk, onDone } = request;
  try {
    const filterOutcome = await runStoredInputFilter({
      message: trimmed,
      sessionId: conversationId,
      tenantId: ctx.tenantId,
      botId: ctx.botId,
      rawConfig: ctx.inputFilterConfig,
      redisClient: getRedisClient(),
    });

    if (filterOutcome.blocked && filterOutcome.replyMessage) {
      markRateLimit(userId);
      await saveInputFilterRejectedTurn(ctx, trimmed, filterOutcome.replyMessage, filterOutcome.result);
      logLessonAuthorFlow('input_filter_rejected', {
        conversation_id: conversationId,
        tenant_id: ctx.tenantId,
        bot_id: ctx.botId,
        target: ctx.target,
        code: filterOutcome.result.code,
        processing_time_ms: filterOutcome.result.processingTimeMs ?? null,
      });
      onChunk(filterOutcome.replyMessage);
      onDone();
      return true;
    }
  } catch (err) {
    console.error('[InputFilter] Invalid config or runtime error; continuing chat flow', {
      conversation_id: conversationId,
      tenant_id: ctx.tenantId,
      bot_id: ctx.botId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return false;
}
