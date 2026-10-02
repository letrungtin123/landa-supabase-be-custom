import { createHash } from 'node:crypto';

export const LESSON_AUTHOR_ORCHESTRATION_V2 = 2 as const;
export const LESSON_AUTHOR_PROVIDER_MAX_OUTPUT_TOKENS = 65_536;
export const LESSON_AUTHOR_PROVIDER_MAX_ATTEMPTS = 2;

export type OrchestrationV2TaskKind =
  | 'source_snapshot'
  | 'course_skeleton'
  | 'chapter_blueprint'
  | 'validate_architecture'
  | 'publish_inventory'
  | 'generate_unit'
  | 'validate_chapter'
  | 'finalize_course';

export interface OrchestrationV2Budget {
  input_tokens: number;
  embedding_tokens: number;
  max_output_tokens: number;
  max_provider_attempts: number;
  execution_budget_ms: number;
}

export interface OrchestrationV2UnitSpec {
  node_id: string;
  contract_hash: string;
  budget: OrchestrationV2Budget;
}

export interface OrchestrationV2ChapterSpec {
  chapter_key: string;
  chapter_node_id: string;
  source_scope_hash: string;
  architecture_budget: OrchestrationV2Budget;
  units: readonly OrchestrationV2UnitSpec[];
}

export interface OrchestrationV2PlanInput {
  source_snapshot_hash: string;
  source_snapshot_budget_ms: number;
  skeleton_budget: OrchestrationV2Budget;
  chapters: readonly OrchestrationV2ChapterSpec[];
  architecture_validation_budget_ms: number;
  inventory_publish_budget_ms: number;
  chapter_validation_budget_ms: number;
  finalization_budget_ms: number;
}

export interface OrchestrationV2Task {
  ordinal: number;
  task_key: string;
  kind: OrchestrationV2TaskKind;
  chapter_key: string | null;
  node_id: string | null;
  contract_hash: string;
  depends_on: readonly string[];
  budget: Readonly<OrchestrationV2Budget>;
}

export interface OrchestrationV2Manifest {
  version: typeof LESSON_AUTHOR_ORCHESTRATION_V2;
  source_snapshot_hash: string;
  tasks: readonly OrchestrationV2Task[];
  token_ceiling: number;
  execution_budget_ms: number;
  manifest_hash: string;
}

export interface OrchestrationV2PersistedTask {
  ordinal: number;
  task_key: string;
  kind: OrchestrationV2TaskKind;
  chapter_key: string | null;
  node_id: string | null;
  contract_hash: string;
  input_context_hash: string | null;
  priority: number;
  max_attempts: number;
  depends_on: readonly string[];
  budget: Readonly<OrchestrationV2Budget>;
}

export interface OrchestrationV2PersistedManifest {
  version: typeof LESSON_AUTHOR_ORCHESTRATION_V2;
  source_snapshot_hash: string;
  tasks: readonly OrchestrationV2PersistedTask[];
  token_ceiling: number;
  execution_budget_ms: number;
  manifest_hash: string;
}

export interface OrchestrationV2CompletionInput {
  manifest: OrchestrationV2Manifest;
  succeeded_task_keys: readonly string[];
  admitted_fact_count: number;
  allocated_fact_count: number;
  covered_fact_count: number;
  duplicate_fact_count: number;
  unresolved_fact_count: number;
  chapter_receipt_count: number;
}

export interface OrchestrationV2CompletionReceipt {
  contract: 'lesson-author-course-completion-v2';
  manifest_hash: string;
  task_count: number;
  admitted_fact_count: number;
  allocated_fact_count: number;
  covered_fact_count: number;
  chapter_receipt_count: number;
  checks: Readonly<{
    tasks: 'PASS';
    allocation: 'PASS';
    coverage: 'PASS';
    duplicates: 'PASS';
    chapters: 'PASS';
  }>;
  receipt_hash: string;
}

export type OrchestrationV2ErrorCode =
  | 'ORCHESTRATION_V2_INPUT_INVALID'
  | 'ORCHESTRATION_V2_BUDGET_INVALID'
  | 'ORCHESTRATION_V2_DEPENDENCY_INVALID'
  | 'ORCHESTRATION_V2_COMPLETENESS_FAILED';

