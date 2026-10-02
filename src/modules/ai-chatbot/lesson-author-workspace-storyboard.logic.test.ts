import assert from 'node:assert/strict';
import test from 'node:test';
import type { LessonAuthorBlueprint } from './chat.service.js';
import { workspaceStoryboardSeed, editWorkspaceStoryboard, workspaceStoryboardView, workspaceOverview,
  WORKSPACE_AGGREGATE_EDIT, WORKSPACE_MEDIA_EDIT } from './lesson-author-workspace-storyboard.logic.js';
import { prepareWorkspaceEdit, prepareWorkspaceReset, type WorkspaceNodeSnapshot } from './lesson-author-workspace.logic.js';
import { workspaceEditChecksAccepted, type WorkspaceEditAcceptance } from './lesson-author-workspace-edit.repository.js';

function fixture(locale: 'vi' | 'en' = 'vi'): LessonAuthorBlueprint {
  const vi = locale === 'vi';
  return { architecture_contract_version: 5, content_contract_version: 1, title: vi ? 'Khóa học tổng hợp' : 'Synthetic course',
    summary: vi ? 'Giới thiệu quy trình.' : 'Introduce the procedure.', target_audience: vi ? 'Nhân viên' : 'Staff', prerequisites: [],
    assessment_strategy: vi ? 'Câu hỏi kiểm tra.' : 'Knowledge checks.', learning_outcomes: ['Do not remap this global outcome by array position'], assumptions: [],
    chapters: [1, 2].map(n => ({ title: vi ? `Chương ${n}` : `Chapter ${n}`, objective: vi ? `Giải thích bước ${n}` : `Explain step ${n}`,
      source_refs: [`chapter-source-${n}`], lessons: [{ title: `Lesson ${n}`, objective: 'Explain the approved steps.', learning_activities: ['Read and practise'], assessment: 'Check understanding',
        learning_objectives: ['Identify the first step', 'Describe the check'], source_refs: [`lesson-source-${n}`], units: [{ title: `Unit ${n}`, purpose: 'Explain and practise',
          source_refs: [`unit-source-${n}`], source_fact_ids: [`fact-${n}`], learning_objective_refs: ['lo_1'], primary_evidence_scope_ids: [`scope-${n}`], supporting_evidence_scope_ids: [],
          component_plan: [{ component_plan_id: `plan-${n}`, type: 'html', title: 'Explain', rationale: 'Source-supported explanation', source_fact_ids: [`fact-${n}`] }],
          media_plan: { type: 'video', title: vi ? 'Video quy trình' : 'Procedure video', content_outline: 'Legacy outline must not replace structured points',
            rationale: 'Demonstrate the sequence', brief_version: 2, content_points: ['Show the first step', 'Show the final check'], context_description: 'A demonstration at the work station.', evidence_language: 'original', content_basis: 'SOURCE_EXCERPTS' },
        }] }],
    })), media_review: { version: 'media-review-v1', decisions: [1, 2].map(n => ({ unit_path: `chapter_${n}.lesson_1.unit_1`, status: 'PROPOSED', reason_code: 'SOURCE_SUPPORTED' })) } };
}
const code = (expected: string) => (error: unknown) => error instanceof Error && error.message === expected;
const kinds = ['course', 'chapter', 'lesson', 'unit', 'media_brief'] as const;
const paths = ['course', 'chapter_1', 'chapter_1.lesson_1', 'chapter_1.lesson_1.unit_1', 'chapter_1.lesson_1.unit_1.media_1'];

