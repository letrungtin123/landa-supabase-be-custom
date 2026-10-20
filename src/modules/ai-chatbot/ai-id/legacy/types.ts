// AI ID V1 / lesson-author legacy code, moved unchanged out of chat.service.ts.
// chat.service.ts re-exports its public symbols, so existing imports keep working.
import {
  type LessonAuthorComponentType,
  type LessonAuthorProposal,
} from '../../../course-authoring/course-authoring.service.js';
import { type LessonAuthorBlueprintMediaReview } from '../v1/lesson-author-media-review.logic.js';
import {
  type LessonAuthorContentContractPlan,
  type LessonAuthorStructuredArtifactRequirement,
} from '../content/lesson-author-content-contract.logic.js';
import { type SemanticLearningBlock } from '../content/lesson-author-component-registry.logic.js';
import {
  type BlueprintArchitectureValidationResult,
  type LessonAuthorSourceMap,
} from '../v1/lesson-author-blueprint-validator.logic.js';
import type { LessonAuthorSourceDocument } from '../../chat/chat.types.js';

export interface LessonAuthorOutlineMention {
  block_id: string;
  block_type: string;
  display_name: string;
  path: string;
  unit_id?: string | null;
  ancestor_ids?: string[];
  ancestor_types?: string[];
}

export interface LessonAuthorBlueprintLesson {
  title: string;
  objective: string;
  learning_activities: string[];
  assessment: string;
  units: LessonAuthorBlueprintUnit[];
  source_refs?: string[];
  learning_objectives?: string[];
  primary_concept_ids?: string[];
  supporting_concept_ids?: string[];
  prerequisite_concept_ids?: string[];
  estimated_minutes?: number;
  assessment_required?: boolean;
  assessment_objective_refs?: string[];
}

export interface LessonAuthorBlueprintComponentPlan {
  component_plan_id?: string;
  learning_objective_refs?: string[];
  type: LessonAuthorComponentType;
  title: string;
  rationale: string;
  purpose?: LessonAuthorContentContractPlan['purpose'];
  source_fact_ids?: string[];
  /** Read-only evidence for a V5 supporting/reinforcement treatment. */
  supporting_evidence_fact_ids?: string[];
  content_requirements?: string[];
  reason_code?: string;
  learning_block_ids?: string[];
  required_artifacts?: LessonAuthorStructuredArtifactRequirement[];
}

export interface LessonAuthorBlueprintMediaPlan {
  type: 'video' | 'static_infographic';
  title: string;
  content_outline: string;
  brief_version?: 2;
  content_points?: string[];
  context_description?: string;
  evidence_language?: 'original';
  content_basis?: 'SOURCE_EXCERPTS';
  rationale: string;
}

export interface LessonAuthorBlueprintUnit {
  title: string;
  component_plan: LessonAuthorBlueprintComponentPlan[];
  purpose?: string;
  concept_ids?: string[];
  primary_concept_ids?: string[];
  primary_evidence_scope_ids?: string[];
  supporting_evidence_scope_ids?: string[];
  learning_objective_refs?: string[];
  source_refs?: string[];
  source_fact_ids?: string[];
  /** Resolved from approved supporting evidence scopes; not canonical ownership. */
  supporting_evidence_fact_ids?: string[];
  /** Phase 2 intermediate representation; persisted in existing blueprint JSON. */
  learning_blocks?: SemanticLearningBlock[];
  media_plan?: LessonAuthorBlueprintMediaPlan;
}

export interface LessonAuthorBlueprintChapter {
  title: string;
  objective: string;
  lessons: LessonAuthorBlueprintLesson[];
  source_refs?: string[];
  learning_objectives?: string[];
  concept_ids?: string[];
}

export interface LessonAuthorBlueprintQualityReport {
  score: number;
  status: 'ready_for_review' | 'needs_review';
  checks: Array<{ key: string; passed: boolean }>;
  review_notes: string[];
  source_evidence?: {
    structure_source: string | null;
    structure_confidence: number | null;
    structure_node_count: number;
    known_source_ref_count: number;
    covered_source_ref_count: number;
    source_coverage_ratio: number | null;
    warnings: string[];
  };
  architecture_validation?: BlueprintArchitectureValidationResult;
}

export interface LessonAuthorBlueprint {
  source_chapter_policy?: import('../v1/lesson-author-blueprint-validator.logic.js').SourceChapterPolicy;
  component_capabilities?: import('../content/lesson-author-capabilities.logic.js').LessonAuthorComponentCapabilities;
  architecture_contract_version?: 3 | 4 | 5;
  content_contract_version?: 1;
  title: string;
  summary: string;
  target_audience: string;
  prerequisites: string[];
  learning_outcomes: string[];
  course_outcomes?: string[];
  assessment_strategy: string;
  assumptions: string[];
  chapters: LessonAuthorBlueprintChapter[];
  source_map?: LessonAuthorSourceMap;
  source_fact_allocation?: LessonAuthorSourceFactAllocation;
  source_evidence_scope_allocation?: LessonAuthorSourceEvidenceScopeAllocation;
  media_review?: LessonAuthorBlueprintMediaReview;
}

