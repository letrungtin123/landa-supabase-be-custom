export interface OrchestrationV2RagUsage {
  inputTokens?: number;
  outputTokens?: number;
  embeddingTokens?: number;
  totalTokens?: number;
}

export interface OrchestrationV2SourceFact {
  document_id: string;
  fact_key: string;
  scope_key: string;
  fact_text: string;
  source_ref: string | null;
  source_page: number | null;
  source_chunk: number | null;
  locator: Record<string, unknown>;
}

export interface OrchestrationV2SourceScope {
  scope_key: string;
  title: string;
  source_ref: string | null;
  fact_count: number;
  content_chars: number;
}

export interface OrchestrationV2SourceOutlineChapter {
  order: number;
  document_id: string;
  source_ref: string;
  title: string;
}

export interface OrchestrationV2SourceAuthority {
  mode: 'locked' | 'model_designed' | 'needs_review';
  source: 'toc' | 'headings' | 'none' | 'ambiguous';
  complete: boolean;
  confidence: number;
  structure_hash: string;
  reason_codes: string[];
  chapters: OrchestrationV2SourceOutlineChapter[];
}

export interface OrchestrationV2CourseSkeletonChapter {
  chapter_key: string;
  order: number;
  title: string;
  objective: string;
  learning_outcomes?: string[];
  source_scope_ids: string[];
}

export interface OrchestrationV2CourseSkeleton {
  contract_version: 2;
  source_snapshot_hash: string;
  locale: 'vi' | 'en';
  title: string;
  summary: string;
  target_audience: string;
  prerequisites: string[];
  learning_outcomes: string[];
  assessment_strategy: string;
  assumptions: string[];
  chapters: OrchestrationV2CourseSkeletonChapter[];
}

export interface OrchestrationV2ChapterShardPlan {
  chapter_key: string;
  order: number;
  shard_index: number;
  shard_count: number;
  source_scope_ids: string[];
  source_fact_count: number;
  source_content_chars: number;
}

export type OrchestrationV2ComponentType = 'html' | 'problem' | 'la_faq' | 'la_sortable' | 'la_crossword' | 'la_diagram';

export interface OrchestrationV2ArchitectureComponentPlan {
  type: OrchestrationV2ComponentType;
  title: string;
  rationale: string;
  author_review?: {
    purpose: string | null;
    example_scenario: string | null;
    visual_asset: string | null;
    user_behavior_navigation: string | null;
  };
  source_scope_ids: string[];
}

export interface OrchestrationV2ArchitectureMediaBrief {
  type: 'video' | 'static_infographic';
  title: string;
  content_points: string[];
  context_description: string;
  rationale: string;
}

export interface OrchestrationV2UnitArchitecture {
  title: string;
  purpose: string;
  learning_objective_refs: string[];
  source_scope_ids: string[];
  component_plan: OrchestrationV2ArchitectureComponentPlan[];
  media_brief: OrchestrationV2ArchitectureMediaBrief | null;
}

export interface OrchestrationV2LessonArchitecture {
  title: string;
  objective: string;
  learning_objectives: string[];
  learning_activities: string[];
  assessment: string;
  units: OrchestrationV2UnitArchitecture[];
}

export interface OrchestrationV2AssessmentObligation {
  planned_slot_key: string;
  lesson_index: number;
  unit_index: number;
  component_index: number;
  learning_objective_refs: string[];
  required_assessment_kind: 'single_choice';
  relevant_scope_ids: string[];
  relevant_evidence_fact_ids: string[];
  unresolved_reason: 'ASSESSMENT_SOURCE_CHECK_REQUIRED';
  status: 'open';
}

export interface OrchestrationV2ChapterShard {
  contract_version: 2;
  source_snapshot_hash: string;
  chapter_key: string;
  order: number;
  shard_index: number;
  shard_count: number;
  source_scope_ids: string[];
  title: string;
  objective: string;
  lessons: OrchestrationV2LessonArchitecture[];
  assessment_obligations?: OrchestrationV2AssessmentObligation[];
}

