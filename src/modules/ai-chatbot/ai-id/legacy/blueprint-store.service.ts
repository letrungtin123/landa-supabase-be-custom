// AI ID V1 / lesson-author legacy code, moved unchanged out of chat.service.ts.
// chat.service.ts re-exports its public symbols, so existing imports keep working.
import { projectBlueprintDraftArchitecture } from '../../lesson-author-blueprint-draft-architecture.logic.js';
import { lessonAuthorSourceSnapshotHash as createLessonAuthorBlueprintSourceSnapshotHash } from '../../lesson-author-source-snapshot.logic.js';
import { createHash } from 'crypto';
import { query } from '../../../../config/database.js';
import { AppError } from '../../../../middleware/error-handler.js';
import {
  type LessonAuthorComponentProposal,
  type LessonAuthorComponentType,
  type LessonAuthorProposal,
} from '../../../course-authoring/course-authoring.service.js';
import { type RagLessonAuthorRequest } from '../../ai-rag-client.service.js';
import {
  extractLessonAuthorTargetNumberPath,
  isLessonAuthorNewChapterDraftRequest,
  matchesLessonAuthorBlueprintChapterDraft,
} from '../../lesson-author-intent.logic.js';
import { getNextBlueprintChapterIndex } from '../../lesson-author-blueprint-sequencing.logic.js';
import { validateLessonAuthorGeneratedUnitCoverage } from '../../lesson-author-content-contract.logic.js';
import { readServerOwnedSourceFactIds } from '../../lesson-author-component-registry.logic.js';
import { swallowAndLog } from '../../../../utils/best-effort.js';
import type {
  ConversationContext,
  LessonAuthorSourceDocument,
  LessonAuthorSourceDocumentInput,
} from '../../chat.types.js';
import { logLessonAuthorFlow, isValidUUID } from '../../chat-turn-runtime.service.js';
import { asRecord } from './component-normalize.logic.js';
import { getBlueprintChapterDraftProgress, formatBlueprintDraftSequenceError } from './message-hydration.service.js';
import type {
  LessonAuthorBlueprint,
  LessonAuthorBlueprintQualityReport,
  BlueprintDraftContext,
  LessonAuthorBlueprintRow,
} from './types.js';
import {
  toSourceDocumentMetadata,
  normalizeDocumentUpdatedAt,
  validateLessonAuthorSourceDocuments,
  withAuthoritativeCourseTitle,
  foldVietnameseText,
} from './context.service.js';
import { isV4SupportingFactlessUnit, resolveV5SupportingEvidenceFactIds } from './proposal-normalize.logic.js';
import { normalizeLessonAuthorBlueprint } from './blueprint-normalize.logic.js';

export function createLessonAuthorRequestHash(
  ctx: ConversationContext,
  kbId: string | null,
  prompt: string,
  sourceDocuments: LessonAuthorSourceDocument[] = [],
  blueprintId: string | null = null,
): string {
  const sourceKey = sourceDocuments.map(doc => doc.document_id).sort().join(',');
  return createHash('sha256')
    .update([ctx.tenantId, ctx.courseId, ctx.botId, kbId ?? '', blueprintId ?? '', sourceKey, prompt.trim()].join('|'))
    .digest('hex');
}

