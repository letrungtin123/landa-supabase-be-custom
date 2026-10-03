import assert from 'node:assert/strict';
import test from 'node:test';
import { compileWorkspaceApply, workspaceApplyEstablishedParentOffsets, workspaceApplyMaterializationPlan, workspaceApplyTargetHash, workspaceApplyWriteAlreadyMaterialized,
  WorkspaceApplyCompileError, type WorkspaceApplyCompileInput, type WorkspaceApplyNode } from './lesson-author-workspace-apply.logic.js';
import { workspaceInventoryFixture } from './lesson-author-workspace-inventory.fixture.js';
import { buildWorkspaceInventory } from './lesson-author-workspace-inventory.logic.js';
import { workspaceStoryboardSeed } from './lesson-author-workspace-storyboard.logic.js';
import { hydrateWorkspaceComponent, workspaceComponentContent } from './lesson-author-workspace-component.logic.js';
import { encodeWorkspaceProblem } from './lesson-author-workspace-problem.logic.js';
import { generationSnapshotHash as hash } from './lesson-author-generation-job.logic.js';
import type { LessonAuthorBlueprint } from './chat.service.js';
import type { LessonAuthorProposal } from '../course-authoring/course-authoring.service.js';
import type { CourseComponentType } from '../tenants/tenant-course-components.constants.js';