export interface OrchestrationV2SourceCursor {
  document_id: string;
  chunk_no: number;
}

export interface OrchestrationV2SourceSnapshotPageResponse {
  contract_version: 2;
  source_snapshot_hash: string;
  source_revision: string;
  source_authority: OrchestrationV2SourceAuthority;
  facts: OrchestrationV2SourceFact[];
  next_cursor: OrchestrationV2SourceCursor | null;
  has_more: boolean;
  page_content_bytes: number;
  usage?: OrchestrationV2RagUsage;
}

export interface OrchestrationV2SourceSnapshotCompletion {
  contract_version: 2;
  source_snapshot_hash: string;
  source_authority: OrchestrationV2SourceAuthority;
  scopes: OrchestrationV2SourceScope[];
}

export interface OrchestrationV2CourseSkeletonResponse {
  contract_version: 2;
  skeleton: OrchestrationV2CourseSkeleton;
  usage?: OrchestrationV2RagUsage;
  usage_complete?: boolean;
  usage_source?: 'provider' | 'reserved_upper_bound';
  content_origin?: 'provider_validated' | 'structured_fallback';
  quality_state?: 'validated' | 'review_required';
}

export interface OrchestrationV2ChapterShardResponse {
  contract_version: 2;
  shard: OrchestrationV2ChapterShard;
  usage?: OrchestrationV2RagUsage;
  usage_complete?: boolean;
  usage_source?: 'provider' | 'reserved_upper_bound';
  content_origin?: 'provider_validated' | 'structured_fallback';
  quality_state?: 'validated' | 'review_required';
}

export class OrchestrationV2RagContractError extends Error {
  constructor(readonly code: 'ORCHESTRATION_V2_RAG_RESPONSE_INVALID' | 'ORCHESTRATION_V2_RAG_IDENTITY_MISMATCH') {
    super(code);
    this.name = 'OrchestrationV2RagContractError';
  }
}

const HASH = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[a-z0-9][a-z0-9_.:-]{0,159}$/;
const OBJECTIVE_REF = /^lo_([1-9][0-9]*)$/;
const COMPONENT_TYPES = new Set<OrchestrationV2ComponentType>(
  ['html', 'problem', 'la_faq', 'la_sortable', 'la_crossword', 'la_diagram'],
);
const fail = (identity = false): never => {
  throw new OrchestrationV2RagContractError(identity
    ? 'ORCHESTRATION_V2_RAG_IDENTITY_MISMATCH' : 'ORCHESTRATION_V2_RAG_RESPONSE_INVALID');
};
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object'
  && !Array.isArray(value) ? value as Record<string, unknown> : null;
const requireRecord = (value: unknown): Record<string, unknown> => {
  const output = record(value);
  if (!output) fail();
  return output as Record<string, unknown>;
};
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};
const text = (value: unknown, maximum: number): value is string => typeof value === 'string'
  && value.trim().length > 0 && value.length <= maximum;
const integer = (value: unknown, minimum: number, maximum: number): value is number => Number.isSafeInteger(value)
  && (value as number) >= minimum && (value as number) <= maximum;
const strings = (value: unknown, maximum: number, allowEmpty = true): value is string[] => Array.isArray(value)
  && (allowEmpty || value.length > 0) && value.length <= maximum
  && value.every(item => text(item, 5_000));
const usage = (value: unknown): OrchestrationV2RagUsage | undefined => {
  const input = record(value);
  if (!input) return undefined;
  const output: OrchestrationV2RagUsage = {};
  for (const key of ['inputTokens', 'outputTokens', 'embeddingTokens', 'totalTokens'] as const) {
    const candidate = input[key];
    if (candidate !== undefined) {
      if (!integer(candidate, 0, Number.MAX_SAFE_INTEGER)) fail();
      output[key] = candidate as number;
    }
  }
  return output;
};

