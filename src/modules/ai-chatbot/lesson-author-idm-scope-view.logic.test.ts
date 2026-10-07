import assert from 'node:assert/strict';
import test from 'node:test';
import { idmBlockScopeKey, type IdmCourseDesignV1 } from './lesson-author-idm.contract.js';
import {
  assertIdmCourseDesignInvariants,
  idmScopeViewOf,
  idmShardLessonsOf,
  planIdmChapterShards,
  remapFactsToBlockScopes,
  resolveOrchestrationScopeView,
} from './lesson-author-idm-scope-view.logic.js';
import { idmFixture, rehashIdmDesign, IDM_FIXTURE_SNAPSHOT_HASH } from './lesson-author-idm.fixture.js';
import { ORCHESTRATION_V2_IDM_EXECUTION_POLICY } from './lesson-author-orchestration-v2-execution.config.js';
import { orchestrationV2Hash } from './lesson-author-orchestration-v2.logic.js';
import type { OrchestrationV2PlanningBudgets } from './lesson-author-orchestration-v2-planning.logic.js';

type Mutable = Record<string, any>;
const budgets: OrchestrationV2PlanningBudgets = ORCHESTRATION_V2_IDM_EXECUTION_POLICY.planning;
const artifactHash = orchestrationV2Hash('skeleton-artifact');
const designInvalid = { code: 'IDM_COURSE_DESIGN_INVALID' };

test('scope view is legacy for legacy runs and never reads the payload', () => {
  assert.deepEqual(resolveOrchestrationScopeView('v2-legacy', undefined), { kind: 'legacy' });
  assert.deepEqual(resolveOrchestrationScopeView('v2-legacy', { idm: 'ignored' }), { kind: 'legacy' });
  assert.throws(() => resolveOrchestrationScopeView('v9' as never, {}), { code: 'IDM_CONTRACT_INVALID' });
});

test('IDM scope view exposes the block-scope catalogue, fact scopes and disposition counts', () => {
  const { design, facts } = idmFixture();
  const view = resolveOrchestrationScopeView('idm-1', { contract_version: 2, skeleton: {}, idm: design });
  assert.equal(view.kind, 'idm');
  if (view.kind !== 'idm') return;
  assert.deepEqual(view.scopeCatalog, design.block_scopes.map(scope => ({ scope_key: scope.scope_key,
    title: scope.title, source_ref: scope.source_ref, fact_count: scope.fact_count, content_chars: scope.content_chars })));
  const firstScope = design.block_scopes[0]!;
  assert.equal(view.scopeOfFact(firstScope.fact_keys[0]!), firstScope.scope_key);
  const excluded = design.dispositions.filter(item => !['course', 'reference_job_aid'].includes(item.disposition));
  assert.deepEqual(excluded.map(item => item.disposition), ['nice_to_know', 'hold', 'noise']);
  assert.ok(excluded.every(item => view.scopeOfFact(item.fact_key) === null));
  assert.equal(view.scopeOfFact('unknown-fact'), null);
  assert.equal(view.dispositionOf('unknown-fact'), null);
  assert.deepEqual(view.dispositionCounts, { course: facts.length - 3, reference_job_aid: 0, nice_to_know: 1,
    remove: 0, hold: 1, noise: 1 });
  assert.throws(() => resolveOrchestrationScopeView('idm-1', { skeleton: {} }), designInvalid);
  assert.throws(() => resolveOrchestrationScopeView('idm-1', null), designInvalid);
  assert.throws(() => resolveOrchestrationScopeView('idm-1', { idm: { ...design, extra: 1 } }),
    { code: 'IDM_CONTRACT_INVALID' });
});

test('IDM scope view rejects internally inconsistent block scopes and dispositions', () => {
  const broken = (change: (design: Mutable) => void) => {
    const design = structuredClone(idmFixture().design) as Mutable;
    change(design);
    return rehashIdmDesign(design as IdmCourseDesignV1);
  };
  assert.throws(() => idmScopeViewOf(broken(design => { design.dispositions.push({ ...design.dispositions[0] }); })),
    designInvalid);
  assert.throws(() => idmScopeViewOf(broken(design => { design.dispositions[0].disposition = 'remove'; })), designInvalid);
  assert.throws(() => idmScopeViewOf(broken(design => { design.dispositions.at(-1).block_id = 'cb_0001'; })),
    designInvalid);
  assert.throws(() => idmScopeViewOf(broken(design => { design.block_scopes[0].fact_count += 1; })), designInvalid);
  assert.throws(() => idmScopeViewOf(broken(design => { design.block_scopes.push(design.block_scopes[0]); })),
    designInvalid);
  assert.throws(() => idmScopeViewOf(broken(design => { design.block_scopes.pop(); })), designInvalid);
});

