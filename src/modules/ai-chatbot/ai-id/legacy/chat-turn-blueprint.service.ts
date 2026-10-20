// AI ID V1 / lesson-author course Blueprint turn: generate (AI RAG service or
// Gemini File Search), normalize, validate and persist a Blueprint proposal,
// or record the failure; then answer and settle. Moved from sendMessageStream
// (chat/chat.service.ts).

import { query } from '../../../../config/database.js';
import { AppError } from '../../../../middleware/error-handler.js';
import { getTenantAllowedCourseComponentTypeSet } from '../../../tenants/tenant-course-components.service.js';
import { ComponentCapabilityError, createComponentCapabilities, readComponentCapabilities } from '../content/lesson-author-capabilities.logic.js';
import { acceptAndPersistLessonAuthorBlueprint, BlueprintAcceptanceError, blueprintBoundaryCounts } from '../v1/lesson-author-blueprint-acceptance.logic.js';
import type { AiUsage } from '../../ai-platform/ai-engine.types.js';
import { normalizeAiUsage } from '../../ai-platform/ai-token-quota.service.js';
import {
  generateRagLessonAuthorBlueprint,
  RagServiceError,
  type RagRetrievalDiagnostics,
} from '../../ai-platform/ai-rag-client.service.js';
import { RAG_LESSON_AUTHOR_BLUEPRINT_MAX_OUTPUT_TOKENS } from '../../chat/chat.constants.js';
import { toRagChatHistory } from '../../chat/chat-turn.logic.js';
import { logLessonAuthorFlow } from '../../chat/chat-turn-runtime.service.js';
import { estimateAiTurnUsage } from '../../chat/chat-turn-settle.service.js';
import type { ChatTurn, ChatTurnBudget } from '../../chat/chat-turn.types.js';
import { asRecord } from './component-normalize.logic.js';
import type { LessonAuthorBlueprint, LessonAuthorBlueprintQualityReport, DraftCourseOutline } from './types.js';
import {
  toSourceDocumentMetadata,
  getDraftCourseOutlineForPrompt,
  toRagSourceDocuments,
  emitRagWorkflowProgress,
  withAuthoritativeCourseTitle,
} from './context.service.js';
import { getLessonAuthorBlueprintSchemaHint } from './generation-schema.logic.js';
import { normalizeLessonAuthorBlueprint, buildLessonAuthorBlueprintQualityReport } from './blueprint-normalize.logic.js';
import { formatBlueprintPreview, formatLessonAuthorBlueprintFailurePreview } from './preview.logic.js';
import { generateLessonAuthorBlueprint } from './generation.service.js';
import { createLessonAuthorBlueprint, createFailedLessonAuthorBlueprint } from './blueprint-store.service.js';

/** What the Blueprint stages share while the turn runs (read by the failure record and the settlement). */
interface BlueprintRun {
  blueprintUsage: Partial<AiUsage> | null;
  blueprintRetrieval: RagRetrievalDiagnostics | null;
  blueprintFailureStage: string;
  blueprintStartedAt: number;
  logBlueprintBoundary: (stage: string, details: Record<string, unknown>) => void;
}

interface BlueprintResult {
  blueprint: LessonAuthorBlueprint | null;
  blueprintId: string | null;
  qualityReport: LessonAuthorBlueprintQualityReport | null;
  assistantText: string;
  course: DraftCourseOutline | null;
}