/** Server-generated provenance allocation; it never contains model reasoning. */
export interface LessonAuthorSourceFactAllocationV1 {
  version: 'source-fact-allocation-v1';
  required_count: number;
  allocated_count: number;
  complete: boolean;
  allocations: Array<{
    fact_id: string;
    unit_path: string;
    learning_block_id: string;
    basis: 'SECTION_MATCH' | 'CONCEPT_MATCH' | 'SOURCE_REF_MATCH' | 'OWNERSHIP_MATCH';
  }>;
  unallocated: Array<{ fact_id: string; code: string; path: string }>;
  invalid_claimed_fact_ids: string[];
}

/** v4 allocation is created after Architect output by Python's deterministic server allocator. */
export interface LessonAuthorSourceFactAllocationV2 {
  version: 'source-fact-allocation-v2';
  authority: 'server';
  architecture_contract_version: 4;
  required_count: number;
  allocated_count: number;
  complete: boolean;
  allocations: Array<{
    fact_id: string;
    unit_path: string;
    learning_block_id: string;
    basis: 'SECTION_MATCH' | 'CONCEPT_MATCH' | 'SOURCE_REF_MATCH' | 'OWNERSHIP_MATCH';
  }>;
  unallocated: Array<{ fact_id: string; code: string; path: string }>;
}

/** V5 derives canonical Fact ownership only from a primary evidence scope. */
export interface LessonAuthorSourceFactAllocationV3 {
  version: 'source-fact-allocation-v3';
  authority: 'server';
  architecture_contract_version: 5;
  required_count: number;
  allocated_count: number;
  complete: boolean;
  allocations: Array<{
    fact_id: string;
    unit_path: string;
    learning_block_id: string;
    evidence_scope_id: string;
    basis: 'PRIMARY_EVIDENCE_SCOPE';
  }>;
  unallocated: Array<{ fact_id: string; code: string; path: string }>;
}

export type LessonAuthorSourceFactAllocation = LessonAuthorSourceFactAllocationV1 | LessonAuthorSourceFactAllocationV2 | LessonAuthorSourceFactAllocationV3;

export interface LessonAuthorSourceEvidenceScopeAllocation {
  version: 'source-evidence-scope-allocation-v1';
  authority: 'server';
  architecture_contract_version: 5;
  required_count: number;
  allocated_count: number;
  complete: boolean;
  allocations: Array<{
    evidence_scope_id: string;
    unit_path: string;
    learning_block_id: string;
    basis: 'PRIMARY_EVIDENCE_SCOPE';
  }>;
  unallocated: Array<{ evidence_scope_id: string; code: string; path: string }>;
}

export interface DraftCourseOutline {
  courseName: string;
  courseDescription: string;
  hasStructure: boolean;
  chapterCount: number;
  outline: string;
}

export interface MentionContextRow {
  id: string;
  parent_id: string | null;
  root_id: string;
  block_type: string;
  display_name: string;
  sort_order: number;
  depth: number;
  data: unknown;
  metadata: unknown;
}

export interface LessonAuthorJobRow {
  id: string;
  tenant_id: string;
  course_id: string;
  conversation_id: string | null;
  bot_id: string | null;
  kb_id: string | null;
  requested_by: string | null;
  blueprint_id?: string | null;
  prompt: string;
  proposal: LessonAuthorProposal;
  status: string;
  created_block_ids?: string[] | null;
  updated_block_ids?: string[] | null;
  created_at: string;
}

export interface AppliedLessonAuthorJob {
  job_id: string;
  course_id: string;
  created_block_ids: string[];
  updated_block_ids: string[];
  created_count: number;
  updated_count: number;
  already_applied?: boolean;
  blueprint_id?: string | null;
  blueprint_chapter_index?: number | null;
}

export interface LessonAuthorBlueprintRow {
  output_locale?: 'vi' | 'en' | null;
  id: string;
  tenant_id: string;
  course_id: string;
  kb_id: string | null;
  status: string;
  blueprint: LessonAuthorBlueprint;
  quality_report: LessonAuthorBlueprintQualityReport;
  source_documents: unknown;
  source_snapshot_hash: string;
  course_outline_hash: string;
}

export type LessonAuthorIntent = 'chat' | 'course_blueprint' | 'draft_lesson';

// ── Scoring-based intent classifier ──
// Mỗi signal có weight. Tổng > 0 → draft_lesson, ≤ 0 → chat
// KHÔNG gọi Gemini — zero extra API call

export interface IntentSignal {
  name: string;
  weight: number;
  matched: boolean;
}

export interface BlueprintDraftContext {
  outputLocale?: 'vi' | 'en';
  id: string;
  chapterIndex: number;
  blueprint: LessonAuthorBlueprint;
  sourceDocuments: LessonAuthorSourceDocument[];
}
