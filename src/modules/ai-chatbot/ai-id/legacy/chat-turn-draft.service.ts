// AI ID V1 / lesson-author draft turn: a pending lesson proposal (AI RAG
// service or Gemini File Search), validated against the Component Registry
// and the pedagogical rules before its job is stored, or a failed job; then
// answer and settle. Moved from sendMessageStream (chat/chat.service.ts).

import { query } from '../../../../config/database.js';
import { AppError } from '../../../../middleware/error-handler.js';
import { type LessonAuthorOperationPlan, type LessonAuthorProposal } from '../../../course-authoring/course-authoring.service.js';
import { getTenantAllowedCourseComponentTypeSet } from '../../../tenants/tenant-course-components.service.js';
import { assertLessonAuthorProposalComponentsValid } from '../content/lesson-author-component-registry.logic.js';
import { assertLessonAuthorPedagogicalQuality } from '../content/lesson-author-pedagogical-validator.logic.js';
import type { AiUsage } from '../../ai-platform/ai-engine.types.js';
import { normalizeAiUsage } from '../../ai-platform/ai-token-quota.service.js';
import { generateRagLessonAuthorProposal, type RagRetrievalDiagnostics } from '../../ai-platform/ai-rag-client.service.js';
import { toRagChatHistory } from '../../chat/chat-turn.logic.js';
import { logLessonAuthorFlow } from '../../chat/chat-turn-runtime.service.js';
import { estimateAiTurnUsage } from '../../chat/chat-turn-settle.service.js';
import type { ChatTurn, ChatTurnBudget } from '../../chat/chat-turn.types.js';
import type { LessonAuthorTurnIntent } from './chat-turn-intent.service.js';
import { createLessonAuthorJob, createFailedLessonAuthorJob } from './job-store.service.js';
import {
  toSourceDocumentMetadata,
  getDraftCourseOutlineForPrompt,
  toRagSourceDocuments,
  emitRagWorkflowProgress,
  formatOutlineMentionsForPrompt,
} from './context.service.js';
import { getLessonAuthorOutputSchemaHint } from './generation-schema.logic.js';
import { normalizeLessonAuthorProposal } from './proposal-normalize.logic.js';
import {
  constrainAdditiveComponentProposal,
  formatProposalPreview,
  formatLessonAuthorFailurePreview,
  getLessonAuthorProposalMetrics,
  sanitizeInternalErrorReason,
  toLessonAuthorDisplayProposal,
} from './preview.logic.js';
import { generateLessonAuthorProposalV2 } from './generation.service.js';
import { blueprintDraftArchitecture, lockProposalToBlueprintChapter } from './blueprint-store.service.js';

/** The provider usage and retrieval of the draft, kept even when a later step fails (settled as billed). */
interface DraftRun {
  draftUsage: Partial<AiUsage> | null;
  draftRetrieval: RagRetrievalDiagnostics | null;
}

