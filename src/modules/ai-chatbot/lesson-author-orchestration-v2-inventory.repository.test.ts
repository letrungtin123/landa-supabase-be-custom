import assert from 'node:assert/strict';
import test from 'node:test';
import type { GenerationJobDatabase, GenerationJobSql } from './lesson-author-generation-job.repository.js';
import { assembleOrchestrationV2Architecture } from './lesson-author-orchestration-v2-architecture.logic.js';
import {
  prepareOrchestrationV2InventoryPublication,
  type OrchestrationV2InventoryBudgets,
  type OrchestrationV2StoredTask,
} from './lesson-author-orchestration-v2-inventory.logic.js';
import { createOrchestrationV2InventoryRepository } from './lesson-author-orchestration-v2-inventory.repository.js';
import { executeOrchestrationV2InventoryTask } from './lesson-author-orchestration-v2-inventory.service.js';
import { orchestrationV2Hash } from './lesson-author-orchestration-v2.logic.js';
import type { OrchestrationV2TaskLease } from './lesson-author-orchestration-v2-worker.repository.js';
import { createOrchestrationV2WorkerRepository } from './lesson-author-orchestration-v2-worker.repository.js';

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const hash = (value: string) => orchestrationV2Hash(value);
const deterministic = { input_tokens: 0, embedding_tokens: 0, max_output_tokens: 0,
  max_provider_attempts: 0, execution_budget_ms: 60_000 };
const provider = { input_tokens: 100_000, embedding_tokens: 0, max_output_tokens: 32_000,
  max_provider_attempts: 2, execution_budget_ms: 300_000 };
const budgets: OrchestrationV2InventoryBudgets = {
  unit: provider, chapter_validation_budget_ms: 60_000, finalization_budget_ms: 60_000,
};

function fixtureAssembly() {
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
          rationale: 'Core teaching', source_scope_ids: ['scope-1'] }], media_brief: { type: 'video' as const,
          title: 'Scenario', content_points: ['Context', 'Decision'], context_description: 'Board meeting',
          rationale: 'Make the model concrete' } }] }] };
  return assembleOrchestrationV2Architecture(skeleton,
    [{ scope_key: 'scope-1', title: 'Scope', source_ref: null, fact_count: 2, content_chars: 20 }],
    [{ artifact_hash: hash('shard'), shard }]);
}

function existingTasks(assemblyHash: string): OrchestrationV2StoredTask[] {
  const values = [
    { task_key: 'source:snapshot', kind: 'source_snapshot' as const, chapter_key: null, depends_on: [], budget: deterministic },
    { task_key: 'architecture:course', kind: 'course_skeleton' as const, chapter_key: null,
      depends_on: ['source:snapshot'], budget: provider },
    { task_key: 'architecture:chapter:chapter-1:shard:1', kind: 'chapter_blueprint' as const,
      chapter_key: 'chapter-1', depends_on: ['architecture:course'], budget: provider },
    { task_key: 'architecture:validate', kind: 'validate_architecture' as const, chapter_key: null,
      depends_on: ['architecture:chapter:chapter-1:shard:1'], budget: deterministic },
    { task_key: 'inventory:publish', kind: 'publish_inventory' as const, chapter_key: null,
      depends_on: ['architecture:validate'], budget: deterministic },
  ];
  return values.map((value, ordinal) => ({ ...value, id: uuid(100 + ordinal), ordinal, node_id: null,
    contract_hash: hash(`contract-${ordinal}`),
    input_context_hash: ordinal === 4 ? assemblyHash : hash(`input-${ordinal}`),
    priority: ordinal * 10, max_attempts: 2 }));
}

function lease(assemblyHash: string, sourceHash: string): OrchestrationV2TaskLease {
  return { task_id: uuid(104), run_id: uuid(2), workspace_id: uuid(3), tenant_id: uuid(4),
    course_id: 'course-v1:test+1+2026', task_key: 'inventory:publish', kind: 'publish_inventory',
    chapter_key: null, node_id: null, contract_hash: hash('contract-4'), input_context_hash: assemblyHash,
    source_snapshot_id: uuid(5), source_snapshot_hash: sourceHash, runtime_config_hash: hash('runtime'), model: 'test-model', locale: 'vi',
    max_output_tokens: 0, provider_max_attempts: 0, execution_budget_ms: 60_000,
    lease_token: uuid(6), dispatch_epoch: 1, provider_replay_required: false,
    routing_shard: 7, ai_reservation_id: null };
}

