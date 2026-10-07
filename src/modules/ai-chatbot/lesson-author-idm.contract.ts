import { createHash } from 'node:crypto';
import { orchestrationV2Hash } from './lesson-author-orchestration-v2.logic.js';
import type { OrchestrationV2SourceFact } from './lesson-author-orchestration-v2-rag-contract.logic.js';

/**
 * Strict TypeScript mirror of `landa-ai-rag/app/idm/contracts.py` (spec §6, §12.2).
 *
 * Python sends `model_dump(mode="json")`: every field is present (nullable ones
 * as `null`), every IDM string has already been whitespace-stripped by pydantic
 * and every model forbids extra keys. The readers below therefore reject extra
 * or missing keys, out-of-bound lengths (counted in Unicode code points, like
 * Python `len`), non-integer numbers, unknown enum members and strings that
 * still carry leading/trailing whitespace. Any violation throws `IdmError` with
 * code `IDM_CONTRACT_INVALID` and the JSON path of the first offending value.
 */

export const IDM_PIPELINE_VERSION = 'idm-1' as const;
export const IDM_LEGACY_PIPELINE_VERSION = 'v2-legacy' as const;
export const IDM_CONTRACT_VERSION = 1 as const;
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
export const IDM_TREATMENTS = ['keep', 'condense', 'rewrite', 'combine', 'separate', 'move_to_reference',
  'convert_to_job_aid', 'remove'] as const;
export const IDM_DISPOSITIONS = ['course', 'reference_job_aid', 'nice_to_know', 'remove', 'hold', 'noise'] as const;
export const IDM_SUPPORT_KINDS = ['explain_concept', 'explain_principle', 'example', 'non_example', 'worked_example',
  'demonstration'] as const;
export const IDM_COMPONENT_ROLES = ['explain', 'show', 'practice', 'clarify', 'summary', 'job_aid'] as const;
export const IDM_UNIT_SEGMENTS = ['context_explain', 'example', 'practice_feedback', 'summary_apply', 'job_aid'] as const;
export const IDM_SCENARIO_ORIGINS = ['source', 'ai_drafted', 'none'] as const;
export const IDM_ORIGINS = ['client', 'ai_proposed'] as const;
export const IDM_STAGE_ORIGINS = ['provider', 'partial_fallback', 'deterministic_fallback'] as const;
export const IDM_COMPONENT_TYPES = ['html', 'problem', 'la_faq', 'la_sortable', 'la_crossword', 'la_diagram'] as const;
export const IDM_JUDGE_CRITERIA = ['Q1_support_sufficient', 'Q2_not_copied', 'Q3_practice_complete',
  'Q4_feedback_teaches', 'Q5_grounded_criteria', 'Q6_alignment', 'Q7_cognitive_load', 'Q8_language',
  'Q9_traceability'] as const;
export const IDM_JUDGE_SEVERITIES = ['pass', 'minor', 'major', 'critical'] as const;
const LOCALES = ['vi', 'en'] as const;

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
export type IdmStageOrigin = typeof IDM_STAGE_ORIGINS[number];
export type IdmComponentType = typeof IDM_COMPONENT_TYPES[number];
export type IdmJudgeCriterion = typeof IDM_JUDGE_CRITERIA[number];
export type IdmJudgeSeverity = typeof IDM_JUDGE_SEVERITIES[number];

// --- Models (spec §6.2-§6.8) ---------------------------------------------------------------
export interface IdmSourceDocumentRefV1 { document_id: string; name: string; type: string | null }

export interface IdmProjectContextV1 {
  locale: 'vi' | 'en';
  course_title_hint: string | null;
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
export interface IdmAudienceV1 { description: string; origin: IdmOrigin }
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

export interface IdmCourseDesignV1 {
  pipeline_version: typeof IDM_PIPELINE_VERSION;
  idm_contract_version: typeof IDM_CONTRACT_VERSION;
  prompt_policy_version: typeof IDM_PROMPT_POLICY_VERSION;
  source_snapshot_hash: string;
  project_context: IdmProjectContextV1;
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
}

export interface IdmUnitBriefV1 {
  pipeline_version: typeof IDM_PIPELINE_VERSION;
  course_title: string;
  target_audience: string;
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

// --- Canonical hash ------------------------------------------------------------------------
/**
 * Same canonical encoding as Python `canonical_hash`
 * (`json.dumps(sort_keys=True, ensure_ascii=False, separators=(",", ":"))` → sha256):
 * the shared V2 hash. Key order differs from Python only for keys containing
 * astral-plane characters; every IDM key is ASCII.
 */
export function idmHash(value: unknown): string {
  return orchestrationV2Hash(value);
}

function hashWithout(value: object, key: string): string {
  return idmHash(Object.fromEntries(Object.entries(value).filter(([name]) => name !== key)));
}

/** `canonical_hash` of a design payload without its `design_hash` (Python `design_hash_of`). */
export function idmDesignHash(design: object): string {
  return hashWithout(design, 'design_hash');
}

/** `canonical_hash` of a unit brief without its `brief_hash` (Python `brief_hash_of`). */
export function idmBriefHash(brief: object): string {
  return hashWithout(brief, 'brief_hash');
}

/** Python `block_scope_key`: `idmcb_` + sha256(snapshot ␞ block ␞ sorted fact keys)[:32]. */
export function idmBlockScopeKey(sourceSnapshotHash: string, blockId: string, factKeys: readonly string[]): string {
  const sorted = [...factKeys].sort((left, right) => compareCodePoints(left, right));
  const material = [sourceSnapshotHash, blockId, sorted.join(',')].join('\u001e');
  return IDM_SCOPE_KEY_PREFIX + createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 32);
}

/** Python string ordering (by code point), independent of UTF-16 surrogate layout. */
function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left), b = Array.from(right);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const delta = a[index]!.codePointAt(0)! - b[index]!.codePointAt(0)!;
    if (delta) return delta;
  }
  return a.length - b.length;
}

// --- Primitive readers -----------------------------------------------------------------------
// pydantic-core strips Unicode White_Space (Rust `str::trim`), Python `str.strip` additionally
// strips U+001C..U+001F. IDM models use the former; `ArchitectureComponentAuthorReviewV2` the latter.
const RUST_WHITESPACE = '\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const PYTHON_WHITESPACE = `${RUST_WHITESPACE}\\u001c-\\u001f`;
const RUST_EDGE_WHITESPACE = new RegExp(`^[${RUST_WHITESPACE}]|[${RUST_WHITESPACE}]$`, 'u');
const PYTHON_EDGE_WHITESPACE = new RegExp(`^[${PYTHON_WHITESPACE}]|[${PYTHON_WHITESPACE}]$`, 'u');
const PYTHON_BLANK = new RegExp(`^[${PYTHON_WHITESPACE}]*$`, 'u');
const RUST_TRIM = new RegExp(`^[${RUST_WHITESPACE}]+|[${RUST_WHITESPACE}]+$`, 'gu');

