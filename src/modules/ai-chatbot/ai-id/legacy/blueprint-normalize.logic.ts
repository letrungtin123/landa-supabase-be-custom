// AI ID V1 / lesson-author legacy code, moved unchanged out of chat.service.ts.
// chat.service.ts re-exports its public symbols, so existing imports keep working.
import { assertComponentInstancePlan, readComponentCapabilities } from '../content/lesson-author-capabilities.logic.js';
import { AppError } from '../../../../middleware/error-handler.js';
import { type CourseComponentType } from '../../../tenants/tenant-course-components.constants.js';
import { type RagRetrievalDiagnostics } from '../../ai-platform/ai-rag-client.service.js';
import { stripLessonAuthorSourceRangeSuffix } from '../shared/lesson-author-intent.logic.js';
import { getLessonAuthorBlueprintReviewNotes } from '../v1/lesson-author-blueprint-quality.logic.js';
import {
  normalizeSemanticLearningBlocks,
  readServerOwnedSourceFactIds,
  type ComponentPlannerDiagnostic,
} from '../content/lesson-author-component-registry.logic.js';
import {
  normalizeLessonAuthorSourceMap,
  normalizeSourceChapterPolicy,
  type BlueprintArchitectureValidationResult,
} from '../v1/lesson-author-blueprint-validator.logic.js';
import {
  MAX_BLUEPRINT_CHAPTERS,
  MAX_COMPACT_BLUEPRINT_LESSONS_PER_CHAPTER,
  MAX_BLUEPRINT_LESSONS_PER_CHAPTER,
  MAX_COMPACT_BLUEPRINT_UNITS_PER_LESSON,
  MAX_COMPACT_BLUEPRINT_COMPONENTS_PER_UNIT,
  MAX_BLUEPRINT_LEARNING_OUTCOMES,
  MAX_COMPACT_BLUEPRINT_TOTAL_LESSONS,
  MAX_COMPACT_BLUEPRINT_TOTAL_UNITS,
  MAX_COMPACT_BLUEPRINT_TOTAL_COMPONENTS,
  MAX_COMPACT_BLUEPRINT_MEDIA_PLANS,
  MAX_BLUEPRINT_ASSUMPTIONS,
} from './constants.js';
import {
  asRecord,
  readString,
  readStringArray,
  normalizeLessonAuthorTitle,
  normalizeLessonAuthorComponentPlan,
  componentTypeLabel,
  readCanonicalBlueprintIds,
} from './component-normalize.logic.js';
import type {
  LessonAuthorBlueprint,
  LessonAuthorBlueprintChapter,
  LessonAuthorBlueprintLesson,
  LessonAuthorBlueprintUnit,
  LessonAuthorBlueprintComponentPlan,
  LessonAuthorBlueprintMediaPlan,
  LessonAuthorBlueprintQualityReport,
} from './types.js';
import {
  normalizeLessonAuthorSourceFactAllocation,
  normalizeLessonAuthorSourceEvidenceScopeAllocation,
  readLocalLearningObjectiveRefs,
  assertLocalLearningObjectiveRefs,
  normalizeLessonAuthorMediaReview,
  applyPhaseOneContentContract,
  isV4SupportingFactlessUnit,
  resolveV5SupportingEvidenceFactIds,
} from './proposal-normalize.logic.js';