export async function answerLessonAuthorBlueprintTurn(turn: ChatTurn, budget: ChatTurnBudget): Promise<void> {
  const { conversationId, userId, trimmed, ctx, aiSettings, lessonAuthorCorrelationId, isDeleteRequest, sourceDocuments, onSideEvent } = turn;
  const { requestedLocale, maxOutputTokens, generationAttempts } = budget;
  let blueprint: LessonAuthorBlueprint | null = null;
  let blueprintId: string | null = null;
  let qualityReport: LessonAuthorBlueprintQualityReport | null = null;
  let assistantText = '';
  let course: DraftCourseOutline | null = null;
  const blueprintStartedAt = Date.now();
  const logBlueprintBoundary = (stage: string, details: Record<string, unknown>) => logLessonAuthorFlow(stage, {
    ...details, correlation_id: lessonAuthorCorrelationId, conversation_id: conversationId,
    timestamp_utc: new Date().toISOString(), duration_ms: Date.now() - blueprintStartedAt,
  });
  const run: BlueprintRun = {
    blueprintUsage: null,
    blueprintRetrieval: null,
    blueprintFailureStage: 'node_blueprint_preparation',
    blueprintStartedAt,
    logBlueprintBoundary,
  };

  logLessonAuthorFlow('blueprint_branch_enter', {
    correlation_id: lessonAuthorCorrelationId,
    conversation_id: conversationId,
    course_id: ctx.courseId,
    kb_id: ctx.botKbId,
    active_engine: aiSettings.activeEngine,
  });
  try {
    if (isDeleteRequest) {
      throw new AppError('Thao tác xóa không được hỗ trợ qua Chuyên gia bài học. Vui lòng xóa trực tiếp trong outline/editor.', 400);
    }
    if (!ctx.botKbId) throw new AppError('Chưa cấu hình KB active cho chuyên gia tạo bài học', 409);
    course = await getDraftCourseOutlineForPrompt(ctx.courseId!, ctx.tenantId);
    const allowedComponentTypes = await getTenantAllowedCourseComponentTypeSet(ctx.tenantId);
    onSideEvent?.({ type: 'progress', stage: 'ANALYZING_SOURCE', detail: 'Đang phân tích phạm vi tài liệu nguồn' });

    if (aiSettings.activeEngine === 'self_built_rag') {
      blueprint = await generateRagBlueprint(turn, budget, run, course, allowedComponentTypes);
    } else {
      onSideEvent?.({ type: 'progress', stage: 'designing' });
      blueprint = await generateLessonAuthorBlueprint(
        ctx,
        trimmed,
        ctx.botKbId,
        course,
        sourceDocuments,
        maxOutputTokens,
        requestedLocale,
        generationAttempts,
      );
    }

    blueprint = withAuthoritativeCourseTitle(blueprint, course.courseName);
    onSideEvent?.({ type: 'progress', stage: 'validating' });
    run.blueprintFailureStage = 'node_blueprint_validation';
    const candidateBlueprint = blueprint;
    const candidateCourse = course;
    const blueprintKbId = ctx.botKbId;
    const accepted = await acceptAndPersistLessonAuthorBlueprint(candidateBlueprint, candidateBlueprint.source_map, diagnostics => {
      logBlueprintBoundary('blueprint_node_validation', {
        correlation_id: lessonAuthorCorrelationId, conversation_id: conversationId,
        failure_stage: diagnostics.status === 'FAIL' ? 'node_blueprint_validation' : null,
        ...diagnostics,
      });
    }, async architectureValidation => {
      run.blueprintFailureStage = 'node_blueprint_quality_report';
      const report = buildLessonAuthorBlueprintQualityReport(
        candidateBlueprint, sourceDocuments.length, run.blueprintRetrieval,
        requestedLocale, architectureValidation,
      );
      run.blueprintFailureStage = 'node_blueprint_persistence';
      const id = await createLessonAuthorBlueprint(
        ctx, userId, trimmed, blueprintKbId, candidateBlueprint, report,
        candidateCourse.outline, sourceDocuments, aiSettings.activeEngine, aiSettings.lessonAuthorModel,
      );
      return { id, report };
    });
    blueprintId = accepted.id;
    qualityReport = accepted.report;
    run.blueprintFailureStage = 'node_blueprint_response';
    assistantText = formatBlueprintPreview(blueprint, qualityReport, requestedLocale);
    logBlueprintBoundary('blueprint_branch_ready', {
      correlation_id: lessonAuthorCorrelationId,
      conversation_id: conversationId,
      blueprint_id: blueprintId,
      chapters: blueprint.chapters.length,
      quality_score: qualityReport.score,
    });
  } catch (err: any) {
    // Failed-record persistence must never make a candidate review-ready.
    qualityReport = null;
    ({ blueprintId, assistantText } = await recordBlueprintFailure(turn, budget, run, err, course));
  }

  await sendBlueprintAnswer(turn, budget, run, { blueprint, blueprintId, qualityReport, assistantText, course });
}

