import assert from 'node:assert/strict';
import test from 'node:test';
import type { GenerationJobDatabase, GenerationJobSql } from './lesson-author-generation-job.repository.js';
import { orchestrationV2Hash } from './lesson-author-orchestration-v2.logic.js';
import { assembleOrchestrationV2Architecture } from './lesson-author-orchestration-v2-architecture.logic.js';
import type { OrchestrationV2PlanningBudgets } from './lesson-author-orchestration-v2-planning.logic.js';
import { createOrchestrationV2PlanningRepository } from './lesson-author-orchestration-v2-planning.repository.js';
import type {
  OrchestrationV2CourseSkeletonResponse,
} from './lesson-author-orchestration-v2-rag-contract.logic.js';
import type { OrchestrationV2TaskLease } from './lesson-author-orchestration-v2-worker.repository.js';
import { createOrchestrationV2WorkerRepository } from './lesson-author-orchestration-v2-worker.repository.js';

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const hash = (value: string) => orchestrationV2Hash(value);
const budgets: OrchestrationV2PlanningBudgets = {
  skeleton: { input_tokens: 100_000, embedding_tokens: 0, max_output_tokens: 32_000,
    max_provider_attempts: 2, execution_budget_ms: 300_000 },
  chapter: { input_tokens: 100_000, embedding_tokens: 0, max_output_tokens: 32_000,
    max_provider_attempts: 2, execution_budget_ms: 300_000 },
  architecture_validation_budget_ms: 60_000,
  inventory_publish_budget_ms: 60_000,
};

function lease(kind: OrchestrationV2TaskLease['kind']): OrchestrationV2TaskLease {
  const deterministic = kind === 'source_snapshot' || kind === 'validate_architecture';
  return {
    task_id: uuid(1), run_id: uuid(2), workspace_id: uuid(3), tenant_id: uuid(4), course_id: 'course-v1:test+1+2026',
    task_key: kind === 'source_snapshot' ? 'source:snapshot' : kind === 'course_skeleton'
      ? 'architecture:course' : kind === 'validate_architecture' ? 'architecture:validate'
        : 'architecture:chapter:chapter-1:shard:1',
    kind, chapter_key: kind === 'chapter_blueprint' ? 'chapter-1' : null, node_id: null,
    contract_hash: hash('contract'), input_context_hash: hash('input'), source_snapshot_id: uuid(5),
    source_snapshot_hash: hash('source'), runtime_config_hash: hash('runtime'),
    model: 'test-model', locale: 'vi', max_output_tokens: deterministic ? 0 : 32_000,
    provider_max_attempts: deterministic ? 0 : 2, execution_budget_ms: 300_000,
    lease_token: uuid(6), dispatch_epoch: 1, provider_replay_required: false, routing_shard: 7,
    ai_reservation_id: deterministic ? null : uuid(7),
  };
}

type QueryHandler = (sql: string, params: unknown[]) => Array<Record<string, unknown>>;

function database(handler: QueryHandler) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const tx: GenerationJobSql = {
    async query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
      queries.push({ sql, params });
      const rows = handler(sql, params);
      return { rows: rows as T[], rowCount: rows.length };
    },
  };
  const db: GenerationJobDatabase = { async transaction<T>(work: (value: GenerationJobSql) => Promise<T>) {
    return work(tx);
  } };
  return { db, tx, queries };
}

type Worker = ReturnType<typeof createOrchestrationV2WorkerRepository>;
type Succeed = Worker['succeed'];

function hookWorker(tx: GenerationJobSql, artifacts: Array<Record<string, unknown>>): Worker {
  const succeed: Succeed = async (...args) => {
    const artifact = args[4];
    const hooks = args[6];
    if (artifact) artifacts.push(artifact as unknown as Record<string, unknown>);
    await hooks?.beforeSuccess?.(tx, { id: args[0].task_id });
    await hooks?.afterSuccess?.(tx, { id: args[0].task_id });
  };
  return { succeed } as unknown as Worker;
}