export async function createLessonAuthorBlueprint(
  ctx: ConversationContext,
  userId: string,
  prompt: string,
  kbId: string,
  blueprint: LessonAuthorBlueprint,
  qualityReport: LessonAuthorBlueprintQualityReport,
  courseOutline: string,
  sourceDocuments: LessonAuthorSourceDocument[],
  engine: 'gemini_file_search' | 'self_built_rag',
  model: string,
  emitCreatedLog = true,
): Promise<string> {
  if (!ctx.courseId) throw new Error('courseId is required for lesson author');
  const requestHash = createLessonAuthorRequestHash(ctx, kbId, prompt, sourceDocuments);
  const sourceSnapshotHash = createLessonAuthorBlueprintSourceSnapshotHash(ctx, kbId, sourceDocuments);
  const courseOutlineHash = createHash('sha256').update(courseOutline).digest('hex');
  const sourceDocumentMetadata = sourceDocuments.map(toSourceDocumentMetadata);
  const result = await query<{ id: string }>(
    `INSERT INTO lesson_author_blueprints (
       tenant_id, course_id, conversation_id, bot_id, kb_id, requested_by,
       request_hash, prompt, blueprint, quality_report, source_documents,
       source_snapshot_hash, course_outline_hash, engine, model, status
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12, $13, $14, $15, 'proposed')
     RETURNING id`,
    [
      ctx.tenantId,
      ctx.courseId,
      ctx.conversationId,
      ctx.botId,
      kbId,
      userId,
      requestHash,
      prompt,
      JSON.stringify(blueprint),
      JSON.stringify(qualityReport),
      JSON.stringify(sourceDocumentMetadata),
      sourceSnapshotHash,
      courseOutlineHash,
      engine,
      model,
    ],
  );
  const blueprintId = result.rows[0].id;
  if (emitCreatedLog) logLessonAuthorFlow('blueprint_created', {
    conversation_id: ctx.conversationId,
    course_id: ctx.courseId,
    blueprint_id: blueprintId,
    request_hash: requestHash,
    chapters: blueprint.chapters.length,
    quality_score: qualityReport.score,
  });
  return blueprintId;
}

export async function createFailedLessonAuthorBlueprint(
  ctx: ConversationContext,
  userId: string,
  prompt: string,
  kbId: string | null,
  courseOutline: string,
  sourceDocuments: LessonAuthorSourceDocument[],
  engine: 'gemini_file_search' | 'self_built_rag',
  model: string,
  errorReason: string,
): Promise<string> {
  if (!ctx.courseId) throw new Error('courseId is required for lesson author');
  const requestHash = createLessonAuthorRequestHash(ctx, kbId, prompt, sourceDocuments);
  const sourceSnapshotHash = createLessonAuthorBlueprintSourceSnapshotHash(ctx, kbId ?? '', sourceDocuments);
  const courseOutlineHash = createHash('sha256').update(courseOutline).digest('hex');
  const result = await query<{ id: string }>(
    `INSERT INTO lesson_author_blueprints (
       tenant_id, course_id, conversation_id, bot_id, kb_id, requested_by,
       request_hash, prompt, blueprint, quality_report, source_documents,
       source_snapshot_hash, course_outline_hash, engine, model, status, error_reason
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '{}'::jsonb, '{}'::jsonb, $9::jsonb, $10, $11, $12, $13, 'failed', $14)
     RETURNING id`,
    [
      ctx.tenantId,
      ctx.courseId,
      ctx.conversationId,
      ctx.botId,
      kbId,
      userId,
      requestHash,
      prompt,
      JSON.stringify(sourceDocuments.map(toSourceDocumentMetadata)),
      sourceSnapshotHash,
      courseOutlineHash,
      engine,
      model,
      errorReason,
    ],
  );
  return result.rows[0].id;
}

function hasDraftableBlueprintArchitecture(blueprint: LessonAuthorBlueprint): boolean {
  return blueprint.chapters.every(chapter => chapter.lessons.every(lesson => (
    lesson.units.length > 0
    && lesson.units.every(unit => isV4SupportingFactlessUnit(blueprint.architecture_contract_version, unit)
      ? blueprint.architecture_contract_version !== 5
        || (resolveV5SupportingEvidenceFactIds(blueprint, unit).length > 0
          && unit.component_plan.length > 0
          && unit.component_plan.some(plan => plan.type === 'html'))
      : (unit.component_plan.length > 0
        && unit.component_plan.some(plan => plan.type === 'html')
        && (unit.source_fact_ids?.length ?? 0) > 0))
  )));
}

