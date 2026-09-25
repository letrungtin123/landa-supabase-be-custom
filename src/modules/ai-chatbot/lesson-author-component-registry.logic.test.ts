import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import pg from 'pg';
import { acceptAndPersistLessonAuthorBlueprint } from './lesson-author-blueprint-acceptance.logic.js';
import { validateLessonAuthorPedagogicalQuality } from './lesson-author-pedagogical-validator.logic.js';
import { assertComponentInstancePlan, assessmentGapMessage, createComponentCapabilities, readSafeBlueprintFailure } from './lesson-author-capabilities.logic.js';
import { validateLessonAuthorContentContractUnit, validateLessonAuthorGeneratedUnitCoverage } from './lesson-author-content-contract.logic.js';
import { normalizeLessonAuthorSourceMap, validateLessonAuthorBlueprintArchitecture } from './lesson-author-blueprint-validator.logic.js';
import type { LessonAuthorComponentProposal } from '../course-authoring/course-authoring.service.js';
import { COURSE_COMPONENT_TYPES } from '../tenants/tenant-course-components.constants.js';
import {
  AI_COMPONENT_REGISTRY,
  assertAiComponentRegistryCoverage,
  assertAiGeneratedComponentValid,
  MAX_SERVER_OWNED_SOURCE_FACT_IDS_PER_SCOPE,
  normalizeSemanticLearningBlocks,
  planSemanticLearningBlocks,
  renderSemanticLearningHtml,
  validateSemanticLearningHtmlPayload,
  type SemanticLearningBlock,
  type ComponentPlannerDiagnostic,
} from './lesson-author-component-registry.logic.js';

const sourceFacts = ['fact-1', 'fact-2', 'fact-3'];
const allAllowed = new Set(COURSE_COMPONENT_TYPES);

test('profile two preserves distinct assessment instances without losing a required treatment', () => {
  const checks = [1, 2].map(n => ({ ...block('knowledge_check'), id: `check_${n}`, learning_objective_refs: [`lo_${n}`] }));
  const planned = planSemanticLearningBlocks({
    blocks: [block('concept_explanation'), ...checks, block('relationship_visualization', { relationship_evidence: true, relationship_count: 2 })],
    unit_source_fact_ids: sourceFacts,
    allowed_component_types: allAllowed,
    component_capabilities: { version: 2, max_components_per_unit: 4, max_assessments_per_unit: 3, assessment_enabled: true },
    unit_path: 'chapter_1.lesson_1.unit_1',
  });
  assert.deepEqual(planned.map(p => p.type), ['html', 'problem', 'problem', 'la_diagram']);
  assert.equal(new Set(planned.map(p => p.component_plan_id)).size, 4);
  assert.deepEqual(planned.slice(1, 3).map(p => p.learning_block_ids), [['check_1'], ['check_2']]);
});

test('profile two refuses capacity overflow, tenant-disabled assessment and ambiguous block identity', () => {
  const capabilities = createComponentCapabilities(allAllowed);
  const input = { unit_path: 'chapter_1.lesson_1.unit_1', unit_source_fact_ids: sourceFacts, component_capabilities: capabilities };
  assert.throws(() => planSemanticLearningBlocks({ ...input, blocks: [1, 2, 3, 4].map(n => ({ ...block('knowledge_check'), id: `check_${n}` })) }), /CAPABILITY_GAP/);
  assert.throws(() => planSemanticLearningBlocks({ ...input, blocks: [block('knowledge_check')], allowed_component_types: new Set(['html']) }), /TENANT_CAPABILITY_GAP/);
  assert.throws(() => planSemanticLearningBlocks({ ...input, blocks: [block('relationship_visualization', { relationship_evidence: true })], allowed_component_types: new Set(['html']) }), /MANDATORY_COMPONENT_CAPACITY_EXCEEDED/);
  assert.throws(() => planSemanticLearningBlocks({ ...input, blocks: [block('knowledge_check'), block('knowledge_check')] }), /AMBIGUOUS/);
  assert.throws(() => planSemanticLearningBlocks({ ...input, blocks: [1, 2, 3].map(n => ({ ...block('knowledge_check'), id: `check_${n}` })).concat([block('relationship_visualization', { relationship_evidence: true, relationship_count: 2 })]) }), /MANDATORY_COMPONENT_CAPACITY_EXCEEDED/);
});

test('capability diagnostics exclude arbitrary content and gap message never claims repair ran', () => {
  assert.deepEqual(readSafeBlueprintFailure({ failure_stage: 'blueprint_validation', internal_failure_code: 'ASSESSMENT_PLAN_DOWNSTREAM_CAPABILITY_GAP', total_repair_provider_calls: 0, prompt: 'PRIVATE_SENTINEL', response: 'PRIVATE_SENTINEL' }), {
    failure_stage: 'blueprint_validation', internal_failure_code: 'ASSESSMENT_PLAN_DOWNSTREAM_CAPABILITY_GAP', total_repair_provider_calls: 0,
  });
  assert.doesNotMatch(assessmentGapMessage('ASSESSMENT_PLAN_DOWNSTREAM_CAPABILITY_GAP', 'vi')!, /thử lại/);
  assert.equal(assessmentGapMessage('UNRECOGNIZED', 'vi'), undefined);
});

