import assert from 'node:assert/strict';
import test from 'node:test';
import type { LessonAuthorProposal } from '../course-authoring/course-authoring.service.js';
import type { CourseComponentType } from '../tenants/tenant-course-components.constants.js';
import { idmDesignHash, idmPythonWordCount } from './lesson-author-idm.contract.js';
import {
  assembleIdmOrchestrationArchitecture,
  assertIdmShardDesign,
  idmAuthorNote,
} from './lesson-author-idm-architecture.logic.js';
import { idmScopeViewOf, remapFactsToBlockScopes } from './lesson-author-idm-scope-view.logic.js';
import { exceedsIdmOutputBudget, idmPythonHtmlVisibleText, idmUnitOutputBudget } from './lesson-author-idm-unit.logic.js';
import { idmFixture, idmShardFixtures, IDM_FIXTURE_SNAPSHOT_HASH } from './lesson-author-idm.fixture.js';
import {
  assembleOrchestrationV2Architecture,
  readOrchestrationV2ArchitectureAssembly,
} from './lesson-author-orchestration-v2-architecture.logic.js';
import { finalizeOrchestrationV2Course } from './lesson-author-orchestration-v2-finalization.logic.js';
import {
  prepareOrchestrationV2InventoryIdentity,
  prepareOrchestrationV2InventoryPublication,
} from './lesson-author-orchestration-v2-inventory.logic.js';
import { orchestrationV2Hash, sealOrchestrationV2PersistedManifest } from './lesson-author-orchestration-v2.logic.js';
import { ORCHESTRATION_V2_IDM_EXECUTION_POLICY } from './lesson-author-orchestration-v2-execution.config.js';
import {
  acceptOrchestrationV2GeneratedUnit,
  prepareOrchestrationV2UnitGenerationContract,
  readOrchestrationV2UnitProviderResponse,
} from './lesson-author-orchestration-v2-unit.logic.js';
import { buildWorkspaceArchitecturePreview } from './lesson-author-workspace-preview.logic.js';
import { renderSemanticLearningHtml } from './lesson-author-component-registry.logic.js';

type Mutable = Record<string, any>;
const RUN = '00000000-0000-4000-8000-000000000001';
const hash = (value: unknown) => orchestrationV2Hash(value);
const shardInvalid = { code: 'IDM_SHARD_DESIGN_INVALID' };

function idmAssembly() {
  const fixture = idmFixture();
  const shards = idmShardFixtures(fixture);
  const view = idmScopeViewOf(fixture.design);
  const assembly = assembleIdmOrchestrationArchitecture(fixture.skeleton, view,
    shards.map(item => ({ artifact_hash: item.artifact_hash, shard: item.shard as never })));
  return { fixture, shards, view, assembly };
}

test('IDM assembly keeps the V2 assembly over the block-scope catalogue and adds a hashed idm extension', () => {
  const { fixture, shards, view, assembly } = idmAssembly();
  const legacy = assembleOrchestrationV2Architecture(fixture.skeleton, view.scopeCatalog,
    shards.map(item => ({ artifact_hash: item.artifact_hash, shard: item.shard as never })));
  const { assembly_hash: legacyHash, ...legacyBase } = legacy;
  const { assembly_hash: idmHashValue, idm, ...base } = assembly;
  assert.deepEqual(base, legacyBase, 'every legacy field is unchanged');
  assert.notEqual(idmHashValue, legacyHash);
  assert.equal(idmHashValue, hash({ ...base, idm }));
  assert.equal(assembly.admitted_fact_count, view.dispositionCounts.course + view.dispositionCounts.reference_job_aid);
  assert.deepEqual({ ...idm, chapters: Object.keys(idm!.chapters) }, {
    design_hash: fixture.design.design_hash, excluded_fact_count: 3,
    disposition_counts: { course: 6, reference_job_aid: 0, nice_to_know: 1, remove: 0, hold: 1, noise: 1 },
    module_keys: ['mod_01', 'mod_02'], notes: fixture.design.notes, chapters: ['chapter-1', 'chapter-2'],
  });
  assert.deepEqual(readOrchestrationV2ArchitectureAssembly(JSON.parse(JSON.stringify(assembly))), JSON.parse(
    JSON.stringify(assembly)));
});

