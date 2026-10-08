import type { LessonAuthorComponentType } from '../course-authoring/course-authoring.service.js';

export type LessonAuthorInstructionalPurpose =
  | 'explain'
  | 'assess'
  | 'clarify'
  | 'sequence'
  | 'relationship'
  | 'terminology';

export type LessonAuthorStructuredArtifactType =
  | 'ordered_list'
  | 'checklist'
  | 'table'
  | 'warning'
  | 'requirement'
  | 'exception'
  | 'comparison';

export interface LessonAuthorStructuredArtifactRequirement {
  type: LessonAuthorStructuredArtifactType;
  minimum_items?: number;
}

export interface LessonAuthorContentContractPlan {
  component_plan_id?: string;
  learning_objective_refs?: string[];
  type: LessonAuthorComponentType;
  title?: string;
  rationale?: string;
  purpose?: LessonAuthorInstructionalPurpose;
  source_fact_ids?: string[];
  /** Read-only grounding for V5 reinforcement; never canonical ownership. */
  supporting_evidence_fact_ids?: string[];
  content_requirements?: string[];
  reason_code?: string;
  learning_block_ids?: string[];
  required_artifacts?: LessonAuthorStructuredArtifactRequirement[];
}

export interface LessonAuthorContentContractUnit {
  source_fact_ids?: string[];
  /** Facts resolved from approved supporting evidence scopes, never owned here. */
  supporting_evidence_fact_ids?: string[];
  component_plan?: LessonAuthorContentContractPlan[];
}

export interface LessonAuthorGeneratedComponentContract {
  component_plan_id?: string;
  type: LessonAuthorComponentType;
  source_fact_ids?: string[];
  covered_source_fact_ids?: string[];
  supporting_evidence_fact_ids?: string[];
  html?: string;
  data?: unknown;
}

export interface LessonAuthorLearnerContentPurityContext {
  exact_identifiers?: readonly string[];
}

const SAFE_HTML_TAGS = new Set([
  'h2', 'h3', 'p', 'ul', 'ol', 'li', 'strong', 'blockquote',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
]);

const PURPOSE_BY_COMPONENT_TYPE: Record<LessonAuthorComponentType, LessonAuthorInstructionalPurpose> = {
  html: 'explain',
  problem: 'assess',
  la_faq: 'clarify',
  la_sortable: 'sequence',
  la_crossword: 'terminology',
  la_diagram: 'relationship',
};

const DEFAULT_CONTENT_REQUIREMENT: Record<LessonAuthorComponentType, string> = {
  html: 'Explain every assigned source fact accurately and in a learnable structure.',
  problem: 'Assess understanding of the assigned source facts without adding unsupported facts.',
  la_faq: 'Clarify source-grounded questions or common misunderstandings using the assigned facts.',
  la_sortable: 'Preserve the source-supported order of the assigned procedure or process.',
  la_crossword: 'Practice only source-supported terminology represented by the assigned facts.',
  la_diagram: 'Show the source-supported relationship, hierarchy, or flow represented by the assigned facts.',
};

function uniqueFactIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const values = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const factId = item.trim();
    if (factId) values.add(factId);
  }
  return Array.from(values);
}

function normalizePurpose(value: unknown, type: LessonAuthorComponentType): LessonAuthorInstructionalPurpose {
  const purpose = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (purpose === 'explain' || purpose === 'assess' || purpose === 'clarify'
    || purpose === 'sequence' || purpose === 'relationship' || purpose === 'terminology') {
    return purpose;
  }
  return PURPOSE_BY_COMPONENT_TYPE[type];
}

function normalizeArtifactRequirement(value: unknown): LessonAuthorStructuredArtifactRequirement | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const type = typeof raw.type === 'string' ? raw.type.trim().toLowerCase() : '';
  if (!['ordered_list', 'checklist', 'table', 'warning', 'requirement', 'exception', 'comparison'].includes(type)) {
    return null;
  }
  const minimum = typeof raw.minimum_items === 'number' && Number.isInteger(raw.minimum_items)
    ? raw.minimum_items
    : typeof raw.minimum_items === 'string' && /^\d+$/.test(raw.minimum_items.trim())
      ? Number.parseInt(raw.minimum_items, 10)
      : undefined;
  return {
    type: type as LessonAuthorStructuredArtifactType,
    ...(minimum && minimum > 0 ? { minimum_items: Math.min(minimum, 100) } : {}),
  };
}