export function normalizeLessonAuthorBlueprint(
  rawValue: unknown,
  options: {
    requireContentArchitecture?: boolean;
    requirePhaseOneContract?: boolean;
    allowedComponentTypes?: ReadonlySet<CourseComponentType>;
    onBoundary?: (stage: 'node_blueprint_normalization' | 'node_component_planner', value: unknown) => void;
    onComponentDecision?: (diagnostics: ComponentPlannerDiagnostic) => void;
  } = {},
): LessonAuthorBlueprint {
  const raw = asRecord(rawValue);
  let sourceChapterPolicy: LessonAuthorBlueprint['source_chapter_policy'];
  try {
    sourceChapterPolicy = normalizeSourceChapterPolicy(raw.source_chapter_policy);
  } catch {
    throw new AppError('Blueprint source chapter policy is invalid.', 422, 'SOURCE_CHAPTER_POLICY_INVALID');
  }
  const architectureContractVersion = raw.architecture_contract_version === 3 || raw.architecture_contract_version === 4 || raw.architecture_contract_version === 5
    ? raw.architecture_contract_version
    : undefined;
  const sourceFactAllocation = normalizeLessonAuthorSourceFactAllocation(raw.source_fact_allocation);
  const sourceEvidenceScopeAllocation = normalizeLessonAuthorSourceEvidenceScopeAllocation(raw.source_evidence_scope_allocation);
  if (architectureContractVersion === 4
    && (!sourceFactAllocation || sourceFactAllocation.version !== 'source-fact-allocation-v2')) {
    throw new Error('Blueprint v4 requires server-owned Source Fact allocation metadata');
  }
  if (architectureContractVersion === 5
    && (!sourceFactAllocation || sourceFactAllocation.version !== 'source-fact-allocation-v3'
      || !sourceEvidenceScopeAllocation || sourceEvidenceScopeAllocation.version !== 'source-evidence-scope-allocation-v1')) {
    throw new Error('Blueprint v5 requires server-owned evidence-scope and Source Fact allocation metadata');
  }
  const rawChapters = Array.isArray(raw.chapters) ? raw.chapters : [];
  if (rawChapters.length === 0) throw new Error('AI blueprint must contain at least one chapter');
  if (rawChapters.length > MAX_BLUEPRINT_CHAPTERS) {
    throw new AppError(`AI blueprint vượt quá giới hạn ${MAX_BLUEPRINT_CHAPTERS} chương. Hãy thu gọn cấu trúc khóa học trước khi duyệt.`, 400);
  }

  const chapters = rawChapters.map((chapterValue, chapterIndex): LessonAuthorBlueprintChapter => {
    const chapter = asRecord(chapterValue);
    const title = stripLessonAuthorSourceRangeSuffix(
      readString(chapter.title, `Chương ${chapterIndex + 1}`, 250),
    ).slice(0, 180);
    const rawLessons = Array.isArray(chapter.lessons) ? chapter.lessons : [];
    if (rawLessons.length === 0) {
      throw new Error(`Blueprint chapter ${chapterIndex + 1} must contain lessons`);
    }
    const lessonLimit = options.requireContentArchitecture
      ? MAX_COMPACT_BLUEPRINT_LESSONS_PER_CHAPTER
      : MAX_BLUEPRINT_LESSONS_PER_CHAPTER;
    if (rawLessons.length > lessonLimit) {
      throw new Error(`Blueprint chapter ${chapterIndex + 1} exceeds ${lessonLimit} lessons`);
    }

    const lessons = rawLessons.map((lessonValue, lessonIndex): LessonAuthorBlueprintLesson => {
      const lesson = asRecord(lessonValue);
      const lessonTitle = stripLessonAuthorSourceRangeSuffix(
        readString(lesson.title, `Bài học ${lessonIndex + 1}`, 250),
      ).slice(0, 180);
      const activities = readStringArray(
        lesson.learning_activities ?? lesson.activities,
        5,
        280,
      );
      const rawUnits = Array.isArray(lesson.units) ? lesson.units : [];
      if (options.requireContentArchitecture && rawUnits.length === 0) {
        throw new Error(`Blueprint lesson ${chapterIndex + 1}.${lessonIndex + 1} must contain draftable units`);
      }
      const unitLimit = options.requireContentArchitecture
        ? MAX_COMPACT_BLUEPRINT_UNITS_PER_LESSON
        : 8;
      if (rawUnits.length > unitLimit) {
        throw new Error(`Blueprint lesson ${chapterIndex + 1}.${lessonIndex + 1} exceeds ${unitLimit} units`);
      }
      const units = rawUnits.map((unitValue, unitIndex): LessonAuthorBlueprintUnit => {
        const unit = asRecord(unitValue);
        const unitTitle = normalizeLessonAuthorTitle(
          unit.title,
          'unit',
          `Bài học ${lessonIndex + 1}.${unitIndex + 1}`,
        );
        const componentPlan = normalizeLessonAuthorComponentPlan(
          unit.component_plan ?? unit.components ?? unit.planned_components,
        ).map((plan): LessonAuthorBlueprintComponentPlan => ({
          component_plan_id: plan.component_plan_id,
          learning_objective_refs: plan.learning_objective_refs,
          type: plan.type,
          title: readString(
            plan.title,
            componentTypeLabel(plan.type, 'vi'),
            180,
          ),
          rationale: readString(
            plan.rationale,
            `Học liệu hỗ trợ mục tiêu của ${unitTitle}.`,
            240,
          ),
          ...(plan.purpose ? { purpose: plan.purpose } : {}),
          ...(plan.component_plan_id || plan.source_fact_ids?.length ? { source_fact_ids: plan.source_fact_ids ?? [] } : {}),
          ...(plan.supporting_evidence_fact_ids?.length ? { supporting_evidence_fact_ids: plan.supporting_evidence_fact_ids } : {}),
          ...(plan.content_requirements?.length ? { content_requirements: plan.content_requirements } : {}),
          ...(plan.reason_code ? { reason_code: plan.reason_code } : {}),
          ...(plan.learning_block_ids?.length ? { learning_block_ids: plan.learning_block_ids } : {}),
          ...(plan.required_artifacts?.length ? { required_artifacts: plan.required_artifacts } : {}),
        }));
        if (raw.component_capabilities && componentPlan.length) assertComponentInstancePlan(componentPlan);
        if (options.requireContentArchitecture && componentPlan.length > (raw.component_capabilities ? 4 : MAX_COMPACT_BLUEPRINT_COMPONENTS_PER_UNIT)) {
          throw new Error(`Blueprint unit ${chapterIndex + 1}.${lessonIndex + 1}.${unitIndex + 1} exceeds ${MAX_COMPACT_BLUEPRINT_COMPONENTS_PER_UNIT} component plans`);
        }
        // A v4 Blueprint's canonical allocation is server-owned. Never use a
        // display-oriented truncating normalizer for valid provenance IDs.
        const sourceFactIds = readServerOwnedSourceFactIds(unit.source_fact_ids);
        if (architectureContractVersion === 5) {
          const rawBlocks = unit.learning_blocks ?? unit.semantic_learning_blocks;
          if (!Array.isArray(rawBlocks) || rawBlocks.length > 12) throw new AppError('Blueprint learning block cardinality is invalid.', 422, 'V5_LEARNING_BLOCK_CARDINALITY_INVALID');
          const refs = unit.learning_objective_refs;
          if (!Array.isArray(refs) || refs.length === 0 || refs.some(ref => typeof ref !== 'string')
            || new Set(refs.map(ref => String(ref).trim())).size !== refs.length) {
            throw new AppError('Blueprint unit objective references are invalid.', 422, 'V5_UNIT_OBJECTIVE_REFS_INVALID');
          }
        }
        const learningBlocks = normalizeSemanticLearningBlocks(
          unit.learning_blocks ?? unit.semantic_learning_blocks,
          sourceFactIds,
          { strictLocalObjectiveRefs: architectureContractVersion === 4 || architectureContractVersion === 5 },
        );
        if (options.requireContentArchitecture && componentPlan.length === 0 && learningBlocks.length === 0) {
          throw new Error(`Blueprint unit ${chapterIndex + 1}.${lessonIndex + 1}.${unitIndex + 1} must contain semantic learning blocks or a legacy component plan`);
        }
        const rawMediaPlan = unit.media_plan ?? unit.media_suggestion ?? unit.media;
        let mediaPlan: LessonAuthorBlueprintMediaPlan | undefined;
        if (rawMediaPlan !== undefined && rawMediaPlan !== null) {
          const media = asRecord(rawMediaPlan);
          const mediaType = readString(media.type ?? media.media_type ?? media.format, '', 40).toLowerCase();
          if (mediaType !== 'video' && mediaType !== 'static_infographic') {
            throw new Error(`Blueprint unit ${chapterIndex + 1}.${lessonIndex + 1}.${unitIndex + 1} has an unsupported media plan`);
          }
          const contentOutline = readString(media.content_outline ?? media.content ?? media.description, '', 600);
          if (!contentOutline) {
            throw new Error(`Blueprint unit ${chapterIndex + 1}.${lessonIndex + 1}.${unitIndex + 1} media plan needs a content outline`);
          }
          mediaPlan = {
            type: mediaType,
            title: readString(media.title ?? media.label ?? media.name, '', 180),
            content_outline: contentOutline,
            rationale: readString(media.rationale ?? media.reason, '', 240),
          };
          if (!mediaPlan.title || !mediaPlan.rationale) {
            throw new Error(`Blueprint unit ${chapterIndex + 1}.${lessonIndex + 1}.${unitIndex + 1} media plan is incomplete`);
          }
          if (media.brief_version === 2) {
            if (!Array.isArray(media.content_points) || media.content_points.length < 1 || media.content_points.length > 6
              || media.content_points.some(p => typeof p !== 'string' || !p.trim() || p.length > 500)
              || typeof media.context_description !== 'string' || !media.context_description.trim() || media.context_description.length > 1000) {
              throw new Error('Structured media brief has invalid points or context');
            }
            Object.assign(mediaPlan, { brief_version: 2, content_points: media.content_points, context_description: media.context_description,
              evidence_language: 'original', content_basis: 'SOURCE_EXCERPTS' });
          }
        }
        const unitLearningObjectiveRefs = architectureContractVersion === 4 || architectureContractVersion === 5
          ? readLocalLearningObjectiveRefs(unit.learning_objective_refs, 24)
          : readStringArray(unit.learning_objective_refs, 24, 96);
        const unitConceptIds = readCanonicalBlueprintIds(unit.concept_ids, 24);
        const unitPrimaryConceptIds = readCanonicalBlueprintIds(unit.primary_concept_ids, 24);
        const unitPrimaryEvidenceScopeIds = readCanonicalBlueprintIds(unit.primary_evidence_scope_ids, 12);
        const unitSupportingEvidenceScopeIds = readCanonicalBlueprintIds(unit.supporting_evidence_scope_ids, 12);
        const unitSourceRefs = readCanonicalBlueprintIds(unit.source_refs, 8);
        return {
          title: unitTitle,
          component_plan: componentPlan,
          ...(readString(unit.purpose, '', 300) ? { purpose: readString(unit.purpose, '', 300) } : {}),
          ...(unitConceptIds.length > 0 ? { concept_ids: unitConceptIds } : {}),
          ...(unitPrimaryConceptIds.length > 0 ? { primary_concept_ids: unitPrimaryConceptIds } : {}),
          ...(unitPrimaryEvidenceScopeIds.length > 0 ? { primary_evidence_scope_ids: unitPrimaryEvidenceScopeIds } : {}),
          ...(unitSupportingEvidenceScopeIds.length > 0 ? { supporting_evidence_scope_ids: unitSupportingEvidenceScopeIds } : {}),
          ...(unitLearningObjectiveRefs.length > 0 ? { learning_objective_refs: unitLearningObjectiveRefs } : {}),
          source_refs: unitSourceRefs,
          source_fact_ids: sourceFactIds,
          ...(raw.component_capabilities ? { supporting_evidence_fact_ids: readServerOwnedSourceFactIds(unit.supporting_evidence_fact_ids) } : {}),
          ...(learningBlocks.length > 0 ? { learning_blocks: learningBlocks } : {}),
          ...(mediaPlan ? { media_plan: mediaPlan } : {}),
        };
      });
      const legacyUnits = units.length > 0
        ? units
        : activities.map((activity, activityIndex) => ({
          title: normalizeLessonAuthorTitle(activity, 'unit', `Bài học ${lessonIndex + 1}.${activityIndex + 1}`),
          component_plan: [],
          source_refs: readStringArray(lesson.source_refs, 8, 32),
        }));
      const lessonLearningObjectives = readStringArray(lesson.learning_objectives, 8, 500);
      const assessmentObjectiveRefs = architectureContractVersion === 4 || architectureContractVersion === 5
        ? readLocalLearningObjectiveRefs(lesson.assessment_objective_refs, 8)
        : readStringArray(lesson.assessment_objective_refs, 8, 96);
      if (architectureContractVersion === 4 || architectureContractVersion === 5) {
        units.forEach((unit, unitIndex) => {
          assertLocalLearningObjectiveRefs(
            unit.learning_objective_refs ?? [],
            lessonLearningObjectives.length,
            `Blueprint unit ${chapterIndex + 1}.${lessonIndex + 1}.${unitIndex + 1}`,
          );
          (unit.learning_blocks ?? []).forEach((block, blockIndex) => {
            assertLocalLearningObjectiveRefs(
              block.learning_objective_refs ?? [],
              lessonLearningObjectives.length,
              `Blueprint learning block ${chapterIndex + 1}.${lessonIndex + 1}.${unitIndex + 1}.${blockIndex + 1}`,
            );
          });
        });
        assertLocalLearningObjectiveRefs(
          assessmentObjectiveRefs,
          lessonLearningObjectives.length,
          `Blueprint lesson ${chapterIndex + 1}.${lessonIndex + 1}`,
        );
      }
      return {
        title: lessonTitle,
        objective: readString(
          lesson.objective,
          `Người học có thể vận dụng nội dung chính của ${lessonTitle}.`,
          500,
        ),
        learning_activities: activities.length > 0
          ? activities
          : ['Tiếp cận nội dung, thực hành và tự kiểm tra mức độ hiểu.'],
        assessment: readString(
          lesson.assessment,
          'Kiểm tra mức độ đạt mục tiêu học tập của bài học.',
          500,
        ),
        units: legacyUnits,
        source_refs: readCanonicalBlueprintIds(lesson.source_refs, 8),
        ...(lessonLearningObjectives.length > 0 ? { learning_objectives: lessonLearningObjectives } : {}),
        ...(readCanonicalBlueprintIds(lesson.primary_concept_ids, 24).length > 0 ? { primary_concept_ids: readCanonicalBlueprintIds(lesson.primary_concept_ids, 24) } : {}),
        ...(readCanonicalBlueprintIds(lesson.supporting_concept_ids, 24).length > 0 ? { supporting_concept_ids: readCanonicalBlueprintIds(lesson.supporting_concept_ids, 24) } : {}),
        ...(readCanonicalBlueprintIds(lesson.prerequisite_concept_ids, 24).length > 0 ? { prerequisite_concept_ids: readCanonicalBlueprintIds(lesson.prerequisite_concept_ids, 24) } : {}),
        ...(typeof lesson.estimated_minutes === 'number' && Number.isInteger(lesson.estimated_minutes) && lesson.estimated_minutes > 0 && lesson.estimated_minutes <= 600
          ? { estimated_minutes: lesson.estimated_minutes } : {}),
        ...(lesson.assessment_required === true ? { assessment_required: true } : {}),
        ...(assessmentObjectiveRefs.length > 0 ? { assessment_objective_refs: assessmentObjectiveRefs } : {}),
      };
    });

    return {
      title,
      objective: readString(
        chapter.objective,
        `Người học có thể đạt các mục tiêu của ${title}.`,
        500,
      ),
      lessons,
      source_refs: readCanonicalBlueprintIds(chapter.source_refs, 8),
      ...(readStringArray(chapter.learning_objectives, 12, 500).length > 0 ? { learning_objectives: readStringArray(chapter.learning_objectives, 12, 500) } : {}),
      ...(readCanonicalBlueprintIds(chapter.concept_ids, 48).length > 0 ? { concept_ids: readCanonicalBlueprintIds(chapter.concept_ids, 48) } : {}),
    };
  });

  const mediaReview = normalizeLessonAuthorMediaReview(raw.media_review, chapters);
  const learningOutcomes = readStringArray(raw.learning_outcomes, MAX_BLUEPRINT_LEARNING_OUTCOMES, 500);
  if (learningOutcomes.length === 0) {
    throw new Error('AI blueprint must contain measurable learning outcomes');
  }

  if (options.requireContentArchitecture) {
    const compactMetrics = chapters.reduce((totals, chapter) => {
      chapter.lessons.forEach((lesson) => {
        totals.lessons += 1;
        lesson.units.forEach((unit) => {
          totals.units += 1;
          totals.components += unit.component_plan.length;
          totals.mediaPlans += unit.media_plan ? 1 : 0;
        });
      });
      return totals;
    }, { lessons: 0, units: 0, components: 0, mediaPlans: 0 });
    if (compactMetrics.lessons > MAX_COMPACT_BLUEPRINT_TOTAL_LESSONS
      || compactMetrics.units > MAX_COMPACT_BLUEPRINT_TOTAL_UNITS
      || compactMetrics.components > MAX_COMPACT_BLUEPRINT_TOTAL_COMPONENTS
      || compactMetrics.mediaPlans > MAX_COMPACT_BLUEPRINT_MEDIA_PLANS) {
      throw new Error('Blueprint exceeds the compact generation budget.');
    }
  }

  const normalized: LessonAuthorBlueprint = {
    ...(raw.component_capabilities ? { component_capabilities: readComponentCapabilities(raw.component_capabilities) } : {}),
    ...(architectureContractVersion ? { architecture_contract_version: architectureContractVersion } : {}),
    title: readString(raw.title, 'Bản thiết kế khóa học', 220),
    summary: readString(raw.summary, 'Bản thiết kế khóa học đang chờ duyệt.', 1400),
    target_audience: readString(raw.target_audience, 'Cần xác nhận đối tượng học.', 500),
    prerequisites: readStringArray(raw.prerequisites, 10, 280),
    learning_outcomes: learningOutcomes,
    ...(readStringArray(raw.course_outcomes, MAX_BLUEPRINT_LEARNING_OUTCOMES, 500).length > 0
      ? { course_outcomes: readStringArray(raw.course_outcomes, MAX_BLUEPRINT_LEARNING_OUTCOMES, 500) } : {}),
    assessment_strategy: readString(raw.assessment_strategy, 'Cần xác nhận chiến lược đánh giá.', 900),
    assumptions: readStringArray(raw.assumptions, MAX_BLUEPRINT_ASSUMPTIONS, 400),
    chapters,
    ...(normalizeLessonAuthorSourceMap(raw.source_map) ? { source_map: normalizeLessonAuthorSourceMap(raw.source_map)! } : {}),
    ...(sourceFactAllocation ? { source_fact_allocation: sourceFactAllocation } : {}),
    ...(sourceEvidenceScopeAllocation ? { source_evidence_scope_allocation: sourceEvidenceScopeAllocation } : {}),
    ...(mediaReview ? { media_review: mediaReview } : {}),
    ...(sourceChapterPolicy ? { source_chapter_policy: sourceChapterPolicy } : {}),
  };
  options.onBoundary?.('node_blueprint_normalization', normalized);
  if (options.requirePhaseOneContract) options.onBoundary?.('node_component_planner', normalized);
  return options.requirePhaseOneContract
    ? applyPhaseOneContentContract(normalized, options.allowedComponentTypes, options.onComponentDecision)
    : normalized;
}

