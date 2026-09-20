import assert from 'node:assert/strict';
import test from 'node:test';
import {
  completeLessonAuthorContentContract,
  sanitizeLessonAuthorHtml,
  shouldUseBoundedLessonAuthorGeneration,
  validateLessonAuthorContentContractUnit,
  validateLessonAuthorGeneratedUnitCoverage,
  validateLessonAuthorHtmlContract,
} from './lesson-author-content-contract.logic.js';

const sourceFacts = ['p1-f1', 'p1-f2'];

function phaseOnePlan() {
  return completeLessonAuthorContentContract({
    source_fact_ids: sourceFacts,
    component_plan: [
      {
        type: 'html',
        title: 'Giải thích',
        rationale: 'Diễn giải nguồn.',
        required_artifacts: [{ type: 'ordered_list', minimum_items: 3 }, { type: 'warning' }],
      },
      { type: 'problem', title: 'Kiểm tra', rationale: 'Kiểm tra hiểu.' },
    ],
  });
}

test('rejects a component fact ID outside its unit', () => {
  const failure = validateLessonAuthorContentContractUnit({
    source_fact_ids: ['p1-f1'],
    component_plan: [{ type: 'html', source_fact_ids: ['p2-f1'] }],
  });
  assert.match(failure ?? '', /outside its unit/);
});

test('rejects a unit source fact without an owning component', () => {
  const failure = validateLessonAuthorContentContractUnit({
    source_fact_ids: sourceFacts,
    component_plan: [{ type: 'html', source_fact_ids: ['p1-f1'] }],
  });
  assert.match(failure ?? '', /no owning component/);
});

test('rejects generated component topology that changes the Blueprint', () => {
  const failure = validateLessonAuthorGeneratedUnitCoverage(
    { source_fact_ids: sourceFacts, component_plan: phaseOnePlan() },
    [{
      type: 'html',
      source_fact_ids: sourceFacts,
      covered_source_fact_ids: sourceFacts,
      html: '<p>Nội dung hợp lệ.</p>',
    }],
  );
  assert.match(failure ?? '', /count does not match/);
});

test('rejects a required procedure when its step count is lost', () => {
  const plan = phaseOnePlan();
  const failure = validateLessonAuthorGeneratedUnitCoverage(
    { source_fact_ids: sourceFacts, component_plan: plan },
    [
      {
        type: 'html',
        source_fact_ids: sourceFacts,
        covered_source_fact_ids: sourceFacts,
        html: '<h2>Quy trình</h2><ol><li>Bước một</li><li>Bước hai</li></ol><blockquote>Lưu ý bắt buộc.</blockquote>',
      },
      {
        type: 'problem',
        source_fact_ids: ['p1-f1'],
        covered_source_fact_ids: ['p1-f1'],
      },
    ],
  );
  assert.match(failure ?? '', /ordered_list/);
});

test('rejects a required warning that has been flattened into prose', () => {
  const plan = phaseOnePlan();
  const failure = validateLessonAuthorGeneratedUnitCoverage(
    { source_fact_ids: sourceFacts, component_plan: plan },
    [
      {
        type: 'html',
        source_fact_ids: sourceFacts,
        covered_source_fact_ids: sourceFacts,
        html: '<h2>Quy trình</h2><ol><li>Bước một</li><li>Bước hai</li><li>Bước ba</li></ol><p>Cảnh báo quan trọng.</p>',
      },
      {
        type: 'problem',
        source_fact_ids: ['p1-f1'],
        covered_source_fact_ids: ['p1-f1'],
      },
    ],
  );
  assert.match(failure ?? '', /warning/);
});

test('sanitizes unsupported HTML and rejects malformed semantic HTML', () => {
  assert.equal(sanitizeLessonAuthorHtml('<div onclick="bad()"><p>Nội dung</p></div>'), '<p>Nội dung</p>');
  assert.match(validateLessonAuthorHtmlContract('<h2>Tiêu đề</h3>') ?? '', /invalid h3 nesting/);
});

test('requires declared component coverage for every owned source fact', () => {
  const failure = validateLessonAuthorGeneratedUnitCoverage(
    { source_fact_ids: sourceFacts, component_plan: phaseOnePlan() },
    [
      {
        type: 'html',
        source_fact_ids: sourceFacts,
        covered_source_fact_ids: ['p1-f1'],
        html: '<h2>Quy trình</h2><ol><li>Một</li><li>Hai</li><li>Ba</li></ol><blockquote>Lưu ý.</blockquote>',
      },
      {
        type: 'problem',
        source_fact_ids: ['p1-f1'],
        covered_source_fact_ids: ['p1-f1'],
      },
    ],
  );
  assert.match(failure ?? '', /omitted its required source facts/);
});

test('accepts a valid Phase-1 proposal before the existing Apply path persists it', () => {
  const plan = phaseOnePlan();
  const failure = validateLessonAuthorGeneratedUnitCoverage(
    { source_fact_ids: sourceFacts, component_plan: plan },
    [
      {
        type: 'html',
        source_fact_ids: sourceFacts,
        covered_source_fact_ids: sourceFacts,
        html: '<h2>Quy trình</h2><ol><li>Bước một</li><li>Bước hai</li><li>Bước ba</li></ol><blockquote>Lưu ý bắt buộc.</blockquote>',
      },
      {
        type: 'problem',
        source_fact_ids: ['p1-f1'],
        covered_source_fact_ids: ['p1-f1'],
      },
    ],
  );
  assert.equal(failure, null);
});

test('forces Gemini File Search Blueprint drafts into bounded unit generation', () => {
  assert.equal(shouldUseBoundedLessonAuthorGeneration(true, false), true);
  assert.equal(shouldUseBoundedLessonAuthorGeneration(false, true), true);
  assert.equal(shouldUseBoundedLessonAuthorGeneration(false, false), false);
});