/** A Blueprint from the AI RAG service, normalized against the tenant's components. */
async function generateRagBlueprint(
  turn: ChatTurn,
  budget: ChatTurnBudget,
  run: BlueprintRun,
  course: DraftCourseOutline,
  allowedComponentTypes: Awaited<ReturnType<typeof getTenantAllowedCourseComponentTypeSet>>,
): Promise<LessonAuthorBlueprint> {
  const { conversationId, trimmed, ctx, aiSettings, lessonAuthorCorrelationId, sourceDocuments, mentionContext, onSideEvent } = turn;
  const { historyForTurn, requestedLocale, blueprintSystemPrompt, maxOutputTokens, generationAttempts } = budget;
  const { logBlueprintBoundary } = run;
  const componentCapabilities = createComponentCapabilities(allowedComponentTypes);
  const ragResponse = await generateRagLessonAuthorBlueprint({
    component_capabilities: componentCapabilities,
    correlation_id: lessonAuthorCorrelationId ?? undefined,
    course_id: ctx.courseId ?? undefined,
    tenant_id: ctx.tenantId,
    kb_id: ctx.botKbId,
    conversation_id: conversationId,
    target: ctx.target,
    model: aiSettings.lessonAuthorModel,
    max_output_tokens: Math.min(maxOutputTokens, RAG_LESSON_AUTHOR_BLUEPRINT_MAX_OUTPUT_TOKENS),
    max_attempts: generationAttempts,
    embedding_model: aiSettings.embeddingModel,
    embedding_dimensions: aiSettings.embeddingDimensions,
    system_prompt: blueprintSystemPrompt ?? ctx.systemPrompt,
    user_message: trimmed,
    history: toRagChatHistory(historyForTurn.slice(0, -1)),
    source_documents: toRagSourceDocuments(sourceDocuments),
    course_context: course.outline,
    outline_context: mentionContext,
    blueprint_schema_hint: getLessonAuthorBlueprintSchemaHint(),
    locale: requestedLocale,
  });
  run.blueprintUsage = ragResponse.usage ?? null;
  run.blueprintRetrieval = ragResponse.retrieval ?? null;
  const blueprintRetrieval = run.blueprintRetrieval;
  emitRagWorkflowProgress(onSideEvent, ragResponse.workflow);
  const ragBlueprint = asRecord(ragResponse.blueprint);
  run.blueprintFailureStage = 'node_blueprint_normalization';
  logBlueprintBoundary('blueprint_python_response_received', {
    correlation_id: lessonAuthorCorrelationId, conversation_id: conversationId,
    ...blueprintBoundaryCounts(ragBlueprint),
  });
  if (JSON.stringify(readComponentCapabilities(ragBlueprint.component_capabilities)) !== JSON.stringify(componentCapabilities)) {
    throw new Error('COMPONENT_CAPABILITY_PROFILE_NOT_ACKNOWLEDGED');
  }
  const blueprint = normalizeLessonAuthorBlueprint({
    ...ragBlueprint,
    ...(ragResponse.source_map !== undefined ? { source_map: ragResponse.source_map } : {}),
  }, {
    requireContentArchitecture: true,
    requirePhaseOneContract: true,
    allowedComponentTypes,
    onComponentDecision: diagnostics => logBlueprintBoundary('blueprint_component_selection', { ...diagnostics }),
    onBoundary: (stage, value) => {
      run.blueprintFailureStage = stage;
      logBlueprintBoundary('blueprint_contract_boundary', {
        correlation_id: lessonAuthorCorrelationId, conversation_id: conversationId,
        stage, ...blueprintBoundaryCounts(value),
      });
    },
  });
  logBlueprintBoundary('blueprint_component_plan_completed', {
    correlation_id: lessonAuthorCorrelationId, conversation_id: conversationId,
    ...blueprintBoundaryCounts(blueprint),
  });
  logLessonAuthorFlow('blueprint_branch_rag_retrieval', {
    correlation_id: lessonAuthorCorrelationId,
    conversation_id: conversationId,
    kb_id: ctx.botKbId,
    retrieved_count: blueprintRetrieval?.retrieved_count ?? null,
    returned_source_count: blueprintRetrieval?.returned_source_count ?? null,
    top_score: blueprintRetrieval?.top_score ?? null,
    methods: blueprintRetrieval?.methods ?? [],
    reason: blueprintRetrieval?.reason ?? null,
    workflow: ragResponse.workflow?.workflow ?? null,
    workflow_status: ragResponse.workflow?.status ?? null,
    workflow_duration_ms: ragResponse.workflow?.duration_ms ?? null,
    workflow_repair_count: ragResponse.workflow?.repair_count ?? null,
    workflow_validation_codes: ragResponse.workflow?.validation_codes ?? [],
    workflow_objective_coverage: ragResponse.workflow?.objective_coverage ?? null,
    workflow_source_fact_coverage: ragResponse.workflow?.source_fact_coverage ?? null,
    workflow_assessment_alignment: ragResponse.workflow?.assessment_alignment ?? null,
    workflow_duplicate_count: ragResponse.workflow?.duplicate_count ?? 0,
    workflow_pedagogical_warning_count: ragResponse.workflow?.pedagogical_warning_count ?? 0,
  });
  return blueprint;
}

