// AI ID V1 / lesson-author context of a chat turn (stage 2, resolve
// context): the outline targets (@mentions, editor context), the Blueprint
// chapter being drafted and the source documents; a chapter checkpoint turn
// is answered here. Moved from sendMessageStream (chat/chat.service.ts).

import { env } from '../../../../config/env.js';
import { AppError } from '../../../../middleware/error-handler.js';
import { buildLessonAuthorCreationContext, resolveLessonAuthorOutputLocale } from '../shared/lesson-author-intent.logic.js';
import { selectEditorContextTarget } from '../shared/lesson-author-command.logic.js';
import { LESSON_AUTHOR_TARGET } from '../../chat/chat.constants.js';
import { logLessonAuthorFlow } from '../../chat/chat-turn-runtime.service.js';
import type { ChatTurnBase } from '../../chat/chat-turn.types.js';
import type { LessonAuthorSourceDocument } from '../../chat/chat.types.js';
import type { BlueprintDraftContext, LessonAuthorOutlineMention } from './types.js';
import {
  validateLessonAuthorOutlineMentions,
  shouldCarryForwardLessonAuthorTarget,
  getLatestConversationOutlineMentions,
  validateLessonAuthorSourceDocuments,
  shouldCarryForwardLessonAuthorSourceDocuments,
  getLatestConversationSourceDocuments,
  formatSourceDocumentsForPrompt,
} from './context.service.js';
import {
  validateLessonAuthorEditorContext,
  toLessonAuthorEditorContextMention,
  getOutlineMentionContextRows,
  formatMentionContextRowsForPrompt,
  buildTargetLockedProposalInstruction,
} from './targets.service.js';
import { classifyLessonAuthorIntentV2 } from './intent-classifier.logic.js';
import {
  loadLessonAuthorBlueprintForDraft,
  tryLoadMatchingLessonAuthorBlueprintDraft,
  formatBlueprintDraftContext,
} from './blueprint-store.service.js';
import { executeChapterCheckpoint } from './chapter-checkpoint.service.js';

/** The outline targets of the turn. */
export interface LessonAuthorTurnTargets {
  validatedEditorContext: Awaited<ReturnType<typeof validateLessonAuthorEditorContext>>;
  creationContext: ReturnType<typeof buildLessonAuthorCreationContext>;
  isDeleteRequest: boolean;
  outlineMentions: LessonAuthorOutlineMention[];
  outlineMentionSource: 'current' | 'editor_context' | 'carried_forward' | 'none';
  preClassify: ReturnType<typeof classifyLessonAuthorIntentV2> | null;
  mentionContext: string;
  targetScopeInstruction: string;
}

/** The AI ID context of the turn: its targets, the Blueprint chapter being drafted and the source documents. */
export interface LessonAuthorTurnContext extends LessonAuthorTurnTargets {
  blueprintDraftContext: BlueprintDraftContext | null;
  sourceDocuments: LessonAuthorSourceDocument[];
  sourceDocumentSource: 'blueprint' | 'current' | 'carried_forward' | 'none';
  sourceDocumentContext: string;
}

/** The AI ID context of the turn, or null when a chapter checkpoint answered it. */
export async function resolveLessonAuthorTurnContext(turn: ChatTurnBase): Promise<LessonAuthorTurnContext | null> {
  return resolveLessonAuthorSources(turn, await resolveLessonAuthorTargets(turn));
}

