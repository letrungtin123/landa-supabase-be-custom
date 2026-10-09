import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { COURSE_AUTHOR_NOTES_KEY, readCourseAuthorNotes } from '../course-authoring/course-author-notes.logic.js';
import { generationSnapshotHash as hash } from './lesson-author-generation-job.logic.js';
import { idmFixture, rehashIdmDesign } from './lesson-author-idm.fixture.js';
import type { WorkspaceApplyMapping, WorkspaceApplyWrite } from './lesson-author-workspace-apply.logic.js';
import { workspaceApplyBlockMetadata, workspaceAssessmentReviews, workspaceAuthorNotesHash, workspaceAuthorNotesRefreshes,
  workspaceBlockAuthorNotes, workspaceCourseAuthorNotes, type WorkspaceAssessmentObligationInput,
  type WorkspaceAuthorNotesContext } from './lesson-author-workspace-author-notes.logic.js';
import { persistCourseAuthorNotes, persistWorkspaceAuthorNotes, readWorkspaceAssessmentReviews,
  WorkspaceAuthorNotesTargetChanged } from './lesson-author-workspace-author-notes.repository.js';

const uuid = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const context = { workspace_id: uuid(1), content_locale: 'vi' as const };
const QA = 'QA tự động: IDM_W5_PRACTICE_INCOMPLETE đã sửa';
const BRIEF = { node_id: uuid(30), revision: 0, content_hash: hash('brief'), media_type: 'video',
  content: { title: 'Video quy trình 5Why', purpose: 'Minh hoạ chuỗi nguyên nhân', implementation_notes: null,
    data: { content_points: ['Tại sao 1', 'Tại sao 2'], context_description: 'Xưởng sản xuất' } } };

function unitWrite(overrides: Partial<WorkspaceApplyWrite> = {}): WorkspaceApplyWrite {
  return { node_id: uuid(10), parent_node_id: uuid(9), canonical_path: 'chapter_1.lesson_1.unit_1', kind: 'unit',
    block_type: 'vertical', sort_order: 0, revision: 2, content_hash: hash('unit-r2'), title: 'Bài 1',
    component: null, author_metadata: { purpose: 'Người học tự phân tích 5Why', implementation_notes: QA, storyboard: {},
      author_review: null, media_briefs: [structuredClone(BRIEF)] }, mapped_target: null, ...overrides };
}
function componentWrite(): WorkspaceApplyWrite {
  return { node_id: uuid(11), parent_node_id: uuid(10), canonical_path: 'chapter_1.lesson_1.unit_1.component_1', kind: 'component',
    block_type: 'html', sort_order: 0, revision: 0, content_hash: hash('component'), title: 'Lý thuyết',
    component: { type: 'html', title: 'Lý thuyết', data: '<p>Nội dung cho người học</p>',
      metadata: { component_plan_id: 'cp_1', source_fact_ids: ['f1'] } } as never,
    author_metadata: { purpose: 'Giải thích 5Why', implementation_notes: 'Ghi chú thành phần', storyboard: null,
      author_review: { purpose: 'Mục đích', example_scenario: 'Tình huống xưởng', visual_asset: null, user_behavior_navigation: null },
      media_briefs: [] }, mapped_target: null };
}
function mappingFor(write: WorkspaceApplyWrite, blockId: string): WorkspaceApplyMapping {
  return { node_id: write.node_id, target_block_id: blockId, target_parent_id: uuid(90), target_block_type: write.block_type,
    target_sort_order: write.sort_order, applied_revision: write.revision, applied_content_hash: write.content_hash,
    target_hash: hash(`target:${blockId}`), actual_target_hash: hash(`target:${blockId}`),
    receipt_revision_manifest: [{ node_id: write.node_id, revision: write.revision, content_hash: write.content_hash }] };
}