const uuid = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const allowed = new Set<CourseComponentType>(['html', 'problem', 'la_sortable', 'la_crossword', 'la_diagram', 'la_faq']);
const html = (n: number) => `<p>Section ${n} explains a specific procedure using the supplied evidence. Read all instructions before starting the activity. Inspect each required item and record the result carefully. Follow the stated sequence to complete the task, then verify the final outcome against the original requirements.</p>`;
function typedData(type: string, n: number): unknown {
  if (type === 'html') return html(n);
  if (type === 'problem') return { kind: 'multiple_choice', question: 'Which step comes first?', explanation: 'Read first.', hints: [], choices: [{ text: 'Read', correct: true }, { text: 'Skip', correct: false }] };
  if (type === 'la_sortable') return { question_text: 'Order these steps.', items: [{ id: 1, text: 'Read' }, { id: 2, text: 'Check' }, { id: 3, text: 'Act' }] };
  if (type === 'la_faq') return { items: [{ id: 1, question: 'Why read?', answer: 'To understand the steps.' }, { id: 2, question: 'Why check?', answer: 'To detect missing items.' }] };
  if (type === 'la_crossword') return { words: ['READ', 'CHECK', 'ACT'].map((answer, row) => ({ id: row + 1, answer, clue: `Term ${row + 1}`, hint: '', row, col: 0, direction: 'across' })), keyword_coordinates: [{ row: 0, col: 0 }] };
  return { start_diagram_id: 'main', diagrams: [{ id: 'main', name: 'Process', nodes: [
    { id: 'a', type: 'customShape', position: { x: 0, y: 0 }, data: { label: 'Read' } },
    { id: 'b', type: 'customShape', position: { x: 200, y: 0 }, data: { label: 'Check' } },
  ], edges: [{ id: 'ab', source: 'a', target: 'b', label: 'then' }] }] };
}
function refresh(input: WorkspaceApplyCompileInput) {
  input.request.expected_revision_manifest = input.nodes.map(n => ({ node_id: n.node_id, revision: n.current_revision!, content_hash: n.current!.content_hash }));
  input.request.expected_target_snapshot_hash = workspaceApplyTargetHash(input.targets);
}
function fixture(blueprint = workspaceInventoryFixture(2), scope = 'chapter_1'): WorkspaceApplyCompileInput {
  const inventory = buildWorkspaceInventory(blueprint, allowed).nodes;
  const ids = new Map(inventory.map((n, i) => [n.canonical_path, uuid(i + 1)]));
  let ordinal = 0;
  const nodes: WorkspaceApplyNode[] = inventory.filter(n => n.kind !== 'course').map(n => {
    const content = n.kind === 'component'
      ? { title: String(n.protected_contract.display_title), purpose: null, data: typedData(n.protected_contract.component_type as string, ++ordinal), implementation_notes: null }
      : workspaceStoryboardSeed(blueprint, n.kind as 'chapter' | 'lesson' | 'unit' | 'media_brief', n.canonical_path)!.baseline;
    return { ...n, node_id: ids.get(n.canonical_path)!, parent_id: ids.get(n.parent_path!)!, kind: n.kind as WorkspaceApplyNode['kind'],
      content_state: 'content_ready' as const, current_revision: 0,
      baseline: { content: structuredClone(content), content_hash: hash(content) }, current: { content: structuredClone(content), content_hash: hash(content) } };
  }).map(({ ...n }) => { delete (n as any).parent_path; return n; });
  const byPath = new Map(nodes.map(n => [n.canonical_path, n]));
  const accepted_baselines = blueprint.chapters.map((chapter, ci) => {
    const proposal: LessonAuthorProposal = { summary: '', chapters: [{ title: chapter.title, lessons: chapter.lessons.map((lesson, li) => ({ title: lesson.title,
      units: lesson.units.map((unit, ui) => ({ title: unit.title, source_fact_ids: unit.source_fact_ids, components: unit.component_plan.map((_p, pi) => {
        const node = byPath.get(`chapter_${ci + 1}.lesson_${li + 1}.unit_${ui + 1}.component_${pi + 1}`)!;
        return hydrateWorkspaceComponent(node.protected_contract, node.baseline!.content, allowed);
      }) })) })) }] };
    return { chapter_path: `chapter_${ci + 1}`, proposal, content_hash: hash(proposal) };
  });
  const input: WorkspaceApplyCompileInput = { workspace_id: uuid(9000), course_node_id: ids.get('course')!, content_locale: 'en', event_head: 12,
    source_snapshot_hash: hash('source'), runtime_config_hash: hash('runtime'), blueprint, blueprint_hash: hash(blueprint), nodes, accepted_baselines, allowed,
    targets: { course_root_id: uuid(9001), course_root_hash: hash('course'), mappings: [] },
    request: { scope_node_id: ids.get(scope)!, expected_workspace_revision: 12, expected_revision_manifest: [], expected_target_snapshot_hash: '' } };
  refresh(input); return input;
}
function node(input: WorkspaceApplyCompileInput, path: string) { return input.nodes.find(n => n.canonical_path === path)!; }
function edit(input: WorkspaceApplyCompileInput, path: string, mutate: (c: any) => void) {
  const n = node(input, path); mutate(n.current!.content); n.current_revision!++; n.current!.content_hash = hash(n.current!.content); refresh(input);
}
function mapTargets(input: WorkspaceApplyCompileInput) {
  const blockIds = new Map(input.nodes.map((n, i) => [n.node_id, uuid(1000 + i)]));
  input.targets.mappings = input.nodes.filter(n => n.kind !== 'media_brief').map(n => ({ node_id: n.node_id, target_block_id: blockIds.get(n.node_id)!,
    target_parent_id: n.kind === 'chapter' ? input.targets.course_root_id : blockIds.get(n.parent_id)!,
    target_block_type: n.kind === 'component' ? String(n.protected_contract.component_type) : { chapter: 'chapter', lesson: 'sequential', unit: 'vertical' }[n.kind as 'chapter' | 'lesson' | 'unit'],
    target_sort_order: n.sort_order + 3, applied_revision: n.current_revision!, applied_content_hash: n.current!.content_hash,
    target_hash: hash(n.node_id), actual_target_hash: hash(n.node_id), receipt_revision_manifest: structuredClone([...input.request.expected_revision_manifest]) }));
  refresh(input);
}
function failure(input: WorkspaceApplyCompileInput, code?: string, finding?: string) {
  assert.throws(() => compileWorkspaceApply(input), (e: unknown) => {
    assert.ok(e instanceof WorkspaceApplyCompileError);
    if (code) assert.equal(e.code, code);
    if (finding) assert.ok(e.findings.some(f => f.code === finding), JSON.stringify(e.findings));
    return true;
  });
}
const first = 'chapter_1.lesson_1.unit_1';
const second = 'chapter_1.lesson_1.unit_2';