export async function answerLessonAuthorDraftTurn(turn: ChatTurn, budget: ChatTurnBudget, intent: LessonAuthorTurnIntent): Promise<void> {
  const {
    conversationId, userId, trimmed, ctx, aiSettings, lessonAuthorCorrelationId, isDeleteRequest,
    outlineMentions, mentionContext, sourceDocuments, blueprintDraftContext, onSideEvent,
  } = turn;
  const { requestedLocale, maxOutputTokens } = budget;
  const { resolvedOperationPlan, targetScopeInstruction } = intent;
  let proposal: LessonAuthorProposal | null = null;
  let jobId: string | null = null;
  let assistantText = '';
  const run: DraftRun = { draftUsage: null, draftRetrieval: null };

  logLessonAuthorFlow('draft_branch_enter', {
    correlation_id: lessonAuthorCorrelationId,
    conversation_id: conversationId,
    course_id: ctx.courseId,
    kb_id: ctx.botKbId,
    active_engine: aiSettings.activeEngine,
  });
  try {
    // Delete guard: NEVER allow draft_lesson when delete intent detected
    if (isDeleteRequest) {
      throw new AppError('Thao tác xóa không được hỗ trợ qua Chuyên gia bài học. Vui lòng xóa trực tiếp trong outline/editor.', 400);
    }
    if (!ctx.botKbId) throw new AppError('Chưa cấu hình KB active cho chuyên gia tạo bài học', 409);
    if (aiSettings.activeEngine === 'self_built_rag') {
      proposal = await generateRagDraftProposal(turn, budget, intent, run);
    } else {
      proposal = await generateLessonAuthorProposalV2(
        ctx, trimmed, ctx.botKbId, outlineMentions, mentionContext, targetScopeInstruction, sourceDocuments,
        maxOutputTokens,
        (stage, detail) => {
          onSideEvent?.({ type: 'progress', stage, detail });
        },
        blueprintDraftContext,
      );
    }
    if (proposal && blueprintDraftContext) {
      proposal = lockProposalToBlueprintChapter(proposal, blueprintDraftContext);
    }
    if (
      proposal
      && !blueprintDraftContext
      && (resolvedOperationPlan.operation === 'create' || resolvedOperationPlan.operation === 'update_content')
    ) {
      proposal = {
        ...proposal,
        operation_plan: resolvedOperationPlan as LessonAuthorOperationPlan,
      };
    }
    if (proposal) {
      // This is the proposal-side counterpart of the Apply check. A
      // provider response cannot introduce an unregistered, forbidden,
      // tenant-disabled, or media-bearing component into review storage.
      assertLessonAuthorProposalComponentsValid(
        proposal,
        await getTenantAllowedCourseComponentTypeSet(ctx.tenantId),
      );
      const pedagogicalQuality = assertLessonAuthorPedagogicalQuality({
        proposal,
        ...(blueprintDraftContext
          ? { blueprint_chapter: blueprintDraftContext.blueprint.chapters[blueprintDraftContext.chapterIndex] }
          : {}),
      });
      // Retain safe operational quality output with the review artifact;
      // never add private source excerpts or model reasoning to a job.
      proposal = {
        ...proposal,
        source_evidence: {
          ...(proposal.source_evidence ?? {}),
          pedagogical_quality: {
            status: pedagogicalQuality.status,
            scores: pedagogicalQuality.scores,
            duplicate_count: pedagogicalQuality.duplicate_count,
            finding_codes: pedagogicalQuality.findings.map(item => item.code).slice(0, 24),
          },
        },
      };
    }
    jobId = await createLessonAuthorJob(
      ctx,
      userId,
      trimmed,
      ctx.botKbId,
      proposal,
      sourceDocuments,
      blueprintDraftContext?.id ?? null,
    );
    if (proposal) {
      assistantText = formatProposalPreview(proposal, blueprintDraftContext?.chapterIndex ?? 0, requestedLocale);
    } else if (!assistantText) {
      assistantText = formatLessonAuthorFailurePreview(new Error('AI did not return a lesson-author proposal.'), requestedLocale);
    }
    logLessonAuthorFlow('draft_branch_proposal_ready', {
      conversation_id: conversationId,
      job_id: jobId,
      assistant_chars: assistantText.length,
      ...getLessonAuthorProposalMetrics(proposal),
    });
  } catch (err: any) {
    const errorReason = sanitizeInternalErrorReason(err);
    // Never surface a pre-validation proposal. It may be structurally
    // plausible but has just failed the Blueprint source contract and is
    // therefore not applicable.
    proposal = null;
    jobId = await createFailedLessonAuthorJob(ctx, userId, trimmed, ctx.botKbId ?? null, errorReason, sourceDocuments);
    assistantText = formatLessonAuthorFailurePreview(err, requestedLocale);
    logLessonAuthorFlow('draft_branch_proposal_failed', {
      conversation_id: conversationId,
      job_id: jobId,
      error: errorReason,
    });
  }

  await sendDraftAnswer(turn, intent, budget, run, proposal, jobId, assistantText);
}

