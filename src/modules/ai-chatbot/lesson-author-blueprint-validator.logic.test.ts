import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { acceptAndPersistLessonAuthorBlueprint, BlueprintAcceptanceError, blueprintBoundaryCounts, blueprintValidationDiagnostics } from './lesson-author-blueprint-acceptance.logic.js';
import {
  normalizeLessonAuthorSourceMap,
  normalizeSourceChapterPolicy,
  validateLessonAuthorBlueprintArchitecture,
  type BlueprintArchitecture,
  type LessonAuthorSourceMap,
} from './lesson-author-blueprint-validator.logic.js';

const sourceMap: LessonAuthorSourceMap = {
  version: 'source-map-v1',
  documents: [{ id: 'doc-1', title: 'Safety guide', language: 'en', source_section_ids: ['section-1', 'section-2'] }],
  sections: [
    { id: 'section-1', document_id: 'doc-1', source_ref: 'src-001', title: 'Foundation', level: 1, parent_id: null, order: 1, source_fact_ids: ['fact-1'] },
    { id: 'section-2', document_id: 'doc-1', source_ref: 'src-002', title: 'Application', level: 2, parent_id: 'section-1', order: 2, source_fact_ids: ['fact-2'] },
  ],
  concepts: [
    { id: 'concept-foundation', name: 'Foundation', source_section_ids: ['section-1'], source_fact_ids: ['fact-1'], prerequisite_concept_ids: [], importance: 'core' },
    { id: 'concept-application', name: 'Application', source_section_ids: ['section-2'], source_fact_ids: ['fact-2'], prerequisite_concept_ids: ['concept-foundation'], importance: 'core', relationship_evidence: 'source_hierarchy' },
  ],
  facts: [
    { id: 'fact-1', section_id: 'section-1', document_id: 'doc-1', source_ref: 'src-001', page: 1, chunk: 0 },
    { id: 'fact-2', section_id: 'section-2', document_id: 'doc-1', source_ref: 'src-002', page: 2, chunk: 1 },
  ],
  coverage: { section_count: 2, source_fact_count: 2, mapped_fact_count: 2, fact_scope_complete: true, section_scope_complete: true },
};

function blueprint(): BlueprintArchitecture {
  return {
    architecture_contract_version: 3,
    title: 'Safety guide',
    learning_outcomes: ['Identify hazards.', 'Explain controls.', 'Apply controls.'],
    course_outcomes: ['Identify hazards.', 'Explain controls.', 'Apply controls.'],
    chapters: [{
      title: 'Safe work', objective: 'Apply safe work controls.', learning_objectives: ['lo-1'],
      concept_ids: ['concept-foundation', 'concept-application'], source_refs: ['src-001', 'src-002'],
      lessons: [
        {
          title: 'Foundation', objective: 'Identify the required controls.', learning_objectives: ['lo-1'],
          primary_concept_ids: ['concept-foundation'], supporting_concept_ids: [], prerequisite_concept_ids: [],
          assessment_required: true, assessment_objective_refs: ['lo-1'], source_refs: ['src-001'],
          units: [{ title: 'Required controls', purpose: 'Explain the foundation.', concept_ids: ['concept-foundation'], learning_objective_refs: ['lo-1'], source_refs: ['src-001'], source_fact_ids: ['fact-1'] }],
        },
        {
          title: 'Application', objective: 'Apply the controls in a work situation.', learning_objectives: ['lo-1'],
          primary_concept_ids: ['concept-application'], supporting_concept_ids: [], prerequisite_concept_ids: ['concept-foundation'],
          assessment_required: true, assessment_objective_refs: ['lo-1'], source_refs: ['src-002'],
          units: [{ title: 'Control application', purpose: 'Apply the foundation.', concept_ids: ['concept-application'], learning_objective_refs: ['lo-1'], source_refs: ['src-002'], source_fact_ids: ['fact-2'] }],
        },
      ],
    }],
  };
}

function copy<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function codes(value: ReturnType<typeof validateLessonAuthorBlueprintArchitecture>): string[] {
  return [...value.errors, ...value.warnings, ...value.info].map(item => item.code);
}

