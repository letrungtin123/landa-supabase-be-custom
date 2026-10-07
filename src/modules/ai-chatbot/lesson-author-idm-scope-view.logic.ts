import { orchestrationV2Hash } from './lesson-author-orchestration-v2.logic.js';
import {
  OrchestrationV2PlanningError,
  type OrchestrationV2PlanningBudgets,
  type OrchestrationV2PlanningTaskSpec,
} from './lesson-author-orchestration-v2-planning.logic.js';
import type {
  OrchestrationV2ChapterShardPlan,
  OrchestrationV2CourseSkeleton,
  OrchestrationV2SourceFact,
  OrchestrationV2SourceScope,
} from './lesson-author-orchestration-v2-rag-contract.logic.js';
import {
  IDM_DISPOSITIONS,
  IDM_LEGACY_PIPELINE_VERSION,
  IDM_PIPELINE_VERSION,
  IDM_SHARD_MAX_SOURCE_CHARS,
  IdmError,
  idmBlockScopeKey,
  idmDesignHash,
  idmRemainingBudgetMs,
  idmTokenAllowance,
  readIdmCourseDesign,
  readIdmModuleContext,
  type IdmCourseDesignV1,
  type IdmDisposition,
  type IdmModuleContextV1,
  type OrchestrationV2RunPipeline,
} from './lesson-author-idm.contract.js';

/**
 * The single place that decides which scope catalogue a run uses (spec §5.3,
 * §12.3): legacy runs keep the source-snapshot scopes, IDM runs use the
 * block-scope catalogue stored in `course_skeleton.payload.idm`.
 */
export type OrchestrationScopeView =
  | Readonly<{ kind: 'legacy' }>
  | Readonly<{
    kind: 'idm';
    design: IdmCourseDesignV1;
    /** Block-scope key of a fact, or null when the fact does not enter the course. */
    scopeOfFact: (factKey: string) => string | null;
    /** Disposition of a snapshot fact, or null when the design does not know the fact. */
    dispositionOf: (factKey: string) => IdmDisposition | null;
    scopeCatalog: readonly OrchestrationV2SourceScope[];
    dispositionCounts: Readonly<Record<IdmDisposition, number>>;
  }>;

export type IdmScopeView = Extract<OrchestrationScopeView, { kind: 'idm' }>;

/** Lesson composition of one IDM chapter shard; kept beside the plan because Python's
 * `ChapterShardPlanV2` forbids extra keys. */
export interface IdmShardLessons {
  task_key: string;
  chapter_key: string;
  shard_index: number;
  module_key: string;
  lesson_keys: readonly string[];
  /** Course-wide count of the lessons before this shard (earlier modules and shards); this is the
   * `lesson_index_offset` sent in `idm_module_context` and echoed in `IdmShardDesignV1`. */
  lesson_index_offset: number;
  /** Index of the shard's first lesson inside its chapter. */
  chapter_lesson_offset: number;
}

const LEGACY_VIEW: OrchestrationScopeView = Object.freeze({ kind: 'legacy' as const });
const COURSE_DISPOSITIONS = new Set<IdmDisposition>(['course', 'reference_job_aid']);
const HASH = /^[0-9a-f]{64}$/;
const KEY = /^[a-z0-9][a-z0-9_.:-]{0,159}$/;
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object'
  && !Array.isArray(value) ? value as Record<string, unknown> : null;
const integer = (value: number, minimum: number, maximum: number) => Number.isSafeInteger(value)
  && value >= minimum && value <= maximum;
const designInvalid = (): never => { throw new IdmError('IDM_COURSE_DESIGN_INVALID'); };
const sameList = (left: readonly string[], right: readonly string[]) => left.length === right.length
  && left.every((value, index) => value === right[index]);

/**
 * Build the IDM view of an already parsed design. Internal consistency that does
 * not need the database is enforced here: one disposition per fact, disjoint
 * block scopes covering exactly the course/reference facts, and scope fact sets
 * equal to their content block.
 */