test('assembly reader rejects a tampered or inconsistent idm extension', () => {
  const { assembly } = idmAssembly();
  const resealed = (change: (value: Mutable) => void) => {
    const copy = structuredClone(assembly) as Mutable;
    change(copy);
    const { assembly_hash: _old, ...base } = copy;
    return { ...base, assembly_hash: hash(base) };
  };
  const invalid = { code: 'ORCHESTRATION_V2_ARCHITECTURE_INVALID' };
  assert.throws(() => readOrchestrationV2ArchitectureAssembly({ ...assembly, idm: { ...assembly.idm,
    excluded_fact_count: 4 } }), invalid);
  assert.throws(() => readOrchestrationV2ArchitectureAssembly(resealed(value => { value.idm.excluded_fact_count = 4; })),
    invalid);
  assert.throws(() => readOrchestrationV2ArchitectureAssembly(resealed(value => { value.idm.extra = true; })), invalid);
  assert.throws(() => readOrchestrationV2ArchitectureAssembly(resealed(value => {
    value.idm.chapters['chapter-9'] = value.idm.chapters['chapter-1']; delete value.idm.chapters['chapter-1'];
  })), invalid);
  assert.throws(() => readOrchestrationV2ArchitectureAssembly(resealed(value => { value.admitted_fact_count = 7;
    value.allocated_fact_count = 7; })), invalid);
  assert.throws(() => readOrchestrationV2ArchitectureAssembly(resealed(value => {
    value.idm.chapters['chapter-1'][0].design_hash = 'f'.repeat(64);
  })), invalid);
});

test('shard designs must match the plan and their own V2 projection (IDM_SHARD_DESIGN_INVALID)', () => {
  const fixture = idmFixture();
  const [first] = idmShardFixtures(fixture);
  const plan = first!.plan;
  assert.equal(assertIdmShardDesign(first!.shard as never, fixture.design, plan).chapter_key, 'chapter-1');
  const variant = (change: (shard: Mutable) => void, reseal = true) => {
    const shard = structuredClone(first!.shard) as Mutable;
    change(shard);
    if (reseal) {
      const { design_hash: _old, ...rest } = shard.idm_design;
      shard.idm_design = { ...rest, design_hash: idmDesignHash(rest) };
    }
    return shard as never;
  };
  assert.throws(() => assertIdmShardDesign(variant(shard => { delete shard.idm_design; }, false), fixture.design, plan),
    shardInvalid);
  assert.throws(() => assertIdmShardDesign(variant(shard => { shard.idm_design.design_hash = 'a'.repeat(64); }, false),
    fixture.design, plan), shardInvalid);
  assert.throws(() => assertIdmShardDesign(variant(shard => { shard.idm_design.lesson_index_offset = 9; }),
    fixture.design, plan), shardInvalid);
  assert.throws(() => assertIdmShardDesign(variant(shard => { shard.idm_design.lessons.reverse(); }),
    fixture.design, plan), shardInvalid);
  assert.throws(() => assertIdmShardDesign(variant(shard => { shard.idm_design.lessons[0].title = 'Tên khác hẳn'; }),
    fixture.design, plan), shardInvalid);
  assert.throws(() => assertIdmShardDesign(variant(shard => {
    shard.lessons[0].units[0].component_plan[0].type = 'la_faq';
  }), fixture.design, plan), shardInvalid);
  assert.throws(() => assertIdmShardDesign(variant(shard => { shard.idm_design.chapter_key = 'chapter-2'; }),
    fixture.design, plan), shardInvalid);
});

