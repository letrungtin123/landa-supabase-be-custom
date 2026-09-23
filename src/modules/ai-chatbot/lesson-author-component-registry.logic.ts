import type {
  LessonAuthorComponentPlan,
  LessonAuthorComponentProposal,
  LessonAuthorComponentType,
} from '../course-authoring/course-authoring.service.js';
import {
  getLessonAuthorSortableItems,
  isLessonAuthorMediaProtectedBlock,
} from '../course-authoring/lesson-author-components.logic.js';
import { normalizeDiagramData } from '../course-authoring/diagram-data.logic.js';
import {
  sanitizeLessonAuthorHtml,
  validateLessonAuthorHtmlContract,
} from './lesson-author-content-contract.logic.js';
import {
  COURSE_COMPONENT_TYPES,
  isCourseComponentType,
  type CourseComponentType,
} from '../tenants/tenant-course-components.constants.js';

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

const INTENTS: readonly LearningBlockIntent[] = [
  'introduction', 'concept_explanation', 'definition', 'example', 'worked_example',
  'procedure', 'comparison', 'warning', 'tip', 'scenario', 'reflection', 'practice',
  'knowledge_check', 'terminology_reinforcement', 'faq', 'relationship_visualization',
  'summary', 'media_reference',
];

const IMPORTANCE: readonly LearningBlockImportance[] = ['supporting', 'core', 'critical', 'assessment'];

const GENERATABLE_TYPES = new Set<LessonAuthorComponentType>([
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
    constraints: { supported_subtypes: ['multiple_choice', 'multiple_select', 'dropdown', 'numerical', 'short_text'], media_forbidden: true },
    schema: { data: 'Open edX problem XML', required: ['question', 'answer or choices'] },
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function textList(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  const result = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const normalized = item.trim().slice(0, maxLength);
    if (normalized) result.add(normalized);
    if (result.size >= maxItems) break;
  }
  return Array.from(result);
}

/** IDs in the v4 semantic contract are not display strings and cannot truncate. */
function canonicalIdList(value: unknown, maxItems: number, maxLength = 96): string[] {
  if (!Array.isArray(value)) return [];
  if (value.length > maxItems) throw new Error('Semantic Blueprint identifier list exceeds its contract limit.');
  const result = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') throw new Error('Semantic Blueprint identifier is invalid.');
    const identifier = item.trim();
    if (!identifier || identifier.length > maxLength) throw new Error('Semantic Blueprint identifier is invalid.');
    result.add(identifier);
  }
  return [...result];
}

function localObjectiveRefList(value: unknown, maxItems: number): string[] {
  const refs = canonicalIdList(value, maxItems, 16);
  if (refs.some(ref => !/^lo_([1-9][0-9]*)$/.test(ref))) {
    throw new Error('Semantic learning block objective reference must be a local lo_N identifier.');
  }
  return refs;
}

export function readServerOwnedSourceFactIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const normalized = item.trim();
    if (!normalized || normalized.length > 96) {
      throw new Error('Server-owned Source Fact ID is invalid.');
    }
    ids.add(normalized);
    if (ids.size > MAX_SERVER_OWNED_SOURCE_FACT_IDS_PER_SCOPE) {
      throw new Error(`Server-owned Source Fact allocation exceeds ${MAX_SERVER_OWNED_SOURCE_FACT_IDS_PER_SCOPE} IDs for one scope.`);
    }
  }
  return Array.from(ids);
}