export function idmScopeViewOf(design: IdmCourseDesignV1): IdmScopeView {
  const dispositionByFact = new Map<string, IdmDisposition>();
  const dispositionCounts = Object.fromEntries(IDM_DISPOSITIONS.map(name => [name, 0])) as Record<IdmDisposition, number>;
  const blockIds = new Set(design.blocks.map(block => block.block_id));
  if (blockIds.size !== design.blocks.length) designInvalid();
  for (const item of design.dispositions) {
    if (dispositionByFact.has(item.fact_key) || (item.disposition === 'noise') !== (item.block_id === null)
      || (item.block_id !== null && !blockIds.has(item.block_id))) designInvalid();
    dispositionByFact.set(item.fact_key, item.disposition);
    dispositionCounts[item.disposition] += 1;
  }
  const blockById = new Map(design.blocks.map(block => [block.block_id, block]));
  const scopeByFact = new Map<string, string>();
  const scopeKeys = new Set<string>();
  const scopedBlocks = new Set<string>();
  for (const scope of design.block_scopes) {
    const block = blockById.get(scope.block_id);
    if (!block || scopeKeys.has(scope.scope_key) || scopedBlocks.has(scope.block_id)
      || scope.fact_count !== scope.fact_keys.length || !sameList(scope.fact_keys, block.fact_keys)) designInvalid();
    scopeKeys.add(scope.scope_key);
    scopedBlocks.add(scope.block_id);
    for (const factKey of scope.fact_keys) {
      if (scopeByFact.has(factKey) || !COURSE_DISPOSITIONS.has(dispositionByFact.get(factKey) as IdmDisposition)) {
        designInvalid();
      }
      scopeByFact.set(factKey, scope.scope_key);
    }
  }
  for (const [factKey, value] of dispositionByFact) {
    if (COURSE_DISPOSITIONS.has(value) && !scopeByFact.has(factKey)) designInvalid();
  }
  const scopeCatalog = Object.freeze(design.block_scopes.map(scope => Object.freeze({
    scope_key: scope.scope_key, title: scope.title, source_ref: scope.source_ref,
    fact_count: scope.fact_count, content_chars: scope.content_chars,
  })));
  return Object.freeze({
    kind: 'idm' as const,
    design,
    scopeOfFact: (factKey: string) => scopeByFact.get(factKey) ?? null,
    dispositionOf: (factKey: string) => dispositionByFact.get(factKey) ?? null,
    scopeCatalog,
    dispositionCounts: Object.freeze(dispositionCounts),
  });
}

/** Resolve the scope view of a run from its pipeline and its stored `course_skeleton` payload. */
export function resolveOrchestrationScopeView(
  pipeline: OrchestrationV2RunPipeline,
  skeletonArtifactPayload: unknown,
): OrchestrationScopeView {
  if (pipeline === IDM_LEGACY_PIPELINE_VERSION) return LEGACY_VIEW;
  if (pipeline !== IDM_PIPELINE_VERSION) throw new IdmError('IDM_CONTRACT_INVALID');
  const payload = record(skeletonArtifactPayload);
  if (!payload || payload.idm === undefined) designInvalid();
  return idmScopeViewOf(readIdmCourseDesign((payload as Record<string, unknown>).idm));
}

/**
 * Re-key source facts to IDM block scopes before they are sent to Python. Facts
 * outside the course (nice-to-know, remove, hold, noise) are dropped; a fact the
 * design does not know means the snapshot and the design diverged.
 */
export function remapFactsToBlockScopes(
  facts: readonly OrchestrationV2SourceFact[],
  view: OrchestrationScopeView,
): OrchestrationV2SourceFact[] {
  if (view.kind === 'legacy') return [...facts];
  return facts.flatMap(fact => {
    const disposition = view.dispositionOf(fact.fact_key);
    if (disposition === null) return designInvalid();
    const scope = view.scopeOfFact(fact.fact_key);
    return scope === null ? [] : [{ ...fact, scope_key: scope }];
  });
}

/**
 * Node-side re-check of a Python course design before it becomes durable
 * (spec §12.6). `snapshotFacts` are the persisted snapshot facts in ordinal order
 * with their Postgres `char_length`.
 */