function planningQualityEnvelope(value: Record<string, unknown>): Readonly<{
  usage_complete: boolean;
  usage_source: 'provider' | 'reserved_upper_bound';
  content_origin: 'provider_validated' | 'structured_fallback';
  quality_state: 'validated' | 'review_required';
}> {
  const present = ['usage_complete', 'usage_source', 'content_origin', 'quality_state']
    .filter(key => value[key] !== undefined).length;
  // Artifacts produced before the quality envelope rollout remain readable as
  // provider-authored data. New responses must provide the complete envelope;
  // partial metadata could under-settle provider accounting.
  if (present === 0) return { usage_complete: true as const, usage_source: 'provider' as const,
    content_origin: 'provider_validated' as const, quality_state: 'validated' as const };
  if (present !== 4 || typeof value.usage_complete !== 'boolean'
    || !['provider', 'reserved_upper_bound'].includes(String(value.usage_source))
    || !['provider_validated', 'structured_fallback'].includes(String(value.content_origin))
    || !['validated', 'review_required'].includes(String(value.quality_state))
    || (value.usage_source === 'provider') !== value.usage_complete
    || (value.content_origin === 'provider_validated') !== (value.quality_state === 'validated')) fail();
  return { usage_complete: value.usage_complete as boolean,
    usage_source: value.usage_source as 'provider' | 'reserved_upper_bound',
    content_origin: value.content_origin as 'provider_validated' | 'structured_fallback',
    quality_state: value.quality_state as 'validated' | 'review_required' };
}

function identifiers(value: unknown, maximum: number): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum
    || value.some(item => !text(item, 255)) || new Set(value).size !== value.length) fail();
  return value as string[];
}

function architectureComponent(value: unknown): OrchestrationV2ArchitectureComponentPlan {
  const item = requireRecord(value);
  const review = item.author_review === undefined ? {
    purpose: null, example_scenario: null, visual_asset: null, user_behavior_navigation: null,
  } : requireRecord(item.author_review);
  if (!(exactKeys(item, ['type', 'title', 'rationale', 'author_review', 'source_scope_ids'])
      || exactKeys(item, ['type', 'title', 'rationale', 'source_scope_ids']))
    || !exactKeys(review, ['purpose', 'example_scenario', 'visual_asset', 'user_behavior_navigation'])
    || !COMPONENT_TYPES.has(item.type as OrchestrationV2ComponentType) || !text(item.title, 180)
    || !text(item.rationale, 500)) fail();
  for (const [key, maximum] of [['purpose', 1_200], ['example_scenario', 2_000], ['visual_asset', 1_200],
    ['user_behavior_navigation', 1_200]] as const) {
    if (review[key] !== null && !text(review[key], maximum)) fail();
  }
  return { type: item.type as OrchestrationV2ComponentType, title: item.title as string, rationale: item.rationale as string,
    author_review: review as unknown as OrchestrationV2ArchitectureComponentPlan['author_review'],
    source_scope_ids: identifiers(item.source_scope_ids, 4_096) };
}

export function readOrchestrationV2SourceAuthority(value: unknown): OrchestrationV2SourceAuthority {
  const item = requireRecord(value);
  if (!exactKeys(item, ['mode', 'source', 'complete', 'confidence', 'structure_hash', 'reason_codes', 'chapters'])
    || !['locked', 'model_designed', 'needs_review'].includes(String(item.mode))
    || !['toc', 'headings', 'none', 'ambiguous'].includes(String(item.source))
    || typeof item.complete !== 'boolean' || typeof item.confidence !== 'number'
    || item.confidence < 0 || item.confidence > 1 || !text(item.structure_hash, 64)
    || !HASH.test(item.structure_hash as string) || !strings(item.reason_codes, 32)
    || !Array.isArray(item.chapters) || item.chapters.length > 512) fail();
  const chapters = (item.chapters as unknown[]).map((candidate, index) => {
    const chapter = requireRecord(candidate);
    if (!exactKeys(chapter, ['order', 'document_id', 'source_ref', 'title']) || chapter.order !== index
      || !text(chapter.document_id, 64) || !UUID.test(chapter.document_id as string)
      || !text(chapter.source_ref, 255) || !text(chapter.title, 500)) fail();
    return chapter as unknown as OrchestrationV2SourceOutlineChapter;
  });
  if (item.mode === 'locked') {
    if (!item.complete || !chapters.length || !['toc', 'headings'].includes(String(item.source))) fail();
  } else if (chapters.length) fail();
  return { ...(item as unknown as OrchestrationV2SourceAuthority), chapters };
}