test('EN/VI chapter acceptance derives real checks; no course writes or input mutation', () => {
  for (const locale of ['en', 'vi'] as const) {
    const input = fixture(workspaceInventoryFixture(2, locale)); input.content_locale = locale;
    const before = structuredClone(input), result = compileWorkspaceApply(input);
    assert.deepEqual(input, before); assert.equal(result.content_locale, locale);
    assert.equal(result.writes.length, 6); assert.ok(result.writes.every(w => w.node_id !== input.course_node_id));
    assert.equal(result.acceptance.checks.security, 'PASS'); assert.equal(result.semantic_fidelity, 'not_measured');
    assert.equal(result.revision_manifest.length, input.nodes.length);
    assert.ok(result.writes.every(w => w.mapped_target === null));
    assert.equal(result.writes.find(w => w.canonical_path === first)!.title, locale === 'vi' ? 'Bài 1' : 'Unit 1');
  }
});
test('deterministic ordering despite shuffled server rows, mappings, manifests and artifacts', () => {
  const input = fixture(); mapTargets(input); const result = compileWorkspaceApply(input);
  input.nodes = [...input.nodes].reverse(); input.accepted_baselines = [...input.accepted_baselines].reverse();
  input.targets.mappings.reverse(); input.targets.mappings.forEach(m => m.receipt_revision_manifest.reverse());
  input.request.expected_revision_manifest = [...input.request.expected_revision_manifest].reverse();
  assert.deepEqual(compileWorkspaceApply(input), result);
});
test('unit Apply writes exact ancestors and selected descendants only; full chapter still hashed', () => {
  const input = fixture(undefined, first), result = compileWorkspaceApply(input);
  assert.deepEqual(result.writes.map(w => w.canonical_path), ['chapter_1', 'chapter_1.lesson_1', first, `${first}.component_1`]);
  assert.ok(result.revision_manifest.some(r => r.node_id === node(input, second).node_id));
});
test('section Apply writes its chapter ancestor and complete selected subtree only', () => {
  const input = fixture(undefined, 'chapter_1.lesson_1'), result = compileWorkspaceApply(input);
  assert.deepEqual(result.writes.map(w => w.canonical_path), [
    'chapter_1', 'chapter_1.lesson_1', first, `${first}.component_1`, second, `${second}.component_1`,
  ]);
});
test('component Apply writes ancestors and only the selected component, never siblings', () => {
  const selected = `${second}.component_1`;
  const input = fixture(undefined, selected), result = compileWorkspaceApply(input);
  assert.deepEqual(result.writes.map(w => w.canonical_path), ['chapter_1', 'chapter_1.lesson_1', second, selected]);
  assert.ok(!result.writes.some(w => w.canonical_path === `${first}.component_1`));
});
test('unit Apply does not invent dependencies from canonical sibling order', () => {
  const input = fixture(undefined, second), result = compileWorkspaceApply(input);
  assert.deepEqual(result.required_applied_dependencies, []);
  assert.deepEqual(result.writes.map(w => w.canonical_path), ['chapter_1', 'chapter_1.lesson_1', second, `${second}.component_1`]);
});
test('effective metadata overlay, author-only notes and briefs do not enter learner payload', () => {
  const blueprint = workspaceInventoryFixture(1);
  blueprint.chapters[0].lessons[0].units[0].media_plan = { type: 'video', title: 'Brief', rationale: 'Author rationale', content_outline: 'AUTHOR_BRIEF_ONLY' };
  const input = fixture(blueprint);
  edit(input, 'chapter_1', c => { c.title = 'Updated chapter'; c.data.objective = 'Updated objective'; });
  edit(input, first, c => { c.purpose = 'AUTHOR_PURPOSE_ONLY'; c.implementation_notes = 'AUTHOR_NOTES_ONLY'; });
  edit(input, `${first}.component_1`, c => { c.title = 'Updated component'; c.implementation_notes = 'COMPONENT_NOTES_ONLY'; });
  const result = compileWorkspaceApply(input), unit = result.writes.find(w => w.canonical_path === first)!;
  assert.equal(result.writes[0].title, 'Updated chapter');
  assert.equal((result.writes[0].author_metadata.storyboard as any).objective, 'Updated objective');
  assert.equal(unit.author_metadata.implementation_notes, 'AUTHOR_NOTES_ONLY'); assert.equal(unit.author_metadata.media_briefs.length, 1);
  assert.ok(result.writes.every(w => w.block_type !== 'video'));
  const component = result.writes.find(w => w.canonical_path === `${first}.component_1`)!;
  assert.equal(component.component!.title, 'Updated component');
  assert.equal(JSON.stringify(component.component).includes('_ONLY'), false);
});
test('mapped targets remain ID-bound through renames; unit-to-chapter Apply reuses the same IDs', () => {
  const input = fixture(undefined, first); mapTargets(input);
  const unitResult = compileWorkspaceApply(input);
  edit(input, first, c => { c.title = 'Identical names do not redirect IDs'; });
  input.request.scope_node_id = node(input, 'chapter_1').node_id;
  const chapterResult = compileWorkspaceApply(input);
  for (const write of unitResult.writes) assert.equal(chapterResult.writes.find(w => w.node_id === write.node_id)!.mapped_target!.block_id, write.mapped_target!.block_id);
});
test('missing full chapter context or a pending sibling cannot be disguised as ready', () => {
  const input = fixture(undefined, first); node(input, second).content_state = 'planned'; failure(input, 'WORKSPACE_APPLY_CONTEXT_INCOMPLETE');
  const missing = fixture(undefined, first); missing.nodes = missing.nodes.filter(n => n.canonical_path !== `${second}.component_1`); refresh(missing); failure(missing, 'WORKSPACE_APPLY_CONTEXT_INCOMPLETE');
});
test('hashes, exact revision sets and event-head preconditions reject stale or fabricated input', () => {
  const cases: Array<[string, (i: WorkspaceApplyCompileInput) => void]> = [
    ['WORKSPACE_APPLY_HASH_INVALID', i => { i.blueprint.title = 'Changed'; }],
    ['WORKSPACE_APPLY_HASH_INVALID', i => { (node(i, first).current!.content as any).title = 'Unhashed'; }],
    ['WORKSPACE_APPLY_HASH_INVALID', i => { i.accepted_baselines[0].proposal.summary = 'Unhashed'; }],
    ['WORKSPACE_APPLY_REVISION_CONFLICT', i => { i.request.expected_workspace_revision--; }],
    ['WORKSPACE_APPLY_REVISION_CONFLICT', i => { i.request.expected_revision_manifest = i.request.expected_revision_manifest.slice(1); }],
    ['WORKSPACE_APPLY_REVISION_CONFLICT', i => { i.request.expected_revision_manifest = [...i.request.expected_revision_manifest, i.request.expected_revision_manifest[0]]; }],
  ];
  for (const [code, mutate] of cases) { const input = fixture(); mutate(input); failure(input, code); }
});
test('bindings, parent IDs, order and baseline origin cannot be rewritten', () => {
  for (const mutate of [(n: WorkspaceApplyNode) => { n.parent_id = uuid(5555); }, (n: WorkspaceApplyNode) => { n.sort_order++; },
    (n: WorkspaceApplyNode) => { n.protected_contract.component_type = 'problem'; n.contract_hash = hash(n.protected_contract); },
    (n: WorkspaceApplyNode) => { (n.baseline!.content as any).title = 'Wrong origin'; n.baseline!.content_hash = hash(n.baseline!.content); }]) {
    const input = fixture(); mutate(node(input, `${first}.component_1`)); failure(input, 'WORKSPACE_APPLY_BINDING_INVALID');
  }
});
test('changed target fingerprints, parents, block types and inconsistent sibling offsets fail', () => {
  for (const mutate of [(m: any) => { m.actual_target_hash = hash('external change'); }, (m: any) => { m.target_parent_id = uuid(3333); },
    (m: any) => { m.target_block_type = 'problem'; }, (m: any) => { m.target_sort_order++; }]) {
    const input = fixture(); mapTargets(input); mutate(input.targets.mappings.find(m => m.node_id === node(input, second).node_id)!); refresh(input);
    failure(input, 'WORKSPACE_APPLY_TARGET_CHANGED');
  }
});
test('baseline coverage and effective pedagogy are validated rather than accepted from caller PASS', () => {
  const input = fixture();
  input.accepted_baselines[0].proposal.chapters[0].lessons[0].units[0].components![0].metadata!.covered_source_fact_ids = [];
  input.accepted_baselines[0].content_hash = hash(input.accepted_baselines[0].proposal);
  (input as any).checks = { coverage: 'PASS' }; failure(input, 'WORKSPACE_APPLY_VALIDATION_FAILED');
  const shallow = fixture(); edit(shallow, `${first}.component_1`, c => { c.data = '<p>A short sentence.</p>'; });
  failure(shallow, 'WORKSPACE_APPLY_VALIDATION_FAILED', 'INSUFFICIENT_INSTRUCTIONAL_DEPTH');
});
test('duplicate comparison cannot silently stop after 96 pairs', () => {
  const input = fixture(workspaceInventoryFixture(15));
  edit(input, 'chapter_1.lesson_1.unit_15.component_1', c => { c.data = html(14); });
  failure(input, 'WORKSPACE_APPLY_VALIDATION_FAILED', 'DUPLICATE_EXPLANATION');
});
test('unsafe HTML, immutable objective slots and missing tenant capabilities fail closed', () => {
  const unsafe = fixture(); edit(unsafe, `${first}.component_1`, c => { c.data = '<script>SECRET</script>'; }); failure(unsafe);
  const slots = fixture(); edit(slots, 'chapter_1.lesson_1', c => { c.data.learning_objectives.push('New objective'); }); failure(slots);
  const capability = fixture(); capability.allowed = new Set(['problem']); failure(capability);
});
function allTypesBlueprint() {
  const blueprint = workspaceInventoryFixture(1), unit = blueprint.chapters[0].lessons[0].units[0];
  unit.supporting_evidence_fact_ids = ['fact_1'];
  const reasons = { la_sortable: 'ORDERING_PRACTICE', la_crossword: 'TERMINOLOGY_REINFORCEMENT', la_diagram: 'RELATIONSHIP_VISUALIZATION', la_faq: 'FAQ_ANTICIPATED_QUESTIONS' };
  for (const type of ['problem', 'la_sortable', 'la_crossword', 'la_diagram', 'la_faq'] as const) unit.component_plan.push({ type,
    component_plan_id: `plan_${type}`, title: `Teaching ${type}`, rationale: 'Grounded practice', source_fact_ids: [], supporting_evidence_fact_ids: ['fact_1'],
    learning_objective_refs: ['lo_1'], learning_block_ids: ['block_1'], ...(type === 'problem' ? {} : { reason_code: reasons[type] as any }) });
  return blueprint;
}
test('all six typed payloads compile into actual learner component contracts', () => {
  const input = fixture(allTypesBlueprint()), result = compileWorkspaceApply(input);
  assert.deepEqual(result.writes.filter(w => w.component).map(w => w.component!.type), [...allowed]);
  const problem = result.writes.find(w => w.component?.type === 'problem')!.component!;
  assert.equal(problem.data, encodeWorkspaceProblem(typedData('problem', 0) as any));
  for (const write of result.writes.filter(w => w.component)) assert.deepEqual(workspaceComponentContent(write.component!, allowed).data, (node(input, write.canonical_path).current!.content as any).data);
});
test('six typed validators reject corrupted payloads without leaking source content', () => {
  const mutations: Record<string, (c: any) => void> = {
    html: c => { c.data = '<img src=x onerror=SECRET>'; }, problem: c => { c.data.choices[0].correct = false; },
    la_sortable: c => { c.data.items[0].id = c.data.items[1].id; }, la_crossword: c => { c.data.words[0].row = 99; },
    la_diagram: c => { c.data.diagrams[0].edges[0].target = 'SECRET'; }, la_faq: c => { c.data.items[0].question = ''; },
  };
  for (const [type, mutate] of Object.entries(mutations)) {
    const input = fixture(allTypesBlueprint()), n = input.nodes.find(n => n.protected_contract.component_type === type)!;
    edit(input, n.canonical_path, mutate); failure(input);
  }
});