test('block metadata keeps mapping identity keys and learner component metadata; notes live under one reserved key', () => {
  const unit = workspaceApplyBlockMetadata(unitWrite(), context);
  assert.equal(unit.workspace_id, context.workspace_id); assert.equal(unit.workspace_node_id, uuid(10));
  assert.equal(unit.generated_by, 'lesson_author_ai'); assert.deepEqual(unit.workspace_storyboard, {});
  const notes = readCourseAuthorNotes(unit[COURSE_AUTHOR_NOTES_KEY])!;
  assert.equal(notes.version, 1); assert.equal(notes.implementation_notes, QA); assert.equal(notes.revision, 2);
  assert.equal(notes.storyboard, null, 'a unit storyboard is empty');
  assert.deepEqual(notes.media_briefs, [{ node_id: uuid(30), revision: 0, content_hash: BRIEF.content_hash, media_type: 'video',
    title: 'Video quy trình 5Why', rationale: 'Minh hoạ chuỗi nguyên nhân', content_points: ['Tại sao 1', 'Tại sao 2'],
    context_description: 'Xưởng sản xuất', implementation_notes: null }]);

  const write = componentWrite();
  const component = workspaceApplyBlockMetadata(write, context);
  assert.equal(component.component_plan_id, 'cp_1'); assert.deepEqual(component.source_fact_ids, ['f1']);
  assert.equal('workspace_storyboard' in component, false);
  const componentNotes = readCourseAuthorNotes(component[COURSE_AUTHOR_NOTES_KEY])!;
  assert.deepEqual(componentNotes.author_review, { purpose: 'Mục đích', example_scenario: 'Tình huống xưởng',
    visual_asset: null, user_behavior_navigation: null });
  // Learner payload is the compiled component data only; nothing author-only reaches it.
  assert.equal(JSON.stringify(write.component!.data).includes('Ghi chú'), false);
  assert.equal(JSON.stringify(write.component!.metadata).includes(COURSE_AUTHOR_NOTES_KEY), false);
});

test('notes are deterministic per revision: re-Apply is identical, a newer revision replaces them', () => {
  const first = workspaceBlockAuthorNotes(unitWrite(), context), again = workspaceBlockAuthorNotes(unitWrite(), context);
  assert.equal(workspaceAuthorNotesHash(first), workspaceAuthorNotesHash(again));
  const newer = workspaceBlockAuthorNotes(unitWrite({ revision: 3, content_hash: hash('unit-r3'),
    author_metadata: { ...unitWrite().author_metadata, implementation_notes: 'Ghi chú mới' } }), context);
  assert.notEqual(workspaceAuthorNotesHash(newer), workspaceAuthorNotesHash(first));
  assert.equal(newer.implementation_notes, 'Ghi chú mới'); assert.equal(newer.media_briefs.length, 1, 'no duplicated briefs');
  // jsonb reorders keys; the fingerprint must not.
  const reordered = Object.fromEntries(Object.entries(first).reverse());
  assert.equal(workspaceAuthorNotesHash(reordered), workspaceAuthorNotesHash(first));
});

test('only content-current blocks with stale notes are refreshed (edited brief or legacy block without notes)', () => {
  const write = unitWrite(), mapping = mappingFor(write, uuid(50));
  const current = workspaceBlockAuthorNotes(write, context);
  const plan = (stored: unknown) => workspaceAuthorNotesRefreshes({ materialized: [write], mappings: [mapping],
    stored_notes: new Map([[uuid(50), stored]]), context });
  assert.deepEqual(plan(structuredClone(current)), []);
  assert.equal(plan(null).length, 1, 'legacy block applied before notes existed');
  const editedBrief = structuredClone(current); editedBrief.media_briefs[0]!.revision = 1;
  assert.equal(plan(editedBrief).length, 1);
  assert.deepEqual(workspaceAuthorNotesRefreshes({ materialized: [write], mappings: [], stored_notes: new Map(), context }), [],
    'never invents a target for an unmapped write');
});

