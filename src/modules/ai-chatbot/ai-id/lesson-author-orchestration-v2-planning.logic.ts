import { orchestrationV2Hash, type OrchestrationV2Budget } from './lesson-author-orchestration-v2.logic.js';
import type {
  OrchestrationV2ChapterShardPlan,
  OrchestrationV2CourseSkeleton,
  OrchestrationV2SourceScope,
} from './lesson-author-orchestration-v2-rag-contract.logic.js';

export const ORCHESTRATION_V2_MAX_SHARD_SOURCE_CHARS = 400_000;
export const ORCHESTRATION_V3_MAX_SHARD_SOURCE_CHARS = 60_000;

export interface OrchestrationV2PlanningBudgets {
  skeleton: OrchestrationV2Budget;
  chapter: OrchestrationV2Budget;
  architecture_validation_budget_ms: number;
  inventory_publish_budget_ms: number;
}

export interface OrchestrationV2PlanningTaskSpec {
  task_key: string;
  kind: 'course_skeleton' | 'chapter_blueprint' | 'validate_architecture' | 'publish_inventory';
  chapter_key: string | null;
  contract_hash: string;
  input_context_hash: string;
  budget: Readonly<OrchestrationV2Budget>;
  shard_plan?: Readonly<OrchestrationV2ChapterShardPlan>;
}

export class OrchestrationV2PlanningError extends Error {
  constructor(readonly code: 'ORCHESTRATION_V2_PLANNING_INVALID' | 'ORCHESTRATION_V2_SCOPE_EXCEEDS_SHARD') {
    super(code);
    this.name = 'OrchestrationV2PlanningError';
  }
}

const HASH = /^[0-9a-f]{64}$/;
const KEY = /^[a-z0-9][a-z0-9_.:-]{0,159}$/;
const integer = (value: number, minimum: number, maximum: number) => Number.isSafeInteger(value)
  && value >= minimum && value <= maximum;
const fail = (code: OrchestrationV2PlanningError['code']): never => { throw new OrchestrationV2PlanningError(code); };

function providerBudget(value: OrchestrationV2Budget): Readonly<OrchestrationV2Budget> {
  if (!value || !integer(value.input_tokens, 1, 2_000_000) || !integer(value.embedding_tokens, 0, 2_000_000)
    || !integer(value.max_output_tokens, 1, 65_536) || !integer(value.max_provider_attempts, 1, 2)
    || !integer(value.execution_budget_ms, 1, 600_000)) fail('ORCHESTRATION_V2_PLANNING_INVALID');
  return Object.freeze({ ...value });
}

export function buildOrchestrationV2SkeletonTask(
  sourceSnapshotHash: string,
  sourceCatalogHash: string,
  budgetInput: OrchestrationV2Budget,
): Readonly<OrchestrationV2PlanningTaskSpec> {
  if (!HASH.test(sourceSnapshotHash) || !HASH.test(sourceCatalogHash)) fail('ORCHESTRATION_V2_PLANNING_INVALID');
  const budget = providerBudget(budgetInput);
  const base = { contract_version: 2, task_key: 'architecture:course', kind: 'course_skeleton' as const,
    source_snapshot_hash: sourceSnapshotHash, source_catalog_hash: sourceCatalogHash, budget };
  return Object.freeze({ task_key: base.task_key, kind: base.kind, chapter_key: null,
    contract_hash: orchestrationV2Hash(base), input_context_hash: sourceCatalogHash, budget });
}

export function buildOrchestrationV2InventoryTask(
  architectureAssemblyHash: string,
  executionBudgetMs: number,
): Readonly<OrchestrationV2PlanningTaskSpec> {
  if (!HASH.test(architectureAssemblyHash) || !integer(executionBudgetMs, 1, 600_000)) {
    fail('ORCHESTRATION_V2_PLANNING_INVALID');
  }
  const budget = Object.freeze({ input_tokens: 0, embedding_tokens: 0, max_output_tokens: 0,
    max_provider_attempts: 0, execution_budget_ms: executionBudgetMs });
  const base = { contract_version: 2, task_key: 'inventory:publish', kind: 'publish_inventory' as const,
    architecture_assembly_hash: architectureAssemblyHash, budget };
  return Object.freeze({ task_key: base.task_key, kind: base.kind, chapter_key: null,
    contract_hash: orchestrationV2Hash(base), input_context_hash: architectureAssemblyHash, budget });
}

