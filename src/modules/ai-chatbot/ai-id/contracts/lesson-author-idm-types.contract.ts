// IDM contract vocabulary: versions and limits, IdmError, the enum member lists and the
// TypeScript shape of every contract object. Split out of lesson-author-idm.contract.ts
// (move only), which re-exports all of it.

import type { OrchestrationV2SourceFact } from './lesson-author-orchestration-v2-rag-contract.logic.js';
import { LESSON_AUTHOR_DESIGN_MODES } from './lesson-author-launch-brief.logic.js';
import type { OrganizationContextV1 } from './lesson-author-org-context.contract.js';

export const IDM_PIPELINE_VERSION = 'idm-1' as const;
export const IDM_LEGACY_PIPELINE_VERSION = 'v2-legacy' as const;
export const IDM_CONTRACT_VERSION = 3 as const;
/** Contract versions a stored course design may carry (1 = before QLT-5, 2 = before QLT-6). */
export const IDM_READABLE_CONTRACT_VERSIONS = [1, 2, IDM_CONTRACT_VERSION] as const;
export const IDM_PROMPT_POLICY_VERSION = 'idm-prompt-1' as const;
export const IDM_SCOPE_KEY_PREFIX = 'idmcb_';
/** Python `IDM_SINGLE_TASK_MAX_SOURCE_CHARS`; Node checks it before calling Python (spec §12.4). */
export const IDM_SINGLE_TASK_MAX_SOURCE_CHARS = 384_000;
/** Python `IdmCourseSkeletonRequestV1.source_facts` max_length. */
export const IDM_SINGLE_TASK_MAX_FACTS = 20_000;
/** Python `IDM_SHARD_MAX_SOURCE_CHARS`; Node packs whole lessons into chapter shards (spec §12.3). */
export const IDM_SHARD_MAX_SOURCE_CHARS = 90_000;
export const IDM_REMAINING_BUDGET_SAFETY_MS = 15_000;
export const IDM_REMAINING_BUDGET_MIN_MS = 30_000;
export const IDM_REMAINING_BUDGET_MAX_MS = 600_000;

export type OrchestrationV2RunPipeline = typeof IDM_LEGACY_PIPELINE_VERSION | typeof IDM_PIPELINE_VERSION;

export type IdmErrorCode =
  | 'IDM_CONTRACT_INVALID'
  | 'IDM_COURSE_DESIGN_INVALID'
  | 'IDM_SHARD_DESIGN_INVALID'
  | 'IDM_UNIT_QUALITY_INVALID'
  | 'IDM_LESSON_EXCEEDS_SHARD'
  | 'IDM_SOURCE_EXCEEDS_SINGLE_TASK_CAPACITY'
  /** Lease time left minus the 15 s margin is under Python's 30 s floor; raised before provider dispatch. */
  | 'IDM_REMAINING_BUDGET_INSUFFICIENT';

export class IdmError extends Error {
  constructor(readonly code: IdmErrorCode, readonly path: string | null = null) {
    super(code);
    this.name = 'IdmError';
  }
}

// --- Enums (spec §6.1) ---------------------------------------------------------------------
export const IDM_INTENTS = ['know', 'do', 'decide'] as const;
export const IDM_SUPPORT_ROLES = ['example', 'common_mistake', 'checklist', 'job_aid', 'practice_material'] as const;
export const IDM_CONTENT_KINDS = ['concept', 'procedure', 'skill', 'decision', 'policy', 'mindset', 'system', 'case',
  'reference'] as const;
export const IDM_ISSUE_TYPES = ['unclear', 'duplicate', 'conflict', 'too_general', 'too_detailed', 'outdated'] as const;
export const IDM_GAP_TYPES = ['missing_example', 'missing_exception', 'missing_criteria', 'missing_step',
  'missing_sample_output', 'missing_common_mistake', 'missing_feedback_basis', 'missing_unit_variation'] as const;
export const IDM_LO_RELATIONS = ['direct', 'supporting', 'context', 'unrelated', 'unknown'] as const;
export const IDM_BLOOMS = ['remember', 'understand', 'apply', 'analyze', 'evaluate', 'create'] as const;
export const IDM_CLASSIFICATIONS = ['must_do', 'must_know', 'reference', 'nice_to_know', 'remove'] as const;
export const IDM_PLACEMENTS = ['course', 'reference_job_aid', 'excluded'] as const;
export const IDM_TREATMENTS = ['keep', 'condense', 'rewrite', 'explain', 'combine', 'separate', 'move_to_reference',
  'convert_to_job_aid', 'remove'] as const;