test('authority query qualifies every live-lease column in joined SQL', async () => {
  const f = database((sql) => {
    if (sql.includes('SELECT w.kb_id')) {
      for (const column of ['id', 'run_id', 'workspace_id', 'tenant_id', 'status', 'lease_token',
        'lease_expires_at', 'deadline_at']) assert.match(sql, new RegExp(`t\\.${column}`));
      return [{ kb_id: uuid(8), conversation_id: uuid(9), correlation_id: uuid(10), content_locale: 'vi',
        source_document_ids: [uuid(11)], live_task: uuid(1) }];
    }
    if (sql.includes('FROM kb_documents')) return [{ document_id: uuid(11), kb_id: uuid(8), name: 'raw.pdf',
      type: 'application/pdf', status: 'learned' }];
    assert.fail(`unexpected SQL: ${sql}`);
  });
  const repo = createOrchestrationV2PlanningRepository(f.db, {} as Worker);
  const authority = await repo.loadAuthority(lease('source_snapshot'));
  assert.equal(authority.source_documents.length, 1);
  assert.equal(f.queries.length, 2);
});

test('source completion seals the snapshot and atomically admits the skeleton task through outbox', async () => {
  const f = database((sql) => {
    if (sql.includes('UPDATE lesson_author_workspace_source_snapshots')) {
      return [{ fact_count: 1, scope_count: 1, content_bytes: 5 }];
    }
    if (sql.includes('INSERT INTO lesson_author_workspace_v2_tasks')) return [{ id: uuid(20) }];
    if (sql.includes('INSERT INTO lesson_author_workspace_v2_dependencies')) return [{ task_id: uuid(20) }];
    if (sql.includes("SET status='queued'")) return [{ id: uuid(20) }];
    if (sql.includes('INSERT INTO lesson_author_workspace_v2_dispatch_outbox')) return [{ id: uuid(21) }];
    assert.fail(`unexpected SQL: ${sql}`);
  });
  const artifacts: Array<Record<string, unknown>> = [];
  let nextId = 20;
  const repo = createOrchestrationV2PlanningRepository(f.db, hookWorker(f.tx, artifacts), () => uuid(nextId++));
  const current = lease('source_snapshot');
  const response = { contract_version: 2 as const, source_snapshot_hash: current.source_snapshot_hash };
  const scopes = [{ scope_key: 'scope-1', title: 'Scope', source_ref: null, fact_count: 1, content_chars: 5 }];
  await repo.completeSource(current, { ...response, source_authority: {
    mode: 'model_designed', source: 'none', complete: true, confidence: 0,
    structure_hash: 'e'.repeat(64), reason_codes: [], chapters: [],
  } }, scopes, budgets.skeleton);
  assert.equal(artifacts[0]?.artifact_kind, 'source_catalog');
  assert.deepEqual((artifacts[0]?.payload as Record<string, unknown>)?.source_authority, {
    mode: 'model_designed', source: 'none', complete: true, confidence: 0,
    structure_hash: 'e'.repeat(64), reason_codes: [], chapters: [],
  });
  assert.equal(f.queries.filter(query => query.sql.includes('lesson_author_workspace_v2_tasks')).length, 2);
  assert.equal(f.queries.filter(query => query.sql.includes('lesson_author_workspace_v2_dispatch_outbox')).length, 1);
  assert.equal(f.queries.at(-1)?.params[6], 7);
});

test('source completion rejects malformed authority before committing an artifact', async () => {
  const f = database((sql) => assert.fail(`unexpected SQL: ${sql}`));
  const artifacts: Array<Record<string, unknown>> = [];
  const repo = createOrchestrationV2PlanningRepository(f.db, hookWorker(f.tx, artifacts));
  const current = lease('source_snapshot');
  await assert.rejects(repo.completeSource(current, {
    contract_version: 2, source_snapshot_hash: current.source_snapshot_hash,
    source_authority: undefined as never,
  }, [{ scope_key: 'scope-1', title: 'Scope', source_ref: null, fact_count: 1, content_chars: 5 }], budgets.skeleton),
  { code: 'ORCHESTRATION_V2_PLANNING_ARTIFACT_INVALID' });
  assert.equal(artifacts.length, 0);
  assert.equal(f.queries.length, 0);
});