const BLOCK_ID = /^cb_[0-9]{4}$/;
const SECTION_ID = /^sec_[0-9]{3}$/;
const LO_ID = /^lo_[1-9][0-9]?$/;
const MUST_DO_ID = /^md_[1-9][0-9]?$/;
const LESSON_KEY = /^lsn_[0-9]{3}$/;
const MODULE_KEY = /^mod_[0-9]{2}$/;
const SCOPE_KEY = /^idmcb_[0-9a-f]{32}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const COMPONENT_PLAN_ID = /^cp2_[a-f0-9]{32}$/;
const PRACTICE_ID = /^pt_[1-9]$/;
const DETERMINISTIC_CODE = /^[A-Z][A-Z0-9_]{0,95}$/;
const UNBOUNDED = Number.MAX_SAFE_INTEGER;

type Reader<T> = (value: unknown, path: string) => T;

function invalid(path: string): never {
  throw new IdmError('IDM_CONTRACT_INVALID', path);
}

/** Unicode code point count (Python `len`). */
export function idmTextLength(value: string): number {
  let length = 0;
  for (const _ of value) length += 1;
  return length;
}

/** Strip like pydantic `str_strip_whitespace` (Unicode White_Space). */
export function idmStripWhitespace(value: string): string {
  return value.replace(RUST_TRIM, '');
}

const PYTHON_TRIM = new RegExp(`^[${PYTHON_WHITESPACE}]+|[${PYTHON_WHITESPACE}]+$`, 'gu');
const PYTHON_SPACE_RUN = new RegExp(`[${PYTHON_WHITESPACE}]+`, 'gu');
/** Python `str.strip()`: the characters for which `str.isspace()` is true. */
export function idmPythonStrip(value: string): string {
  return value.replace(PYTHON_TRIM, '');
}
/** Python `re.sub(r"\s+", " ", value)` (a str pattern's `\s` is `str.isspace()`). */
export function idmPythonCollapseWhitespace(value: string): string {
  return value.replace(PYTHON_SPACE_RUN, ' ');
}
/** Python `len(re.findall(r"\w+", value))`: a str `\w` is `str.isalnum()` or `_`. */
export function idmPythonWordCount(value: string): number {
  return value.match(/[\p{L}\p{N}_]+/gu)?.length ?? 0;
}

function object(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(path);
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) invalid(path);
  return record;
}

/** IDM-model string: already stripped by pydantic, so no edge whitespace survives. */
function text(value: unknown, path: string, minimum: number, maximum: number, pattern?: RegExp): string {
  if (typeof value !== 'string' || RUST_EDGE_WHITESPACE.test(value)) return invalid(path);
  const length = idmTextLength(value);
  if (length < minimum || length > maximum || (pattern !== undefined && !pattern.test(value))) invalid(path);
  return value;
}

function nullableText(value: unknown, path: string, maximum: number, pattern?: RegExp): string | null {
  return value === null ? null : text(value, path, 0, maximum, pattern);
}

/** Non-IDM model string (no stripping): only type and code point length are constrained. */
function rawText(value: unknown, path: string, minimum: number, maximum: number): string {
  if (typeof value !== 'string') return invalid(path);
  const length = idmTextLength(value);
  if (length < minimum || length > maximum) invalid(path);
  return value;
}

function oneOf<const T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) invalid(path);
  return value as T;
}

function integer(value: unknown, path: string, minimum: number, maximum = UNBOUNDED): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalid(path);
  return value as number;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') invalid(path);
  return value as boolean;
}

function list<T>(value: unknown, path: string, minimum: number, maximum: number, item: Reader<T>): T[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) return invalid(path);
  return value.map((entry, index) => item(entry, `${path}[${index}]`));
}

function dictionary<V>(value: unknown, path: string, key: Reader<string>, item: Reader<V>): Record<string, V> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(path);
  // Object.fromEntries defines own data properties, so a `__proto__` key cannot alter the prototype.
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, entry]) =>
    [key(name, `${path}{${name}}`), item(entry, `${path}.${name}`)]));
}

const factKey: Reader<string> = (value, path) => text(value, path, 1, 255);
const blockId: Reader<string> = (value, path) => text(value, path, 0, 8, BLOCK_ID);
const loId: Reader<string> = (value, path) => text(value, path, 0, 5, LO_ID);
const mustDoId: Reader<string> = (value, path) => text(value, path, 0, 5, MUST_DO_ID);
const sha256: Reader<string> = (value, path) => text(value, path, 0, 64, SHA256);
const line = (maximum: number): Reader<string> => (value, path) => text(value, path, 1, maximum);
const anyKey: Reader<string> = (value, path) => text(value, path, 0, UNBOUNDED);
const nullable = <T>(reader: Reader<T>): Reader<T | null> => (value, path) => value === null ? null : reader(value, path);

// --- W0/W1 -----------------------------------------------------------------------------------
const sourceDocument: Reader<IdmSourceDocumentRefV1> = (value, path) => {
  const item = object(value, path, ['document_id', 'name', 'type']);
  return { document_id: text(item.document_id, `${path}.document_id`, 1, 64),
    name: text(item.name, `${path}.name`, 1, 255), type: nullableText(item.type, `${path}.type`, 40) };
};

const projectContext: Reader<IdmProjectContextV1> = (value, path) => {
  const item = object(value, path, ['locale', 'course_title_hint', 'source_documents', 'target_audience',
    'learning_objectives', 'duration_target_minutes']);
  return {
    locale: oneOf(item.locale, `${path}.locale`, LOCALES),
    course_title_hint: nullableText(item.course_title_hint, `${path}.course_title_hint`, 500),
    source_documents: list(item.source_documents, `${path}.source_documents`, 1, 20, sourceDocument),
    target_audience: nullableText(item.target_audience, `${path}.target_audience`, 2_000),
    learning_objectives: list(item.learning_objectives, `${path}.learning_objectives`, 0, 8, line(500)),
    duration_target_minutes: nullable((entry, at) => integer(entry, at, 5, 600))(
      item.duration_target_minutes, `${path}.duration_target_minutes`),
  };
};

const issue: Reader<IdmIssueV1> = (value, path) => {
  const item = object(value, path, ['type', 'note', 'fact_keys']);
  return { type: oneOf(item.type, `${path}.type`, IDM_ISSUE_TYPES), note: text(item.note, `${path}.note`, 1, 500),
    fact_keys: list(item.fact_keys, `${path}.fact_keys`, 0, 32, factKey) };
};