test('remap keeps only course/reference facts and rewrites their scope to the block scope', () => {
  const { design, facts } = idmFixture();
  const view = idmScopeViewOf(design);
  const remapped = remapFactsToBlockScopes(facts, view);
  assert.equal(remapped.length, facts.length - 3);
  for (const fact of remapped) {
    const scope = design.block_scopes.find(candidate => candidate.fact_keys.includes(fact.fact_key))!;
    assert.equal(fact.scope_key, scope.scope_key);
    assert.deepEqual({ ...fact, scope_key: 'scope3_00' }, facts.find(candidate => candidate.fact_key === fact.fact_key));
  }
  assert.equal(facts[0]!.scope_key, 'scope3_00', 'input facts are not mutated');
  assert.deepEqual(remapFactsToBlockScopes(facts, { kind: 'legacy' }), facts);
  assert.throws(() => remapFactsToBlockScopes([{ ...facts[0]!, fact_key: 'foreign' }], view), designInvalid);
});

test('IDM shard planning packs whole lessons in order under the 90k block-scope budget', () => {
  // Module 1: lessons of 50k, 30k (two blocks), 20k and 45k characters → [50k+30k], [20k+45k].
  const fixture = idmFixture([[[[50_000]], [[10_000], [20_000]], [[20_000]], [[45_000]]], [[[1_000]]]]);
  const first = planIdmChapterShards(fixture.skeleton, fixture.design, budgets, artifactHash);
  const second = planIdmChapterShards(fixture.skeleton, fixture.design, budgets, artifactHash);
  assert.deepEqual(first.chapter_tasks, second.chapter_tasks);
  const scopes = fixture.design.block_scopes.map(scope => scope.scope_key);
  assert.deepEqual(first.chapter_tasks.map(task => task.shard_plan), [
    { chapter_key: 'chapter-1', order: 0, shard_index: 0, shard_count: 2, source_scope_ids: scopes.slice(0, 3),
      source_fact_count: 3, source_content_chars: 80_000 },
    { chapter_key: 'chapter-1', order: 0, shard_index: 1, shard_count: 2, source_scope_ids: scopes.slice(3, 5),
      source_fact_count: 2, source_content_chars: 65_000 },
    { chapter_key: 'chapter-2', order: 1, shard_index: 0, shard_count: 1, source_scope_ids: scopes.slice(5, 6),
      source_fact_count: 1, source_content_chars: 1_000 },
  ]);
  for (const task of first.chapter_tasks) {
    assert.deepEqual(Object.keys(task.shard_plan!).sort(), ['chapter_key', 'order', 'shard_count', 'shard_index',
      'source_content_chars', 'source_fact_count', 'source_scope_ids'], 'Python ChapterShardPlanV2 forbids extra keys');
    assert.equal(task.kind, 'chapter_blueprint');
    assert.equal(task.input_context_hash, artifactHash);
    assert.deepEqual(task.budget, ORCHESTRATION_V2_IDM_EXECUTION_POLICY.planning.chapter);
    assert.equal(task.contract_hash, orchestrationV2Hash({ contract_version: 2, task_key: task.task_key,
      kind: 'chapter_blueprint', source_snapshot_hash: IDM_FIXTURE_SNAPSHOT_HASH, skeleton_artifact_hash: artifactHash,
      shard_plan: task.shard_plan, budget: task.budget }));
  }
  assert.deepEqual([...first.shard_lessons.values()], [
    { task_key: 'architecture:chapter:chapter-1:shard:1', chapter_key: 'chapter-1', shard_index: 0,
      module_key: 'mod_01', lesson_keys: ['lsn_001', 'lsn_002'], lesson_index_offset: 0, chapter_lesson_offset: 0 },
    { task_key: 'architecture:chapter:chapter-1:shard:2', chapter_key: 'chapter-1', shard_index: 1,
      module_key: 'mod_01', lesson_keys: ['lsn_003', 'lsn_004'], lesson_index_offset: 2, chapter_lesson_offset: 2 },
    { task_key: 'architecture:chapter:chapter-2:shard:1', chapter_key: 'chapter-2', shard_index: 0,
      module_key: 'mod_02', lesson_keys: ['lsn_005'], lesson_index_offset: 4, chapter_lesson_offset: 0 },
  ]);
  for (const task of first.chapter_tasks) {
    assert.deepEqual(idmShardLessonsOf(fixture.design, task.shard_plan!), first.shard_lessons.get(task.task_key));
  }
  assert.equal(first.validation_task.kind, 'validate_architecture');
  assert.equal(first.validation_task.contract_hash, orchestrationV2Hash({ contract_version: 2,
    task_key: 'architecture:validate', kind: 'validate_architecture', source_snapshot_hash: IDM_FIXTURE_SNAPSHOT_HASH,
    skeleton_artifact_hash: artifactHash, chapter_contract_hashes: first.chapter_tasks.map(task => task.contract_hash),
    execution_budget_ms: budgets.architecture_validation_budget_ms }));
});