async function markLessonAuthorBlueprintSuperseded(
  blueprintId: string,
  tenantId: string,
  reason: string,
): Promise<void> {
  await query(
    `UPDATE lesson_author_blueprints
     SET status = 'superseded', error_reason = $3, updated_at = now()
     WHERE id = $1 AND tenant_id = $2 AND status = 'proposed'`,
    [blueprintId, tenantId, reason.slice(0, 1000)],
  );
}

function getBlueprintSourceDocumentInputs(value: unknown): LessonAuthorSourceDocumentInput[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is LessonAuthorSourceDocumentInput => (
    Boolean(item) && typeof item === 'object' && !Array.isArray(item)
  ));
}

function getStoredSourceUpdatedAtByDocument(value: unknown): Map<string, string> {
  const revisions = new Map<string, string>();
  for (const source of getBlueprintSourceDocumentInputs(value)) {
    const documentId = typeof source.document_id === 'string' ? source.document_id : source.id;
    const updatedAt = (source as unknown as Record<string, unknown>).updated_at;
    if (typeof documentId === 'string' && updatedAt) {
      revisions.set(documentId, normalizeDocumentUpdatedAt(updatedAt));
    }
  }
  return revisions;
}

export async function loadLessonAuthorBlueprintForDraft(
  ctx: ConversationContext,
  blueprintId: string,
  chapterIndex: number,
  requireGeminiMapping: boolean,
  locale: 'vi' | 'en',
): Promise<BlueprintDraftContext> {
  if (!ctx.courseId) throw new Error('courseId is required for lesson author');
  if (!ctx.botKbId) throw new AppError('Chưa cấu hình KB active cho chuyên gia tạo bài học.', 409);
  if (!isValidUUID(blueprintId)) throw new AppError('Blueprint ID không hợp lệ.', 400);
  const result = await query<LessonAuthorBlueprintRow>(
    `SELECT id, tenant_id, course_id, status, blueprint, quality_report,
            (SELECT message.metadata ->> 'locale'
             FROM chat_messages message
             WHERE message.conversation_id = lesson_author_blueprints.conversation_id
               AND message.role = 'assistant'
               AND message.metadata ->> 'kind' = 'lesson_author_blueprint'
               AND message.metadata ->> 'lesson_author_blueprint_id' = lesson_author_blueprints.id::text
               AND message.metadata ->> 'locale' IN ('vi', 'en')
             ORDER BY message.created_at ASC, message.id ASC LIMIT 1) AS output_locale,
            kb_id, source_documents, source_snapshot_hash, course_outline_hash
     FROM lesson_author_blueprints
     WHERE id = $1
       AND tenant_id = $2
       AND course_id = $3
       AND kb_id = $4
       AND status = 'proposed'
     LIMIT 1`,
    [blueprintId, ctx.tenantId, ctx.courseId, ctx.botKbId],
  );
  if (!result.rowCount) {
    throw new AppError('Bản thiết kế khóa học không còn khả dụng, không thuộc KB hiện tại, hoặc không thuộc khóa học hiện tại.', 409);
  }
  const stored = result.rows[0];
  let sourceDocuments: LessonAuthorSourceDocument[];
  try {
    sourceDocuments = await validateLessonAuthorSourceDocuments(
      ctx,
      ctx.botKbId,
      getBlueprintSourceDocumentInputs(stored.source_documents),
      { requireGeminiMapping },
    );
  } catch {
    const reason = 'Tài liệu nguồn của bản thiết kế đã thay đổi, bị xóa, hoặc chưa sẵn sàng. Vui lòng tạo lại bản thiết kế khóa học.';
    await markLessonAuthorBlueprintSuperseded(stored.id, ctx.tenantId, reason).catch(swallowAndLog('lesson_author.blueprint_supersede'));
    throw new AppError(reason, 409);
  }

  const storedRevisions = getStoredSourceUpdatedAtByDocument(stored.source_documents);
  const hasChangedSource = sourceDocuments.some((document) => {
    const storedUpdatedAt = storedRevisions.get(document.document_id);
    return Boolean(storedUpdatedAt && storedUpdatedAt !== document.updated_at);
  });
  if (hasChangedSource) {
    const reason = 'Tài liệu nguồn của bản thiết kế đã được cập nhật. Vui lòng tạo lại bản thiết kế khóa học trước khi soạn chi tiết.';
    await markLessonAuthorBlueprintSuperseded(stored.id, ctx.tenantId, reason);
    throw new AppError(reason, 409);
  }

  const courseResult = await query<{ display_name: string }>(
    `SELECT COALESCE(course_block.display_name, c.display_name) AS display_name
     FROM courses c
     LEFT JOIN LATERAL (
       SELECT cb.display_name
       FROM course_blocks cb
       WHERE cb.course_id = c.id
         AND cb.block_type = 'course'
         AND cb.deleted_at IS NULL
       ORDER BY cb.sort_order ASC, cb.created_at ASC
       LIMIT 1
     ) course_block ON true
      WHERE c.id = $1
        AND c.tenant_id = $2
       AND c.deleted_at IS NULL
     LIMIT 1`,
    [ctx.courseId, ctx.tenantId],
  );
  const blueprint = withAuthoritativeCourseTitle(
    normalizeLessonAuthorBlueprint(stored.blueprint),
    courseResult.rows[0]?.display_name ?? '',
  );
  if (!hasDraftableBlueprintArchitecture(blueprint)) {
    throw new AppError(
      locale === 'en'
        ? 'This course blueprint was created before the content architecture was available. Generate a new course blueprint before drafting chapters.'
        : 'Bản thiết kế này được tạo trước khi có kiến trúc học liệu. Hãy tạo lại Bản thiết kế khóa học trước khi soạn chương.',
      409,
      'LESSON_AUTHOR_BLUEPRINT_ARCHITECTURE_REQUIRED',
    );
  }
  const requestedChapterIndex = Math.floor(chapterIndex);
  if (
    !Number.isInteger(chapterIndex)
    || !Number.isFinite(chapterIndex)
    || requestedChapterIndex < 0
    || requestedChapterIndex >= blueprint.chapters.length
  ) {
    throw new AppError('Chương trong bản thiết kế không còn hợp lệ. Vui lòng mở lại bản thiết kế và thử lại.', 409);
  }

  const draftProgress = await getBlueprintChapterDraftProgress(ctx, stored.id);
  const nextChapterIndex = getNextBlueprintChapterIndex(blueprint.chapters.length, draftProgress.applied);
  const currentChapterPending = nextChapterIndex !== null && draftProgress.pending.has(nextChapterIndex);
  if (requestedChapterIndex !== nextChapterIndex || currentChapterPending) {
    throw new AppError(
      formatBlueprintDraftSequenceError(locale, nextChapterIndex, requestedChapterIndex, currentChapterPending),
      409,
      'LESSON_AUTHOR_BLUEPRINT_CHAPTER_SEQUENCE',
    );
  }
  return { id: stored.id, chapterIndex: requestedChapterIndex, blueprint, sourceDocuments,
    ...(stored.output_locale === 'vi' || stored.output_locale === 'en' ? { outputLocale: stored.output_locale } : {}),
  };
}

