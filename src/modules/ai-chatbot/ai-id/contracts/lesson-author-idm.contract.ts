import type { OrchestrationV2SourceFact } from './lesson-author-orchestration-v2-rag-contract.logic.js';
import { idmAuthorIntent } from './lesson-author-idm-intent.logic.js';
import type { LessonAuthorLaunchBrief } from './lesson-author-launch-brief.logic.js';
import {
  IDM_BLOOMS, IDM_COMPONENT_ROLES, IDM_COMPONENT_TYPES, IDM_CONTENT_KINDS, IDM_CONTRACT_VERSION, IDM_DESIGN_MODES,
  IDM_DISPOSITIONS, IDM_FAQ_ITEM_ORIGINS, IDM_FAQ_QUESTION_TYPES, IDM_INTENTS, IDM_JUDGE_CRITERIA, IDM_JUDGE_SEVERITIES,
  IDM_PIPELINE_VERSION, IDM_PURPOSE_PROFILES, IDM_REMAINING_BUDGET_MAX_MS, IDM_REMAINING_BUDGET_MIN_MS,
  IDM_REMAINING_BUDGET_SAFETY_MS, IDM_SCENARIO_ORIGINS, IDM_SINGLE_TASK_MAX_FACTS, IDM_SINGLE_TASK_MAX_SOURCE_CHARS,
  IDM_STAGE_ORIGINS, IDM_SUPPORT_KINDS, IDM_SUPPORT_ROLES, IDM_TREATMENTS, IDM_UNIT_SEGMENTS, IdmError,
} from './lesson-author-idm-types.contract.js';
import type {
  IdmAudienceV1, IdmAuthorNotesV1, IdmBlockScopeV1, IdmBlueprintRowV1, IdmBriefComponentV1, IdmComponentAuthorReviewV1,
  IdmComponentDesignV1, IdmComponentType, IdmContentBlockV1, IdmContextFactV1, IdmCourseSkeletonRequestV1,
  IdmDisposition, IdmFaqBlockNoteV1, IdmFaqItemPlanV1, IdmFaqMaterialV1, IdmFaqPracticeNoteV1, IdmFeedbackFocusV1,
  IdmLearningObjectiveV1, IdmLessonDesignV1, IdmMediaBriefV1, IdmModulePlanV1, IdmMustDoV1, IdmPracticeTaskV1,
  IdmProjectContextV1, IdmPurposeV1, IdmShardDesignV1, IdmSupportItemV1, IdmTokenAllowanceV1, IdmTreatmentRefV1,
  IdmUnitBriefV1, IdmUnitDesignV1, IdmUnitQualityV1,
} from './lesson-author-idm-types.contract.js';
import {
  COMPONENT_PLAN_ID, DETERMINISTIC_CODE, LESSON_KEY, MODULE_KEY, PRACTICE_ID, PYTHON_BLANK, PYTHON_EDGE_WHITESPACE,
  blockId, boolean, dictionary, factKey, hasKey, idmBriefHash, idmDesignHash, idmStripWhitespace, idmTextLength,
  integer, invalid, line, list, nullable, nullableText, object, oneOf, rawText, sha256, text,
} from './lesson-author-idm-primitives.contract.js';
import type { Reader } from './lesson-author-idm-primitives.contract.js';
import {
  audience, authorNotes, blockScope, blueprintRow, contentBlock, fidelityMode, gap, issue, learningObjective,
  modulePlan, mustDo, projectContext, purpose,
} from './lesson-author-idm-course-design.contract.js';
export { readIdmCourseDesign } from './lesson-author-idm-course-design.contract.js';
export {
  idmHash, idmDesignHash, idmBriefHash, idmBlockScopeKey, idmTextLength, idmStripWhitespace, idmPythonStrip,
  idmPythonCollapseWhitespace, idmPythonWordCount,
} from './lesson-author-idm-primitives.contract.js';
export * from './lesson-author-idm-types.contract.js';

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
 *
 * Contract 2 (QLT-5) adds `project_context.course_description`, the design's
 * `purpose`, the unit brief's purpose fields and the module context's
 * `purpose`. Designs stored under contract 1 still read: each reader accepts
 * exactly one of the two shapes and returns it unchanged (absent keys stay
 * absent), so `design_hash` and `brief_hash` still verify. QLT-5 C adds, still
 * in contract 2, the optional `purpose.fidelity_mode` and brief `fidelity_mode`
 * (the content mode; absent or null reads as "structured") and the `explain`
 * treatment.
 *
 * Contract 3 (QLT-6) adds the launch brief to `project_context` (`design_mode`,
 * `learner_audience`, `course_purpose`; null for a workspace started before it),
 * the "author" audience origin, the "purpose" purpose evidence and the unit
 * brief's `design_mode`. Contract-1 and contract-2 designs and briefs read
 * unchanged, exactly as stored (no key is added), so their hashes still verify.
 */

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

