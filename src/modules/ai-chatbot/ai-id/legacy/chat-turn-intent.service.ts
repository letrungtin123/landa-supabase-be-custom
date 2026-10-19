// AI ID V1 / lesson-author intent of a chat turn: the deterministic intent
// and operation plan (zero provider calls), then the turns answered without
// a provider: a clarification question and a simple action proposal (rename,
// delete, move). Moved from sendMessageStream (chat/chat.service.ts).

import { query } from '../../../../config/database.js';
import {
  type LessonAuthorOperationPlan,
  type LessonAuthorProposal,
} from '../../../course-authoring/course-authoring.service.js';
import { classifyLessonAuthorIntent, detectLessonAuthorInputLocale } from '../lesson-author-intent.logic.js';
import { buildNormalizedLessonAuthorCommand, isSimpleDeterministicLessonAuthorCommand } from '../lesson-author-command.logic.js';
import { LESSON_AUTHOR_TARGET } from '../../chat/chat.constants.js';
import { logLessonAuthorFlow } from '../../chat/chat-turn-runtime.service.js';
import { estimateAiTurnUsage } from '../../chat/chat-turn-settle.service.js';
import type { ChatTurn, ChatTurnBudget } from '../../chat/chat-turn.types.js';
import type { LessonAuthorIntent, IntentSignal } from './types.js';
import { createLessonAuthorJob } from './job-store.service.js';
import {
  resolveLessonAuthorOperationPlan,
  buildLessonAuthorOperationInstruction,
  formatLessonAuthorIntentClarification,
} from './targets.service.js';
import { formatLessonAuthorActionPreview } from './preview.logic.js';
import { classifyLessonAuthorIntentV2 } from './intent-classifier.logic.js';

export type LessonAuthorTurnIntent = Awaited<ReturnType<typeof resolveLessonAuthorTurnIntent>>;

export async function resolveLessonAuthorTurnIntent(turn: ChatTurn, budget: ChatTurnBudget) {
  const {
    conversationId, trimmed, options, ctx, lessonAuthorCorrelationId, outlineMentions, outlineMentionSource,
    creationContext, sourceDocuments, blueprintDraftContext,
  } = turn;
  const { requestedLocale } = budget;
  let { targetScopeInstruction } = turn;
  // ── Intent classification via deterministic scoring (zero Gemini calls) ──
  const { intent: lessonAuthorIntent, operationPlan: classifiedOperationPlan, signals: intentSignals, score: intentScore, input_locale: inputLocale } = ctx.target === LESSON_AUTHOR_TARGET
    ? classifyLessonAuthorIntentV2(
      trimmed,
      outlineMentions,
      (options.mode as 'chat' | 'course_blueprint' | 'draft_lesson' | 'auto') ?? 'auto',
      outlineMentionSource === 'none' ? undefined : outlineMentionSource,
      creationContext,
    )
    : {
      intent: 'chat' as LessonAuthorIntent,
      operationPlan: classifyLessonAuthorIntent({ message: trimmed, mode: 'chat' }),
      signals: [] as IntentSignal[],
      score: -100,
      input_locale: detectLessonAuthorInputLocale(trimmed),
    };
  // A blueprint chapter is a pending, virtual target: it may not exist in
  // the course outline until the proposal is approved. Resolve existing
  // nodes only for ordinary @mention/explicit edit flows.
  const resolvedOperationPlan = ctx.target === LESSON_AUTHOR_TARGET
    ? blueprintDraftContext
      ? {
        ...classifiedOperationPlan,
        // A blueprint chapter is virtual until Apply. In draft_lesson mode
        // it is always a guarded create, never an update of an unknown node.
        operation: 'create' as const,
        target_type: 'chapter' as const,
        target_resolution: 'new' as const,
        target_block_id: null,
        target_path: `Blueprint Chapter ${blueprintDraftContext.chapterIndex + 1}`,
        target_number_path: String(blueprintDraftContext.chapterIndex + 1),
        target_display_name: blueprintDraftContext.blueprint.chapters[blueprintDraftContext.chapterIndex]?.title ?? null,
        ambiguity_reasons: [],
        signals: [...classifiedOperationPlan.signals, 'blueprint_chapter_create'],
      }
      : await resolveLessonAuthorOperationPlan(ctx, classifiedOperationPlan, trimmed, outlineMentions.slice(0, 1))
    : classifiedOperationPlan;
  const normalizedLessonAuthorCommand = ctx.target === LESSON_AUTHOR_TARGET
    ? buildNormalizedLessonAuthorCommand({
      plan: resolvedOperationPlan,
      userInstruction: trimmed,
      sourceDocumentIds: sourceDocuments.map(document => document.document_id),
    })
    : null;
  if (ctx.target === LESSON_AUTHOR_TARGET && blueprintDraftContext) {
    const chapter = blueprintDraftContext.blueprint.chapters[blueprintDraftContext.chapterIndex];
    targetScopeInstruction = [
      targetScopeInstruction,
      'SERVER-RESOLVED OPERATION: CREATE_NEW_CHAPTER.',
      `Create exactly one pending Chapter ${blueprintDraftContext.chapterIndex + 1}: ${chapter?.title ?? 'the selected blueprint chapter'}.`,
      'The chapter does not exist in the course outline until approval. Return only this chapter and its complete detailed learning content; do not update or duplicate any existing outline node.',
    ].filter(Boolean).join('\n\n');
  } else if (
    ctx.target === LESSON_AUTHOR_TARGET
    && (resolvedOperationPlan.operation === 'create' || resolvedOperationPlan.operation === 'update_content')
  ) {
    targetScopeInstruction = [
      targetScopeInstruction,
      buildLessonAuthorOperationInstruction(resolvedOperationPlan),
    ].filter(Boolean).join('\n\n');
  }
  logLessonAuthorFlow('intent_scored', {
    correlation_id: lessonAuthorCorrelationId,
    conversation_id: conversationId,
    target: ctx.target,
    intent: lessonAuthorIntent,
    operation: resolvedOperationPlan.operation,
    target_type: resolvedOperationPlan.target_type,
    target_block_id: resolvedOperationPlan.target_block_id ?? null,
    confidence: resolvedOperationPlan.confidence,
    score: intentScore,
    input_locale: inputLocale,
    output_locale: requestedLocale,
    approved_blueprint_locale: blueprintDraftContext?.outputLocale ?? null,
    mention_source: outlineMentionSource,
    command_intent: normalizedLessonAuthorCommand?.intent ?? null,
    command_scope: normalizedLessonAuthorCommand?.scope ?? null,
    command_source_mode: normalizedLessonAuthorCommand?.source_mode ?? null,
    command_route: normalizedLessonAuthorCommand?.route ?? null,
    matched: intentSignals.filter(s => s.matched).map(s => `${s.name}(${s.weight > 0 ? '+' : ''}${s.weight})`),
    requested_mode: options.mode ?? 'auto',
    lesson_author_action: options.lessonAuthorAction ?? null,
  });
  return { lessonAuthorIntent, resolvedOperationPlan, normalizedLessonAuthorCommand, targetScopeInstruction };
}

