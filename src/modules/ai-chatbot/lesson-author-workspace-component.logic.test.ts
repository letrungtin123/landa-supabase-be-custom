import assert from 'node:assert/strict';
import test from 'node:test';
import { editWorkspaceComponent, workspaceComponentContent, validateWorkspaceComponentChapter, workspaceComponentStorage, hydrateWorkspaceComponent, validateWorkspaceReadyComponentChapter, workspaceComponentPlanBinding } from './lesson-author-workspace-component.logic.js';
import { decodeWorkspaceProblem, encodeWorkspaceProblem } from './lesson-author-workspace-problem.logic.js';
import { prepareWorkspaceEdit, prepareWorkspaceReset } from './lesson-author-workspace.logic.js';
import type { LessonAuthorComponentProposal, LessonAuthorProposal } from '../course-authoring/course-authoring.service.js';
import type { CourseComponentType } from '../tenants/tenant-course-components.constants.js';
import { validateLessonAuthorPedagogicalQuality, type LessonAuthorPedagogicalBlueprintChapter } from './lesson-author-pedagogical-validator.logic.js';

const allowed = new Set<CourseComponentType>(['html', 'problem', 'la_faq', 'la_sortable', 'la_crossword', 'la_diagram']);
const code = (wanted: string) => (e: unknown) => e instanceof Error && e.message === wanted;
const metadata = { component_plan_id: 'component_1', source_fact_ids: ['fact_1'], covered_source_fact_ids: ['fact_1'],
  supporting_evidence_fact_ids: [], learning_objective_refs: ['lo_1'], generated_by: 'lesson_author_ai' };