/** A pending proposal from the AI RAG service, with its source evidence. */
async function generateRagDraftProposal(
  turn: ChatTurn,
  budget: ChatTurnBudget,
  intent: LessonAuthorTurnIntent,
  run: DraftRun,
): Promise<LessonAuthorProposal> {
  const {
    conversationId, trimmed, ctx, aiSettings, lessonAuthorCorrelationId,
    outlineMentions, mentionContext, sourceDocuments, blueprintDraftContext, onSideEvent,
  } = turn;
  const { historyForTurn, requestedLocale, maxOutputTokens, generationAttempts } = budget;
  const { resolvedOperationPlan, targetScopeInstruction } = intent;
  onSideEvent?.({ type: 'progress', stage: 'RETRIEVING_EVIDENCE', detail: 'Đang truy xuất bằng chứng cho bài học' });
  const course = await getDraftCourseOutlineForPrompt(ctx.courseId!, ctx.tenantId);
  const ragHistory = toRagChatHistory(historyForTurn.slice(0, -1));
  const ragResponse = await generateRagLessonAuthorProposal({
    correlation_id: lessonAuthorCorrelationId ?? undefined,
    tenant_id: ctx.tenantId,
    kb_id: ctx.botKbId,
    conversation_id: conversationId,
    target: ctx.target,
    model: aiSettings.lessonAuthorModel,
    max_output_tokens: maxOutputTokens,
    embedding_model: aiSettings.embeddingModel,
    embedding_dimensions: aiSettings.embeddingDimensions,
    system_prompt: `${ctx.systemPrompt}\n\nYou are an Instructional Design expert. Build rigorous learner-centered course content from the provided source material. Return only a pending proposal for approval.`,
    user_message: trimmed,
    history: ragHistory,
    source_documents: toRagSourceDocuments(sourceDocuments),
    course_context: course.outline,
    outline_context: [
      outlineMentions.length > 0 ? formatOutlineMentionsForPrompt(outlineMentions.slice(0, 1)) : '',
      mentionContext,
    ].filter(Boolean).join('\n\n'),
    target_scope_instruction: targetScopeInstruction,
    ...(blueprintDraftContext ? { blueprint_architecture: blueprintDraftArchitecture(blueprintDraftContext) } : {}),
    output_schema_hint: getLessonAuthorOutputSchemaHint(),
    operation: resolvedOperationPlan.operation,
    target_type: resolvedOperationPlan.target_type,
    generation_mode: blueprintDraftContext
      ? 'staged'
      : resolvedOperationPlan.operation === 'create'
        && resolvedOperationPlan.target_type === 'chapter'
        ? 'staged'
        : 'auto',
    max_attempts: generationAttempts,
    locale: requestedLocale,
  });
  run.draftUsage = ragResponse.usage ?? null;
  run.draftRetrieval = ragResponse.retrieval ?? null;
  const draftRetrieval = run.draftRetrieval;
  emitRagWorkflowProgress(onSideEvent, ragResponse.workflow);
  const normalizedProposal = normalizeLessonAuthorProposal(ragResponse.proposal);
  const proposal = constrainAdditiveComponentProposal(
    {
      ...normalizedProposal,
      ...(draftRetrieval ? {
        source_evidence: {
          status: draftRetrieval.source_coverage_status ?? 'not_applicable',
          required_count: draftRetrieval.source_coverage_required_count ?? 0,
          covered_count: draftRetrieval.source_coverage_covered_count ?? 0,
          missing_fact_ids: draftRetrieval.source_coverage_missing_fact_ids ?? [],
          hard_locked: draftRetrieval.target_source_scope_hard_locked === true,
          pages: draftRetrieval.target_source_scope_pages ?? [],
          expected_pages: draftRetrieval.target_source_scope_expected_pages ?? [],
        },
      } : {}),
    },
    trimmed,
    outlineMentions.slice(0, 1),
  );
  logLessonAuthorFlow('draft_branch_rag_retrieval', {
    correlation_id: lessonAuthorCorrelationId,
    conversation_id: conversationId,
    kb_id: ctx.botKbId,
    retrieved_count: draftRetrieval?.retrieved_count ?? null,
    returned_source_count: draftRetrieval?.returned_source_count ?? null,
    top_score: draftRetrieval?.top_score ?? null,
    methods: draftRetrieval?.methods ?? [],
    reason: draftRetrieval?.reason ?? null,
    target_source_scope_hard_locked: draftRetrieval?.target_source_scope_hard_locked ?? null,
    target_source_scope_pages: draftRetrieval?.target_source_scope_pages ?? [],
    target_source_scope_missing_pages: draftRetrieval?.target_source_scope_missing_pages ?? [],
    source_coverage_status: draftRetrieval?.source_coverage_status ?? null,
    source_coverage_required_count: draftRetrieval?.source_coverage_required_count ?? null,
    source_coverage_covered_count: draftRetrieval?.source_coverage_covered_count ?? null,
    workflow: ragResponse.workflow?.workflow ?? null,
    workflow_status: ragResponse.workflow?.status ?? null,
    workflow_duration_ms: ragResponse.workflow?.duration_ms ?? null,
    workflow_repair_count: ragResponse.workflow?.repair_count ?? null,
    workflow_validation_codes: ragResponse.workflow?.validation_codes ?? [],
  });
  return proposal;
}