const gap: Reader<IdmGapV1> = (value, path) => {
  const item = object(value, path, ['type', 'note']);
  return { type: oneOf(item.type, `${path}.type`, IDM_GAP_TYPES), note: text(item.note, `${path}.note`, 1, 500) };
};

const contentBlock: Reader<IdmContentBlockV1> = (value, path) => {
  const item = object(value, path, ['block_id', 'section_id', 'name', 'summary', 'intent', 'support_role',
    'content_kind', 'fact_keys', 'issues', 'gaps', 'sme_questions', 'origin']);
  return {
    block_id: blockId(item.block_id, `${path}.block_id`),
    section_id: text(item.section_id, `${path}.section_id`, 0, 7, SECTION_ID),
    name: text(item.name, `${path}.name`, 1, 180),
    summary: text(item.summary, `${path}.summary`, 1, 300),
    intent: oneOf(item.intent, `${path}.intent`, IDM_INTENTS),
    support_role: item.support_role === null ? null : oneOf(item.support_role, `${path}.support_role`, IDM_SUPPORT_ROLES),
    content_kind: oneOf(item.content_kind, `${path}.content_kind`, IDM_CONTENT_KINDS),
    fact_keys: list(item.fact_keys, `${path}.fact_keys`, 1, UNBOUNDED, factKey),
    issues: list(item.issues, `${path}.issues`, 0, 16, issue),
    gaps: list(item.gaps, `${path}.gaps`, 0, 8, gap),
    sme_questions: list(item.sme_questions, `${path}.sme_questions`, 0, 8, line(400)),
    origin: oneOf(item.origin, `${path}.origin`, ['provider', 'deterministic_fallback'] as const),
  };
};

// --- W1-reduce + W0 ----------------------------------------------------------------------------
const learningObjective: Reader<IdmLearningObjectiveV1> = (value, path) => {
  const item = object(value, path, ['lo_id', 'statement', 'bloom', 'origin']);
  return { lo_id: loId(item.lo_id, `${path}.lo_id`), statement: text(item.statement, `${path}.statement`, 10, 500),
    bloom: oneOf(item.bloom, `${path}.bloom`, IDM_BLOOMS), origin: oneOf(item.origin, `${path}.origin`, IDM_ORIGINS) };
};

const mustDo: Reader<IdmMustDoV1> = (value, path) => {
  const item = object(value, path, ['must_do_id', 'lo_id', 'statement', 'kind', 'bloom']);
  return { must_do_id: mustDoId(item.must_do_id, `${path}.must_do_id`), lo_id: loId(item.lo_id, `${path}.lo_id`),
    statement: text(item.statement, `${path}.statement`, 5, 280),
    kind: oneOf(item.kind, `${path}.kind`, ['do', 'decide'] as const), bloom: oneOf(item.bloom, `${path}.bloom`, IDM_BLOOMS) };
};

const loLink: Reader<IdmBlockLoLinkV1> = (value, path) => {
  const item = object(value, path, ['block_id', 'lo_id', 'relation']);
  return { block_id: blockId(item.block_id, `${path}.block_id`), lo_id: loId(item.lo_id, `${path}.lo_id`),
    relation: oneOf(item.relation, `${path}.relation`, IDM_LO_RELATIONS) };
};

const audience: Reader<IdmAudienceV1> = (value, path) => {
  const item = object(value, path, ['description', 'origin']);
  return { description: text(item.description, `${path}.description`, 10, 2_000),
    origin: oneOf(item.origin, `${path}.origin`, IDM_ORIGINS) };
};

// --- W2 ----------------------------------------------------------------------------------------
const separatePart: Reader<IdmSeparatePartV1> = (value, path) => {
  const item = object(value, path, ['name', 'intent', 'fact_keys']);
  return { name: text(item.name, `${path}.name`, 3, 180), intent: oneOf(item.intent, `${path}.intent`, IDM_INTENTS),
    fact_keys: list(item.fact_keys, `${path}.fact_keys`, 1, 400, factKey) };
};

const blueprintRow: Reader<IdmBlueprintRowV1> = (value, path) => {
  const item = object(value, path, ['block_id', 'lo_id', 'must_do_ids', 'classification', 'placement', 'treatment',
    'detail_level', 'hold', 'hold_reason', 'sme_question', 'combine_into', 'separate_into', 'rationale']);
  return {
    block_id: blockId(item.block_id, `${path}.block_id`),
    lo_id: nullable(loId)(item.lo_id, `${path}.lo_id`),
    must_do_ids: list(item.must_do_ids, `${path}.must_do_ids`, 0, 8, mustDoId),
    classification: oneOf(item.classification, `${path}.classification`, IDM_CLASSIFICATIONS),
    placement: oneOf(item.placement, `${path}.placement`, IDM_PLACEMENTS),
    treatment: oneOf(item.treatment, `${path}.treatment`, IDM_TREATMENTS),
    detail_level: text(item.detail_level, `${path}.detail_level`, 1, 300),
    hold: boolean(item.hold, `${path}.hold`),
    hold_reason: nullableText(item.hold_reason, `${path}.hold_reason`, 300),
    sme_question: nullableText(item.sme_question, `${path}.sme_question`, 400),
    combine_into: nullable(blockId)(item.combine_into, `${path}.combine_into`),
    separate_into: list(item.separate_into, `${path}.separate_into`, 0, 6, separatePart),
    rationale: text(item.rationale, `${path}.rationale`, 1, 300),
  };
};

// --- W4 course ---------------------------------------------------------------------------------
const lessonPlan: Reader<IdmLessonPlanV1> = (value, path) => {
  const item = object(value, path, ['lesson_key', 'kind', 'title', 'primary_must_do_id', 'secondary_must_do_ids',
    'block_ids', 'est_screens', 'est_minutes', 'ordering_rationale']);
  return {
    lesson_key: text(item.lesson_key, `${path}.lesson_key`, 0, 7, LESSON_KEY),
    kind: oneOf(item.kind, `${path}.kind`, ['learning', 'job_aid'] as const),
    title: text(item.title, `${path}.title`, 3, 180),
    primary_must_do_id: nullable(mustDoId)(item.primary_must_do_id, `${path}.primary_must_do_id`),
    secondary_must_do_ids: list(item.secondary_must_do_ids, `${path}.secondary_must_do_ids`, 0, 2, mustDoId),
    block_ids: list(item.block_ids, `${path}.block_ids`, 1, 40, blockId),
    est_screens: integer(item.est_screens, `${path}.est_screens`, 2, 30),
    est_minutes: integer(item.est_minutes, `${path}.est_minutes`, 2, 60),
    ordering_rationale: text(item.ordering_rationale, `${path}.ordering_rationale`, 1, 300),
  };
};

