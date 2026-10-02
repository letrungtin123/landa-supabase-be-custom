import type { LessonAuthorBlueprint } from './chat.service.js';
import type { RagLessonAuthorRequest } from './ai-rag-client.service.js';

/** Shared existing V4/V5 projection. Pure: no runtime/DB/provider imports.
 * Keep defaults and all provenance fields identical for legacy and workspace. */
export function projectBlueprintDraftArchitecture(blueprint: LessonAuthorBlueprint, chapterIndex: number):
  NonNullable<RagLessonAuthorRequest['blueprint_architecture']> {
  const chapter = blueprint.chapters[chapterIndex];
  return {
    ...(blueprint.component_capabilities ? { component_capabilities: blueprint.component_capabilities } : {}),
    ...((blueprint.architecture_contract_version === 4 || blueprint.architecture_contract_version === 5)
      ? { architecture_contract_version: blueprint.architecture_contract_version } : {}),
    chapter_title: chapter.title,
    source_refs: chapter.source_refs ?? [],
    lessons: chapter.lessons.map(lesson => ({
      title: lesson.title,
      source_refs: lesson.source_refs ?? [],
      learning_objectives: lesson.learning_objectives ?? [],
      primary_concept_ids: lesson.primary_concept_ids ?? [],
      supporting_concept_ids: lesson.supporting_concept_ids ?? [],
      assessment_required: lesson.assessment_required ?? false,
      assessment_objective_refs: lesson.assessment_objective_refs ?? [],
      units: lesson.units.map(unit => ({
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
        component_plan: unit.component_plan.map(plan => ({
          component_plan_id: plan.component_plan_id,
          learning_objective_refs: plan.learning_objective_refs,
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
}
