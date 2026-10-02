import assert from 'node:assert/strict';
import test from 'node:test';
import { assembleOrchestrationV2Architecture } from './lesson-author-orchestration-v2-architecture.logic.js';
import { orchestrationV2Hash } from './lesson-author-orchestration-v2.logic.js';
import type { OrchestrationV2ChapterShard, OrchestrationV2CourseSkeleton } from './lesson-author-orchestration-v2-rag-contract.logic.js';

const hash = (value: string) => orchestrationV2Hash(value);
const skeleton: OrchestrationV2CourseSkeleton = {
  contract_version: 2, source_snapshot_hash: hash('source'), locale: 'vi', title: 'Course', summary: 'Summary',
  target_audience: 'Leaders', prerequisites: [], learning_outcomes: ['Apply'], assessment_strategy: 'Practice',
  assumptions: [], chapters: [{ chapter_key: 'chapter-1', order: 0, title: 'Chapter', objective: 'Learn',
    source_scope_ids: ['scope-1', 'scope-2'] }],
};
const scopes = [
  { scope_key: 'scope-1', title: 'One', source_ref: null, fact_count: 2, content_chars: 20 },
  { scope_key: 'scope-2', title: 'Two', source_ref: null, fact_count: 3, content_chars: 30 },
];
const shard = (index: number, scope: string): OrchestrationV2ChapterShard => ({
  contract_version: 2, source_snapshot_hash: skeleton.source_snapshot_hash, chapter_key: 'chapter-1', order: 0,
  shard_index: index, shard_count: 2, source_scope_ids: [scope], title: 'Chapter', objective: 'Learn',
  lessons: [{ title: `Lesson ${index + 1}`, objective: 'Learn', learning_objectives: ['Apply'],
    learning_activities: ['Read'], assessment: 'Check', units: [{ title: `Unit ${index + 1}`, purpose: 'Teach',
      learning_objective_refs: ['lo_1'], source_scope_ids: [scope], component_plan: [{ type: 'html',
        title: 'Explanation', rationale: 'Core teaching', source_scope_ids: [scope] }], media_brief: null }] }],
});

test('assembles a deterministic complete architecture with exact fact allocation', () => {
  const input = [{ artifact_hash: hash('shard-2'), shard: shard(1, 'scope-2') },
    { artifact_hash: hash('shard-1'), shard: shard(0, 'scope-1') }];
  const first = assembleOrchestrationV2Architecture(skeleton, scopes, input);
  const second = assembleOrchestrationV2Architecture(skeleton, scopes, [...input].reverse());
  assert.deepEqual(first, second);
  assert.equal(first.admitted_fact_count, 5);
  assert.equal(first.allocated_fact_count, 5);
  assert.equal(first.unit_count, 2);
  assert.deepEqual(first.shard_hashes, [hash('shard-1'), hash('shard-2')]);
  assert.equal(first.assembly_hash, second.assembly_hash);
});

test('rejects missing, duplicate, reordered, or out-of-scope allocations', () => {
  const good = [{ artifact_hash: hash('shard-1'), shard: shard(0, 'scope-1') },
    { artifact_hash: hash('shard-2'), shard: shard(1, 'scope-2') }];
  assert.throws(() => assembleOrchestrationV2Architecture(skeleton, scopes, good.slice(0, 1)),
    { code: 'ORCHESTRATION_V2_ARCHITECTURE_INVALID' });
  assert.throws(() => assembleOrchestrationV2Architecture(skeleton, scopes,
    [good[0]!, { ...good[1]!, artifact_hash: good[0]!.artifact_hash }]),
  { code: 'ORCHESTRATION_V2_ARCHITECTURE_INVALID' });
  const wrong = shard(1, 'scope-2');
  wrong.source_scope_ids = ['scope-1'];
  wrong.lessons[0]!.units[0]!.source_scope_ids = ['scope-1'];
  wrong.lessons[0]!.units[0]!.component_plan[0]!.source_scope_ids = ['scope-1'];
  assert.throws(() => assembleOrchestrationV2Architecture(skeleton, scopes,
    [good[0]!, { artifact_hash: hash('wrong'), shard: wrong }]),
  { code: 'ORCHESTRATION_V2_ARCHITECTURE_INVALID' });
});