/** The outline targets of the turn: current @mentions, the editor context, or the ones carried forward. */
async function resolveLessonAuthorTargets(turn: ChatTurnBase): Promise<LessonAuthorTurnTargets> {
  const { ctx, trimmed, options } = turn;
  const requestedOutlineMentions = await validateLessonAuthorOutlineMentions(ctx, options.outlineMentions ?? []);
  const validatedEditorContext = await validateLessonAuthorEditorContext(ctx, options.editorContext);
  const requestedMode = (options.mode as 'chat' | 'course_blueprint' | 'draft_lesson' | 'auto') ?? 'auto';
  const creationContext = buildLessonAuthorCreationContext(options, validatedEditorContext?.context);
  const initialPreClassify = ctx.target === LESSON_AUTHOR_TARGET
    ? classifyLessonAuthorIntentV2(
      trimmed,
      requestedOutlineMentions,
      requestedMode,
      requestedOutlineMentions.length > 0 ? 'current' : undefined,
      creationContext,
    )
    : null;
  const editorTarget = initialPreClassify && validatedEditorContext
    ? selectEditorContextTarget(
      trimmed,
      initialPreClassify.operationPlan,
      validatedEditorContext.context,
      requestedOutlineMentions.length > 0,
    )
    : null;
  const editorMention = editorTarget
    ? validatedEditorContext?.targets.get(editorTarget.id)
    : null;
  if (editorTarget && !editorMention) {
    throw new AppError('Không xác định được target editor context trong khóa học hiện tại.', 400);
  }
  const currentOutlineMentions = requestedOutlineMentions.length > 0
    ? requestedOutlineMentions
    : editorMention
      ? [toLessonAuthorEditorContextMention(editorMention)]
      : [];
  const currentOutlineMentionSource: 'current' | 'editor_context' | 'none' = requestedOutlineMentions.length > 0
    ? 'current'
    : editorMention
      ? 'editor_context'
      : 'none';
  const isDeleteRequest = initialPreClassify?.operationPlan.operation === 'delete'
    || initialPreClassify?.operationPlan.signals.includes('delete_verb') === true;
  const carriedOutlineMentions = !isDeleteRequest
    && currentOutlineMentions.length === 0
    && initialPreClassify?.intent !== 'course_blueprint'
    && shouldCarryForwardLessonAuthorTarget(trimmed)
      ? await getLatestConversationOutlineMentions(ctx)
      : [];
  const outlineMentions = currentOutlineMentions.length > 0 ? currentOutlineMentions : carriedOutlineMentions;
  const outlineMentionSource: 'current' | 'editor_context' | 'carried_forward' | 'none' = currentOutlineMentions.length > 0
    ? currentOutlineMentionSource
    : outlineMentions.length > 0
      ? 'carried_forward'
      : 'none';
  const preClassify = ctx.target === LESSON_AUTHOR_TARGET
    ? classifyLessonAuthorIntentV2(
      trimmed,
      outlineMentions,
      requestedMode,
      outlineMentionSource === 'none' ? undefined : outlineMentionSource,
      creationContext,
    )
    : null;
  const mentionContextRows = await getOutlineMentionContextRows(ctx, outlineMentions);
  const mentionContext = formatMentionContextRowsForPrompt(mentionContextRows);
  const targetScopeInstruction = buildTargetLockedProposalInstruction(trimmed, outlineMentions, mentionContextRows);
  return {
    validatedEditorContext,
    creationContext,
    isDeleteRequest,
    outlineMentions,
    outlineMentionSource,
    preClassify,
    mentionContext,
    targetScopeInstruction,
  };
}

