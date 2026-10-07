import type { CourseComponentType } from '../tenants/tenant-course-components.constants.js';
import type { LessonAuthorComponentPlan, LessonAuthorComponentProposal, LessonAuthorProposal } from '../course-authoring/course-authoring.service.js';
import {
  sanitizeLessonAuthorHtml,
  validateLessonAuthorGeneratedUnitCoverage,
  type LessonAuthorStructuredArtifactRequirement,
} from './lesson-author-content-contract.logic.js';
import { workspaceComponentContent } from './lesson-author-workspace-component.logic.js';
import { readWorkspaceContent, type WorkspaceContent } from './lesson-author-workspace.logic.js';
import type { OrchestrationV2ArchitectureAssembly } from './lesson-author-orchestration-v2-architecture.logic.js';
import { orchestrationV2ComponentPlanId } from './lesson-author-orchestration-v2-inventory.logic.js';
import { orchestrationV2Hash } from './lesson-author-orchestration-v2.logic.js';
import { orchestrationV2QualityPolicy } from './lesson-author-orchestration-v2-quality.logic.js';
import type { OrchestrationV2SourceFact } from './lesson-author-orchestration-v2-rag-contract.logic.js';
import {
  readOrchestrationV2AttemptTrace,
  type OrchestrationV2AttemptTraceEvent,
} from './lesson-author-orchestration-v2-attempt.logic.js';
import {
  readOrchestrationV2SemanticReviewSummary,
  type OrchestrationV2SemanticReviewSummary,
} from './lesson-author-semantic-review.logic.js';

export const ORCHESTRATION_V2_UNIT_CONTRACT = 'orchestration-unit-baseline-v2';
const UNIT_CONTENT_V3_DENSITY_POLICY = 'unit-content-v3-density-1';
export const UNIT_CONTENT_V4_ALIGNMENT_POLICY = 'unit-content-v4-alignment-1';

export interface OrchestrationV2UnitComponentPlan extends LessonAuthorComponentPlan {
  component_plan_id: string;
  title: string;
  rationale: string;
  source_fact_ids: string[];
  supporting_evidence_fact_ids: string[];
  learning_objective_refs: string[];
  source_scope_ids: string[];
}

export interface OrchestrationV2UnitGenerationContract {
  contract_version: 2;
  unit_content_policy_version?: typeof UNIT_CONTENT_V4_ALIGNMENT_POLICY;
  source_snapshot_hash: string;
  assembly_hash: string;
  chapter_key: string;
  unit_path: string;
  chapter_title: string;
  lesson_title: string;
  lesson_learning_objectives: string[];
  unit_title: string;
  unit_purpose: string;
  unit_learning_objective_refs: string[];
  unit_source_scope_ids: string[];
  unit_source_fact_ids: string[];
  component_plan: OrchestrationV2UnitComponentPlan[];
  source_facts: OrchestrationV2SourceFact[];
  contract_hash: string;
}

export interface OrchestrationV2UnitProviderResponse {
  contract_version: 2;
  source_snapshot_hash: string;
  unit_path: string;
  unit: Record<string, unknown> & { components: unknown[] };
  usage_complete: boolean;
  usage_source: 'provider' | 'reserved_upper_bound' | 'deterministic_fallback';
  content_origin: 'provider_validated' | 'structured_fallback';
  quality_state: 'validated' | 'review_required';
  usage?: Record<string, number>;
  attempt_trace: OrchestrationV2AttemptTraceEvent[];
  semantic_review?: Readonly<OrchestrationV2SemanticReviewSummary>;
}

export interface OrchestrationV2UnitBaselineNode {
  path: string;
  content: WorkspaceContent;
  content_hash: string;
}

export interface OrchestrationV2UnitPublication {
  validation_contract: typeof ORCHESTRATION_V2_UNIT_CONTRACT;
  unit_path: string;
  source_snapshot_hash: string;
  contract_hash: string;
  nodes: OrchestrationV2UnitBaselineNode[];
  generated_unit: Record<string, unknown> & { components: LessonAuthorComponentProposal[] };
  content_origin: 'provider_validated' | 'structured_fallback';
  quality_state: 'validated' | 'review_required';
  semantic_review?: Readonly<OrchestrationV2SemanticReviewSummary>;
  result_hash: string;
}