export function planOrchestrationV2ChapterShards(
  skeleton: OrchestrationV2CourseSkeleton,
  scopes: readonly OrchestrationV2SourceScope[],
  budgets: OrchestrationV2PlanningBudgets,
  skeletonArtifactHash: string,
): Readonly<{ chapter_tasks: readonly OrchestrationV2PlanningTaskSpec[]; validation_task: OrchestrationV2PlanningTaskSpec }> {
  if (!skeleton || !HASH.test(skeleton.source_snapshot_hash) || !HASH.test(skeletonArtifactHash)
    || !Array.isArray(scopes) || !scopes.length || scopes.length > 4_096
    || !integer(budgets.architecture_validation_budget_ms, 1, 600_000)
    || !integer(budgets.inventory_publish_budget_ms, 1, 600_000)) fail('ORCHESTRATION_V2_PLANNING_INVALID');
  const chapterBudget = providerBudget(budgets.chapter);
  providerBudget(budgets.skeleton);
  const byScope = new Map(scopes.map(scope => [scope.scope_key, scope]));
  if (byScope.size !== scopes.length) fail('ORCHESTRATION_V2_PLANNING_INVALID');
  const owned = skeleton.chapters.flatMap(chapter => chapter.source_scope_ids);
  if (owned.length !== new Set(owned).size || owned.length !== scopes.length
    || owned.some(scope => !byScope.has(scope))) fail('ORCHESTRATION_V2_PLANNING_INVALID');
  const chapterTasks: OrchestrationV2PlanningTaskSpec[] = [];
  for (const chapter of [...skeleton.chapters].sort((a, b) => a.order - b.order)) {
    // Existing V2 workspaces keep their accepted 400k transport contract.
    // Density-scoped V3 workspaces use smaller architecture calls so lesson
    // design is bounded before the unit-content writer is dispatched.
    const shardSourceChars = chapter.source_scope_ids.every(scopeId => scopeId.startsWith('scope3_'))
      ? ORCHESTRATION_V3_MAX_SHARD_SOURCE_CHARS
      : ORCHESTRATION_V2_MAX_SHARD_SOURCE_CHARS;
    const groups: OrchestrationV2SourceScope[][] = [];
    let current: OrchestrationV2SourceScope[] = [], chars = 0;
    for (const scopeId of chapter.source_scope_ids) {
      const scope = byScope.get(scopeId);
      if (scope === undefined) throw new OrchestrationV2PlanningError('ORCHESTRATION_V2_PLANNING_INVALID');
      if (scope.content_chars > shardSourceChars) {
        fail('ORCHESTRATION_V2_SCOPE_EXCEEDS_SHARD');
      }
      if (current.length && chars + scope.content_chars > shardSourceChars) {
        groups.push(current); current = []; chars = 0;
      }
      current.push(scope); chars += scope.content_chars;
    }
    if (current.length) groups.push(current);
    for (const [index, group] of groups.entries()) {
      const shardPlan: OrchestrationV2ChapterShardPlan = {
        chapter_key: chapter.chapter_key, order: chapter.order, shard_index: index, shard_count: groups.length,
        source_scope_ids: group.map(scope => scope.scope_key),
        source_fact_count: group.reduce((sum, scope) => sum + scope.fact_count, 0),
        source_content_chars: group.reduce((sum, scope) => sum + scope.content_chars, 0),
      };
      const taskKey = `architecture:chapter:${chapter.chapter_key}:shard:${index + 1}`;
      if (!KEY.test(taskKey)) fail('ORCHESTRATION_V2_PLANNING_INVALID');
      const base = { contract_version: 2, task_key: taskKey, kind: 'chapter_blueprint' as const,
        source_snapshot_hash: skeleton.source_snapshot_hash, skeleton_artifact_hash: skeletonArtifactHash,
        shard_plan: shardPlan, budget: chapterBudget };
      chapterTasks.push(Object.freeze({ task_key: taskKey, kind: base.kind, chapter_key: chapter.chapter_key,
        contract_hash: orchestrationV2Hash(base), input_context_hash: skeletonArtifactHash,
        budget: chapterBudget, shard_plan: Object.freeze({ ...shardPlan, source_scope_ids: [...shardPlan.source_scope_ids] }) }));
    }
  }
  if (!chapterTasks.length || chapterTasks.length > 4_096) fail('ORCHESTRATION_V2_PLANNING_INVALID');
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
  return Object.freeze({ chapter_tasks: Object.freeze(chapterTasks), validation_task: validationTask });
}