const faqItemPlan: Reader<IdmFaqItemPlanV1> = (value, path) => {
  const item = object(value, path, ['question_type', 'anchor_fact_keys', 'origin']);
  return { question_type: oneOf(item.question_type, `${path}.question_type`, IDM_FAQ_QUESTION_TYPES),
    anchor_fact_keys: list(item.anchor_fact_keys, `${path}.anchor_fact_keys`, 1, 6, factKey),
    origin: oneOf(item.origin, `${path}.origin`, IDM_FAQ_ITEM_ORIGINS) };
};

/** `faq_items` is optional (QLT-5 D): a component without a plan has no such key, so it reads and hashes as before. */
function faqItems(value: unknown, item: Record<string, unknown>, path: string): { faq_items?: IdmFaqItemPlanV1[] } {
  return hasKey(value, 'faq_items') ? { faq_items: list(item.faq_items, `${path}.faq_items`, 0, 6, faqItemPlan) } : {};
}

/** `key_letter` is optional (QLT-9): the W4 letter of a single-choice key, 0 (A) to 3 (D); absent keys read and hash
 * as before. */
function keyLetter(value: unknown, item: Record<string, unknown>, path: string): { key_letter?: number } {
  return hasKey(value, 'key_letter') ? { key_letter: integer(item.key_letter, `${path}.key_letter`, 0, 3) } : {};
}

function optionalKeys(value: unknown): string[] {
  return ['faq_items', 'key_letter'].filter(key => hasKey(value, key));
}

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

const COMPONENT_DESIGN_KEYS = ['component_index', 'type', 'role', 'title', 'rationale', 'block_ids', 'practice_id',
  'support_items', 'author_review'] as const;

const componentDesign: Reader<IdmComponentDesignV1> = (value, path) => {
  const item = object(value, path, [...COMPONENT_DESIGN_KEYS, ...optionalKeys(value)]);
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
    ...faqItems(value, item, path),
    ...keyLetter(value, item, path),
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

const BRIEF_COMPONENT_KEYS = ['component_plan_id', 'type', 'role', 'title', 'support_items', 'practice', 'treatments',
  'owned_fact_keys', 'supporting_fact_keys'] as const;

const briefComponent: Reader<IdmBriefComponentV1> = (value, path) => {
  const item = object(value, path, [...BRIEF_COMPONENT_KEYS, ...optionalKeys(value)]);
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
    ...faqItems(value, item, path),
    ...keyLetter(value, item, path),
  };
};

const faqBlockNote: Reader<IdmFaqBlockNoteV1> = (value, path) => {
  const item = object(value, path, ['block_id', 'name', 'intent', 'content_kind', 'support_role', 'issues', 'gaps',
    'sme_questions']);
  return {
    block_id: blockId(item.block_id, `${path}.block_id`),
    name: text(item.name, `${path}.name`, 1, 180),
    intent: oneOf(item.intent, `${path}.intent`, IDM_INTENTS),
    content_kind: oneOf(item.content_kind, `${path}.content_kind`, IDM_CONTENT_KINDS),
    support_role: item.support_role === null ? null : oneOf(item.support_role, `${path}.support_role`, IDM_SUPPORT_ROLES),
    issues: list(item.issues, `${path}.issues`, 0, 16, issue),
    gaps: list(item.gaps, `${path}.gaps`, 0, 8, gap),
    sme_questions: list(item.sme_questions, `${path}.sme_questions`, 0, 8, line(400)),
  };
};

const faqPracticeNote: Reader<IdmFaqPracticeNoteV1> = (value, path) => {
  const item = object(value, path, ['practice_id', 'sentence', 'feedback_focus']);
  return { practice_id: text(item.practice_id, `${path}.practice_id`, 0, 4, PRACTICE_ID),
    sentence: text(item.sentence, `${path}.sentence`, 10, 280),
    feedback_focus: feedbackFocus(item.feedback_focus, `${path}.feedback_focus`) };
};

const faqMaterial: Reader<IdmFaqMaterialV1> = (value, path) => {
  const opened = hasKey(value, 'open_questions');
  const item = object(value, path, opened ? ['blocks', 'practices', 'open_questions'] : ['blocks', 'practices']);
  return { blocks: list(item.blocks, `${path}.blocks`, 0, 24, faqBlockNote),
    practices: list(item.practices, `${path}.practices`, 0, 3, faqPracticeNote),
    ...(opened ? { open_questions: list(item.open_questions, `${path}.open_questions`, 0, 8, line(400)) } : {}) };
};