export function assertIdmCourseDesignInvariants(input: {
  design: IdmCourseDesignV1;
  skeleton: OrchestrationV2CourseSkeleton;
  sourceSnapshotHash: string;
  snapshotFacts: ReadonlyArray<{ fact_key: string; fact_chars: number }>;
}): IdmScopeView {
  const { design, skeleton } = input;
  if (design.design_hash !== idmDesignHash(design) || design.source_snapshot_hash !== input.sourceSnapshotHash
    || skeleton.source_snapshot_hash !== input.sourceSnapshotHash
    || design.project_context.locale !== skeleton.locale) designInvalid();
  const view = idmScopeViewOf(design);

  // 1. Every snapshot fact has exactly one disposition, and nothing else does.
  const snapshotChars = new Map<string, number>();
  for (const fact of input.snapshotFacts) {
    if (snapshotChars.has(fact.fact_key) || !integer(fact.fact_chars, 1, 1_000_000)) designInvalid();
    snapshotChars.set(fact.fact_key, fact.fact_chars);
  }
  if (!snapshotChars.size || design.dispositions.length !== snapshotChars.size
    || design.dispositions.some(item => !snapshotChars.has(item.fact_key))) designInvalid();

  // 2. Block scopes: deterministic keys, sizes measured from the persisted snapshot, and every
  //    course/reference disposition points at the block that owns its scope.
  const scopeBlockOfFact = new Map<string, string>();
  for (const scope of design.block_scopes) {
    const chars = scope.fact_keys.reduce((total, key) => total + (snapshotChars.get(key) ?? designInvalid()), 0);
    if (scope.content_chars !== Math.max(1, chars)
      || scope.scope_key !== idmBlockScopeKey(input.sourceSnapshotHash, scope.block_id, scope.fact_keys)) {
      designInvalid();
    }
    for (const key of scope.fact_keys) scopeBlockOfFact.set(key, scope.block_id);
  }
  if (design.dispositions.some(item => COURSE_DISPOSITIONS.has(item.disposition)
    && scopeBlockOfFact.get(item.fact_key) !== item.block_id)) designInvalid();

  // 3. One chapter per module; chapter i owns exactly the block scopes of module i (lesson → block order).
  const scopeOfBlock = new Map(design.block_scopes.map(scope => [scope.block_id, scope.scope_key]));
  const lessonKeys = design.modules.flatMap(module => module.lessons.map(lesson => lesson.lesson_key));
  const moduleKeys = design.modules.map(module => module.module_key);
  const lessonBlocks = design.modules.flatMap(module => module.lessons.flatMap(lesson => lesson.block_ids));
  if (new Set(lessonKeys).size !== lessonKeys.length || new Set(moduleKeys).size !== moduleKeys.length
    || new Set(lessonBlocks).size !== lessonBlocks.length || lessonBlocks.length !== scopeOfBlock.size
    || lessonBlocks.some(blockId => !scopeOfBlock.has(blockId))
    || skeleton.chapters.length !== design.modules.length) designInvalid();
  const catalog = new Set(view.scopeCatalog.map(scope => scope.scope_key));
  const assigned = skeleton.chapters.flatMap(chapter => chapter.source_scope_ids);
  if (assigned.length !== new Set(assigned).size || assigned.length !== catalog.size
    || assigned.some(scopeKey => !catalog.has(scopeKey))) designInvalid();
  for (const chapter of skeleton.chapters) {
    const module = design.modules[chapter.order];
    if (!module || chapter.chapter_key !== `chapter-${chapter.order + 1}`
      || !sameList(chapter.source_scope_ids, module.lessons.flatMap(lesson =>
        lesson.block_ids.map(blockId => scopeOfBlock.get(blockId) as string)))) designInvalid();
  }
  return view;
}

function providerBudget(value: OrchestrationV2PlanningBudgets['chapter']) {
  if (!value || !integer(value.input_tokens, 1, 2_000_000) || !integer(value.embedding_tokens, 0, 2_000_000)
    || !integer(value.max_output_tokens, 1, 65_536) || !integer(value.max_provider_attempts, 1, 2)
    || !integer(value.execution_budget_ms, 1, 600_000)) {
    throw new OrchestrationV2PlanningError('ORCHESTRATION_V2_PLANNING_INVALID');
  }
  return Object.freeze({ ...value });
}

/**
 * IDM chapter fan-out (spec §12.3 row 1): one chapter per module; whole lessons
 * are packed in order into shards whose block-scope `content_chars` stay within
 * `maxSourceChars`. Task specs keep exactly the legacy shape and contract-hash
 * inputs; the lesson composition is returned in a side map keyed by task key.
 */