/** The failed Blueprint record and the failure answer. */
async function recordBlueprintFailure(
  turn: ChatTurn,
  budget: ChatTurnBudget,
  run: BlueprintRun,
  err: unknown,
  course: DraftCourseOutline | null,
): Promise<{ blueprintId: string; assistantText: string }> {
  const { conversationId, userId, trimmed, ctx, aiSettings, lessonAuthorCorrelationId, sourceDocuments } = turn;
  const { requestedLocale } = budget;
  const { logBlueprintBoundary, blueprintStartedAt } = run;
  if (err instanceof RagServiceError && err.usage) {
    run.blueprintUsage = err.usage;
  }
  const { blueprintFailureStage } = run;
  logBlueprintBoundary('blueprint_branch_rejected', {
    correlation_id: lessonAuthorCorrelationId, conversation_id: conversationId,
    failure_stage: blueprintFailureStage,
    internal_failure_code: err instanceof BlueprintAcceptanceError ? err.internal_failure_code
      : err instanceof ComponentCapabilityError || err instanceof AppError ? err.code ?? 'NODE_BLUEPRINT_BRANCH_FAILED' : 'NODE_BLUEPRINT_BRANCH_FAILED',
    ...(err instanceof BlueprintAcceptanceError ? err.diagnostics : {}),
    ...(err instanceof RagServiceError ? err.diagnostics : {}),
  });
  // Blueprint input/normalizer errors can embed private titles. Keep
  // operational codes above; never persist/log the arbitrary exception.
  const errorReason = err instanceof BlueprintAcceptanceError ? err.message
    : err instanceof ComponentCapabilityError ? err.code
      : err instanceof RagServiceError ? 'AI_RAG_BLUEPRINT_FAILED'
        : 'Không thể hoàn tất Bản thiết kế khóa học ở bước kiểm tra hoặc lưu kết quả.';
  const blueprintId = await createFailedLessonAuthorBlueprint(
    ctx,
    userId,
    trimmed,
    ctx.botKbId ?? null,
    course?.outline ?? '',
    sourceDocuments,
    aiSettings.activeEngine,
    aiSettings.lessonAuthorModel,
    errorReason,
  );
  const assistantText = formatLessonAuthorBlueprintFailurePreview(err, requestedLocale);
  logLessonAuthorFlow('blueprint_branch_failed', {
    timestamp_utc: new Date().toISOString(), duration_ms: Date.now() - blueprintStartedAt,
    failure_stage: blueprintFailureStage,
    internal_failure_code: err instanceof BlueprintAcceptanceError ? err.internal_failure_code
      : err instanceof ComponentCapabilityError || err instanceof AppError ? err.code ?? 'NODE_BLUEPRINT_BRANCH_FAILED' : 'NODE_BLUEPRINT_BRANCH_FAILED',
    external_failure_code: err instanceof AppError ? err.code ?? 'LESSON_AUTHOR_BLUEPRINT_FAILED' : 'LESSON_AUTHOR_BLUEPRINT_FAILED',
    ...(err instanceof BlueprintAcceptanceError ? err.diagnostics : {}),
    ...(err instanceof RagServiceError ? err.diagnostics : {}),
    ...(err instanceof ComponentCapabilityError ? { internal_failure_code: err.code, failure_stage: 'node_component_planner', unit_path: err.unit_path } : {}),
    correlation_id: lessonAuthorCorrelationId,
    conversation_id: conversationId,
    blueprint_id: blueprintId,
    error: errorReason,
  });
  return { blueprintId, assistantText };
}