test('inventory identity carries §8.4 author notes for IDM and counts every snapshot fact as admitted', () => {
  const { fixture, assembly } = idmAssembly();
  const identity = prepareOrchestrationV2InventoryIdentity({ run_id: RUN, assembly });
  const byKind = (kind: string) => identity.nodes.filter(node => node.kind === kind);
  assert.equal(byKind('course')[0]!.baseline!.implementation_notes, fixture.design.notes.course);
  assert.deepEqual(byKind('chapter').map(node => node.baseline!.implementation_notes), ['Ghi chú chương.', 'Ghi chú chương.']);
  assert.deepEqual(byKind('lesson').map(node => node.baseline!.implementation_notes),
    ['lsn_001', 'lsn_002', 'lsn_003'].map(key => `Ghi chú mục.\nGhi chú thiết kế ${key}.`));
  assert.ok(byKind('unit').every(node => node.baseline === null));
  // The legacy identity of the same V2 structure keeps every note null.
  const legacy = prepareOrchestrationV2InventoryIdentity({ run_id: RUN,
    assembly: (({ idm: _idm, ...rest }) => rest)(assembly) as never });
  assert.ok(legacy.nodes.every(node => node.baseline === null || node.baseline.implementation_notes === null));
  assert.notEqual(legacy.inventory_hash, identity.inventory_hash);
  const tasks = [
    { id: '00000000-0000-4000-8000-000000000201', ordinal: 0, task_key: 'source:snapshot', kind: 'source_snapshot' },
    { id: '00000000-0000-4000-8000-000000000202', ordinal: 1, task_key: 'architecture:course', kind: 'course_skeleton' },
    { id: '00000000-0000-4000-8000-000000000203', ordinal: 2, task_key: 'architecture:chapter:chapter-1:shard:1',
      kind: 'chapter_blueprint' },
    { id: '00000000-0000-4000-8000-000000000204', ordinal: 3, task_key: 'architecture:chapter:chapter-2:shard:1',
      kind: 'chapter_blueprint' },
    { id: '00000000-0000-4000-8000-000000000205', ordinal: 4, task_key: 'architecture:validate', kind: 'validate_architecture' },
    { id: '00000000-0000-4000-8000-000000000206', ordinal: 5, task_key: 'inventory:publish', kind: 'publish_inventory' },
  ].map(task => {
    const provider = ['course_skeleton', 'chapter_blueprint'].includes(task.kind);
    const depends: Record<string, string[]> = { course_skeleton: ['source:snapshot'],
      chapter_blueprint: ['architecture:course'], validate_architecture: ['architecture:chapter:chapter-1:shard:1',
        'architecture:chapter:chapter-2:shard:1'], publish_inventory: ['architecture:validate'] };
    return { ...task, kind: task.kind as never, chapter_key: task.kind === 'chapter_blueprint'
      ? task.task_key.split(':')[2]! : null, node_id: null, contract_hash: hash(task.task_key),
    input_context_hash: hash(`${task.task_key}-input`), priority: 10, max_attempts: 2,
    depends_on: depends[task.kind] ?? [], budget: provider ? { ...ORCHESTRATION_V2_IDM_EXECUTION_POLICY.planning.chapter }
      : { input_tokens: 0, embedding_tokens: 0, max_output_tokens: 0, max_provider_attempts: 0, execution_budget_ms: 120_000 } };
  });
  const publication = prepareOrchestrationV2InventoryPublication({ run_id: RUN, assembly, existing_tasks: tasks,
    budgets: ORCHESTRATION_V2_IDM_EXECUTION_POLICY.inventory });
  assert.equal(publication.admitted_fact_count, fixture.facts.length);
  assert.equal(publication.inventory_hash, identity.inventory_hash);
});

test('author notes never carry angle brackets and are bounded in code points', () => {
  assert.equal(idmAuthorNote(['  a <b> c  ', null, '', 'd'], 100), 'a ‹b› c\nd');
  assert.equal(idmAuthorNote([' ', null], 100), null);
  assert.equal(idmAuthorNote([`${'x'.repeat(9)}\u{1F600}y`], 10), `${'x'.repeat(9)}\u{1F600}`);
});

function idmUnit() {
  const { fixture, assembly, view } = idmAssembly();
  const unitPath = 'chapter_1.lesson_1.unit_1';
  const scopes = assembly.architecture.chapters[0]!.lessons[0]!.units[0]!.source_scope_ids;
  const keys = new Set(view.design.block_scopes.filter(scope => scopes.includes(scope.scope_key))
    .flatMap(scope => scope.fact_keys));
  const unitFacts = remapFactsToBlockScopes(fixture.facts.filter(fact => keys.has(fact.fact_key)), view);
  const contract = prepareOrchestrationV2UnitGenerationContract({ assembly, unit_path: unitPath, source_facts: unitFacts,
    idm: { design: fixture.design, lesson_facts: fixture.facts.filter(fact => keys.has(fact.fact_key)) } });
  return { fixture, assembly, contract };
}