function wrapped(type: LessonAuthorComponentProposal['type'], key: string, value: unknown, extra = {}): LessonAuthorComponentProposal {
  return { type, title: 'Synthetic', data: { [key]: JSON.stringify(value), ...extra }, metadata: { ...structuredClone(metadata), [key]: value, ...extra } };
}
function fixtures(): LessonAuthorComponentProposal[] {
  return [
    { type: 'html', title: 'Explain', data: '<p>Read the supplied procedure before using the equipment. Check each item in its stated order.</p>', metadata: structuredClone(metadata) },
    { type: 'problem', title: 'Check', data: encodeWorkspaceProblem({ kind: 'multiple_choice', question: 'Which step comes first?', explanation: 'Read first.', hints: [], choices: [{ text: 'Read', correct: true }, { text: 'Skip', correct: false }] }), metadata: structuredClone(metadata) },
    wrapped('la_faq', 'faq_data', { items: [{ id: 1, question: 'Why read?', answer: 'To understand the steps.' }, { id: 2, question: 'Why check?', answer: 'To detect missing items.' }] }),
    wrapped('la_sortable', 'sortable_data', { items: [{ id: 1, text: 'Read' }, { id: 2, text: 'Check' }, { id: 3, text: 'Act' }] }, { question_text: 'Order the steps.' }),
    wrapped('la_crossword', 'crossword_data', { words: ['READ', 'CHECK', 'ACT'].map((answer, row) => ({ id: row + 1, answer, clue: `Term ${row + 1}`, hint: '', row, col: 0, direction: 'across' })), keyword_coordinates: [{ row: 0, col: 0 }] }),
    wrapped('la_diagram', 'diagram_data', { start_diagram_id: 'main', diagrams: [{ id: 'main', name: 'Process', nodes: [
      { id: 'a', type: 'customShape', position: { x: 0, y: 0 }, data: { label: 'Read' } },
      { id: 'b', type: 'customShape', position: { x: 200, y: 0 }, data: { label: 'Check' } },
    ], edges: [{ id: 'ab', source: 'a', target: 'b', label: 'then' }] }] }),
  ];
}
test('all six payloads roundtrip without losing bytes, metadata, IDs or author-only notes', () => {
  for (const original of fixtures()) {
    const before = structuredClone(original);
    const content = workspaceComponentContent(original, allowed, { purpose: 'Purpose', implementation_notes: 'Author only' });
    assert.deepEqual(editWorkspaceComponent(original, content, allowed), original);
    assert.deepEqual(original, before);
    assert.equal(JSON.stringify(content).includes('fact_1'), false);
    const renamed = editWorkspaceComponent(original, { ...content, title: 'Edited' }, allowed);
    assert.deepEqual(renamed.data, original.data); assert.deepEqual(renamed.metadata, original.metadata);
    assert.equal(JSON.stringify(renamed).includes('Author only'), false);
  }
});
test('FAQ and sortable edits keep metadata/data mirrors synchronized and provenance unchanged', () => {
  for (const original of fixtures().filter(c => ['la_faq', 'la_sortable'].includes(c.type))) {
    const content = workspaceComponentContent(original, allowed);
    const data = content.data as any;
    if (original.type === 'la_faq') data.items[0].answer = 'Câu trả lời đã chỉnh / Updated answer';
    else { data.items[0].text = 'Đọc / Read'; data.question_text = 'Sắp xếp / Order'; }
    const output = editWorkspaceComponent(original, content, allowed), key = original.type === 'la_faq' ? 'faq_data' : 'sortable_data';
    assert.deepEqual(JSON.parse((output.data as any)[key]), output.metadata![key]);
    assert.deepEqual(output.metadata!.source_fact_ids, metadata.source_fact_ids);
    assert.deepEqual(output.metadata!.learning_objective_refs, metadata.learning_objective_refs);
    assert.deepEqual(output.metadata!.covered_source_fact_ids, metadata.covered_source_fact_ids);
  }
});
test('conflicting mirrors are rejected instead of preferring stale metadata', () => {
  const original = fixtures()[2]; (original.metadata!.faq_data as any).items[0].answer = 'Different';
  assert.throws(() => workspaceComponentContent(original, allowed), code('WORKSPACE_COMPONENT_MIRROR_CONFLICT'));
});
test('canonical FAQ structure can be edited while component binding and provenance remain protected', () => {
  const original = fixtures()[2];
  for (const mutate of [(d: any) => d.items.reverse(), (d: any) => d.items.push({ id: 3, question: 'New', answer: 'New' }), (d: any) => d.items[0].id = 100]) {
    const content = workspaceComponentContent(original, allowed); mutate(content.data);
    const edited = editWorkspaceComponent(original, content, allowed);
    assert.deepEqual(JSON.parse((edited.data as any).faq_data), content.data);
  }
  for (const field of ['source_fact_ids', 'learning_objective_refs', 'component_plan_id', 'type']) {
    const content = workspaceComponentContent(original, allowed); (content.data as any)[field] = ['fake'];
    assert.throws(() => editWorkspaceComponent(original, content, allowed));
  }
  assert.throws(() => workspaceComponentContent(original, new Set(['html'])), code('WORKSPACE_COMPONENT_CAPABILITY_DENIED'));
});
test('diagram invalid edge, duplicate edge, start reference fail before normalization can drop or rewrite', () => {
  for (const mutate of [(d: any) => d.diagrams[0].edges[0].target = 'missing',
    (d: any) => d.diagrams[0].edges.push({ ...d.diagrams[0].edges[0] }),
    (d: any) => d.start_diagram_id = 'unknown']) {
    const original = fixtures()[5], content = workspaceComponentContent(original, allowed); mutate(content.data);
    assert.throws(() => editWorkspaceComponent(original, content, allowed), code('WORKSPACE_COMPONENT_REFERENCE_INVALID'));
  }
});
test('diagram canonical editor changes persist while invalid references still fail closed', () => {
  const original = fixtures()[5], content = workspaceComponentContent(original, allowed), d = content.data as any;
  d.diagrams[0].name = 'Quy trình'; d.diagrams[0].nodes[0].data.label = 'Đọc trước'; d.diagrams[0].edges[0].label = 'Tiếp theo';
  const output = editWorkspaceComponent(original, content, allowed);
  assert.equal((output.metadata!.diagram_data as any).diagrams[0].nodes[0].data.label, 'Đọc trước');
  d.diagrams[0].edges[0].source = 'b'; d.diagrams[0].edges[0].target = 'a';
  const rewired = editWorkspaceComponent(original, content, allowed);
  assert.equal((rewired.metadata!.diagram_data as any).diagrams[0].edges[0].source, 'b');
});
test('diagram workspace projects generated React Flow fields into the canonical Course Outline contract', () => {
  const original = fixtures()[5];
  const wire = (original.metadata!.diagram_data as any);
  wire.diagrams[0].nodes[0].data.target_diagram_id = '';
  wire.diagrams[0].edges[0] = { ...wire.diagrams[0].edges[0], type: 'deletable',
    style: { stroke: '#64748B', strokeWidth: 2 }, markerEnd: { type: 'arrowclosed', color: '#64748B' },
    data: { routing: 'orthogonal', feedbackSide: 'right' } };
  (original.data as any).diagram_data = JSON.stringify(wire);
  const content = workspaceComponentContent(original, allowed), projected = content.data as any;
  assert.equal(projected.diagrams[0].nodes[0].data.target_diagram_id, undefined);
  assert.equal(projected.diagrams[0].edges[0].style, undefined);
  assert.equal(projected.diagrams[0].edges[0].data.feedbackSide, undefined);
  assert.equal(projected.diagrams[0].edges[0].data.routing, 'orthogonal');
  assert.deepEqual(editWorkspaceComponent(original, content, allowed), original, 'an unchanged projected draft keeps original CMS bytes');
});
test('crossword answer/clue edits preserve grid; invalid keyword, overlap and down direction fail', () => {
  const original = fixtures()[4], content = workspaceComponentContent(original, allowed), d = content.data as any;
  d.words[0].answer = 'LEARN'; d.words[0].clue = 'Học';
  assert.equal((editWorkspaceComponent(original, content, allowed).metadata!.crossword_data as any).words[0].answer, 'LEARN');
  for (const mutate of [(v: any) => v.keyword_coordinates[0].col = 50,
    (v: any) => v.words[1].row = 0, (v: any) => v.words[0].direction = 'down', (v: any) => v.words[0].answer = 'CÓ DẤU']) {
    const c = workspaceComponentContent(original, allowed); mutate(c.data);
    assert.throws(() => editWorkspaceComponent(original, c, allowed));
  }
});
test('HTML author edits use the same canonical sanitizer as Course Outline', () => {
  const original = fixtures()[0];
  const data = '<h1>Heading</h1><p class="lesson-copy"><em>Italic</em> <a href="https://example.com">Link</a></p>'
    + '<table class="landa-rich-table" style="width: 640px"><tbody><tr data-landa-row-height="48" style="height: 48px">'
    + '<th data-landa-cell-bg="#DBEAFE" style="background-color: #DBEAFE">A</th><td>B</td></tr></tbody></table>'
    + '<script>alert(1)</script><p onclick="alert(1)">Safe text</p><a href="javascript:alert(1)">Unsafe URL</a>';
  const edited = editWorkspaceComponent(original, { ...workspaceComponentContent(original, allowed), data }, allowed);
  assert.match(String(edited.data), /<h1>Heading<\/h1>/);
  assert.match(String(edited.data), /class="landa-rich-table"/);
  assert.match(String(edited.data), /data-landa-row-height="48"/);
  assert.match(String(edited.data), /<em>Italic<\/em>/);
  assert.doesNotMatch(String(edited.data), /script|onclick|javascript:/i);
});

