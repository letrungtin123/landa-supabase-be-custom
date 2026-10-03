import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildOrchestrationV2InventoryTask,
  buildOrchestrationV2SkeletonTask,
  planOrchestrationV2ChapterShards,
  type OrchestrationV2PlanningBudgets,
} from './lesson-author-orchestration-v2-planning.logic.js';
import { executeOrchestrationV2PlanningTask } from './lesson-author-orchestration-v2-planning.service.js';
import type { OrchestrationV2CourseSkeleton, OrchestrationV2SourceScope } from './lesson-author-orchestration-v2-rag-contract.logic.js';
import type { OrchestrationV2TaskLease } from './lesson-author-orchestration-v2-worker.repository.js';

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const hash = (char: string) => char.repeat(64);
const providerBudget = { input_tokens: 100_000, embedding_tokens: 0, max_output_tokens: 32_000,
  max_provider_attempts: 2, execution_budget_ms: 300_000 };
const budgets: OrchestrationV2PlanningBudgets = {
  skeleton: providerBudget, chapter: providerBudget, architecture_validation_budget_ms: 60_000,
  inventory_publish_budget_ms: 60_000,
};
const scopes: OrchestrationV2SourceScope[] = [
  { scope_key: 'scope-1', title: 'One', source_ref: null, fact_count: 2, content_chars: 250_000 },
  { scope_key: 'scope-2', title: 'Two', source_ref: null, fact_count: 1, content_chars: 200_000 },
];
const skeleton: OrchestrationV2CourseSkeleton = {
  contract_version: 2, source_snapshot_hash: hash('a'), locale: 'vi', title: 'Course', summary: 'Summary',
  target_audience: 'Leaders', prerequisites: [], learning_outcomes: ['Apply'], assessment_strategy: 'Practice',
  assumptions: [], chapters: [{ chapter_key: 'chapter-1', order: 0, title: 'Chapter', objective: 'Learn',
    source_scope_ids: ['scope-1', 'scope-2'] }],
};

function lease(kind: OrchestrationV2TaskLease['kind']): OrchestrationV2TaskLease {
  const deterministic = kind === 'source_snapshot' || kind === 'validate_architecture';
  return {
    task_id: uuid(1), run_id: uuid(2), workspace_id: uuid(3), tenant_id: uuid(4), course_id: 'course',
    task_key: kind === 'source_snapshot' ? 'source:snapshot' : kind === 'course_skeleton'
      ? 'architecture:course' : kind === 'validate_architecture' ? 'architecture:validate'
        : 'architecture:chapter:chapter-1:shard:1',
    kind, chapter_key: kind === 'chapter_blueprint' ? 'chapter-1' : null, node_id: null,
    contract_hash: hash('b'), input_context_hash: hash('c'), source_snapshot_id: uuid(5),
    source_snapshot_hash: hash('a'), runtime_config_hash: hash('runtime'), model: 'model',
    locale: 'vi', max_output_tokens: deterministic ? 0 : 32_000,
    provider_max_attempts: deterministic ? 0 : 2, execution_budget_ms: 300_000,
    lease_token: uuid(6), dispatch_epoch: 1, routing_shard: 17, ai_reservation_id: deterministic ? null : uuid(7),
  };
}

test('planning splits a chapter deterministically without splitting an oversized scope', () => {
  const first = planOrchestrationV2ChapterShards(skeleton, scopes, budgets, hash('c'));
  const second = planOrchestrationV2ChapterShards(skeleton, scopes, budgets, hash('c'));
  assert.deepEqual(first, second);
  assert.equal(first.chapter_tasks.length, 2);
  assert.deepEqual(first.chapter_tasks.map(task => task.shard_plan?.source_scope_ids), [['scope-1'], ['scope-2']]);
  assert.deepEqual(first.chapter_tasks.map(task => task.shard_plan?.shard_index), [0, 1]);
  assert.ok(first.chapter_tasks.every(task => task.shard_plan?.shard_count === 2));
  assert.equal(first.validation_task.kind, 'validate_architecture');
});

test('planning rejects missing scope ownership and an indivisible scope over 400k characters', () => {
  assert.throws(() => planOrchestrationV2ChapterShards(skeleton, scopes.slice(0, 1), budgets, hash('c')),
    { code: 'ORCHESTRATION_V2_PLANNING_INVALID' });
  assert.throws(() => planOrchestrationV2ChapterShards(skeleton,
    [{ ...scopes[0]!, content_chars: 400_001 }, scopes[1]!], budgets, hash('c')),
  { code: 'ORCHESTRATION_V2_SCOPE_EXCEEDS_SHARD' });
  const oversizedKey = { ...skeleton, chapters: [{ ...skeleton.chapters[0]!, chapter_key: `chapter-${'x'.repeat(140)}` }] };
  assert.throws(() => planOrchestrationV2ChapterShards(oversizedKey, scopes, budgets, hash('c')),
    { code: 'ORCHESTRATION_V2_PLANNING_INVALID' });
});

