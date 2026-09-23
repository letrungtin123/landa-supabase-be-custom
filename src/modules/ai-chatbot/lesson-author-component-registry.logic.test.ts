import assert from 'node:assert/strict';
import test from 'node:test';
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
} from './lesson-author-component-registry.logic.js';

const sourceFacts = ['fact-1', 'fact-2', 'fact-3'];
const allAllowed = new Set(COURSE_COMPONENT_TYPES);

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