test('IDM unit contract carries a sealed brief inside the contract hash; required artifacts are never forced', () => {
  const { fixture, assembly, contract } = idmUnit();
  const brief = contract.idm_unit_brief!;
  const { contract_hash: contractHash, ...base } = contract;
  assert.equal(contractHash, hash(base));
  assert.equal(brief.brief_hash, hash((({ brief_hash: _hash, ...rest }) => rest)(brief)));
  assert.deepEqual({ course: brief.course_title, module: brief.module_title, lesson: brief.lesson_title,
    previous: brief.previous_lesson_title, next: brief.next_lesson_title, segment: brief.unit_segment,
    audience: brief.target_audience }, { course: fixture.skeleton.title, module: 'Chương 1', lesson: 'Bài học 1',
    previous: null, next: 'Bài học 2', segment: 'context_explain', audience: fixture.design.target_audience.description });
  assert.deepEqual(brief.components.map(slot => [slot.component_plan_id, slot.owned_fact_keys, slot.supporting_fact_keys]),
    contract.component_plan.map(plan => [plan.component_plan_id, plan.source_fact_ids, plan.supporting_evidence_fact_ids]));
  assert.deepEqual(brief.components[0]!.treatments, [{ block_id: 'cb_0001', treatment: 'condense',
    detail_level: 'Giữ phần cần thiết.' }]);
  assert.ok(contract.component_plan.every(plan => plan.required_artifacts?.length === 0));
  assert.ok(contract.source_facts.every(fact => fact.scope_key.startsWith('idmcb_')));
  assert.throws(() => prepareOrchestrationV2UnitGenerationContract({ assembly, unit_path: contract.unit_path,
    source_facts: contract.source_facts }), { code: 'ORCHESTRATION_V2_UNIT_CONTRACT_INVALID' });
  assert.equal(idmUnitOutputBudget(brief).max_words, 450);
  assert.equal(idmUnitOutputBudget({ unit_segment: 'job_aid', components: [{ ...brief.components[0]!,
    treatments: Array.from({ length: 20 }, (_, index) => ({ block_id: `cb_${String(index + 1).padStart(4, '0')}`,
      treatment: 'keep' as const, detail_level: 'd' })) }] }).max_words, 1_600);
});

function unitResponse(contract: ReturnType<typeof idmUnit>['contract'], html: string, quality: unknown,
  origin: 'provider_validated' | 'structured_fallback' = 'provider_validated', extra: Mutable = {}) {
  const plan = contract.component_plan[0]!;
  return readOrchestrationV2UnitProviderResponse({ contract_version: 2,
    source_snapshot_hash: contract.source_snapshot_hash, unit_path: contract.unit_path,
    unit: { title: contract.unit_title, source_fact_ids: [...contract.unit_source_fact_ids],
      idm_quality: quality, component_plan: contract.component_plan, components: [{ ...extra,
        type: 'html', title: 'Giải thích', data: html, component_plan_id: plan.component_plan_id,
        source_fact_ids: [...plan.source_fact_ids], covered_source_fact_ids: [...plan.source_fact_ids],
        supporting_evidence_fact_ids: [], metadata: { component_plan_id: plan.component_plan_id,
          source_fact_ids: [...plan.source_fact_ids], covered_source_fact_ids: [...plan.source_fact_ids],
          supporting_evidence_fact_ids: [], learning_objective_refs: [...plan.learning_objective_refs] } }] },
    usage_complete: true, usage_source: 'provider', content_origin: origin,
    quality_state: origin === 'provider_validated' ? 'validated' : 'review_required', usage: {}, attempt_trace: [
      { sequence: 1, invocation_kind: 'writer', invocation_index: 1, provider_attempt: 1, phase: 'idm_w5_writer',
        outcome: 'succeeded', event_code: 'provider_response_received', failure_stage: null, failure_code: null,
        failure_path: null, provider_dispatched: true, usage_source: 'unknown', observed_usage: {}, duration_ms: 3,
        diagnostics: {} },
      { sequence: 2, invocation_kind: 'evaluator', invocation_index: 1, provider_attempt: 1, phase: 'idm_w6_judge',
        outcome: 'succeeded', event_code: 'provider_response_received', failure_stage: null, failure_code: null,
        failure_path: null, provider_dispatched: true, usage_source: 'unknown', observed_usage: {}, duration_ms: 3,
        diagnostics: {} }] }, contract);
}

const QUALITY = { judge_mode: 'observe', judge_status: 'pass', finding_counts: { minor: 0, major: 0, critical: 0 },
  criteria: { Q1_support_sufficient: 'pass' }, repair_applied: false, deterministic_codes: [],
  author_note: 'QA tự động: không phát hiện vấn đề lớn.' };