/** Canonical unit artifact envelope shared by publication, chapter validation and Apply. */
export function orchestrationV2UnitArtifactBase(
  payload: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    validation_contract: ORCHESTRATION_V2_UNIT_CONTRACT,
    unit_path: payload.unit_path,
    source_snapshot_hash: payload.source_snapshot_hash,
    contract_hash: payload.contract_hash,
    nodes: payload.nodes,
    generated_unit: payload.generated_unit,
    ...(payload.content_origin !== undefined ? { content_origin: payload.content_origin } : {}),
    ...(payload.quality_state !== undefined ? { quality_state: payload.quality_state } : {}),
    ...(payload.semantic_review !== undefined ? { semantic_review: payload.semantic_review } : {}),
  };
}

export function orchestrationV2UnitArtifactHash(
  payload: Readonly<Record<string, unknown>>,
): string {
  return orchestrationV2Hash(orchestrationV2UnitArtifactBase(payload));
}

export class OrchestrationV2UnitError extends Error {
  constructor(readonly code:
    | 'ORCHESTRATION_V2_UNIT_CONTRACT_INVALID'
    | 'ORCHESTRATION_V2_UNIT_CONTEXT_TOO_LARGE'
    | 'ORCHESTRATION_V2_UNIT_RESPONSE_INVALID'
    | 'ORCHESTRATION_V2_UNIT_NORMALIZATION_INVALID'
    | 'ORCHESTRATION_V2_UNIT_BASELINE_INVALID') {
    super(code);
    this.name = 'OrchestrationV2UnitError';
  }
}

const HASH = /^[0-9a-f]{64}$/;
const PATH = /^chapter_([1-9][0-9]*)\.lesson_([1-9][0-9]*)\.unit_([1-9][0-9]*)$/;
const MAX_FACTS = 32_768;
const MAX_CONTEXT_CHARS = 400_000;
const MAX_PUBLICATION_BYTES = 16 * 1024 * 1024;
const fail = (code: OrchestrationV2UnitError['code']): never => { throw new OrchestrationV2UnitError(code); };
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object'
  && !Array.isArray(value) ? value as Record<string, unknown> : null;
const exactIds = (value: unknown, expected: readonly string[]) => Array.isArray(value)
  && value.length === expected.length && new Set(value).size === value.length
  && value.every(item => typeof item === 'string' && expected.includes(item));

function sourceRequiredArtifacts(
  facts: readonly OrchestrationV2SourceFact[],
): LessonAuthorStructuredArtifactRequirement[] {
  const artifacts: LessonAuthorStructuredArtifactRequirement[] = [];
  const texts = facts.map(fact => fact.fact_text.trim());
  // Locator metadata is chunk-level in legacy and mixed-version snapshots. It
  // can say "table" even when this density lane owns prose only. A mandatory
  // learner artifact must be reproducible from the immutable canonical facts,
  // not inferred from adjacent chunk content.
  const tableRows = texts.filter(text => /^Row\s+\d+\s*:\s*.+\|.+$/iu.test(text)).length;
  if (tableRows >= 2) artifacts.push({ type: 'table', minimum_items: 2 });
  const orderedSteps = texts.filter(text => /^(?:step|bước)\s*\d+\s*[:.)-]/iu.test(text)).length;
  if (orderedSteps >= 2) artifacts.push({ type: 'ordered_list', minimum_items: Math.min(orderedSteps, 10) });
  const checklistItems = texts.filter(text => /^(?:☐|☑|\[\s*[x ]?\s*\])\s*\S/iu.test(text)).length;
  if (checklistItems >= 2) artifacts.push({ type: 'checklist', minimum_items: Math.min(checklistItems, 20) });
  for (const [type, pattern] of [
    ['warning', /^(?:warning|caution|cảnh báo|lưu ý)\s*:/iu],
    ['requirement', /^(?:requirement|yêu cầu|bắt buộc)\s*:/iu],
    ['exception', /^(?:exception|ngoại lệ)\s*:/iu],
  ] as const) {
    if (texts.some(text => pattern.test(text))) artifacts.push({ type, minimum_items: 1 });
  }
  return artifacts;
}