function normalizeContentRequirements(value: unknown, type: LessonAuthorComponentType): string[] {
  const values = Array.isArray(value)
    ? value
      .filter((item): item is string => typeof item === 'string')
      .map(item => item.trim())
      .filter(Boolean)
      .slice(0, 8)
    : [];
  return values.length > 0 ? Array.from(new Set(values)) : [DEFAULT_CONTENT_REQUIREMENT[type]];
}

/**
 * Fills omitted Phase-1 plan fields deterministically after source facts have
 * been allocated. Supplied IDs are never silently rewritten: invalid IDs are
 * rejected by validateLessonAuthorContentContractUnit.
 */
export function completeLessonAuthorContentContract(
  unit: LessonAuthorContentContractUnit,
): LessonAuthorContentContractPlan[] {
  const unitFactIds = uniqueFactIds(unit.source_fact_ids);
  const plan = Array.isArray(unit.component_plan) ? unit.component_plan : [];
  const nonHtmlPlans = plan.filter(item => item.type !== 'html');
  let nonHtmlCursor = 0;

  return plan.map((item): LessonAuthorContentContractPlan => {
    const suppliedFactIds = uniqueFactIds(item.source_fact_ids);
    let sourceFactIds = suppliedFactIds;
    if (sourceFactIds.length === 0 && unitFactIds.length > 0 && !item.component_plan_id) {
      if (item.type === 'html') {
        // The explanatory component is the guaranteed owner of every source
        // fact, including requirements and warnings which must not be lost.
        sourceFactIds = unitFactIds;
      } else {
        const targetIndex = nonHtmlPlans.length > 0 ? nonHtmlCursor % unitFactIds.length : 0;
        sourceFactIds = [unitFactIds[targetIndex]];
        nonHtmlCursor += 1;
      }
    }
    const artifacts = Array.isArray(item.required_artifacts)
      ? item.required_artifacts
        .map(normalizeArtifactRequirement)
        .filter((artifact): artifact is LessonAuthorStructuredArtifactRequirement => Boolean(artifact))
      : [];
    return {
      ...item,
      purpose: normalizePurpose(item.purpose, item.type),
      source_fact_ids: sourceFactIds,
      content_requirements: normalizeContentRequirements(item.content_requirements, item.type),
      ...(artifacts.length > 0 ? { required_artifacts: artifacts } : {}),
    };
  });
}

export function validateLessonAuthorContentContractUnit(
  unit: LessonAuthorContentContractUnit,
): string | null {
  const unitFactIds = uniqueFactIds(unit.source_fact_ids);
  const supportingEvidenceFactIds = uniqueFactIds(unit.supporting_evidence_fact_ids);
  const plan = Array.isArray(unit.component_plan) ? unit.component_plan : [];
  if (unitFactIds.length === 0 && supportingEvidenceFactIds.length === 0) {
    return 'Unit must declare canonical source facts or resolved read-only supporting evidence.';
  }
  if (plan.length === 0) return 'Unit must contain a component plan for the Phase-1 content contract.';

  if (unitFactIds.length === 0) {
    const knownSupportingFacts = new Set(supportingEvidenceFactIds);
    for (const component of plan) {
      if (uniqueFactIds(component.source_fact_ids).length > 0) {
        return `Supporting-only component ${component.type} must not claim canonical source fact ownership.`;
      }
      const evidenceIds = uniqueFactIds(component.supporting_evidence_fact_ids);
      if (evidenceIds.length === 0) return `Supporting-only component ${component.type} needs resolved supporting evidence.`;
      const invalid = evidenceIds.filter(factId => !knownSupportingFacts.has(factId));
      if (invalid.length > 0) return `Supporting-only component ${component.type} references evidence outside its approved support scope.`;
    }
    return null;
  }

  const knownFactIds = new Set(unitFactIds);
  const knownEvidenceFactIds = new Set([...unitFactIds, ...supportingEvidenceFactIds]);
  const ownedFactIds = new Set<string>();
  for (const component of plan) {
    const sourceFactIds = uniqueFactIds(component.source_fact_ids);
    if (component.component_plan_id && !sourceFactIds.length) {
      const support = uniqueFactIds(component.supporting_evidence_fact_ids);
      if (!support.length || support.some(id => !knownEvidenceFactIds.has(id))) return 'Supporting component instance requires exact approved read-only evidence.';
      continue;
    }
    if (sourceFactIds.length === 0) {
      return `Component ${component.type} must own at least one source_fact_id.`;
    }
    const invalid = sourceFactIds.filter(factId => !knownFactIds.has(factId));
    if (invalid.length > 0) {
      return `Component ${component.type} owns source facts outside its unit: ${invalid.slice(0, 4).join(', ')}.`;
    }
    for (const factId of sourceFactIds) ownedFactIds.add(factId);
  }
  const unowned = unitFactIds.filter(factId => !ownedFactIds.has(factId));
  if (unowned.length > 0) {
    return `Unit source facts have no owning component: ${unowned.slice(0, 6).join(', ')}.`;
  }
  return null;
}