type Call = { sql: string; params: unknown[] };
function fakeTx(responses: { storedBlockNotes?: unknown; refreshRows?: number; courseNode?: Record<string, unknown> | null;
  storedRootNotes?: unknown; idm?: unknown; obligations?: Array<Record<string, unknown>> }) {
  const calls: Call[] = [];
  const tx = { async query(sql: string, params: unknown[] = []) {
    calls.push({ sql, params });
    if (/FROM lesson_author_workspace_v2_assessment_obligations o/.test(sql)) return { rows: responses.obligations ?? [] };
    if (/^SELECT id::text AS id,metadata->'ai_id_author_notes'/.test(sql)) {
      return { rows: (params[1] as string[]).map(id => ({ id, notes: responses.storedBlockNotes ?? null })) };
    }
    if (/^UPDATE course_blocks SET metadata=jsonb_set/.test(sql)) {
      return { rows: Array.from({ length: /parent_id IS NULL/.test(sql) ? 1 : responses.refreshRows ?? 1 }, () => ({ id: params[0] })) };
    }
    if (/FROM lesson_author_workspace_nodes n/.test(sql)) return { rows: responses.courseNode ? [responses.courseNode] : [] };
    if (/artifact_kind='course_skeleton'/.test(sql)) return { rows: responses.idm === undefined ? [] : [{ idm: responses.idm }] };
    if (/^SELECT metadata->'ai_id_author_notes' AS notes FROM course_blocks/.test(sql)) return { rows: [{ notes: responses.storedRootNotes ?? null }] };
    throw new Error(`unexpected SQL: ${sql}`);
  } };
  return { tx: tx as never, calls };
}
const courseContent = { title: 'BiC 5.0 — Thay đổi tư duy', purpose: null,
  data: { summary: 'Khoá học giúp CEO SME…', target_audience: 'CEO/BĐH SME', prerequisites: ['Kinh nghiệm quản lý'], assessment_strategy: 'Phiếu thực hành' },
  implementation_notes: 'Hold: Tam Hóa — cần SME. Nice to know: 4 lực đẩy.' };
const courseNodeRow = { content_state: 'content_ready', current_revision: '0', content: courseContent, content_hash: hash(courseContent) };
const base = { tenantId: uuid(2), courseId: 'course-v1:Nesso+364564+2026', workspaceId: uuid(1), courseNodeId: uuid(3), isV2: false,
  rootId: uuid(4), context };

test('persist: stale block notes are refreshed with an exact before-hash fence and recorded as a receipt delta', async () => {
  const write = unitWrite(), mapping = mappingFor(write, uuid(50));
  const { tx, calls } = fakeTx({ storedBlockNotes: null, courseNode: courseNodeRow });
  const result = await persistWorkspaceAuthorNotes(tx, { ...base, materialized: [write], mappings: [mapping],
    blockHash: async id => hash(`after:${id}`) });
  const refresh = calls.find(call => /^UPDATE course_blocks SET metadata=jsonb_set/.test(call.sql) && !/parent_id IS NULL/.test(call.sql))!;
  assert.match(refresh.sql, /workspace_course_block_hash\(id,course_id,\$6\)=\$7/);
  assert.doesNotMatch(refresh.sql, /\bdata=|is_published|display_name/, 'notes refresh never touches learner content or publish state');
  assert.deepEqual([refresh.params[0], refresh.params[2], refresh.params[3], refresh.params[4], refresh.params[5], refresh.params[6]],
    [uuid(50), base.courseId, mapping.target_parent_id, 'vertical', base.tenantId, mapping.target_hash]);
  assert.equal(readCourseAuthorNotes(JSON.parse(refresh.params[1] as string))!.implementation_notes, QA);
  assert.deepEqual(result.delta, [{ node_id: write.node_id, block_id: uuid(50), revision: 2, content_hash: write.content_hash,
    before_hash: mapping.target_hash, after_hash: hash(`after:${uuid(50)}`) }]);
  // Course-level notes: reserved key on the root only, never title/description.
  const root = calls.find(call => /parent_id IS NULL AND block_type='course'/.test(call.sql) && /^UPDATE/.test(call.sql))!;
  assert.doesNotMatch(root.sql, /display_name|description|\bdata=/);
  const courseNotes = readCourseAuthorNotes(JSON.parse(root.params[1] as string))!;
  assert.equal(courseNotes.node_kind, 'course'); assert.equal(courseNotes.title, courseContent.title);
  assert.deepEqual(courseNotes.storyboard!.prerequisites, ['Kinh nghiệm quản lý']);
  assert.match(courseNotes.implementation_notes!, /Hold: Tam Hóa/);
  assert.deepEqual(result.touched, [uuid(50), base.rootId]);
});