test('skeleton task contract is stable and bound to the sealed source catalog', () => {
  assert.deepEqual(buildOrchestrationV2SkeletonTask(hash('a'), hash('d'), providerBudget),
    buildOrchestrationV2SkeletonTask(hash('a'), hash('d'), providerBudget));
  assert.notEqual(buildOrchestrationV2SkeletonTask(hash('a'), hash('d'), providerBudget).contract_hash,
    buildOrchestrationV2SkeletonTask(hash('a'), hash('e'), providerBudget).contract_hash);
});

test('inventory task is deterministic, zero-token, and bound to the validated assembly', () => {
  const first = buildOrchestrationV2InventoryTask(hash('d'), 60_000);
  const second = buildOrchestrationV2InventoryTask(hash('d'), 60_000);
  assert.deepEqual(first, second);
  assert.equal(first.kind, 'publish_inventory');
  assert.equal(first.input_context_hash, hash('d'));
  assert.equal(first.budget.max_output_tokens, 0);
  assert.equal(first.budget.max_provider_attempts, 0);
  assert.notEqual(first.contract_hash, buildOrchestrationV2InventoryTask(hash('e'), 60_000).contract_hash);
});

function serviceFixture(kind: OrchestrationV2TaskLease['kind'], failBeforeDispatch = false) {
  const events: string[] = [];
  const authority = { tenant_id: uuid(4), kb_id: uuid(8), conversation_id: uuid(9), correlation_id: uuid(10),
    locale: 'vi' as const, source_documents: [{ document_id: uuid(11), kb_id: uuid(8), name: 'raw.pdf', type: 'file', status: 'learned' }] };
  const sourcePage = { contract_version: 2 as const, source_snapshot_hash: hash('a'),
    source_revision: hash('d'), source_authority: { mode: 'model_designed' as const, source: 'none' as const,
      complete: true, confidence: 0, structure_hash: hash('e'), reason_codes: [], chapters: [] },
    next_cursor: null, has_more: false, page_content_bytes: 5, facts: [{
    document_id: uuid(11), fact_key: 'fact-1', scope_key: 'scope-1', fact_text: 'Alpha', source_ref: null,
    source_page: 1, source_chunk: 0, locator: {},
  }] };
  const planning = {
    loadAuthority: async () => { events.push('authority'); return authority; },
    persistSourcePage: async () => { events.push('persist-source'); },
    loadPersistedSourceCatalog: async () => { events.push('persisted-catalog'); return [scopes[0]!]; },
    completeSource: async (_lease: unknown, response: { source_authority?: unknown }) => {
      events.push('complete-source');
      assert.deepEqual(response.source_authority, sourcePage.source_authority);
    },
    loadSourceCatalog: async () => { events.push('catalog'); return [scopes[0]!]; },
    loadSourceAuthority: async () => { events.push('source-authority'); return sourcePage.source_authority; },
    completeSkeleton: async () => { events.push('complete-skeleton'); },
    loadChapterInput: async () => { events.push('chapter-input'); return { skeleton,
      shard_plan: { chapter_key: 'chapter-1', order: 0, shard_index: 0, shard_count: 1,
        source_scope_ids: ['scope-1'], source_fact_count: 1, source_content_chars: 5 },
      source_facts: sourcePage.facts } },
    completeChapter: async () => { events.push('complete-chapter'); },
    loadArchitectureInput: async () => { events.push('architecture-input'); return { skeleton: {
      ...skeleton, chapters: [{ ...skeleton.chapters[0]!, source_scope_ids: ['scope-1'] }] },
    scopes: [scopes[0]!], shard_artifacts: [{ artifact_hash: hash('d'), shard: {
      contract_version: 2 as const, source_snapshot_hash: hash('a'), chapter_key: 'chapter-1', order: 0,
      shard_index: 0, shard_count: 1, source_scope_ids: ['scope-1'], title: 'Chapter', objective: 'Learn',
      lessons: [{ title: 'Lesson', objective: 'Learn', learning_objectives: ['Apply'],
        learning_activities: ['Read'], assessment: 'Check', units: [{ title: 'Unit', purpose: 'Teach',
          learning_objective_refs: ['lo_1'], source_scope_ids: ['scope-1'], component_plan: [{ type: 'html' as const,
            title: 'Explanation', rationale: 'Core teaching', source_scope_ids: ['scope-1'] }], media_brief: null }] }],
    } }] } },
    completeArchitecture: async () => { events.push('complete-architecture'); },
  };
  const worker = { markProviderDispatched: async () => { events.push('dispatch-marker'); } };
  const clients = {
    source: async (request: Record<string, unknown>, _execution: unknown,
      consumePage: (page: typeof sourcePage, startOrdinal: number) => Promise<void>) => { events.push('source-call');
      assert.equal(request.max_output_tokens, 1); await consumePage(sourcePage, 0);
      return { contract_version: 2 as const, source_snapshot_hash: hash('a'), source_revision: hash('d'),
        page_count: 1, fact_count: 1, source_authority: sourcePage.source_authority }; },
    skeleton: async (request: Record<string, unknown>, execution: { beforeProviderDispatch: () => Promise<void> }) => {
      events.push('skeleton-preflight');
      if (failBeforeDispatch) throw new Error('skeleton pre-dispatch failure');
      await execution.beforeProviderDispatch();
      events.push('skeleton-call');
      assert.deepEqual(request.scope_catalog, [scopes[0]!]);
      return { contract_version: 2 as const, skeleton }; },
    chapter: async (request: Record<string, unknown>, execution: { beforeProviderDispatch: () => Promise<void> }) => {
      events.push('chapter-preflight');
      if (failBeforeDispatch) throw new Error('chapter pre-dispatch failure');
      await execution.beforeProviderDispatch();
      events.push('chapter-call');
      assert.equal((request.shard_plan as { chapter_key: string }).chapter_key, 'chapter-1');
      return { contract_version: 2 as const, shard: { contract_version: 2 as const,
        source_snapshot_hash: hash('a'), chapter_key: 'chapter-1', order: 0, shard_index: 0, shard_count: 1,
        source_scope_ids: ['scope-1'], title: 'Chapter', objective: 'Learn', lessons: [{ title: 'Lesson',
          objective: 'Learn', learning_objectives: ['Apply'], learning_activities: ['Read'], assessment: 'Check',
          units: [{ title: 'Unit', purpose: 'Teach', learning_objective_refs: ['lo_1'], source_scope_ids: ['scope-1'],
            component_plan: [{ type: 'html' as const, title: 'Explanation', rationale: 'Core teaching',
              source_scope_ids: ['scope-1'] }], media_brief: null }] }] } }; },
  };
  return { kind, events, planning, worker, clients };
}