test('Python compiler/allocation → Node plan → staged Python generation → Node acceptance preserves two assessment instances', { timeout: 30_000 }, async (t) => {
  // Real pure serializers live in the service module. Block external boundaries
  // BEFORE importing it; a regression must never touch the configured database.
  t.mock.method(pg.Pool.prototype, 'query', () => { throw new Error('TEST_DATABASE_ACCESS_FORBIDDEN'); });
  t.mock.method(pg.Pool.prototype, 'connect', () => { throw new Error('TEST_DATABASE_ACCESS_FORBIDDEN'); });
  t.mock.method(globalThis, 'fetch', () => { throw new Error('TEST_HTTP_ACCESS_FORBIDDEN'); });
  const nativeInterval = globalThis.setInterval;
  t.mock.method(globalThis, 'setInterval', (...args: Parameters<typeof setInterval>) => {
    const timer = nativeInterval(...args);
    timer.unref();
    t.after(() => clearInterval(timer));
    return timer;
  });
  const { normalizeLessonAuthorBlueprint, blueprintDraftArchitecture, normalizeLessonAuthorProposal, lockProposalToBlueprintChapter } = await import('./chat.service.js');
  const ragDir = fileURLToPath(new URL('../../../../landa-ai-rag/', import.meta.url));
  const python = process.platform === 'win32' ? resolve(ragDir, '.venv/Scripts/python.exe') : resolve(ragDir, '.venv/bin/python');
  function pythonBoundary(payload: unknown) {
    const result = spawnSync(python, ['-X', 'utf8', '-B', '-m', 'tests.test_component_instance_contract'], {
      cwd: ragDir, input: JSON.stringify(payload), encoding: 'utf8', timeout: 20_000, maxBuffer: 4_000_000,
    });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    return JSON.parse(result.stdout);
  }
  const { blueprint: rawBlueprint, source_map: sourceMapRaw, manifest } = pythonBoundary({ mode: 'compile' });
  // Python V5 Architect output has no CMS plans. Execute the production Node
  // normalizer/planner and the stored-JSON read path, not a parallel test mapper.
  const blueprint = normalizeLessonAuthorBlueprint({ ...rawBlueprint, source_map: sourceMapRaw }, {
    requireContentArchitecture: true, requirePhaseOneContract: true, allowedComponentTypes: allAllowed,
  });
  const stored = normalizeLessonAuthorBlueprint(JSON.parse(JSON.stringify(blueprint)));
  const withPolicy = structuredClone(rawBlueprint);
  withPolicy.source_chapter_policy = { version: 1, mode: 'MODEL_DESIGNED', complete: true, reason_codes: [], chapters: [] };
  const policyNormalized = normalizeLessonAuthorBlueprint({ ...withPolicy, source_map: sourceMapRaw }, { requirePhaseOneContract: true });
  assert.deepEqual(normalizeLessonAuthorBlueprint(JSON.parse(JSON.stringify(policyNormalized))).source_chapter_policy, withPolicy.source_chapter_policy);
  assert.throws(() => normalizeLessonAuthorBlueprint({ ...withPolicy, source_chapter_policy: { ...withPolicy.source_chapter_policy, complete: false } }), { code: 'SOURCE_CHAPTER_POLICY_INVALID' });
  assert.deepEqual(stored.chapters[0]!.lessons[0]!.units[0]!.component_plan, blueprint.chapters[0]!.lessons[0]!.units[0]!.component_plan);
  for (const refs of [[], ['lo_1', 'lo_1']]) {
    const invalid = structuredClone(rawBlueprint);
    invalid.chapters[0].lessons[0].units[0].learning_objective_refs = refs;
    assert.throws(() => normalizeLessonAuthorBlueprint(invalid), { code: 'V5_UNIT_OBJECTIVE_REFS_INVALID' });
  }
  const oversized = structuredClone(rawBlueprint);
  oversized.chapters[0].lessons[0].units[0].learning_blocks = Array.from({ length: 13 }, (_, i) => ({ ...rawBlueprint.chapters[0].lessons[0].units[0].learning_blocks[0], id: `block_${i}` }));
  assert.throws(() => normalizeLessonAuthorBlueprint(oversized), { code: 'V5_LEARNING_BLOCK_CARDINALITY_INVALID' });
  // Preserve VI/EN media artifacts through the actual stored-JSON read path.
  for (const title of ['Safe work demonstration', 'Minh họa làm việc an toàn']) {
    const media = structuredClone(rawBlueprint);
    media.chapters[0].lessons[0].units[0].media_plan = { type: 'video', title,
      content_outline: 'Demonstrate the documented safety sequence.', rationale: 'Show the source-supported procedure.' };
    media.media_review = { version: 'media-review-v1', decisions: [{ unit_path: 'chapter_1.lesson_1.unit_1', status: 'PROPOSED', reason_code: 'SOURCE_SUPPORTED_PROCEDURE' }] };
    const normalizedMedia = normalizeLessonAuthorBlueprint({ ...media, source_map: sourceMapRaw }, { requirePhaseOneContract: true, allowedComponentTypes: allAllowed });
    const storedMedia = normalizeLessonAuthorBlueprint(JSON.parse(JSON.stringify(normalizedMedia)));
    assert.deepEqual(storedMedia.media_review, media.media_review);
    assert.deepEqual(storedMedia.chapters[0].lessons[0].units[0].media_plan, media.chapters[0].lessons[0].units[0].media_plan);
  }
  // Existing specialty descriptors must survive Architect-shaped blocks,
  // normalization and persisted reads; do not force them on unfit material.
  for (const [intent, descriptor, expected] of [
    ['faq', { anticipated_questions: true, question_count: 2 }, 'la_faq'],
    ['relationship_visualization', { relationship_evidence: true }, 'la_diagram'],
    ['terminology_reinforcement', { terminology_count: 3, definitions_supported: true }, 'la_crossword'],
    ['practice', { requires_ordering_practice: true, ordered_sequence: true, sequence_item_count: 3 }, 'la_sortable'],
  ] as const) {
    const specialty = structuredClone(rawBlueprint);
    const u = specialty.chapters[0].lessons[0].units[0];
    const anchor = u.learning_blocks[0];
    u.learning_blocks.push({ ...anchor, id: 'specialty', intent, importance: 'supporting', content: descriptor,
      source_fact_ids: [], primary_evidence_scope_ids: [], primary_concept_ids: [],
      supporting_evidence_scope_ids: anchor.primary_evidence_scope_ids });
    const planned = normalizeLessonAuthorBlueprint({ ...specialty, source_map: sourceMapRaw }, { requirePhaseOneContract: true, allowedComponentTypes: allAllowed });
    const saved = normalizeLessonAuthorBlueprint(JSON.parse(JSON.stringify(planned)));
    assert.deepEqual(saved.chapters[0].lessons[0].units[0].learning_blocks!.at(-1)!.content, descriptor);
    assert.ok(saved.chapters[0].lessons[0].units[0].component_plan.some(p => p.type === expected));
  }
  const sourceMap = normalizeLessonAuthorSourceMap(sourceMapRaw);
  assert.ok(sourceMap);
  const validated = validateLessonAuthorBlueprintArchitecture(blueprint, sourceMap);
  assert.notEqual(validated.status, 'FAIL', JSON.stringify(validated.errors));
  const lesson = blueprint.chapters[0].lessons[0];
  const unit = lesson.units[0];
  assertComponentInstancePlan(unit.component_plan);
  assert.equal(validateLessonAuthorContentContractUnit(unit), null);
  assert.deepEqual(unit.component_plan.map((p: any) => p.type), ['html', 'problem', 'problem']);
  assert.deepEqual(unit.component_plan.slice(1).map((p: any) => p.source_fact_ids), [[], []]);
  const context = { blueprint, chapterIndex: 0 } as Parameters<typeof blueprintDraftArchitecture>[0];
  const architecture = blueprintDraftArchitecture(context);
  manifest.supporting_evidence_facts = manifest.facts;
  const { proposal, provider_calls: calls } = pythonBoundary({ mode: 'draft', architecture, manifest });
  const generated = proposal.chapters[0].lessons[0].units[0];
  assert.equal(calls, 1);
  assert.equal(validateLessonAuthorGeneratedUnitCoverage(unit, generated.components), null);
  assert.deepEqual(generated.components.map((p: any) => p.component_plan_id), unit.component_plan.map((p: any) => p.component_plan_id));
  const normalized = normalizeLessonAuthorProposal(proposal);
  const locked = lockProposalToBlueprintChapter(normalized, context);
  const quality = validateLessonAuthorPedagogicalQuality({ proposal: locked, blueprint_chapter: blueprint.chapters[0] });
  assert.notEqual(quality.status, 'FAIL', JSON.stringify(quality.findings));
  for (const component of locked.chapters[0]!.lessons[0]!.units[0]!.components ?? []) assertAiGeneratedComponentValid(component, allAllowed);
  const duplicatePayload = structuredClone(proposal);
  duplicatePayload.chapters[0].lessons[0].units[0].components.push(generated.components[1]);
  assert.throws(() => normalizeLessonAuthorProposal(duplicatePayload), /INSTANCE_INVALID/);
  const missingIdentity = structuredClone(blueprint);
  delete missingIdentity.chapters[0]!.lessons[0]!.units[0]!.component_plan[1]!.component_plan_id;
  assert.throws(() => normalizeLessonAuthorBlueprint(missingIdentity), /INSTANCE_INVALID/);
  const legacyPayload = structuredClone(proposal);
  legacyPayload.chapters[0].lessons[0].units[0].component_plan = [];
  legacyPayload.chapters[0].lessons[0].units[0].components.forEach((c: any) => { c.component_plan_id = null; });
  assert.doesNotThrow(() => normalizeLessonAuthorProposal(legacyPayload));
  // Real converter acceptance: missing/ambiguous answers must never become
  // "first answer is correct" or manufacture a new dropdown option.
  const questionPayload = (problem: Record<string, unknown>) => {
    const value = structuredClone(legacyPayload);
    value.chapters[0].lessons[0].units[0].components = [value.chapters[0].lessons[0].units[0].components[0], problem];
    return value;
  };
  const mcq = { type: 'problem', problem_type: 'multiple_choice', question: 'Which documented action comes first?', choices: [{ text: 'Check', correct: true }, { text: 'Skip', correct: false }] };
  assert.doesNotThrow(() => normalizeLessonAuthorProposal(questionPayload(mcq)));
  for (const choices of [
    [{ text: 'Check', correct: false }, { text: 'Skip', correct: false }],
    [{ text: 'Check', correct: true }, { text: 'Skip', correct: true }],
    [{ text: 'Check', correct: true }, { text: 'check', correct: false }],
    ['Check', 'Skip'],
  ]) assert.throws(() => normalizeLessonAuthorProposal(questionPayload({ ...mcq, choices })), /PROBLEM_(CORRECT_ANSWER_INVALID|DUPLICATE_CHOICES)/);
  const dropdown = { type: 'problem', problem_type: 'dropdown', question: 'Which action?', options: ['Check', 'Skip'], answer: 'Check' };
  assert.doesNotThrow(() => normalizeLessonAuthorProposal(questionPayload(dropdown)));
  for (const answer of ['', 'Invented option']) assert.throws(() => normalizeLessonAuthorProposal(questionPayload({ ...dropdown, answer })), /PROBLEM_CORRECT_ANSWER_INVALID/);
  const faq = { type: 'la_faq', items: [{ question: 'When?', answer: 'Before the task.' }, { question: 'Why?', answer: 'To check conditions.' }] };
  const faqFirst = questionPayload(mcq);
  faqFirst.chapters[0].lessons[0].units[0].components.unshift(faq);
  const ordered = normalizeLessonAuthorProposal(faqFirst).chapters[0]!.lessons[0]!.units[0]!.components!;
  assert.equal(ordered.at(-1)!.type, 'la_faq');
  const faqBlueprint = structuredClone(blueprint);
  const faqLesson = faqBlueprint.chapters[0]!.lessons[0]!;
  const faqUnit = faqLesson.units[0]!;
  const teaching = faqUnit.learning_blocks!.find((b: any) => b.intent !== 'knowledge_check')!;
  faqLesson.assessment_required = false;
  faqLesson.assessment_objective_refs = [];
  faqUnit.learning_blocks = faqUnit.learning_blocks!.filter((b: any) => b.intent !== 'knowledge_check');
  faqUnit.learning_blocks.push(
    { ...structuredClone(teaching), id: 'faq_support', intent: 'faq', importance: 'core', source_fact_ids: [], primary_evidence_scope_ids: [], supporting_evidence_scope_ids: teaching.primary_evidence_scope_ids, content: { anticipated_questions: true, question_count: 2 } },
    { ...structuredClone(teaching), id: 'diagram_support', intent: 'relationship_visualization', importance: 'supporting', source_fact_ids: [], primary_evidence_scope_ids: [], supporting_evidence_scope_ids: teaching.primary_evidence_scope_ids, content: { relationship_evidence: true } },
  );
  const faqPlanned = normalizeLessonAuthorBlueprint(faqBlueprint, { requirePhaseOneContract: true, allowedComponentTypes: allAllowed }).chapters[0]!.lessons[0]!.units[0]!.component_plan;
  assert.deepEqual(faqPlanned.map(p => p.type), ['html', 'la_diagram', 'la_faq']);
  const typedFixtures = spawnSync(python, ['-X', 'utf8', '-B', '-c',
    'import json; from tests.test_staged_lesson_provider_boundary import StagedLessonProviderBoundaryTests; from app.main import staged_component_payload_code; p=StagedLessonProviderBoundaryTests.payloads(); assert all(staged_component_payload_code(c) is None for c in p); print(json.dumps(p))',
  ], { cwd: ragDir, encoding: 'utf8', timeout: 20_000, maxBuffer: 1_000_000 });
  assert.equal(typedFixtures.status, 0, typedFixtures.stderr);
  for (const fixture of JSON.parse(typedFixtures.stdout)) {
    const accepted = normalizeLessonAuthorProposal(questionPayload(fixture));
    for (const component of accepted.chapters[0]!.lessons[0]!.units[0]!.components!) {
      assertAiGeneratedComponentValid(component, allAllowed);
    }
  }
  const swapped = structuredClone(generated.components);
  [swapped[1], swapped[2]] = [swapped[2], swapped[1]];
  assert.match(validateLessonAuthorGeneratedUnitCoverage(unit, swapped)!, /instance/);
});