function architectureMediaBrief(value: unknown): OrchestrationV2ArchitectureMediaBrief | null {
  if (value === null) return null;
  const item = requireRecord(value);
  if (!exactKeys(item, ['type', 'title', 'content_points', 'context_description', 'rationale'])
    || !['video', 'static_infographic'].includes(String(item.type)) || !text(item.title, 180)
    || !strings(item.content_points, 6, false) || (item.content_points as string[]).some(point => point.length > 600)
    || !text(item.context_description, 1_000) || !text(item.rationale, 500)) fail();
  return { type: item.type as OrchestrationV2ArchitectureMediaBrief['type'], title: item.title as string,
    content_points: item.content_points as string[], context_description: item.context_description as string,
    rationale: item.rationale as string };
}

function unitArchitecture(value: unknown): OrchestrationV2UnitArchitecture {
  const item = requireRecord(value);
  if (!exactKeys(item, ['title', 'purpose', 'learning_objective_refs', 'source_scope_ids', 'component_plan', 'media_brief'])
    || !text(item.title, 180) || !text(item.purpose, 500)
    || !Array.isArray(item.component_plan) || item.component_plan.length < 1 || item.component_plan.length > 4) fail();
  const sourceScopeIds = identifiers(item.source_scope_ids, 4_096);
  const learningObjectiveRefs = identifiers(item.learning_objective_refs, 24);
  if (learningObjectiveRefs.some(reference => !OBJECTIVE_REF.test(reference))) fail();
  const componentPlan = (item.component_plan as unknown[]).map(architectureComponent);
  const types = componentPlan.map(component => component.type);
  const htmlIndex = types.indexOf('html');
  const faqIndex = types.indexOf('la_faq');
  if (new Set(types).size !== types.length
    || (htmlIndex >= 0 && htmlIndex !== 0)
    || (faqIndex >= 0 && faqIndex !== types.length - 1)) fail();
  const allowed = new Set(sourceScopeIds);
  const representedScopes = new Set(componentPlan.flatMap(component => component.source_scope_ids));
  if (componentPlan.some(component => component.source_scope_ids.some(scope => !allowed.has(scope)))
    || representedScopes.size !== allowed.size
    || [...allowed].some(scope => !representedScopes.has(scope))) fail();
  return { title: item.title as string, purpose: item.purpose as string, learning_objective_refs: learningObjectiveRefs,
    source_scope_ids: sourceScopeIds, component_plan: componentPlan, media_brief: architectureMediaBrief(item.media_brief) };
}