export const IDM_DISPOSITIONS = ['course', 'reference_job_aid', 'nice_to_know', 'remove', 'hold', 'noise'] as const;
export const IDM_SUPPORT_KINDS = ['explain_concept', 'explain_principle', 'example', 'non_example', 'worked_example',
  'demonstration'] as const;
export const IDM_COMPONENT_ROLES = ['explain', 'show', 'practice', 'clarify', 'summary', 'job_aid'] as const;
export const IDM_UNIT_SEGMENTS = ['context_explain', 'example', 'practice_feedback', 'summary_apply', 'job_aid'] as const;
export const IDM_SCENARIO_ORIGINS = ['source', 'ai_drafted', 'none'] as const;
export const IDM_ORIGINS = ['client', 'ai_proposed'] as const;
/** Python `AudienceOrigin`: "author" (contract 3) is the audience the author entered when starting AI ID. */
export const IDM_AUDIENCE_ORIGINS = ['client', 'ai_proposed', 'author'] as const;
/** Python `DesignMode` (contract 3): how the author started AI ID. */
export const IDM_DESIGN_MODES = LESSON_AUTHOR_DESIGN_MODES;
export const IDM_STAGE_ORIGINS = ['provider', 'partial_fallback', 'deterministic_fallback'] as const;
export const IDM_COMPONENT_TYPES = ['html', 'problem', 'la_faq', 'la_sortable', 'la_crossword', 'la_diagram'] as const;
export const IDM_JUDGE_CRITERIA = ['Q1_support_sufficient', 'Q2_not_copied', 'Q3_practice_complete',
  'Q4_feedback_teaches', 'Q5_grounded_criteria', 'Q6_alignment', 'Q7_cognitive_load', 'Q8_language',
  'Q9_traceability'] as const;
export const IDM_JUDGE_SEVERITIES = ['pass', 'minor', 'major', 'critical'] as const;
export const IDM_PURPOSE_PROFILES = ['onboarding', 'product', 'compliance', 'sales', 'soft_skills', 'general'] as const;
export const IDM_PURPOSE_CONFIDENCES = ['high', 'medium', 'low'] as const;
export const IDM_PURPOSE_ORIGINS = ['author_intent', 'ai_inferred', 'deterministic_fallback'] as const;
export const IDM_PURPOSE_EVIDENCE = ['title', 'description', 'source', 'purpose'] as const;
/** Python `FidelityMode` (QLT-5 C): how closely learner text follows the source wording. */
export const IDM_FIDELITY_MODES = ['keep', 'structured', 'explain'] as const;
/** QLT-5 D (Python `FaqQuestionType`, `FaqItemOrigin`): the server's plan of one FAQ item. */
export const IDM_FAQ_QUESTION_TYPES = ['why', 'what_if', 'common_mistake', 'how_to_apply', 'comparison', 'recall'] as const;
export const IDM_FAQ_ITEM_ORIGINS = ['source', 'distractor', 'ai_drafted'] as const;

export type IdmIntent = typeof IDM_INTENTS[number];
export type IdmSupportRole = typeof IDM_SUPPORT_ROLES[number];
export type IdmContentKind = typeof IDM_CONTENT_KINDS[number];
export type IdmIssueType = typeof IDM_ISSUE_TYPES[number];
export type IdmGapType = typeof IDM_GAP_TYPES[number];
export type IdmLoRelation = typeof IDM_LO_RELATIONS[number];
export type IdmBloom = typeof IDM_BLOOMS[number];
export type IdmClassification = typeof IDM_CLASSIFICATIONS[number];
export type IdmPlacement = typeof IDM_PLACEMENTS[number];
export type IdmTreatment = typeof IDM_TREATMENTS[number];
export type IdmDisposition = typeof IDM_DISPOSITIONS[number];
export type IdmSupportKind = typeof IDM_SUPPORT_KINDS[number];
export type IdmComponentRole = typeof IDM_COMPONENT_ROLES[number];
export type IdmUnitSegment = typeof IDM_UNIT_SEGMENTS[number];
export type IdmScenarioOrigin = typeof IDM_SCENARIO_ORIGINS[number];
export type IdmOrigin = typeof IDM_ORIGINS[number];
export type IdmAudienceOrigin = typeof IDM_AUDIENCE_ORIGINS[number];
export type IdmDesignMode = typeof IDM_DESIGN_MODES[number];
export type IdmStageOrigin = typeof IDM_STAGE_ORIGINS[number];
export type IdmComponentType = typeof IDM_COMPONENT_TYPES[number];
export type IdmJudgeCriterion = typeof IDM_JUDGE_CRITERIA[number];
export type IdmJudgeSeverity = typeof IDM_JUDGE_SEVERITIES[number];
export type IdmPurposeProfile = typeof IDM_PURPOSE_PROFILES[number];
export type IdmFidelityMode = typeof IDM_FIDELITY_MODES[number];
export type IdmFaqQuestionType = typeof IDM_FAQ_QUESTION_TYPES[number];
export type IdmFaqItemOrigin = typeof IDM_FAQ_ITEM_ORIGINS[number];
export type IdmContractVersion = typeof IDM_READABLE_CONTRACT_VERSIONS[number];