/** The Blueprint chapter being drafted and the source documents; null when a chapter checkpoint answered the turn. */
async function resolveLessonAuthorSources(
  turn: ChatTurnBase,
  targets: LessonAuthorTurnTargets,
): Promise<LessonAuthorTurnContext | null> {
  const { ctx, conversationId, userId, trimmed, options, aiSettings, lessonAuthorCorrelationId, onChunk, onDone, onSideEvent } = turn;
  const { outlineMentions, outlineMentionSource, preClassify, mentionContext } = targets;
  let { targetScopeInstruction } = targets;
  let blueprintDraftContext: BlueprintDraftContext | null = null;
  let blueprintDraftSource: 'explicit' | 'auto_matched' | 'none' = 'none';
  if (ctx.target === LESSON_AUTHOR_TARGET && options.blueprintId) {
    if (preClassify?.intent !== 'draft_lesson') {
      throw new AppError('Blueprint chỉ được dùng khi soạn chi tiết một chương.', 400);
    }
    blueprintDraftContext = await loadLessonAuthorBlueprintForDraft(
      ctx,
      options.blueprintId,
      options.blueprintChapterIndex ?? 0,
      aiSettings.activeEngine === 'gemini_file_search',
      resolveLessonAuthorOutputLocale(trimmed, options.locale ?? 'vi'),
    );
    blueprintDraftSource = 'explicit';
  } else if (ctx.target === LESSON_AUTHOR_TARGET && preClassify?.intent === 'draft_lesson') {
    blueprintDraftContext = await tryLoadMatchingLessonAuthorBlueprintDraft(
      ctx,
      trimmed,
      aiSettings.activeEngine === 'gemini_file_search',
      resolveLessonAuthorOutputLocale(trimmed, options.locale ?? 'vi'),
    );
    blueprintDraftSource = blueprintDraftContext ? 'auto_matched' : 'none';
  }
  if (blueprintDraftContext) {
    targetScopeInstruction = [targetScopeInstruction, formatBlueprintDraftContext(blueprintDraftContext)]
      .filter(Boolean)
      .join('\n\n');
  }
  const requestedSourceDocuments = blueprintDraftContext
    ? []
    : await validateLessonAuthorSourceDocuments(
      ctx,
      ctx.botKbId,
      options.sourceDocuments ?? [],
      { requireGeminiMapping: aiSettings.activeEngine === 'gemini_file_search' },
    );
  const carriedSourceDocuments = !blueprintDraftContext
    && requestedSourceDocuments.length === 0
    && shouldCarryForwardLessonAuthorSourceDocuments(trimmed)
      ? await getLatestConversationSourceDocuments(ctx)
      : [];
  const sourceDocuments = blueprintDraftContext?.sourceDocuments
    ?? (requestedSourceDocuments.length > 0 ? requestedSourceDocuments : carriedSourceDocuments);
  const sourceDocumentSource = blueprintDraftContext
    ? 'blueprint'
    : requestedSourceDocuments.length > 0
      ? 'current'
      : sourceDocuments.length > 0
        ? 'carried_forward'
        : 'none';
  const sourceDocumentContext = formatSourceDocumentsForPrompt(sourceDocuments);
  logLessonAuthorFlow('stream_outline_mentions_validated', {
    correlation_id: lessonAuthorCorrelationId,
    conversation_id: conversationId,
    target: ctx.target,
    requested_count: options.outlineMentions?.length ?? 0,
    valid_count: outlineMentions.length,
    mention_ids: outlineMentions.map(mention => mention.block_id),
    mention_source: outlineMentionSource,
    mention_context_chars: mentionContext.length,
    target_scope_chars: targetScopeInstruction.length,
    blueprint_draft_source: blueprintDraftSource,
  });
  logLessonAuthorFlow('stream_source_documents_validated', {
    correlation_id: lessonAuthorCorrelationId,
    conversation_id: conversationId,
    target: ctx.target,
    requested_count: options.sourceDocuments?.length ?? 0,
    valid_count: sourceDocuments.length,
    source: sourceDocumentSource,
    document_ids: sourceDocuments.map(doc => doc.document_id),
    source_context_chars: sourceDocumentContext.length,
  });

  if (env.LESSON_AUTHOR_CHAPTER_CHECKPOINT_ENABLED && options.chapterCheckpointKey
    && ctx.target===LESSON_AUTHOR_TARGET && aiSettings.activeEngine==='self_built_rag'
    && blueprintDraftContext?.blueprint.architecture_contract_version===5) {
    await executeChapterCheckpoint(ctx,userId,trimmed,options,blueprintDraftContext,onChunk,onDone,onSideEvent);
    return null;
  }
  return {
    ...targets,
    targetScopeInstruction,
    blueprintDraftContext,
    sourceDocuments,
    sourceDocumentSource,
    sourceDocumentContext,
  };
}