export function buildLessonAuthorBlueprintQualityReport(
  blueprint: LessonAuthorBlueprint,
  sourceDocumentCount: number,
  retrieval?: RagRetrievalDiagnostics | null,
  locale: 'vi' | 'en' = 'vi',
  architectureValidation?: BlueprintArchitectureValidationResult,
): LessonAuthorBlueprintQualityReport {
  const chaptersHaveAlignment = blueprint.chapters.every(chapter =>
    Boolean(chapter.objective)
    && chapter.lessons.length > 0
    && chapter.lessons.every(lesson => Boolean(lesson.objective) && lesson.learning_activities.length > 0 && Boolean(lesson.assessment)),
  );
  const contentArchitectureReady = blueprint.chapters.every(chapter =>
    chapter.lessons.every(lesson =>
      lesson.units.length > 0
      && lesson.units.every(unit => isV4SupportingFactlessUnit(blueprint.architecture_contract_version, unit)
        ? blueprint.architecture_contract_version !== 5
          || (resolveV5SupportingEvidenceFactIds(blueprint, unit).length > 0 && unit.component_plan.length > 0)
        : (unit.component_plan.length > 0 && unit.component_plan.some(plan => plan.type === 'html'))),
    ),
  );
  // RAG must prove that at least one source chunk was actually returned. A
  // selected file alone is not evidence that retrieval succeeded. File Search
  // has no equivalent retrieval diagnostics yet, so retain its legacy check.
  const sourceGrounded = retrieval
    ? retrieval.returned_source_count > 0
    : sourceDocumentCount > 0;
  const structureNodeCount = retrieval?.structure_node_count ?? 0;
  const structureConfidence = retrieval?.structure_confidence ?? null;
  const structureAvailable = structureNodeCount > 0;
  const structureSource = retrieval?.structure_source ?? null;
  const structureWarnings = new Set(retrieval?.source_structure_warnings ?? []);
  const hasFallbackStructureWarning = structureWarnings.has('TOC_NOT_FOUND_HEADING_INFERRED');
  const coverageRatio = retrieval?.source_coverage_ratio ?? null;
  const coverageThreshold = structureSource === 'toc' ? 0.9 : 0.25;
  const coverageAvailable = coverageRatio !== null && coverageRatio >= coverageThreshold;
  // An inferred heading list is useful for review, but it is not strong
  // enough to mark a source-grounded Blueprint ready for application.
  const sourceStructureReady = structureAvailable
    && (structureConfidence ?? 0) >= 0.6
    && structureSource !== 'heading_inferred'
    && !hasFallbackStructureWarning;
  const weightedChecks = [
    { key: 'learning_outcomes', passed: blueprint.learning_outcomes.length >= 3, weight: 20 },
    { key: 'constructive_alignment', passed: chaptersHaveAlignment && contentArchitectureReady, weight: 25 },
    { key: 'assessment_strategy', passed: blueprint.assessment_strategy.length >= 24, weight: 15 },
    { key: 'source_grounding', passed: sourceGrounded, weight: 25 },
    { key: 'source_structure', passed: sourceStructureReady, weight: 10 },
    { key: 'source_coverage', passed: coverageAvailable, weight: 5 },
    ...(architectureValidation ? [{ key: 'blueprint_architecture', passed: architectureValidation.errors.length === 0, weight: 0 }] : []),
  ];
  const checks = weightedChecks.map(({ key, passed }) => ({ key, passed }));
  const score = weightedChecks.reduce((total, check) => total + (check.passed ? check.weight : 0), 0);
  const reviewNotes = getLessonAuthorBlueprintReviewNotes(
    checks,
    structureSource,
    blueprint.assumptions.length > 0,
    locale,
  );

  return {
    score,
    status: score >= 80 && sourceStructureReady && coverageAvailable ? 'ready_for_review' : 'needs_review',
    checks,
    review_notes: reviewNotes,
    source_evidence: {
      structure_source: retrieval?.structure_source ?? null,
      structure_confidence: structureConfidence,
      structure_node_count: structureNodeCount,
      known_source_ref_count: retrieval?.known_source_ref_count ?? 0,
      covered_source_ref_count: retrieval?.covered_source_ref_count ?? 0,
      source_coverage_ratio: coverageRatio,
      warnings: retrieval?.source_structure_warnings ?? [],
    },
    ...(architectureValidation ? { architecture_validation: architectureValidation } : {}),
  };
}

export function localizeLessonAuthorBlueprintQualityReport(
  qualityReport: LessonAuthorBlueprintQualityReport,
  blueprint: LessonAuthorBlueprint,
  locale: 'vi' | 'en',
): LessonAuthorBlueprintQualityReport {
  return {
    ...qualityReport,
    review_notes: getLessonAuthorBlueprintReviewNotes(
      qualityReport.checks,
      qualityReport.source_evidence?.structure_source,
      blueprint.assumptions.length > 0,
      locale,
    ),
  };
}
