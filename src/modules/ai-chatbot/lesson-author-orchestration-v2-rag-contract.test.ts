import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OrchestrationV2RagContractError,
  readOrchestrationV2ChapterShardResponse,
  readOrchestrationV2CourseSkeletonResponse,
  readOrchestrationV2SourceSnapshotPageResponse,
  type OrchestrationV2ChapterShardPlan,
  type OrchestrationV2CourseSkeleton,
} from './lesson-author-orchestration-v2-rag-contract.logic.js';

const hash = 'a'.repeat(64);
const snapshot = () => ({ contract_version: 2, source_snapshot_hash: hash, source_revision: 'b'.repeat(64), facts: [
  { document_id: '00000000-0000-4000-8000-000000000001', fact_key: 'fact-1', scope_key: 'scope-1', fact_text: 'Alpha',
    source_ref: null, source_page: 1, source_chunk: 0, locator: { source_revision: 'b'.repeat(64),
      scope_title: 'Scope 1', index_id: '00000000-0000-4000-8000-000000000002' } },
], source_authority: { mode: 'model_designed', source: 'none', complete: true, confidence: 0,
  structure_hash: 'd'.repeat(64), reason_codes: [], chapters: [] },
next_cursor: null, has_more: false, page_content_bytes: 5 });
const skeleton: OrchestrationV2CourseSkeleton = { contract_version: 2, source_snapshot_hash: hash, locale: 'vi',
  title: 'Khóa học', summary: 'Tóm tắt', target_audience: 'Quản lý', prerequisites: [],
  learning_outcomes: ['Áp dụng'], assessment_strategy: 'Đánh giá', assumptions: [], chapters: [{
    chapter_key: 'chapter-1', order: 0, title: 'Chương 1', objective: 'Mục tiêu', source_scope_ids: ['scope-1'],
  }] };
const plan: OrchestrationV2ChapterShardPlan = { chapter_key: 'chapter-1', order: 0, shard_index: 0,
  shard_count: 1, source_scope_ids: ['scope-1'], source_fact_count: 1, source_content_chars: 5 };

test('accepts a bounded source page and rejects byte or revision drift', () => {
  assert.equal(readOrchestrationV2SourceSnapshotPageResponse(snapshot(), hash).facts[0]?.fact_key, 'fact-1');
  const bad = snapshot(); bad.page_content_bytes = 4;
  assert.throws(() => readOrchestrationV2SourceSnapshotPageResponse(bad, hash), OrchestrationV2RagContractError);
  assert.throws(() => readOrchestrationV2SourceSnapshotPageResponse(snapshot(), 'c'.repeat(64)),
    { code: 'ORCHESTRATION_V2_RAG_IDENTITY_MISMATCH' });
  assert.throws(() => readOrchestrationV2SourceSnapshotPageResponse(snapshot(), hash, 'c'.repeat(64)),
    { code: 'ORCHESTRATION_V2_RAG_IDENTITY_MISMATCH' });
});

test('binds skeleton response to the expected immutable source hash', () => {
  assert.equal(readOrchestrationV2CourseSkeletonResponse({ contract_version: 2, skeleton }, hash).skeleton.title, 'Khóa học');
  assert.throws(() => readOrchestrationV2CourseSkeletonResponse({ contract_version: 2, skeleton }, 'b'.repeat(64)),
    { code: 'ORCHESTRATION_V2_RAG_IDENTITY_MISMATCH' });
});

test('rejects a chapter shard whose identity or scope partition changed', () => {
  const response = { contract_version: 2, shard: { contract_version: 2, source_snapshot_hash: hash,
    chapter_key: 'chapter-1', order: 0, shard_index: 0, shard_count: 1, source_scope_ids: ['scope-1'],
    title: 'Chương 1', objective: 'Mục tiêu', lessons: [{ title: 'Bài 1', objective: 'Hiểu nội dung',
      learning_objectives: ['Áp dụng'], learning_activities: ['Đọc'], assessment: 'Kiểm tra',
      units: [{ title: 'Nội dung', purpose: 'Giải thích', learning_objective_refs: ['lo_1'],
        source_scope_ids: ['scope-1'], component_plan: [{ type: 'html', title: 'Giải thích',
          rationale: 'Nội dung chính', source_scope_ids: ['scope-1'] }], media_brief: null }] }] } };
  assert.equal(readOrchestrationV2ChapterShardResponse(response, skeleton, plan).shard.lessons.length, 1);
  response.shard.source_scope_ids = ['scope-khác'];
  assert.throws(() => readOrchestrationV2ChapterShardResponse(response, skeleton, plan),
    { code: 'ORCHESTRATION_V2_RAG_IDENTITY_MISMATCH' });
});

test('requires an explicit valid media brief and preserves its production brief fields', () => {
  const response = { contract_version: 2, shard: { contract_version: 2, source_snapshot_hash: hash,
    chapter_key: 'chapter-1', order: 0, shard_index: 0, shard_count: 1, source_scope_ids: ['scope-1'],
    title: 'Chương 1', objective: 'Mục tiêu', lessons: [{ title: 'Bài 1', objective: 'Hiểu nội dung',
      learning_objectives: ['Áp dụng'], learning_activities: ['Đọc'], assessment: 'Kiểm tra', units: [{
        title: 'Nội dung', purpose: 'Giải thích', learning_objective_refs: ['lo_1'],
        source_scope_ids: ['scope-1'], component_plan: [{ type: 'html', title: 'Giải thích',
          rationale: 'Nội dung chính', source_scope_ids: ['scope-1'] }], media_brief: {
          type: 'static_infographic', title: 'Bản đồ quyết định', content_points: ['Bối cảnh', 'Lựa chọn'],
          context_description: 'Tình huống họp điều hành', rationale: 'Giúp người học so sánh',
        },
      }] }] } };
  const parsed = readOrchestrationV2ChapterShardResponse(response, skeleton, plan);
  assert.equal(parsed.shard.lessons[0]?.units[0]?.media_brief?.content_points.length, 2);
  const missing = structuredClone(response) as Record<string, any>;
  delete missing.shard.lessons[0].units[0].media_brief;
  assert.throws(() => readOrchestrationV2ChapterShardResponse(missing, skeleton, plan),
    { code: 'ORCHESTRATION_V2_RAG_RESPONSE_INVALID' });
  const emptyPoints = structuredClone(response);
  emptyPoints.shard.lessons[0]!.units[0]!.media_brief!.content_points = [];
  assert.throws(() => readOrchestrationV2ChapterShardResponse(emptyPoints, skeleton, plan),
    { code: 'ORCHESTRATION_V2_RAG_RESPONSE_INVALID' });
});
