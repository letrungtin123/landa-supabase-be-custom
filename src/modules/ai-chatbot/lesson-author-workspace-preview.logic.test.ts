import assert from 'node:assert/strict';
import test from 'node:test';
import { orchestrationV2DeterministicUuid } from './lesson-author-orchestration-v2-inventory.logic.js';
import { buildWorkspaceArchitecturePreview } from './lesson-author-workspace-preview.logic.js';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const source = 'a'.repeat(64), runId = uuid(1);
const skeleton = { contract_version: 2, source_snapshot_hash: source, locale: 'vi', title: 'Khóa học an toàn',
  summary: 'Tóm tắt', target_audience: 'Quản lý', prerequisites: [], learning_outcomes: ['Hiểu quy trình'],
  assessment_strategy: 'Thực hành', assumptions: [], chapters: [{ chapter_key: 'chapter-1', order: 0,
    title: 'Nhận diện', objective: 'Nhận diện rủi ro', source_scope_ids: ['scope-1'] }] };
const plan = { chapter_key: 'chapter-1', order: 0, shard_index: 0, shard_count: 1,
  source_scope_ids: ['scope-1'], source_fact_count: 1, source_content_chars: 100 };
const shard = { contract_version: 2, source_snapshot_hash: source, chapter_key: 'chapter-1', order: 0,
  shard_index: 0, shard_count: 1, source_scope_ids: ['scope-1'], title: 'Nhận diện', objective: 'Nhận diện rủi ro',
  lessons: [{ title: 'Mục 1', objective: 'Thực hiện', learning_objectives: ['Phân tích'],
    learning_activities: ['Đọc'], assessment: 'Một câu hỏi', units: [{ title: 'Bài học 1', purpose: 'Giải thích',
      learning_objective_refs: ['lo_1'], source_scope_ids: ['scope-1'], component_plan: [{ type: 'html',
        title: 'Nội dung chính', rationale: 'Nền tảng', source_scope_ids: ['scope-1'] }], media_brief: {
        type: 'static_infographic', title: 'Sơ đồ rủi ro', content_points: ['Điểm chính'],
        context_description: 'Sơ đồ minh họa', rationale: 'Hỗ trợ ghi nhớ' } }] }] };

function input(status = 'succeeded', unitStatus?: string) {
  const unitId = orchestrationV2DeterministicUuid(runId, 'node:chapter_1.lesson_1.unit_1');
  return { run_id: runId, course_title: 'Tên khóa học hiện tại', skeleton_artifact: { skeleton, shard_plans: [plan] },
    chapter_tasks: [{ task_id: uuid(2), task_key: 'architecture:chapter:chapter-1:shard:1',
      chapter_key: 'chapter-1', status, artifact_payload: status === 'succeeded' ? { shard } : null }],
    unit_tasks: unitStatus ? [{ node_id: unitId, status: unitStatus }] : [] };
}

test('projection begins with one durable-identity course progress node before the skeleton exists', () => {
  const preview = buildWorkspaceArchitecturePreview({ run_id: runId, course_title: 'Khóa học đang tạo',
    skeleton_artifact: null, chapter_tasks: [], unit_tasks: [] });
  assert.equal(preview.total_chapters, 0);
  assert.deepEqual(preview.nodes.map(node => [node.kind, node.state, node.title]),
    [['course', 'generating', 'Khóa học đang tạo']]);
  assert.equal(preview.nodes[0]!.node_id, orchestrationV2DeterministicUuid(runId, 'node:course'));
});

test('committed shard projection uses the exact future inventory IDs and exposes only safe presentation fields', () => {
  const preview = buildWorkspaceArchitecturePreview(input('succeeded', 'running'));
  assert.equal(preview.completed_chapters, 1);
  assert.deepEqual(preview.nodes.map(node => node.kind),
    ['course', 'chapter', 'lesson', 'unit', 'component', 'media_brief']);
  const unit = preview.nodes.find(node => node.kind === 'unit')!;
  assert.equal(unit.node_id, orchestrationV2DeterministicUuid(runId, 'node:chapter_1.lesson_1.unit_1'));
  assert.equal(unit.state, 'generating');
  assert.equal(preview.nodes.find(node => node.kind === 'component')!.component_type, 'html');
  assert.equal(preview.nodes.find(node => node.kind === 'media_brief')!.media_type, 'static_infographic');
  assert.equal(JSON.stringify(preview).includes('source_scope_ids'), false);
  assert.equal(JSON.stringify(preview).includes('rationale'), false);
});

test('unfinished or failed chapter work stays non-authoritative and never fabricates descendants', () => {
  const running = buildWorkspaceArchitecturePreview(input('running'));
  assert.equal(running.chapters[0]!.state, 'generating');
  assert.deepEqual(running.nodes.map(node => node.kind), ['course', 'chapter']);
  const failed = buildWorkspaceArchitecturePreview(input('failed'));
  assert.equal(failed.chapters[0]!.state, 'needs_action');
  assert.deepEqual(failed.nodes.map(node => node.kind), ['course', 'chapter']);
});