function numeric(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function truthy(value: unknown): boolean {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function contentFlag(block: SemanticLearningBlock, key: string): boolean {
  return truthy(block.content[key]) || truthy(block.metadata?.[key]);
}

function contentCount(block: SemanticLearningBlock, key: string): number {
  const direct = numeric(block.content[key]);
  if (direct > 0) return direct;
  const values = block.content[key];
  return Array.isArray(values) ? values.length : 0;
}

function componentPurposeForIntent(intent: LearningBlockIntent): NonNullable<LessonAuthorComponentPlan['purpose']> {
  if (intent === 'knowledge_check' || intent === 'practice') return 'assess';
  if (intent === 'faq') return 'clarify';
  if (intent === 'relationship_visualization') return 'relationship';
  if (intent === 'terminology_reinforcement') return 'terminology';
  if (intent === 'procedure') return 'sequence';
  return 'explain';
}

function fallbackRequirement(intent: LearningBlockIntent): string {
  const requirements: Record<LearningBlockIntent, string> = {
    introduction: 'Introduce the assigned source facts clearly before later learning activities.',
    concept_explanation: 'Explain the assigned source facts accurately in a learnable structure.',
    definition: 'Define the assigned terms exactly as supported by the source facts.',
    example: 'Use only source-supported examples for the assigned facts.',
    worked_example: 'Explain the source-supported worked example and its result.',
    procedure: 'Present the complete source-supported procedure in its required order.',
    comparison: 'Preserve the source-supported comparison criteria and distinctions.',
    warning: 'Present the source-supported warning visibly, without hiding it in an interaction.',
    tip: 'Present the source-supported practical tip with its applicable context.',
    scenario: 'Explain the source-supported scenario without inventing a branching conversation.',
    reflection: 'Provide a source-grounded reflection prompt.',
    practice: 'Create a source-grounded practice activity only when its interaction is supported.',
    knowledge_check: 'Assess understanding of the assigned source facts without adding unsupported facts.',
    terminology_reinforcement: 'Reinforce only terms and definitions supported by the assigned source facts.',
    faq: 'Answer anticipated, source-grounded learner questions.',
    relationship_visualization: 'Show the source-supported relationship, hierarchy, system, or flow.',
    summary: 'Summarize the assigned source facts without omitting critical conditions.',
    media_reference: 'Refer only to an existing authorized asset; do not fabricate a path or URL.',
  };
  return requirements[intent];
}

function htmlFallbackReason(intent: LearningBlockIntent): ComponentPlannerReasonCode {
  if (intent === 'procedure') return 'PROCEDURE_EXPLANATION';
  if (intent === 'warning') return 'WARNING_EXPLANATION';
  if (intent === 'scenario') return 'SCENARIO_MANUAL_ONLY_FALLBACK';
  if (intent === 'media_reference') return 'MEDIA_REFERENCE_ONLY_FALLBACK';
  return 'EXPLANATION_DEFAULT';
}

function isAllowed(type: CourseComponentType, allowed?: ReadonlySet<CourseComponentType>): boolean {
  return !allowed || allowed.has(type);
}

function makePlan(
  type: LessonAuthorComponentType,
  blocks: readonly SemanticLearningBlock[],
  reasonCode: ComponentPlannerReasonCode,
  fallbackTitle = '',
): PlannedLearningComponent {
  const factIds = Array.from(new Set(blocks.flatMap(block => block.source_fact_ids)));
  const requirements = Array.from(new Set(blocks.flatMap(block => {
    const explicit = textList(block.content.content_requirements, 8, 500);
    return explicit.length > 0 ? explicit : [fallbackRequirement(block.intent)];
  }))).slice(0, 8);
  const title = fallbackTitle || blocks[0]?.content.title;
  const requiredArtifacts = blocks.flatMap(block => {
    const raw = Array.isArray(block.metadata?.required_artifacts) ? block.metadata?.required_artifacts : [];
    return raw.flatMap(value => {
      const artifact = asRecord(value);
      const type = typeof artifact.type === 'string' ? artifact.type.trim().toLowerCase() : '';
      if (!['ordered_list', 'checklist', 'table', 'warning', 'requirement', 'exception', 'comparison'].includes(type)) return [];
      const minimum = numeric(artifact.minimum_items);
      return [{
        type: type as NonNullable<LessonAuthorComponentPlan['required_artifacts']>[number]['type'],
        ...(Number.isInteger(minimum) && minimum > 0 ? { minimum_items: Math.min(minimum, 100) } : {}),
      }];
    });
  });
  return {
    type,
    ...(typeof title === 'string' && title.trim() ? { title: title.trim().slice(0, 180) } : {}),
    rationale: blocks.map(block => fallbackRequirement(block.intent)).join(' ').slice(0, 240),
    purpose: componentPurposeForIntent(blocks[0]?.intent ?? 'concept_explanation'),
    source_fact_ids: factIds,
    content_requirements: requirements,
    learning_block_ids: blocks.map(block => block.id),
    reason_code: reasonCode,
    ...(requiredArtifacts.length > 0 ? { required_artifacts: requiredArtifacts } : {}),
  };
}

/** Parses only the semantic representation; invalid declared blocks are rejected. */
export function normalizeSemanticLearningBlocks(
  value: unknown,
  unitSourceFactIds: readonly string[] = [],
  options: { strictLocalObjectiveRefs?: boolean } = {},
): SemanticLearningBlock[] {
  if (!Array.isArray(value)) return [];
  const knownFacts = new Set(unitSourceFactIds);
  const seenIds = new Set<string>();
  return value.slice(0, 12).map((valueItem, index) => {
    const item = asRecord(valueItem);
    const intent = typeof item.intent === 'string' ? item.intent.trim().toLowerCase() : '';
    if (!INTENTS.includes(intent as LearningBlockIntent)) {
      throw new Error(`Semantic learning block ${index + 1} has an unsupported intent.`);
    }
    const importance = typeof item.importance === 'string' ? item.importance.trim().toLowerCase() : 'core';
    if (!IMPORTANCE.includes(importance as LearningBlockImportance)) {
      throw new Error(`Semantic learning block ${index + 1} has an unsupported importance.`);
    }
    const suppliedId = typeof item.id === 'string' ? item.id.trim() : '';
    if (suppliedId.length > 96) throw new Error(`Semantic learning block ${index + 1} has an invalid identifier.`);
    const id = suppliedId || `lb_${index + 1}`;
    if (seenIds.has(id)) throw new Error(`Semantic learning block ID "${id}" is duplicated.`);
    seenIds.add(id);
    const sourceFactIds = readServerOwnedSourceFactIds(item.source_fact_ids ?? item.sourceFactIds);
    const invalidFactIds = sourceFactIds.filter(idValue => knownFacts.size > 0 && !knownFacts.has(idValue));
    if (invalidFactIds.length > 0) {
      throw new Error(`Semantic learning block "${id}" references source facts outside its unit.`);
    }
    const primaryEvidenceScopeIds = canonicalIdList(
      item.primary_evidence_scope_ids ?? item.primaryEvidenceScopeIds,
      12,
    );
    const supportingEvidenceScopeIds = canonicalIdList(
      item.supporting_evidence_scope_ids ?? item.supportingEvidenceScopeIds,
      12,
    );
    if (primaryEvidenceScopeIds.some(scopeId => supportingEvidenceScopeIds.includes(scopeId))) {
      throw new Error(`Semantic learning block "${id}" cannot primary-own and support the same evidence scope.`);
    }
    return {
      id,
      intent: intent as LearningBlockIntent,
      importance: importance as LearningBlockImportance,
      content: asRecord(item.content),
      source_fact_ids: sourceFactIds,
      ...(canonicalIdList(item.concept_ids ?? item.conceptIds, 24).length > 0
        ? { concept_ids: canonicalIdList(item.concept_ids ?? item.conceptIds, 24) }
        : {}),
      ...(canonicalIdList(item.source_refs ?? item.sourceRefs, 8).length > 0
        ? { source_refs: canonicalIdList(item.source_refs ?? item.sourceRefs, 8) }
        : {}),
      ...(canonicalIdList(item.primary_concept_ids ?? item.primaryConceptIds, 24).length > 0
        ? { primary_concept_ids: canonicalIdList(item.primary_concept_ids ?? item.primaryConceptIds, 24) }
        : {}),
      ...(primaryEvidenceScopeIds.length > 0
        ? { primary_evidence_scope_ids: primaryEvidenceScopeIds }
        : {}),
      ...(supportingEvidenceScopeIds.length > 0
        ? { supporting_evidence_scope_ids: supportingEvidenceScopeIds }
        : {}),
      ...((options.strictLocalObjectiveRefs
        ? localObjectiveRefList(item.learning_objective_refs ?? item.learningObjectiveRefs, 12)
        : textList(item.learning_objective_refs ?? item.learningObjectiveRefs, 12, 160)).length > 0
        ? { learning_objective_refs: options.strictLocalObjectiveRefs
          ? localObjectiveRefList(item.learning_objective_refs ?? item.learningObjectiveRefs, 12)
          : textList(item.learning_objective_refs ?? item.learningObjectiveRefs, 12, 160) }
        : {}),
      ...(Object.keys(asRecord(item.metadata)).length > 0 ? { metadata: asRecord(item.metadata) } : {}),
    };
  });
}

/** Compatibility adapter for persisted or provider responses created before Phase 2. */
export function deriveSemanticLearningBlocksFromLegacyComponentPlan(
  plan: readonly Pick<LessonAuthorComponentPlan, 'type' | 'purpose' | 'source_fact_ids' | 'title' | 'required_artifacts'>[],
): SemanticLearningBlock[] {
  return plan.map((item, index) => {
    const intent: LearningBlockIntent = item.type === 'problem'
      ? 'knowledge_check'
      : item.type === 'la_faq'
        ? 'faq'
        : item.type === 'la_sortable'
          ? 'practice'
          : item.type === 'la_crossword'
            ? 'terminology_reinforcement'
            : item.type === 'la_diagram'
              ? 'relationship_visualization'
              : item.purpose === 'sequence'
                ? 'procedure'
                : item.purpose === 'relationship'
                  ? 'relationship_visualization'
                  : item.purpose === 'terminology'
                    ? 'terminology_reinforcement'
                    : item.purpose === 'clarify'
                      ? 'faq'
                      : 'concept_explanation';
    return {
      id: `legacy_lb_${index + 1}`,
      intent,
      importance: intent === 'knowledge_check' ? 'assessment' : 'core',
      source_fact_ids: item.source_fact_ids ?? [],
      content: {
        ...(item.title ? { title: item.title } : {}),
        legacy_component_type: item.type,
        ...(item.type === 'la_faq' ? { anticipated_questions: true, question_count: 2 } : {}),
        ...(item.type === 'la_sortable' ? { requires_ordering_practice: true, ordered_sequence: true, sequence_item_count: 3 } : {}),
        ...(item.type === 'la_crossword' ? { terminology_count: 3, definitions_supported: true } : {}),
        ...(item.type === 'la_diagram' ? { relationship_evidence: true } : {}),
      },
      metadata: {
        adapter: 'legacy_component_plan',
        ...(item.required_artifacts?.length ? { required_artifacts: item.required_artifacts } : {}),
      },
    };
  });
}

interface Candidate {
  type: LessonAuthorComponentType | null;
  reason_code: ComponentPlannerReasonCode;
}

function selectCandidate(block: SemanticLearningBlock): Candidate {
  if (block.intent === 'knowledge_check') return { type: 'problem', reason_code: 'ASSESS_OBJECTIVE' };
  if (block.intent === 'faq') {
    const validFaq = contentFlag(block, 'anticipated_questions')
      || contentCount(block, 'questions') >= 2
      || contentCount(block, 'question_count') >= 2;
    return validFaq
      ? { type: 'la_faq', reason_code: 'FAQ_ANTICIPATED_QUESTIONS' }
      : { type: null, reason_code: 'INSUFFICIENT_EVIDENCE_FALLBACK' };
  }
  if (block.intent === 'relationship_visualization') {
    return contentFlag(block, 'relationship_evidence') || contentFlag(block, 'has_relationship_evidence')
      || contentCount(block, 'relationships') > 0 || contentCount(block, 'nodes') >= 2
      ? { type: 'la_diagram', reason_code: 'RELATIONSHIP_VISUALIZATION' }
      : { type: null, reason_code: 'INSUFFICIENT_EVIDENCE_FALLBACK' };
  }
  if (block.intent === 'terminology_reinforcement') {
    const hasTerms = contentCount(block, 'terminology_count') >= 3 || contentCount(block, 'terms') >= 3;
    return hasTerms && (contentFlag(block, 'definitions_supported') || contentCount(block, 'definitions') >= 3)
      ? { type: 'la_crossword', reason_code: 'TERMINOLOGY_REINFORCEMENT' }
      : { type: null, reason_code: 'INSUFFICIENT_EVIDENCE_FALLBACK' };
  }
  if (block.intent === 'practice') {
    return contentFlag(block, 'requires_ordering_practice')
      && (contentFlag(block, 'ordered_sequence') || contentCount(block, 'sequence_items') >= 3 || contentCount(block, 'sequence_item_count') >= 3)
      ? { type: 'la_sortable', reason_code: 'ORDERING_PRACTICE' }
      : { type: null, reason_code: 'INSUFFICIENT_EVIDENCE_FALLBACK' };
  }
  return { type: null, reason_code: htmlFallbackReason(block.intent) };
}

/**
 * Deterministically maps semantic blocks to the smallest useful set of CMS
 * components.  A caller may supply tenant capability; the global registry
 * never bypasses that intersection.
 */
export function planSemanticLearningBlocks(input: {
  blocks: readonly SemanticLearningBlock[];
  unit_source_fact_ids: readonly string[];
  allowed_component_types?: ReadonlySet<CourseComponentType>;
}): PlannedLearningComponent[] {
  const allowed = input.allowed_component_types;
  if (!isAllowed('html', allowed)) {
    throw new Error('Tenant has disabled html, so Lesson Author cannot safely render the required explanatory content.');
  }
  const sourceFactIds = Array.from(new Set(input.unit_source_fact_ids));
  const explanatoryBlocks: SemanticLearningBlock[] = [];
  const primaryCandidates: Array<{ block: SemanticLearningBlock; candidate: Candidate }> = [];
  const faqCandidates: Array<{ block: SemanticLearningBlock; candidate: Candidate }> = [];
  let tenantCapabilityFallback = false;

  for (const block of input.blocks) {
    const candidate = selectCandidate(block);
    if (!candidate.type) {
      explanatoryBlocks.push(block);
      continue;
    }
    if (!isAllowed(candidate.type, allowed)) {
      tenantCapabilityFallback = true;
      explanatoryBlocks.push(block);
      continue;
    }
    if (candidate.type === 'la_faq') faqCandidates.push({ block, candidate });
    else primaryCandidates.push({ block, candidate });
  }

  // All source facts remain owned by explanatory HTML. This avoids dropping a
  // warning/procedure when an optional interaction is also selected.
  const htmlBlocks = explanatoryBlocks.length > 0 ? explanatoryBlocks : input.blocks;
  const htmlPlan = makePlan('html', htmlBlocks, htmlBlocks.some(block => block.intent === 'warning')
    ? 'WARNING_EXPLANATION'
    : htmlBlocks.some(block => block.intent === 'procedure')
      ? 'PROCEDURE_EXPLANATION'
      : tenantCapabilityFallback
        ? 'TENANT_CAPABILITY_FALLBACK'
        : 'EXPLANATION_DEFAULT');
  htmlPlan.source_fact_ids = sourceFactIds;

  const plans: PlannedLearningComponent[] = [htmlPlan];
  // Do not make a lesson visually varied by force: at most one non-FAQ
  // interaction is selected for a compact unit, then an evidence-backed FAQ.
  const chosenPrimary = primaryCandidates.sort((left, right) => {
    const leftPriority = AI_COMPONENT_REGISTRY[left.candidate.type!].selection_priority;
    const rightPriority = AI_COMPONENT_REGISTRY[right.candidate.type!].selection_priority;
    return leftPriority - rightPriority;
  })[0];
  if (chosenPrimary) plans.push(makePlan(chosenPrimary.candidate.type!, [chosenPrimary.block], chosenPrimary.candidate.reason_code));
  const chosenFaq = faqCandidates[0];
  if (chosenFaq) plans.push(makePlan('la_faq', [chosenFaq.block], chosenFaq.candidate.reason_code));

  for (const plan of plans) {
    if (!GENERATABLE_TYPES.has(plan.type)) throw new Error(`Registry selected unsupported AI component ${plan.type}.`);
    if (!isAllowed(plan.type, allowed)) {
      throw new Error(`Tenant does not permit Lesson Author component ${plan.type}.`);
    }
  }
  return plans;
}

function parseEmbeddedData(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try { return asRecord(JSON.parse(value)); } catch { return {}; }
  }
  return asRecord(value);
}

function escapeHtmlText(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const SEMANTIC_LEARNING_HTML_LIMITS = {
  heading: 240,
  paragraphs: { items: 12, characters: 2_000 },
  bullet_points: { items: 20, characters: 800 },
  ordered_steps: { items: 20, characters: 1_000 },
  warnings: { items: 8, characters: 1_000 },
  comparison_rows: { items: 30, labelCharacters: 500, valueCharacters: 1_000 },
} as const;

function semanticTextValues(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean);
}

function validateSemanticTextValues(
  value: unknown,
  label: keyof Pick<typeof SEMANTIC_LEARNING_HTML_LIMITS, 'paragraphs' | 'bullet_points' | 'ordered_steps' | 'warnings'>,
): string | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) return `Semantic ${label} must be an array.`;
  const limit = SEMANTIC_LEARNING_HTML_LIMITS[label];
  if (value.length > limit.items) return `Semantic ${label} exceeds the ${limit.items}-item render limit.`;
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) return `Semantic ${label} contains an empty text value.`;
    if (item.trim().length > limit.characters) return `Semantic ${label} contains text exceeding the ${limit.characters}-character render limit.`;
  }
  return null;
}