export class OrchestrationV2Error extends Error {
  constructor(readonly code: OrchestrationV2ErrorCode) {
    super(code);
    this.name = 'OrchestrationV2Error';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const KEY = /^[a-z0-9][a-z0-9_.:-]{0,159}$/;
const MAX_TASKS = 32_768;
const MAX_CHAPTERS = 512;
const MAX_UNITS_PER_CHAPTER = 512;
const TASK_KINDS = new Set<OrchestrationV2TaskKind>(['source_snapshot', 'course_skeleton', 'chapter_blueprint',
  'validate_architecture', 'publish_inventory', 'generate_unit', 'validate_chapter', 'finalize_course']);

function fail(code: OrchestrationV2ErrorCode): never { throw new OrchestrationV2Error(code); }
function safeInteger(value: number, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}
export function orchestrationV2Hash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
function budget(value: OrchestrationV2Budget, provider: boolean): Readonly<OrchestrationV2Budget> {
  if (!value || !safeInteger(value.input_tokens, provider ? 1 : 0, 2_000_000)
    || !safeInteger(value.embedding_tokens, 0, 2_000_000)
    || !safeInteger(value.execution_budget_ms, 1, 600_000)
    || !safeInteger(value.max_output_tokens, provider ? 1 : 0, LESSON_AUTHOR_PROVIDER_MAX_OUTPUT_TOKENS)
    || !safeInteger(value.max_provider_attempts, provider ? 1 : 0, LESSON_AUTHOR_PROVIDER_MAX_ATTEMPTS)
    || (!provider && (value.max_output_tokens !== 0 || value.max_provider_attempts !== 0))) {
    fail('ORCHESTRATION_V2_BUDGET_INVALID');
  }
  return Object.freeze({ ...value });
}
function deterministicBudget(execution_budget_ms: number): Readonly<OrchestrationV2Budget> {
  return budget({ input_tokens: 0, embedding_tokens: 0, max_output_tokens: 0,
    max_provider_attempts: 0, execution_budget_ms }, false);
}
function taskContract(value: Omit<OrchestrationV2Task, 'ordinal' | 'contract_hash'>): string {
  return orchestrationV2Hash({ version: LESSON_AUTHOR_ORCHESTRATION_V2, ...value });
}
function freezeTask(ordinal: number, value: Omit<OrchestrationV2Task, 'ordinal' | 'contract_hash'>): OrchestrationV2Task {
  return Object.freeze({ ordinal, ...value, depends_on: Object.freeze([...value.depends_on]),
    budget: Object.freeze({ ...value.budget }), contract_hash: taskContract(value) });
}

/**
 * Build a finite dependency graph for one-click full-course generation.
 * RabbitMQ delivery and worker concurrency may change execution order only
 * among tasks whose dependencies have succeeded; neither is authority for the
 * graph itself. The manifest is immutable and safe to persist before dispatch.
 */
export function buildOrchestrationV2Manifest(input: OrchestrationV2PlanInput): OrchestrationV2Manifest {
  if (!input || !HASH.test(input.source_snapshot_hash) || !Array.isArray(input.chapters)
    || input.chapters.length < 1 || input.chapters.length > MAX_CHAPTERS) fail('ORCHESTRATION_V2_INPUT_INVALID');
  const chapters = input.chapters.map(chapter => ({ ...chapter, units: [...chapter.units] }));
  const chapterKeys = new Set<string>(), nodeIds = new Set<string>();
  for (const chapter of chapters) {
    if (!KEY.test(chapter.chapter_key) || chapterKeys.has(chapter.chapter_key) || !UUID.test(chapter.chapter_node_id)
      || nodeIds.has(chapter.chapter_node_id) || !HASH.test(chapter.source_scope_hash)
      || !chapter.units.length || chapter.units.length > MAX_UNITS_PER_CHAPTER) fail('ORCHESTRATION_V2_INPUT_INVALID');
    chapterKeys.add(chapter.chapter_key); nodeIds.add(chapter.chapter_node_id);
    for (const unit of chapter.units) {
      if (!UUID.test(unit.node_id) || nodeIds.has(unit.node_id) || !HASH.test(unit.contract_hash)) fail('ORCHESTRATION_V2_INPUT_INVALID');
      nodeIds.add(unit.node_id);
    }
  }
  const tasks: OrchestrationV2Task[] = [];
  const append = (value: Omit<OrchestrationV2Task, 'ordinal' | 'contract_hash'>) => {
    if (!KEY.test(value.task_key) || tasks.some(task => task.task_key === value.task_key)) fail('ORCHESTRATION_V2_INPUT_INVALID');
    tasks.push(freezeTask(tasks.length, value));
  };
  append({task_key:'source:snapshot',kind:'source_snapshot',chapter_key:null,node_id:null,depends_on:[],
    budget:deterministicBudget(input.source_snapshot_budget_ms)});
  append({ task_key:'architecture:course',kind:'course_skeleton',chapter_key:null,node_id:null,depends_on:['source:snapshot'],
    budget:budget(input.skeleton_budget,true) });
  for (const chapter of chapters) append({ task_key:`architecture:chapter:${chapter.chapter_key}`,kind:'chapter_blueprint',
    chapter_key:chapter.chapter_key,node_id:chapter.chapter_node_id,depends_on:['architecture:course'],
    budget:budget(chapter.architecture_budget,true) });
  const architectureKeys=chapters.map(chapter=>`architecture:chapter:${chapter.chapter_key}`);
  append({task_key:'architecture:validate',kind:'validate_architecture',chapter_key:null,node_id:null,
    depends_on:architectureKeys,budget:deterministicBudget(input.architecture_validation_budget_ms)});
  append({task_key:'inventory:publish',kind:'publish_inventory',chapter_key:null,node_id:null,
    depends_on:['architecture:validate'],budget:deterministicBudget(input.inventory_publish_budget_ms)});
  for (const chapter of chapters) {
    const unitKeys:string[]=[];
    for (const [index,unit] of chapter.units.entries()) {
      const taskKey=`content:${chapter.chapter_key}:unit:${index+1}`; unitKeys.push(taskKey);
      append({task_key:taskKey,kind:'generate_unit',chapter_key:chapter.chapter_key,node_id:unit.node_id,
        depends_on:['inventory:publish'],budget:budget(unit.budget,true)});
    }
    append({task_key:`content:${chapter.chapter_key}:validate`,kind:'validate_chapter',chapter_key:chapter.chapter_key,
      node_id:chapter.chapter_node_id,depends_on:unitKeys,budget:deterministicBudget(input.chapter_validation_budget_ms)});
  }
  append({task_key:'course:finalize',kind:'finalize_course',chapter_key:null,node_id:null,
    depends_on:chapters.map(chapter=>`content:${chapter.chapter_key}:validate`),
    budget:deterministicBudget(input.finalization_budget_ms)});
  if (tasks.length > MAX_TASKS) fail('ORCHESTRATION_V2_INPUT_INVALID');
  const positions=new Map(tasks.map(task=>[task.task_key,task.ordinal]));
  for (const task of tasks) for (const dependency of task.depends_on) {
    const position=positions.get(dependency);
    if (position===undefined || position>=task.ordinal) fail('ORCHESTRATION_V2_DEPENDENCY_INVALID');
  }
  let tokenCeiling=0,executionBudget=0;
  for(const task of tasks){
    const tokens=task.budget.input_tokens+task.budget.embedding_tokens
      + task.budget.max_output_tokens*task.budget.max_provider_attempts;
    tokenCeiling+=tokens; executionBudget+=task.budget.execution_budget_ms;
    if(!Number.isSafeInteger(tokenCeiling)||!Number.isSafeInteger(executionBudget))fail('ORCHESTRATION_V2_BUDGET_INVALID');
  }
  const content={version:LESSON_AUTHOR_ORCHESTRATION_V2,source_snapshot_hash:input.source_snapshot_hash,
    tasks:Object.freeze(tasks),token_ceiling:tokenCeiling,execution_budget_ms:executionBudget};
  return Object.freeze({...content,manifest_hash:orchestrationV2Hash(content)});
}

/**
 * Seal the exact persisted shard-aware graph. Unlike the early planning helper,
 * this function receives every real task and dependency after inventory fan-out,
 * so its hash is the runtime authority rather than an estimated architecture.
 */
export function sealOrchestrationV2PersistedManifest(input: {
  source_snapshot_hash: string;
  tasks: readonly OrchestrationV2PersistedTask[];
}): Readonly<OrchestrationV2PersistedManifest> {
  if (!input || !HASH.test(input.source_snapshot_hash) || !Array.isArray(input.tasks)
    || input.tasks.length < 8 || input.tasks.length > MAX_TASKS) fail('ORCHESTRATION_V2_INPUT_INVALID');
  const providerKinds = new Set<OrchestrationV2TaskKind>(['course_skeleton', 'chapter_blueprint', 'generate_unit']);
  // Database task rows also carry runtime-only fields such as `id`, status and
  // lease metadata. A manifest is an authority contract, so hash only the
  // declared persisted-task fields. Spreading the row here previously made the
  // inventory hash depend on whichever query shape happened to load it, while
  // finalization reconstructed the declared shape and therefore got a different
  // hash for the same task graph.
  const tasks = [...input.tasks].sort((a, b) => a.ordinal - b.ordinal).map(task => ({
    ordinal: task.ordinal,
    task_key: task.task_key,
    kind: task.kind,
    chapter_key: task.chapter_key,
    node_id: task.node_id,
    contract_hash: task.contract_hash,
    input_context_hash: task.input_context_hash,
    priority: task.priority,
    max_attempts: task.max_attempts,
    depends_on: [...task.depends_on],
    budget: budget({
      input_tokens: task.budget.input_tokens,
      embedding_tokens: task.budget.embedding_tokens,
      max_output_tokens: task.budget.max_output_tokens,
      max_provider_attempts: task.budget.max_provider_attempts,
      execution_budget_ms: task.budget.execution_budget_ms,
    }, providerKinds.has(task.kind)),
  }));
  const keys = new Set<string>();
  for (const [index, task] of tasks.entries()) {
    if (task.ordinal !== index || !KEY.test(task.task_key) || keys.has(task.task_key) || !TASK_KINDS.has(task.kind)
      || (task.chapter_key !== null && !KEY.test(task.chapter_key))
      || (task.node_id !== null && !UUID.test(task.node_id)) || !HASH.test(task.contract_hash)
      || (task.input_context_hash !== null && !HASH.test(task.input_context_hash))
      || !safeInteger(task.priority, 0, 1_000) || !safeInteger(task.max_attempts, 1, 2)
      || !Array.isArray(task.depends_on) || new Set(task.depends_on).size !== task.depends_on.length) {
      fail('ORCHESTRATION_V2_INPUT_INVALID');
    }
    keys.add(task.task_key);
  }
  const positions = new Map(tasks.map(task => [task.task_key, task.ordinal]));
  for (const task of tasks) for (const dependency of task.depends_on) {
    const position = positions.get(dependency);
    if (position === undefined || position >= task.ordinal) fail('ORCHESTRATION_V2_DEPENDENCY_INVALID');
  }
  const byKind = (kind: OrchestrationV2TaskKind) => tasks.filter(task => task.kind === kind);
  const exactlyOne = (kind: OrchestrationV2TaskKind) => byKind(kind).length === 1;
  const chapters = byKind('validate_chapter');
  const units = byKind('generate_unit');
  const chapterKeys = new Set(chapters.map(task => task.chapter_key));
  if (!exactlyOne('source_snapshot') || !exactlyOne('course_skeleton') || !exactlyOne('validate_architecture')
    || !exactlyOne('publish_inventory') || !exactlyOne('finalize_course') || !byKind('chapter_blueprint').length
    || !units.length || !chapters.length || chapterKeys.has(null) || chapterKeys.size !== chapters.length
    || units.some(task => task.chapter_key === null || task.node_id === null || !chapterKeys.has(task.chapter_key))
    || chapters.some(task => task.node_id === null)) fail('ORCHESTRATION_V2_INPUT_INVALID');
  const keyOf = (kind: OrchestrationV2TaskKind) => byKind(kind)[0]!.task_key;
  const same = (left: readonly string[], right: readonly string[]) => left.length === right.length
    && left.every((value, index) => value === right[index]);
  if (byKind('source_snapshot')[0]!.depends_on.length
    || !same(byKind('course_skeleton')[0]!.depends_on, [keyOf('source_snapshot')])
    || byKind('chapter_blueprint').some(task => !same(task.depends_on, [keyOf('course_skeleton')]))
    || !same(byKind('validate_architecture')[0]!.depends_on,
      byKind('chapter_blueprint').map(task => task.task_key))
    || !same(byKind('publish_inventory')[0]!.depends_on, [keyOf('validate_architecture')])
    || units.some(task => !same(task.depends_on, [keyOf('publish_inventory')]))
    || chapters.some(task => !same(task.depends_on,
      units.filter(unit => unit.chapter_key === task.chapter_key).map(unit => unit.task_key)))
    || !same(byKind('finalize_course')[0]!.depends_on, chapters.map(task => task.task_key))) {
    fail('ORCHESTRATION_V2_DEPENDENCY_INVALID');
  }
  let tokenCeiling = 0, executionBudget = 0;
  const frozenTasks = tasks.map(task => Object.freeze({ ...task, depends_on: Object.freeze([...task.depends_on]),
    budget: Object.freeze({ ...task.budget }) }));
  for (const task of frozenTasks) {
    tokenCeiling += task.budget.input_tokens + task.budget.embedding_tokens
      + task.budget.max_output_tokens * task.budget.max_provider_attempts;
    executionBudget += task.budget.execution_budget_ms;
    if (!Number.isSafeInteger(tokenCeiling) || !Number.isSafeInteger(executionBudget)) {
      fail('ORCHESTRATION_V2_BUDGET_INVALID');
    }
  }
  if (tokenCeiling < 1 || executionBudget < 1) fail('ORCHESTRATION_V2_BUDGET_INVALID');
  const content = { version: LESSON_AUTHOR_ORCHESTRATION_V2, source_snapshot_hash: input.source_snapshot_hash,
    tasks: Object.freeze(frozenTasks), token_ceiling: tokenCeiling, execution_budget_ms: executionBudget };
  return Object.freeze({ ...content, manifest_hash: orchestrationV2Hash(content) });
}

/** A truthful terminal gate. It never infers coverage from a successful task. */
export function completeOrchestrationV2(input: OrchestrationV2CompletionInput): OrchestrationV2CompletionReceipt {
  const manifest=input?.manifest;
  if(!manifest||manifest.version!==LESSON_AUTHOR_ORCHESTRATION_V2||orchestrationV2Hash({version:manifest.version,
    source_snapshot_hash:manifest.source_snapshot_hash,tasks:manifest.tasks,token_ceiling:manifest.token_ceiling,
    execution_budget_ms:manifest.execution_budget_ms})!==manifest.manifest_hash)fail('ORCHESTRATION_V2_INPUT_INVALID');
  const succeeded=new Set(input.succeeded_task_keys);
  if(succeeded.size!==manifest.tasks.length||manifest.tasks.some(task=>!succeeded.has(task.task_key))
    || !safeInteger(input.admitted_fact_count,1,10_000_000)
    || input.allocated_fact_count!==input.admitted_fact_count||input.covered_fact_count!==input.admitted_fact_count
    || input.duplicate_fact_count!==0||input.unresolved_fact_count!==0
    || input.chapter_receipt_count!==manifest.tasks.filter(task=>task.kind==='validate_chapter').length) {
    fail('ORCHESTRATION_V2_COMPLETENESS_FAILED');
  }
  const base={contract:'lesson-author-course-completion-v2' as const,manifest_hash:manifest.manifest_hash,
    task_count:manifest.tasks.length,admitted_fact_count:input.admitted_fact_count,
    allocated_fact_count:input.allocated_fact_count,covered_fact_count:input.covered_fact_count,
    chapter_receipt_count:input.chapter_receipt_count,checks:Object.freeze({tasks:'PASS' as const,allocation:'PASS' as const,
      coverage:'PASS' as const,duplicates:'PASS' as const,chapters:'PASS' as const})};
  return Object.freeze({...base,receipt_hash:orchestrationV2Hash(base)});
}
