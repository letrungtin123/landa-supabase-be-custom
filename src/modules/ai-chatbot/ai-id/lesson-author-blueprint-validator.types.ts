// Types of the blueprint architecture validator: the Source Map, the blueprint architecture,
// the source chapter policy and the validation result. Split out of
// lesson-author-blueprint-validator.logic.ts (move only), which re-exports them.

export type BlueprintValidationSeverity = 'error' | 'warning' | 'info';
export type BlueprintValidationStatus = 'PASS' | 'PASS_WITH_WARNINGS' | 'FAIL';

export interface SourceMapSection {
  id: string;
  document_id: string;
  source_ref: string;
  title: string;
  level: number;
  parent_id: string | null;
  order: number;
  source_fact_ids: string[];
}

export interface SourceMapConcept {
  id: string;
  name: string;
  source_section_ids: string[];
  source_fact_ids: string[];
  prerequisite_concept_ids: string[];
  importance: 'core' | 'supporting';
  relationship_evidence?: 'source_hierarchy' | 'none';
}

export interface SourceEvidenceScope {
  id: string;
  document_id: string;
  section_id: string;
  concept_ids: string[];
  source_ref: string;
  source_fact_ids: string[];
  fact_count: number;
  evidence_char_count: number;
  evidence_token_estimate: number;
  derivation_basis: string;
  provenance_complete: boolean;
}

export interface LessonAuthorSourceMap {
  version: string;
  documents: Array<{ id: string; title: string; language?: string; source_section_ids: string[] }>;
  sections: SourceMapSection[];
  concepts: SourceMapConcept[];
  source_evidence_scopes?: SourceEvidenceScope[];
  facts: Array<{ id: string; section_id: string; document_id: string; source_ref?: string; page?: number | null; chunk?: number | null }>;
  coverage: {
    section_count: number;
    source_fact_count: number;
    mapped_fact_count: number;
    unmapped_fact_ids?: string[];
    fact_scope_complete: boolean;
    section_scope_complete: boolean;
    total_fact_count?: number;
    represented_fact_count?: number;
    concept_count?: number;
    incomplete_reason?: string | null;
    evidence_scope_count?: number;
    evidence_scope_complete?: boolean;
  };
  warnings?: string[];
}

export interface BlueprintArchitectureUnit {
  title: string;
  purpose?: string;
  concept_ids?: string[];
  primary_concept_ids?: string[];
  source_refs?: string[];
  source_fact_ids?: string[];
  primary_evidence_scope_ids?: string[];
  supporting_evidence_scope_ids?: string[];
  learning_objective_refs?: string[];
  learning_blocks?: Array<{
    id?: string;
    intent?: string;
    concept_ids?: string[];
    primary_concept_ids?: string[];
    source_refs?: string[];
    source_fact_ids?: string[];
    primary_evidence_scope_ids?: string[];
    supporting_evidence_scope_ids?: string[];
    learning_objective_refs?: string[];
  }>;
}

export interface BlueprintArchitectureLesson {
  title: string;
  objective: string;
  learning_objectives?: string[];
  primary_concept_ids?: string[];
  supporting_concept_ids?: string[];
  prerequisite_concept_ids?: string[];
  estimated_minutes?: number;
  assessment_required?: boolean;
  assessment_objective_refs?: string[];
  source_refs?: string[];
  units: BlueprintArchitectureUnit[];
}

export interface BlueprintArchitectureChapter {
  title: string;
  objective: string;
  learning_objectives?: string[];
  concept_ids?: string[];
  source_refs?: string[];
  lessons: BlueprintArchitectureLesson[];
}

export interface BlueprintArchitecture {
  source_chapter_policy?: SourceChapterPolicy;
  architecture_contract_version?: number;
  title: string;
  learning_outcomes: string[];
  course_outcomes?: string[];
  chapters: BlueprintArchitectureChapter[];
  source_fact_allocation?: {
    version: string;
    authority?: string;
    architecture_contract_version?: number;
    required_count: number;
    allocated_count: number;
    complete: boolean;
    allocations: Array<{ fact_id: string; unit_path: string; learning_block_id: string; evidence_scope_id?: string; basis: string }>;
    unallocated: Array<{ fact_id: string; code: string; path: string }>;
  };
  source_evidence_scope_allocation?: {
    version: string;
    authority?: string;
    architecture_contract_version?: number;
    required_count: number;
    allocated_count: number;
    complete: boolean;
    allocations: Array<{ evidence_scope_id: string; unit_path: string; learning_block_id: string; basis: string }>;
    unallocated: Array<{ evidence_scope_id: string; code: string; path: string }>;
  };
}

export interface SourceChapterPolicy {
  version: 1;
  mode: 'MODEL_DESIGNED' | 'SOURCE_LOCKED_TOC' | 'SOURCE_LOCKED_HEADINGS';
  complete: true;
  reason_codes: string[];
  chapters: Array<{ document_id: string; source_ref: string; title: string; source_title: string; basis: string; parser_version: string | null }>;
}

export interface BlueprintValidationIssue {
  code: string;
  severity: BlueprintValidationSeverity;
  path: string;
  message: string;
  repair_scope: 'blueprint' | 'chapter' | 'lesson' | 'unit';
}

export interface BlueprintArchitectureValidationResult {
  status: BlueprintValidationStatus;
  score_summary: { source_coverage: number | null; concept_coverage: number | null };
  errors: BlueprintValidationIssue[];
  warnings: BlueprintValidationIssue[];
  info: BlueprintValidationIssue[];
  concept_ownership: Record<string, { primary_lesson_path: string; supporting_lesson_paths: string[] }>;
}