const normalize = (raw: unknown) => ({ summary: '', chapters: (raw as { chapters: LessonAuthorProposal['chapters'] }).chapters });
const allowed = new Set<CourseComponentType>(['html']);

test('IDM unit acceptance keeps idm_quality, writes the unit note and applies the IDM output budget', () => {
  const { contract } = idmUnit();
  const accepted = acceptOrchestrationV2GeneratedUnit({ contract, normalizeProposal: normalize, allowed,
    response: unitResponse(contract, '<p>Quy trình mẫu được giải thích ngắn gọn cho người học.</p>', QUALITY) });
  assert.deepEqual(accepted.generated_unit.idm_quality, QUALITY);
  assert.equal(accepted.nodes[0]!.content.implementation_notes, QUALITY.author_note);
  const silent = acceptOrchestrationV2GeneratedUnit({ contract, normalizeProposal: normalize, allowed,
    response: unitResponse(contract, '<p>Quy trình mẫu được giải thích ngắn gọn cho người học.</p>',
      { ...QUALITY, author_note: '' }) });
  assert.equal(silent.nodes[0]!.content.implementation_notes, null);
  assert.throws(() => acceptOrchestrationV2GeneratedUnit({ contract, normalizeProposal: normalize, allowed,
    response: unitResponse(contract, '<p>Nội dung.</p>', { ...QUALITY, judge_status: 'great' }) }),
  { code: 'IDM_UNIT_QUALITY_INVALID' });
  assert.throws(() => acceptOrchestrationV2GeneratedUnit({ contract, normalizeProposal: normalize, allowed,
    response: unitResponse(contract, '<p>Nội dung.</p>', undefined) }), { code: 'IDM_UNIT_QUALITY_INVALID' });
  // context_explain with one block → 450 words / 3,150 visible characters for authored HTML only.
  const long = `<p>${'Giải thích chi tiết quy trình '.repeat(160)}</p>`;
  assert.throws(() => acceptOrchestrationV2GeneratedUnit({ contract, normalizeProposal: normalize, allowed,
    response: unitResponse(contract, long, QUALITY) }), { code: 'ORCHESTRATION_V2_UNIT_BASELINE_INVALID' });
  assert.doesNotThrow(() => acceptOrchestrationV2GeneratedUnit({ contract, normalizeProposal: normalize, allowed,
    response: unitResponse(contract, long, QUALITY, 'structured_fallback') }));
});

/** v2 semantic html: `words` distinct "mã_<n>" (one Python `\w+` word each) over paragraphs, under a long heading. */
function semanticHtml(words: number) {
  const paragraphs = Array.from({ length: Math.ceil(words / 150) }, (_, index) =>
    Array.from({ length: Math.min(150, words - index * 150) }, (_word, position) =>
      `mã_${(index * 150 + position).toString(36)}`).join(' '));
  return { version: 2, sections: [{ heading: 'Tiêu đề phần giải thích rất dài gồm nhiều từ không được tính vào ngân sách',
    learning_block_ids: [], blocks: paragraphs.map(text => ({ kind: 'paragraph', text, items: [], rows: [] })) }] };
}

test('IDM output budget is measured exactly like Python (code points, \\w+ words, per html component)', () => {
  const brief = { unit_segment: 'summary_apply' as const, components: [] };
  assert.deepEqual(idmUnitOutputBudget(brief), { max_words: 250, max_visible_chars: 1_750 });
  const html = (text: string) => ({ type: 'html', data: `<p>${text}</p>` });
  // Code points, not UTF-16 units: 1,750 astral letters are one word of 1,750 characters.
  assert.equal(exceedsIdmOutputBudget(brief, [html('𝔸'.repeat(1_750))]), false);
  assert.equal(exceedsIdmOutputBudget(brief, [html('𝔸'.repeat(1_751))]), true);
  // `\w` includes "_" and digits: "mã_số_2" and "a_1" are one word each.
  assert.equal(idmPythonWordCount('mã_số_2 a-b c.d'), 5);
  assert.equal(exceedsIdmOutputBudget(brief, [html(Array(250).fill('a_1').join(' '))]), false);
  assert.equal(exceedsIdmOutputBudget(brief, [html(Array(251).fill('a_1').join(' '))]), true);
  // Raw html: tags become a space, entities are kept as text, whitespace runs collapse.
  assert.equal(idmPythonHtmlVisibleText({ html: '<p>a &amp;\n\n b</p><p>c</p>' }), 'a &amp; b c');
  // Semantic content: section headings are not measured; items are stripped and joined by one space.
  assert.equal(idmPythonHtmlVisibleText({ semantic_content: { version: 2, sections: [{ heading: 'Không tính',
    blocks: [{ kind: 'paragraph', text: '  một  hai ' }, { kind: 'steps', items: ['ba'] },
      { kind: 'table', rows: [{ label: ' bốn ', value: 'năm' }] }] }] } }), 'một  hai ba bốn năm');
  assert.equal(idmPythonHtmlVisibleText({ semantic_content: { heading: 'Một', paragraphs: ['hai'], bullets: ['ba'] } }),
    'Một hai ba');
  assert.equal(idmPythonHtmlVisibleText({ semantic_content: { version: 2, sections: [] } }), null);
  // Python measures each html component on its own.
  const full = html(Array(250).fill('từ').join(' '));
  assert.equal(exceedsIdmOutputBudget(brief, [full, full]), false);
  assert.equal(exceedsIdmOutputBudget(brief, [full, html(Array(251).fill('từ').join(' '))]), true);
});

