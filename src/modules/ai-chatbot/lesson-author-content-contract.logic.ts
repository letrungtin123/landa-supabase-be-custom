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
  const ownedFactIds = new Set<string>();
  for (const component of plan) {
    const sourceFactIds = uniqueFactIds(component.source_fact_ids);
    if (component.component_plan_id && !sourceFactIds.length) {
      const support = uniqueFactIds(component.supporting_evidence_fact_ids);
      if (!support.length || support.some(id => !supportingEvidenceFactIds.includes(id))) return 'Assessment instance requires exact approved read-only evidence.';
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
  if (!html.trim()) return 'HTML content must not be empty.';
  const stack: string[] = [];
  const tagPattern = /<\/?([a-z0-9]+)>/gi;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(html)) !== null) {
    const tag = match[1].toLowerCase();
    if (!SAFE_HTML_TAGS.has(tag)) return `HTML contains unsupported tag: ${tag}.`;
    if (match[0].startsWith('</')) {
      if (stack.pop() !== tag) return `HTML has invalid ${tag} nesting.`;
    } else {
      stack.push(tag);
    }
  }
  if (stack.length > 0) return `HTML has unclosed ${stack[stack.length - 1]} tag.`;
  if (/<li>/.test(html) && !/<(?:ul|ol)>/i.test(html)) return 'HTML list items must be inside ul or ol.';
  if (/<(?:th|td)>/i.test(html) && !/<tr>/i.test(html)) return 'HTML table cells must be inside a table row.';
  if (/<tr>/i.test(html) && !/<table>/i.test(html)) return 'HTML table rows must be inside a table.';
  for (const artifact of requiredArtifacts) {
    const failure = validateArtifactRequirement(html, artifact);
    if (failure) return failure;
  }
  return null;
}

export function validateLessonAuthorGeneratedUnitCoverage(
  unit: LessonAuthorContentContractUnit,
  components: readonly LessonAuthorGeneratedComponentContract[],
): string | null {
  const plan = Array.isArray(unit.component_plan) ? unit.component_plan : [];
  if (components.length !== plan.length) return 'Generated component count does not match the approved Blueprint plan.';
  const unitFactIds = new Set(uniqueFactIds(unit.source_fact_ids));
  const unitSupportingEvidenceFactIds = new Set(uniqueFactIds(unit.supporting_evidence_fact_ids));
  const coveredFactIds = new Set<string>();

  for (const [index, component] of components.entries()) {
    if (plan[index]?.component_plan_id && component.component_plan_id !== plan[index].component_plan_id) return 'Generated component instance does not match its approved Blueprint plan.';
    const expected = plan[index];
    if (component.type !== expected.type) return `Generated component ${index + 1} changed the approved component type.`;
    const expectedOwnerIds = new Set(uniqueFactIds(expected.source_fact_ids));
    const declaredOwnerIds = new Set(uniqueFactIds(component.source_fact_ids));
    if (expectedOwnerIds.size !== declaredOwnerIds.size || [...expectedOwnerIds].some(id => !declaredOwnerIds.has(id))) {
      return `Generated component ${index + 1} does not match its Blueprint source fact ownership.`;
    }
    const expectedSupportingEvidenceIds = new Set(uniqueFactIds(expected.supporting_evidence_fact_ids));
    const declaredSupportingEvidenceIds = new Set(uniqueFactIds(component.supporting_evidence_fact_ids));
    if (expectedSupportingEvidenceIds.size !== declaredSupportingEvidenceIds.size
      || [...expectedSupportingEvidenceIds].some(id => !declaredSupportingEvidenceIds.has(id))) {
      return `Generated component ${index + 1} does not match its approved supporting evidence.`;
    }
    const invalidSupportingEvidence = [...declaredSupportingEvidenceIds]
      .filter(id => !unitSupportingEvidenceFactIds.has(id));
    if (invalidSupportingEvidence.length > 0) {
      return `Generated component ${index + 1} references supporting evidence outside its unit.`;
    }
    if (unitFactIds.size === 0 && declaredSupportingEvidenceIds.size === 0) {
      return `Generated supporting-only component ${index + 1} must declare read-only supporting evidence.`;
    }
    const declaredCoverage = new Set(uniqueFactIds(component.covered_source_fact_ids));
    if (unitFactIds.size === 0 || (expected.component_plan_id && expectedOwnerIds.size === 0)) {
      if (declaredCoverage.size > 0) return `Generated supporting-only component ${index + 1} must not claim canonical source coverage.`;
    } else if (declaredCoverage.size === 0) return `Generated component ${index + 1} must declare covered_source_fact_ids.`;
    const invalidCoverage = [...declaredCoverage].filter(id => !unitFactIds.has(id));
    if (invalidCoverage.length > 0) return `Generated component ${index + 1} covers source facts outside its unit.`;
    const missingOwnedCoverage = [...expectedOwnerIds].filter(id => !declaredCoverage.has(id));
    if (missingOwnedCoverage.length > 0) return `Generated component ${index + 1} omitted its required source facts from declared coverage.`;
    for (const factId of declaredCoverage) coveredFactIds.add(factId);

    if (component.type === 'html') {
      const html = sanitizeLessonAuthorHtml(component.html ?? component.data);
      const formattingFailure = validateLessonAuthorHtmlContract(html, expected.required_artifacts ?? []);
      if (formattingFailure) return `Generated HTML component ${index + 1}: ${formattingFailure}`;
    }
  }
  const missing = [...unitFactIds].filter(id => !coveredFactIds.has(id));
  return missing.length > 0 ? `Generated components did not declare coverage for unit source facts: ${missing.slice(0, 6).join(', ')}.` : null;
}

/** Blueprint drafts must never fall back to a chapter-wide single provider response. */
export function shouldUseBoundedLessonAuthorGeneration(
  hasBlueprintDraft: boolean,
  hasChapterScope: boolean,
): boolean {
  return hasBlueprintDraft || hasChapterScope;
}