export async function tryLoadMatchingLessonAuthorBlueprintDraft(
  ctx: ConversationContext,
  prompt: string,
  requireGeminiMapping: boolean,
  locale: 'vi' | 'en',
): Promise<BlueprintDraftContext | null> {
  if (!ctx.courseId || !ctx.botKbId || !isLessonAuthorNewChapterDraftRequest(prompt)) return null;
  const chapterPath = extractLessonAuthorTargetNumberPath(prompt, 'chapter');
  const chapterIndex = chapterPath ? Number(chapterPath) - 1 : Number.NaN;
  if (!Number.isInteger(chapterIndex) || chapterIndex < 0) return null;

  const candidates = await query<{ id: string; blueprint: LessonAuthorBlueprint }>(
    `SELECT id, blueprint
     FROM lesson_author_blueprints
     WHERE tenant_id = $1
       AND course_id = $2
       AND conversation_id = $3
       AND kb_id = $4
       AND status = 'proposed'
     ORDER BY updated_at DESC, created_at DESC
     LIMIT 5`,
    [ctx.tenantId, ctx.courseId, ctx.conversationId, ctx.botKbId],
  );

  for (const candidate of candidates.rows) {
    let blueprint: LessonAuthorBlueprint;
    try {
      blueprint = normalizeLessonAuthorBlueprint(candidate.blueprint);
    } catch {
      continue;
    }
    const chapter = blueprint.chapters[chapterIndex];
    if (!chapter || !matchesLessonAuthorBlueprintChapterDraft(prompt, chapterIndex, chapter.title)) continue;

    // The canonical loader revalidates source revisions and the next-chapter
    // sequence before this manually-entered command can reach generation.
    return loadLessonAuthorBlueprintForDraft(ctx, candidate.id, chapterIndex, requireGeminiMapping, locale);
  }
  return null;
}