test('skeleton completion fans out deterministic chapter shards and leaves validation blocked', async () => {
  const f = database((sql, params) => {
    if (sql.includes('coalesce(max(ordinal)')) return [{ value: 1 }];
    if (sql.includes('INSERT INTO lesson_author_workspace_v2_tasks')) {
      return (JSON.parse(String(params[0])) as Array<{ id: string }>).map(row => ({ id: row.id }));
    }
    if (sql.includes('INSERT INTO lesson_author_workspace_v2_dependencies')) {
      return (JSON.parse(String(params[0])) as Array<{ task_id: string }>).map(row => ({ task_id: row.task_id }));
    }
    if (sql.includes("SET status='queued'")) return (params[1] as string[]).map(id => ({ id }));
    if (sql.includes('INSERT INTO lesson_author_workspace_v2_dispatch_outbox')) {
      return (JSON.parse(String(params[0])) as Array<{ id: string }>).map(row => ({ id: row.id }));
    }
    if (sql.includes("'architecture_progressed'")) return [{ sequence: 3 }];
    assert.fail(`unexpected SQL: ${sql}`);
  });
  const artifacts: Array<Record<string, unknown>> = [];
  let nextId = 30;
  const repo = createOrchestrationV2PlanningRepository(f.db, hookWorker(f.tx, artifacts), () => uuid(nextId++));
  const current = lease('course_skeleton');
  const response: OrchestrationV2CourseSkeletonResponse = {
    contract_version: 2,
    skeleton: {
      contract_version: 2, source_snapshot_hash: current.source_snapshot_hash, locale: 'vi', title: 'Course',
      summary: 'Summary', target_audience: 'Leaders', prerequisites: [], learning_outcomes: ['Apply'],
      assessment_strategy: 'Practice', assumptions: [], chapters: [{ chapter_key: 'chapter-1', order: 0,
        title: 'Chapter', objective: 'Learn', source_scope_ids: ['scope-1', 'scope-2'] }],
    },
  };
  const scopes = [
    { scope_key: 'scope-1', title: 'One', source_ref: null, fact_count: 1, content_chars: 250_000 },
    { scope_key: 'scope-2', title: 'Two', source_ref: null, fact_count: 1, content_chars: 200_000 },
  ];
  await repo.completeSkeleton(current, response, scopes, budgets, async () => undefined);
  assert.equal(artifacts[0]?.artifact_kind, 'course_skeleton');
  const taskInserts = f.queries.filter(query => query.sql.includes('INSERT INTO lesson_author_workspace_v2_tasks'));
  assert.equal(taskInserts.length, 1, 'fan-out must use one set-based task insert');
  const insertedTasks = JSON.parse(String(taskInserts[0]?.params[0])) as Array<{ kind: string }>;
  assert.equal(insertedTasks.length, 3, 'two chapter shards plus one architecture validation task');
  assert.equal(insertedTasks.filter(task => task.kind === 'validate_architecture').length, 1);
  assert.equal(f.queries.filter(query => query.sql.includes("SET status='queued'")).length, 1);
  assert.equal(f.queries.filter(query => query.sql.includes('lesson_author_workspace_v2_dispatch_outbox')).length, 1);
  assert.equal(f.queries.length, 6, 'fan-out query count must remain constant as shard count grows');
});

test('last chapter completion promotes architecture validation through one durable outbox', async () => {
  const f = database((sql) => {
    if (sql.includes("'architecture_progressed'")) return [{ sequence: 4 }];
    if (sql.includes("task_key='architecture:validate'")) return [{ id: uuid(40) }];
    if (sql.includes('INSERT INTO lesson_author_workspace_v2_dispatch_outbox')) return [{ id: uuid(41) }];
    assert.fail(`unexpected SQL: ${sql}`);
  });
  const artifacts: Array<Record<string, unknown>> = [];
  const repo = createOrchestrationV2PlanningRepository(f.db, hookWorker(f.tx, artifacts), () => uuid(41));
  const current = lease('chapter_blueprint');
  await repo.completeChapter(current, { contract_version: 2, shard: {
    contract_version: 2, source_snapshot_hash: current.source_snapshot_hash, chapter_key: 'chapter-1', order: 0,
    shard_index: 0, shard_count: 1, source_scope_ids: ['scope-1'], title: 'Chapter', objective: 'Learn',
    lessons: [{ title: 'Lesson', objective: 'Learn', learning_objectives: ['Apply'],
      learning_activities: ['Read'], assessment: 'Check', units: [{ title: 'Unit', purpose: 'Teach',
        learning_objective_refs: ['lo_1'], source_scope_ids: ['scope-1'], component_plan: [{ type: 'html',
          title: 'Explanation', rationale: 'Core teaching', source_scope_ids: ['scope-1'] }], media_brief: null }] }],
  } }, async () => undefined);
  assert.equal(artifacts[0]?.artifact_kind, 'chapter_blueprint');
  assert.equal(f.queries.length, 3);
  assert.equal(f.queries[2]?.params[5], uuid(40));
});