function countTags(html: string, tag: string): number {
  return (html.match(new RegExp(`<${tag}(?:\\s[^>]*)?>`, 'gi')) ?? []).length;
}

function countListItems(html: string, tag: 'ol' | 'ul'): number {
  const matches = html.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi')) ?? [];
  return matches.reduce((total, segment) => total + countTags(segment, 'li'), 0);
}

/**
 * A content-contract failure: a stable reason code (safe to log, shared with the
 * Python acceptance mirror `landa-ai-rag/app/idm/node_acceptance.py`) and the
 * human message the string APIs below keep returning.
 */
export interface LessonAuthorContentFinding {
  code: string;
  message: string;
  /** 0-based component index for unit coverage findings; null for a unit-level finding. */
  component_index?: number | null;
}

const contentFinding = (code: string, message: string, componentIndex?: number | null): LessonAuthorContentFinding =>
  componentIndex === undefined ? { code, message } : { code, message, component_index: componentIndex };

function validateArtifactRequirement(
  html: string,
  artifact: LessonAuthorStructuredArtifactRequirement,
): string | null {
  const minimum = artifact.minimum_items ?? 1;
  if (artifact.type === 'ordered_list') {
    return countListItems(html, 'ol') >= minimum ? null : `Required ordered_list needs at least ${minimum} list items.`;
  }
  if (artifact.type === 'checklist') {
    return countListItems(html, 'ul') >= minimum ? null : `Required checklist needs at least ${minimum} list items.`;
  }
  if (artifact.type === 'table' || artifact.type === 'comparison') {
    return countTags(html, 'table') > 0 && countTags(html, 'tr') >= Math.max(2, minimum)
      ? null
      : `Required ${artifact.type} needs a semantic table with at least ${Math.max(2, minimum)} rows.`;
  }
  if (artifact.type === 'warning' || artifact.type === 'requirement' || artifact.type === 'exception') {
    return countTags(html, 'blockquote') >= minimum
      ? null
      : `Required ${artifact.type} needs a blockquote with clear context.`;
  }
  return null;
}

