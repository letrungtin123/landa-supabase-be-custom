// The component registry table (AI_COMPONENT_REGISTRY), the learning block vocabulary and their
// types. Split out of lesson-author-component-registry.logic.ts (move only), which re-exports the
// public names.

import type {
  LessonAuthorComponentPlan, LessonAuthorComponentType,
} from '../../course-authoring/course-authoring.service.js';
import type { CourseComponentType } from '../../tenants/tenant-course-components.constants.js';

/**
 * The CMS component capability is deliberately separate from a learning
 * treatment.  The registry is the single Node-side authority for what Lesson
 * Author may propose; it does not grant a tenant permission by itself.
 */
export type AiComponentGenerationMode =
  | 'AI_GENERATABLE'
  | 'AI_GENERATABLE_WITH_EXISTING_ASSET'
  | 'REFERENCE_ONLY'
  | 'MANUAL_ONLY';

export type LearningBlockIntent =
  | 'introduction'
  | 'concept_explanation'
  | 'definition'
  | 'example'
  | 'worked_example'
  | 'procedure'
  | 'comparison'
  | 'warning'
  | 'tip'
  | 'scenario'
  | 'reflection'
  | 'practice'
  | 'knowledge_check'
  | 'terminology_reinforcement'
  | 'faq'
  | 'relationship_visualization'
  | 'summary'
  | 'media_reference';

export type LearningBlockImportance = 'supporting' | 'core' | 'critical' | 'assessment';

export interface SemanticLearningBlock {
  id: string;
  intent: LearningBlockIntent;
  importance: LearningBlockImportance;
  content: Record<string, unknown>;
  source_fact_ids: string[];
  /** Canonical Source Map scope selected by the Course Architect. */
  concept_ids?: string[];
  source_refs?: string[];
  /** Primary ownership only; reinforcement blocks intentionally leave this empty. */
  primary_concept_ids?: string[];
  /** V5 server-owned evidence scope contract; only primary scopes own Facts. */
  primary_evidence_scope_ids?: string[];
  /** Grounded reinforcement references that never duplicate canonical Fact ownership. */
  supporting_evidence_scope_ids?: string[];
  learning_objective_refs?: string[];
  metadata?: Record<string, unknown>;
}

/**
 * A transport/serialization boundary for server-owned canonical allocations.
 * It is not an instructional-design target and must reject rather than slice.
 */
export const MAX_SERVER_OWNED_SOURCE_FACT_IDS_PER_SCOPE = 512;

export interface AiComponentDescriptor {
  type: CourseComponentType;
  generation_mode: AiComponentGenerationMode;
  ai_generatable: boolean;
  requires_existing_asset: boolean;
  pedagogical_intents: readonly LearningBlockIntent[];
  best_for: readonly string[];
  avoid_when: readonly string[];
  constraints: Readonly<Record<string, unknown>>;
  /** A concise description of the existing persisted data/metadata contract. */
  schema: Readonly<Record<string, unknown>>;
  selection_priority: number;
}

export type ComponentPlannerReasonCode =
  | 'OPTIONAL_TREATMENT_HTML_FALLBACK'
  | 'EXPLANATION_DEFAULT'
  | 'ASSESS_OBJECTIVE'
  | 'FAQ_ANTICIPATED_QUESTIONS'
  | 'RELATIONSHIP_VISUALIZATION'
  | 'TERMINOLOGY_REINFORCEMENT'
  | 'ORDERING_PRACTICE'
  | 'PROCEDURE_EXPLANATION'
  | 'WARNING_EXPLANATION'
  | 'SCENARIO_MANUAL_ONLY_FALLBACK'
  | 'MEDIA_REFERENCE_ONLY_FALLBACK'
  | 'TENANT_CAPABILITY_FALLBACK'
  | 'INSUFFICIENT_EVIDENCE_FALLBACK'
  | 'LEGACY_COMPONENT_PLAN_ADAPTER';