function mixedObjectiveFixture(locale: 'en' | 'vi' = 'en') {
  const map: LessonAuthorSourceMap = { ...copy(sourceMap), version: 'source-map-v2',
    source_evidence_scopes: sourceMap.sections.map((section, i) => ({
      id: `scope-${i + 1}`, document_id: section.document_id, section_id: section.id,
      concept_ids: [sourceMap.concepts[i].id], source_ref: section.source_ref,
      source_fact_ids: section.source_fact_ids, fact_count: 1, evidence_char_count: 80,
      evidence_token_estimate: 20, derivation_basis: 'FALLBACK_PAGE_FACT_ORDINAL_RANGE', provenance_complete: true,
    })), coverage: { ...sourceMap.coverage, evidence_scope_complete: true, evidence_scope_count: 2 } };
  const candidate = blueprint();
  candidate.architecture_contract_version = 5;
  const lesson = candidate.chapters[0].lessons[0];
  lesson.objective = locale === 'en' ? 'Identify hazards and apply controls.' : 'Nhận diện nguy cơ và thực hiện kiểm soát.';
  lesson.learning_objectives = locale === 'en' ? ['Identify hazards.', 'Apply controls.'] : ['Nhận diện nguy cơ.', 'Thực hiện kiểm soát.'];
  lesson.primary_concept_ids = map.concepts.map(c => c.id);
  lesson.assessment_required = false;
  lesson.assessment_objective_refs = [];
  lesson.units = map.sections.map((section, i) => ({
    title: `Source treatment ${i + 1}`, purpose: '', concept_ids: [map.concepts[i].id],
    learning_objective_refs: [`lo_${i + 1}`], source_refs: [section.source_ref], source_fact_ids: section.source_fact_ids,
    learning_blocks: [{ id: `block-${i}`, intent: i ? 'procedure' : 'concept_explanation',
      concept_ids: [map.concepts[i].id], source_refs: [section.source_ref], source_fact_ids: section.source_fact_ids,
      learning_objective_refs: [`lo_${i + 1}`], primary_evidence_scope_ids: [`scope-${i + 1}`], supporting_evidence_scope_ids: [] }],
  }));
  candidate.chapters[0].lessons = [lesson];
  candidate.source_evidence_scope_allocation = { version: 'source-evidence-scope-allocation-v1', authority: 'server', architecture_contract_version: 5,
    complete: true, required_count: 2, allocated_count: 2, unallocated: [], allocations: map.source_evidence_scopes!.map((scope, i) => ({
      evidence_scope_id: scope.id, unit_path: `chapter_1.lesson_1.unit_${i + 1}`, learning_block_id: `block-${i}`, basis: 'PRIMARY_EVIDENCE_SCOPE' })) };
  candidate.source_fact_allocation = { version: 'source-fact-allocation-v3', authority: 'server', architecture_contract_version: 5,
    complete: true, required_count: 2, allocated_count: 2, unallocated: [], allocations: map.facts.map((fact, i) => ({
      fact_id: fact.id, evidence_scope_id: `scope-${i + 1}`, unit_path: `chapter_1.lesson_1.unit_${i + 1}`, learning_block_id: `block-${i}`, basis: 'PRIMARY_EVIDENCE_SCOPE' })) };
  return { candidate, map, lesson };
}