const modulePlan: Reader<IdmModulePlanV1> = (value, path) => {
  const item = object(value, path, ['module_key', 'title', 'performance_goal', 'lo_ids', 'lessons']);
  return {
    module_key: text(item.module_key, `${path}.module_key`, 0, 6, MODULE_KEY),
    title: text(item.title, `${path}.title`, 3, 500),
    performance_goal: text(item.performance_goal, `${path}.performance_goal`, 10, 2_000),
    lo_ids: list(item.lo_ids, `${path}.lo_ids`, 1, 8, loId),
    lessons: list(item.lessons, `${path}.lessons`, 1, 30, lessonPlan),
  };
};

// --- Course design -----------------------------------------------------------------------------
const disposition: Reader<IdmDispositionV1> = (value, path) => {
  const item = object(value, path, ['fact_key', 'disposition', 'block_id', 'reason']);
  return { fact_key: factKey(item.fact_key, `${path}.fact_key`),
    disposition: oneOf(item.disposition, `${path}.disposition`, IDM_DISPOSITIONS),
    block_id: nullable(blockId)(item.block_id, `${path}.block_id`),
    reason: nullableText(item.reason, `${path}.reason`, 300) };
};

const blockScope: Reader<IdmBlockScopeV1> = (value, path) => {
  const item = object(value, path, ['scope_key', 'block_id', 'title', 'source_ref', 'fact_count', 'content_chars',
    'fact_keys']);
  return {
    scope_key: text(item.scope_key, `${path}.scope_key`, 0, 38, SCOPE_KEY),
    block_id: blockId(item.block_id, `${path}.block_id`),
    title: text(item.title, `${path}.title`, 1, 500),
    source_ref: nullableText(item.source_ref, `${path}.source_ref`, 255),
    fact_count: integer(item.fact_count, `${path}.fact_count`, 1),
    content_chars: integer(item.content_chars, `${path}.content_chars`, 1),
    fact_keys: list(item.fact_keys, `${path}.fact_keys`, 1, UNBOUNDED, factKey),
  };
};

const holdItem: Reader<IdmHoldItemV1> = (value, path) => {
  const item = object(value, path, ['block_id', 'name', 'reason', 'sme_question', 'blocked_must_do_ids']);
  return { block_id: blockId(item.block_id, `${path}.block_id`), name: text(item.name, `${path}.name`, 1, 180),
    reason: text(item.reason, `${path}.reason`, 1, 300),
    sme_question: text(item.sme_question, `${path}.sme_question`, 1, 400),
    blocked_must_do_ids: list(item.blocked_must_do_ids, `${path}.blocked_must_do_ids`, 0, 40, mustDoId) };
};

const authorNotes: Reader<IdmAuthorNotesV1> = (value, path) => {
  const item = object(value, path, ['course', 'modules', 'lessons']);
  return { course: text(item.course, `${path}.course`, 1, 7_000),
    modules: dictionary(item.modules, `${path}.modules`, anyKey, line(3_000)),
    lessons: dictionary(item.lessons, `${path}.lessons`, anyKey, line(2_000)) };
};

const COURSE_DESIGN_KEYS = ['pipeline_version', 'idm_contract_version', 'prompt_policy_version', 'source_snapshot_hash',
  'project_context', 'target_audience', 'learning_objectives', 'must_dos', 'blocks', 'lo_links', 'blueprint',
  'blocked_must_do_ids', 'hold_items', 'modules', 'block_scopes', 'dispositions', 'notes', 'stage_origins',
  'design_hash'] as const;

function courseDesign(value: unknown, path: string): IdmCourseDesignV1 {
  const item = object(value, path, COURSE_DESIGN_KEYS);
  if (item.idm_contract_version !== IDM_CONTRACT_VERSION) invalid(`${path}.idm_contract_version`);
  return {
    pipeline_version: oneOf(item.pipeline_version, `${path}.pipeline_version`, [IDM_PIPELINE_VERSION] as const),
    idm_contract_version: IDM_CONTRACT_VERSION,
    prompt_policy_version: oneOf(item.prompt_policy_version, `${path}.prompt_policy_version`,
      [IDM_PROMPT_POLICY_VERSION] as const),
    source_snapshot_hash: sha256(item.source_snapshot_hash, `${path}.source_snapshot_hash`),
    project_context: projectContext(item.project_context, `${path}.project_context`),
    target_audience: audience(item.target_audience, `${path}.target_audience`),
    learning_objectives: list(item.learning_objectives, `${path}.learning_objectives`, 1, 8, learningObjective),
    must_dos: list(item.must_dos, `${path}.must_dos`, 1, 40, mustDo),
    blocks: list(item.blocks, `${path}.blocks`, 1, 2_000, contentBlock),
    lo_links: list(item.lo_links, `${path}.lo_links`, 0, 16_000, loLink),
    blueprint: list(item.blueprint, `${path}.blueprint`, 1, 2_000, blueprintRow),
    blocked_must_do_ids: list(item.blocked_must_do_ids, `${path}.blocked_must_do_ids`, 0, 40, mustDoId),
    hold_items: list(item.hold_items, `${path}.hold_items`, 0, 2_000, holdItem),
    modules: list(item.modules, `${path}.modules`, 1, 24, modulePlan),
    block_scopes: list(item.block_scopes, `${path}.block_scopes`, 1, 2_000, blockScope),
    dispositions: list(item.dispositions, `${path}.dispositions`, 1, UNBOUNDED, disposition),
    notes: authorNotes(item.notes, `${path}.notes`),
    stage_origins: dictionary(item.stage_origins, `${path}.stage_origins`, anyKey,
      (entry, at) => oneOf(entry, at, IDM_STAGE_ORIGINS)),
    design_hash: sha256(item.design_hash, `${path}.design_hash`),
  };
}

/**
 * Strictly parse the `idm` object of a `/course-skeleton` response or of a
 * stored `course_skeleton` artifact and verify `design_hash`.
 */
export function readIdmCourseDesign(value: unknown): IdmCourseDesignV1 {
  const design = courseDesign(value, 'idm');
  if (design.design_hash !== idmDesignHash(design)) invalid('idm.design_hash');
  return design;
}

// --- W3/W4 module ------------------------------------------------------------------------------
const feedbackFocus: Reader<IdmFeedbackFocusV1> = (value, path) => {
  const item = object(value, path, ['criterion', 'rationale', 'improvement']);
  return { criterion: text(item.criterion, `${path}.criterion`, 5, 400),
    rationale: text(item.rationale, `${path}.rationale`, 5, 400),
    improvement: text(item.improvement, `${path}.improvement`, 5, 400) };
};