test('Course Outline-shaped author edits save for every supported component without re-running the AI generation gate', () => {
  for (const original of fixtures()) {
    const content = workspaceComponentContent(original, allowed);
    const data = content.data as any;
    if (original.type === 'html') content.data = '<h1>Edited</h1><p><em>Course Outline content</em></p>';
    if (original.type === 'problem') {
      data.question = '<p><strong>Edited question</strong></p>';
      data.explanation = '<p><em>Edited explanation</em></p>';
    }
    if (original.type === 'la_faq') data.items[0].answer = 'Edited answer';
    if (original.type === 'la_sortable') { data.question_text = 'Edited order'; data.items.reverse(); }
    if (original.type === 'la_crossword') data.words[0].clue = 'Edited clue';
    if (original.type === 'la_diagram') data.diagrams[0].nodes[0].data.label = 'Edited node';
    const edited = editWorkspaceComponent(original, content, allowed);
    assert.equal(edited.title, original.title);
  }
});
test('interactive text cannot smuggle executable markup through JSON', () => {
  for (const [index, mutate] of [
    [2, (d: any) => d.items[0].answer = '<img src=x onerror=alert(1)>'],
    [3, (d: any) => d.question_text = '<script>private</script>'],
    [4, (d: any) => d.words[0].hint = '<iframe src=x>'],
    [5, (d: any) => d.diagrams[0].nodes[0].data.label = '<svg onload=alert(1)>'],
  ] as const) {
    const original = fixtures()[index], content = workspaceComponentContent(original, allowed); mutate(content.data);
    assert.throws(() => editWorkspaceComponent(original, content, allowed), code('WORKSPACE_COMPONENT_PAYLOAD_INVALID'));
  }
});
test('crossword bounds follow actual preview: contiguous rows, col <=20 and no hidden cells past30', () => {
  for (const mutate of [(d: any) => d.words[1].row = 8, (d: any) => d.words[0].col = 21,
    (d: any) => { d.words[0].col = 20; d.words[0].answer = 'ABCDEFGHIJK'; }]) {
    const original = fixtures()[4], content = workspaceComponentContent(original, allowed); mutate(content.data);
    assert.throws(() => editWorkspaceComponent(original, content, allowed));
  }
});
test('EN/VI Save and Reset roundtrip retains the exact baseline payload with no Apply', () => {
  for (const title of ['Câu hỏi thường gặp', 'Frequently asked questions']) {
    const original = fixtures()[2]; original.title = title;
    const baseline = workspaceComponentContent(original, allowed);
    const node = { node_id: 'synthetic', kind: 'component' as const, content_state: 'content_ready' as const, current_revision: 0, baseline, current: baseline };
    const edit = prepareWorkspaceEdit(node, { expected_revision: 0, changes: { title: `${title}!` } });
    assert.equal(editWorkspaceComponent(original, edit.content, allowed).title, `${title}!`);
    const reset = prepareWorkspaceReset({ ...node, current_revision: 1, current: edit.content }, 1);
    assert.deepEqual(editWorkspaceComponent(original, reset.content, allowed), original);
    assert.equal(reset.validation_state, 'pending');
  }
});
function chapterFixture() {
  const components = [fixtures()[0], fixtures()[1]];
  components[1].metadata = { ...metadata, component_plan_id: 'component_2', source_fact_ids: [], covered_source_fact_ids: [], supporting_evidence_fact_ids: ['fact_1'] };
  const unit = { title: 'Unit', source_fact_ids: ['fact_1'], supporting_evidence_fact_ids: ['fact_1'], learning_objective_refs: ['lo_1'],
    component_plan: components.map(c => ({ type: c.type, component_plan_id: c.metadata!.component_plan_id as string,
      source_fact_ids: c.metadata!.source_fact_ids as string[], supporting_evidence_fact_ids: c.metadata!.supporting_evidence_fact_ids as string[] })) };
  const blueprint: LessonAuthorPedagogicalBlueprintChapter = { lessons: [{ title: 'Lesson', units: [unit] }] };
  const proposal: LessonAuthorProposal = { summary: 'Synthetic', chapters: [{ title: 'Chapter', lessons: [{ title: 'Lesson', units: [{ title: 'Unit', components }] }] }] };
  return { proposal, blueprint, allowed };
}
test('full ready chapter uses real coverage/pedagogical gates without claiming semantic fidelity', () => {
  const f = chapterFixture(), result = validateWorkspaceComponentChapter(f);
  assert.equal(result.status, 'PASS'); assert.equal(result.semantic_fidelity, 'not_measured');
  f.proposal.chapters[0].lessons[0].units[0].components![0].metadata!.covered_source_fact_ids = [];
  assert.ok(validateWorkspaceComponentChapter(f).findings.some(v => v.code === 'WORKSPACE_COMPONENT_COVERAGE_INVALID'));
});
test('pending/missing scope is not treated as a passing empty chapter', () => {
  const f = chapterFixture(); f.proposal.chapters[0].lessons[0].units = [];
  assert.throws(() => validateWorkspaceComponentChapter(f), code('WORKSPACE_COMPONENT_SCOPE_INCOMPLETE'));
});
test('existing teaching/assessment alignment and required HTML artifacts remain blocking', () => {
  const f = chapterFixture(), lesson = f.blueprint.lessons[0];
  lesson.learning_objectives = ['Identify the first step.']; lesson.assessment_required = true;
  lesson.assessment_objective_refs = ['lo_1'];
  for (const p of lesson.units[0].component_plan!) p.learning_objective_refs = ['lo_1'];
  assert.equal(validateWorkspaceComponentChapter(f).status, 'PASS');
  lesson.units[0].component_plan![0].required_artifacts = [{ type: 'table', minimum_items: 2 }];
  assert.ok(validateWorkspaceComponentChapter(f).findings.some(x => x.code === 'WORKSPACE_COMPONENT_COVERAGE_INVALID'));
  f.proposal.chapters[0].lessons[0].units[0].components![0].data = '<p>Too short.</p>';
  const codes = validateWorkspaceComponentChapter(f).findings.map(x => x.code);
  assert.ok(codes.includes('OBJECTIVE_NOT_TAUGHT')); assert.ok(codes.includes('ASSESSMENT_NOT_ALIGNED'));
});
test('FAQ-last ordering is a validation finding, not automatic reordering', () => {
  const f = chapterFixture(), faqComponent = fixtures()[2];
  f.proposal.chapters[0].lessons[0].units[0].components!.unshift(faqComponent);
  assert.ok(validateWorkspaceComponentChapter(f).findings.some(v => v.code === 'WORKSPACE_FAQ_NOT_LAST'));
  assert.equal(f.proposal.chapters[0].lessons[0].units[0].components![0].type, 'la_faq');
});
test('all five Problem subtypes preserve question/answer/feedback in VI and EN', () => {
  for (const question of ['Câu hỏi < & >?', 'Question < & >?']) {
    const common = { question, explanation: 'Giải thích & feedback <not markup>', hints: ['Gợi ý & hint'] };
    for (const problem of [
      ...(['multiple_choice', 'multiple_select', 'dropdown'] as const).map(kind => ({ ...common, kind, choices: [{ text: 'Đúng', correct: true }, { text: 'Sai', correct: false }] })),
      { ...common, kind: 'short_text', answers: ['Có', 'Yes'], case_sensitive: false },
      { ...common, kind: 'numerical', answers: ['12', '12.0'], tolerance: '0.1%' },
    ]) assert.deepEqual(decodeWorkspaceProblem(encodeWorkspaceProblem(problem)), problem);
  }
});
test('Problem hints roundtrip and legacy XML without demandhint defaults to an empty list', () => {
  const legacy = '<problem><multiplechoiceresponse><label>Check?</label><choicegroup type="MultipleChoice"><choice correct="true">Yes</choice><choice correct="false">No</choice></choicegroup></multiplechoiceresponse></problem>';
  assert.deepEqual(decodeWorkspaceProblem(legacy).hints, []);
  const input = { kind: 'multiple_choice' as const, question: 'Check?', explanation: '', hints: ['Read the first step.', 'Compare the requirement & exception.'],
    choices: [{ text: 'Yes', correct: true }, { text: 'No', correct: false }] };
  const encoded = encodeWorkspaceProblem(input);
  assert.match(encoded, /<demandhint><hint>Read the first step\.<\/hint>/);
  assert.deepEqual(decodeWorkspaceProblem(encoded), input);
});
test('Problem malformed XML, external entities, unsupported tags and invalid answers fail closed', () => {
  const xml = fixtures()[1].data as string;
  for (const value of [xml.replace('</choicegroup>', ''), xml + '<script>x</script>', xml.replace('Read', '&xxe;'),
    '<!DOCTYPE problem SYSTEM "file:///secret">' + xml, xml.replace('<label>', '<label onclick="x">')]) {
    assert.throws(() => decodeWorkspaceProblem(value));
  }
  const p = decodeWorkspaceProblem(xml) as any;
  p.choices[0].correct = false; assert.throws(() => encodeWorkspaceProblem(p));
  p.choices[0].correct = true; p.choices[1].text = p.choices[0].text; assert.throws(() => encodeWorkspaceProblem(p));
  for (const character of ['\u0000', '\ud800', '\udfff']) {
    const unsafe = decodeWorkspaceProblem(xml); unsafe.question += character;
    assert.throws(() => encodeWorkspaceProblem(unsafe));
  }
});
test('Problem supported builder whitespace and empty feedback roundtrip without rewriting unchanged bytes', () => {
  const original = fixtures()[1];
  original.data = (original.data as string).replace(/<solution>[\s\S]*<\/solution>/, '').replace(/></g, '>\n  <');
  const content = workspaceComponentContent(original, allowed);
  assert.equal((content.data as any).explanation, '');
  assert.deepEqual(editWorkspaceComponent(original, content, allowed), original);
  const p = content.data as any; p.question = '  Preserve author whitespace  ';
  const changed = editWorkspaceComponent(original, content, allowed);
  assert.equal(decodeWorkspaceProblem(changed.data).question, p.question);
});

