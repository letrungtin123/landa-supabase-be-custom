import assert from 'node:assert/strict';
import test from 'node:test';
import { assembleOrchestrationV2Architecture } from './lesson-author-orchestration-v2-architecture.logic.js';
import {
  orchestrationV2DeterministicUuid,
  prepareOrchestrationV2InventoryPublication,
  type OrchestrationV2StoredTask,
} from './lesson-author-orchestration-v2-inventory.logic.js';
import { orchestrationV2Hash } from './lesson-author-orchestration-v2.logic.js';

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const hash = (value: string) => orchestrationV2Hash(value);
const deterministic = (ms = 60_000) => ({ input_tokens: 0, embedding_tokens: 0, max_output_tokens: 0,
  max_provider_attempts: 0, execution_budget_ms: ms });
const provider = { input_tokens: 100_000, embedding_tokens: 0, max_output_tokens: 32_000,
  max_provider_attempts: 2, execution_budget_ms: 300_000 };

function assembly() {
  const source = hash('source');
  const skeleton = { contract_version: 2 as const, source_snapshot_hash: source, locale: 'vi' as const,
    title: 'Course', summary: 'Summary', target_audience: 'Leaders', prerequisites: [],
    learning_outcomes: ['Apply'], assessment_strategy: 'Practice', assumptions: [], chapters: [{
      chapter_key: 'chapter-1', order: 0, title: 'Chapter', objective: 'Learn', source_scope_ids: ['scope-1'],
    }] };
  const shard = { contract_version: 2 as const, source_snapshot_hash: source, chapter_key: 'chapter-1', order: 0,
    shard_index: 0, shard_count: 1, source_scope_ids: ['scope-1'], title: 'Chapter', objective: 'Learn', lessons: [{
      title: 'Lesson', objective: 'Learn', learning_objectives: ['Apply'], learning_activities: ['Read'],
      assessment: 'Check', units: [{ title: 'Unit', purpose: 'Teach', learning_objective_refs: ['lo_1'],
        source_scope_ids: ['scope-1'], component_plan: [{ type: 'html' as const, title: 'Explanation',
          rationale: 'Core teaching', source_scope_ids: ['scope-1'] }], media_brief: {
          type: 'video' as const, title: 'Leadership scenario', content_points: ['Context', 'Decision'],
          context_description: 'Executive meeting', rationale: 'Make the model concrete',
        } }] }] };
  return assembleOrchestrationV2Architecture(skeleton,
    [{ scope_key: 'scope-1', title: 'Scope', source_ref: null, fact_count: 2, content_chars: 20 }],
    [{ artifact_hash: hash('shard'), shard }]);
}

function existingTasks(): OrchestrationV2StoredTask[] {
  const values: Array<Pick<OrchestrationV2StoredTask, 'task_key' | 'kind' | 'chapter_key' | 'depends_on' | 'budget'>> = [
    { task_key: 'source:snapshot', kind: 'source_snapshot', chapter_key: null, depends_on: [], budget: deterministic() },
    { task_key: 'architecture:course', kind: 'course_skeleton', chapter_key: null,
      depends_on: ['source:snapshot'], budget: provider },
    { task_key: 'architecture:chapter:chapter-1:shard:1', kind: 'chapter_blueprint', chapter_key: 'chapter-1',
      depends_on: ['architecture:course'], budget: provider },
    { task_key: 'architecture:validate', kind: 'validate_architecture', chapter_key: null,
      depends_on: ['architecture:chapter:chapter-1:shard:1'], budget: deterministic() },
    { task_key: 'inventory:publish', kind: 'publish_inventory', chapter_key: null,
      depends_on: ['architecture:validate'], budget: deterministic() },
  ];
  return values.map((value, ordinal) => ({ ...value, id: uuid(100 + ordinal), ordinal, node_id: null,
    contract_hash: hash(`contract-${ordinal}`), input_context_hash: hash(`input-${ordinal}`),
    priority: ordinal * 10, max_attempts: 2 }));
}

test('publishes deterministic workspace nodes, media brief and exact remaining DAG', () => {
  const input = { run_id: uuid(1), assembly: assembly(), existing_tasks: existingTasks(), budgets: {
    unit: provider, chapter_validation_budget_ms: 60_000, finalization_budget_ms: 60_000,
  } };
  const first = prepareOrchestrationV2InventoryPublication(input);
  const second = prepareOrchestrationV2InventoryPublication(structuredClone(input));
  assert.deepEqual(first, second);
  assert.equal(first.node_count, 6);
  assert.equal(first.unit_count, 1);
  assert.equal(first.component_count, 1);
  assert.equal(first.media_brief_count, 1);
  assert.ok(first.nodes.some(node => node.canonical_path.endsWith('.media_1') && node.baseline));
  assert.deepEqual(first.new_tasks.map(task => task.kind), ['generate_unit', 'validate_chapter', 'finalize_course']);
  assert.deepEqual(first.manifest.tasks.at(-1)?.depends_on, ['content:chapter-1:validate']);
  assert.equal(first.manifest.tasks.length, 8);
  assert.match(first.receipt_hash, /^[0-9a-f]{64}$/);
});

test('deterministic UUIDs are stable, namespaced, and valid', () => {
  const first = orchestrationV2DeterministicUuid(uuid(1), 'node:course');
  assert.equal(first, orchestrationV2DeterministicUuid(uuid(1), 'node:course'));
  assert.notEqual(first, orchestrationV2DeterministicUuid(uuid(1), 'task:course'));
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('rejects a non-contiguous or pre-expanded planning graph', () => {
  const base = { run_id: uuid(1), assembly: assembly(), budgets: { unit: provider,
    chapter_validation_budget_ms: 60_000, finalization_budget_ms: 60_000 } };
  const gap = existingTasks(); gap[4]!.ordinal = 6;
  assert.throws(() => prepareOrchestrationV2InventoryPublication({ ...base, existing_tasks: gap }),
    { code: 'ORCHESTRATION_V2_INVENTORY_INVALID' });
  const expanded = existingTasks(); expanded.push({ ...expanded[4]!, id: uuid(200), ordinal: 5,
    task_key: 'course:finalize', kind: 'finalize_course' });
  assert.throws(() => prepareOrchestrationV2InventoryPublication({ ...base, existing_tasks: expanded }),
    { code: 'ORCHESTRATION_V2_INVENTORY_INVALID' });
});