test('persist: re-Apply of the same revision writes nothing (idempotent, no duplicate notes)', async () => {
  const write = unitWrite(), mapping = mappingFor(write, uuid(50));
  const storedCourse = workspaceCourseAuthorNotes({ ...context, node_id: base.courseNodeId, revision: 0,
    content_hash: courseNodeRow.content_hash, content: courseContent, idm_guidance: null });
  const { tx, calls } = fakeTx({ storedBlockNotes: workspaceBlockAuthorNotes(write, context), courseNode: courseNodeRow,
    storedRootNotes: JSON.parse(JSON.stringify(storedCourse)) });
  const result = await persistWorkspaceAuthorNotes(tx, { ...base, materialized: [write], mappings: [mapping],
    blockHash: async () => { throw new Error('no write expected'); } });
  assert.deepEqual(result, { delta: [], touched: [] });
  assert.equal(calls.some(call => /^UPDATE/.test(call.sql)), false);
});

test('persist: a concurrent author edit (hash fence miss) fails closed; unready course node is skipped', async () => {
  const write = unitWrite(), mapping = mappingFor(write, uuid(50));
  const { tx } = fakeTx({ storedBlockNotes: null, refreshRows: 0, courseNode: null });
  await assert.rejects(persistWorkspaceAuthorNotes(tx, { ...base, materialized: [write], mappings: [mapping],
    blockHash: async () => hash('x') }), WorkspaceAuthorNotesTargetChanged);
  const skipped = fakeTx({ courseNode: { ...courseNodeRow, content_state: 'generating' } });
  assert.deepEqual(await persistWorkspaceAuthorNotes(skipped.tx, { ...base, materialized: [], mappings: [], blockHash: async () => hash('x') }),
    { delta: [], touched: [] });
  const tampered = fakeTx({ courseNode: { ...courseNodeRow, content_hash: hash('other') } });
  assert.deepEqual(await persistWorkspaceAuthorNotes(tampered.tx, { ...base, materialized: [], mappings: [], blockHash: async () => hash('x') }),
    { delta: [], touched: [] }, 'an unverifiable course revision is never persisted');
});

test('semantic replay: only the unmapped course root notes may be written, once', async () => {
  const first = fakeTx({ courseNode: courseNodeRow, storedRootNotes: null });
  assert.deepEqual(await persistCourseAuthorNotes(first.tx, base), [base.rootId]);
  assert.ok(first.calls.every(call => !/^UPDATE/.test(call.sql) || /parent_id IS NULL AND block_type='course'/.test(call.sql)),
    'no mapped block is touched');
  const written = JSON.parse(first.calls.find(call => /^UPDATE/.test(call.sql))!.params[1] as string);
  const again = fakeTx({ courseNode: courseNodeRow, storedRootNotes: written });
  assert.deepEqual(await persistCourseAuthorNotes(again.tx, base), []);
  assert.equal(again.calls.some(call => /^UPDATE/.test(call.sql)), false);
});

test('persist: V2 course notes carry the IDM Hold items, SME questions and nice-to-know', async () => {
  const fixtureDesign = structuredClone(idmFixture().design);
  // QLT-3: 12 questions on one block; the free-text course note would show 10 and "và 2 mục khác".
  fixtureDesign.blocks[0]!.sme_questions = Array.from({ length: 8 }, (_, index) => `Câu hỏi A${index + 1} cho chuyên gia?`);
  fixtureDesign.blocks[1]!.sme_questions = Array.from({ length: 4 }, (_, index) => `Câu hỏi B${index + 1} cho chuyên gia?`);
  const design = JSON.parse(JSON.stringify(rehashIdmDesign(fixtureDesign)));
  const { tx, calls } = fakeTx({ courseNode: courseNodeRow, idm: design });
  await persistWorkspaceAuthorNotes(tx, { ...base, isV2: true, materialized: [], mappings: [], blockHash: async () => hash('x') });
  const root = calls.find(call => /^UPDATE/.test(call.sql))!;
  const notes = readCourseAuthorNotes(JSON.parse(root.params[1] as string))!;
  assert.ok(notes.idm_guidance);
  assert.equal(notes.idm_guidance!.hold_items.length, design.hold_items.length);
  assert.ok(notes.idm_guidance!.hold_items.every(item => typeof item.name === 'string'));
  assert.equal(notes.idm_guidance!.sme_questions!.length, 12, 'the complete SME list, not the truncated note');
  assert.ok(calls.some(call => /artifact_kind='course_skeleton'/.test(call.sql) && call.params[0] === base.workspaceId
    && call.params[1] === base.tenantId && call.params[2] === base.courseId), 'tenant/course/workspace-bound design read');
});