// --- Models (spec §6.2-§6.8) ---------------------------------------------------------------
export interface IdmSourceDocumentRefV1 { document_id: string; name: string; type: string | null }

export interface IdmProjectContextV1 {
  locale: 'vi' | 'en';
  course_title_hint: string | null;
  /** Contract 2: the CMS course description (author intent); absent in a contract-1 context. */
  course_description?: string | null;
  /** Contract 3 (QLT-6): the launch brief; all three absent in a contract-1/2 context, null without a brief. */
  design_mode?: IdmDesignMode | null;
  learner_audience?: string | null;
  course_purpose?: string | null;
  /**
   * Contract 3, optional (organization context): the profile the run froze at launch, background only;
   * absent (never null) without one, so every earlier context reads and hashes as before.
   */
  organization_context?: OrganizationContextV1;
  source_documents: IdmSourceDocumentRefV1[];
  target_audience: string | null;
  learning_objectives: string[];
  duration_target_minutes: number | null;
}

export interface IdmIssueV1 { type: IdmIssueType; note: string; fact_keys: string[] }
export interface IdmGapV1 { type: IdmGapType; note: string }

export interface IdmContentBlockV1 {
  block_id: string;
  section_id: string;
  name: string;
  summary: string;
  intent: IdmIntent;
  support_role: IdmSupportRole | null;
  content_kind: IdmContentKind;
  fact_keys: string[];
  issues: IdmIssueV1[];
  gaps: IdmGapV1[];
  sme_questions: string[];
  origin: 'provider' | 'deterministic_fallback';
}

export interface IdmLearningObjectiveV1 { lo_id: string; statement: string; bloom: IdmBloom; origin: IdmOrigin }
export interface IdmMustDoV1 { must_do_id: string; lo_id: string; statement: string; kind: 'do' | 'decide'; bloom: IdmBloom }
export interface IdmBlockLoLinkV1 { block_id: string; lo_id: string; relation: IdmLoRelation }
export interface IdmAudienceV1 { description: string; origin: IdmAudienceOrigin }
export interface IdmSeparatePartV1 { name: string; intent: IdmIntent; fact_keys: string[] }

export interface IdmBlueprintRowV1 {
  block_id: string;
  lo_id: string | null;
  must_do_ids: string[];
  classification: IdmClassification;
  placement: IdmPlacement;
  treatment: IdmTreatment;
  detail_level: string;
  hold: boolean;
  hold_reason: string | null;
  sme_question: string | null;
  combine_into: string | null;
  separate_into: IdmSeparatePartV1[];
  rationale: string;
}

export interface IdmLessonPlanV1 {
  lesson_key: string;
  kind: 'learning' | 'job_aid';
  title: string;
  primary_must_do_id: string | null;
  secondary_must_do_ids: string[];
  block_ids: string[];
  est_screens: number;
  est_minutes: number;
  ordering_rationale: string;
}

export interface IdmModulePlanV1 {
  module_key: string;
  title: string;
  performance_goal: string;
  lo_ids: string[];
  lessons: IdmLessonPlanV1[];
}

export interface IdmDispositionV1 {
  fact_key: string;
  disposition: IdmDisposition;
  block_id: string | null;
  reason: string | null;
}

export interface IdmBlockScopeV1 {
  scope_key: string;
  block_id: string;
  title: string;
  source_ref: string | null;
  fact_count: number;
  content_chars: number;
  fact_keys: string[];
}

export interface IdmHoldItemV1 {
  block_id: string;
  name: string;
  reason: string;
  sme_question: string;
  blocked_must_do_ids: string[];
}

export interface IdmAuthorNotesV1 { course: string; modules: Record<string, string>; lessons: Record<string, string> }

/** A required part of the purpose's course pattern the source lacks; `note` is plain author text. */
export interface IdmTemplateGapV1 { section_key: string; note: string }

