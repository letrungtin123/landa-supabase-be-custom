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

test('validates explicit structured-evidence status without rejecting legacy wire responses', () => {
  const ready = snapshot();
  const readyLocator = ready.facts[0]!.locator as Record<string, unknown>;
  readyLocator.source_evidence_status = 'ready';
  readyLocator.source_evidence_revision = 'e'.repeat(64);
  assert.equal(
    readOrchestrationV2SourceSnapshotPageResponse(ready, hash).facts[0]?.locator.source_evidence_status,
    'ready',
  );

  const legacy = snapshot();
  const legacyLocator = legacy.facts[0]!.locator as Record<string, unknown>;
  legacyLocator.source_evidence_status = 'legacy_review_required';
  assert.equal(
    readOrchestrationV2SourceSnapshotPageResponse(legacy, hash).facts[0]?.locator.source_evidence_status,
    'legacy_review_required',
  );

  const inconsistent = snapshot();
  const inconsistentLocator = inconsistent.facts[0]!.locator as Record<string, unknown>;
  inconsistentLocator.source_evidence_status = 'ready';
  assert.throws(
    () => readOrchestrationV2SourceSnapshotPageResponse(inconsistent, hash),
    { code: 'ORCHESTRATION_V2_RAG_RESPONSE_INVALID' },
  );
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

test('unit plan permits interaction-led teaching while enforcing HTML-first and FAQ-last', () => {
  const base = { type: 'la_diagram', title: 'Quan hệ', rationale: 'Trực quan hóa quan hệ',
    source_scope_ids: ['scope-1'] };
  const response = { contract_version: 2, shard: { contract_version: 2, source_snapshot_hash: hash,
    chapter_key: 'chapter-1', order: 0, shard_index: 0, shard_count: 1, source_scope_ids: ['scope-1'],
    title: 'Chương 1', objective: 'Mục tiêu', lessons: [{ title: 'Bài 1', objective: 'Hiểu nội dung',
      learning_objectives: ['Áp dụng'], learning_activities: ['Đọc'], assessment: 'Kiểm tra', units: [{
        title: 'Nội dung', purpose: 'Thực hành', learning_objective_refs: ['lo_1'],
        source_scope_ids: ['scope-1'], component_plan: [
          base,
          { ...base, type: 'problem', title: 'Kiểm tra' },
          { ...base, type: 'la_faq', title: 'Câu hỏi thường gặp' },
        ], media_brief: null,
      }] }] } };
  assert.deepEqual(readOrchestrationV2ChapterShardResponse(response, skeleton, plan)
    .shard.lessons[0]!.units[0]!.component_plan.map(component => component.type),
  ['la_diagram', 'problem', 'la_faq']);

  const htmlLate = structuredClone(response);
  htmlLate.shard.lessons[0]!.units[0]!.component_plan = [base,
    { ...base, type: 'html', title: 'Giải thích' }];
  assert.throws(() => readOrchestrationV2ChapterShardResponse(htmlLate, skeleton, plan),
    { code: 'ORCHESTRATION_V2_RAG_RESPONSE_INVALID' });

  const faqEarly = structuredClone(response);
  faqEarly.shard.lessons[0]!.units[0]!.component_plan = [
    { ...base, type: 'la_faq', title: 'Câu hỏi thường gặp' },
    { ...base, type: 'problem', title: 'Kiểm tra' },
  ];
  assert.throws(() => readOrchestrationV2ChapterShardResponse(faqEarly, skeleton, plan),
    { code: 'ORCHESTRATION_V2_RAG_RESPONSE_INVALID' });
});

test('assessment obligations admit slot three and reject slot four', () => {
  const component = { type: 'html', title: 'Giải thích', rationale: 'Nội dung chính',
    source_scope_ids: ['scope-1'] };
  const response = { contract_version: 2, shard: { contract_version: 2, source_snapshot_hash: hash,
    chapter_key: 'chapter-1', order: 0, shard_index: 0, shard_count: 1, source_scope_ids: ['scope-1'],
    title: 'Chương 1', objective: 'Mục tiêu', lessons: [{ title: 'Bài 1', objective: 'Hiểu nội dung',
      learning_objectives: ['Áp dụng'], learning_activities: ['Đọc'], assessment: 'Kiểm tra', units: [{
        title: 'Nội dung', purpose: 'Giải thích', learning_objective_refs: ['lo_1'],
        source_scope_ids: ['scope-1'], component_plan: [component,
          { ...component, type: 'la_diagram', title: 'Sơ đồ' },
          { ...component, type: 'problem', title: 'Kiểm tra' }], media_brief: null,
      }] }], assessment_obligations: [{ planned_slot_key: `ao2_${'b'.repeat(32)}`,
        lesson_index: 1, unit_index: 1, component_index: 3, learning_objective_refs: ['lo_1'],
        required_assessment_kind: 'single_choice', relevant_scope_ids: ['scope-1'],
        relevant_evidence_fact_ids: ['fact-1'], unresolved_reason: 'ASSESSMENT_SOURCE_CHECK_REQUIRED', status: 'open' }] } };
  assert.equal(readOrchestrationV2ChapterShardResponse(response, skeleton, plan)
    .shard.assessment_obligations?.[0]?.component_index, 3);

  const slotFour = structuredClone(response);
  slotFour.shard.lessons[0]!.units[0]!.component_plan.splice(2, 0,
    { ...component, type: 'la_sortable', title: 'Sắp xếp' });
  slotFour.shard.assessment_obligations[0]!.component_index = 4;
  assert.throws(() => readOrchestrationV2ChapterShardResponse(slotFour, skeleton, plan),
    { code: 'ORCHESTRATION_V2_RAG_RESPONSE_INVALID' });
});