export function planIdmChapterShards(
  skeleton: OrchestrationV2CourseSkeleton,
  design: IdmCourseDesignV1,
  budgets: OrchestrationV2PlanningBudgets,
  skeletonArtifactHash: string,
  maxSourceChars = IDM_SHARD_MAX_SOURCE_CHARS,
): Readonly<{
  chapter_tasks: readonly OrchestrationV2PlanningTaskSpec[];
  validation_task: OrchestrationV2PlanningTaskSpec;
  shard_lessons: ReadonlyMap<string, IdmShardLessons>;
}> {
  if (!skeleton || !HASH.test(skeleton.source_snapshot_hash) || !HASH.test(skeletonArtifactHash)
    || !integer(maxSourceChars, 1, 100_000_000)
    || !integer(budgets.architecture_validation_budget_ms, 1, 600_000)
    || !integer(budgets.inventory_publish_budget_ms, 1, 600_000)) {
    throw new OrchestrationV2PlanningError('ORCHESTRATION_V2_PLANNING_INVALID');
  }
  const chapterBudget = providerBudget(budgets.chapter);
  providerBudget(budgets.skeleton);
  if (skeleton.chapters.length !== design.modules.length) designInvalid();
  const scopeByBlock = new Map(design.block_scopes.map(scope => [scope.block_id, scope]));
  const chapterTasks: OrchestrationV2PlanningTaskSpec[] = [];
  const shardLessons = new Map<string, IdmShardLessons>();
  for (const chapter of [...skeleton.chapters].sort((a, b) => a.order - b.order)) {
    const module = design.modules[chapter.order];
    if (!module) return designInvalid();
    const lessons = module.lessons.map(lesson => {
      const scopes = lesson.block_ids.map(blockId => scopeByBlock.get(blockId) ?? designInvalid());
      const chars = scopes.reduce((sum, scope) => sum + scope.content_chars, 0);
      if (chars > maxSourceChars) throw new IdmError('IDM_LESSON_EXCEEDS_SHARD');
      return { lesson_key: lesson.lesson_key, scopes, chars,
        facts: scopes.reduce((sum, scope) => sum + scope.fact_count, 0) };
    });
    if (!sameList(chapter.source_scope_ids, lessons.flatMap(lesson => lesson.scopes.map(scope => scope.scope_key)))) {
      designInvalid();
    }
    const groups: Array<typeof lessons> = [];
    let current: typeof lessons = [], chars = 0;
    for (const lesson of lessons) {
      if (current.length && chars + lesson.chars > maxSourceChars) {
        groups.push(current); current = []; chars = 0;
      }
      current.push(lesson); chars += lesson.chars;
    }
    if (current.length) groups.push(current);
    const courseOffset = lessonsBefore(design, chapter.order);
    let lessonOffset = 0;
    for (const [index, group] of groups.entries()) {
      const shardPlan: OrchestrationV2ChapterShardPlan = {
        chapter_key: chapter.chapter_key, order: chapter.order, shard_index: index, shard_count: groups.length,
        source_scope_ids: group.flatMap(lesson => lesson.scopes.map(scope => scope.scope_key)),
        source_fact_count: group.reduce((sum, lesson) => sum + lesson.facts, 0),
        source_content_chars: group.reduce((sum, lesson) => sum + lesson.chars, 0),
      };
      const taskKey = `architecture:chapter:${chapter.chapter_key}:shard:${index + 1}`;
      if (!KEY.test(taskKey)) throw new OrchestrationV2PlanningError('ORCHESTRATION_V2_PLANNING_INVALID');
      const base = { contract_version: 2, task_key: taskKey, kind: 'chapter_blueprint' as const,
        source_snapshot_hash: skeleton.source_snapshot_hash, skeleton_artifact_hash: skeletonArtifactHash,
        shard_plan: shardPlan, budget: chapterBudget };
      chapterTasks.push(Object.freeze({ task_key: taskKey, kind: base.kind, chapter_key: chapter.chapter_key,
        contract_hash: orchestrationV2Hash(base), input_context_hash: skeletonArtifactHash,
        budget: chapterBudget, shard_plan: Object.freeze({ ...shardPlan, source_scope_ids: [...shardPlan.source_scope_ids] }) }));
      shardLessons.set(taskKey, Object.freeze({ task_key: taskKey, chapter_key: chapter.chapter_key,
        shard_index: index, module_key: module.module_key,
        lesson_keys: Object.freeze(group.map(lesson => lesson.lesson_key)),
        lesson_index_offset: courseOffset + lessonOffset, chapter_lesson_offset: lessonOffset }));
      lessonOffset += group.length;
    }
  }
  if (!chapterTasks.length || chapterTasks.length > 4_096) {
    throw new OrchestrationV2PlanningError('ORCHESTRATION_V2_PLANNING_INVALID');
  }
  const validationBase = { contract_version: 2, task_key: 'architecture:validate',
    kind: 'validate_architecture' as const, source_snapshot_hash: skeleton.source_snapshot_hash,
    skeleton_artifact_hash: skeletonArtifactHash, chapter_contract_hashes: chapterTasks.map(task => task.contract_hash),
    execution_budget_ms: budgets.architecture_validation_budget_ms };
  const validationTask: OrchestrationV2PlanningTaskSpec = Object.freeze({
    task_key: validationBase.task_key, kind: validationBase.kind, chapter_key: null,
    contract_hash: orchestrationV2Hash(validationBase), input_context_hash: skeletonArtifactHash,
    budget: Object.freeze({ input_tokens: 0, embedding_tokens: 0, max_output_tokens: 0,
      max_provider_attempts: 0, execution_budget_ms: budgets.architecture_validation_budget_ms }),
  });
  return Object.freeze({ chapter_tasks: Object.freeze(chapterTasks), validation_task: validationTask,
    shard_lessons: shardLessons });
}