/**
 * Reject semantic content that the deterministic renderer cannot preserve.
 * This is intentionally a validation boundary, rather than a truncating
 * presentation helper: generated content must never claim source coverage
 * after rows, steps, or text have been silently discarded.
 */
export function validateSemanticLearningHtmlPayload(value: unknown): string | null {
  const content = asRecord(value);
  if (Object.keys(content).length === 0) return 'Semantic content must be a non-empty object.';
  let hasRenderableText = false;
  if (content.heading !== undefined) {
    if (typeof content.heading !== 'string' || !content.heading.trim()) return 'Semantic heading must be non-empty text.';
    if (content.heading.trim().length > SEMANTIC_LEARNING_HTML_LIMITS.heading) {
      return `Semantic heading exceeds the ${SEMANTIC_LEARNING_HTML_LIMITS.heading}-character render limit.`;
    }
    hasRenderableText = true;
  }
  const semanticFields: Array<[
    keyof Pick<typeof SEMANTIC_LEARNING_HTML_LIMITS, 'paragraphs' | 'bullet_points' | 'ordered_steps' | 'warnings'>,
    unknown,
  ]> = [
    ['paragraphs', content.paragraphs],
    ['bullet_points', content.bullet_points ?? content.bullets],
    ['ordered_steps', content.ordered_steps ?? content.steps],
    ['warnings', content.warnings ?? content.warning],
  ];
  for (const [label, fieldValue] of semanticFields) {
    const failure = validateSemanticTextValues(fieldValue, label);
    if (failure) return failure;
    if (Array.isArray(fieldValue) && fieldValue.length > 0) hasRenderableText = true;
  }
  const rows = content.comparison_rows ?? content.table_rows;
  if (rows !== undefined && rows !== null) {
    if (!Array.isArray(rows)) return 'Semantic comparison_rows must be an array.';
    if (rows.length > SEMANTIC_LEARNING_HTML_LIMITS.comparison_rows.items) {
      return `Semantic comparison_rows exceeds the ${SEMANTIC_LEARNING_HTML_LIMITS.comparison_rows.items}-row render limit.`;
    }
    for (const rowValue of rows) {
      const row = asRecord(rowValue);
      const label = typeof row.label === 'string' ? row.label.trim() : '';
      const rowValueText = typeof row.value === 'string' ? row.value.trim() : '';
      if (!label || !rowValueText) return 'Semantic comparison_rows contains an incomplete row.';
      if (label.length > SEMANTIC_LEARNING_HTML_LIMITS.comparison_rows.labelCharacters
        || rowValueText.length > SEMANTIC_LEARNING_HTML_LIMITS.comparison_rows.valueCharacters) {
        return 'Semantic comparison_rows contains text exceeding the render limit.';
      }
    }
    if (rows.length > 0) hasRenderableText = true;
  }
  return hasRenderableText ? null : 'Semantic content has no renderer-visible text.';
}