function twoChapters(): LessonAuthorBlueprint {
  const b = workspaceInventoryFixture(2), c = b.chapters[0], secondUnit = c.lessons[0].units.pop()!;
  b.chapters.push({ ...structuredClone(c), title: 'Chapter 2', lessons: [{ ...structuredClone(c.lessons[0]), units: [secondUnit] }] });
  b.source_fact_allocation!.allocations[1].unit_path = 'chapter_2.lesson_1.unit_1';
  b.source_evidence_scope_allocation!.allocations[1].unit_path = 'chapter_2.lesson_1.unit_1';
  return b;
}
test('later independent chapter can Apply first and writes never expand to earlier chapter', () => {
  const input = fixture(twoChapters(), 'chapter_2'); const output = compileWorkspaceApply(input);
  assert.ok(output.writes.every(w => w.canonical_path.startsWith('chapter_2')));
  assert.deepEqual(output.required_applied_dependencies, []);
});

test('out-of-order sibling Apply reuses one established parent offset', () => {
  const parent = uuid(9900);
  const offsets = workspaceApplyEstablishedParentOffsets([
    { parent_node_id: parent, node_sort_order: 0, target_sort_order: 0 },
    { parent_node_id: parent, node_sort_order: 2, target_sort_order: 2 },
    { parent_node_id: parent, node_sort_order: 4, target_sort_order: 4 },
    { parent_node_id: parent, node_sort_order: 5, target_sort_order: 5 },
  ]);
  assert.equal(offsets.get(parent), 0);
  assert.equal(1 + offsets.get(parent)!, 1, 'chapter 2 fills its canonical gap instead of appending after chapter 6');
  assert.throws(() => workspaceApplyEstablishedParentOffsets([
    { parent_node_id: parent, node_sort_order: 0, target_sort_order: 0 },
    { parent_node_id: parent, node_sort_order: 2, target_sort_order: 7 },
  ]), { code: 'WORKSPACE_APPLY_TARGET_CHANGED' });
});
test('out-of-scope later chapter nodes are not required or written', () => {
  const input = fixture(twoChapters());
  input.nodes = input.nodes.filter(n => n.canonical_path.startsWith('chapter_1'));
  input.accepted_baselines = input.accepted_baselines.slice(0, 1); refresh(input);
  assert.ok(compileWorkspaceApply(input).writes.every(w => w.canonical_path.startsWith('chapter_1')));
});
test('explicit concept prerequisites cannot be invented or fulfilled by a later unit', () => {
  const blueprint = workspaceInventoryFixture(1);
  blueprint.source_map!.concepts[0].prerequisite_concept_ids = ['missing_concept'];
  failure(fixture(blueprint), 'WORKSPACE_APPLY_DEPENDENCY_REQUIRED');
});
test('cross-chapter duplicate explanations are rejected', () => {
  const input = fixture(twoChapters(), 'chapter_2'); mapTargets(input);
  edit(input, 'chapter_2.lesson_1.unit_1.component_1', c => { c.data = html(1); });
  failure(input, 'WORKSPACE_APPLY_VALIDATION_FAILED', 'DUPLICATE_EXPLANATION');
});
test('course/media scopes stay rejected and receipt hashes bind the exact target snapshot', () => {
  const invalid = fixture(); invalid.request.scope_node_id = invalid.course_node_id; failure(invalid, 'WORKSPACE_APPLY_SCOPE_INVALID');
  const stale = fixture(); stale.request.expected_target_snapshot_hash = hash('different snapshot'); failure(stale, 'WORKSPACE_APPLY_TARGET_CHANGED');
  const corrupt = fixture(); mapTargets(corrupt);
  corrupt.targets.mappings[0].receipt_revision_manifest[0].content_hash = hash('forged receipt'); refresh(corrupt);
  failure(corrupt, 'WORKSPACE_APPLY_TARGET_CHANGED');
});
test('exact current mappings are reused while stale revision, content or target evidence is materialized again', () => {
  const input = fixture(); mapTargets(input);
  const result = compileWorkspaceApply(input), write = result.writes[0]!;
  const mapping = input.targets.mappings.find(candidate => candidate.node_id === write.node_id)!;
  assert.equal(workspaceApplyWriteAlreadyMaterialized(write, mapping), true);
  assert.equal(workspaceApplyWriteAlreadyMaterialized(write, { ...mapping, applied_content_hash: hash('changed') }), false);
  assert.equal(workspaceApplyWriteAlreadyMaterialized(write, { ...mapping, actual_target_hash: hash('drifted') }), false);
  assert.equal(workspaceApplyWriteAlreadyMaterialized({ ...write, revision: write.revision + 1 }, mapping), false);
  assert.equal(workspaceApplyWriteAlreadyMaterialized(write, undefined), false);
});
test('materialization plan skips exact ancestors and writes only the selected missing component', () => {
  const path = `${first}.component_1`, input = fixture(workspaceInventoryFixture(2), path); mapTargets(input);
  const selected = node(input, path);
  input.targets.mappings = input.targets.mappings.filter(mapping => mapping.node_id !== selected.node_id); refresh(input);
  const result = compileWorkspaceApply(input);
  const plan = workspaceApplyMaterializationPlan(result.writes, input.targets.mappings, selected.node_id);
  assert.deepEqual(plan.writes.map(write => write.node_id), [selected.node_id]);
  assert.equal(plan.noopAnchor, null);

  mapTargets(input); const current = compileWorkspaceApply(input);
  const replay = workspaceApplyMaterializationPlan(current.writes, input.targets.mappings, selected.node_id);
  assert.deepEqual(replay.writes, []);
  assert.equal(replay.noopAnchor?.node_id, selected.node_id);
});
test('revision zero must be immutable and accepted objective provenance cannot be hydrated away', () => {
  const baseline = fixture();
  const n = node(baseline, `${first}.component_1`); (n.current!.content as any).title = 'Impossible revision zero'; n.current!.content_hash = hash(n.current!.content); refresh(baseline);
  failure(baseline, 'WORKSPACE_APPLY_BINDING_INVALID');
  const provenance = fixture(); provenance.accepted_baselines[0].proposal.chapters[0].lessons[0].units[0].components![0].metadata!.learning_objective_refs = ['forged'];
  provenance.accepted_baselines[0].content_hash = hash(provenance.accepted_baselines[0].proposal);
  failure(provenance, 'WORKSPACE_APPLY_BINDING_INVALID');
});
test('explicit concept dependencies require the owning unit receipt including its media brief', () => {
  const blueprint = workspaceInventoryFixture(2);
  blueprint.chapters[0].lessons[0].units[0].media_plan = { type: 'video', title: 'Brief', rationale: 'Author only', content_outline: 'Review steps' };
  const prerequisite = blueprint.source_map!.concepts[0].id;
  blueprint.source_map!.concepts.push({ ...structuredClone(blueprint.source_map!.concepts[0]), id: 'concept_2', name: 'Dependent concept',
    source_fact_ids: ['fact_2'], prerequisite_concept_ids: [prerequisite] });
  blueprint.chapters[0].lessons[0].units[0].primary_concept_ids = [prerequisite];
  blueprint.chapters[0].lessons[0].units[1].concept_ids = ['concept_2'];
  blueprint.chapters[0].lessons[0].units[1].primary_concept_ids = ['concept_2'];
  blueprint.chapters[0].lessons[0].units[1].learning_blocks![0].concept_ids = ['concept_2'];
  const missing = fixture(blueprint, second);
  failure(missing, 'WORKSPACE_APPLY_DEPENDENCY_REQUIRED');
  const input = fixture(blueprint, second); mapTargets(input); compileWorkspaceApply(input);
  const brief = node(input, `${first}.media_1`), owner = input.targets.mappings.find(m => m.node_id === brief.parent_id)!;
  owner.receipt_revision_manifest = owner.receipt_revision_manifest.filter(r => r.node_id !== brief.node_id); refresh(input);
  failure(input, 'WORKSPACE_APPLY_DEPENDENCY_REQUIRED');
});