/** The answer, the Blueprint side event, the assistant message and the settlement. */
async function sendBlueprintAnswer(turn: ChatTurn, budget: ChatTurnBudget, run: BlueprintRun, result: BlueprintResult): Promise<void> {
  const { conversationId, trimmed, ctx, aiSettings, sourceDocuments, mentionContext, sourceDocumentContext, onChunk, onDone, onSideEvent, finalizeAiReservation } = turn;
  const { requestedLocale } = budget;
  const { blueprintUsage, blueprintRetrieval } = run;
  const { blueprint, blueprintId, qualityReport, assistantText, course } = result;
  onChunk(assistantText);
  if (blueprint && blueprintId && qualityReport) {
    onSideEvent?.({
      type: 'blueprint',
      blueprint_id: blueprintId,
      blueprint,
      quality_report: qualityReport,
      locale: requestedLocale,
    });
  }

  await query(
    `INSERT INTO chat_messages (conversation_id, role, content, metadata)
     VALUES ($1, 'assistant', $2, $3)`,
    [
      conversationId,
      assistantText,
      {
        lesson_author_blueprint_id: blueprintId,
        kind: blueprint ? 'lesson_author_blueprint' : 'lesson_author_generation_failed',
        locale: requestedLocale,
        lesson_author_blueprint_status: blueprint ? 'proposed' : 'failed',
        ...(sourceDocuments.length > 0 ? { source_documents: sourceDocuments.map(toSourceDocumentMetadata) } : {}),
        ...(blueprintRetrieval ? { rag_retrieval: blueprintRetrieval } : {}),
      },
    ],
  );
  await finalizeAiReservation(
    blueprintUsage
      ? normalizeAiUsage(blueprintUsage)
      : estimateAiTurnUsage([ctx.systemPrompt, trimmed, mentionContext, sourceDocumentContext, course?.outline], assistantText),
    { service: aiSettings.activeEngine, operation: 'lesson_author' },
    {
      lesson_author_blueprint_id: blueprintId,
      source_document_count: sourceDocuments.length,
      ...(blueprintRetrieval ? { rag_retrieval: blueprintRetrieval } : {}),
    },
  );

  if (ctx.messageCount === 0) {
    const title = trimmed.slice(0, 50) + (trimmed.length > 50 ? '...' : '');
    await query(`UPDATE chat_conversations SET title = $1 WHERE id = $2`, [title, conversationId]);
  }
  onDone();
}