const practiceTask: Reader<IdmPracticeTaskV1> = (value, path) => {
  const item = object(value, path, ['practice_id', 'sentence', 'context_input', 'learner_action', 'result', 'bloom',
    'criteria_fact_keys', 'scenario_origin', 'hold', 'hold_question', 'feedback_focus']);
  return {
    practice_id: text(item.practice_id, `${path}.practice_id`, 0, 4, PRACTICE_ID),
    sentence: text(item.sentence, `${path}.sentence`, 10, 280),
    context_input: text(item.context_input, `${path}.context_input`, 3, 300),
    learner_action: text(item.learner_action, `${path}.learner_action`, 3, 200),
    result: text(item.result, `${path}.result`, 3, 200),
    bloom: oneOf(item.bloom, `${path}.bloom`, IDM_BLOOMS),
    criteria_fact_keys: list(item.criteria_fact_keys, `${path}.criteria_fact_keys`, 0, 24, factKey),
    scenario_origin: oneOf(item.scenario_origin, `${path}.scenario_origin`, IDM_SCENARIO_ORIGINS),
    hold: boolean(item.hold, `${path}.hold`),
    hold_question: nullableText(item.hold_question, `${path}.hold_question`, 400),
    feedback_focus: feedbackFocus(item.feedback_focus, `${path}.feedback_focus`),
  };
};

const supportItem: Reader<IdmSupportItemV1> = (value, path) => {
  const item = object(value, path, ['kind', 'brief', 'block_id']);
  return { kind: oneOf(item.kind, `${path}.kind`, IDM_SUPPORT_KINDS), brief: text(item.brief, `${path}.brief`, 3, 300),
    block_id: blockId(item.block_id, `${path}.block_id`) };
};

/** `ArchitectureComponentAuthorReviewV2`: each value null or a Python-stripped, non-blank string. */
const authorReview: Reader<IdmComponentAuthorReviewV1> = (value, path) => {
  const item = object(value, path, ['purpose', 'example_scenario', 'visual_asset', 'user_behavior_navigation']);
  const field = (entry: unknown, at: string, maximum: number): string | null => {
    if (entry === null) return null;
    if (typeof entry !== 'string' || PYTHON_BLANK.test(entry) || PYTHON_EDGE_WHITESPACE.test(entry)
      || idmTextLength(entry) > maximum) return invalid(at);
    return entry;
  };
  return { purpose: field(item.purpose, `${path}.purpose`, 1_200),
    example_scenario: field(item.example_scenario, `${path}.example_scenario`, 2_000),
    visual_asset: field(item.visual_asset, `${path}.visual_asset`, 1_200),
    user_behavior_navigation: field(item.user_behavior_navigation, `${path}.user_behavior_navigation`, 1_200) };
};

/** `ArchitectureMediaBriefV2` keeps raw strings; content points must be non-blank. */
const mediaBrief: Reader<IdmMediaBriefV1> = (value, path) => {
  const item = object(value, path, ['type', 'title', 'content_points', 'context_description', 'rationale']);
  return {
    type: oneOf(item.type, `${path}.type`, ['video', 'static_infographic'] as const),
    title: rawText(item.title, `${path}.title`, 1, 180),
    content_points: list(item.content_points, `${path}.content_points`, 1, 6, (entry, at) => {
      const point = rawText(entry, at, 0, 600);
      return PYTHON_BLANK.test(point) ? invalid(at) : point;
    }),
    context_description: rawText(item.context_description, `${path}.context_description`, 1, 1_000),
    rationale: rawText(item.rationale, `${path}.rationale`, 1, 500),
  };
};

const componentDesign: Reader<IdmComponentDesignV1> = (value, path) => {
  const item = object(value, path, ['component_index', 'type', 'role', 'title', 'rationale', 'block_ids',
    'practice_id', 'support_items', 'author_review']);
  return {
    component_index: integer(item.component_index, `${path}.component_index`, 1, 4),
    type: oneOf(item.type, `${path}.type`, IDM_COMPONENT_TYPES),
    role: oneOf(item.role, `${path}.role`, IDM_COMPONENT_ROLES),
    title: text(item.title, `${path}.title`, 3, 180),
    rationale: text(item.rationale, `${path}.rationale`, 3, 500),
    block_ids: list(item.block_ids, `${path}.block_ids`, 1, 12, blockId),
    practice_id: nullableText(item.practice_id, `${path}.practice_id`, 4, PRACTICE_ID),
    support_items: list(item.support_items, `${path}.support_items`, 0, 6, supportItem),
    author_review: authorReview(item.author_review, `${path}.author_review`),
  };
};

const unitDesign: Reader<IdmUnitDesignV1> = (value, path) => {
  const item = object(value, path, ['unit_index', 'segment', 'title', 'purpose', 'block_ids', 'components',
    'media_brief']);
  return {
    unit_index: integer(item.unit_index, `${path}.unit_index`, 1, 12),
    segment: oneOf(item.segment, `${path}.segment`, IDM_UNIT_SEGMENTS),
    title: text(item.title, `${path}.title`, 3, 180),
    purpose: text(item.purpose, `${path}.purpose`, 5, 500),
    block_ids: list(item.block_ids, `${path}.block_ids`, 1, 24, blockId),
    components: list(item.components, `${path}.components`, 1, 4, componentDesign),
    media_brief: nullable(mediaBrief)(item.media_brief, `${path}.media_brief`),
  };
};

const lessonDesign: Reader<IdmLessonDesignV1> = (value, path) => {
  const item = object(value, path, ['lesson_key', 'title', 'objective', 'learning_objectives', 'practice_tasks',
    'assessment', 'units', 'notes']);
  return {
    lesson_key: text(item.lesson_key, `${path}.lesson_key`, 0, 7, LESSON_KEY),
    title: text(item.title, `${path}.title`, 3, 180),
    objective: text(item.objective, `${path}.objective`, 5, 500),
    learning_objectives: list(item.learning_objectives, `${path}.learning_objectives`, 1, 8, line(500)),
    practice_tasks: list(item.practice_tasks, `${path}.practice_tasks`, 0, 3, practiceTask),
    assessment: text(item.assessment, `${path}.assessment`, 5, 500),
    units: list(item.units, `${path}.units`, 1, 12, unitDesign),
    notes: text(item.notes, `${path}.notes`, 1, 2_000),
  };
};

/**
 * Strictly parse `shard.idm_design` (Python `IdmShardDesignV1`) and verify
 * `design_hash` = canonical hash of the shard design without `design_hash`
 * (Python `module_design` builds it with `design_hash_of`).
 */