type Handler = (sql: string, params: unknown[]) => Array<Record<string, unknown>>;
function database(handler: Handler) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const tx: GenerationJobSql = { async query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
    queries.push({ sql, params }); const rows = handler(sql, params); return { rows: rows as T[], rowCount: rows.length };
  } };
  const db: GenerationJobDatabase = { async transaction<T>(work: (value: GenerationJobSql) => Promise<T>) {
    return work(tx);
  } };
  return { db, tx, queries };
}

type Worker = ReturnType<typeof createOrchestrationV2WorkerRepository>;
function hookWorker(tx: GenerationJobSql, artifacts: Array<Record<string, unknown>>): Worker {
  return { succeed: async (...args: Parameters<Worker['succeed']>) => {
    if (args[4]) artifacts.push(args[4] as unknown as Record<string, unknown>);
    await args[6]?.beforeSuccess?.(tx, { id: args[0].task_id });
    await args[6]?.afterSuccess?.(tx, { id: args[0].task_id });
  } } as unknown as Worker;
}

test('loads exactly one validated architecture and the complete persisted planning graph', async () => {
  const assembly = fixtureAssembly();
  const tasks = existingTasks(assembly.assembly_hash);
  const current = lease(assembly.assembly_hash, assembly.source_snapshot_hash);
  const dependencies = tasks.flatMap(task => task.depends_on.map(parent => ({ task_key: task.task_key,
    depends_on: parent, ordinal: tasks.find(candidate => candidate.task_key === parent)!.ordinal })));
  const f = database((sql) => {
    if (sql.includes("a.artifact_kind='architecture_validation'")) {
      return [{ payload: assembly, artifact_hash: assembly.assembly_hash }];
    }
    if (sql.includes('SELECT t.id::text,t.ordinal')) return tasks.map(task => ({ ...task, ...task.budget,
      provider_max_attempts: task.budget.max_provider_attempts,
      status: task.id === current.task_id ? 'running' : 'succeeded' }));
    if (sql.includes('SELECT child.task_key')) return dependencies;
    assert.fail(`unexpected SQL: ${sql}`);
  });
  const repo = createOrchestrationV2InventoryRepository(f.db, {} as Worker);
  const loaded = await repo.load(current);
  assert.equal(loaded.assembly.assembly_hash, assembly.assembly_hash);
  assert.deepEqual(loaded.existing_tasks.map(task => task.task_key), tasks.map(task => task.task_key));
  assert.equal(f.queries.length, 3);
  for (const column of ['id', 'run_id', 'workspace_id', 'tenant_id', 'status', 'lease_token']) {
    assert.match(f.queries[0]!.sql, new RegExp(`current_task\\.${column}`));
  }
});