test('real Python Blueprint endpoint depth repair → Node acceptance → chapter drafting → proposal validation', { timeout: 30_000 }, async (t) => {
  t.mock.method(pg.Pool.prototype, 'query', () => { throw new Error('TEST_DATABASE_ACCESS_FORBIDDEN'); });
  t.mock.method(pg.Pool.prototype, 'connect', () => { throw new Error('TEST_DATABASE_ACCESS_FORBIDDEN'); });
  t.mock.method(globalThis, 'fetch', () => { throw new Error('TEST_HTTP_ACCESS_FORBIDDEN'); });
  const nativeInterval = globalThis.setInterval;
  t.mock.method(globalThis, 'setInterval', (...args: Parameters<typeof setInterval>) => {
    const timer = nativeInterval(...args); timer.unref(); t.after(() => clearInterval(timer)); return timer;
  });
  const { normalizeLessonAuthorBlueprint, blueprintDraftArchitecture, normalizeLessonAuthorProposal, lockProposalToBlueprintChapter } = await import('./chat.service.js');
  const cwd = fileURLToPath(new URL('../../../../landa-ai-rag/', import.meta.url));
  const python = resolve(cwd, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
  const response = spawnSync(python, ['-X', 'utf8', '-B', '-m', 'tests.test_v5_repair_contract_integration', '--node-fixture'], {
    cwd, encoding: 'utf8', timeout: 20_000, maxBuffer: 4_000_000,
  });
  assert.equal(response.status, 0, response.error?.message ?? response.stderr);
  const raw = JSON.parse(response.stdout);
  assert.equal(raw.workflow.repair_provider_calls, 1);
  const blueprint = normalizeLessonAuthorBlueprint({ ...raw.blueprint, source_map: raw.source_map }, {
    requireContentArchitecture: true, requirePhaseOneContract: true, allowedComponentTypes: allAllowed,
  });
  let writes = 0;
  // Production acceptance gate, deliberately fake persistence. No database.
  const stored = await acceptAndPersistLessonAuthorBlueprint(blueprint, blueprint.source_map, () => {}, async validation => {
    assert.notEqual(validation.status, 'FAIL'); writes++;
    return normalizeLessonAuthorBlueprint(JSON.parse(JSON.stringify(blueprint)));
  });
  assert.equal(writes, 1);
  assert.equal(stored.source_fact_allocation!.allocated_count, 371);
  const context = { blueprint: stored, chapterIndex: 0 } as Parameters<typeof blueprintDraftArchitecture>[0];
  const architecture = blueprintDraftArchitecture(context);
  const unit = stored.chapters[0].lessons[0].units[0];
  assert.ok(unit.learning_blocks!.some(b => b.intent === 'worked_example' && b.source_fact_ids.length === 0));
  assert.equal(validateLessonAuthorContentContractUnit(unit), null);
  const ownedIds = new Set(unit.source_fact_ids);
  const manifest = { ...raw.test_manifest, facts: raw.test_manifest.facts.filter((f: any) => ownedIds.has(f.fact_id)) };
  manifest.supporting_evidence_facts = manifest.facts;
  const draft = spawnSync(python, ['-X', 'utf8', '-B', '-m', 'tests.test_component_instance_contract'], {
    cwd, input: JSON.stringify({ mode: 'draft', architecture, manifest }), encoding: 'utf8', timeout: 20_000, maxBuffer: 4_000_000,
  });
  assert.equal(draft.status, 0, draft.error?.message ?? draft.stderr);
  const { proposal } = JSON.parse(draft.stdout);
  assert.equal(validateLessonAuthorGeneratedUnitCoverage(unit, proposal.chapters[0].lessons[0].units[0].components), null);
  // Normalization moves instance/provenance into component.metadata; the
  // production lock reads that storage shape and revalidates it internally.
  const locked = lockProposalToBlueprintChapter(normalizeLessonAuthorProposal(proposal), context);
  const components = locked.chapters[0]!.lessons[0]!.units[0]!.components ?? [];
  for (const component of components) assertAiGeneratedComponentValid(component, allAllowed);
  const quality = validateLessonAuthorPedagogicalQuality({ proposal: locked, blueprint_chapter: stored.chapters[0] });
  assert.notEqual(quality.status, 'FAIL', JSON.stringify(quality.findings));
  const invalid = structuredClone(stored);
  const invalidUnit = invalid.chapters[0].lessons[0].units[0];
  assert.ok(invalidUnit.source_fact_ids);
  invalidUnit.source_fact_ids.push('unknown-fact');
  await assert.rejects(acceptAndPersistLessonAuthorBlueprint(invalid, invalid.source_map, () => {}, async () => { writes++; }));
  assert.equal(writes, 1, 'invalid blueprint must never reach persistence');
});

function block(
  intent: SemanticLearningBlock['intent'],
  content: Record<string, unknown> = {},
): SemanticLearningBlock {
  return {
    id: `lb-${intent}`,
    intent,
    importance: intent === 'knowledge_check' ? 'assessment' : 'core',
    content,
    source_fact_ids: sourceFacts,
  };
}

test('selection diagnostics explain six types without private block content or identifiers', () => {
  for (const [intent, content, expected] of [
    ['concept_explanation', {}, 'html'], ['knowledge_check', {}, 'problem'],
    ['faq', { anticipated_questions: true, question_count: 2 }, 'la_faq'],
    ['relationship_visualization', { relationship_evidence: true }, 'la_diagram'],
    ['terminology_reinforcement', { terminology_count: 3, definitions_supported: true }, 'la_crossword'],
    ['practice', { requires_ordering_practice: true, ordered_sequence: true, sequence_item_count: 3 }, 'la_sortable'],
  ] as const) {
    const events: ComponentPlannerDiagnostic[] = [];
    const b = { ...block(intent, { ...content, title: 'PRIVATE_SENTINEL', prompt: 'PRIVATE_SENTINEL' }), id: 'PRIVATE_SENTINEL' };
    const input = { blocks: [b], unit_source_fact_ids: sourceFacts, allowed_component_types: allAllowed,
      component_capabilities: createComponentCapabilities(allAllowed), unit_path: 'chapter_1.lesson_1.unit_1' };
    const baseline = planSemanticLearningBlocks(input);
    assert.deepEqual(planSemanticLearningBlocks({ ...input, on_diagnostics: e => events.push(e) }), baseline);
    assert.equal(events[0].decisions[0].selected_type, expected);
    assert.equal(events[0].decisions[0].tenant_permitted, true);
    assert.equal(events[0].status, 'PASS');
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE_SENTINEL/);
    assert.deepEqual(planSemanticLearningBlocks({ ...input, on_diagnostics: () => { throw new Error('log sink'); } }), baseline);
  }
});