// --- QLT-3: open assessment obligations reach the author notes -------------------------------
const lessonContent = { title: 'Nhận diện thói quen cũ', purpose: null, implementation_notes: null,
  data: { objective: 'Đối chiếu 4 trục', learning_objectives: ['Đánh giá hiện trạng theo 4 trục BiC', 'Lập lộ trình chuyển đổi'] } };
const unitContent = { title: 'Ma trận 4 trục', purpose: 'Người học đối chiếu', implementation_notes: null, data: {} };
function obligation(overrides: Partial<WorkspaceAssessmentObligationInput> = {}): WorkspaceAssessmentObligationInput {
  return { obligation_id: uuid(60), unit_node_id: uuid(10), unit_path: 'chapter_1.lesson_1.unit_1', component_index: 2,
    required_kind: 'single_choice', learning_objective_refs: ['lo_1'], unresolved_reason: 'ASSESSMENT_SOURCE_CHECK_REQUIRED',
    evidence_fact_count: 9, unit: unitContent, lesson: lessonContent, ...overrides };
}
const openReviews = () => workspaceAssessmentReviews([
  obligation(),
  obligation({ obligation_id: uuid(61), unit_node_id: uuid(20), unit_path: 'chapter_4.lesson_2.unit_1', learning_objective_refs: ['lo_2', 'lo_9'],
    evidence_fact_count: 13 }),
]);
const v2Context = (reviews = openReviews()): WorkspaceAuthorNotesContext => ({ ...context, assessment_reviews: reviews });

test('obligations map to author reviews: lesson-local objective refs resolve, unknown refs stay codes, bad rows are skipped', () => {
  const reviews = workspaceAssessmentReviews([
    obligation(),
    obligation({ obligation_id: uuid(61), learning_objective_refs: ['lo_2', 'lo_9'] }),
    obligation({ obligation_id: uuid(62), lesson: null, unit: null, unit_node_id: null }),
    obligation({ obligation_id: 'not-an-id' }),
    obligation({ obligation_id: uuid(63), unresolved_reason: 'free text' }),
  ]);
  assert.deepEqual(reviews[0], { obligation_id: uuid(60), unit_node_id: uuid(10), unit_path: 'chapter_1.lesson_1.unit_1',
    unit_title: 'Ma trận 4 trục', component_index: 2, required_kind: 'single_choice', learning_objective_refs: ['lo_1'],
    learning_objectives: ['Đánh giá hiện trạng theo 4 trục BiC'], unresolved_reason: 'ASSESSMENT_SOURCE_CHECK_REQUIRED',
    evidence_fact_count: 9 });
  assert.deepEqual(reviews[1]!.learning_objectives, ['Lập lộ trình chuyển đổi'], 'lo_2 is the 2nd lesson objective; lo_9 is unresolved');
  assert.deepEqual([reviews[2]!.unit_title, reviews[2]!.learning_objectives, reviews[2]!.unit_node_id], [null, [], null],
    'an unverified revision never supplies text');
  assert.deepEqual(reviews.map(review => review.obligation_id), [uuid(60), uuid(61), uuid(62)]);
});