/**
 * Phase-2 adapter for explanatory components.  It intentionally renders a
 * small semantic JSON vocabulary to strict HTML and escapes every model text
 * value. Existing `html` strings remain supported by the legacy sanitizer.
 */
export function renderSemanticLearningHtml(value: unknown): string | null {
  const content = asRecord(value);
  if (Object.keys(content).length === 0) return null;
  const preservationFailure = validateSemanticLearningHtmlPayload(content);
  if (preservationFailure) throw new Error(`Semantic learning content is not lossless: ${preservationFailure}`);
  const heading = typeof content.heading === 'string' ? content.heading.trim() : '';
  const paragraphs = semanticTextValues(content.paragraphs);
  const bullets = semanticTextValues(content.bullet_points ?? content.bullets);
  const orderedSteps = semanticTextValues(content.ordered_steps ?? content.steps);
  const warnings = semanticTextValues(content.warnings ?? content.warning);
  const rows = Array.isArray(content.comparison_rows ?? content.table_rows)
    ? (content.comparison_rows ?? content.table_rows) as unknown[]
    : [];
  const tableRows = rows.flatMap(rowValue => {
    const row = asRecord(rowValue);
    const left = typeof row.label === 'string' ? row.label.trim() : '';
    const right = typeof row.value === 'string' ? row.value.trim() : '';
    return left && right ? [`<tr><th>${escapeHtmlText(left)}</th><td>${escapeHtmlText(right)}</td></tr>`] : [];
  });
  const output = [
    heading ? `<h2>${escapeHtmlText(heading)}</h2>` : '',
    ...paragraphs.map(paragraph => `<p>${escapeHtmlText(paragraph)}</p>`),
    bullets.length > 0 ? `<ul>${bullets.map(item => `<li>${escapeHtmlText(item)}</li>`).join('')}</ul>` : '',
    orderedSteps.length > 0 ? `<ol>${orderedSteps.map(item => `<li>${escapeHtmlText(item)}</li>`).join('')}</ol>` : '',
    ...warnings.map(warning => `<blockquote>${escapeHtmlText(warning)}</blockquote>`),
    tableRows.length > 0 ? `<table><tbody>${tableRows.join('')}</tbody></table>` : '',
  ].filter(Boolean).join('');
  if (!output) return null;
  const sanitized = sanitizeLessonAuthorHtml(output);
  const failure = validateLessonAuthorHtmlContract(sanitized);
  if (failure) throw new Error(`Deterministic semantic HTML is invalid: ${failure}`);
  return sanitized;
}