/** Mirror of Python `IdmPurposeV1` (QLT-5): the course purpose the pipeline designed for. */
export interface IdmPurposeV1 {
  profile: IdmPurposeProfile;
  summary: string;
  confidence: typeof IDM_PURPOSE_CONFIDENCES[number];
  origin: typeof IDM_PURPOSE_ORIGINS[number];
  evidence: Array<typeof IDM_PURPOSE_EVIDENCE[number]>;
  signals: string[];
  template_gaps: IdmTemplateGapV1[];
  /** QLT-5 C: the content mode every later stage follows; absent in a purpose stored before it ("structured"). */
  fidelity_mode?: IdmFidelityMode | null;
}

export interface IdmCourseDesignV1 {
  pipeline_version: typeof IDM_PIPELINE_VERSION;
  idm_contract_version: IdmContractVersion;
  prompt_policy_version: typeof IDM_PROMPT_POLICY_VERSION;
  source_snapshot_hash: string;
  project_context: IdmProjectContextV1;
  /** Contract 2; absent in a design stored by contract 1. */
  purpose?: IdmPurposeV1;
  target_audience: IdmAudienceV1;
  learning_objectives: IdmLearningObjectiveV1[];
  must_dos: IdmMustDoV1[];
  blocks: IdmContentBlockV1[];
  lo_links: IdmBlockLoLinkV1[];
  blueprint: IdmBlueprintRowV1[];
  blocked_must_do_ids: string[];
  hold_items: IdmHoldItemV1[];
  modules: IdmModulePlanV1[];
  block_scopes: IdmBlockScopeV1[];
  dispositions: IdmDispositionV1[];
  notes: IdmAuthorNotesV1;
  stage_origins: Record<string, IdmStageOrigin>;
  design_hash: string;
}
export type IdmCourseDesign = IdmCourseDesignV1;

export interface IdmFeedbackFocusV1 { criterion: string; rationale: string; improvement: string }

export interface IdmPracticeTaskV1 {
  practice_id: string;
  sentence: string;
  context_input: string;
  learner_action: string;
  result: string;
  bloom: IdmBloom;
  criteria_fact_keys: string[];
  scenario_origin: IdmScenarioOrigin;
  hold: boolean;
  hold_question: string | null;
  feedback_focus: IdmFeedbackFocusV1;
}

export interface IdmSupportItemV1 { kind: IdmSupportKind; brief: string; block_id: string }

/**
 * Mirror of Python `IdmFaqItemPlanV1` (QLT-5 D): the question type of one FAQ item, the facts its answer is built on
 * and where its point comes from. Written by the server at W4 for an la_faq slot, never by authors.
 */
export interface IdmFaqItemPlanV1 {
  question_type: IdmFaqQuestionType;
  anchor_fact_keys: string[];
  origin: IdmFaqItemOrigin;
}

/** Mirror of Python `ArchitectureComponentAuthorReviewV2` (blank values normalised to null). */
export interface IdmComponentAuthorReviewV1 {
  purpose: string | null;
  example_scenario: string | null;
  visual_asset: string | null;
  user_behavior_navigation: string | null;
}

/** Mirror of Python `ArchitectureMediaBriefV2` (a non-IDM model: strings are not stripped). */
export interface IdmMediaBriefV1 {
  type: 'video' | 'static_infographic';
  title: string;
  content_points: string[];
  context_description: string;
  rationale: string;
}

export interface IdmComponentDesignV1 {
  component_index: number;
  type: IdmComponentType;
  role: IdmComponentRole;
  title: string;
  rationale: string;
  block_ids: string[];
  practice_id: string | null;
  support_items: IdmSupportItemV1[];
  author_review: IdmComponentAuthorReviewV1;
  /** QLT-5 D: the plan of an la_faq slot; absent on every other slot and in designs stored before it. */
  faq_items?: IdmFaqItemPlanV1[];
  /** QLT-9: the letter (0 = A) of a single-choice key, set by W4; absent on other slots and in older designs. */
  key_letter?: number;
}

export interface IdmUnitDesignV1 {
  unit_index: number;
  segment: IdmUnitSegment;
  title: string;
  purpose: string;
  block_ids: string[];
  components: IdmComponentDesignV1[];
  media_brief: IdmMediaBriefV1 | null;
}

export interface IdmLessonDesignV1 {
  lesson_key: string;
  title: string;
  objective: string;
  learning_objectives: string[];
  practice_tasks: IdmPracticeTaskV1[];
  assessment: string;
  units: IdmUnitDesignV1[];
  notes: string;
}

export interface IdmShardDesignV1 {
  pipeline_version: typeof IDM_PIPELINE_VERSION;
  chapter_key: string;
  shard_index: number;
  lessons: IdmLessonDesignV1[];
  lesson_index_offset: number;
  stage_origin: IdmStageOrigin;
  design_hash: string;
}