function visibleHtmlText(value: string): string {
  return value.replace(/<[^>]+>/g, ' ').replace(/&(?:[a-z]+|#\d+|#x[a-f0-9]+);/gi, ' ')
    .replace(/\s+/g, ' ').trim();
}

function normalizedInstructionalText(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export interface LessonAuthorHtmlQualityOptions {
  /**
   * IDM worksheet (html slot with role practice): its template table and worked
   * example legitimately repeat row labels and blank-cell guidance, so repeated
   * table cells (th/td) are not a repeated block. Paragraphs, list items and
   * callouts must still be unique.
   */
  allow_repeated_table_cells?: boolean;
}

/** Learner-facing HTML quality gate shared by provider and deterministic fallback. */
export function validateLessonAuthorHtmlInstructionalQuality(
  html: string,
  purityContext: LessonAuthorLearnerContentPurityContext = {},
  options: LessonAuthorHtmlQualityOptions = {},
): string | null {
  return lessonAuthorHtmlInstructionalQualityFinding(html, purityContext, options)?.message ?? null;
}

/** `validateLessonAuthorHtmlInstructionalQuality` with its stable reason code. */
export function lessonAuthorHtmlInstructionalQualityFinding(
  html: string,
  purityContext: LessonAuthorLearnerContentPurityContext = {},
  options: LessonAuthorHtmlQualityOptions = {},
): LessonAuthorContentFinding | null {
  const visible = visibleHtmlText(html);
  const folded = normalizedInstructionalText(visible);
  for (const phrase of [
    'ra soat y trong tai lieu nguon',
    'theo dung thu tu xuat hien trong tai lieu nguon',
    'duoc giu nguyen de nguoi dung ra soat theo nguon',
    'review the source point',
    'displayed order in the source',
    'retained for source review',
  ]) {
    if (folded.includes(phrase)) {
      return contentFinding('HTML_SOURCE_REVIEW_COPY', 'HTML contains internal source-review copy instead of learner instruction.');
    }
  }
  if (/\b(?:theo|dua tren|trich tu)\s+(?:tai lieu|nguon|source|document)\b/iu.test(folded)
    || /\b(?:trong|inside)\s+(?:tai lieu nguon|source document)\b/iu.test(folded)
    || /\b(?:tai lieu|document|source)\s+(?:neu|mo ta|states?|describes?)\b/iu.test(folded)
    || /\b(?:nguon|source|tai lieu nguon)\s*[:：]/iu.test(folded)) {
    return contentFinding('HTML_SOURCE_ATTRIBUTION', 'HTML exposes source attribution in learner-facing content.');
  }
  if (/\b(?:trang|page|slide|chunk|doan nguon|muc nguon)\s*(?:so|number|no\.?|#)?\s*[:#-]?\s*\d{1,6}\b/iu.test(folded)) {
    return contentFinding('HTML_SOURCE_LOCATOR', 'HTML exposes a source locator in learner-facing content.');
  }
  if (/(?:^|\s)[^<>\n]{0,160}\.(?:pdf|pptx?|docx?|xlsx?|csv|txt|rtf)(?=$|\s|[),.;:])/iu.test(visible)) {
    return contentFinding('HTML_SOURCE_FILENAME', 'HTML exposes a source filename in learner-facing content.');
  }
  if (/(?:^|\s)(?:p\d+[-_]f\d+|src[-_]\d+(?:[-_]f\d+)?|(?:component|block|fact|scope)[-_](?:[a-z0-9]+[-_]?){1,8})(?=$|\s|[),.;:])/iu.test(visible)) {
    return contentFinding('HTML_INTERNAL_IDENTIFIER', 'HTML exposes an internal identifier in learner-facing content.');
  }
  for (const identifier of purityContext.exact_identifiers ?? []) {
    const candidate = typeof identifier === 'string' ? identifier.trim() : '';
    if (candidate.length < 3) continue;
    const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`, 'iu').test(visible)) {
      return contentFinding('HTML_INTERNAL_IDENTIFIER', 'HTML exposes an internal identifier in learner-facing content.');
    }
  }
  if (/(.)\1{5,}/iu.test(visible)) return contentFinding('HTML_OCR_NOISE', 'HTML contains repeated OCR noise.');
  const segments = Array.from(html.matchAll(/<(p|li|th|td|blockquote)>\s*([^<]+?)\s*<\//giu))
    .map(match => ({ tag: match[1].toLowerCase(),
      text: match[2].replace(/&(?:[a-z]+|#\d+|#x[a-f0-9]+);/gi, ' ').replace(/\s+/g, ' ').trim() }))
    .filter(segment => segment.text);
  for (const { text: segment } of segments) {
    if (/^(?:https?:\/\/|www\.)\S+$/iu.test(segment)
      || /^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}$/u.test(segment)
      || /^(?:thank you|thanks|cảm ơn|xin cảm ơn)$/iu.test(segment)) {
      return contentFinding('HTML_BOILERPLATE', 'HTML contains non-instructional contact or presentation boilerplate.');
    }
  }
  const meaningful = segments
    .filter(segment => !options.allow_repeated_table_cells || (segment.tag !== 'th' && segment.tag !== 'td'))
    .map(segment => normalizedInstructionalText(segment.text)).filter(value => value.length >= 12);
  if (new Set(meaningful).size !== meaningful.length) {
    return contentFinding('HTML_DUPLICATE_BLOCK', 'HTML repeats a learner-facing block.');
  }
  return null;
}

/** AI ID emits exactly one supported assessment shape: single-answer MCQ. */
export function validateLessonAuthorSingleChoiceProblem(value: unknown): string | null {
  return lessonAuthorSingleChoiceProblemFinding(value)?.message ?? null;
}

/** `validateLessonAuthorSingleChoiceProblem` with its stable reason code. */
export function lessonAuthorSingleChoiceProblemFinding(value: unknown): LessonAuthorContentFinding | null {
  if (typeof value !== 'string' || !value.trim()) return contentFinding('PROBLEM_XML_EMPTY', 'Problem XML must not be empty.');
  if (!/<multiplechoiceresponse>/i.test(value) || !/<choicegroup\s+type="MultipleChoice">/i.test(value)) {
    return contentFinding('PROBLEM_NOT_SINGLE_CHOICE', 'AI Instructional Design problem must be single-answer multiple choice.');
  }
  if (/<(?:stringresponse|numericalresponse|optionresponse|checkboxgroup|choiceresponse)>/i.test(value)) {
    return contentFinding('PROBLEM_UNSUPPORTED_RESPONSE',
      'AI Instructional Design problem contains an unsupported response type.');
  }
  const labels = Array.from(value.matchAll(/<label>([\s\S]*?)<\/label>/gi));
  if (labels.length !== 1 || visibleHtmlText(labels[0]?.[1] ?? '').length < 20) {
    return contentFinding('PROBLEM_QUESTION_INCOMPLETE', 'Multiple-choice problem needs one complete question.');
  }
  const choices = Array.from(value.matchAll(/<choice\s+correct="(true|false)">([\s\S]*?)<\/choice>/gi));
  if (choices.length < 3 || choices.length > 6) {
    return contentFinding('PROBLEM_CHOICE_COUNT', 'Multiple-choice problem needs three to six choices.');
  }
  if (choices.filter(choice => choice[1].toLowerCase() === 'true').length !== 1) {
    return contentFinding('PROBLEM_CORRECT_COUNT', 'Multiple-choice problem needs exactly one correct answer.');
  }
  const choiceTexts = choices.map(choice => visibleHtmlText(choice[2]));
  const normalizedChoices = choiceTexts.map(normalizedInstructionalText);
  if (choiceTexts.some(text => text.length < 8) || new Set(normalizedChoices).size !== normalizedChoices.length) {
    return contentFinding('PROBLEM_CHOICES_NOT_DISTINCT', 'Multiple-choice problem choices must be complete and distinct.');
  }
  const correct = choiceTexts[choices.findIndex(choice => choice[1].toLowerCase() === 'true')] ?? '';
  if (/^(?:https?:\/\/|www\.)\S+$/iu.test(correct)
    || /^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}$/u.test(correct)
    || /^\+?\d[\d\s().-]{7,}\d$/u.test(correct)) {
    return contentFinding('PROBLEM_CORRECT_BOILERPLATE', 'Multiple-choice correct answer is non-instructional source boilerplate.');
  }
  const solution = value.match(/<solution>[\s\S]*?<p>([\s\S]*?)<\/p>[\s\S]*?<\/solution>/i);
  if (!solution || visibleHtmlText(solution[1]).length < 20) {
    return contentFinding('PROBLEM_EXPLANATION_MISSING', 'Multiple-choice problem needs a source-grounded explanation.');
  }
  return null;
}

/** Removes unsupported tags and attributes before content can reach course_blocks. */
export function sanitizeLessonAuthorHtml(value: unknown): string {
  const raw = typeof value === 'string' ? value : '';
  const stripped = raw
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object[^>]*>[\s\S]*?<\/object>/gi, '')
    .replace(/<embed[^>]*>[\s\S]*?<\/embed>/gi, '');

  return stripped.replace(/<\/?([a-z0-9]+)(?:\s[^>]*)?>/gi, (tag, tagName: string) => {
    const normalized = tagName.toLowerCase();
    if (!SAFE_HTML_TAGS.has(normalized)) return '';
    return tag.startsWith('</') ? `</${normalized}>` : `<${normalized}>`;
  }).trim();
}

export function validateLessonAuthorHtmlContract(
  html: string,
  requiredArtifacts: readonly LessonAuthorStructuredArtifactRequirement[] = [],
): string | null {
  return lessonAuthorHtmlContractFinding(html, requiredArtifacts)?.message ?? null;
}

/** `validateLessonAuthorHtmlContract` with its stable reason code. */
export function lessonAuthorHtmlContractFinding(
  html: string,
  requiredArtifacts: readonly LessonAuthorStructuredArtifactRequirement[] = [],
): LessonAuthorContentFinding | null {
  if (!html.trim()) return contentFinding('HTML_EMPTY', 'HTML content must not be empty.');
  const outside = () => contentFinding('HTML_TEXT_OUTSIDE_ROOT',
    'HTML contains learner text outside a supported semantic root element.');
  const stack: string[] = [];
  const tagPattern = /<\/?([a-z0-9]+)>/gi;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(html)) !== null) {
    if (stack.length === 0 && visibleHtmlText(html.slice(cursor, match.index))) return outside();
    const tag = match[1].toLowerCase();
    if (!SAFE_HTML_TAGS.has(tag)) return contentFinding('HTML_UNSUPPORTED_TAG', `HTML contains unsupported tag: ${tag}.`);
    if (match[0].startsWith('</')) {
      if (stack.pop() !== tag) return contentFinding('HTML_INVALID_NESTING', `HTML has invalid ${tag} nesting.`);
    } else {
      stack.push(tag);
    }
    cursor = tagPattern.lastIndex;
  }
  if (stack.length > 0) return contentFinding('HTML_UNCLOSED_TAG', `HTML has unclosed ${stack[stack.length - 1]} tag.`);
  if (visibleHtmlText(html.slice(cursor))) return outside();
  if (/<li>/.test(html) && !/<(?:ul|ol)>/i.test(html)) {
    return contentFinding('HTML_LIST_ITEM_OUTSIDE_LIST', 'HTML list items must be inside ul or ol.');
  }
  if (/<(?:th|td)>/i.test(html) && !/<tr>/i.test(html)) {
    return contentFinding('HTML_CELL_OUTSIDE_ROW', 'HTML table cells must be inside a table row.');
  }
  if (/<tr>/i.test(html) && !/<table>/i.test(html)) {
    return contentFinding('HTML_ROW_OUTSIDE_TABLE', 'HTML table rows must be inside a table.');
  }
  for (const artifact of requiredArtifacts) {
    const failure = validateArtifactRequirement(html, artifact);
    if (failure) return contentFinding('HTML_REQUIRED_ARTIFACT_MISSING', failure);
  }
  return null;
}

export interface LessonAuthorUnitCoverageOptions {
  enforceGeneratedContentQuality?: boolean;
  /** 0-based indexes of IDM worksheet html slots (see `LessonAuthorHtmlQualityOptions`). */
  worksheet_component_indexes?: ReadonlySet<number>;
}

export function validateLessonAuthorGeneratedUnitCoverage(
  unit: LessonAuthorContentContractUnit,
  components: readonly LessonAuthorGeneratedComponentContract[],
  purityContext: LessonAuthorLearnerContentPurityContext = {},
  options: LessonAuthorUnitCoverageOptions = {},
): string | null {
  return lessonAuthorGeneratedUnitCoverageFinding(unit, components, purityContext, options)?.message ?? null;
}

/** `validateLessonAuthorGeneratedUnitCoverage` with its stable reason code and component index. */
export function lessonAuthorGeneratedUnitCoverageFinding(
  unit: LessonAuthorContentContractUnit,
  components: readonly LessonAuthorGeneratedComponentContract[],
  purityContext: LessonAuthorLearnerContentPurityContext = {},
  options: LessonAuthorUnitCoverageOptions = {},
): LessonAuthorContentFinding | null {
  const plan = Array.isArray(unit.component_plan) ? unit.component_plan : [];
  if (components.length !== plan.length) {
    return contentFinding('COVERAGE_COMPONENT_COUNT', 'Generated component count does not match the approved Blueprint plan.', null);
  }
  const unitFactIds = new Set(uniqueFactIds(unit.source_fact_ids));
  const unitSupportingEvidenceFactIds = new Set(uniqueFactIds(unit.supporting_evidence_fact_ids));
  const allowedSupportingEvidenceFactIds = new Set([...unitFactIds, ...unitSupportingEvidenceFactIds]);
  const coveredFactIds = new Set<string>();

  for (const [index, component] of components.entries()) {
    const at = (code: string, message: string) => contentFinding(code, message, index);
    if (plan[index]?.component_plan_id && component.component_plan_id !== plan[index].component_plan_id) {
      return at('COVERAGE_INSTANCE_MISMATCH', 'Generated component instance does not match its approved Blueprint plan.');
    }
    const expected = plan[index];
    if (component.type !== expected.type) {
      return at('COVERAGE_TYPE_CHANGED', `Generated component ${index + 1} changed the approved component type.`);
    }
    const expectedOwnerIds = new Set(uniqueFactIds(expected.source_fact_ids));
    const declaredOwnerIds = new Set(uniqueFactIds(component.source_fact_ids));
    if (expectedOwnerIds.size !== declaredOwnerIds.size || [...expectedOwnerIds].some(id => !declaredOwnerIds.has(id))) {
      return at('COVERAGE_OWNERSHIP_MISMATCH',
        `Generated component ${index + 1} does not match its Blueprint source fact ownership.`);
    }
    const expectedSupportingEvidenceIds = new Set(uniqueFactIds(expected.supporting_evidence_fact_ids));
    const declaredSupportingEvidenceIds = new Set(uniqueFactIds(component.supporting_evidence_fact_ids));
    if (expectedSupportingEvidenceIds.size !== declaredSupportingEvidenceIds.size
      || [...expectedSupportingEvidenceIds].some(id => !declaredSupportingEvidenceIds.has(id))) {
      return at('COVERAGE_SUPPORT_MISMATCH', `Generated component ${index + 1} does not match its approved supporting evidence.`);
    }
    const invalidSupportingEvidence = [...declaredSupportingEvidenceIds]
      .filter(id => !allowedSupportingEvidenceFactIds.has(id));
    if (invalidSupportingEvidence.length > 0) {
      return at('COVERAGE_SUPPORT_OUTSIDE_UNIT',
        `Generated component ${index + 1} references supporting evidence outside its unit.`);
    }
    if (unitFactIds.size === 0 && declaredSupportingEvidenceIds.size === 0) {
      return at('COVERAGE_SUPPORT_REQUIRED',
        `Generated supporting-only component ${index + 1} must declare read-only supporting evidence.`);
    }
    const declaredCoverage = new Set(uniqueFactIds(component.covered_source_fact_ids));
    if (unitFactIds.size === 0 || (expected.component_plan_id && expectedOwnerIds.size === 0)) {
      if (declaredCoverage.size > 0) {
        return at('COVERAGE_SUPPORT_ONLY_CLAIM',
          `Generated supporting-only component ${index + 1} must not claim canonical source coverage.`);
      }
    } else if (declaredCoverage.size === 0) {
      return at('COVERAGE_DECLARATION_MISSING', `Generated component ${index + 1} must declare covered_source_fact_ids.`);
    }
    const invalidCoverage = [...declaredCoverage].filter(id => !unitFactIds.has(id));
    if (invalidCoverage.length > 0) {
      return at('COVERAGE_OUTSIDE_UNIT', `Generated component ${index + 1} covers source facts outside its unit.`);
    }
    const missingOwnedCoverage = [...expectedOwnerIds].filter(id => !declaredCoverage.has(id));
    if (missingOwnedCoverage.length > 0) {
      return at('COVERAGE_OWNED_OMITTED',
        `Generated component ${index + 1} omitted its required source facts from declared coverage.`);
    }
    for (const factId of declaredCoverage) coveredFactIds.add(factId);

    if (component.type === 'html') {
      const html = sanitizeLessonAuthorHtml(component.html ?? component.data);
      const formattingFailure = lessonAuthorHtmlContractFinding(html, expected.required_artifacts ?? []);
      if (formattingFailure) {
        return at(formattingFailure.code, `Generated HTML component ${index + 1}: ${formattingFailure.message}`);
      }
      if (options.enforceGeneratedContentQuality !== false) {
        const qualityFailure = lessonAuthorHtmlInstructionalQualityFinding(html, purityContext,
          { allow_repeated_table_cells: options.worksheet_component_indexes?.has(index) === true });
        if (qualityFailure) return at(qualityFailure.code, `Generated HTML component ${index + 1}: ${qualityFailure.message}`);
      }
    }
    if (component.type === 'problem' && component.data !== undefined
      && options.enforceGeneratedContentQuality !== false) {
      const problemFailure = lessonAuthorSingleChoiceProblemFinding(component.data);
      if (problemFailure) {
        return at(problemFailure.code, `Generated problem component ${index + 1}: ${problemFailure.message}`);
      }
    }
  }
  const missing = [...unitFactIds].filter(id => !coveredFactIds.has(id));
  return missing.length > 0 ? contentFinding('COVERAGE_UNIT_INCOMPLETE',
    `Generated components did not declare coverage for unit source facts: ${missing.slice(0, 6).join(', ')}.`, null) : null;
}

/** Blueprint drafts must never fall back to a chapter-wide single provider response. */
export function shouldUseBoundedLessonAuthorGeneration(
  hasBlueprintDraft: boolean,
  hasChapterScope: boolean,
): boolean {
  return hasBlueprintDraft || hasChapterScope;
}