export function formatBlueprintDraftContext(context: BlueprintDraftContext): string {
  const chapter = context.blueprint.chapters[context.chapterIndex];
  const architecture = {
    chapter_title: chapter.title,
    source_refs: chapter.source_refs ?? [],
    lessons: chapter.lessons.map((lesson) => ({
      title: lesson.title,
      source_refs: lesson.source_refs ?? [],
      learning_objectives: lesson.learning_objectives ?? [],
      primary_concept_ids: lesson.primary_concept_ids ?? [],
      supporting_concept_ids: lesson.supporting_concept_ids ?? [],
      assessment_required: lesson.assessment_required === true,
      assessment_objective_refs: lesson.assessment_objective_refs ?? [],
      units: lesson.units.map((unit) => ({
        title: unit.title,
        purpose: unit.purpose ?? '',
        concept_ids: unit.concept_ids ?? [],
        primary_concept_ids: unit.primary_concept_ids ?? [],
        primary_evidence_scope_ids: unit.primary_evidence_scope_ids ?? [],
        supporting_evidence_scope_ids: unit.supporting_evidence_scope_ids ?? [],
        learning_objective_refs: unit.learning_objective_refs ?? [],
        source_refs: unit.source_refs ?? [],
        source_fact_ids: unit.source_fact_ids ?? [],
        supporting_evidence_fact_ids: unit.supporting_evidence_fact_ids ?? [],
        learning_blocks: unit.learning_blocks ?? [],
        component_plan: unit.component_plan.map((plan) => ({
          type: plan.type,
          title: plan.title,
          rationale: plan.rationale,
          purpose: plan.purpose,
          source_fact_ids: plan.source_fact_ids ?? [],
          supporting_evidence_fact_ids: plan.supporting_evidence_fact_ids ?? [],
          content_requirements: plan.content_requirements ?? [],
          reason_code: plan.reason_code,
          learning_block_ids: plan.learning_block_ids ?? [],
          required_artifacts: plan.required_artifacts ?? [],
        })),
      })),
    })),
  };
  return [
    `Approved course blueprint: ${context.blueprint.title}`,
    `Target audience: ${context.blueprint.target_audience}`,
    `Course learning outcomes: ${context.blueprint.learning_outcomes.map((outcome, index) => `${index + 1}. ${outcome}`).join(' | ')}`,
    `Assessment strategy: ${context.blueprint.assessment_strategy}`,
    `HARD SCOPE LIMIT: Generate detailed content for Blueprint Chapter ${context.chapterIndex + 1} only: ${chapter.title}.`,
    chapter.source_refs?.length ? `Chapter source references: ${chapter.source_refs.join(', ')}` : '',
    `Chapter objective: ${chapter.objective}`,
    `Blueprint lessons: ${chapter.lessons.map((lesson, index) => `${index + 1}. ${lesson.title} (${lesson.objective}${lesson.source_refs?.length ? `; sources ${lesson.source_refs.join(', ')}` : ''})`).join(' | ')}`,
    `LOCKED CONTENT ARCHITECTURE: ${JSON.stringify(architecture)}`,
    'Do not generate other Blueprint chapters. Preserve the exact chapter, lesson, unit, and component-plan topology. Do not add, remove, reorder, or substitute component types.',
  ].join('\n');
}