export interface IdmTreatmentRefV1 { block_id: string; treatment: IdmTreatment; detail_level: string }
export interface IdmContextFactV1 { fact_key: string; fact_text: string }

export interface IdmBriefComponentV1 {
  component_plan_id: string;
  type: IdmComponentType;
  role: IdmComponentRole;
  title: string;
  support_items: IdmSupportItemV1[];
  practice: IdmPracticeTaskV1 | null;
  treatments: IdmTreatmentRefV1[];
  owned_fact_keys: string[];
  supporting_fact_keys: string[];
  /** QLT-5 D: the design component's FAQ plan, only on an la_faq slot that has one. */
  faq_items?: IdmFaqItemPlanV1[];
  /** QLT-9: the design component's key letter, only on a problem slot that has one. */
  key_letter?: number;
}

/** Mirror of Python `IdmFaqBlockNoteV1` (QLT-5 D): what W1 found about one block of a unit with an FAQ. */
export interface IdmFaqBlockNoteV1 {
  block_id: string;
  name: string;
  intent: IdmIntent;
  content_kind: IdmContentKind;
  support_role: IdmSupportRole | null;
  issues: IdmIssueV1[];
  gaps: IdmGapV1[];
  sme_questions: string[];
}

/** Mirror of Python `IdmFaqPracticeNoteV1`: a lesson practice and its feedback focus ("why wrong" basis). */
export interface IdmFaqPracticeNoteV1 { practice_id: string; sentence: string; feedback_focus: IdmFeedbackFocusV1 }

/**
 * Mirror of Python `IdmFaqMaterialV1`: the raw material of a unit's FAQ (real confusions, never facts).
 * `open_questions` (QLT-7, contract 3): the SME questions of the lesson's Hold items and held practices, which the
 * FAQ must leave unanswered; absent when there is none, so a brief without them reads and hashes as before.
 */
export interface IdmFaqMaterialV1 {
  blocks: IdmFaqBlockNoteV1[];
  practices: IdmFaqPracticeNoteV1[];
  open_questions?: string[];
}

export interface IdmUnitBriefV1 {
  pipeline_version: typeof IDM_PIPELINE_VERSION;
  course_title: string;
  target_audience: string;
  /** Contract 2: the design's purpose (null for a contract-1 design); absent in a contract-1 brief. */
  purpose_profile?: IdmPurposeProfile | null;
  purpose_summary?: string | null;
  /** QLT-5 C: the design purpose's content mode (null without one); absent in a brief built before it. */
  fidelity_mode?: IdmFidelityMode | null;
  /** Contract 3 (QLT-6): how the author started AI ID (null without a brief); absent in an older brief. */
  design_mode?: IdmDesignMode | null;
  /** Contract 3, optional: the design's frozen organization context; absent without one. */
  organization_context?: OrganizationContextV1;
  module_title: string;
  lesson_title: string;
  lesson_objective: string;
  lesson_practice_sentences: string[];
  previous_lesson_title: string | null;
  next_lesson_title: string | null;
  unit_segment: IdmUnitSegment;
  unit_purpose: string;
  components: IdmBriefComponentV1[];
  lesson_context_facts: IdmContextFactV1[];
  job_aid_signpost: string | null;
  /** QLT-5 D: present only for a unit with an la_faq slot. */
  faq_material?: IdmFaqMaterialV1 | null;
  brief_hash: string;
}

export interface IdmFindingCountsV1 { minor: number; major: number; critical: number }

export interface IdmUnitQualityV1 {
  judge_mode: 'off' | 'observe' | 'repair';
  judge_status: 'not_run' | 'pass' | 'review_required' | 'reject' | 'skipped_budget' | 'failed';
  finding_counts: IdmFindingCountsV1;
  criteria: Partial<Record<IdmJudgeCriterion, IdmJudgeSeverity>>;
  repair_applied: boolean;
  deterministic_codes: string[];
  author_note: string;
}

export interface IdmTokenAllowanceV1 { input_tokens: number; output_tokens: number }

/** Request field `idm` of `/v1/lesson-author/orchestration-v2/course-skeleton` (Python `IdmCourseSkeletonRequestV1`). */
export interface IdmCourseSkeletonRequestV1 {
  pipeline_version: typeof IDM_PIPELINE_VERSION;
  project_context: IdmProjectContextV1;
  source_facts: OrchestrationV2SourceFact[];
  token_allowance: IdmTokenAllowanceV1;
  remaining_budget_ms: number;
}