test('a unit carries only its own open obligations; other blocks and obligation-free units are unchanged', () => {
  const unit = readCourseAuthorNotes(workspaceApplyBlockMetadata(unitWrite(), v2Context())[COURSE_AUTHOR_NOTES_KEY])!;
  assert.deepEqual(unit.assessment_reviews!.map(review => review.obligation_id), [uuid(60)]);
  const other = workspaceBlockAuthorNotes(unitWrite({ node_id: uuid(12) }), v2Context());
  assert.equal('assessment_reviews' in other, false, 'no empty key: notes stay byte-identical to pre-QLT-3 notes');
  assert.equal(workspaceAuthorNotesHash(other), workspaceAuthorNotesHash(workspaceBlockAuthorNotes(unitWrite({ node_id: uuid(12) }), context)));
  const component = workspaceBlockAuthorNotes({ ...componentWrite(), node_id: uuid(10) }, v2Context());
  assert.equal('assessment_reviews' in component, false, 'only unit nodes own obligations');
  // Learner payload of the unit block is untouched by obligations.
  const { [COURSE_AUTHOR_NOTES_KEY]: _notes, ...learner } = workspaceApplyBlockMetadata(unitWrite(), v2Context());
  assert.equal(JSON.stringify(learner).includes('ASSESSMENT_SOURCE_CHECK_REQUIRED'), false);
});

test('course root: a V2 Apply always records the run-wide list (even empty); V1 never adds the key', () => {
  const course = (ctx: WorkspaceAuthorNotesContext) => workspaceCourseAuthorNotes({ ...ctx, node_id: base.courseNodeId, revision: 0,
    content_hash: courseNodeRow.content_hash, content: courseContent, idm_guidance: null });
  assert.deepEqual(course(v2Context()).assessment_reviews!.map(review => review.unit_path),
    ['chapter_1.lesson_1.unit_1', 'chapter_4.lesson_2.unit_1']);
  assert.deepEqual(course(v2Context([])).assessment_reviews, []);
  assert.equal('assessment_reviews' in course(context), false);
});

test('re-Apply: a resolved obligation disappears from the unit (notes-only refresh) and from the root (also on replay)', async () => {
  const write = unitWrite(), mapping = mappingFor(write, uuid(50));
  const storedWithOpen = structuredClone(workspaceBlockAuthorNotes(write, v2Context()));
  assert.equal(storedWithOpen.assessment_reviews!.length, 1);
  const resolved = v2Context(openReviews().filter(review => review.obligation_id !== uuid(60)));
  const plan = workspaceAuthorNotesRefreshes({ materialized: [write], mappings: [mapping], stored_notes: new Map([[uuid(50), storedWithOpen]]),
    context: resolved });
  assert.equal(plan.length, 1, 'content-current unit gets a notes-only refresh');
  assert.equal('assessment_reviews' in plan[0]!.notes, false);
  assert.deepEqual(workspaceAuthorNotesRefreshes({ materialized: [write], mappings: [mapping],
    stored_notes: new Map([[uuid(50), storedWithOpen]]), context: v2Context() }), [], 'unchanged obligations write nothing');

  const v2Base = { ...base, isV2: true };
  const first = fakeTx({ courseNode: courseNodeRow });
  assert.deepEqual(await persistCourseAuthorNotes(first.tx, { ...v2Base, context: v2Context() }), [base.rootId]);
  const written = JSON.parse(first.calls.find(call => /^UPDATE/.test(call.sql))!.params[1] as string);
  assert.equal(readCourseAuthorNotes(written)!.assessment_reviews!.length, 2);
  const replay = fakeTx({ courseNode: courseNodeRow, storedRootNotes: written });
  assert.deepEqual(await persistCourseAuthorNotes(replay.tx, { ...v2Base, context: resolved }), [base.rootId]);
  const refreshed = readCourseAuthorNotes(JSON.parse(replay.calls.find(call => /^UPDATE/.test(call.sql))!.params[1] as string))!;
  assert.deepEqual(refreshed.assessment_reviews!.map(review => review.obligation_id), [uuid(61)]);
  assert.ok(replay.calls.every(call => !/^UPDATE/.test(call.sql) || /parent_id IS NULL AND block_type='course'/.test(call.sql)),
    'a replay never touches a mapped block');
  const again = fakeTx({ courseNode: courseNodeRow, storedRootNotes: JSON.parse(JSON.stringify(refreshed)) });
  assert.deepEqual(await persistCourseAuthorNotes(again.tx, { ...v2Base, context: resolved }), [], 'idempotent');
});