test('selection diagnostics retain insufficient evidence, tenant and capacity reasons without changing policy', () => {
  const events: ComponentPlannerDiagnostic[] = [];
  const input = { unit_source_fact_ids: sourceFacts, unit_path: 'chapter_1.lesson_1.unit_1',
    component_capabilities: createComponentCapabilities(allAllowed), on_diagnostics: (e: ComponentPlannerDiagnostic) => events.push(e) };
  planSemanticLearningBlocks({ ...input, blocks: [block('faq')] });
  assert.equal(events.at(-1)!.decisions[0].reason_code, 'INSUFFICIENT_EVIDENCE_FALLBACK');
  assert.equal(events.at(-1)!.decisions[0].descriptor_eligible, false);
  const optionalFaq = { ...block('faq', { anticipated_questions: true }), importance: 'supporting' as const };
  planSemanticLearningBlocks({ ...input, blocks: [optionalFaq], allowed_component_types: new Set(['html']) });
  assert.equal(events.at(-1)!.decisions[0].reason_code, 'TENANT_CAPABILITY_FALLBACK');
  assert.equal(events.at(-1)!.decisions[0].tenant_permitted, false);
  const checks = [1, 2, 3].map(n => ({ ...block('knowledge_check'), id: `check_${n}` }));
  planSemanticLearningBlocks({ ...input, blocks: [...checks, optionalFaq] });
  assert.equal(events.at(-1)!.decisions.at(-1)!.reason_code, 'OPTIONAL_TREATMENT_HTML_FALLBACK');
  assert.throws(() => planSemanticLearningBlocks({ ...input, blocks: [...checks, block('faq', { anticipated_questions: true })] }), /MANDATORY_COMPONENT_CAPACITY_EXCEEDED/);
  assert.equal(events.at(-1)!.status, 'FAIL');
  assert.equal(events.at(-1)!.failure_code, 'MANDATORY_COMPONENT_CAPACITY_EXCEEDED');
  assert.throws(() => planSemanticLearningBlocks({ ...input, blocks: checks, allowed_component_types: new Set(['html']) }), /TENANT_CAPABILITY_GAP/);
  const many = Array.from({ length: 20 }, (_, i) => ({ ...block('concept_explanation'), id: `safe_${i}` }));
  planSemanticLearningBlocks({ ...input, blocks: many });
  assert.equal(events.at(-1)!.decisions.length, 12);
  assert.equal(events.at(-1)!.omitted_block_count, 8);
});