test('IDM unit acceptance never rejects semantic html that Python accepted at the budget edge', () => {
  const { contract } = idmUnit();
  assert.equal(idmUnitOutputBudget(contract.idm_unit_brief!).max_words, 450);
  // 450 underscore words + a heading: Python counts 450 (heading excluded, "mã_1a" is one word). The
  // rendered page (what the real normalizer stores) shows the heading and splits "mã_1a" in two.
  const semantic = (words: number) => {
    const content = semanticHtml(words);
    return unitResponse(contract, renderSemanticLearningHtml(content)!, QUALITY, 'provider_validated',
      { semantic_content: content });
  };
  const atBudget = acceptOrchestrationV2GeneratedUnit({ contract, normalizeProposal: normalize, allowed,
    response: semantic(450) });
  const rendered = String(atBudget.generated_unit.components[0]!.data);
  assert.match(rendered, /<h2>/);
  assert.ok((rendered.replace(/<[^>]+>/g, ' ').match(/[\p{L}\p{N}]+/gu)?.length ?? 0) > 450,
    'the former rendered-HTML measure would have rejected this unit');
  assert.throws(() => acceptOrchestrationV2GeneratedUnit({ contract, normalizeProposal: normalize, allowed,
    response: semantic(451) }), { code: 'ORCHESTRATION_V2_UNIT_BASELINE_INVALID' });
});