function exceedsInstructionalOutputBudget(
  contract: Readonly<OrchestrationV2UnitGenerationContract>,
  components: readonly LessonAuthorComponentProposal[],
): boolean {
  if (!contract.source_facts.length || !contract.source_facts.every(fact =>
    fact.locator?.instructional_density_policy_version === UNIT_CONTENT_V3_DENSITY_POLICY)) return false;
  const sourceChars = contract.source_facts.reduce((sum, fact) => sum + fact.fact_text.length, 0);
  const sourceWords = contract.source_facts.reduce((sum, fact) =>
    sum + (fact.fact_text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0), 0);
  const maxVisibleChars = Math.min(18_000, Math.max(4_000, Math.ceil(sourceChars * 1.75)));
  const maxWords = Math.min(2_400, Math.max(600, Math.ceil(sourceWords * 1.75)));
  const html = sanitizeLessonAuthorHtml(components.find(component => component.type === 'html')?.data);
  const visible = html.replace(/<[^>]+>/g, ' ').replace(/&(?:[a-z]+|#\d+|#x[a-f0-9]+);/gi, ' ')
    .replace(/\s+/g, ' ').trim();
  const words = visible.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
  return visible.length > maxVisibleChars || words > maxWords;
}

function componentPurpose(type: OrchestrationV2UnitComponentPlan['type']): NonNullable<LessonAuthorComponentPlan['purpose']> {
  if (type === 'problem') return 'assess';
  if (type === 'la_sortable') return 'sequence';
  if (type === 'la_diagram') return 'relationship';
  if (type === 'la_crossword') return 'terminology';
  if (type === 'la_faq') return 'clarify';
  return 'explain';
}

/** Resolve one immutable unit into exact facts and stable component instances. */
export function prepareOrchestrationV2UnitGenerationContract(input: {
  assembly: Readonly<OrchestrationV2ArchitectureAssembly>;
  unit_path: string;
  source_facts: readonly OrchestrationV2SourceFact[];
}): Readonly<OrchestrationV2UnitGenerationContract> {
  const { assembly, unit_path: unitPath } = input;
  const match = PATH.exec(unitPath);
  if (!assembly || assembly.contract_version !== 2 || !HASH.test(assembly.assembly_hash)) {
    fail('ORCHESTRATION_V2_UNIT_CONTRACT_INVALID');
  }
  if (!match) fail('ORCHESTRATION_V2_UNIT_CONTRACT_INVALID');
  const pathMatch = match as RegExpExecArray;
  const chapter = assembly.architecture.chapters[Number(pathMatch[1]) - 1];
  const lesson = chapter?.lessons[Number(pathMatch[2]) - 1];
  const unit = lesson?.units[Number(pathMatch[3]) - 1];
  if (!chapter || !lesson || !unit || unit.component_plan.length < 1) fail('ORCHESTRATION_V2_UNIT_CONTRACT_INVALID');
  const facts = [...input.source_facts];
  if (!facts.length || facts.length > MAX_FACTS
    || facts.reduce((sum, fact) => sum + fact.fact_text.length, 0) > MAX_CONTEXT_CHARS) {
    fail('ORCHESTRATION_V2_UNIT_CONTEXT_TOO_LARGE');
  }
  const scopes = new Set(unit.source_scope_ids);
  const v3Markers = facts.map(fact => fact.locator?.instructional_density_policy_version === UNIT_CONTENT_V3_DENSITY_POLICY);
  if (v3Markers.some(Boolean) && !v3Markers.every(Boolean)) fail('ORCHESTRATION_V2_UNIT_CONTRACT_INVALID');
  const factKeys = new Set<string>();
  const representedScopes = new Set<string>();
  for (const fact of facts) {
    if (!fact || typeof fact.fact_key !== 'string' || !fact.fact_key || factKeys.has(fact.fact_key)
      || !scopes.has(fact.scope_key) || typeof fact.fact_text !== 'string' || !fact.fact_text.trim()) {
      fail('ORCHESTRATION_V2_UNIT_CONTRACT_INVALID');
    }
    factKeys.add(fact.fact_key); representedScopes.add(fact.scope_key);
  }
  if (representedScopes.size !== scopes.size || [...scopes].some(scope => !representedScopes.has(scope))) {
    fail('ORCHESTRATION_V2_UNIT_CONTRACT_INVALID');
  }
  const ownedFactIds = new Set<string>();
  const componentPlan: OrchestrationV2UnitComponentPlan[] = unit.component_plan.map((plan, index) => {
    const componentPath = `${unitPath}.component_${index + 1}`;
    const planScopes = new Set(plan.source_scope_ids);
    const sourceFactIds = facts.filter(fact => planScopes.has(fact.scope_key)).map(fact => fact.fact_key);
    if (!sourceFactIds.length || [...planScopes].some(scope => !scopes.has(scope))) {
      fail('ORCHESTRATION_V2_UNIT_CONTRACT_INVALID');
    }
    const canonicalFactIds = sourceFactIds.filter(factId => !ownedFactIds.has(factId));
    canonicalFactIds.forEach(factId => ownedFactIds.add(factId));
    const supportingFactIds = sourceFactIds.filter(factId => !canonicalFactIds.includes(factId));
    return {
      component_plan_id: orchestrationV2ComponentPlanId(assembly.assembly_hash, componentPath),
      type: plan.type, title: plan.title, rationale: plan.rationale, purpose: componentPurpose(plan.type),
      source_fact_ids: canonicalFactIds,
      supporting_evidence_fact_ids: supportingFactIds,
      learning_objective_refs: [...unit.learning_objective_refs], source_scope_ids: [...plan.source_scope_ids],
      content_requirements: [], learning_block_ids: [],
      required_artifacts: canonicalFactIds.length > 0 && plan.type === 'html' ? sourceRequiredArtifacts(facts) : [],
    };
  });
  const types = componentPlan.map(plan => plan.type);
  if ((types.includes('html') && types[0] !== 'html')
    || (types.includes('la_faq') && types.at(-1) !== 'la_faq')
    || !exactIds([...ownedFactIds], facts.map(fact => fact.fact_key))) {
    fail('ORCHESTRATION_V2_UNIT_CONTRACT_INVALID');
  }
  const base = {
    contract_version: 2 as const, unit_content_policy_version: UNIT_CONTENT_V4_ALIGNMENT_POLICY as typeof UNIT_CONTENT_V4_ALIGNMENT_POLICY,
    source_snapshot_hash: assembly.source_snapshot_hash,
    assembly_hash: assembly.assembly_hash, chapter_key: chapter.chapter_key, unit_path: unitPath,
    chapter_title: chapter.title, lesson_title: lesson.title,
    lesson_learning_objectives: [...lesson.learning_objectives], unit_title: unit.title,
    unit_purpose: unit.purpose, unit_learning_objective_refs: [...unit.learning_objective_refs],
    unit_source_scope_ids: [...unit.source_scope_ids], unit_source_fact_ids: facts.map(fact => fact.fact_key),
    component_plan: componentPlan, source_facts: facts,
  };
  return Object.freeze({ ...base, contract_hash: orchestrationV2Hash(base) });
}

/** Strict transport identity gate; learner payload validation remains in Node's component registry. */
export function readOrchestrationV2UnitProviderResponse(
  value: unknown,
  expected: Readonly<OrchestrationV2UnitGenerationContract>,
): OrchestrationV2UnitProviderResponse {
  const item = record(value);
  const usageSource = item?.usage_source;
  const usageContractValid = (usageSource === 'provider' && item?.usage_complete === true)
    || (usageSource === 'reserved_upper_bound' && item?.usage_complete === false)
    || (usageSource === 'deterministic_fallback' && item?.usage_complete === true);
  if (!item || item.contract_version !== 2 || item.source_snapshot_hash !== expected.source_snapshot_hash
    || item.unit_path !== expected.unit_path || !usageContractValid) {
    fail('ORCHESTRATION_V2_UNIT_RESPONSE_INVALID');
  }
  const responseItem = item as Record<string, unknown>;
  const quality = orchestrationV2QualityPolicy(responseItem);
  if (!quality.evidence_valid || quality.content_origin === 'raw_source_fallback') {
    fail('ORCHESTRATION_V2_UNIT_RESPONSE_INVALID');
  }
  const contentOrigin = quality.has_envelope
    ? quality.content_origin as OrchestrationV2UnitProviderResponse['content_origin']
    : usageSource === 'provider' ? 'provider_validated' as const : 'structured_fallback' as const;
  const qualityState = quality.has_envelope
    ? quality.quality_state as OrchestrationV2UnitProviderResponse['quality_state']
    : usageSource === 'provider' ? 'validated' as const : 'review_required' as const;
  // A whole-unit fallback is a reviewable draft even when its source evidence
  // is structurally valid. Only provider-accounted responses may use the
  // validated lane; component-scoped fallback under provider accounting keeps
  // its existing quality policy.
  if (usageSource !== 'provider'
    && (contentOrigin !== 'structured_fallback' || qualityState !== 'review_required')) {
    fail('ORCHESTRATION_V2_UNIT_RESPONSE_INVALID');
  }
  const unit = record(responseItem.unit);
  if (!unit || unit.title !== expected.unit_title || !Array.isArray(unit.components)
    || unit.components.length !== expected.component_plan.length
    || !exactIds(unit.source_fact_ids, expected.unit_source_fact_ids)) fail('ORCHESTRATION_V2_UNIT_RESPONSE_INVALID');
  const responseUnit = unit as Record<string, unknown>;
  const responseComponents = responseUnit.components as unknown[];
  const seen = new Set<string>();
  for (const [index, valueComponent] of responseComponents.entries()) {
    const component = record(valueComponent), metadata = record(component?.metadata);
    const expectedPlan = expected.component_plan[index]!;
    const planId = component?.component_plan_id ?? metadata?.component_plan_id;
    if (!component || component.type !== expectedPlan.type || planId !== expectedPlan.component_plan_id
      || seen.has(String(planId)) || !exactIds(component.source_fact_ids ?? metadata?.source_fact_ids, expectedPlan.source_fact_ids)
      || !exactIds(component.covered_source_fact_ids ?? metadata?.covered_source_fact_ids, expectedPlan.source_fact_ids)
      || !exactIds(component.supporting_evidence_fact_ids ?? metadata?.supporting_evidence_fact_ids,
        expectedPlan.supporting_evidence_fact_ids)) {
      fail('ORCHESTRATION_V2_UNIT_RESPONSE_INVALID');
    }
    seen.add(String(planId));
  }
  const rawUsage = record(responseItem.usage);
  const usage: Record<string, number> = {};
  if (rawUsage) for (const key of ['inputTokens', 'outputTokens', 'embeddingTokens', 'totalTokens']) {
    const candidate = rawUsage[key];
    if (candidate !== undefined && (!Number.isSafeInteger(candidate) || Number(candidate) < 0)) {
      fail('ORCHESTRATION_V2_UNIT_RESPONSE_INVALID');
    }
    if (candidate !== undefined) usage[key] = Number(candidate);
  }
  let attemptTrace: OrchestrationV2AttemptTraceEvent[];
  let semanticReview: Readonly<OrchestrationV2SemanticReviewSummary> | undefined;
  try {
    attemptTrace = readOrchestrationV2AttemptTrace(responseItem.attempt_trace);
    if (responseItem.semantic_review !== undefined) {
      semanticReview = readOrchestrationV2SemanticReviewSummary(responseItem.semantic_review);
      const componentCount = responseComponents.length;
      if (semanticReview.repair_component_indices.some(index => index >= componentCount)
        || semanticReview.findings.some(finding => finding.scope === 'component'
          && (finding.component_index === null || finding.component_index >= componentCount))) {
        fail('ORCHESTRATION_V2_UNIT_RESPONSE_INVALID');
      }
    }
  } catch {
    return fail('ORCHESTRATION_V2_UNIT_RESPONSE_INVALID');
  }
  return { contract_version: 2, source_snapshot_hash: expected.source_snapshot_hash,
    unit_path: expected.unit_path, unit: responseUnit as OrchestrationV2UnitProviderResponse['unit'],
    usage_complete: responseItem.usage_complete as boolean,
    usage_source: usageSource as OrchestrationV2UnitProviderResponse['usage_source'],
    content_origin: contentOrigin, quality_state: qualityState, usage, attempt_trace: attemptTrace,
    ...(semanticReview ? { semantic_review: semanticReview } : {}) };
}

/** Normalize, validate and project revision-0 content. No persistence or Apply occurs here. */
export function acceptOrchestrationV2GeneratedUnit(input: {
  contract: Readonly<OrchestrationV2UnitGenerationContract>;
  response: OrchestrationV2UnitProviderResponse;
  normalizeProposal(raw: unknown): LessonAuthorProposal;
  allowed: ReadonlySet<CourseComponentType>;
}): Readonly<OrchestrationV2UnitPublication> {
  const { contract, response, allowed } = input;
  let proposal: LessonAuthorProposal;
  try {
    proposal = input.normalizeProposal({ chapters: [{ title: contract.chapter_title,
      lessons: [{ title: contract.lesson_title, units: [response.unit] }] }] });
  } catch { return fail('ORCHESTRATION_V2_UNIT_NORMALIZATION_INVALID'); }
  const unit = proposal.chapters?.[0]?.lessons?.[0]?.units?.[0];
  if (proposal.chapters?.length !== 1 || proposal.chapters[0]?.lessons?.length !== 1
    || proposal.chapters[0]?.lessons?.[0]?.units?.length !== 1 || !unit?.components
    || unit.components.length !== contract.component_plan.length) fail('ORCHESTRATION_V2_UNIT_NORMALIZATION_INVALID');
  const normalizedComponents = unit!.components as LessonAuthorComponentProposal[];
  const normalizedById = new Map<string, LessonAuthorComponentProposal>();
  for (const component of normalizedComponents) {
    const planId = component.metadata?.component_plan_id;
    if (typeof planId !== 'string' || normalizedById.has(planId)) {
      fail('ORCHESTRATION_V2_UNIT_NORMALIZATION_INVALID');
    }
    normalizedById.set(planId as string, component);
  }
  const rawById = new Map<string, Record<string, unknown>>();
  for (const value of response.unit.components) {
    const raw = record(value), metadata = record(raw?.metadata);
    const planId = raw?.component_plan_id ?? metadata?.component_plan_id;
    if (!raw || typeof planId !== 'string' || rawById.has(planId)) fail('ORCHESTRATION_V2_UNIT_RESPONSE_INVALID');
    rawById.set(planId as string, raw as Record<string, unknown>);
  }
  // The established course-outline normalizer groups component types for UI
  // consistency. Rebind by immutable instance ID, then restore the admitted
  // plan order; array position is never component identity.
  const components: LessonAuthorComponentProposal[] = contract.component_plan.map(plan => {
    const component = normalizedById.get(plan.component_plan_id)
      ?? fail('ORCHESTRATION_V2_UNIT_NORMALIZATION_INVALID');
    const raw = rawById.get(plan.component_plan_id)
      ?? fail('ORCHESTRATION_V2_UNIT_NORMALIZATION_INVALID');
    if (component.type !== plan.type || component.metadata?.component_plan_id !== plan.component_plan_id) {
      fail('ORCHESTRATION_V2_UNIT_NORMALIZATION_INVALID');
    }
    const acceptedRaw = raw as Record<string, unknown>;
    const rawMetadata = record(acceptedRaw.metadata);
    for (const [field, expected] of [
      ['source_fact_ids', plan.source_fact_ids], ['covered_source_fact_ids', plan.source_fact_ids],
      ['supporting_evidence_fact_ids', plan.supporting_evidence_fact_ids],
      ['learning_objective_refs', plan.learning_objective_refs],
    ] as const) {
      const claimed = acceptedRaw[field] ?? rawMetadata?.[field] ?? component.metadata?.[field];
      if (field !== 'learning_objective_refs' && !exactIds(claimed, expected)) fail('ORCHESTRATION_V2_UNIT_RESPONSE_INVALID');
      if (field === 'learning_objective_refs' && claimed !== undefined && !exactIds(claimed, expected)) {
        fail('ORCHESTRATION_V2_UNIT_RESPONSE_INVALID');
      }
    }
    return { ...component, metadata: { ...component.metadata, component_plan_id: plan.component_plan_id,
      source_fact_ids: [...plan.source_fact_ids], covered_source_fact_ids: [...plan.source_fact_ids],
      supporting_evidence_fact_ids: [...plan.supporting_evidence_fact_ids],
      learning_objective_refs: [...plan.learning_objective_refs] } } as LessonAuthorComponentProposal;
  });
  const coverage = validateLessonAuthorGeneratedUnitCoverage({ source_fact_ids: contract.unit_source_fact_ids,
    supporting_evidence_fact_ids: [],
    component_plan: contract.component_plan }, components.map(component => ({
    type: component.type, data: component.data,
    component_plan_id: component.metadata?.component_plan_id as string | undefined,
    source_fact_ids: component.metadata?.source_fact_ids as string[] | undefined,
    covered_source_fact_ids: component.metadata?.covered_source_fact_ids as string[] | undefined,
    supporting_evidence_fact_ids: component.metadata?.supporting_evidence_fact_ids as string[] | undefined,
  })), {
    exact_identifiers: contract.source_facts.flatMap(fact => [fact.fact_key, fact.source_ref ?? '']).filter(Boolean),
  });
  if (coverage) fail('ORCHESTRATION_V2_UNIT_BASELINE_INVALID');
  if (exceedsInstructionalOutputBudget(contract, components)) {
    fail('ORCHESTRATION_V2_UNIT_BASELINE_INVALID');
  }
  let componentContents: WorkspaceContent[];
  try { componentContents = components.map(component => workspaceComponentContent(component, allowed)); }
  catch { return fail('ORCHESTRATION_V2_UNIT_BASELINE_INVALID'); }
  const unitContent = readWorkspaceContent({ title: contract.unit_title, purpose: contract.unit_purpose,
    data: {}, implementation_notes: null });
  const nodes = [{ path: contract.unit_path, content: unitContent }, ...componentContents.map((content, index) => ({
    path: `${contract.unit_path}.component_${index + 1}`, content,
  }))].map(node => ({ ...node, content_hash: orchestrationV2Hash(node.content) }));
  const generatedUnit = { ...response.unit, components };
  const base = orchestrationV2UnitArtifactBase({
    unit_path: contract.unit_path,
    source_snapshot_hash: contract.source_snapshot_hash, contract_hash: contract.contract_hash,
    nodes, generated_unit: generatedUnit, content_origin: response.content_origin, quality_state: response.quality_state,
    ...(response.semantic_review ? { semantic_review: response.semantic_review } : {}) });
  if (Buffer.byteLength(JSON.stringify(base), 'utf8') > MAX_PUBLICATION_BYTES) {
    fail('ORCHESTRATION_V2_UNIT_CONTEXT_TOO_LARGE');
  }
  return Object.freeze({ ...base, result_hash: orchestrationV2UnitArtifactHash(base) }) as
    Readonly<OrchestrationV2UnitPublication>;
}