for (const kind of ['source_snapshot', 'course_skeleton', 'chapter_blueprint', 'validate_architecture'] as const) {
  test(`planning service executes one fenced ${kind} task in the required order`, async () => {
    const f = serviceFixture(kind);
    await executeOrchestrationV2PlanningTask(lease(kind), f.planning as never, f.worker as never, f.clients as never,
      { embedding_model: 'embedding', embedding_dimensions: 768, budgets }, async () => undefined, new AbortController().signal);
    if (kind === 'validate_architecture') {
      assert.deepEqual(f.events, ['architecture-input', 'complete-architecture']);
    } else if (kind === 'source_snapshot') {
      assert.deepEqual(f.events, ['authority', 'source-call', 'persist-source', 'persisted-catalog', 'complete-source']);
    } else if (kind === 'course_skeleton') {
      assert.deepEqual(f.events, ['authority', 'catalog', 'source-authority', 'skeleton-preflight',
        'dispatch-marker', 'skeleton-call', 'complete-skeleton']);
    } else {
      assert.deepEqual(f.events, ['authority', 'chapter-input', 'chapter-preflight',
        'dispatch-marker', 'chapter-call', 'complete-chapter']);
    }
  });
}

for (const kind of ['course_skeleton', 'chapter_blueprint'] as const) {
  test(`planning ${kind} pre-dispatch failure never writes the provider dispatch fence`, async () => {
    const f = serviceFixture(kind, true);
    await assert.rejects(() => executeOrchestrationV2PlanningTask(lease(kind), f.planning as never,
      f.worker as never, f.clients as never, { embedding_model: 'embedding', embedding_dimensions: 768, budgets },
      async () => undefined, new AbortController().signal), /pre-dispatch failure/);
    assert.equal(f.events.includes('dispatch-marker'), false);
    assert.equal(f.events.some(event => event.startsWith('complete-')), false);
  });
}