function lessonArchitecture(value: unknown): OrchestrationV2LessonArchitecture {
  const item = requireRecord(value);
  if (!exactKeys(item, ['title', 'objective', 'learning_objectives', 'learning_activities', 'assessment', 'units'])
    || !text(item.title, 180) || !text(item.objective, 500)
    || !strings(item.learning_objectives, 8, false) || !strings(item.learning_activities, 3, false)
    || (item.learning_objectives as string[]).some(value => value.length > 500)
    || (item.learning_activities as string[]).some(value => value.length > 280)
    || !text(item.assessment, 500) || !Array.isArray(item.units)
    || item.units.length < 1 || item.units.length > 512) fail();
  const units = (item.units as unknown[]).map(unitArchitecture);
  const objectiveCount = (item.learning_objectives as string[]).length;
  if (units.some(unit => unit.learning_objective_refs.some(reference => {
    const match = OBJECTIVE_REF.exec(reference);
    return !match || Number(match[1]) > objectiveCount;
  }))) fail();
  return { title: item.title as string, objective: item.objective as string,
    learning_objectives: item.learning_objectives as string[],
    learning_activities: item.learning_activities as string[], assessment: item.assessment as string, units };
}

function assessmentObligation(value: unknown): OrchestrationV2AssessmentObligation {
  const item = requireRecord(value);
  if (!exactKeys(item, ['planned_slot_key', 'lesson_index', 'unit_index', 'component_index',
    'learning_objective_refs', 'required_assessment_kind', 'relevant_scope_ids',
    'relevant_evidence_fact_ids', 'unresolved_reason', 'status'])
    || typeof item.planned_slot_key !== 'string' || !/^ao2_[a-f0-9]{32}$/.test(item.planned_slot_key)
    || !integer(item.lesson_index, 1, 4_096) || !integer(item.unit_index, 1, 4_096)
    || !integer(item.component_index, 1, 3) || item.required_assessment_kind !== 'single_choice'
    || item.unresolved_reason !== 'ASSESSMENT_SOURCE_CHECK_REQUIRED' || item.status !== 'open') fail();
  const objectiveRefs = identifiers(item.learning_objective_refs, 24);
  if (objectiveRefs.some(reference => !OBJECTIVE_REF.test(reference))) fail();
  return { planned_slot_key: item.planned_slot_key as string, lesson_index: item.lesson_index as number,
    unit_index: item.unit_index as number, component_index: item.component_index as number,
    learning_objective_refs: objectiveRefs, required_assessment_kind: 'single_choice',
    relevant_scope_ids: identifiers(item.relevant_scope_ids, 4_096),
    relevant_evidence_fact_ids: identifiers(item.relevant_evidence_fact_ids, 32_768),
    unresolved_reason: 'ASSESSMENT_SOURCE_CHECK_REQUIRED', status: 'open' };
}

function sourceScope(value: unknown): OrchestrationV2SourceScope {
  const item = requireRecord(value);
  if (!text(item.scope_key, 255) || !text(item.title, 500)
    || (item.source_ref !== null && item.source_ref !== undefined && !text(item.source_ref, 255))
    || !integer(item.fact_count, 1, 1_000_000) || !integer(item.content_chars, 1, 100_000_000)) fail();
  return item as unknown as OrchestrationV2SourceScope;
}

function sourceFact(value: unknown): OrchestrationV2SourceFact {
  const item = requireRecord(value);
  if (!text(item.document_id, 64) || !text(item.fact_key, 255) || !text(item.scope_key, 255)
    || !text(item.fact_text, 32_768)
    || (item.source_ref !== null && item.source_ref !== undefined && !text(item.source_ref, 255))
    || (item.source_page !== null && item.source_page !== undefined && !integer(item.source_page, 1, Number.MAX_SAFE_INTEGER))
    || (item.source_chunk !== null && item.source_chunk !== undefined && !integer(item.source_chunk, 0, Number.MAX_SAFE_INTEGER))
    || !record(item.locator)) fail();
  const locator = item.locator as Record<string, unknown>;
  const evidenceStatus = locator.source_evidence_status;
  const evidenceRevision = locator.source_evidence_revision;
  if (evidenceStatus !== undefined && evidenceStatus !== null) {
    if (!['ready', 'legacy_review_required'].includes(String(evidenceStatus))) fail();
    if (evidenceStatus === 'ready' && (typeof evidenceRevision !== 'string' || !HASH.test(evidenceRevision))) fail();
    if (evidenceStatus === 'legacy_review_required' && evidenceRevision != null) fail();
  }
  return item as unknown as OrchestrationV2SourceFact;
}