function nestedData(component: LessonAuthorComponentProposal, key: string): Record<string, unknown> {
  const metadata = asRecord(component.metadata);
  const data = asRecord(component.data);
  return parseEmbeddedData(metadata[key] ?? data[key]);
}

function assertText(value: unknown, message: string): void {
  if (typeof value !== 'string' || !value.trim()) throw new Error(message);
}

/** Validates normalized proposal payloads before a proposal can be persisted or applied. */
export function assertAiGeneratedComponentValid(
  component: LessonAuthorComponentProposal,
  allowedComponentTypes?: ReadonlySet<CourseComponentType>,
): void {
  if (!isCourseComponentType(component.type)) throw new Error(`Component type ${component.type} does not exist in the CMS registry.`);
  const descriptor = AI_COMPONENT_REGISTRY[component.type];
  if (!descriptor.ai_generatable || descriptor.generation_mode !== 'AI_GENERATABLE') {
    throw new Error(`Component type ${component.type} is not enabled for AI proposal generation.`);
  }
  if (!isAllowed(component.type, allowedComponentTypes)) {
    throw new Error(`Tenant does not permit Lesson Author component ${component.type}.`);
  }
  if (isLessonAuthorMediaProtectedBlock(component.type, component.data, component.metadata)) {
    throw new Error(`AI-generated ${component.type} must not contain an asset, media tag, storage path, or provider URL.`);
  }

  if (component.type === 'html') {
    assertText(component.data, 'HTML component must contain content.');
    const html = component.data as string;
    if (sanitizeLessonAuthorHtml(html) !== html.trim()) throw new Error('HTML component bypassed the Lesson Author sanitizer.');
    const failure = validateLessonAuthorHtmlContract(html);
    if (failure) throw new Error(`HTML component is invalid: ${failure}`);
    return;
  }
  if (component.type === 'problem') {
    assertText(component.data, 'Problem component must contain Open edX problem XML.');
    const xml = component.data as string;
    if (!/^\s*<problem>[\s\S]*<\/problem>\s*$/.test(xml)) throw new Error('Problem component is not a complete Open edX problem XML document.');
    if (!/<label>[\s\S]+<\/label>/.test(xml)) throw new Error('Problem component must contain a question label.');
    return;
  }
  if (component.type === 'la_faq') {
    const items = nestedData(component, 'faq_data').items;
    if (!Array.isArray(items) || items.length < 2 || items.some(item => {
      const row = asRecord(item);
      return typeof row.question !== 'string' || !row.question.trim() || typeof row.answer !== 'string' || !row.answer.trim();
    })) throw new Error('FAQ component requires at least two non-empty question-and-answer items.');
    return;
  }
  if (component.type === 'la_sortable') {
    const items = nestedData(component, 'sortable_data').items;
    const question = asRecord(component.metadata).question_text ?? asRecord(component.data).question_text;
    if (typeof question !== 'string' || !question.trim() || !Array.isArray(items) || items.length < 3) {
      throw new Error('Sortable component requires a question and at least three ordered items.');
    }
    if (items.some(item => typeof asRecord(item).text !== 'string' || !String(asRecord(item).text).trim())) {
      throw new Error('Sortable component contains an empty ordered item.');
    }
    return;
  }
  if (component.type === 'la_crossword') {
    const words = nestedData(component, 'crossword_data').words;
    if (!Array.isArray(words) || words.length < 3 || words.some(word => {
      const row = asRecord(word);
      return typeof row.answer !== 'string' || row.answer.trim().length < 2 || typeof row.clue !== 'string' || !row.clue.trim();
    })) throw new Error('Crossword component requires at least three terms with non-empty clues.');
    return;
  }
  const diagram = normalizeDiagramData(asRecord(component.metadata).diagram_data ?? component.data);
  if (!diagram || diagram.diagrams.length === 0 || diagram.diagrams.some(item => item.nodes.length < 2)) {
    throw new Error('Diagram component requires at least two normalized nodes.');
  }
}

export function assertLessonAuthorProposalComponentsValid(
  proposal: { chapters: Array<{ lessons: Array<{ units: Array<{ components?: LessonAuthorComponentProposal[] }> }> }> },
  allowedComponentTypes?: ReadonlySet<CourseComponentType>,
): void {
  for (const chapter of proposal.chapters) {
    for (const lesson of chapter.lessons) {
      for (const unit of lesson.units) {
        for (const component of unit.components ?? []) {
          assertAiGeneratedComponentValid(component, allowedComponentTypes);
        }
      }
    }
  }
}

/** Prevent accidental drift when the editor's authoritative enum changes. */
export function assertAiComponentRegistryCoverage(): void {
  const registered = Object.keys(AI_COMPONENT_REGISTRY).sort();
  const actual = [...COURSE_COMPONENT_TYPES].sort();
  if (registered.length !== actual.length || registered.some((type, index) => type !== actual[index])) {
    throw new Error('AI component registry must classify every current CMS component type exactly once.');
  }
}
