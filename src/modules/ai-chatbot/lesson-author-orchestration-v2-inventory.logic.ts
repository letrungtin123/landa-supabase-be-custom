import { createHash } from 'node:crypto';
import type { WorkspaceContent, WorkspaceJson, WorkspaceNodeKind } from './lesson-author-workspace.logic.js';
import {
  orchestrationV2Hash,
  sealOrchestrationV2PersistedManifest,
  type OrchestrationV2Budget,
  type OrchestrationV2PersistedManifest,
  type OrchestrationV2PersistedTask,
  type OrchestrationV2TaskKind,
} from './lesson-author-orchestration-v2.logic.js';
import type { OrchestrationV2ArchitectureAssembly } from './lesson-author-orchestration-v2-architecture.logic.js';

export interface OrchestrationV2StoredTask extends OrchestrationV2PersistedTask { id: string }

export interface OrchestrationV2InventoryBudgets {
  unit: OrchestrationV2Budget;
  chapter_validation_budget_ms: number;
  finalization_budget_ms: number;
}

export interface OrchestrationV2InventoryNode {
  id: string;
  canonical_path: string;
  parent_path: string | null;
  parent_id: string | null;
  kind: WorkspaceNodeKind;
  sort_order: number;
  protected_contract: Record<string, unknown>;
  contract_hash: string;
  baseline: WorkspaceContent | null;
}

export interface OrchestrationV2PreparedTask extends OrchestrationV2StoredTask {}

export interface OrchestrationV2InventoryIdentity {
  nodes: readonly OrchestrationV2InventoryNode[];
  unit_bindings: readonly {
    chapter_key: string;
    chapter_node_id: string;
    unit_node_id: string;
    unit_path: string;
    unit_contract_hash: string;
    source_scope_ids: string[];
    unit: unknown;
  }[];
  inventory_hash: string;
  unit_count: number;
  component_count: number;
  media_brief_count: number;
}

export interface OrchestrationV2InventoryPublication {
  contract: 'lesson-author-inventory-publication-v2';
  assembly_hash: string;
  admitted_fact_count: number;
  inventory_hash: string;
  node_count: number;
  unit_count: number;
  component_count: number;
  media_brief_count: number;
  nodes: readonly OrchestrationV2InventoryNode[];
  new_tasks: readonly OrchestrationV2PreparedTask[];
  manifest: Readonly<OrchestrationV2PersistedManifest>;
  receipt_hash: string;
}