export function readIdmShardDesign(value: unknown): IdmShardDesignV1 {
  const path = 'idm_design';
  const item = object(value, path, ['pipeline_version', 'chapter_key', 'shard_index', 'lessons',
    'lesson_index_offset', 'stage_origin', 'design_hash']);
  const design: IdmShardDesignV1 = {
    pipeline_version: oneOf(item.pipeline_version, `${path}.pipeline_version`, [IDM_PIPELINE_VERSION] as const),
    chapter_key: text(item.chapter_key, `${path}.chapter_key`, 1, 160),
    shard_index: integer(item.shard_index, `${path}.shard_index`, 0, 4_095),
    lessons: list(item.lessons, `${path}.lessons`, 1, 30, lessonDesign),
    lesson_index_offset: integer(item.lesson_index_offset, `${path}.lesson_index_offset`, 0, 4_095),
    stage_origin: oneOf(item.stage_origin, `${path}.stage_origin`, IDM_STAGE_ORIGINS),
    design_hash: sha256(item.design_hash, `${path}.design_hash`),
  };
  if (design.design_hash !== idmDesignHash(design)) invalid(`${path}.design_hash`);
  return design;
}

// --- W5 brief / W6 judge -----------------------------------------------------------------------
const treatmentRef: Reader<IdmTreatmentRefV1> = (value, path) => {
  const item = object(value, path, ['block_id', 'treatment', 'detail_level']);
  return { block_id: blockId(item.block_id, `${path}.block_id`),
    treatment: oneOf(item.treatment, `${path}.treatment`, IDM_TREATMENTS),
    detail_level: text(item.detail_level, `${path}.detail_level`, 1, 300) };
};

const contextFact: Reader<IdmContextFactV1> = (value, path) => {
  const item = object(value, path, ['fact_key', 'fact_text']);
  return { fact_key: factKey(item.fact_key, `${path}.fact_key`),
    fact_text: text(item.fact_text, `${path}.fact_text`, 1, 32_768) };
};

const briefComponent: Reader<IdmBriefComponentV1> = (value, path) => {
  const item = object(value, path, ['component_plan_id', 'type', 'role', 'title', 'support_items', 'practice',
    'treatments', 'owned_fact_keys', 'supporting_fact_keys']);
  return {
    component_plan_id: text(item.component_plan_id, `${path}.component_plan_id`, 0, 36, COMPONENT_PLAN_ID),
    type: oneOf(item.type, `${path}.type`, IDM_COMPONENT_TYPES),
    role: oneOf(item.role, `${path}.role`, IDM_COMPONENT_ROLES),
    title: text(item.title, `${path}.title`, 1, 180),
    support_items: list(item.support_items, `${path}.support_items`, 0, 6, supportItem),
    practice: nullable(practiceTask)(item.practice, `${path}.practice`),
    treatments: list(item.treatments, `${path}.treatments`, 0, 24, treatmentRef),
    owned_fact_keys: list(item.owned_fact_keys, `${path}.owned_fact_keys`, 0, 32_768, factKey),
    supporting_fact_keys: list(item.supporting_fact_keys, `${path}.supporting_fact_keys`, 0, 32_768, factKey),
  };
};

function unitBrief(value: unknown, path: string, keys: readonly string[]): Omit<IdmUnitBriefV1, 'brief_hash'> {
  const item = object(value, path, keys);
  return {
    pipeline_version: oneOf(item.pipeline_version, `${path}.pipeline_version`, [IDM_PIPELINE_VERSION] as const),
    course_title: text(item.course_title, `${path}.course_title`, 1, 500),
    target_audience: text(item.target_audience, `${path}.target_audience`, 1, 2_000),
    module_title: text(item.module_title, `${path}.module_title`, 1, 500),
    lesson_title: text(item.lesson_title, `${path}.lesson_title`, 1, 180),
    lesson_objective: text(item.lesson_objective, `${path}.lesson_objective`, 1, 500),
    lesson_practice_sentences: list(item.lesson_practice_sentences, `${path}.lesson_practice_sentences`, 0, 3,
      line(280)),
    previous_lesson_title: nullableText(item.previous_lesson_title, `${path}.previous_lesson_title`, 180),
    next_lesson_title: nullableText(item.next_lesson_title, `${path}.next_lesson_title`, 180),
    unit_segment: oneOf(item.unit_segment, `${path}.unit_segment`, IDM_UNIT_SEGMENTS),
    unit_purpose: text(item.unit_purpose, `${path}.unit_purpose`, 1, 500),
    components: list(item.components, `${path}.components`, 1, 4, briefComponent),
    lesson_context_facts: list(item.lesson_context_facts, `${path}.lesson_context_facts`, 0, 80, contextFact),
    job_aid_signpost: nullableText(item.job_aid_signpost, `${path}.job_aid_signpost`, 300),
  };
}

const UNIT_BRIEF_KEYS = ['pipeline_version', 'course_title', 'target_audience', 'module_title', 'lesson_title',
  'lesson_objective', 'lesson_practice_sentences', 'previous_lesson_title', 'next_lesson_title', 'unit_segment',
  'unit_purpose', 'components', 'lesson_context_facts', 'job_aid_signpost', 'brief_hash'] as const;

/** Strictly parse an `IdmUnitBriefV1` and verify `brief_hash` (Python `brief_hash_of`). */
export function readIdmUnitBrief(value: unknown): IdmUnitBriefV1 {
  const path = 'idm_unit_brief';
  const brief = unitBrief(value, path, UNIT_BRIEF_KEYS);
  const briefHash = sha256((value as Record<string, unknown>).brief_hash, `${path}.brief_hash`);
  const sealed: IdmUnitBriefV1 = { ...brief, brief_hash: briefHash };
  if (briefHash !== idmBriefHash(sealed)) invalid(`${path}.brief_hash`);
  return sealed;
}

/** Validate an unhashed brief and attach its canonical `brief_hash`. */
export function sealIdmUnitBrief(value: Omit<IdmUnitBriefV1, 'brief_hash'>): IdmUnitBriefV1 {
  const brief = unitBrief(value, 'idm_unit_brief', UNIT_BRIEF_KEYS.filter(key => key !== 'brief_hash'));
  return readIdmUnitBrief({ ...brief, brief_hash: idmBriefHash(brief) });
}