function planFor(blocks: SemanticLearningBlock[], allowed = allAllowed) {
  return planSemanticLearningBlocks({
    blocks,
    unit_source_fact_ids: sourceFacts,
    allowed_component_types: allowed,
  });
}

test('registry classifies every editor component exactly once', () => {
  assert.doesNotThrow(assertAiComponentRegistryCoverage);
  assert.deepEqual(Object.keys(AI_COMPONENT_REGISTRY).sort(), [...COURSE_COMPONENT_TYPES].sort());
  assert.equal(AI_COMPONENT_REGISTRY.html.generation_mode, 'AI_GENERATABLE');
  assert.equal(AI_COMPONENT_REGISTRY.la_media_quiz.generation_mode, 'AI_GENERATABLE_WITH_EXISTING_ASSET');
  assert.equal(AI_COMPONENT_REGISTRY.la_scenario_chat.generation_mode, 'MANUAL_ONLY');
  assert.equal(AI_COMPONENT_REGISTRY.video.generation_mode, 'REFERENCE_ONLY');
  assert.equal(AI_COMPONENT_REGISTRY.la_pdf.generation_mode, 'REFERENCE_ONLY');
});

test('planner maps knowledge check to problem with a stable reason code', () => {
  const planned = planFor([block('knowledge_check')]);
  assert.deepEqual(planned.map(item => item.type), ['html', 'problem']);
  assert.equal(planned[1]?.reason_code, 'ASSESS_OBJECTIVE');
});

