import assert from 'node:assert/strict';
import test from 'node:test';
import type { LessonAuthorProposal } from '../course-authoring/course-authoring.service.js';
import {
  assertLessonAuthorPedagogicalQuality,
  detectLessonAuthorGeneratedContentDuplicates,
  validateLessonAuthorPedagogicalQuality,
  type LessonAuthorPedagogicalBlueprintChapter,
} from './lesson-author-pedagogical-validator.logic.js';

const explanatoryText = [
  'Người học xác định đúng thiết bị bảo hộ trước khi bắt đầu công việc.',
  'Thiết bị phù hợp giảm tiếp xúc với rủi ro đã được tài liệu mô tả.',
  'Kiểm tra điều kiện sử dụng trước khi thực hiện từng bước.',
  'Không bỏ qua cảnh báo hoặc thay thế thiết bị bằng lựa chọn không được phê duyệt.',
].join(' ');

function html(facts = ['fact-1', 'fact-2'], text = explanatoryText) {
  return {
    type: 'html' as const,
    title: 'Giải thích',
    data: `<p>${text}</p>`,
    metadata: { source_fact_ids: facts, covered_source_fact_ids: facts },
  };
}

function problem(facts = ['fact-1']) {
  return {
    type: 'problem' as const,
    title: 'Kiểm tra',
    data: '<problem><multiplechoiceresponse><label>Thiết bị nào cần kiểm tra trước khi làm việc?</label><choicegroup><choice correct="true">Thiết bị bảo hộ</choice><choice correct="false">Vật dụng không liên quan</choice></choicegroup></multiplechoiceresponse></problem>',
    metadata: { source_fact_ids: facts, covered_source_fact_ids: facts },
  };
}

function proposal(units: Array<Record<string, unknown>>): LessonAuthorProposal {
  return {
    summary: 'Đề xuất chờ duyệt.',
    chapters: [{ title: 'An toàn', lessons: [{ title: 'Chuẩn bị', units: units as any }] }],
  };
}

function unit(components: unknown[], facts = ['fact-1', 'fact-2']) {
  return { title: 'Thiết bị bảo hộ', source_fact_ids: facts, components };
}

function blueprint(overrides: Partial<LessonAuthorPedagogicalBlueprintChapter['lessons'][number]> = {}): LessonAuthorPedagogicalBlueprintChapter {
  return {
    lessons: [{
      title: 'Chuẩn bị',
      learning_objectives: ['Xác định thiết bị bảo hộ phù hợp.'],
      assessment_required: true,
      assessment_objective_refs: ['lo_1'],
      units: [{
        title: 'Thiết bị bảo hộ',
        concept_ids: ['concept-ppe'],
        learning_objective_refs: ['lo_1'],
        source_fact_ids: ['fact-1', 'fact-2'],
        learning_blocks: [
          { id: 'lb-explain', intent: 'concept_explanation', learning_objective_refs: ['lo_1'], source_fact_ids: ['fact-1', 'fact-2'] },
          { id: 'lb-check', intent: 'knowledge_check', learning_objective_refs: ['lo_1'], source_fact_ids: ['fact-1'] },
        ],
        component_plan: [
          { type: 'html', source_fact_ids: ['fact-1', 'fact-2'], reason_code: 'EXPLANATION_DEFAULT', learning_block_ids: ['lb-explain'] },
          { type: 'problem', source_fact_ids: ['fact-1'], reason_code: 'ASSESS_OBJECTIVE', learning_block_ids: ['lb-check'] },
        ],
      }],
      ...overrides,
    }],
  };
}

test('pedagogical validator accepts taught, assessed, source-covered lesson', () => {
  const report = validateLessonAuthorPedagogicalQuality({
    proposal: proposal([unit([html(), problem()])]),
    blueprint_chapter: blueprint(),
  });
  assert.equal(report.status, 'PASS');
  assert.equal(report.scores.objective_coverage, 1);
  assert.equal(report.scores.source_coverage, 1);
  assert.equal(report.scores.assessment_alignment, 1);
});

test('pedagogical validator detects missing source coverage and an unaligned assessment', () => {
  const candidate = proposal([unit([
    html(['fact-1']),
    problem(['fact-3']),
  ])]);
  const report = validateLessonAuthorPedagogicalQuality({ proposal: candidate, blueprint_chapter: blueprint() });
  assert.equal(report.status, 'FAIL');
  assert.ok(report.findings.some(item => item.code === 'SOURCE_FACT_NOT_TAUGHT'));
  assert.ok(report.findings.some(item => item.code === 'ASSESSMENT_NOT_ALIGNED'));
});

test('complex lesson with a generic paragraph is marked too thin', () => {
  const shallow = proposal([unit([
    html(['fact-1', 'fact-2'], 'Thiết bị bảo hộ rất quan trọng.'),
    problem(),
  ])]);
  const report = validateLessonAuthorPedagogicalQuality({ proposal: shallow, blueprint_chapter: blueprint() });
  assert.ok(report.findings.some(item => item.code === 'INSUFFICIENT_INSTRUCTIONAL_DEPTH'));
});

test('component purpose must remain aligned to an approved learning treatment', () => {
  const incorrectPurpose = blueprint({
    units: [{
      title: 'Thiết bị bảo hộ',
      learning_objective_refs: ['lo_1'],
      source_fact_ids: ['fact-1', 'fact-2'],
      component_plan: [{ type: 'la_sortable', reason_code: 'EXPLANATION_DEFAULT', learning_block_ids: ['lb-explain'] }],
    }],
  });
  const report = validateLessonAuthorPedagogicalQuality({ proposal: proposal([unit([html(), problem()])]), blueprint_chapter: incorrectPurpose });
  assert.ok(report.findings.some(item => item.code === 'COMPONENT_PURPOSE_INVALID'));
});

test('detector catches duplicated explanatory content and quiz question', () => {
  const duplicated = proposal([
    unit([html(), problem()]),
    unit([html(['fact-1', 'fact-2']), problem(['fact-1'])]),
  ]);
  const findings = detectLessonAuthorGeneratedContentDuplicates(duplicated);
  assert.ok(findings.some(item => item.code === 'DUPLICATE_EXPLANATION'));
  assert.ok(findings.some(item => item.code === 'DUPLICATE_QUIZ_QUESTION'));
});

test('teach then knowledge check is intentional reinforcement, not duplicate prose', () => {
  const findings = detectLessonAuthorGeneratedContentDuplicates(proposal([unit([html(), problem()])]));
  assert.equal(findings.length, 0);
  assert.doesNotThrow(() => assertLessonAuthorPedagogicalQuality({
    proposal: proposal([unit([html(), problem()])]),
    blueprint_chapter: blueprint(),
  }));
});