test('obligations are read only, open only and bound to the run, workspace, tenant and course', async () => {
  const run = uuid(70);
  const { tx, calls } = fakeTx({ obligations: [
    { obligation_id: uuid(60), unit_path: 'chapter_1.lesson_1.unit_1', planned_component_index: 2, learning_objective_refs: ['lo_1'],
      required_assessment_kind: 'single_choice', evidence_fact_count: 9, unresolved_reason: 'ASSESSMENT_SOURCE_CHECK_REQUIRED',
      unit_node_id: uuid(10), unit_content: unitContent, unit_content_hash: hash(unitContent),
      lesson_content: lessonContent, lesson_content_hash: hash(lessonContent) },
    { obligation_id: uuid(61), unit_path: 'chapter_4.lesson_2.unit_1', planned_component_index: '2', learning_objective_refs: ['lo_1'],
      required_assessment_kind: 'single_choice', evidence_fact_count: '13', unresolved_reason: 'ASSESSMENT_SOURCE_CHECK_REQUIRED',
      unit_node_id: uuid(20), unit_content: unitContent, unit_content_hash: hash('other'),
      lesson_content: lessonContent, lesson_content_hash: hash('tampered') },
  ] });
  const reviews = await readWorkspaceAssessmentReviews(tx, { tenantId: base.tenantId, courseId: base.courseId, workspaceId: base.workspaceId, runId: run });
  assert.equal(calls.length, 1);
  const { sql, params } = calls[0]!;
  assert.match(sql, /^SELECT /); assert.doesNotMatch(sql, /\b(UPDATE|INSERT|DELETE|FOR UPDATE|FOR SHARE)\b/);
  assert.deepEqual(params, [run, base.workspaceId, base.tenantId, base.courseId]);
  assert.match(sql, /WHERE o\.run_id=\$1 AND o\.workspace_id=\$2 AND o\.tenant_id=\$3 AND o\.course_id=\$4 AND o\.status='open'/);
  assert.equal((sql.match(/AND u\.tenant_id=|AND ur\.tenant_id=|AND l\.tenant_id=|AND lr\.tenant_id=/g) ?? []).length, 4,
    'every join stays inside the tenant');
  assert.match(sql, /LIMIT 200$/);
  assert.deepEqual(reviews.map(review => [review.obligation_id, review.unit_title, review.learning_objectives, review.evidence_fact_count]), [
    [uuid(60), 'Ma trận 4 trục', ['Đánh giá hiện trạng theo 4 trục BiC'], 9],
    [uuid(61), null, [], 13],
  ], 'hash-verified revisions only supply titles and objectives');
});

test('Apply wiring: V2 obligations are read once, before the replay branch, and reach units, refreshes and the root', () => {
  const source = readFileSync(new URL('./lesson-author-workspace-apply.repository.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const read = source.indexOf('readWorkspaceAssessmentReviews(tx, {');
  assert.ok(read > 0 && read < source.indexOf('const semanticPrior = await tx.query('), 'read before the semantic replay check');
  assert.equal((source.match(/readWorkspaceAssessmentReviews\(tx,/g) ?? []).length, 1);
  assert.match(source, /\.\.\.\(isV2 \? \{ assessment_reviews: await readWorkspaceAssessmentReviews\(tx, \{ tenantId: target\.tenantId,\n\s+courseId: target\.courseId, workspaceId: target\.workspaceId, runId: text\(w\.v2_run_id\) \}\) \} : \{\}\)/);
  assert.match(source, /persistCourseAuthorNotes\(tx, \{[^}]*context: notesContext \}\)/, 'replay refreshes the root list');
  assert.match(source, /const metadata = workspaceApplyBlockMetadata\(write, notesContext\);/);
  assert.match(source, /persistWorkspaceAuthorNotes\(tx, \{[^}]*context: notesContext,/);
});