test('planner maps anticipated FAQ to FAQ and does not use FAQ as generic text', () => {
  const valid = planFor([block('faq', { anticipated_questions: true, question_count: 2 })]);
  assert.deepEqual(valid.map(item => item.type), ['html', 'la_faq']);
  assert.equal(valid[1]?.reason_code, 'FAQ_ANTICIPATED_QUESTIONS');

  const generic = planFor([block('faq')]);
  assert.deepEqual(generic.map(item => item.type), ['html']);
});

test('planner maps evidence-backed relationship visualization to diagram only', () => {
  const planned = planFor([block('relationship_visualization', { relationship_evidence: true, nodes: ['A', 'B'] })]);
  assert.deepEqual(planned.map(item => item.type), ['html', 'la_diagram']);
  assert.equal(planned[1]?.reason_code, 'RELATIONSHIP_VISUALIZATION');
});

test('mandatory assessment does not suppress one evidence-backed instructional treatment', () => {
  const diagramAndCheck = planFor([
    block('concept_explanation'),
    block('relationship_visualization', { relationship_evidence: true, relationship_count: 2 }),
    block('knowledge_check'),
  ]);
  assert.deepEqual(diagramAndCheck.map(item => item.type), ['html', 'problem', 'la_diagram']);

  const sortableAndCheck = planFor([
    block('practice', {
      requires_ordering_practice: true,
      ordered_sequence: true,
      sequence_item_count: 4,
    }),
    block('knowledge_check'),
  ]);
  assert.deepEqual(sortableAndCheck.map(item => item.type), ['html', 'problem', 'la_sortable']);
  assert.equal(sortableAndCheck.length, 3);
});