test('all aggregate/media seed types retain VI/EN, canonical paths and detached protected references', () => {
  for (const locale of ['vi', 'en'] as const) {
    const bp = fixture(locale), before = structuredClone(bp);
    for (const [i, kind] of kinds.entries()) {
      const seed = workspaceStoryboardSeed(bp, kind, paths[i])!;
      assert.equal(seed.kind, kind); assert.equal(seed.canonical_path, paths[i]);
      assert.deepEqual(editWorkspaceStoryboard(seed, seed.baseline), seed.baseline);
      const view = workspaceStoryboardView(seed, seed.baseline);
      assert.equal(view.user_modified, false); assert.equal(view.semantic_fidelity, 'not_measured');
      assert.equal(view.apply_readiness, 'NOT_EVALUATED');
      view.readonly_references.source_refs.push('changed copy');
      assert.equal(seed.binding.readonly_references.source_refs.includes('changed copy'), false);
      assert.equal(JSON.stringify(seed.baseline).includes('scope-1'), false);
    }
    assert.deepEqual(bp, before);
  }
});
test('overview outcomes remain bound to exact chapter revisions; course-global outcomes are not assigned by position', () => {
  const bp = fixture(), root = workspaceStoryboardSeed(bp, 'course', 'course')!;
  const chapters = bp.chapters.map((_c, i) => { const seed = workspaceStoryboardSeed(bp, 'chapter', `chapter_${i + 1}`)!; return { seed, current: seed.baseline }; });
  chapters[1].current = { ...chapters[1].current, title: 'Tên đã sửa', data: { objective: 'Mục tiêu đã sửa', learning_objectives: [] } };
  const view = workspaceOverview(root, root.baseline, chapters.reverse());
  assert.equal(view.chapters[1].title, 'Tên đã sửa'); assert.equal(view.chapters[1].chapter_objective, 'Mục tiêu đã sửa');
  assert.equal(view.chapters[0].chapter_objective, bp.chapters[0].objective);
  assert.equal(view.chapters[1].author_review_required, true);
  assert.doesNotMatch(JSON.stringify(view), /Do not remap|quality|Rise Block|Block ID/);
  assert.throws(() => workspaceOverview(root, root.baseline, chapters.slice(0, 1)), code('WORKSPACE_CONTRACT_INVALID'));
  assert.throws(() => workspaceOverview(root, root.baseline, [chapters[0], chapters[0]]), code('WORKSPACE_CONTRACT_INVALID'));
});
test('course, chapter and lesson references include real descendants without creating canonical ownership', () => {
  const bp = fixture(), root = workspaceStoryboardSeed(bp, 'course', 'course')!;
  assert.deepEqual(root.binding.readonly_references.source_refs, ['chapter-source-1', 'lesson-source-1', 'chapter-source-2', 'lesson-source-2', 'unit-source-1', 'unit-source-2']);
  assert.deepEqual(root.binding.readonly_references.learning_objective_refs, []);
  assert.equal('source_fact_ids' in root.binding, false);
  const lesson = workspaceStoryboardSeed(bp, 'lesson', paths[2])!;
  assert.deepEqual(lesson.binding.readonly_references.learning_objective_refs, ['lo_1', 'lo_2']);
});
test('exact indexes and kinds resolve identity; duplicate titles never select a different node', () => {
  const bp = fixture(); bp.chapters[1].title = bp.chapters[0].title;
  assert.equal(workspaceStoryboardSeed(bp, 'chapter', 'chapter_2')!.baseline.data && (workspaceStoryboardSeed(bp, 'chapter', 'chapter_2')!.baseline.data as any).objective, bp.chapters[1].objective);
  for (const path of ['chapter_01', 'chapter_0', 'chapter_3', 'chapter_1.lesson_99', 'chapter_1.unit_1', 'chapter_1.lesson_1.unit_1.media_2']) {
    assert.throws(() => workspaceStoryboardSeed(bp, 'chapter', path), code('WORKSPACE_CONTRACT_INVALID'));
  }
  for (const version of [3, 4] as const) { bp.architecture_contract_version = version; assert.throws(() => workspaceStoryboardSeed(bp, 'course', 'course')); }
});
test('editing objective wording preserves canonical slots and requires author review, not automatic source verification', () => {
  const seed = workspaceStoryboardSeed(fixture(), 'lesson', paths[2])!;
  const content = structuredClone(seed.baseline), originalRefs = structuredClone(seed.binding.readonly_references);
  (content.data as any).learning_objectives[0] = 'Phân tích / Analyze the sequence';
  const view = workspaceStoryboardView(seed, content);
  assert.equal(view.author_review_required, true); assert.deepEqual(view.readonly_references, originalRefs);
  (content.data as any).learning_objectives.push('Another objective');
  assert.throws(() => editWorkspaceStoryboard(seed, content), code('WORKSPACE_NODE_FIELD_PROTECTED'));
});
test('typed fields reject learner payloads, asset URLs, forged locale/type, raw quality and readonly refs', () => {
  for (const [i, kind] of kinds.entries()) {
    const seed = workspaceStoryboardSeed(fixture(), kind, paths[i])!;
    for (const extra of [{ type: 'html' }, { url: 'https://example.invalid/asset' }, { content_locale: 'en' }, { quality_score: 99 }, { html: '<p>Wrong field</p>' }]) {
      assert.throws(() => editWorkspaceStoryboard(seed, { ...seed.baseline, data: { ...(seed.baseline.data as object), ...extra } }), code('WORKSPACE_CONTENT_INVALID'));
    }
    assert.throws(() => editWorkspaceStoryboard(seed, { ...seed.baseline, data: { source_refs: ['foreign'] } }), code('WORKSPACE_NODE_FIELD_PROTECTED'));
  }
});
test('active markup and control characters cannot enter aggregate/media text fields', () => {
  const seed = workspaceStoryboardSeed(fixture(), 'media_brief', paths[4])!;
  for (const title of ['<script>run()</script>', '\u0000', ' ']) assert.throws(() => editWorkspaceStoryboard(seed, { ...seed.baseline, title }));
  assert.throws(() => editWorkspaceStoryboard(seed, { ...seed.baseline, data: { content_points: ['<img src=x onerror=x>'], context_description: 'context' } }));
  assert.throws(() => editWorkspaceStoryboard(seed, { ...seed.baseline, implementation_notes: '<iframe src=x>' }));
});
test('structured media uses real bullet points and context, separate from rationale and legacy outline', () => {
  const bp = fixture(), seed = workspaceStoryboardSeed(bp, 'media_brief', paths[4])!;
  assert.deepEqual(seed.baseline.data, { content_points: ['Show the first step', 'Show the final check'], context_description: 'A demonstration at the work station.' });
  assert.equal(seed.baseline.purpose, 'Demonstrate the sequence'); assert.equal(seed.binding.media_type, 'video');
  assert.equal(seed.sort_order, 1); assert.equal(seed.parent_path, paths[3]);
  bp.chapters[0].lessons[0].units[0].media_plan!.type = 'static_infographic';
  assert.equal(workspaceStoryboardSeed(bp, 'media_brief', paths[4])!.binding.media_type, 'static_infographic');
});
test('legacy media has one unaltered outline bullet and honest missing context, never a fabricated screenplay', () => {
  const bp = fixture(), media = bp.chapters[0].lessons[0].units[0].media_plan!;
  delete media.brief_version; delete media.content_points; delete media.context_description;
  delete bp.media_review;
  const seed = workspaceStoryboardSeed(bp, 'media_brief', paths[4])!;
  assert.deepEqual(seed.baseline.data, { content_points: [media.content_outline], context_description: null });
  assert.equal(seed.binding.brief_format, 'outline_v1');
  const edit = editWorkspaceStoryboard(seed, { ...seed.baseline, data: { content_points: ['Author supplied brief'], context_description: 'Author supplied context' } });
  assert.equal(workspaceStoryboardView(seed, edit).author_review_required, true);
});
test('no empty media node for NOT_NEEDED/SOURCE_GAP/FAILED or absent legacy plan; contradictory proposals fail', () => {
  for (const status of ['NOT_NEEDED', 'SOURCE_GAP', 'FAILED', 'NOT_EVALUATED'] as const) {
    const bp = fixture(); delete bp.chapters[0].lessons[0].units[0].media_plan; bp.media_review!.decisions[0].status = status;
    assert.equal(workspaceStoryboardSeed(bp, 'media_brief', paths[4]), null);
  }
  const absent = fixture(); delete absent.media_review; delete absent.chapters[0].lessons[0].units[0].media_plan;
  assert.equal(workspaceStoryboardSeed(absent, 'media_brief', paths[4]), null);
  const contradicted = fixture(); contradicted.media_review!.decisions[0].status = 'NOT_NEEDED';
  assert.throws(() => workspaceStoryboardSeed(contradicted, 'media_brief', paths[4]), code('WORKSPACE_CONTRACT_INVALID'));
  const missing = fixture(); delete missing.chapters[0].lessons[0].units[0].media_plan;
  assert.throws(() => workspaceStoryboardSeed(missing, 'media_brief', paths[4]), code('WORKSPACE_CONTRACT_INVALID'));
});
test('malformed structured media is rejected, not silently downgraded to legacy outline', () => {
  for (const patch of [{ content_points: [] }, { content_points: Array(7).fill('point') }, { context_description: '' }, { brief_version: 3 }]) {
    const bp = fixture(); Object.assign(bp.chapters[0].lessons[0].units[0].media_plan!, patch);
    assert.throws(() => workspaceStoryboardSeed(bp, 'media_brief', paths[4]), code('WORKSPACE_CONTRACT_INVALID'));
  }
  const seed = workspaceStoryboardSeed(fixture(), 'media_brief', paths[4])!;
  assert.throws(() => editWorkspaceStoryboard(seed, { ...seed.baseline, data: { ...(seed.baseline.data as object), context_description: null } }));
});
test('Save and Reset preserve every original aggregate/media field across VI/EN without Apply', () => {
  for (const locale of ['vi', 'en'] as const) for (const [i, kind] of kinds.entries()) {
    const seed = workspaceStoryboardSeed(fixture(locale), kind, paths[i])!;
    const node: WorkspaceNodeSnapshot = { node_id: 'synthetic', kind, content_state: 'content_ready', current_revision: 0, baseline: seed.baseline, current: seed.baseline };
    const edit = prepareWorkspaceEdit(node, { expected_revision: 0, changes: { title: 'Author / Tác giả', implementation_notes: 'Author-only notes' } });
    editWorkspaceStoryboard(seed, edit.content);
    const reset = prepareWorkspaceReset({ ...node, current: edit.content, current_revision: 1 }, 1);
    assert.deepEqual(editWorkspaceStoryboard(seed, reset.content), seed.baseline); assert.equal(reset.user_modified, false);
  }
});
test('metadata receipts explicitly do not claim pedagogy or registry acceptance and cannot authorize component edits', () => {
  const receipt = { validation_contract: WORKSPACE_AGGREGATE_EDIT,
    checks: { schema: 'PASS', security: 'PASS', references: 'PASS', pedagogy: 'NOT_RUN', registry: 'NOT_APPLICABLE' } } as WorkspaceEditAcceptance;
  for (const kind of ['course', 'chapter', 'lesson', 'unit'] as const) assert.equal(workspaceEditChecksAccepted(kind, receipt), true);
  assert.equal(workspaceEditChecksAccepted('component', receipt), false);
  assert.equal(workspaceEditChecksAccepted('media_brief', receipt), false);
  assert.equal(workspaceEditChecksAccepted('media_brief', { ...receipt, validation_contract: WORKSPACE_MEDIA_EDIT }), true);
  for (const key of ['schema', 'security', 'references'] as const) assert.equal(workspaceEditChecksAccepted('chapter', { ...receipt, checks: { ...receipt.checks, [key]: 'NOT_RUN' } }), false);
  assert.equal(workspaceEditChecksAccepted('chapter', { ...receipt, checks: { ...receipt.checks, pedagogy: 'PASS', registry: 'PASS' } }), false);
  assert.equal(workspaceEditChecksAccepted('component', { ...receipt, validation_contract: 'workspace-component-edit-ready-1' }), false);
});
test('1001 source scopes remain bounded and complete in metadata references without a fact payload copy', () => {
  const bp = fixture(); bp.chapters = [bp.chapters[0]];
  bp.chapters[0].lessons[0].units = Array.from({ length: 1001 }, (_, i) => ({ ...structuredClone(bp.chapters[0].lessons[0].units[0]), source_refs: [`src_${i}`], primary_evidence_scope_ids: [`scope_${i}`] }));
  const root = workspaceStoryboardSeed(bp, 'course', 'course')!;
  assert.equal(root.binding.readonly_references.primary_evidence_scope_ids.length, 1001);
  assert.equal(root.binding.readonly_references.source_refs.length, 1003);
  assert.equal(JSON.stringify(root.baseline).includes('scope_'), false);
  bp.chapters[0].lessons[0].units[0].source_refs = Array.from({ length: 4097 }, (_, i) => `src_${i}`);
  assert.throws(() => workspaceStoryboardSeed(bp, 'course', 'course'), code('WORKSPACE_CONTRACT_INVALID'));
});