test('architecture input loads exactly one skeleton and the complete strict shard set', async () => {
  const current = lease('validate_architecture');
  const skeleton = {
    contract_version: 2 as const, source_snapshot_hash: current.source_snapshot_hash, locale: 'vi' as const,
    title: 'Course', summary: 'Summary', target_audience: 'Leaders', prerequisites: [],
    learning_outcomes: ['Apply'], assessment_strategy: 'Practice', assumptions: [], chapters: [{
      chapter_key: 'chapter-1', order: 0, title: 'Chapter', objective: 'Learn', source_scope_ids: ['scope-1'],
    }],
  };
  const scope = { scope_key: 'scope-1', title: 'Scope', source_ref: null, fact_count: 1, content_chars: 5 };
  const plan = { chapter_key: 'chapter-1', order: 0, shard_index: 0, shard_count: 1,
    source_scope_ids: ['scope-1'], source_fact_count: 1, source_content_chars: 5 };
  const shard = { contract_version: 2 as const, source_snapshot_hash: current.source_snapshot_hash,
    chapter_key: 'chapter-1', order: 0, shard_index: 0, shard_count: 1, source_scope_ids: ['scope-1'],
    title: 'Chapter', objective: 'Learn', lessons: [{ title: 'Lesson', objective: 'Learn',
      learning_objectives: ['Apply'], learning_activities: ['Read'], assessment: 'Check', units: [{ title: 'Unit',
        purpose: 'Teach', learning_objective_refs: ['lo_1'], source_scope_ids: ['scope-1'], component_plan: [{
          type: 'html', title: 'Explanation', rationale: 'Core teaching', source_scope_ids: ['scope-1'],
        }], media_brief: null }] }], assessment_obligations: [{ planned_slot_key: `ao2_${'a'.repeat(32)}`,
          lesson_index: 1, unit_index: 1, component_index: 2, learning_objective_refs: ['lo_1'],
          required_assessment_kind: 'single_choice' as const, relevant_scope_ids: ['scope-1'],
          relevant_evidence_fact_ids: ['fact-1'], unresolved_reason: 'ASSESSMENT_SOURCE_CHECK_REQUIRED' as const,
          status: 'open' as const }] };
  const f = database((sql) => {
    if (sql.includes('INSERT INTO lesson_author_workspace_v2_assessment_obligations')) return [{ id: uuid(49) }];
    if (sql.includes("a.artifact_kind IN ('course_skeleton','chapter_blueprint')")) return [
      { artifact_kind: 'course_skeleton',
        artifact_hash: orchestrationV2Hash({ contract_version: 2, skeleton, scopes: [scope], shard_plans: [plan] }),
        payload: { contract_version: 2, skeleton, scopes: [scope], shard_plans: [plan] },
        task_key: 'architecture:course', kind: 'course_skeleton' },
      { artifact_kind: 'chapter_blueprint', artifact_hash: orchestrationV2Hash({ contract_version: 2, shard }),
        payload: { contract_version: 2, shard }, task_key: 'architecture:chapter:chapter-1:shard:1',
        kind: 'chapter_blueprint' },
    ];
    assert.fail(`unexpected SQL: ${sql}`);
  });
  const repo = createOrchestrationV2PlanningRepository(f.db, {} as Worker);
  const input = await repo.loadArchitectureInput(current);
  assert.equal(input.shard_artifacts.length, 1);
  assert.equal(input.shard_artifacts[0]?.shard.lessons[0]?.units[0]?.component_plan[0]?.type, 'html');
  assert.equal(f.queries.length, 1);
});