export class OrchestrationV2InventoryError extends Error {
  constructor(readonly code: 'ORCHESTRATION_V2_INVENTORY_INVALID' | 'ORCHESTRATION_V2_INVENTORY_TOO_LARGE') {
    super(code);
    this.name = 'OrchestrationV2InventoryError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const KEY = /^[a-z0-9][a-z0-9_.:-]{0,159}$/;
const MAX_NODES = 32_768;
const MAX_INVENTORY_BYTES = 64 * 1024 * 1024;
const fail = (code: OrchestrationV2InventoryError['code'] = 'ORCHESTRATION_V2_INVENTORY_INVALID'): never => {
  throw new OrchestrationV2InventoryError(code);
};
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

export function orchestrationV2DeterministicUuid(namespace: string, value: string): string {
  if (!UUID.test(namespace) || !value || value.length > 512) fail();
  const digest = createHash('sha256').update(namespace.toLowerCase()).update('\0').update(value).digest();
  digest[6] = (digest[6]! & 0x0f) | 0x80;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Stable provider-visible component identity shared by inventory and unit generation. */
export function orchestrationV2ComponentPlanId(assemblyHash: string, canonicalPath: string): string {
  if (!HASH.test(assemblyHash) || !canonicalPath || canonicalPath.length > 240) fail();
  // The existing staged provider boundary validates this exact instance-id
  // namespace. Keeping it here prevents inventory/generation drift.
  return `cp2_${orchestrationV2Hash({ assembly: assemblyHash, path: canonicalPath }).slice(0, 32)}`;
}

const content = (title: string, purpose: string | null, data: WorkspaceJson): WorkspaceContent => ({
  title, purpose, data, implementation_notes: null,
});

function deterministicBudget(executionBudgetMs: number): OrchestrationV2Budget {
  return { input_tokens: 0, embedding_tokens: 0, max_output_tokens: 0,
    max_provider_attempts: 0, execution_budget_ms: executionBudgetMs };
}

/** Rebuild the immutable node graph from the accepted architecture. Apply uses
 * this same constructor so publication and materialization cannot drift. */
export function prepareOrchestrationV2InventoryIdentity(input: {
  run_id: string;
  assembly: Readonly<OrchestrationV2ArchitectureAssembly>;
}): Readonly<OrchestrationV2InventoryIdentity> {
  const { run_id: runId, assembly } = input;
  if (!UUID.test(runId) || !assembly || assembly.contract_version !== 2 || !HASH.test(assembly.assembly_hash)) fail();

  const nodes: OrchestrationV2InventoryNode[] = [];
  const paths = new Map<string, string>();
  const siblingOrders = new Set<string>();
  let inventoryBytes = 0, unitCount = 0, componentCount = 0, mediaBriefCount = 0;
  const add = (candidate: Omit<OrchestrationV2InventoryNode, 'id' | 'parent_id' | 'contract_hash'>) => {
    const id = orchestrationV2DeterministicUuid(runId, `node:${candidate.canonical_path}`);
    const parentId = candidate.parent_path === null ? null : paths.get(candidate.parent_path) ?? fail();
    const sibling = `${candidate.parent_path ?? ''}:${candidate.sort_order}`;
    if (paths.has(candidate.canonical_path) || siblingOrders.has(sibling) || candidate.canonical_path.length > 240
      || bytes(candidate.protected_contract) > 1024 * 1024 || (candidate.baseline && bytes(candidate.baseline) > 1024 * 1024)) {
      fail('ORCHESTRATION_V2_INVENTORY_INVALID');
    }
    const contractHash = orchestrationV2Hash(candidate.protected_contract);
    const node = { ...candidate, id, parent_id: parentId, contract_hash: contractHash };
    inventoryBytes += bytes(node);
    if (nodes.length >= MAX_NODES || inventoryBytes > MAX_INVENTORY_BYTES) fail('ORCHESTRATION_V2_INVENTORY_TOO_LARGE');
    paths.set(candidate.canonical_path, id); siblingOrders.add(sibling); nodes.push(node);
  };
  const refs = (scopeIds: readonly string[], objectiveRefs: readonly string[] = []) => ({ source_refs: [],
    primary_evidence_scope_ids: [...scopeIds], supporting_evidence_scope_ids: [],
    learning_objective_refs: [...objectiveRefs] });
  const storyboard = (kind: Exclude<WorkspaceNodeKind, 'component'>, path: string, parentPath: string | null,
    sortOrder: number, baseline: WorkspaceContent, scopeIds: readonly string[], objectiveRefs: readonly string[] = [],
    extra: { chapter_count?: number; objective_slots?: number; media_type?: 'video' | 'static_infographic' | null;
      brief_format?: 'structured_v2' | null } = {}) => {
    const protectedContract = { storyboard_version: 1, kind, canonical_path: path, display_title: baseline.title,
      baseline_hash: orchestrationV2Hash(baseline), chapter_count: extra.chapter_count ?? 0,
      objective_slots: extra.objective_slots ?? 0, media_type: extra.media_type ?? null,
      brief_format: extra.brief_format ?? null, readonly_references: refs(scopeIds, objectiveRefs) };
    add({ canonical_path: path, parent_path: parentPath, kind, sort_order: sortOrder,
      protected_contract: protectedContract, baseline: kind === 'unit' ? null : baseline });
  };

  const allScopes = assembly.architecture.chapters.flatMap(chapter => chapter.source_scope_ids);
  storyboard('course', 'course', null, 0, content(assembly.architecture.title, null, {
    summary: assembly.architecture.summary, target_audience: assembly.architecture.target_audience,
    prerequisites: assembly.architecture.prerequisites, assessment_strategy: assembly.architecture.assessment_strategy,
  }), allScopes, [], { chapter_count: assembly.chapter_count });

  const unitBindings: Array<{ chapter_key: string; chapter_node_id: string; unit_node_id: string;
    unit_path: string; unit_contract_hash: string; source_scope_ids: string[]; unit: unknown }> = [];
  for (const [chapterIndex, chapter] of assembly.architecture.chapters.entries()) {
    const chapterPath = `chapter_${chapterIndex + 1}`;
    storyboard('chapter', chapterPath, 'course', chapterIndex, content(chapter.title, null, {
      objective: chapter.objective, learning_outcomes: chapter.learning_outcomes ?? [],
    }), chapter.source_scope_ids);
    const chapterNodeId = paths.get(chapterPath)!;
    let chapterUnitIndex = 0;
    for (const [lessonIndex, lesson] of chapter.lessons.entries()) {
      const lessonPath = `${chapterPath}.lesson_${lessonIndex + 1}`;
      const lessonScopes = lesson.units.flatMap(unit => unit.source_scope_ids);
      storyboard('lesson', lessonPath, chapterPath, lessonIndex, content(lesson.title, null, {
        objective: lesson.objective, learning_objectives: lesson.learning_objectives,
        learning_activities: lesson.learning_activities, assessment: lesson.assessment,
      }), lessonScopes, lesson.learning_objectives.map((_value, index) => `lo_${index + 1}`),
      { objective_slots: lesson.learning_objectives.length });
      for (const [unitIndex, unit] of lesson.units.entries()) {
        const unitPath = `${lessonPath}.unit_${unitIndex + 1}`;
        const unitBaseline = content(unit.title, unit.purpose, {});
        storyboard('unit', unitPath, lessonPath, unitIndex, unitBaseline, unit.source_scope_ids,
          unit.learning_objective_refs);
        const unitNodeId = paths.get(unitPath)!;
        const unitNode = nodes.find(node => node.id === unitNodeId)!;
        unitBindings.push({ chapter_key: chapter.chapter_key, chapter_node_id: chapterNodeId,
          unit_node_id: unitNodeId, unit_path: unitPath, unit_contract_hash: unitNode.contract_hash,
          source_scope_ids: [...unit.source_scope_ids], unit });
        unitCount++; chapterUnitIndex++;
        for (const [componentIndex, plan] of unit.component_plan.entries()) {
          const path = `${unitPath}.component_${componentIndex + 1}`;
          const planId = orchestrationV2ComponentPlanId(assembly.assembly_hash, path);
          const protectedContract = { binding_version: 1, component_type: plan.type, display_title: plan.title,
            metadata: { component_plan_id: planId, source_fact_ids: [], covered_source_fact_ids: [],
              supporting_evidence_fact_ids: [], source_scope_ids: [...plan.source_scope_ids],
              learning_objective_refs: [...unit.learning_objective_refs], generated_by: 'lesson_author_ai',
              rationale: plan.rationale, author_review: plan.author_review ?? {
                purpose: null, example_scenario: null, visual_asset: null, user_behavior_navigation: null,
              },
              ...(plan.type === 'problem' ? { weight: 1 } : {}) } };
          add({ canonical_path: path, parent_path: unitPath, kind: 'component', sort_order: componentIndex,
            protected_contract: protectedContract, baseline: null });
          componentCount++;
        }
        if (unit.media_brief) {
          const mediaPath = `${unitPath}.media_1`;
          storyboard('media_brief', mediaPath, unitPath, unit.component_plan.length,
            content(unit.media_brief.title, unit.media_brief.rationale, {
              content_points: unit.media_brief.content_points,
              context_description: unit.media_brief.context_description,
            }), unit.source_scope_ids, unit.learning_objective_refs,
          { media_type: unit.media_brief.type, brief_format: 'structured_v2' });
          mediaBriefCount++;
        }
      }
    }
    if (chapterUnitIndex < 1 || chapterUnitIndex > 4_096) fail('ORCHESTRATION_V2_INVENTORY_TOO_LARGE');
  }
  if (unitCount !== assembly.unit_count || componentCount !== assembly.component_plan_count || !unitCount) fail();

  const inventoryIdentity = nodes.map(node => ({ id: node.id, path: node.canonical_path, parent_id: node.parent_id,
    kind: node.kind, order: node.sort_order, contract_hash: node.contract_hash,
    baseline_hash: node.baseline ? orchestrationV2Hash(node.baseline) : null }));
  const inventoryHash = orchestrationV2Hash(inventoryIdentity);
  return Object.freeze({ nodes: Object.freeze(nodes), unit_bindings: Object.freeze(unitBindings),
    inventory_hash: inventoryHash, unit_count: unitCount, component_count: componentCount,
    media_brief_count: mediaBriefCount });
}

/** Build the complete UI inventory and remaining shard-aware DAG without I/O. */
export function prepareOrchestrationV2InventoryPublication(input: {
  run_id: string;
  assembly: Readonly<OrchestrationV2ArchitectureAssembly>;
  existing_tasks: readonly OrchestrationV2StoredTask[];
  budgets: OrchestrationV2InventoryBudgets;
}): Readonly<OrchestrationV2InventoryPublication> {
  const { run_id: runId, assembly, budgets } = input;
  if (!UUID.test(runId) || !assembly || assembly.contract_version !== 2 || !HASH.test(assembly.assembly_hash)
    || !Array.isArray(input.existing_tasks) || !input.existing_tasks.length
    || !budgets || !Number.isSafeInteger(budgets.chapter_validation_budget_ms)
    || !Number.isSafeInteger(budgets.finalization_budget_ms)) fail();
  const existing = [...input.existing_tasks].sort((a, b) => a.ordinal - b.ordinal);
  if (existing.some((task, index) => !UUID.test(task.id) || task.ordinal !== index)
    || existing.at(-1)?.kind !== 'publish_inventory'
    || existing.some(task => !['source_snapshot', 'course_skeleton', 'chapter_blueprint',
      'validate_architecture', 'publish_inventory'].includes(task.kind))) fail();
  const identity = prepareOrchestrationV2InventoryIdentity({ run_id: runId, assembly });
  const nodes = [...identity.nodes];
  const unitBindings = [...identity.unit_bindings];
  const inventoryHash = identity.inventory_hash;
  const unitCount = identity.unit_count;
  const componentCount = identity.component_count;
  const mediaBriefCount = identity.media_brief_count;
  let ordinal = existing.length;
  const newTasks: OrchestrationV2PreparedTask[] = [];
  const append = (value: Omit<OrchestrationV2PersistedTask, 'ordinal'>) => {
    if (!KEY.test(value.task_key)) fail();
    newTasks.push({ ...value, id: orchestrationV2DeterministicUuid(runId, `task:${value.task_key}`), ordinal: ordinal++ });
  };
  const publishKey = existing.at(-1)!.task_key;
  const chapterUnitKeys = new Map<string, string[]>();
  for (const binding of unitBindings) {
    const index = (chapterUnitKeys.get(binding.chapter_key)?.length ?? 0) + 1;
    const taskKey = `content:${binding.chapter_key}:unit:${index}`;
    const inputContextHash = orchestrationV2Hash({ assembly_hash: assembly.assembly_hash,
      inventory_hash: inventoryHash, node_id: binding.unit_node_id, contract_hash: binding.unit_contract_hash,
      source_scope_ids: binding.source_scope_ids });
    const contractHash = orchestrationV2Hash({ contract_version: 2, task_key: taskKey, kind: 'generate_unit',
      chapter_key: binding.chapter_key, node_id: binding.unit_node_id, input_context_hash: inputContextHash,
      budget: budgets.unit });
    append({ task_key: taskKey, kind: 'generate_unit', chapter_key: binding.chapter_key,
      node_id: binding.unit_node_id, contract_hash: contractHash, input_context_hash: inputContextHash,
      priority: 50, max_attempts: 2, depends_on: [publishKey], budget: { ...budgets.unit } });
    chapterUnitKeys.set(binding.chapter_key, [...(chapterUnitKeys.get(binding.chapter_key) ?? []), taskKey]);
  }
  const chapterValidationKeys: string[] = [];
  for (const chapter of assembly.architecture.chapters) {
    const unitKeys = chapterUnitKeys.get(chapter.chapter_key) ?? fail();
    const taskKey = `content:${chapter.chapter_key}:validate`;
    const chapterNode = unitBindings.find(binding => binding.chapter_key === chapter.chapter_key)?.chapter_node_id ?? fail();
    const budget = deterministicBudget(budgets.chapter_validation_budget_ms);
    const inputContextHash = orchestrationV2Hash({ assembly_hash: assembly.assembly_hash,
      inventory_hash: inventoryHash, chapter_key: chapter.chapter_key, unit_task_keys: unitKeys });
    const contractHash = orchestrationV2Hash({ contract_version: 2, task_key: taskKey,
      kind: 'validate_chapter', chapter_key: chapter.chapter_key, node_id: chapterNode,
      input_context_hash: inputContextHash, budget });
    append({ task_key: taskKey, kind: 'validate_chapter', chapter_key: chapter.chapter_key, node_id: chapterNode,
      contract_hash: contractHash, input_context_hash: inputContextHash, priority: 60, max_attempts: 2,
      depends_on: [...unitKeys], budget });
    chapterValidationKeys.push(taskKey);
  }
  const finalBudget = deterministicBudget(budgets.finalization_budget_ms);
  const finalInputHash = orchestrationV2Hash({ assembly_hash: assembly.assembly_hash,
    inventory_hash: inventoryHash, chapter_validation_keys: chapterValidationKeys });
  append({ task_key: 'course:finalize', kind: 'finalize_course', chapter_key: null, node_id: null,
    contract_hash: orchestrationV2Hash({ contract_version: 2, task_key: 'course:finalize',
      kind: 'finalize_course', input_context_hash: finalInputHash, budget: finalBudget }),
    input_context_hash: finalInputHash, priority: 70, max_attempts: 2,
    depends_on: chapterValidationKeys, budget: finalBudget });
  const manifest = sealOrchestrationV2PersistedManifest({ source_snapshot_hash: assembly.source_snapshot_hash,
    tasks: [...existing, ...newTasks] });
  const receiptBase = { contract: 'lesson-author-inventory-publication-v2' as const,
    assembly_hash: assembly.assembly_hash, admitted_fact_count: assembly.admitted_fact_count,
    inventory_hash: inventoryHash, manifest_hash: manifest.manifest_hash,
    node_count: nodes.length, unit_count: unitCount, component_count: componentCount,
    media_brief_count: mediaBriefCount, task_count: manifest.tasks.length };
  return Object.freeze({ ...receiptBase, nodes: Object.freeze(nodes), new_tasks: Object.freeze(newTasks), manifest,
    receipt_hash: orchestrationV2Hash(receiptBase) });
}