/** True when the operation plan needs a clarification: asked without a provider call. */
export async function answerLessonAuthorClarification(
  turn: ChatTurn,
  budget: ChatTurnBudget,
  intent: LessonAuthorTurnIntent,
): Promise<boolean> {
  const { conversationId, ctx, aiSettings, onChunk, onDone, finalizeAiReservation } = turn;
  const { currentTurnText, requestedLocale } = budget;
  const { resolvedOperationPlan, normalizedLessonAuthorCommand } = intent;
  if (ctx.target === LESSON_AUTHOR_TARGET && resolvedOperationPlan.operation === 'clarify') {
    const assistantText = formatLessonAuthorIntentClarification(resolvedOperationPlan, requestedLocale);
    onChunk(assistantText);
    await query(
      `INSERT INTO chat_messages (conversation_id, role, content, metadata)
       VALUES ($1, 'assistant', $2, $3)`,
      [conversationId, assistantText, {
        kind: 'lesson_author_intent_clarification',
        lesson_author_intent: resolvedOperationPlan,
        ...(normalizedLessonAuthorCommand ? { lesson_author_command: normalizedLessonAuthorCommand } : {}),
      }],
    );
    await finalizeAiReservation(
      estimateAiTurnUsage([ctx.systemPrompt, currentTurnText], assistantText),
      { service: aiSettings.activeEngine, operation: 'chat' },
      { lesson_author_intent: resolvedOperationPlan.operation },
    );
    onDone();
    return true;
  }
  return false;
}

/** True when the command is a simple action (rename, delete, move): proposed without a provider call. */
export async function answerLessonAuthorAction(
  turn: ChatTurn,
  budget: ChatTurnBudget,
  intent: LessonAuthorTurnIntent,
): Promise<boolean> {
  const { conversationId, userId, trimmed, ctx, aiSettings, sourceDocuments, onChunk, onDone, onSideEvent, finalizeAiReservation } = turn;
  const { currentTurnText, requestedLocale } = budget;
  const { resolvedOperationPlan, normalizedLessonAuthorCommand } = intent;
  if (ctx.target === LESSON_AUTHOR_TARGET
    && normalizedLessonAuthorCommand
    && isSimpleDeterministicLessonAuthorCommand(normalizedLessonAuthorCommand)) {
    const actionPlan = resolvedOperationPlan as LessonAuthorOperationPlan;
    const actionProposal: LessonAuthorProposal = {
      summary: actionPlan.operation === 'rename'
        ? `Đề xuất đổi tiêu đề "${actionPlan.target_display_name}" thành "${actionPlan.requested_title}".`
        : actionPlan.operation === 'delete'
          ? `Đề xuất xóa ${actionPlan.target_type} "${actionPlan.target_display_name}" và toàn bộ nội dung bên trong.`
          : `Đề xuất thay đổi vị trí của ${actionPlan.target_type} "${actionPlan.target_display_name}".`,
      chapters: [],
      operation_plan: actionPlan,
    };
    const jobId = await createLessonAuthorJob(ctx, userId, trimmed, ctx.botKbId, actionProposal, sourceDocuments);
    const assistantText = formatLessonAuthorActionPreview(actionPlan, requestedLocale);
    onChunk(assistantText);
    onSideEvent?.({ type: 'proposal', job_id: jobId, proposal: actionProposal });
    await query(
      `INSERT INTO chat_messages (conversation_id, role, content, metadata)
       VALUES ($1, 'assistant', $2, $3)`,
      [conversationId, assistantText, {
        kind: 'lesson_author_proposal',
        lesson_author_job_id: jobId,
        lesson_author_job_status: 'proposed',
        locale: requestedLocale,
        lesson_author_intent: actionPlan,
        lesson_author_command: normalizedLessonAuthorCommand,
      }],
    );
    await finalizeAiReservation(
      estimateAiTurnUsage([ctx.systemPrompt, currentTurnText], assistantText),
      { service: aiSettings.activeEngine, operation: 'lesson_author' },
      { lesson_author_job_id: jobId, lesson_author_intent: actionPlan.operation },
    );
    onDone();
    return true;
  }
  return false;
}