/** Strictly parse `unit.idm_quality` (Python `IdmUnitQualityV1`). */
export function readIdmUnitQuality(value: unknown): IdmUnitQualityV1 {
  const path = 'idm_quality';
  const item = object(value, path, ['judge_mode', 'judge_status', 'finding_counts', 'criteria', 'repair_applied',
    'deterministic_codes', 'author_note']);
  const counts = object(item.finding_counts, `${path}.finding_counts`, ['minor', 'major', 'critical']);
  return {
    judge_mode: oneOf(item.judge_mode, `${path}.judge_mode`, ['off', 'observe', 'repair'] as const),
    judge_status: oneOf(item.judge_status, `${path}.judge_status`,
      ['not_run', 'pass', 'review_required', 'reject', 'skipped_budget', 'failed'] as const),
    finding_counts: { minor: integer(counts.minor, `${path}.finding_counts.minor`, 0, 1_000),
      major: integer(counts.major, `${path}.finding_counts.major`, 0, 1_000),
      critical: integer(counts.critical, `${path}.finding_counts.critical`, 0, 1_000) },
    criteria: dictionary(item.criteria, `${path}.criteria`, (entry, at) => oneOf(entry, at, IDM_JUDGE_CRITERIA),
      (entry, at) => oneOf(entry, at, IDM_JUDGE_SEVERITIES)) as IdmUnitQualityV1['criteria'],
    repair_applied: boolean(item.repair_applied, `${path}.repair_applied`),
    deterministic_codes: list(item.deterministic_codes, `${path}.deterministic_codes`, 0, 32,
      (entry, at) => text(entry, at, 0, 96, DETERMINISTIC_CODE)),
    author_note: text(item.author_note, `${path}.author_note`, 0, 1_500),
  };
}

// --- Course skeleton request (spec §12.4) -------------------------------------------------------
const SOURCE_FACT_KEYS = ['document_id', 'fact_key', 'scope_key', 'fact_text', 'source_ref', 'source_page',
  'source_chunk', 'locator'] as const;

function boundedHint(value: string | null | undefined, maximum: number): string | null {
  if (typeof value !== 'string') return null;
  const stripped = idmStripWhitespace(value);
  const bounded = idmStripWhitespace(Array.from(stripped).slice(0, maximum).join(''));
  return bounded || null;
}

function sourceFactForPython(value: OrchestrationV2SourceFact, path: string): OrchestrationV2SourceFact {
  const item = object(value, path, SOURCE_FACT_KEYS);
  const optionalInteger = (entry: unknown, at: string, minimum: number) => entry === null ? null
    : integer(entry, at, minimum);
  if (!item.locator || typeof item.locator !== 'object' || Array.isArray(item.locator)) invalid(`${path}.locator`);
  return {
    document_id: rawText(item.document_id, `${path}.document_id`, 1, 64),
    fact_key: rawText(item.fact_key, `${path}.fact_key`, 1, 255),
    scope_key: rawText(item.scope_key, `${path}.scope_key`, 1, 255),
    fact_text: rawText(item.fact_text, `${path}.fact_text`, 1, 32_768),
    source_ref: item.source_ref === null ? null : rawText(item.source_ref, `${path}.source_ref`, 0, 255),
    source_page: optionalInteger(item.source_page, `${path}.source_page`, 1),
    source_chunk: optionalInteger(item.source_chunk, `${path}.source_chunk`, 0),
    locator: item.locator as Record<string, unknown>,
  };
}

/**
 * Python's IDM budget must also end before Node stops waiting on the HTTP call
 * (`AI_RAG_REQUEST_TIMEOUT_MS` may be shorter than the lease), keeping the same
 * 15 s safety margin. Python never accepts less than 30 s, so a shorter window
 * fails here, before provider dispatch, instead of granting Python time that
 * outlives the call (`IDM_REMAINING_BUDGET_INSUFFICIENT`).
 */
export function boundIdmRemainingBudgetMs(remainingBudgetMs: number, transportTimeoutMs: number): number {
  return Math.min(remainingBudgetMs, sufficientIdmBudgetMs(transportTimeoutMs, 'transport_timeout_ms'));
}

/**
 * Build the `idm` field of an IDM course-skeleton request. Throws
 * `IDM_SOURCE_EXCEEDS_SINGLE_TASK_CAPACITY` before any provider dispatch when
 * the snapshot cannot fit one Python course-design task.
 */
export function buildIdmCourseSkeletonRequest(input: {
  locale: 'vi' | 'en';
  course_title: string | null;
  source_documents: ReadonlyArray<{ document_id: string; name: string; type: string | null }>;
  source_facts: readonly OrchestrationV2SourceFact[];
  input_tokens: number;
  max_output_tokens: number;
  provider_max_attempts: number;
  remaining_ms: number;
}): IdmCourseSkeletonRequestV1 {
  if (!Array.isArray(input.source_facts) || input.source_facts.length < 1) invalid('idm.source_facts');
  if (input.source_facts.length > IDM_SINGLE_TASK_MAX_FACTS
    || input.source_facts.reduce((total, fact) => total + idmTextLength(String(fact.fact_text)), 0)
      > IDM_SINGLE_TASK_MAX_SOURCE_CHARS) {
    throw new IdmError('IDM_SOURCE_EXCEEDS_SINGLE_TASK_CAPACITY');
  }
  const facts = input.source_facts.map((fact, index) => sourceFactForPython(fact, `idm.source_facts[${index}]`));
  if (new Set(facts.map(fact => fact.fact_key)).size !== facts.length) invalid('idm.source_facts');
  const remaining = idmRemainingBudgetMs(input.remaining_ms, 'idm.remaining_budget_ms');
  const request: IdmCourseSkeletonRequestV1 = {
    pipeline_version: IDM_PIPELINE_VERSION,
    project_context: {
      locale: input.locale,
      course_title_hint: boundedHint(input.course_title, 500),
      source_documents: input.source_documents.map(document => ({
        document_id: document.document_id,
        name: boundedHint(document.name, 255) ?? document.document_id,
        type: boundedHint(document.type, 40),
      })),
      target_audience: null,
      learning_objectives: [],
      duration_target_minutes: null,
    },
    source_facts: facts,
    token_allowance: idmTokenAllowance(input, 'idm.token_allowance'),
    remaining_budget_ms: remaining,
  };
  projectContext(request.project_context, 'idm.project_context');
  return request;
}

/** Task reservation as Python's allowance: input budget, output = max_output_tokens × provider attempts. */
export function idmTokenAllowance(
  input: { input_tokens: number; max_output_tokens: number; provider_max_attempts: number },
  path = 'token_allowance',
): IdmTokenAllowanceV1 {
  return {
    input_tokens: integer(input.input_tokens, `${path}.input_tokens`, 1, 2_000_000),
    output_tokens: integer(input.max_output_tokens * input.provider_max_attempts, `${path}.output_tokens`, 1, 131_072),
  };
}

/**
 * Lease deadline − now − 15 s, capped at Python's 600 s. Below Python's 30 s
 * floor the task fails before provider dispatch with
 * `IDM_REMAINING_BUDGET_INSUFFICIENT` (the worker then retries it on a fresh
 * lease or fails it); granting 30 s would let Python run past `deadline_at`.
 */
export function idmRemainingBudgetMs(remainingMs: number, path = 'remaining_budget_ms'): number {
  return Math.min(IDM_REMAINING_BUDGET_MAX_MS, sufficientIdmBudgetMs(remainingMs, path));
}