test('materializes nodes, seals the exact manifest and queues only independent unit work atomically', async () => {
  const assembly = fixtureAssembly();
  const tasks = existingTasks(assembly.assembly_hash);
  const current = lease(assembly.assembly_hash, assembly.source_snapshot_hash);
  const publication = prepareOrchestrationV2InventoryPublication({ run_id: current.run_id,
    assembly, existing_tasks: tasks, budgets });
  const storedTasks = publication.manifest.tasks.map(task => ({ id: tasks.find(value => value.task_key === task.task_key)?.id
    ?? publication.new_tasks.find(value => value.task_key === task.task_key)!.id, task_key: task.task_key }));
  const unitTasks = publication.new_tasks.filter(task => task.kind === 'generate_unit');
  const f = database((sql, params) => {
    if (sql.includes('SELECT w.status,w.blueprint_id')) return [{ status: 'designing', blueprint_id: null,
      run_status: 'planning', manifest_hash: null, snapshot_status: 'sealed', fact_count: 2,
      source_snapshot_hash: current.source_snapshot_hash, node_count: 0, structure_event_count: 0 }];
    if (sql.includes('INSERT INTO lesson_author_workspace_nodes')) {
      return (JSON.parse(String(params[0])) as Array<{ id: string }>).map(row => ({ id: row.id }));
    }
    if (sql.includes('INSERT INTO lesson_author_workspace_revisions')) {
      return (JSON.parse(String(params[0])) as Array<{ node_id: string }>).map(row => ({ node_id: row.node_id, revision: 0 }));
    }
    if (sql.includes("UPDATE lesson_author_workspaces SET status='drafting'")) return [{ id: current.workspace_id }];
    if (sql.includes('INSERT INTO lesson_author_workspace_events')) return [{ sequence: 1 }];
    if (sql.includes('INSERT INTO lesson_author_workspace_v2_tasks')) {
      return (JSON.parse(String(params[0])) as Array<{ id: string }>).map(row => ({ id: row.id }));
    }
    if (sql.includes('SELECT id::text,task_key FROM lesson_author_workspace_v2_tasks')) return storedTasks;
    if (sql.includes('INSERT INTO lesson_author_workspace_v2_dependencies')) {
      return (JSON.parse(String(params[0])) as Array<{ task_id: string }>).map(row => ({ task_id: row.task_id }));
    }
    if (sql.includes("UPDATE lesson_author_workspace_v2_tasks SET status='queued'")) {
      return unitTasks.map(task => ({ id: task.id }));
    }
    if (sql.includes('INSERT INTO lesson_author_workspace_v2_dispatch_outbox')) {
      return (JSON.parse(String(params[0])) as Array<{ id: string }>).map(row => ({ id: row.id }));
    }
    if (sql.includes("UPDATE lesson_author_workspace_v2_runs SET status='executing'")) return [{ id: current.run_id }];
    if (sql.includes('(SELECT count(*)::integer FROM lesson_author_workspace_nodes')) return [{
      node_count: publication.node_count, task_count: publication.manifest.tasks.length,
      unit_outbox_count: unitTasks.length }];
    assert.fail(`unexpected SQL: ${sql}`);
  });
  const artifacts: Array<Record<string, unknown>> = [];
  let outboxId = 900;
  const repo = createOrchestrationV2InventoryRepository(f.db, hookWorker(f.tx, artifacts), () => uuid(outboxId++));
  await repo.complete(current, publication);
  assert.equal(artifacts[0]?.artifact_kind, 'inventory_receipt');
  const taskInsert = f.queries.find(query => query.sql.includes('INSERT INTO lesson_author_workspace_v2_tasks'));
  const insertedTasks = JSON.parse(String(taskInsert?.params[0])) as Array<{
    kind: string; provider_max_attempts: number; max_provider_attempts: number;
  }>;
  assert.ok(insertedTasks.length > 0);
  assert.ok(insertedTasks.every(task => task.provider_max_attempts === task.max_provider_attempts));
  const runUpdate = f.queries.find(query => query.sql.includes("SET status='executing'"));
  assert.equal(runUpdate?.params[4], publication.manifest.manifest_hash);
  assert.equal(runUpdate?.params[5], publication.manifest.tasks.length);
  assert.equal(f.queries.filter(query => query.sql.includes('INSERT INTO lesson_author_workspace_v2_dispatch_outbox')).length, 1);
  assert.deepEqual(JSON.parse(String(f.queries.find(query => query.sql.includes('INSERT INTO lesson_author_workspace_v2_dispatch_outbox'))?.params[0]))
    .map((row: { task_id: string }) => row.task_id), unitTasks.map(task => task.id));
});

test('inventory service performs load, pure projection and one fenced completion without provider work', async () => {
  const assembly = fixtureAssembly();
  const current = lease(assembly.assembly_hash, assembly.source_snapshot_hash);
  const events: string[] = [];
  const repo = { load: async () => { events.push('load'); return { assembly,
    existing_tasks: existingTasks(assembly.assembly_hash) }; },
  complete: async (_lease: OrchestrationV2TaskLease, publication: { manifest: { tasks: readonly unknown[] } }) => {
    events.push(`complete:${publication.manifest.tasks.length}`);
  } };
  assert.equal(await executeOrchestrationV2InventoryTask(current, repo as never, budgets), 'publish_inventory');
  assert.deepEqual(events, ['load', 'complete:8']);
});
