// Readers of the IDM course design and of its parts (project context, purpose, content blocks,
// objectives, blueprint rows, module plans, scopes). Split out of lesson-author-idm.contract.ts
// (move only), which re-exports readIdmCourseDesign and reuses these readers for the module
// context.

import {
  IDM_AUDIENCE_ORIGINS, IDM_BLOOMS, IDM_CLASSIFICATIONS, IDM_CONTENT_KINDS, IDM_DESIGN_MODES, IDM_DISPOSITIONS,
  IDM_FIDELITY_MODES, IDM_GAP_TYPES, IDM_INTENTS, IDM_ISSUE_TYPES, IDM_LO_RELATIONS, IDM_ORIGINS, IDM_PIPELINE_VERSION,
  IDM_PLACEMENTS, IDM_PROMPT_POLICY_VERSION, IDM_PURPOSE_CONFIDENCES, IDM_PURPOSE_EVIDENCE, IDM_PURPOSE_ORIGINS,
  IDM_PURPOSE_PROFILES, IDM_READABLE_CONTRACT_VERSIONS, IDM_STAGE_ORIGINS, IDM_SUPPORT_ROLES, IDM_TREATMENTS,
} from './lesson-author-idm-types.contract.js';
import type {
  IdmAudienceV1, IdmAuthorNotesV1, IdmBlockLoLinkV1, IdmBlockScopeV1, IdmBlueprintRowV1, IdmContentBlockV1,
  IdmContractVersion, IdmCourseDesignV1, IdmDispositionV1, IdmFidelityMode, IdmGapV1, IdmHoldItemV1, IdmIssueV1,
  IdmLearningObjectiveV1, IdmLessonPlanV1, IdmModulePlanV1, IdmMustDoV1, IdmProjectContextV1, IdmPurposeV1,
  IdmSeparatePartV1, IdmSourceDocumentRefV1, IdmTemplateGapV1,
} from './lesson-author-idm-types.contract.js';
import {
  LESSON_KEY, MODULE_KEY, PATTERN_SECTION_KEY, SCOPE_KEY, SECTION_ID, UNBOUNDED, anyKey, blockId, boolean, dictionary,
  factKey, hasKey, idmDesignHash, integer, invalid, line, list, loId, mustDoId, nullable, nullableText, object, oneOf,
  sha256, text,
} from './lesson-author-idm-primitives.contract.js';
import type { Reader } from './lesson-author-idm-primitives.contract.js';

const LOCALES = ['vi', 'en'] as const;

// --- W0/W1 -----------------------------------------------------------------------------------
const sourceDocument: Reader<IdmSourceDocumentRefV1> = (value, path) => {
  const item = object(value, path, ['document_id', 'name', 'type']);
  return { document_id: text(item.document_id, `${path}.document_id`, 1, 64),
    name: text(item.name, `${path}.name`, 1, 255), type: nullableText(item.type, `${path}.type`, 40) };
};

const PROJECT_CONTEXT_KEYS_V1 = ['locale', 'course_title_hint', 'source_documents', 'target_audience',
  'learning_objectives', 'duration_target_minutes'] as const;
/** Contract 3 (QLT-6) launch-brief keys; present together or not at all. */
const PROJECT_CONTEXT_BRIEF_KEYS = ['design_mode', 'learner_audience', 'course_purpose'] as const;

/**
 * `shape` pins the contract of a stored design; a module context built from any design takes any. The shape
 * follows the keys: `design_mode` = contract 3 (with the description), `course_description` alone = 2, neither = 1.
 */