function pythonCoherenceCodes(candidate: BlueprintArchitecture): string[] {
  const cwd = fileURLToPath(new URL('../../../../landa-ai-rag/', import.meta.url));
  const python = resolve(cwd, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
  const response = spawnSync(python, ['-X', 'utf8', '-B', '-c',
    'import json,sys; from app.main import validate_v5_instructional_coherence; r=validate_v5_instructional_coherence(json.load(sys.stdin)); print(json.dumps([i["code"] for i in r.errors]))'],
  { cwd, input: JSON.stringify(candidate), encoding: 'utf8', timeout: 20_000 });
  assert.equal(response.status, 0, response.stderr);
  return JSON.parse(response.stdout);
}

test('V5 source chapter policy preserves identity and rejects cross-document/primary-scope leakage', () => {
  const { candidate, map } = mixedObjectiveFixture();
  candidate.chapters[0].title = 'Foundation';
  candidate.chapters[0].source_refs = ['src-001'];
  candidate.source_chapter_policy = { version: 1, mode: 'SOURCE_LOCKED_TOC', complete: true, reason_codes: [],
    chapters: [{ document_id: 'doc-1', source_ref: 'src-001', title: 'Foundation', source_title: 'Foundation', basis: 'SOURCE_LOCKED_TOC', parser_version: 'source-structure-v2' }] };
  assert.notEqual(validateLessonAuthorBlueprintArchitecture(candidate, map).status, 'FAIL');
  for (const change of [(b: BlueprintArchitecture) => { b.chapters[0].title = 'Invented'; },
    (b: BlueprintArchitecture) => { b.chapters[0].source_refs = ['src-002']; },
    (b: BlueprintArchitecture) => { b.source_chapter_policy!.chapters[0].document_id = 'other-tenant-document'; }]) {
    const changed = copy(candidate); change(changed);
    assert.ok(validateLessonAuthorBlueprintArchitecture(changed, map).errors.some(e => e.code === 'BLUEPRINT_SOURCE_STRUCTURE_MISMATCH'));
  }
  const unrelatedMap = copy(map); unrelatedMap.sections[1].parent_id = null;
  assert.ok(validateLessonAuthorBlueprintArchitecture(candidate, unrelatedMap).errors.some(e => e.code === 'BLUEPRINT_SOURCE_STRUCTURE_MISMATCH'));
  assert.equal(normalizeSourceChapterPolicy(undefined), undefined);
  assert.throws(() => normalizeSourceChapterPolicy({ ...candidate.source_chapter_policy, complete: false }), /SOURCE_CHAPTER_POLICY_INVALID/);
  assert.throws(() => normalizeSourceChapterPolicy({ ...candidate.source_chapter_policy, chapters: [] }), /SOURCE_CHAPTER_POLICY_INVALID/);
  const bindings = candidate.source_chapter_policy.chapters;
  assert.throws(() => normalizeSourceChapterPolicy({ ...candidate.source_chapter_policy, chapters: [...bindings, ...bindings] }), /SOURCE_CHAPTER_POLICY_INVALID/);
});

test('V5 Python/Node action coherence is scoped to assigned unit objectives in EN and VI', () => {
  for (const locale of ['en', 'vi'] as const) {
    const { candidate, map, lesson } = mixedObjectiveFixture(locale);
    assert.deepEqual(pythonCoherenceCodes(candidate), []);
    assert.equal(validateLessonAuthorBlueprintArchitecture(candidate, map).status, 'PASS');
    lesson.units[1].learning_blocks![0].intent = 'concept_explanation';
    assert.ok(pythonCoherenceCodes(candidate).includes('ACTION_OBJECTIVE_INSTRUCTION_MISMATCH'));
    const result = validateLessonAuthorBlueprintArchitecture(candidate, map);
    assert.deepEqual(result.errors.filter(e => e.code === 'ACTION_OBJECTIVE_INSTRUCTION_MISMATCH').map(e => e.path), ['chapters[0].lessons[0].units[1]']);
  }
});

test('V5 every assessment objective requires its own compatible prior primary teaching', () => {
  const { candidate, map, lesson } = mixedObjectiveFixture();
  lesson.assessment_required = true;
  lesson.assessment_objective_refs = ['lo_1', 'lo_2'];
  lesson.units[1].concept_ids = map.concepts.map(c => c.id);
  const check = { id: 'check', intent: 'knowledge_check', concept_ids: map.concepts.map(c => c.id),
    learning_objective_refs: ['lo_1', 'lo_2'], source_refs: map.sections.map(s => s.source_ref), source_fact_ids: [],
    primary_evidence_scope_ids: [], supporting_evidence_scope_ids: ['scope-1', 'scope-2'] };
  lesson.units[1].learning_blocks!.push(check);
  assert.deepEqual(pythonCoherenceCodes(candidate), []);
  assert.equal(validateLessonAuthorBlueprintArchitecture(candidate, map).status, 'PASS');
  lesson.units[1].learning_blocks![0].learning_objective_refs = ['lo_1'];
  assert.ok(pythonCoherenceCodes(candidate).includes('ASSESSMENT_OBJECTIVE_NOT_COVERED'));
  assert.ok(codes(validateLessonAuthorBlueprintArchitecture(candidate, map)).includes('ASSESSMENT_OBJECTIVE_NOT_COVERED'));
});

test('V5 rejects malformed, missing and duplicate unit objective references', () => {
  for (const refs of [[], ['lo_99'], ['lo_1', 'lo_1'], ['Identify hazards.']]) {
    const { candidate, map, lesson } = mixedObjectiveFixture();
    lesson.units[0].learning_objective_refs = refs;
    assert.ok(codes(validateLessonAuthorBlueprintArchitecture(candidate, map)).includes('OBJECTIVE_ALIGNMENT_INVALID'));
  }
});

test('Node acceptance logs safe findings before rejection and never persists invalid Python-ready candidate', async () => {
  const { candidate, map, lesson } = mixedObjectiveFixture();
  lesson.units[1].learning_blocks![0].intent = 'concept_explanation';
  candidate.title = 'PRIVATE_SENTINEL';
  let writes = 0;
  const events: unknown[] = [];
  await assert.rejects(acceptAndPersistLessonAuthorBlueprint(candidate, map, d => events.push(d), async () => { writes++; return 'id'; }), err => {
    assert.ok(err instanceof BlueprintAcceptanceError);
    assert.equal(err.failure_stage, 'node_blueprint_validation');
    assert.equal(err.code, 'LESSON_AUTHOR_BLUEPRINT_ARCHITECTURE_INVALID');
    assert.ok(err.diagnostics.findings.some(f => f.code === 'ACTION_OBJECTIVE_INSTRUCTION_MISMATCH' && f.path === 'chapters[0].lessons[0].units[1]'));
    return true;
  });
  assert.equal(writes, 0);
  assert.equal(events.length, 1);
  assert.doesNotMatch(JSON.stringify([events, blueprintBoundaryCounts(candidate)]), /PRIVATE_SENTINEL/);
  lesson.units[1].learning_blocks![0].intent = 'procedure';
  const id = await acceptAndPersistLessonAuthorBlueprint(candidate, map, d => events.push(d), async validation => {
    assert.notEqual(validation.status, 'FAIL'); writes++; return 'persisted-review-id';
  });
  assert.equal(id, 'persisted-review-id');
  assert.equal(writes, 1);
  await assert.rejects(acceptAndPersistLessonAuthorBlueprint(candidate, map, () => {}, async () => { throw new Error('PERSISTENCE_FAILED'); }), /PERSISTENCE_FAILED/);
});

test('validation diagnostics are bounded and exclude private messages and non-structural paths', () => {
  const result = validateLessonAuthorBlueprintArchitecture(blueprint(), sourceMap);
  result.errors = Array.from({ length: 45 }, () => ({ code: 'SAFE_CODE', severity: 'error', path: 'PRIVATE_SENTINEL', message: 'PRIVATE_SENTINEL', repair_scope: 'unit' }));
  const diagnostics = blueprintValidationDiagnostics(result);
  assert.equal(diagnostics.findings.length, 40);
  assert.equal(diagnostics.omitted_finding_count, 5 + result.warnings.length + result.info.length);
  assert.doesNotMatch(JSON.stringify(diagnostics), /PRIVATE_SENTINEL/);
});

test('valid Source-Map blueprint has full concept/source coverage and stable ownership', () => {
  const result = validateLessonAuthorBlueprintArchitecture(blueprint(), sourceMap);
  assert.equal(result.errors.length, 0);
  assert.equal(result.score_summary.source_coverage, 1);
  assert.equal(result.score_summary.concept_coverage, 1);
  assert.equal(result.concept_ownership['concept-foundation']?.primary_lesson_path, 'chapters[0].lessons[0]');
});

test('validator detects duplicate objectives and duplicate primary concept ownership', () => {
  const candidate = copy(blueprint());
  candidate.chapters[0].lessons[1].objective = candidate.chapters[0].lessons[0].objective;
  candidate.chapters[0].lessons[1].primary_concept_ids = ['concept-foundation'];
  const result = validateLessonAuthorBlueprintArchitecture(candidate, sourceMap);
  assert.ok(codes(result).includes('DUPLICATE_LESSON_OBJECTIVE'));
  assert.ok(codes(result).includes('DUPLICATE_PRIMARY_CONCEPT_OWNER'));
});

test('validator rejects unsupported concepts, invalid source references and missing source facts', () => {
  const candidate = copy(blueprint());
  const unit = candidate.chapters[0].lessons[0].units[0];
  unit.concept_ids = ['concept-not-in-map'];
  unit.source_refs = ['src-404'];
  unit.source_fact_ids = [];
  const result = validateLessonAuthorBlueprintArchitecture(candidate, sourceMap);
  assert.ok(codes(result).includes('UNSUPPORTED_CONCEPT'));
  assert.ok(codes(result).includes('INVALID_SOURCE_REF'));
  assert.ok(codes(result).includes('MISSING_SOURCE_FACTS'));
});

test('validator detects prerequisite order/cycles, thin and empty nodes, and assessment gaps', () => {
  const candidate = copy(blueprint());
  candidate.chapters[0].lessons.reverse();
  candidate.chapters[0].lessons[0].assessment_objective_refs = [];
  candidate.chapters[0].lessons[1].units = [];
  const cycleMap = copy(sourceMap);
  cycleMap.concepts[0].prerequisite_concept_ids = ['concept-application'];
  const result = validateLessonAuthorBlueprintArchitecture(candidate, cycleMap);
  assert.ok(codes(result).includes('PREREQUISITE_CYCLE'));
  assert.ok(codes(result).includes('PREREQUISITE_ORDER_INVALID'));
  assert.ok(codes(result).includes('ASSESSMENT_ALIGNMENT_MISSING'));
  assert.ok(codes(result).includes('EMPTY_LESSON'));
});

test('legacy stored blueprint remains reviewable without a Source Map', () => {
  const candidate = blueprint();
  delete candidate.architecture_contract_version;
  const result = validateLessonAuthorBlueprintArchitecture(candidate, null);
  assert.equal(result.errors.length, 0);
  assert.ok(codes(result).includes('SOURCE_MAP_UNAVAILABLE'));
});

test('v4 accepts only a complete server-owned allocation that matches semantic blocks', () => {
  const candidate = copy(blueprint());
  candidate.architecture_contract_version = 4;
  for (const lesson of candidate.chapters[0].lessons) {
    lesson.learning_objectives = ['Identify the lesson concept.'];
    lesson.assessment_objective_refs = ['lo_1'];
    for (const unit of lesson.units) unit.learning_objective_refs = ['lo_1'];
  }
  candidate.source_fact_allocation = {
    version: 'source-fact-allocation-v2',
    authority: 'server',
    architecture_contract_version: 4,
    required_count: 2,
    allocated_count: 2,
    complete: true,
    allocations: [
      { fact_id: 'fact-1', unit_path: 'chapter_1.lesson_1.unit_1', learning_block_id: 'lb-1', basis: 'SOURCE_REF_MATCH' },
      { fact_id: 'fact-2', unit_path: 'chapter_1.lesson_2.unit_1', learning_block_id: 'lb-2', basis: 'SOURCE_REF_MATCH' },
    ],
    unallocated: [],
  };
  const firstUnit = candidate.chapters[0].lessons[0].units[0] as unknown as { learning_blocks: Array<{ id: string; source_fact_ids: string[] }> };
  const secondUnit = candidate.chapters[0].lessons[1].units[0] as unknown as { learning_blocks: Array<{ id: string; source_fact_ids: string[] }> };
  firstUnit.learning_blocks = [{ id: 'lb-1', source_fact_ids: ['fact-1'] }];
  secondUnit.learning_blocks = [{ id: 'lb-2', source_fact_ids: ['fact-2'] }];
  const result = validateLessonAuthorBlueprintArchitecture(candidate, sourceMap);
  assert.equal(result.errors.length, 0);

  candidate.source_fact_allocation.authority = 'provider';
  const rejected = validateLessonAuthorBlueprintArchitecture(candidate, sourceMap);
  assert.ok(codes(rejected).includes('SOURCE_FACT_ALLOCATION_AUTHORITY_INVALID'));
});

test('v4 accepts a complete 371-fact allocation with one proven factless supporting unit', () => {
  const sectionCounts = [25, 10, 233, 23, 31, 49];
  let cursor = 0;
  const sections = sectionCounts.map((count, index) => {
    const sourceFactIds = Array.from({ length: count }, () => `fact-${++cursor}`);
    return {
      id: `section-${index + 1}`, document_id: 'doc-371', source_ref: `src-${index + 1}`,
      title: `Source ${index + 1}`, level: 1, parent_id: null, order: index + 1, source_fact_ids: sourceFactIds,
    };
  });
  const facts = sections.flatMap(section => section.source_fact_ids.map((id, index) => ({
    id, section_id: section.id, document_id: 'doc-371', source_ref: section.source_ref, page: index + 1,
  })));
  const concepts = sections.map((section, index) => ({
    id: `concept-${index + 1}`, name: `Concept ${index + 1}`,
    source_section_ids: [section.id], source_fact_ids: section.source_fact_ids,
    prerequisite_concept_ids: [], importance: 'core' as const,
  }));
  const largeMap: LessonAuthorSourceMap = {
    version: 'source-map-v1',
    documents: [{ id: 'doc-371', title: 'Large source', source_section_ids: sections.map(section => section.id) }],
    sections, concepts, facts,
    coverage: { section_count: 6, source_fact_count: 371, mapped_fact_count: 371, fact_scope_complete: true, section_scope_complete: true },
  };
  const units = sections.map((section, index) => ({
    title: `Unit ${index + 1}`, purpose: 'Teach the assigned source concept.',
    concept_ids: [`concept-${index + 1}`], primary_concept_ids: [`concept-${index + 1}`],
    learning_objective_refs: ['lo_1'], source_refs: [section.source_ref], source_fact_ids: section.source_fact_ids,
    learning_blocks: [{ id: `lb-${index + 1}`, concept_ids: [`concept-${index + 1}`], primary_concept_ids: [`concept-${index + 1}`], source_fact_ids: section.source_fact_ids, learning_objective_refs: ['lo_1'] }],
  }));
  const supportUnit = {
    title: 'Reinforcement', purpose: 'Practice an already-owned concept without canonical fact ownership.',
    concept_ids: ['concept-1'], primary_concept_ids: [], learning_objective_refs: ['lo_1'],
    source_refs: ['src-1'], source_fact_ids: [],
    learning_blocks: [{ id: 'lb-support', concept_ids: ['concept-1'], primary_concept_ids: [], source_fact_ids: [], learning_objective_refs: ['lo_1'] }],
  };
  const objectiveLabels = ['foundation controls', 'application requirements', 'hazard signals', 'response procedure', 'review criteria', 'reinforcement steps'];
  const lessons = units.map((unit, index) => ({
    title: `Lesson ${index + 1}`, objective: `Identify ${objectiveLabels[index]}.`,
    learning_objectives: [`Identify ${objectiveLabels[index]}.`], primary_concept_ids: [`concept-${index + 1}`],
    supporting_concept_ids: [], prerequisite_concept_ids: [], assessment_required: false, assessment_objective_refs: [],
    source_refs: [`src-${index + 1}`], units: index === 0 ? [unit, supportUnit] : [unit],
  }));
  const allocations = units.flatMap((unit, index) => unit.source_fact_ids.map(fact_id => ({
    fact_id, unit_path: `chapter_1.lesson_${index + 1}.unit_1`, learning_block_id: `lb-${index + 1}`, basis: 'OWNERSHIP_MATCH',
  })));
  const candidate: BlueprintArchitecture = {
    architecture_contract_version: 4, title: 'Large blueprint', learning_outcomes: ['Identify', 'Explain', 'Apply'],
    chapters: [{ title: 'Course', objective: 'Apply the source concepts.', concept_ids: concepts.map(concept => concept.id), source_refs: sections.map(section => section.source_ref), lessons }],
    source_fact_allocation: {
      version: 'source-fact-allocation-v2', authority: 'server', architecture_contract_version: 4,
      required_count: 371, allocated_count: 371, complete: true, allocations, unallocated: [],
    },
  };
  const result = validateLessonAuthorBlueprintArchitecture(candidate, largeMap);
  assert.equal(result.errors.length, 0);
  assert.equal(result.score_summary.source_coverage, 1);
  assert.ok(!codes(result).includes('MISSING_SOURCE_FACTS'));
});

test('v4 rejects a factless primary unit and invalid local objective references', () => {
  const candidate = copy(blueprint());
  candidate.architecture_contract_version = 4;
  candidate.chapters[0].lessons[0].units[0].primary_concept_ids = ['concept-foundation'];
  candidate.chapters[0].lessons[0].units[0].source_fact_ids = [];
  candidate.chapters[0].lessons[0].units[0].learning_objective_refs = ['Identify the required controls.'];
  const result = validateLessonAuthorBlueprintArchitecture(candidate, sourceMap);
  assert.ok(codes(result).includes('MISSING_SOURCE_FACTS'));
  assert.ok(codes(result).includes('OBJECTIVE_ALIGNMENT_INVALID'));
});

test('v5 accepts server-owned primary evidence scopes and does not make a repeated concept duplicate Fact ownership', () => {
  const map: LessonAuthorSourceMap = {
    ...copy(sourceMap),
    version: 'source-map-v2',
    source_evidence_scopes: [
      { id: 'scope-1', document_id: 'doc-1', section_id: 'section-1', concept_ids: ['concept-foundation'], source_ref: 'src-001', source_fact_ids: ['fact-1'], fact_count: 1, evidence_char_count: 80, evidence_token_estimate: 20, derivation_basis: 'FALLBACK_PAGE_FACT_ORDINAL_RANGE', provenance_complete: true },
      { id: 'scope-2', document_id: 'doc-1', section_id: 'section-2', concept_ids: ['concept-application'], source_ref: 'src-002', source_fact_ids: ['fact-2'], fact_count: 1, evidence_char_count: 80, evidence_token_estimate: 20, derivation_basis: 'FALLBACK_PAGE_FACT_ORDINAL_RANGE', provenance_complete: true },
    ],
    coverage: { ...sourceMap.coverage, evidence_scope_count: 2, evidence_scope_complete: true },
  };
  const candidate = copy(blueprint());
  candidate.architecture_contract_version = 5;
  for (const [lessonIndex, lesson] of candidate.chapters[0].lessons.entries()) {
    lesson.learning_objectives = ['Identify the source concept.'];
    lesson.assessment_required = false;
    lesson.assessment_objective_refs = [];
    const unit = lesson.units[0];
    unit.learning_objective_refs = ['lo_1'];
    unit.primary_evidence_scope_ids = [`scope-${lessonIndex + 1}`];
    unit.supporting_evidence_scope_ids = [];
    unit.learning_blocks = [{
      id: `lb-${lessonIndex + 1}`, intent: lessonIndex === 1 ? 'worked_example' : 'concept_explanation', concept_ids: unit.concept_ids, primary_concept_ids: unit.primary_concept_ids,
      primary_evidence_scope_ids: [`scope-${lessonIndex + 1}`], supporting_evidence_scope_ids: [],
      source_refs: unit.source_refs, source_fact_ids: unit.source_fact_ids, learning_objective_refs: ['lo_1'],
    }];
  }
  candidate.source_evidence_scope_allocation = {
    version: 'source-evidence-scope-allocation-v1', authority: 'server', architecture_contract_version: 5,
    required_count: 2, allocated_count: 2, complete: true,
    allocations: [
      { evidence_scope_id: 'scope-1', unit_path: 'chapter_1.lesson_1.unit_1', learning_block_id: 'lb-1', basis: 'PRIMARY_EVIDENCE_SCOPE' },
      { evidence_scope_id: 'scope-2', unit_path: 'chapter_1.lesson_2.unit_1', learning_block_id: 'lb-2', basis: 'PRIMARY_EVIDENCE_SCOPE' },
    ], unallocated: [],
  };
  candidate.source_fact_allocation = {
    version: 'source-fact-allocation-v3', authority: 'server', architecture_contract_version: 5,
    required_count: 2, allocated_count: 2, complete: true,
    allocations: [
      { fact_id: 'fact-1', unit_path: 'chapter_1.lesson_1.unit_1', learning_block_id: 'lb-1', evidence_scope_id: 'scope-1', basis: 'PRIMARY_EVIDENCE_SCOPE' },
      { fact_id: 'fact-2', unit_path: 'chapter_1.lesson_2.unit_1', learning_block_id: 'lb-2', evidence_scope_id: 'scope-2', basis: 'PRIMARY_EVIDENCE_SCOPE' },
    ], unallocated: [],
  };
  const result = validateLessonAuthorBlueprintArchitecture(candidate, map);
  assert.equal(result.errors.length, 0);

  candidate.chapters[0].lessons[1].units[0].learning_blocks![0].primary_evidence_scope_ids = ['scope-1'];
  const rejected = validateLessonAuthorBlueprintArchitecture(candidate, map);
  assert.ok(codes(rejected).includes('DUPLICATE_PRIMARY_EVIDENCE_SCOPE_OWNER'));
});

test('v5 rejects an assessment-required explanation-only draft and accepts a grounded teach-then-check semantic plan', () => {
  const map: LessonAuthorSourceMap = {
    ...copy(sourceMap),
    version: 'source-map-v2',
    source_evidence_scopes: [
      { id: 'scope-1', document_id: 'doc-1', section_id: 'section-1', concept_ids: ['concept-foundation'], source_ref: 'src-001', source_fact_ids: ['fact-1'], fact_count: 1, evidence_char_count: 80, evidence_token_estimate: 20, derivation_basis: 'FALLBACK_PAGE_FACT_ORDINAL_RANGE', provenance_complete: true },
      { id: 'scope-2', document_id: 'doc-1', section_id: 'section-2', concept_ids: ['concept-application'], source_ref: 'src-002', source_fact_ids: ['fact-2'], fact_count: 1, evidence_char_count: 80, evidence_token_estimate: 20, derivation_basis: 'FALLBACK_PAGE_FACT_ORDINAL_RANGE', provenance_complete: true },
    ],
    coverage: { ...sourceMap.coverage, evidence_scope_count: 2, evidence_scope_complete: true },
  };
  const candidate = copy(blueprint());
  candidate.architecture_contract_version = 5;
  for (const [lessonIndex, lesson] of candidate.chapters[0].lessons.entries()) {
    lesson.learning_objectives = ['Identify the source concept.'];
    lesson.assessment_required = lessonIndex === 0;
    lesson.assessment_objective_refs = lessonIndex === 0 ? ['lo_1'] : [];
    const unit = lesson.units[0];
    unit.learning_objective_refs = ['lo_1'];
    unit.primary_evidence_scope_ids = [`scope-${lessonIndex + 1}`];
    unit.learning_blocks = [{
      id: `lb-${lessonIndex + 1}`, intent: lessonIndex === 1 ? 'worked_example' : 'concept_explanation', concept_ids: unit.concept_ids,
      primary_concept_ids: unit.primary_concept_ids, primary_evidence_scope_ids: [`scope-${lessonIndex + 1}`],
      supporting_evidence_scope_ids: [], source_refs: unit.source_refs, source_fact_ids: unit.source_fact_ids,
      learning_objective_refs: ['lo_1'],
    }];
  }
  candidate.source_evidence_scope_allocation = {
    version: 'source-evidence-scope-allocation-v1', authority: 'server', architecture_contract_version: 5,
    required_count: 2, allocated_count: 2, complete: true,
    allocations: [
      { evidence_scope_id: 'scope-1', unit_path: 'chapter_1.lesson_1.unit_1', learning_block_id: 'lb-1', basis: 'PRIMARY_EVIDENCE_SCOPE' },
      { evidence_scope_id: 'scope-2', unit_path: 'chapter_1.lesson_2.unit_1', learning_block_id: 'lb-2', basis: 'PRIMARY_EVIDENCE_SCOPE' },
    ], unallocated: [],
  };
  candidate.source_fact_allocation = {
    version: 'source-fact-allocation-v3', authority: 'server', architecture_contract_version: 5,
    required_count: 2, allocated_count: 2, complete: true,
    allocations: [
      { fact_id: 'fact-1', unit_path: 'chapter_1.lesson_1.unit_1', learning_block_id: 'lb-1', evidence_scope_id: 'scope-1', basis: 'PRIMARY_EVIDENCE_SCOPE' },
      { fact_id: 'fact-2', unit_path: 'chapter_1.lesson_2.unit_1', learning_block_id: 'lb-2', evidence_scope_id: 'scope-2', basis: 'PRIMARY_EVIDENCE_SCOPE' },
    ], unallocated: [],
  };
  assert.ok(codes(validateLessonAuthorBlueprintArchitecture(candidate, map)).includes('ASSESSMENT_BLOCK_REQUIRED'));

  candidate.chapters[0].lessons[0].units[0].learning_blocks!.push({
    id: 'lb-1-check', intent: 'knowledge_check', concept_ids: ['concept-foundation'], primary_concept_ids: [],
    primary_evidence_scope_ids: [], supporting_evidence_scope_ids: ['scope-1'], source_refs: ['src-001'],
    source_fact_ids: [], learning_objective_refs: ['lo_1'],
  });
  const result = validateLessonAuthorBlueprintArchitecture(candidate, map);
  assert.equal(result.errors.length, 0);
});

test('Source Map normalization rejects an overlong canonical identifier instead of truncating it', () => {
  const candidate = copy(sourceMap) as unknown as Record<string, unknown>;
  const concepts = candidate.concepts as Array<Record<string, unknown>>;
  concepts[0]!.id = 'x'.repeat(97);
  assert.equal(normalizeLessonAuthorSourceMap(candidate), null);
});