/** The answer, the proposal side event, the assistant message and the settlement. */
async function sendDraftAnswer(
  turn: ChatTurn,
  intent: LessonAuthorTurnIntent,
  budget: ChatTurnBudget,
  run: DraftRun,
  proposal: LessonAuthorProposal | null,
  jobId: string | null,
  assistantText: string,
): Promise<void> {
  const {
    conversationId, trimmed, ctx, aiSettings, mentionContext, sourceDocuments, sourceDocumentContext,
    blueprintDraftContext, onChunk, onDone, onSideEvent, finalizeAiReservation,
  } = turn;
  const { requestedLocale } = budget;
  const { targetScopeInstruction } = intent;
  const { draftUsage, draftRetrieval } = run;
  onChunk(assistantText);
  if (proposal && jobId) {
    onSideEvent?.({ type: 'proposal', job_id: jobId, proposal: toLessonAuthorDisplayProposal(proposal, requestedLocale) });
    logLessonAuthorFlow('draft_branch_side_event_sent', {
      conversation_id: conversationId,
      job_id: jobId,
    });
  }

  await query(
    `INSERT INTO chat_messages (conversation_id, role, content, metadata)
     VALUES ($1, 'assistant', $2, $3)`,
    [
      conversationId,
      assistantText,
      {
        lesson_author_job_id: jobId,
        kind: proposal ? 'lesson_author_proposal' : 'lesson_author_generation_failed',
        locale: requestedLocale,
        ...(proposal ? {
          lesson_author_job_status: 'proposed',
        } : {}),
        ...(blueprintDraftContext ? {
          lesson_author_blueprint_id: blueprintDraftContext.id,
          lesson_author_blueprint_chapter_index: blueprintDraftContext.chapterIndex,
        } : {}),
        ...(sourceDocuments.length > 0 ? { source_documents: sourceDocuments.map(toSourceDocumentMetadata) } : {}),
        ...(draftRetrieval ? { rag_retrieval: draftRetrieval } : {}),
      },
    ],
  );
  logLessonAuthorFlow('draft_branch_assistant_message_saved', {
    conversation_id: conversationId,
    job_id: jobId,
    success: Boolean(proposal),
  });
  await finalizeAiReservation(
    draftUsage
      ? normalizeAiUsage(draftUsage)
      : estimateAiTurnUsage([ctx.systemPrompt, trimmed, mentionContext, targetScopeInstruction, sourceDocumentContext], assistantText),
    { service: aiSettings.activeEngine, operation: 'lesson_author' },
    {
      lesson_author_job_id: jobId,
      ...(blueprintDraftContext ? { lesson_author_blueprint_id: blueprintDraftContext.id } : {}),
      source_document_count: sourceDocuments.length,
      ...(draftRetrieval ? { rag_retrieval: draftRetrieval } : {}),
    },
  );

  if (ctx.messageCount === 0) {
    const title = trimmed.slice(0, 50) + (trimmed.length > 50 ? '...' : '');
    await query(
      `UPDATE chat_conversations SET title = $1 WHERE id = $2`,
      [title, conversationId],
    );
  }

  logLessonAuthorFlow('draft_branch_done', {
    conversation_id: conversationId,
    job_id: jobId,
    success: Boolean(proposal),
  });
  onDone();
}