test('IDM finalization adds the excluded facts to the chapter receipts and records idm_accounting', () => {
  const accounting = { course: 6, reference_job_aid: 0, nice_to_know: 1, remove: 0, hold: 1, noise: 1 };
  const receiptBase = { contract: 'orchestration-chapter-receipt-v2' as const, source_snapshot_hash: IDM_FIXTURE_SNAPSHOT_HASH,
    assembly_hash: hash('assembly'), inventory_hash: hash('inventory'), chapter_key: 'chapter-1',
    chapter_node_id: '00000000-0000-4000-8000-000000000011', unit_count: 1, component_count: 1,
    admitted_fact_count: 6, allocated_fact_count: 6, covered_fact_count: 6, duplicate_fact_count: 0 as const,
    unresolved_fact_count: 0 as const, unit_artifact_hashes: [hash('unit')], fact_set_hash: hash('facts'),
    baseline_set_hash: hash('baselines') };
  const receipt = { ...receiptBase, receipt_hash: hash(receiptBase) };
  const task = (ordinal: number, task_key: string, kind: string, extra: Record<string, unknown> = {}) => ({
    ordinal, task_key, kind: kind as never, chapter_key: null, node_id: null, contract_hash: hash(task_key),
    input_context_hash: null, priority: 10, max_attempts: 2, depends_on: [] as string[],
    budget: ['course_skeleton', 'chapter_blueprint', 'generate_unit'].includes(kind)
      ? { ...ORCHESTRATION_V2_IDM_EXECUTION_POLICY.inventory.unit }
      : { input_tokens: 0, embedding_tokens: 0, max_output_tokens: 0, max_provider_attempts: 0, execution_budget_ms: 1_000 },
    status: 'succeeded' as const, result_hash: hash(task_key) as string | null, validation_contract: 'done' as string | null,
    ...extra });
  const tasks = [
    task(0, 'source:snapshot', 'source_snapshot'),
    task(1, 'architecture:course', 'course_skeleton', { depends_on: ['source:snapshot'] }),
    task(2, 'architecture:chapter:chapter-1:shard:1', 'chapter_blueprint', { chapter_key: 'chapter-1',
      depends_on: ['architecture:course'] }),
    task(3, 'architecture:validate', 'validate_architecture', { depends_on: ['architecture:chapter:chapter-1:shard:1'] }),
    task(4, 'inventory:publish', 'publish_inventory', { depends_on: ['architecture:validate'] }),
    task(5, 'content:chapter-1:unit:1', 'generate_unit', { chapter_key: 'chapter-1',
      node_id: '00000000-0000-4000-8000-000000000012', depends_on: ['inventory:publish'] }),
    task(6, 'content:chapter-1:validate', 'validate_chapter', { chapter_key: 'chapter-1',
      node_id: receipt.chapter_node_id, depends_on: ['content:chapter-1:unit:1'], result_hash: receipt.receipt_hash,
      validation_contract: receipt.contract }),
    task(7, 'course:finalize', 'finalize_course', { depends_on: ['content:chapter-1:validate'], status: 'running',
      result_hash: null, validation_contract: null }),
  ];
  const expected = sealOrchestrationV2PersistedManifest({ source_snapshot_hash: IDM_FIXTURE_SNAPSHOT_HASH,
    tasks: tasks.map(({ status: _s, result_hash: _r, validation_contract: _v, ...rest }) => rest) }).manifest_hash;
  const input = { source_snapshot_hash: IDM_FIXTURE_SNAPSHOT_HASH, expected_manifest_hash: expected,
    admitted_fact_count: 9, assembly_hash: receipt.assembly_hash, inventory_hash: receipt.inventory_hash, tasks,
    chapter_receipts: [receipt] };
  assert.throws(() => finalizeOrchestrationV2Course(input), { code: 'ORCHESTRATION_V2_FINALIZATION_INCOMPLETE' },
    'without the IDM accounting only 6 of 9 admitted facts are allocated');
  const result = finalizeOrchestrationV2Course({ ...input, idm_accounting: accounting, assessment_obligations: [] });
  assert.equal(result.contract, 'orchestration-course-finalization-v2');
  if (result.contract !== 'orchestration-course-finalization-v2') return;
  assert.deepEqual([result.completion.allocated_fact_count, result.completion.covered_fact_count], [9, 9]);
  assert.deepEqual(result.idm_accounting, accounting);
  const { course_artifact_hash: artifactHash, ...artifactBase } = result;
  assert.equal(artifactHash, hash(artifactBase));
  assert.throws(() => finalizeOrchestrationV2Course({ ...input, idm_accounting: { ...accounting, course: 5 } }),
    { code: 'ORCHESTRATION_V2_FINALIZATION_INCOMPLETE' });
  assert.throws(() => finalizeOrchestrationV2Course({ ...input, idm_accounting: { ...accounting, noise: 2 } }),
    { code: 'ORCHESTRATION_V2_FINALIZATION_INCOMPLETE' });
});

test('workspace preview renders an IDM skeleton artifact (standard skeleton, block-scope shard plans)', () => {
  const { fixture, shards } = idmAssembly();
  const preview = buildWorkspaceArchitecturePreview({ run_id: RUN, course_title: 'Khoá học',
    skeleton_artifact: { contract_version: 2, skeleton: fixture.skeleton, scopes: idmScopeViewOf(fixture.design).scopeCatalog,
      shard_plans: shards.map(item => item.plan), content_origin: 'provider_validated', quality_state: 'validated',
      idm: fixture.design },
    chapter_tasks: shards.map((item, index) => ({ task_id: `00000000-0000-4000-8000-00000000030${index}`, task_key: `architecture:chapter:${item.plan.chapter_key}:shard:1`,
      chapter_key: item.plan.chapter_key, status: 'succeeded', artifact_payload: { contract_version: 2,
        shard: item.shard } })),
    unit_tasks: [] });
  assert.equal(preview.total_chapters, 2);
  assert.equal(preview.completed_chapters, 2);
  assert.deepEqual(preview.nodes.filter(node => node.kind === 'lesson').map(node => node.title),
    ['Bài học 1', 'Bài học 2', 'Bài học 3']);
});

