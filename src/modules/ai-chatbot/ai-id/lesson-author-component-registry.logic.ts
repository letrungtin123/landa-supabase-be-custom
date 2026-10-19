import { assertComponentInstancePlan, ComponentCapabilityError, componentPlanId, readComponentCapabilities, type LessonAuthorComponentCapabilities } from './lesson-author-capabilities.logic.js';
import type {
  LessonAuthorComponentPlan,
  LessonAuthorComponentProposal,
  LessonAuthorComponentType,
} from '../../course-authoring/course-authoring.service.js';
import {
  getLessonAuthorSortableItems,
  isLessonAuthorMediaProtectedBlock,
} from '../../course-authoring/lesson-author-components.logic.js';
import { normalizeDiagramData } from '../../course-authoring/diagram-data.logic.js';
import {
  sanitizeLessonAuthorHtml,
  validateLessonAuthorHtmlContract,
} from './lesson-author-content-contract.logic.js';
import {
  normalizeDiagramDisplayText,
  validateGeneratedDiagramGeometry,
} from './lesson-author-diagram-layout.logic.js';
import {
  COURSE_COMPONENT_TYPES,
  isCourseComponentType,
  type CourseComponentType,
} from '../../tenants/tenant-course-components.constants.js';
import { AI_COMPONENT_REGISTRY, GENERATABLE_TYPES, INTENTS } from './lesson-author-component-registry.constants.js';
import type {
  ComponentPlannerReasonCode, LearningBlockIntent, PlannedLearningComponent, SemanticLearningBlock,
} from './lesson-author-component-registry.constants.js';
import { asRecord, textList } from './lesson-author-component-registry-blocks.logic.js';
export {
  readServerOwnedSourceFactIds, normalizeSemanticLearningBlocks, deriveSemanticLearningBlocksFromLegacyComponentPlan,
} from './lesson-author-component-registry-blocks.logic.js';
export {
  MAX_SERVER_OWNED_SOURCE_FACT_IDS_PER_SCOPE, AI_COMPONENT_REGISTRY,
} from './lesson-author-component-registry.constants.js';
export type {
  AiComponentGenerationMode, LearningBlockIntent, LearningBlockImportance, SemanticLearningBlock, AiComponentDescriptor,
  ComponentPlannerReasonCode, PlannedLearningComponent,
} from './lesson-author-component-registry.constants.js';

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
export interface ComponentPlannerDiagnostic {
  status: 'PASS' | 'FAIL';
  unit_path: string | null;
  failure_code: string | null;
  block_count: number;
  omitted_block_count: number;
  decisions: Array<{
    block_index: number; intent: LearningBlockIntent | 'unknown'; role: 'required' | 'optional';
    candidate_type: LessonAuthorComponentType; selected_type: LessonAuthorComponentType | null;
    descriptor_eligible: boolean; tenant_permitted: boolean;
    reason_code: string;
  }>;
}

interface ComponentPlannerInput {
  component_capabilities?: LessonAuthorComponentCapabilities;
  unit_path?: string;
  blocks: readonly SemanticLearningBlock[];
  unit_source_fact_ids: readonly string[];
  allowed_component_types?: ReadonlySet<CourseComponentType>;
  on_diagnostics?: (diagnostics: ComponentPlannerDiagnostic) => void;
}

/** Operational projection only: no block IDs, descriptors or private prose. */
export function planSemanticLearningBlocks(input: ComponentPlannerInput): PlannedLearningComponent[] {
  let plans: PlannedLearningComponent[] = [];
  let failure: unknown;
  try {
    plans = planSemanticLearningBlocksInternal(input);
    return plans;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (input.on_diagnostics) {
      const failureCode = failure instanceof ComponentCapabilityError ? failure.code : failure ? 'COMPONENT_PLANNING_REJECTED' : null;
      const diagnostics: ComponentPlannerDiagnostic = {
        status: failure ? 'FAIL' : 'PASS',
        unit_path: /^chapter_\d+\.lesson_\d+\.unit_\d+$/.test(input.unit_path ?? '') ? input.unit_path! : null,
        failure_code: failureCode, block_count: input.blocks.length,
        omitted_block_count: Math.max(0, input.blocks.length - 12),
        decisions: input.blocks.slice(0, 12).map((block, block_index) => {
          const candidate = selectCandidate(block);
          const candidateType = candidate.type ?? 'html';
          const represented = plans.filter(plan => plan.learning_block_ids?.includes(block.id));
          const selected = represented.find(plan => plan.type !== 'html') ?? represented[0];
          const permitted = isAllowed(candidateType, input.allowed_component_types);
          const reason = failureCode ?? (!permitted ? 'TENANT_CAPABILITY_FALLBACK'
            : candidate.type && selected?.type === 'html' ? 'OPTIONAL_TREATMENT_HTML_FALLBACK'
              : !selected ? 'OPTIONAL_TREATMENT_CAPACITY_OMITTED' : candidate.reason_code);
          return { block_index, intent: INTENTS.includes(block.intent) ? block.intent : 'unknown',
            role: block.intent === 'knowledge_check' || block.importance === 'core' || block.importance === 'critical' || block.metadata?.required === true ? 'required' : 'optional',
            candidate_type: candidateType, selected_type: selected?.type ?? null,
            descriptor_eligible: candidate.reason_code !== 'INSUFFICIENT_EVIDENCE_FALLBACK',
            tenant_permitted: permitted, reason_code: reason };
        }),
      };
      // Diagnostic consumers cannot convert rejection to acceptance (or vice versa).
      try { input.on_diagnostics(diagnostics); } catch { /* logging is non-authoritative */ }
    }
  }
}