export interface PlannedLearningComponent extends LessonAuthorComponentPlan {
  learning_block_ids: string[];
  reason_code: ComponentPlannerReasonCode;
}

export const INTENTS: readonly LearningBlockIntent[] = [
  'introduction', 'concept_explanation', 'definition', 'example', 'worked_example',
  'procedure', 'comparison', 'warning', 'tip', 'scenario', 'reflection', 'practice',
  'knowledge_check', 'terminology_reinforcement', 'faq', 'relationship_visualization',
  'summary', 'media_reference',
];

export const IMPORTANCE: readonly LearningBlockImportance[] = ['supporting', 'core', 'critical', 'assessment'];

export const GENERATABLE_TYPES = new Set<LessonAuthorComponentType>([
  'html', 'problem', 'la_faq', 'la_sortable', 'la_crossword', 'la_diagram',
]);

export const AI_COMPONENT_REGISTRY: Readonly<Record<CourseComponentType, AiComponentDescriptor>> = {
  video: {
    type: 'video', generation_mode: 'REFERENCE_ONLY', ai_generatable: false, requires_existing_asset: true,
    pedagogical_intents: ['media_reference'], selection_priority: 99,
    best_for: ['A verified existing video asset supplied by the tenant.'],
    avoid_when: ['No authorized asset exists; Lesson Author must not fabricate a URL or provider ID.'],
    constraints: { requires_authorized_asset: true, proposal_generation_enabled: false },
    schema: { storage: 'metadata.video_storage_path or metadata.youtube_id_1_0', required: ['existing_asset'] },
  },
  html: {
    type: 'html', generation_mode: 'AI_GENERATABLE', ai_generatable: true, requires_existing_asset: false,
    pedagogical_intents: ['introduction', 'concept_explanation', 'definition', 'example', 'worked_example', 'procedure', 'comparison', 'warning', 'tip', 'reflection', 'summary'], selection_priority: 1,
    best_for: ['Source-grounded explanation, procedure, comparison, warning, and summary.'],
    avoid_when: ['An interaction is needed to assess an objective.'],
    constraints: { generated_html_policy: 'lesson_author_strict', media_forbidden: true },
    schema: { data: 'sanitized semantic HTML', allowed_tags: ['h2', 'h3', 'p', 'ul', 'ol', 'li', 'strong', 'blockquote', 'table', 'thead', 'tbody', 'tr', 'th', 'td'] },
  },
  problem: {
    type: 'problem', generation_mode: 'AI_GENERATABLE', ai_generatable: true, requires_existing_asset: false,
    pedagogical_intents: ['knowledge_check', 'practice'], selection_priority: 2,
    best_for: ['A source-grounded knowledge check with a verifiable answer.'],
    avoid_when: ['No assessable claim or answer can be derived from source evidence.'],
    constraints: { supported_subtypes: ['multiple_choice'], correct_answer_count: 1, media_forbidden: true },
    schema: { data: 'Open edX single-answer multiple-choice XML', required: ['question', '3-6 choices', 'exactly one correct choice', 'explanation'] },
  },
  la_media_quiz: {
    type: 'la_media_quiz', generation_mode: 'AI_GENERATABLE_WITH_EXISTING_ASSET', ai_generatable: false, requires_existing_asset: true,
    pedagogical_intents: ['knowledge_check'], selection_priority: 90,
    best_for: ['A validated existing image/video asset with a media-dependent question.'],
    avoid_when: ['No authorized image/video asset is explicitly supplied.'],
    constraints: { requires_authorized_asset: true, proposal_generation_enabled: false },
    schema: { data: 'MediaQuizData version 1', required: ['questions[].media', 'questions[].choices'] },
  },
  la_image_choice_quiz: {
    type: 'la_image_choice_quiz', generation_mode: 'AI_GENERATABLE_WITH_EXISTING_ASSET', ai_generatable: false, requires_existing_asset: true,
    pedagogical_intents: ['knowledge_check'], selection_priority: 91,
    best_for: ['Image discrimination using tenant-owned image assets.'],
    avoid_when: ['Images are absent or their course/tenant ownership is unverified.'],
    constraints: { requires_authorized_asset: true, proposal_generation_enabled: false },
    schema: { data: 'ImageChoiceQuizData version 1', required: ['prompt_html', 'choices[].image.storage_path'] },
  },
  la_scenario_chat: {
    type: 'la_scenario_chat', generation_mode: 'MANUAL_ONLY', ai_generatable: false, requires_existing_asset: false,
    pedagogical_intents: ['scenario', 'practice'], selection_priority: 92,
    best_for: ['A reviewed branching decision/conversation scenario.'],
    avoid_when: ['A static explanation or ordinary knowledge check is sufficient.'],
    constraints: { proposal_generation_enabled: false, requires_human_authored_rounds: true },
    schema: { data: 'ScenarioChatData version 1', required: ['participant', 'learner', 'rounds[].choices'] },
  },
  la_crossword: {
    type: 'la_crossword', generation_mode: 'AI_GENERATABLE', ai_generatable: true, requires_existing_asset: false,
    pedagogical_intents: ['terminology_reinforcement'], selection_priority: 5,
    best_for: ['Reinforcing at least three evidence-backed terms with clear definitions.'],
    avoid_when: ['Terms/definitions are not sufficiently supported by source facts.'],
    constraints: { minimum_terms: 3, media_forbidden: true },
    schema: { metadata: 'crossword_data.words[]', required: ['words[].answer', 'words[].clue'] },
  },
  la_sortable: {
    type: 'la_sortable', generation_mode: 'AI_GENERATABLE', ai_generatable: true, requires_existing_asset: false,
    pedagogical_intents: ['practice'], selection_priority: 4,
    best_for: ['Practice where the learner must reconstruct a verified order.'],
    avoid_when: ['A procedure is only meant to be read or executed, not ordered by the learner.'],
    constraints: { minimum_items: 3, requires_ordering_practice: true, media_forbidden: true },
    schema: { metadata: 'sortable_data.items[]', required: ['question_text', 'items[].text'] },
  },
  la_diagram: {
    type: 'la_diagram', generation_mode: 'AI_GENERATABLE', ai_generatable: true, requires_existing_asset: false,
    pedagogical_intents: ['relationship_visualization'], selection_priority: 3,
    best_for: ['A source-supported relationship, hierarchy, system, or flow.'],
    avoid_when: ['The content is merely decorative or has no meaningful connection to visualize.'],
    constraints: { minimum_nodes: 2, media_forbidden: true },
    schema: { metadata: 'diagram_data.diagrams[]', required: ['diagrams[].nodes', 'diagrams[].edges'] },
  },
  la_faq: {
    type: 'la_faq', generation_mode: 'AI_GENERATABLE', ai_generatable: true, requires_existing_asset: false,
    pedagogical_intents: ['faq'], selection_priority: 6,
    best_for: ['At least two anticipated, source-grounded questions and answers.'],
    avoid_when: ['Generic explanatory prose or a question-free topic.'],
    constraints: { minimum_items: 2, must_be_anticipated_questions: true, media_forbidden: true },
    schema: { metadata: 'faq_data.items[]', required: ['items[].question', 'items[].answer'] },
  },
  la_pdf: {
    type: 'la_pdf', generation_mode: 'REFERENCE_ONLY', ai_generatable: false, requires_existing_asset: true,
    pedagogical_intents: ['media_reference'], selection_priority: 98,
    best_for: ['An authorized existing PDF/storage asset selected by an administrator.'],
    avoid_when: ['No validated PDF path or external URL is supplied.'],
    constraints: { requires_authorized_asset: true, proposal_generation_enabled: false },
    schema: { metadata: 'pdf_url', required: ['existing_authorized_pdf'] },
  },
};