function sufficientIdmBudgetMs(windowMs: number, path: string): number {
  if (!Number.isFinite(windowMs)) invalid(path);
  const budget = Math.floor(windowMs) - IDM_REMAINING_BUDGET_SAFETY_MS;
  if (budget < IDM_REMAINING_BUDGET_MIN_MS) throw new IdmError('IDM_REMAINING_BUDGET_INSUFFICIENT', path);
  return budget;
}

/** Request field `idm_module_context` of `/chapter-shard` (Python `IdmModuleContextV1`). */
export interface IdmModuleContextV1 {
  pipeline_version: typeof IDM_PIPELINE_VERSION;
  project_context: IdmProjectContextV1;
  target_audience: IdmAudienceV1;
  module: IdmModulePlanV1;
  learning_objectives: IdmLearningObjectiveV1[];
  must_dos: IdmMustDoV1[];
  blocks: IdmContentBlockV1[];
  blueprint: IdmBlueprintRowV1[];
  block_scopes: IdmBlockScopeV1[];
  lesson_index_offset: number;
  allowed_component_types: IdmComponentType[];
  token_allowance: IdmTokenAllowanceV1;
  remaining_budget_ms: number;
  design_hash: string;
}

/** Validate a Node-built module context against the Python bounds before it is sent. */
export function readIdmModuleContext(value: unknown): IdmModuleContextV1 {
  const path = 'idm_module_context';
  const item = object(value, path, ['pipeline_version', 'project_context', 'target_audience', 'module',
    'learning_objectives', 'must_dos', 'blocks', 'blueprint', 'block_scopes', 'lesson_index_offset',
    'allowed_component_types', 'token_allowance', 'remaining_budget_ms', 'design_hash']);
  const allowance = object(item.token_allowance, `${path}.token_allowance`, ['input_tokens', 'output_tokens']);
  return {
    pipeline_version: oneOf(item.pipeline_version, `${path}.pipeline_version`, [IDM_PIPELINE_VERSION] as const),
    project_context: projectContext(item.project_context, `${path}.project_context`),
    target_audience: audience(item.target_audience, `${path}.target_audience`),
    module: modulePlan(item.module, `${path}.module`),
    learning_objectives: list(item.learning_objectives, `${path}.learning_objectives`, 1, 8, learningObjective),
    must_dos: list(item.must_dos, `${path}.must_dos`, 1, 40, mustDo),
    blocks: list(item.blocks, `${path}.blocks`, 1, 400, contentBlock),
    blueprint: list(item.blueprint, `${path}.blueprint`, 1, 400, blueprintRow),
    block_scopes: list(item.block_scopes, `${path}.block_scopes`, 1, 400, blockScope),
    lesson_index_offset: integer(item.lesson_index_offset, `${path}.lesson_index_offset`, 0, 4_095),
    allowed_component_types: list(item.allowed_component_types, `${path}.allowed_component_types`, 1, 8,
      (entry, at) => oneOf(entry, at, IDM_COMPONENT_TYPES)),
    token_allowance: {
      input_tokens: integer(allowance.input_tokens, `${path}.token_allowance.input_tokens`, 1, 2_000_000),
      output_tokens: integer(allowance.output_tokens, `${path}.token_allowance.output_tokens`, 1, 131_072),
    },
    remaining_budget_ms: integer(item.remaining_budget_ms, `${path}.remaining_budget_ms`,
      IDM_REMAINING_BUDGET_MIN_MS, IDM_REMAINING_BUDGET_MAX_MS),
    design_hash: sha256(item.design_hash, `${path}.design_hash`),
  };
}

// --- Architecture assembly extension (spec §12.3) ------------------------------------------------
/**
 * `assembly.idm` of an IDM `architecture_validation` artifact. It carries what
 * the deterministic downstream tasks need without re-reading the design:
 * accounting for finalization, author notes for the inventory identity (shared
 * by publish and Apply) and the validated shard designs for unit briefs.
 */
export interface IdmAssemblyExtensionV1 {
  design_hash: string;
  /** Facts accounted for outside the course: nice_to_know + remove + hold + noise. */
  excluded_fact_count: number;
  disposition_counts: Record<IdmDisposition, number>;
  /** `module_keys[i]` is the module of architecture chapter i (chapter-{i+1}). */
  module_keys: string[];
  notes: IdmAuthorNotesV1;
  /** Shard designs per chapter key, in shard order. */
  chapters: Record<string, IdmShardDesignV1[]>;
}

export const IDM_EXCLUDED_DISPOSITIONS = ['nice_to_know', 'remove', 'hold', 'noise'] as const;

/** Strict reader for `assembly.idm`; `chapterKeys` are the architecture chapter keys in order. */
export function readIdmAssemblyExtension(value: unknown, chapterKeys: readonly string[]): IdmAssemblyExtensionV1 {
  const path = 'assembly.idm';
  const item = object(value, path, ['design_hash', 'excluded_fact_count', 'disposition_counts', 'module_keys',
    'notes', 'chapters']);
  const countsItem = object(item.disposition_counts, `${path}.disposition_counts`, IDM_DISPOSITIONS);
  const counts = Object.fromEntries(IDM_DISPOSITIONS.map(name =>
    [name, integer(countsItem[name], `${path}.disposition_counts.${name}`, 0)])) as Record<IdmDisposition, number>;
  const excluded = integer(item.excluded_fact_count, `${path}.excluded_fact_count`, 0);
  if (excluded !== IDM_EXCLUDED_DISPOSITIONS.reduce((sum, name) => sum + counts[name], 0)) {
    invalid(`${path}.excluded_fact_count`);
  }
  const moduleKeys = list(item.module_keys, `${path}.module_keys`, 1, 24,
    (entry, at) => text(entry, at, 0, 6, MODULE_KEY));
  const chaptersItem = item.chapters;
  if (!chaptersItem || typeof chaptersItem !== 'object' || Array.isArray(chaptersItem)) invalid(`${path}.chapters`);
  const chapterRecord = chaptersItem as Record<string, unknown>;
  if (new Set(moduleKeys).size !== moduleKeys.length || moduleKeys.length !== chapterKeys.length
    || Object.keys(chapterRecord).length !== chapterKeys.length
    || chapterKeys.some(key => !Object.hasOwn(chapterRecord, key))) invalid(`${path}.chapters`);
  const chapters = Object.fromEntries(chapterKeys.map(key => [key, list(chapterRecord[key],
    `${path}.chapters.${key}`, 1, 4_096, (entry, at) => {
      const design = readIdmShardDesign(entry);
      if (design.chapter_key !== key) invalid(at);
      return design;
    })]));
  return { design_hash: sha256(item.design_hash, `${path}.design_hash`), excluded_fact_count: excluded,
    disposition_counts: counts, module_keys: moduleKeys, notes: authorNotes(item.notes, `${path}.notes`), chapters };
}