test('persisted typed baseline rehydrates six components without duplicate payload mirrors', () => {
  for (const original of fixtures()) {
    const stored = workspaceComponentStorage(original, allowed);
    const hydrated = hydrateWorkspaceComponent(stored.binding, stored.content, allowed);
    assert.deepEqual(workspaceComponentContent(hydrated, allowed), stored.content);
    for (const key of ['faq_data', 'sortable_data', 'crossword_data', 'diagram_data', 'question_text']) assert.equal(key in stored.binding.metadata, false);
    assert.deepEqual(hydrated.metadata!.source_fact_ids, original.metadata!.source_fact_ids);
    assert.deepEqual(hydrated.metadata!.covered_source_fact_ids, original.metadata!.covered_source_fact_ids);
    assert.deepEqual(hydrated.metadata!.supporting_evidence_fact_ids, original.metadata!.supporting_evidence_fact_ids);
  }
});
test('stored binding requires identity and rejects unknown payload shells, prototype keys and mirrors', () => {
  const stored = workspaceComponentStorage(fixtures()[0], allowed);
  for (const binding of [{ ...stored.binding, binding_version: 2 }, { ...stored.binding, body: 'hidden' },
    { ...stored.binding, metadata: {} }, { ...stored.binding, metadata: { ...stored.binding.metadata, faq_data: {} } },
    { ...stored.binding, metadata: JSON.parse('{"component_plan_id":"component_1","__proto__":{}}') }]) {
    assert.throws(() => hydrateWorkspaceComponent(binding, stored.content, allowed));
  }
  const interactive = fixtures()[2]; (interactive.data as any).hidden_payload = 'not silently dropped';
  assert.throws(() => workspaceComponentStorage(interactive, allowed));
  assert.throws(() => hydrateWorkspaceComponent(stored.binding, stored.content, new Set(['problem'])), code('WORKSPACE_COMPONENT_CAPABILITY_DENIED'));
});
test('ready Save scope passes while a later unit is pending, with explicit deferred checks', () => {
  const f = chapterFixture();
  const pending = structuredClone(f.blueprint.lessons[0].units[0]);
  f.blueprint.lessons[0].units.push(pending);
  f.proposal.chapters[0].lessons[0].units.push({ title: 'Pending', components: [] });
  const result = validateWorkspaceReadyComponentChapter({ ...f, readyUnits: new Set(['0:0']) });
  assert.equal(result.status, 'PASS'); assert.equal(result.scope_complete, false);
  assert.ok(result.deferred_checks.some(v => v.code === 'UNIT_CONTENT_PENDING'));
  assert.equal(result.validation_contract, 'workspace-component-edit-ready-1');
  assert.throws(() => validateWorkspaceComponentChapter(f), code('WORKSPACE_COMPONENT_SCOPE_INCOMPLETE'));
});
test('all-ready Save and final validation have identical findings, with no deferred checks', () => {
  const f = chapterFixture();
  for (const html of [f.proposal.chapters[0].lessons[0].units[0].components![0].data, '<p>Too short</p>']) {
    f.proposal.chapters[0].lessons[0].units[0].components![0].data = html;
    const ready = validateWorkspaceReadyComponentChapter({ ...f, readyUnits: new Set(['0:0']) });
    assert.deepEqual(ready.findings, validateWorkspaceComponentChapter(f).findings);
    assert.deepEqual(ready.deferred_checks, []); assert.equal(ready.scope_complete, true);
  }
});
test('pending later unit cannot hide broken teaching for an already-ready assessment', () => {
  const f = chapterFixture(), lesson = f.blueprint.lessons[0];
  lesson.learning_objectives = ['Identify the first step.', 'Identify the next step.'];
  lesson.assessment_required = true; lesson.assessment_objective_refs = ['lo_1', 'lo_2'];
  for (const p of lesson.units[0].component_plan!) p.learning_objective_refs = ['lo_1'];
  const pending = structuredClone(lesson.units[0]); pending.learning_objective_refs = ['lo_2'];
  for (const p of pending.component_plan!) p.learning_objective_refs = ['lo_2'];
  lesson.units.push(pending);
  f.proposal.chapters[0].lessons[0].units.push({ title: 'Pending', components: [] });
  const input = { ...f, readyUnits: new Set(['0:0']) };
  const before = validateWorkspaceReadyComponentChapter(input);
  assert.equal(before.status, 'PASS');
  assert.ok(before.deferred_checks.some(f => f.code === 'LESSON_ASSESSMENT_COMPLETENESS'));
  f.proposal.chapters[0].lessons[0].units[0].components![0].data = '<p>Short</p>';
  assert.ok(validateWorkspaceReadyComponentChapter(input).findings.some(f => f.code === 'ASSESSMENT_NOT_ALIGNED'));
});
test('ready scope cannot silently discard supplied pending content or invalid indexes', () => {
  const f = chapterFixture();
  for (const readyUnits of [new Set<string>(), new Set(['0:1']), new Set(['0:0', '10:2'])]) {
    assert.throws(() => validateWorkspaceReadyComponentChapter({ ...f, readyUnits }), code('WORKSPACE_COMPONENT_SCOPE_INCOMPLETE'));
  }
});
test('legacy/final pedagogy never accepts injected workspace readiness to skip validation', () => {
  const f = chapterFixture(); f.blueprint.lessons[0].learning_objectives = ['Identify the first step.'];
  f.proposal.chapters[0].lessons[0].units[0].components = [];
  const normal = validateLessonAuthorPedagogicalQuality({ proposal: f.proposal, blueprint_chapter: f.blueprint });
  const extra = { proposal: f.proposal, blueprint_chapter: f.blueprint, readyUnits: new Set<string>(), deferred: [] };
  assert.equal(normal.status, 'FAIL'); assert.deepEqual(validateLessonAuthorPedagogicalQuality(extra), normal);
});
test('binding refuses non-JSON metadata and malformed evidence instead of normalizing it away', () => {
  const stored = workspaceComponentStorage(fixtures()[0], allowed);
  for (const extra of [{ source_fact_ids: ['fact_1', 'fact_1'] }, { covered_source_fact_ids: [17] },
    { supporting_evidence_fact_ids: [' padded '] }, { non_json: Number.NaN }, { non_json: undefined }, { non_json: new Date() }]) {
    assert.throws(() => hydrateWorkspaceComponent({ ...stored.binding, metadata: { ...stored.binding.metadata, ...extra } }, stored.content, allowed));
  }
  let getterCalls = 0;
  const metadata = { ...stored.binding.metadata, get unsafe() { getterCalls++; return 'hidden'; } };
  assert.throws(() => hydrateWorkspaceComponent({ ...stored.binding, metadata }, stored.content, allowed));
  assert.equal(getterCalls, 0);
});
test('planned binding is available before any generated content and never requires a later provenance mutation', () => {
  const plan = { type: 'problem' as const, title: 'Planned check', component_plan_id: 'check_1', source_fact_ids: [], supporting_evidence_fact_ids: ['fact_1'], learning_objective_refs: ['lo_1'] };
  const binding = workspaceComponentPlanBinding(plan), before = structuredClone(binding);
  assert.equal(binding.display_title, plan.title);
  assert.deepEqual(binding.metadata.covered_source_fact_ids, []);
  const content = workspaceComponentContent(fixtures()[1], allowed);
  const hydrated = hydrateWorkspaceComponent(binding, content, allowed);
  assert.deepEqual(hydrated.metadata!.source_fact_ids, []);
  assert.deepEqual(hydrated.metadata!.supporting_evidence_fact_ids, ['fact_1']);
  assert.equal(hydrated.metadata!.weight, 1); assert.deepEqual(binding, before);
  assert.equal('data' in binding, false);
});