test('a lesson above the shard budget fails with IDM_LESSON_EXCEEDS_SHARD even when each block fits', () => {
  const fixture = idmFixture([[[[50_000], [45_000]]]]);
  assert.throws(() => planIdmChapterShards(fixture.skeleton, fixture.design, budgets, artifactHash),
    { code: 'IDM_LESSON_EXCEEDS_SHARD' });
  const exact = idmFixture([[[[45_000], [45_000]], [[1]]]]);
  assert.deepEqual(planIdmChapterShards(exact.skeleton, exact.design, budgets, artifactHash).chapter_tasks
    .map(task => task.shard_plan!.source_content_chars), [90_000, 1]);
  assert.deepEqual(planIdmChapterShards(exact.skeleton, exact.design, budgets, artifactHash, 100_000).chapter_tasks
    .map(task => task.shard_plan!.source_content_chars), [90_001]);
  assert.throws(() => planIdmChapterShards(exact.skeleton, exact.design, budgets, artifactHash, 50_000),
    { code: 'IDM_LESSON_EXCEEDS_SHARD' });
});

test('IDM shard planning rejects skeleton/design drift and unsafe budgets', () => {
  const fixture = idmFixture();
  const reordered = structuredClone(fixture.skeleton);
  reordered.chapters[0]!.source_scope_ids.reverse();
  assert.throws(() => planIdmChapterShards(reordered, fixture.design, budgets, artifactHash), designInvalid);
  const missing = { ...fixture.skeleton, chapters: fixture.skeleton.chapters.slice(0, 1) };
  assert.throws(() => planIdmChapterShards(missing, fixture.design, budgets, artifactHash), designInvalid);
  assert.throws(() => planIdmChapterShards(fixture.skeleton, fixture.design,
    { ...budgets, chapter: { ...budgets.chapter, max_output_tokens: 65_537 } }, artifactHash),
  { code: 'ORCHESTRATION_V2_PLANNING_INVALID' });
  assert.throws(() => planIdmChapterShards(fixture.skeleton, fixture.design, budgets, 'not-a-hash'),
    { code: 'ORCHESTRATION_V2_PLANNING_INVALID' });
});

test('§12.6 invariants accept a consistent design and reject every documented violation', () => {
  const fixture = idmFixture();
  const check = (design: IdmCourseDesignV1, overrides: Partial<Parameters<typeof assertIdmCourseDesignInvariants>[0]> = {}) =>
    assertIdmCourseDesignInvariants({ design, skeleton: fixture.skeleton, sourceSnapshotHash: IDM_FIXTURE_SNAPSHOT_HASH,
      snapshotFacts: fixture.snapshotFacts, ...overrides });
  assert.equal(check(fixture.design).kind, 'idm');
  const broken = (change: (design: Mutable) => void) => {
    const design = structuredClone(fixture.design) as Mutable;
    change(design);
    return rehashIdmDesign(design as IdmCourseDesignV1);
  };
  // 1. dispositions = every snapshot fact exactly once.
  assert.throws(() => check(fixture.design, { snapshotFacts: [...fixture.snapshotFacts,
    { fact_key: 'late-fact', fact_chars: 10 }] }), designInvalid);
  assert.throws(() => check(fixture.design, { snapshotFacts: fixture.snapshotFacts.slice(1) }), designInvalid);
  assert.throws(() => check(fixture.design, { snapshotFacts: [...fixture.snapshotFacts, fixture.snapshotFacts[0]!] }),
    designInvalid);
  // 2. block scopes are measured from the persisted snapshot and keyed deterministically.
  assert.throws(() => check(fixture.design, { snapshotFacts: fixture.snapshotFacts.map((fact, index) =>
    index === 0 ? { ...fact, fact_chars: fact.fact_chars + 1 } : fact) }), designInvalid);
  assert.throws(() => check(broken(design => {
    design.block_scopes[0].scope_key = idmBlockScopeKey(IDM_FIXTURE_SNAPSHOT_HASH, 'cb_0099',
      design.block_scopes[0].fact_keys);
  })), designInvalid);
  assert.throws(() => check(broken(design => {
    design.dispositions[0].block_id = design.blocks[1].block_id;
  })), designInvalid);
  // 3. chapters ↔ modules ↔ block scopes.
  assert.throws(() => check(fixture.design, { skeleton: { ...fixture.skeleton,
    chapters: fixture.skeleton.chapters.slice(0, 1) } }), designInvalid);
  const swapped = structuredClone(fixture.skeleton);
  const moved = swapped.chapters[0]!.source_scope_ids.pop()!;
  swapped.chapters[1]!.source_scope_ids.unshift(moved);
  assert.throws(() => check(fixture.design, { skeleton: swapped }), designInvalid);
  const renamed = structuredClone(fixture.skeleton);
  renamed.chapters[0]!.chapter_key = 'chapter-x';
  assert.throws(() => check(fixture.design, { skeleton: renamed }), designInvalid);
  assert.throws(() => check(broken(design => {
    design.modules[1].lessons[0].lesson_key = design.modules[0].lessons[0].lesson_key;
  })), designInvalid);
  // 4. design hash and snapshot identity.
  assert.throws(() => check({ ...fixture.design, design_hash: 'f'.repeat(64) }), designInvalid);
  assert.throws(() => check(fixture.design, { sourceSnapshotHash: 'b'.repeat(64) }), designInvalid);
  assert.throws(() => check(fixture.design, { skeleton: { ...fixture.skeleton, locale: 'en' } }), designInvalid);
});