export function projectContext(value: unknown, path: string, shape: IdmContractVersion | 'either' = 'either'): IdmProjectContextV1 {
  const described = hasKey(value, 'course_description');
  const briefed = hasKey(value, 'design_mode');
  const actual: IdmContractVersion = briefed ? 3 : described ? 2 : 1;
  if (shape !== 'either' && shape !== actual) invalid(path);
  const item = object(value, path, [...PROJECT_CONTEXT_KEYS_V1, ...(actual >= 2 ? ['course_description'] : []),
    ...(briefed ? PROJECT_CONTEXT_BRIEF_KEYS : [])]);
  return {
    locale: oneOf(item.locale, `${path}.locale`, LOCALES),
    course_title_hint: nullableText(item.course_title_hint, `${path}.course_title_hint`, 500),
    ...(described ? { course_description: nullableText(item.course_description, `${path}.course_description`,
      2_000) } : {}),
    source_documents: list(item.source_documents, `${path}.source_documents`, 1, 20, sourceDocument),
    target_audience: nullableText(item.target_audience, `${path}.target_audience`, 2_000),
    learning_objectives: list(item.learning_objectives, `${path}.learning_objectives`, 0, 8, line(500)),
    duration_target_minutes: nullable((entry, at) => integer(entry, at, 5, 600))(
      item.duration_target_minutes, `${path}.duration_target_minutes`),
    ...(briefed ? {
      design_mode: item.design_mode === null ? null : oneOf(item.design_mode, `${path}.design_mode`, IDM_DESIGN_MODES),
      learner_audience: nullableText(item.learner_audience, `${path}.learner_audience`, 300),
      course_purpose: nullableText(item.course_purpose, `${path}.course_purpose`, 500),
    } : {}),
  };
};

const templateGap: Reader<IdmTemplateGapV1> = (value, path) => {
  const item = object(value, path, ['section_key', 'note']);
  return { section_key: text(item.section_key, `${path}.section_key`, 0, 40, PATTERN_SECTION_KEY),
    note: text(item.note, `${path}.note`, 1, 300) };
};

const PURPOSE_KEYS = ['profile', 'summary', 'confidence', 'origin', 'evidence', 'signals', 'template_gaps'] as const;
export const fidelityMode: Reader<IdmFidelityMode> = (value, path) => oneOf(value, path, IDM_FIDELITY_MODES);

/** `fidelity_mode` is optional (QLT-5 C): a purpose stored without it reads unchanged, so its hash still verifies. */
export const purpose: Reader<IdmPurposeV1> = (value, path) => {
  const moded = hasKey(value, 'fidelity_mode');
  const item = object(value, path, moded ? [...PURPOSE_KEYS, 'fidelity_mode'] : PURPOSE_KEYS);
  return {
    profile: oneOf(item.profile, `${path}.profile`, IDM_PURPOSE_PROFILES),
    summary: text(item.summary, `${path}.summary`, 10, 500),
    confidence: oneOf(item.confidence, `${path}.confidence`, IDM_PURPOSE_CONFIDENCES),
    origin: oneOf(item.origin, `${path}.origin`, IDM_PURPOSE_ORIGINS),
    evidence: list(item.evidence, `${path}.evidence`, 0, 4, (entry, at) => oneOf(entry, at, IDM_PURPOSE_EVIDENCE)),
    signals: list(item.signals, `${path}.signals`, 0, 8, line(40)),
    template_gaps: list(item.template_gaps, `${path}.template_gaps`, 0, 12, templateGap),
    ...(moded ? { fidelity_mode: nullable(fidelityMode)(item.fidelity_mode, `${path}.fidelity_mode`) } : {}),
  };
};

export const issue: Reader<IdmIssueV1> = (value, path) => {
  const item = object(value, path, ['type', 'note', 'fact_keys']);
  return { type: oneOf(item.type, `${path}.type`, IDM_ISSUE_TYPES), note: text(item.note, `${path}.note`, 1, 500),
    fact_keys: list(item.fact_keys, `${path}.fact_keys`, 0, 32, factKey) };
};

export const gap: Reader<IdmGapV1> = (value, path) => {
  const item = object(value, path, ['type', 'note']);
  return { type: oneOf(item.type, `${path}.type`, IDM_GAP_TYPES), note: text(item.note, `${path}.note`, 1, 500) };
};