/** Recover the lesson composition of a stored IDM shard plan (whole lessons, in module order). */
export function idmShardLessonsOf(
  design: IdmCourseDesignV1,
  plan: OrchestrationV2ChapterShardPlan,
): IdmShardLessons {
  const module = design.modules[plan.order];
  if (!module || plan.chapter_key !== `chapter-${plan.order + 1}`) return designInvalid();
  const scopeOfBlock = new Map(design.block_scopes.map(scope => [scope.block_id, scope.scope_key]));
  const wanted = new Set(plan.source_scope_ids);
  const members = module.lessons.map((lesson, index) => {
    const scopes = lesson.block_ids.map(blockId => scopeOfBlock.get(blockId) ?? designInvalid());
    const inShard = scopes.filter(scope => wanted.has(scope)).length;
    if (inShard && inShard !== scopes.length) designInvalid();
    return { index, lesson, scopes, inShard: inShard > 0 };
  }).filter(member => member.inShard);
  if (!members.length || members.some((member, position) => member.index !== members[0]!.index + position)
    || !sameList(members.flatMap(member => member.scopes), plan.source_scope_ids)) designInvalid();
  return Object.freeze({ task_key: `architecture:chapter:${plan.chapter_key}:shard:${plan.shard_index + 1}`,
    chapter_key: plan.chapter_key, shard_index: plan.shard_index, module_key: module.module_key,
    lesson_keys: Object.freeze(members.map(member => member.lesson.lesson_key)),
    lesson_index_offset: lessonsBefore(design, plan.order) + members[0]!.index,
    chapter_lesson_offset: members[0]!.index });
}

function lessonsBefore(design: IdmCourseDesignV1, moduleIndex: number): number {
  return design.modules.slice(0, moduleIndex).reduce((sum, module) => sum + module.lessons.length, 0);
}

/** The six V2 component types the IDM module designer may use (spec §10). */
export const IDM_V2_COMPONENT_TYPES = ['html', 'problem', 'la_faq', 'la_sortable', 'la_crossword', 'la_diagram'] as const;

/**
 * `idm_module_context` of one chapter shard (spec §7.6.1, §11.2): the module plan
 * restricted to the shard's lessons, plus the blocks, blueprint rows and block
 * scopes of exactly those lessons (in design order). Python rejects the request
 * with `IDM_MODULE_CONTEXT_INVALID` if any of it disagrees with the shard plan.
 */
export function buildIdmModuleContext(input: {
  design: IdmCourseDesignV1;
  lessons: IdmShardLessons;
  allowed_component_types: readonly string[];
  input_tokens: number;
  max_output_tokens: number;
  provider_max_attempts: number;
  remaining_ms: number;
}): IdmModuleContextV1 {
  const { design, lessons } = input;
  const module = design.modules.find(item => item.module_key === lessons.module_key) ?? designInvalid();
  const shardLessons = lessons.lesson_keys.map(key => module.lessons.find(lesson => lesson.lesson_key === key)
    ?? designInvalid());
  const blockIds = new Set(shardLessons.flatMap(lesson => lesson.block_ids));
  const allowed = IDM_V2_COMPONENT_TYPES.filter(type => input.allowed_component_types.includes(type));
  return readIdmModuleContext({
    pipeline_version: IDM_PIPELINE_VERSION,
    project_context: design.project_context,
    target_audience: design.target_audience,
    module: { ...module, lessons: shardLessons },
    learning_objectives: design.learning_objectives,
    must_dos: design.must_dos,
    blocks: design.blocks.filter(block => blockIds.has(block.block_id)),
    blueprint: design.blueprint.filter(row => blockIds.has(row.block_id)),
    block_scopes: design.block_scopes.filter(scope => blockIds.has(scope.block_id)),
    lesson_index_offset: lessons.lesson_index_offset,
    allowed_component_types: allowed,
    token_allowance: idmTokenAllowance(input, 'idm_module_context.token_allowance'),
    remaining_budget_ms: idmRemainingBudgetMs(input.remaining_ms, 'idm_module_context.remaining_budget_ms'),
    design_hash: design.design_hash,
  });
}