function chapter(value: unknown): OrchestrationV2CourseSkeletonChapter {
  const item = requireRecord(value);
  if (!text(item.chapter_key, 160) || !KEY.test(item.chapter_key)
    || !integer(item.order, 0, 511) || !text(item.title, 500) || !text(item.objective, 2_000)
    || (item.learning_outcomes !== undefined && !strings(item.learning_outcomes, 24, false))
    || !strings(item.source_scope_ids, 4_096, false)
    || new Set(item.source_scope_ids).size !== item.source_scope_ids.length) fail();
  return item as unknown as OrchestrationV2CourseSkeletonChapter;
}

function courseSkeleton(value: unknown): OrchestrationV2CourseSkeleton {
  const item = requireRecord(value);
  if (item.contract_version !== 2 || !text(item.source_snapshot_hash, 64)
    || !HASH.test(item.source_snapshot_hash) || !['vi', 'en'].includes(String(item.locale))
    || !text(item.title, 500) || !text(item.summary, 5_000) || !text(item.target_audience, 2_000)
    || !strings(item.prerequisites, 1_000) || !strings(item.learning_outcomes, 4_096, false)
    || !text(item.assessment_strategy, 5_000) || !strings(item.assumptions, 1_000)
    || !Array.isArray(item.chapters) || item.chapters.length < 1 || item.chapters.length > 512) fail();
  const rawChapters = item.chapters as unknown[];
  const chapters = rawChapters.map(chapter);
  const keys = chapters.map(value => value.chapter_key);
  const scopes = chapters.flatMap(value => value.source_scope_ids);
  if (new Set(keys).size !== keys.length || new Set(scopes).size !== scopes.length
    || chapters.map(value => value.order).sort((a, b) => a - b).some((value, index) => value !== index)) fail();
  return { ...(item as unknown as OrchestrationV2CourseSkeleton), chapters };
}

export function readOrchestrationV2SourceSnapshotPageResponse(
  value: unknown, expectedSnapshotHash: string, expectedSourceRevision?: string,
): OrchestrationV2SourceSnapshotPageResponse {
  const item = requireRecord(value);
  if (item.contract_version !== 2 || !text(item.source_snapshot_hash, 64)
    || !HASH.test(item.source_snapshot_hash) || !text(item.source_revision, 64) || !HASH.test(item.source_revision)
    || !Array.isArray(item.facts) || item.facts.length > 500 || typeof item.has_more !== 'boolean'
    || !integer(item.page_content_bytes, 0, 4_194_304)) fail();
  const facts = (item.facts as unknown[]).map(sourceFact);
  const authority = readOrchestrationV2SourceAuthority(item.source_authority);
  const factKeys = new Set<string>();
  for (const fact of facts) {
    if (!UUID.test(fact.document_id) || !KEY.test(fact.fact_key) || !KEY.test(fact.scope_key)
      || factKeys.has(fact.fact_key) || fact.locator.source_revision !== item.source_revision
      || !text(fact.locator.scope_title, 500) || !text(fact.locator.index_id, 64)
      || !UUID.test(String(fact.locator.index_id))) fail();
    factKeys.add(fact.fact_key);
  }
  const actualBytes = facts.reduce((total, fact) => total + Buffer.byteLength(fact.fact_text, 'utf8'), 0);
  if (actualBytes !== item.page_content_bytes) fail();
  let nextCursor: OrchestrationV2SourceCursor | null = null;
  if (item.next_cursor !== null) {
    const cursor = requireRecord(item.next_cursor);
    if (!text(cursor.document_id, 64) || !UUID.test(String(cursor.document_id))
      || !integer(cursor.chunk_no, 0, Number.MAX_SAFE_INTEGER)) fail();
    nextCursor = { document_id: cursor.document_id as string, chunk_no: cursor.chunk_no as number };
  }
  if ((item.has_more && !nextCursor) || (!item.has_more && nextCursor)) fail();
  if (item.source_snapshot_hash !== expectedSnapshotHash) fail(true);
  if (expectedSourceRevision && item.source_revision !== expectedSourceRevision) fail(true);
  return { contract_version: 2, source_snapshot_hash: item.source_snapshot_hash as string,
    source_revision: item.source_revision as string, facts, next_cursor: nextCursor,
    source_authority: authority,
    has_more: item.has_more as boolean, page_content_bytes: item.page_content_bytes as number,
    usage: usage(item.usage) };
}