test('architecture completion stores evidence and queues one deterministic inventory task', async () => {
  const current = lease('validate_architecture');
  const skeleton = {
    contract_version: 2 as const, source_snapshot_hash: current.source_snapshot_hash, locale: 'vi' as const,
    title: 'Course', summary: 'Summary', target_audience: 'Leaders', prerequisites: [],
    learning_outcomes: ['Apply'], assessment_strategy: 'Practice', assumptions: [], chapters: [{
      chapter_key: 'chapter-1', order: 0, title: 'Chapter', objective: 'Learn', source_scope_ids: ['scope-1'],
    }],
  };
  const scopes = [{ scope_key: 'scope-1', title: 'Scope', source_ref: null, fact_count: 1, content_chars: 5 }];
  const shard = { contract_version: 2 as const, source_snapshot_hash: current.source_snapshot_hash,
    chapter_key: 'chapter-1', order: 0, shard_index: 0, shard_count: 1, source_scope_ids: ['scope-1'],
    title: 'Chapter', objective: 'Learn', lessons: [{ title: 'Lesson', objective: 'Learn',
      learning_objectives: ['Apply'], learning_activities: ['Read'], assessment: 'Check', units: [{ title: 'Unit',
        purpose: 'Teach', learning_objective_refs: ['lo_1'], source_scope_ids: ['scope-1'], component_plan: [{
          type: 'html' as const, title: 'Explanation', rationale: 'Core teaching', source_scope_ids: ['scope-1'],
        }], media_brief: null }] }], assessment_obligations: [{
      planned_slot_key: `ao2_${'a'.repeat(32)}`, lesson_index: 1, unit_index: 1, component_index: 2,
      learning_objective_refs: ['lo_1'], required_assessment_kind: 'single_choice' as const,
      relevant_scope_ids: ['scope-1'], relevant_evidence_fact_ids: ['fact-1'],
      unresolved_reason: 'ASSESSMENT_SOURCE_CHECK_REQUIRED' as const, status: 'open' as const,
    }] };
  const assembly = assembleOrchestrationV2Architecture(skeleton, scopes,
    [{ artifact_hash: hash('chapter-artifact'), shard }]);
  const f = database((sql) => {
    if (sql.includes('INSERT INTO lesson_author_workspace_v2_assessment_obligations')) {
      return [{ id: uuid(52) }];
    }
    if (sql.includes('coalesce(max(ordinal)')) return [{ value: 4 }];
    if (sql.includes('INSERT INTO lesson_author_workspace_v2_tasks')) return [{ id: uuid(50) }];
    if (sql.includes('INSERT INTO lesson_author_workspace_v2_dependencies')) return [{ task_id: uuid(50) }];
    if (sql.includes("SET status='queued'")) return [{ id: uuid(50) }];
    if (sql.includes('INSERT INTO lesson_author_workspace_v2_dispatch_outbox')) return [{ id: uuid(51) }];
    assert.fail(`unexpected SQL: ${sql}`);
  });
  const artifacts: Array<Record<string, unknown>> = [];
  let nextId = 50;
  const repo = createOrchestrationV2PlanningRepository(f.db, hookWorker(f.tx, artifacts), () => uuid(nextId++));
  await repo.completeArchitecture(current, assembly, budgets.inventory_publish_budget_ms);
  assert.equal(artifacts[0]?.artifact_kind, 'architecture_validation');
  const taskInsert = f.queries.find(query => query.sql.includes('INSERT INTO lesson_author_workspace_v2_tasks'));
  assert.equal(taskInsert?.params[6], 'inventory:publish');
  assert.equal(taskInsert?.params[7], 'publish_inventory');
  assert.equal(taskInsert?.params[9], assembly.assembly_hash);
  const obligationInsert = f.queries.find(query => query.sql.includes(
    'INSERT INTO lesson_author_workspace_v2_assessment_obligations'));
  assert.equal(obligationInsert?.params[5], assembly.assembly_hash);
  assert.equal(f.queries.length, 6);
});