test('optional treatments remain bounded and pedagogical priority beats variety', () => {
  const planned = planFor([
    block('relationship_visualization', { relationship_evidence: true, relationship_count: 2 }),
    block('practice', { requires_ordering_practice: true, ordered_sequence: true, sequence_item_count: 3 }),
    block('faq', { anticipated_questions: true, question_count: 2 }),
    block('knowledge_check'),
  ]);
  assert.deepEqual(planned.map(item => item.type), ['html', 'problem', 'la_diagram']);
});

test('planner maps terminology reinforcement to crossword only with adequate definitions', () => {
  const planned = planFor([block('terminology_reinforcement', { terminology_count: 3, definitions_supported: true })]);
  assert.deepEqual(planned.map(item => item.type), ['html', 'la_crossword']);

  const insufficient = planFor([block('terminology_reinforcement', { terminology_count: 2, definitions_supported: true })]);
  assert.deepEqual(insufficient.map(item => item.type), ['html']);
});

test('a procedure remains explanatory while ordering practice selects sortable', () => {
  assert.deepEqual(planFor([block('procedure', { sequence_item_count: 5 })]).map(item => item.type), ['html']);
  const orderedPractice = planFor([block('practice', {
    requires_ordering_practice: true,
    ordered_sequence: true,
    sequence_item_count: 3,
  })]);
  assert.deepEqual(orderedPractice.map(item => item.type), ['html', 'la_sortable']);
  assert.equal(orderedPractice[1]?.reason_code, 'ORDERING_PRACTICE');
});

test('manual scenario and media reference never cause an AI asset/component fabrication', () => {
  assert.deepEqual(planFor([block('scenario')]).map(item => item.type), ['html']);
  assert.deepEqual(planFor([block('media_reference', { asset_url: 'https://made-up.invalid/video.mp4' })]).map(item => item.type), ['html']);
  assert.equal(AI_COMPONENT_REGISTRY.video.ai_generatable, false);
  assert.equal(AI_COMPONENT_REGISTRY.la_media_quiz.ai_generatable, false);
  assert.equal(AI_COMPONENT_REGISTRY.la_image_choice_quiz.ai_generatable, false);
  assert.equal(AI_COMPONENT_REGISTRY.la_pdf.ai_generatable, false);
});

test('tenant capability is intersected before selection and rechecked by validation', () => {
  const onlyHtml = new Set(['html'] as const);
  const planned = planFor([block('knowledge_check')], onlyHtml);
  assert.deepEqual(planned.map(item => item.type), ['html']);
  assert.equal(planned[0]?.reason_code, 'TENANT_CAPABILITY_FALLBACK');
  assert.throws(() => assertAiGeneratedComponentValid(problemComponent(), onlyHtml), /Tenant does not permit/);
});

test('semantic blocks reject duplicate IDs and facts outside the unit', () => {
  assert.throws(() => normalizeSemanticLearningBlocks([
    { id: 'same', intent: 'concept_explanation', importance: 'core', content: {}, source_fact_ids: ['fact-1'] },
    { id: 'same', intent: 'summary', importance: 'core', content: {}, source_fact_ids: ['fact-2'] },
  ], sourceFacts), /duplicated/);
  assert.throws(() => normalizeSemanticLearningBlocks([
    { id: 'outside', intent: 'concept_explanation', importance: 'core', content: {}, source_fact_ids: ['fact-404'] },
  ], sourceFacts), /outside its unit/);
});

test('server-owned Blueprint facts retain a valid 233-ID allocation and reject overflow explicitly', () => {
  const factIds = Array.from({ length: 233 }, (_value, index) => `fact-${index + 1}`);
  const blocks = normalizeSemanticLearningBlocks([{
    id: 'large-scope', intent: 'concept_explanation', importance: 'core', content: {}, source_fact_ids: factIds,
    concept_ids: ['concept-hse'], primary_concept_ids: ['concept-hse'], source_refs: ['src-003'],
  }], factIds);
  assert.equal(blocks[0]?.source_fact_ids.length, 233);
  assert.deepEqual(blocks[0]?.concept_ids, ['concept-hse']);
  assert.deepEqual(blocks[0]?.primary_concept_ids, ['concept-hse']);
  assert.throws(() => normalizeSemanticLearningBlocks([{
    id: 'overflow', intent: 'concept_explanation', importance: 'core', content: {},
    source_fact_ids: Array.from({ length: MAX_SERVER_OWNED_SOURCE_FACT_IDS_PER_SCOPE + 1 }, (_value, index) => `fact-${index + 1}`),
  }]), /exceeds/);
});

test('semantic explanatory content is deterministically rendered and safely escaped', () => {
  const html = renderSemanticLearningHtml({
    heading: 'Quy tắc <khẩn>',
    paragraphs: ['Không dùng <script>alert(1)</script>.'],
    ordered_steps: ['Bước 1', 'Bước 2'],
    warnings: ['Không bỏ qua điều kiện.'],
    comparison_rows: [{ label: 'Giới hạn', value: '< 10 phút' }],
  });
  assert.match(html ?? '', /<h2>Quy tắc &lt;khẩn&gt;<\/h2>/);
  assert.match(html ?? '', /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html ?? '', /<script/i);
  assert.doesNotThrow(() => assertAiGeneratedComponentValid(htmlComponent(html ?? ''), allAllowed));
});