export function readOrchestrationV2CourseSkeletonResponse(
  value: unknown, expectedSnapshotHash: string,
): OrchestrationV2CourseSkeletonResponse {
  const item = record(value);
  if (!item) fail();
  const safeItem = item as Record<string, unknown>;
  if (safeItem.contract_version !== 2) fail();
  const skeleton = courseSkeleton(safeItem.skeleton);
  if (skeleton.source_snapshot_hash !== expectedSnapshotHash) fail(true);
  return { contract_version: 2, skeleton, usage: usage(safeItem.usage),
    ...planningQualityEnvelope(safeItem) };
}

export function readOrchestrationV2ChapterShardResponse(
  value: unknown, skeleton: OrchestrationV2CourseSkeleton, plan: OrchestrationV2ChapterShardPlan,
): OrchestrationV2ChapterShardResponse {
  const item = requireRecord(value);
  const shard = requireRecord(item.shard);
  const expectedChapter = skeleton.chapters.find(chapter => chapter.chapter_key === plan.chapter_key);
  if (item.contract_version !== 2 || shard.contract_version !== 2
    || !Array.isArray(shard.source_scope_ids) || !Array.isArray(shard.lessons) || shard.lessons.length < 1
    || shard.lessons.length > 512) fail();
  const lessons = (shard.lessons as unknown[]).map(lessonArchitecture);
  const rawObligations = shard.assessment_obligations === undefined ? [] : shard.assessment_obligations;
  if (!Array.isArray(rawObligations) || rawObligations.length > 12_288) fail();
  const obligations = (rawObligations as unknown[]).map(assessmentObligation);
  if (lessons.reduce((total, lesson) => total + lesson.units.length, 0) > 4_096) fail();
  if (!expectedChapter || shard.source_snapshot_hash !== skeleton.source_snapshot_hash
    || shard.chapter_key !== plan.chapter_key || shard.order !== plan.order || shard.shard_index !== plan.shard_index
    || shard.shard_count !== plan.shard_count || shard.title !== expectedChapter.title
    || shard.objective !== expectedChapter.objective
    || JSON.stringify(shard.source_scope_ids) !== JSON.stringify(plan.source_scope_ids)) fail(true);
  const allocatedScopes = lessons.flatMap(lesson => lesson.units.flatMap(unit => unit.source_scope_ids));
  if (allocatedScopes.length !== new Set(allocatedScopes).size
    || allocatedScopes.length !== plan.source_scope_ids.length
    || allocatedScopes.some(scope => !plan.source_scope_ids.includes(scope))) fail(true);
  if (new Set(obligations.map(item => item.planned_slot_key)).size !== obligations.length
    || obligations.some(item => {
      const lesson = lessons[item.lesson_index - 1];
      const unit = lesson?.units[item.unit_index - 1];
      return !unit || item.learning_objective_refs.some(ref => !unit.learning_objective_refs.includes(ref))
        || item.relevant_scope_ids.some(scope => !unit.source_scope_ids.includes(scope));
    })) fail();
  return { contract_version: 2, shard: { ...(shard as unknown as OrchestrationV2ChapterShard), lessons,
    assessment_obligations: obligations },
    usage: usage(item.usage), ...planningQualityEnvelope(item) };
}