export const contentBlock: Reader<IdmContentBlockV1> = (value, path) => {
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
export const learningObjective: Reader<IdmLearningObjectiveV1> = (value, path) => {
  const item = object(value, path, ['lo_id', 'statement', 'bloom', 'origin']);
  return { lo_id: loId(item.lo_id, `${path}.lo_id`), statement: text(item.statement, `${path}.statement`, 10, 500),
    bloom: oneOf(item.bloom, `${path}.bloom`, IDM_BLOOMS), origin: oneOf(item.origin, `${path}.origin`, IDM_ORIGINS) };
};

export const mustDo: Reader<IdmMustDoV1> = (value, path) => {
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

export const audience: Reader<IdmAudienceV1> = (value, path) => {
  const item = object(value, path, ['description', 'origin']);
  return { description: text(item.description, `${path}.description`, 10, 2_000),
    origin: oneOf(item.origin, `${path}.origin`, IDM_AUDIENCE_ORIGINS) };
};

// --- W2 ----------------------------------------------------------------------------------------
const separatePart: Reader<IdmSeparatePartV1> = (value, path) => {
  const item = object(value, path, ['name', 'intent', 'fact_keys']);
  return { name: text(item.name, `${path}.name`, 3, 180), intent: oneOf(item.intent, `${path}.intent`, IDM_INTENTS),
    fact_keys: list(item.fact_keys, `${path}.fact_keys`, 1, 400, factKey) };
};

export const blueprintRow: Reader<IdmBlueprintRowV1> = (value, path) => {
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

export const modulePlan: Reader<IdmModulePlanV1> = (value, path) => {
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

export const blockScope: Reader<IdmBlockScopeV1> = (value, path) => {
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

export const authorNotes: Reader<IdmAuthorNotesV1> = (value, path) => {
  const item = object(value, path, ['course', 'modules', 'lessons']);
  return { course: text(item.course, `${path}.course`, 1, 7_000),
    modules: dictionary(item.modules, `${path}.modules`, anyKey, line(3_000)),
    lessons: dictionary(item.lessons, `${path}.lessons`, anyKey, line(2_000)) };
};

const COURSE_DESIGN_KEYS_V1 = ['pipeline_version', 'idm_contract_version', 'prompt_policy_version',
  'source_snapshot_hash', 'project_context', 'target_audience', 'learning_objectives', 'must_dos', 'blocks', 'lo_links',
  'blueprint', 'blocked_must_do_ids', 'hold_items', 'modules', 'block_scopes', 'dispositions', 'notes', 'stage_origins',
  'design_hash'] as const;

function courseDesign(value: unknown, path: string): IdmCourseDesignV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(path);
  const version = (value as Record<string, unknown>).idm_contract_version;
  if (!(IDM_READABLE_CONTRACT_VERSIONS as readonly unknown[]).includes(version)) invalid(`${path}.idm_contract_version`);
  const contract = version as IdmContractVersion;
  const item = object(value, path, contract === 1 ? COURSE_DESIGN_KEYS_V1 : [...COURSE_DESIGN_KEYS_V1, 'purpose']);
  return {
    pipeline_version: oneOf(item.pipeline_version, `${path}.pipeline_version`, [IDM_PIPELINE_VERSION] as const),
    idm_contract_version: contract,
    prompt_policy_version: oneOf(item.prompt_policy_version, `${path}.prompt_policy_version`,
      [IDM_PROMPT_POLICY_VERSION] as const),
    source_snapshot_hash: sha256(item.source_snapshot_hash, `${path}.source_snapshot_hash`),
    project_context: projectContext(item.project_context, `${path}.project_context`, contract),
    ...(contract === 1 ? {} : { purpose: purpose(item.purpose, `${path}.purpose`) }),
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