function planSemanticLearningBlocksInternal(input: ComponentPlannerInput): PlannedLearningComponent[] {
  const allowed = input.allowed_component_types;
  const capabilities = readComponentCapabilities(input.component_capabilities);
  if (capabilities && !input.unit_path) throw new Error('COMPONENT_PLAN_UNIT_ADDRESS_REQUIRED');
  if (capabilities && (input.blocks.some(b => !b.id) || new Set(input.blocks.map(b => b.id)).size !== input.blocks.length)) throw new Error('COMPONENT_PLAN_BLOCK_ADDRESS_AMBIGUOUS');
  const sourceFactIds = Array.from(new Set(input.unit_source_fact_ids));
  const explanatoryBlocks: SemanticLearningBlock[] = [];
  const assessmentCandidates: Array<{ block: SemanticLearningBlock; candidate: Candidate }> = [];
  const instructionalCandidates: Array<{ block: SemanticLearningBlock; candidate: Candidate }> = [];
  const faqCandidates: Array<{ block: SemanticLearningBlock; candidate: Candidate }> = [];
  let tenantCapabilityFallback = false;

  for (const block of input.blocks) {
    const candidate = selectCandidate(block);
    if (!candidate.type) {
      explanatoryBlocks.push(block);
      continue;
    }
    if (!isAllowed(candidate.type, allowed)) {
      if (capabilities && block.intent === 'knowledge_check') throw new ComponentCapabilityError('ASSESSMENT_TENANT_CAPABILITY_GAP', input.unit_path);
      if (capabilities && (block.importance === 'core' || block.importance === 'critical' || block.metadata?.required === true)) {
        throw new ComponentCapabilityError('MANDATORY_COMPONENT_CAPACITY_EXCEEDED', input.unit_path);
      }
      tenantCapabilityFallback = true;
      explanatoryBlocks.push(block);
      continue;
    }
    if (candidate.type === 'la_faq') faqCandidates.push({ block, candidate });
    else if (candidate.type === 'problem') assessmentCandidates.push({ block, candidate });
    else instructionalCandidates.push({ block, candidate });
  }

  const isRequired = (block: SemanticLearningBlock) => block.importance === 'core'
    || block.importance === 'critical' || block.importance === 'assessment' || block.metadata?.required === true;
  const maxComponents = capabilities?.max_components_per_unit ?? 4;
  if (capabilities && assessmentCandidates.length && !capabilities.assessment_enabled) {
    throw new ComponentCapabilityError('ASSESSMENT_TENANT_CAPABILITY_GAP', input.unit_path);
  }
  if (capabilities && assessmentCandidates.length > capabilities.max_assessments_per_unit) {
    throw new ComponentCapabilityError('ASSESSMENT_PLAN_DOWNSTREAM_CAPABILITY_GAP', input.unit_path);
  }

  let plans: PlannedLearningComponent[] = [];
  if (explanatoryBlocks.length > 0 || tenantCapabilityFallback) {
    if (!isAllowed('html', allowed)) {
      throw new Error('Tenant has disabled html, so Lesson Author cannot render required explanatory content.');
    }
    const htmlBlocks = explanatoryBlocks.length > 0 ? explanatoryBlocks : input.blocks;
    plans.push(makePlan('html', htmlBlocks, htmlBlocks.some(block => block.intent === 'warning')
      ? 'WARNING_EXPLANATION'
      : htmlBlocks.some(block => block.intent === 'procedure')
        ? 'PROCEDURE_EXPLANATION'
        : tenantCapabilityFallback ? 'TENANT_CAPABILITY_FALLBACK' : 'EXPLANATION_DEFAULT'));
  }

  const candidates = [...instructionalCandidates, ...assessmentCandidates, ...faqCandidates]
    .sort((left, right) => {
      if (isRequired(left.block) !== isRequired(right.block)) return isRequired(left.block) ? -1 : 1;
      const phase = (type: LessonAuthorComponentType | null) => type === 'la_faq' ? 3 : type === 'problem' ? 2 : 1;
      return phase(left.candidate.type) - phase(right.candidate.type)
        || AI_COMPONENT_REGISTRY[left.candidate.type!].selection_priority
          - AI_COMPONENT_REGISTRY[right.candidate.type!].selection_priority;
    });
  const availableSlots = Math.max(0, maxComponents - plans.length);
  const requiredOverflow = candidates.slice(availableSlots).some(candidate => isRequired(candidate.block));
  if (capabilities && requiredOverflow) {
    throw new ComponentCapabilityError('MANDATORY_COMPONENT_CAPACITY_EXCEEDED', input.unit_path);
  }
  for (const selected of candidates.slice(0, availableSlots)) {
    plans.push(makePlan(selected.candidate.type!, [selected.block], selected.candidate.reason_code));
  }

  // Blocks that require explanatory rendering, lack safe interaction evidence,
  // or hit a tenant capability fallback were already collected into the HTML
  // plan above.  A specialized candidate omitted only because the bounded
  // component budget is full must not be silently rewritten as generic HTML:
  // that would change the instructional treatment and often duplicate facts.
  const representedFactsBeforeOwnership = new Set(plans.flatMap(plan => plan.source_fact_ids ?? []));
  const omittedWithUniqueEvidence = candidates.slice(availableSlots).some(({ block }) =>
    block.source_fact_ids.some(factId => !representedFactsBeforeOwnership.has(factId)));
  if (omittedWithUniqueEvidence) {
    throw new ComponentCapabilityError('MANDATORY_COMPONENT_CAPACITY_EXCEEDED', input.unit_path);
  }

  const phaseOrder: Record<LessonAuthorComponentType, number> = {
    html: 0, la_diagram: 1, la_sortable: 2, la_crossword: 3, problem: 4, la_faq: 5,
  };
  plans.sort((left, right) => phaseOrder[left.type] - phaseOrder[right.type]);

  // Canonical facts belong to the unit and are assigned exactly once to the
  // earliest selected treatment that uses them. Later treatments retain the
  // same facts as read-only evidence instead of duplicating ownership.
  const ownedFacts = new Set<string>();
  for (const plan of plans) {
    const candidatesForPlan = [...new Set(plan.source_fact_ids ?? [])];
    plan.source_fact_ids = candidatesForPlan.filter(factId => !ownedFacts.has(factId));
    plan.source_fact_ids.forEach(factId => ownedFacts.add(factId));
    plan.supporting_evidence_fact_ids = candidatesForPlan.filter(factId => ownedFacts.has(factId)
      && !plan.source_fact_ids?.includes(factId));
  }
  const unownedFacts = sourceFactIds.filter(factId => !ownedFacts.has(factId));
  if (capabilities && unownedFacts.length > 0) {
    throw new ComponentCapabilityError('MANDATORY_COMPONENT_CAPACITY_EXCEEDED', input.unit_path);
  }
  const finalOwner = plans.find(plan => plan.type === 'html') ?? plans[0];
  if (!finalOwner) throw new Error('Component planner produced no usable treatment.');
  finalOwner.source_fact_ids = [...new Set([...(finalOwner.source_fact_ids ?? []), ...unownedFacts])];

  for (const plan of plans) {
    if (capabilities) {
      plan.component_plan_id = componentPlanId(input.unit_path!, plan.type, plan.learning_block_ids ?? []);
      plan.learning_objective_refs = [...new Set(input.blocks.filter(b => plan.learning_block_ids?.includes(b.id)).flatMap(b => b.learning_objective_refs ?? []))];
    }
    if (!GENERATABLE_TYPES.has(plan.type)) throw new Error(`Registry selected unsupported AI component ${plan.type}.`);
    if (!isAllowed(plan.type, allowed)) {
      throw new Error(`Tenant does not permit Lesson Author component ${plan.type}.`);
    }
  }
  if (plans.some((plan, index) => plan.type === 'html' && index !== 0)
    || plans.some((plan, index) => plan.type === 'la_faq' && index !== plans.length - 1)) {
    throw new Error('Component planner ordering invariant failed.');
  }
  if (capabilities) assertComponentInstancePlan(plans);
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
export function flattenOrderedLearningContent(value: unknown): Record<string, unknown> {
  const content = asRecord(value);
  if (content.version !== 2) {
    if ((content.version != null && content.version !== 1) || (Array.isArray(content.sections) ? content.sections.length > 0 : content.sections != null)) throw new Error('Unsupported semantic content version.');
    return content;
  }
  const legacy = ['heading', 'paragraphs', 'bullet_points', 'ordered_steps', 'warnings', 'comparison_rows'];
  if (Object.keys(content).some(k => !['version', 'sections', ...legacy].includes(k))
      || legacy.some(k => Array.isArray(content[k]) ? (content[k] as unknown[]).length > 0 : Boolean(content[k]))) throw new Error('Mixed ordered and legacy semantic content.');
  if (!Array.isArray(content.sections) || content.sections.length < 1 || content.sections.length > 12) throw new Error('Ordered content requires 1-12 sections.');
  const mapping: Record<string, string> = { paragraph: 'paragraphs', task: 'paragraphs', bullets: 'bullet_points', steps: 'ordered_steps', warning: 'warnings', table: 'comparison_rows' };
  const flat: Record<string, unknown[]> = { paragraphs: [], bullet_points: [], ordered_steps: [], warnings: [], comparison_rows: [] };
  for (const raw of content.sections) {
    const section = asRecord(raw);
    if (Object.keys(section).some(k => !['heading', 'learning_block_ids', 'blocks'].includes(k))
      || typeof section.heading !== 'string' || !section.heading.trim() || section.heading.trim().length > 240) throw new Error('Invalid semantic section heading.');
    const refs = section.learning_block_ids ?? [];
    if (!Array.isArray(refs) || refs.length > 24 || refs.some(r => typeof r !== 'string' || !r.trim() || r.length > 160) || new Set(refs).size !== refs.length) throw new Error('Invalid section learning block references.');
    if (!Array.isArray(section.blocks) || section.blocks.length < 1 || section.blocks.length > 12) throw new Error('Section requires 1-12 ordered blocks.');
    for (const rawBlock of section.blocks) {
      const block = asRecord(rawBlock);
      if (typeof block.kind !== 'string' || !Object.hasOwn(mapping, block.kind) || Object.keys(block).some(k => !['kind', 'text', 'items', 'rows'].includes(k))) throw new Error('Unknown ordered block kind or field.');
      const field = block.kind === 'table' ? 'rows' : ['bullets', 'steps'].includes(block.kind) ? 'items' : 'text';
      if (['text', 'items', 'rows'].filter(k => k !== field).some(k => Array.isArray(block[k]) ? (block[k] as unknown[]).length > 0 : Boolean(block[k]))) throw new Error('Mixed ordered block fields.');
      const data = block[field];
      if (field === 'text' ? typeof data !== 'string' || !data.trim() : !Array.isArray(data) || data.length === 0) throw new Error('Ordered block content required.');
      flat[mapping[block.kind]].push(...(field === 'text' ? [data] : data as unknown[]));
    }
  }
  return flat;
}

export function validateSemanticLearningHtmlPayload(value: unknown): string | null {
  let content: Record<string, unknown>;
  try { content = flattenOrderedLearningContent(value); } catch (error) { return (error as Error).message; }
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
  if (content.version === 2) {
    const fragments: string[] = [];
    for (const raw of content.sections as unknown[]) {
      const section = asRecord(raw);
      fragments.push(`<h2>${escapeHtmlText(section.heading)}</h2>`);
      for (const rawBlock of section.blocks as unknown[]) {
        const block = asRecord(rawBlock);
        if (block.kind === 'table') {
          fragments.push(`<table><tbody>${(block.rows as Array<{label: string; value: string}>).map(row => `<tr><th>${escapeHtmlText(row.label)}</th><td>${escapeHtmlText(row.value)}</td></tr>`).join('')}</tbody></table>`);
        } else if (block.kind === 'bullets' || block.kind === 'steps') {
          const tag = block.kind === 'steps' ? 'ol' : 'ul';
          fragments.push(`<${tag}>${(block.items as string[]).map(item => `<li>${escapeHtmlText(item)}</li>`).join('')}</${tag}>`);
        } else {
          const tag = block.kind === 'warning' ? 'blockquote' : 'p';
          fragments.push(`<${tag}>${escapeHtmlText(block.text)}</${tag}>`);
        }
      }
    }
    const html = sanitizeLessonAuthorHtml(fragments.join(''));
    const failure = validateLessonAuthorHtmlContract(html);
    if (failure) throw new Error(`Deterministic semantic HTML is invalid: ${failure}`);
    return html;
  }
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
  for (const item of diagram.diagrams) {
    const invalidText = item.nodes.some(node => {
      const data = asRecord(node.data);
      return (typeof data.label === 'string' && normalizeDiagramDisplayText(data.label, 140) !== data.label)
        || (typeof data.tooltip === 'string' && normalizeDiagramDisplayText(data.tooltip, 500) !== data.tooltip);
    }) || item.edges.some(edge => typeof edge.label === 'string'
      && normalizeDiagramDisplayText(edge.label, 120) !== edge.label);
    if (invalidText) throw new Error('Diagram contains escaped newline or control tokens in learner-facing text.');
    const geometryFailure = validateGeneratedDiagramGeometry(item.nodes);
    if (geometryFailure) throw new Error(geometryFailure);
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