function unitBrief(value: unknown, path: string, sealed: boolean): Omit<IdmUnitBriefV1, 'brief_hash'> {
  const purposeful = hasKey(value, 'purpose_profile');
  // QLT-5 C: a contract-2 brief may carry the content mode; a brief built before it reads unchanged.
  const moded = purposeful && hasKey(value, 'fidelity_mode');
  // QLT-5 D: only a unit with an la_faq slot carries its FAQ material.
  const material = hasKey(value, 'faq_material');
  // Contract 3 (QLT-6): a brief built from a contract-3 design carries the design mode.
  const designed = purposeful && hasKey(value, 'design_mode');
  const keys = [...(purposeful ? UNIT_BRIEF_KEYS : UNIT_BRIEF_KEYS_V1), ...(moded ? ['fidelity_mode'] : []),
    ...(material ? ['faq_material'] : []), ...(designed ? ['design_mode'] : [])]
    .filter(key => sealed || key !== 'brief_hash');
  const item = object(value, path, keys);
  return {
    pipeline_version: oneOf(item.pipeline_version, `${path}.pipeline_version`, [IDM_PIPELINE_VERSION] as const),
    course_title: text(item.course_title, `${path}.course_title`, 1, 500),
    target_audience: text(item.target_audience, `${path}.target_audience`, 1, 2_000),
    ...(purposeful ? {
      purpose_profile: item.purpose_profile === null ? null
        : oneOf(item.purpose_profile, `${path}.purpose_profile`, IDM_PURPOSE_PROFILES),
      purpose_summary: nullableText(item.purpose_summary, `${path}.purpose_summary`, 500),
    } : {}),
    ...(moded ? { fidelity_mode: nullable(fidelityMode)(item.fidelity_mode, `${path}.fidelity_mode`) } : {}),
    ...(designed ? { design_mode: item.design_mode === null ? null
      : oneOf(item.design_mode, `${path}.design_mode`, IDM_DESIGN_MODES) } : {}),
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
    ...(material ? { faq_material: nullable(faqMaterial)(item.faq_material, `${path}.faq_material`) } : {}),
  };
}

const UNIT_BRIEF_KEYS_V1 = ['pipeline_version', 'course_title', 'target_audience', 'module_title', 'lesson_title',
  'lesson_objective', 'lesson_practice_sentences', 'previous_lesson_title', 'next_lesson_title', 'unit_segment',
  'unit_purpose', 'components', 'lesson_context_facts', 'job_aid_signpost', 'brief_hash'] as const;
const UNIT_BRIEF_KEYS = [...UNIT_BRIEF_KEYS_V1, 'purpose_profile', 'purpose_summary'] as const;

/** Strictly parse an `IdmUnitBriefV1` (either contract) and verify `brief_hash` (Python `brief_hash_of`). */
export function readIdmUnitBrief(value: unknown): IdmUnitBriefV1 {
  const path = 'idm_unit_brief';
  const brief = unitBrief(value, path, true);
  const briefHash = sha256((value as Record<string, unknown>).brief_hash, `${path}.brief_hash`);
  const sealed: IdmUnitBriefV1 = { ...brief, brief_hash: briefHash };
  if (briefHash !== idmBriefHash(sealed)) invalid(`${path}.brief_hash`);
  return sealed;
}

/** Validate an unhashed brief and attach its canonical `brief_hash`. */
export function sealIdmUnitBrief(value: Omit<IdmUnitBriefV1, 'brief_hash'>): IdmUnitBriefV1 {
  const brief = unitBrief(value, 'idm_unit_brief', false);
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
 * the snapshot cannot fit one Python course-design task. The CMS course name
 * and description are the author intent (QLT-5), sanitised here; the launch
 * brief (QLT-6) was cleaned once at launch and is sent as stored (null fields
 * for a workspace started before QLT-6). The returned design must carry this
 * exact `project_context` (`completeSkeleton`).
 */
export function buildIdmCourseSkeletonRequest(input: {
  locale: 'vi' | 'en';
  course_title: string | null;
  course_description: string | null;
  /** The workspace launch brief; null (or absent) for a workspace created before QLT-6. */
  launch_brief?: LessonAuthorLaunchBrief | null;
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
      ...idmAuthorIntent(input),
      source_documents: input.source_documents.map(document => ({
        document_id: document.document_id,
        name: boundedHint(document.name, 255) ?? document.document_id,
        type: boundedHint(document.type, 40),
      })),
      target_audience: null,
      learning_objectives: [],
      duration_target_minutes: null,
      design_mode: input.launch_brief?.design_mode ?? null,
      learner_audience: input.launch_brief?.learner_audience ?? null,
      course_purpose: input.launch_brief?.course_purpose ?? null,
    },
    source_facts: facts,
    token_allowance: idmTokenAllowance(input, 'idm.token_allowance'),
    remaining_budget_ms: remaining,
  };
  projectContext(request.project_context, 'idm.project_context', IDM_CONTRACT_VERSION);
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
  /** The design's purpose; null for a contract-1 design (QLT-5). */
  purpose: IdmPurposeV1 | null;
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
  const item = object(value, path, ['pipeline_version', 'project_context', 'purpose', 'target_audience', 'module',
    'learning_objectives', 'must_dos', 'blocks', 'blueprint', 'block_scopes', 'lesson_index_offset',
    'allowed_component_types', 'token_allowance', 'remaining_budget_ms', 'design_hash']);
  const allowance = object(item.token_allowance, `${path}.token_allowance`, ['input_tokens', 'output_tokens']);
  return {
    pipeline_version: oneOf(item.pipeline_version, `${path}.pipeline_version`, [IDM_PIPELINE_VERSION] as const),
    project_context: projectContext(item.project_context, `${path}.project_context`),
    purpose: nullable(purpose)(item.purpose, `${path}.purpose`),
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