test('semantic explanatory content rejects oversize payloads before render can lose evidence', () => {
  const oversizedSteps = Array.from({ length: 21 }, (_value, index) => `Bước ${index + 1}`);
  assert.match(
    validateSemanticLearningHtmlPayload({ ordered_steps: oversizedSteps }) ?? '',
    /exceeds the 20-item render limit/,
  );
  assert.throws(
    () => renderSemanticLearningHtml({ comparison_rows: [{ label: 'L'.repeat(501), value: 'Giá trị' }] }),
    /not lossless/,
  );
});

test('semantic explanatory content rejects unknown or empty fields with no renderable text', () => {
  assert.match(
    validateSemanticLearningHtmlPayload({ source_fact_ids: ['fact-1'] }) ?? '',
    /no renderer-visible text/,
  );
  assert.throws(
    () => renderSemanticLearningHtml({ paragraphs: [], comparison_rows: [] }),
    /not lossless/,
  );
});

function htmlComponent(data = '<p>Nội dung hợp lệ.</p>'): LessonAuthorComponentProposal {
  return { type: 'html', title: 'HTML', data };
}

function problemComponent(): LessonAuthorComponentProposal {
  return {
    type: 'problem',
    title: 'Kiểm tra',
    data: '<problem><multiplechoiceresponse><label>Câu hỏi?</label><choicegroup><choice correct="true">A</choice><choice correct="false">B</choice></choicegroup></multiplechoiceresponse></problem>',
  };
}

function faqComponent(): LessonAuthorComponentProposal {
  return {
    type: 'la_faq', title: 'FAQ', data: { faq_data: JSON.stringify({ items: [{ question: 'Q1', answer: 'A1' }, { question: 'Q2', answer: 'A2' }] }) },
    metadata: { faq_data: { items: [{ question: 'Q1', answer: 'A1' }, { question: 'Q2', answer: 'A2' }] } },
  };
}

function sortableComponent(): LessonAuthorComponentProposal {
  const items = [{ id: 1, text: 'Bước một' }, { id: 2, text: 'Bước hai' }, { id: 3, text: 'Bước ba' }];
  return {
    type: 'la_sortable', title: 'Sắp xếp', data: { question_text: 'Sắp xếp theo thứ tự.', sortable_data: JSON.stringify({ items }) },
    metadata: { question_text: 'Sắp xếp theo thứ tự.', sortable_data: { items } },
  };
}

function crosswordComponent(): LessonAuthorComponentProposal {
  const words = [
    { id: 1, answer: 'TERM', clue: 'Định nghĩa 1' },
    { id: 2, answer: 'FACT', clue: 'Định nghĩa 2' },
    { id: 3, answer: 'RULE', clue: 'Định nghĩa 3' },
  ];
  return {
    type: 'la_crossword', title: 'Thuật ngữ', data: { crossword_data: JSON.stringify({ words }) },
    metadata: { crossword_data: { words } },
  };
}

function diagramComponent(): LessonAuthorComponentProposal {
  const diagramData = {
    diagrams: [{
      id: 'main', name: 'Quan hệ',
      nodes: [
        { id: 'a', type: 'customShape', position: { x: 0, y: 0 }, data: { label: 'A' } },
        { id: 'b', type: 'customShape', position: { x: 240, y: 0 }, data: { label: 'B' } },
      ],
      edges: [{ id: 'edge', source: 'a', target: 'b' }],
    }],
    start_diagram_id: 'main',
  };
  return { type: 'la_diagram', title: 'Quan hệ', data: { diagram_data: JSON.stringify(diagramData) }, metadata: { diagram_data: diagramData } };
}

test('each Phase-2 AI-enabled component accepts its normalized real payload contract', () => {
  for (const component of [htmlComponent(), problemComponent(), faqComponent(), sortableComponent(), crosswordComponent(), diagramComponent()]) {
    assert.doesNotThrow(() => assertAiGeneratedComponentValid(component, allAllowed), component.type);
  }
});

test('component validators reject unsafe or structurally incomplete payloads', () => {
  assert.throws(() => assertAiGeneratedComponentValid(htmlComponent('<p>Safe</p><img src="https://asset.invalid/a.png">'), allAllowed), /asset|media/i);
  assert.throws(() => assertAiGeneratedComponentValid({ ...problemComponent(), data: '<problem><label>Thiếu</label>' }, allAllowed), /complete Open edX/);
  assert.throws(() => assertAiGeneratedComponentValid({ ...faqComponent(), metadata: { faq_data: { items: [{ question: 'Only', answer: 'One' }] } } }, allAllowed), /at least two/);
  assert.throws(() => assertAiGeneratedComponentValid({ ...sortableComponent(), metadata: { question_text: 'Q', sortable_data: { items: [{ text: '1' }, { text: '2' }] } } }, allAllowed), /at least three/);
  assert.throws(() => assertAiGeneratedComponentValid({ ...crosswordComponent(), metadata: { crossword_data: { words: [{ answer: 'A', clue: '' }] } } }, allAllowed), /at least three/);
  assert.throws(() => assertAiGeneratedComponentValid({ ...diagramComponent(), metadata: { diagram_data: { diagrams: [{ id: 'only', nodes: [{ id: 'a' }], edges: [] }], start_diagram_id: 'only' } } }, allAllowed), /at least two/);
});