function blueprintStructureKey(value: string): string {
  return foldVietnameseText(value)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function blueprintDraftArchitecture(
  context: BlueprintDraftContext,
): NonNullable<RagLessonAuthorRequest['blueprint_architecture']> {
  return projectBlueprintDraftArchitecture(context.blueprint, context.chapterIndex);
}

function readGeneratedComponentContentContract(
  component: LessonAuthorComponentProposal,
): {
  component_plan_id?: string;
  type: LessonAuthorComponentType;
  source_fact_ids: string[];
  covered_source_fact_ids: string[];
  supporting_evidence_fact_ids: string[];
  html?: string;
  data?: unknown;
} {
  const metadata = asRecord(component.metadata);
  return {
    ...(typeof metadata.component_plan_id === 'string' ? { component_plan_id: metadata.component_plan_id } : {}),
    type: component.type,
    source_fact_ids: readServerOwnedSourceFactIds(metadata.source_fact_ids),
    covered_source_fact_ids: readServerOwnedSourceFactIds(metadata.covered_source_fact_ids),
    supporting_evidence_fact_ids: readServerOwnedSourceFactIds(metadata.supporting_evidence_fact_ids),
    ...(component.type === 'html' && typeof component.data === 'string' ? { html: component.data } : {}),
    data: component.data,
  };
}

function requiresPhaseOneContentContract(blueprint: LessonAuthorBlueprint): boolean {
  return blueprint.content_contract_version === 1;
}

export function lockProposalToBlueprintChapter(
  proposal: LessonAuthorProposal,
  context: BlueprintDraftContext,
): LessonAuthorProposal {
  const authoritativeChapter = context.blueprint.chapters[context.chapterIndex];
  const { operation_plan: _ignoredOperationPlan, ...proposalWithoutOperationPlan } = proposal;
  if (!authoritativeChapter || proposal.chapters.length !== 1) {
    throw new Error('Detailed proposal does not match the approved Blueprint chapter scope.');
  }
  const generatedChapter = proposal.chapters[0];
  if (generatedChapter.lessons.length !== authoritativeChapter.lessons.length) {
    throw new Error('Detailed proposal does not match the approved Blueprint lesson structure.');
  }

  const lessons = generatedChapter.lessons.map((lesson, lessonIndex) => {
    const expectedLesson = authoritativeChapter.lessons[lessonIndex];
    if (blueprintStructureKey(lesson.title) !== blueprintStructureKey(expectedLesson.title)) {
      throw new Error(`Detailed proposal changed Blueprint lesson ${lessonIndex + 1}.`);
    }
    if (lesson.units.length !== expectedLesson.units.length) {
      throw new Error(`Detailed proposal does not match the approved units for Blueprint lesson ${lessonIndex + 1}.`);
    }
    const units = lesson.units.map((unit, unitIndex) => {
      const expectedUnit = expectedLesson.units[unitIndex];
      if (blueprintStructureKey(unit.title) !== blueprintStructureKey(expectedUnit.title)) {
        throw new Error(`Detailed proposal changed Blueprint unit ${lessonIndex + 1}.${unitIndex + 1}.`);
      }
      const actualTypes = (unit.components ?? []).map(component => component.type);
      const expectedTypes = expectedUnit.component_plan.map(plan => plan.type);
      const supportingFactless = isV4SupportingFactlessUnit(
        context.blueprint.architecture_contract_version,
        expectedUnit,
      );
      if (supportingFactless) {
        if ((expectedUnit.supporting_evidence_fact_ids?.length ?? 0) === 0) {
          throw new Error(`Supporting Blueprint unit ${lessonIndex + 1}.${unitIndex + 1} has no resolved read-only evidence.`);
        }
        if ((unit.source_fact_ids?.length ?? 0) !== 0) {
          throw new Error(`Supporting Blueprint unit ${lessonIndex + 1}.${unitIndex + 1} must not claim canonical source facts.`);
        }
      }
      if (
        actualTypes.length !== expectedTypes.length
        || actualTypes.some((type, componentIndex) => type !== expectedTypes[componentIndex])
      ) {
        throw new Error(`Detailed proposal changed the approved component plan for Blueprint unit ${lessonIndex + 1}.${unitIndex + 1}.`);
      }
      const expectedFactIds = expectedUnit.source_fact_ids ?? [];
      const actualFactIds = unit.source_fact_ids ?? [];
      if (
        expectedFactIds.length !== actualFactIds.length
        || expectedFactIds.some(factId => !actualFactIds.includes(factId))
      ) {
        throw new Error(`Detailed proposal does not match the approved source coverage for Blueprint unit ${lessonIndex + 1}.${unitIndex + 1}.`);
      }
      if (requiresPhaseOneContentContract(context.blueprint)) {
        const failure = validateLessonAuthorGeneratedUnitCoverage(
          {
            source_fact_ids: expectedFactIds,
            supporting_evidence_fact_ids: expectedUnit.supporting_evidence_fact_ids,
            component_plan: expectedUnit.component_plan,
          },
          (unit.components ?? []).map(readGeneratedComponentContentContract),
        );
        if (failure) {
          throw new Error(`Detailed proposal violates the Phase-1 content contract for Blueprint unit ${lessonIndex + 1}.${unitIndex + 1}: ${failure}`);
        }
      }
      return {
        ...unit,
        title: expectedUnit.title,
        source_refs: expectedUnit.source_refs?.length ? expectedUnit.source_refs : unit.source_refs,
        source_fact_ids: expectedFactIds,
        ...(expectedUnit.supporting_evidence_fact_ids?.length ? { supporting_evidence_fact_ids: expectedUnit.supporting_evidence_fact_ids } : {}),
        component_plan: expectedUnit.component_plan.map(plan => ({
          component_plan_id: plan.component_plan_id,
          learning_objective_refs: plan.learning_objective_refs,
          type: plan.type,
          title: plan.title,
          rationale: plan.rationale,
          purpose: plan.purpose,
          source_fact_ids: plan.source_fact_ids ?? expectedFactIds,
          ...(plan.supporting_evidence_fact_ids?.length ? { supporting_evidence_fact_ids: plan.supporting_evidence_fact_ids } : {}),
          content_requirements: plan.content_requirements ?? [],
          ...(plan.reason_code ? { reason_code: plan.reason_code } : {}),
          ...(plan.learning_block_ids?.length ? { learning_block_ids: plan.learning_block_ids } : {}),
          ...(plan.required_artifacts?.length ? { required_artifacts: plan.required_artifacts } : {}),
        })),
      };
    });
    return {
      ...lesson,
      title: expectedLesson.title,
      source_refs: expectedLesson.source_refs?.length ? expectedLesson.source_refs : lesson.source_refs,
      units,
    };
  });

  return {
    ...proposalWithoutOperationPlan,
    chapters: [{
      ...generatedChapter,
      title: authoritativeChapter.title,
      source_refs: authoritativeChapter.source_refs?.length ? authoritativeChapter.source_refs : generatedChapter.source_refs,
      lessons,
    }],
  };
}
