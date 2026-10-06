import assert from 'node:assert/strict';
import test from 'node:test';
import {
  completeLessonAuthorContentContract,
  sanitizeLessonAuthorHtml,
  shouldUseBoundedLessonAuthorGeneration,
  validateLessonAuthorContentContractUnit,
  validateLessonAuthorGeneratedUnitCoverage,
  validateLessonAuthorHtmlContract,
  validateLessonAuthorHtmlInstructionalQuality,
  validateLessonAuthorSingleChoiceProblem,
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

test('accepts supporting-only evidence without turning it into canonical fact ownership', () => {
  const plan = [{
    type: 'problem' as const,
    source_fact_ids: [],
    supporting_evidence_fact_ids: ['p1-f1'],
  }];
  assert.equal(validateLessonAuthorContentContractUnit({
    source_fact_ids: [],
    supporting_evidence_fact_ids: ['p1-f1'],
    component_plan: plan,
  }), null);
  assert.equal(validateLessonAuthorGeneratedUnitCoverage({
    source_fact_ids: [],
    supporting_evidence_fact_ids: ['p1-f1'],
    component_plan: plan,
  }, [{
    type: 'problem',
    source_fact_ids: [],
    covered_source_fact_ids: [],
    supporting_evidence_fact_ids: ['p1-f1'],
  }]), null);
});

test('accepts an interaction grounded by canonical facts owned only by HTML', () => {
  const plan = [{
    component_plan_id: 'cp2_00000000000000000000000000000001',
    type: 'html' as const,
    source_fact_ids: sourceFacts,
    supporting_evidence_fact_ids: [],
  }, {
    component_plan_id: 'cp2_00000000000000000000000000000002',
    type: 'problem' as const,
    source_fact_ids: [],
    supporting_evidence_fact_ids: ['p1-f1'],
  }];
  const unit = { source_fact_ids: sourceFacts, supporting_evidence_fact_ids: [], component_plan: plan };
  assert.equal(validateLessonAuthorContentContractUnit(unit), null);
  assert.equal(validateLessonAuthorGeneratedUnitCoverage(unit, [{
    component_plan_id: plan[0].component_plan_id,
    type: 'html', source_fact_ids: sourceFacts, covered_source_fact_ids: sourceFacts,
    supporting_evidence_fact_ids: [], html: '<p>Nội dung nguồn đã được giải thích đầy đủ.</p>',
  }, {
    component_plan_id: plan[1].component_plan_id,
    type: 'problem', source_fact_ids: [], covered_source_fact_ids: [],
    supporting_evidence_fact_ids: ['p1-f1'],
  }]), null);
  assert.match(validateLessonAuthorGeneratedUnitCoverage(unit, [{
    component_plan_id: plan[0].component_plan_id,
    type: 'html', source_fact_ids: sourceFacts, covered_source_fact_ids: sourceFacts,
    supporting_evidence_fact_ids: [], html: '<p>Nội dung nguồn đã được giải thích đầy đủ.</p>',
  }, {
    component_plan_id: plan[1].component_plan_id,
    type: 'problem', source_fact_ids: [], covered_source_fact_ids: ['p1-f1'],
    supporting_evidence_fact_ids: ['p1-f1'],
  }]) ?? '', /must not claim canonical source coverage/);
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
  assert.match(validateLessonAuthorHtmlContract('Nội dung rơi ngoài thẻ<p>Nội dung hợp lệ.</p>') ?? '', /outside/);
});

test('rejects source boilerplate, OCR noise and duplicate learner blocks', () => {
  assert.match(validateLessonAuthorHtmlInstructionalQuality('<p>www.l-a.com.vn</p>') ?? '', /boilerplate/);
  assert.match(validateLessonAuthorHtmlInstructionalQuality('<p>vvvvvvvvvvvv</p>') ?? '', /OCR/);
  assert.match(validateLessonAuthorHtmlInstructionalQuality('<p>Kiểm tra điều kiện an toàn.</p><p>Kiểm tra điều kiện an toàn.</p>') ?? '', /repeats/);
  assert.equal(validateLessonAuthorHtmlInstructionalQuality(
    '<h2>Kiểm soát rủi ro</h2><p>Đánh giá mối nguy trước khi lựa chọn biện pháp kiểm soát phù hợp.</p>',
  ), null);
  assert.match(validateLessonAuthorHtmlInstructionalQuality('<p>Theo tài liệu nguồn, cần đánh giá rủi ro.</p>') ?? '', /attribution/);
  assert.match(validateLessonAuthorHtmlInstructionalQuality('<p>Nội dung này được nêu trong tài liệu nguồn.</p>') ?? '', /attribution/);
  assert.match(validateLessonAuthorHtmlInstructionalQuality('<p>Tài liệu mô tả quy trình kiểm soát rủi ro.</p>') ?? '', /attribution/);
  assert.match(validateLessonAuthorHtmlInstructionalQuality('<p>Xem chi tiết tại trang 12.</p>') ?? '', /locator/);
  assert.match(validateLessonAuthorHtmlInstructionalQuality('<p>Nội dung từ playbook.pdf.</p>') ?? '', /filename/);
  assert.match(validateLessonAuthorHtmlInstructionalQuality(
    '<p>Nội dung học tập p5-f2.</p>', { exact_identifiers: ['p5-f2'] },
  ) ?? '', /identifier/);
  assert.equal(validateLessonAuthorHtmlInstructionalQuality('<p>Kiểm tra trang thiết bị trước khi làm việc.</p>'), null);
});

test('AI ID accepts only one-answer multiple-choice problem XML', () => {
  const valid = [
    '<problem>',
    '<multiplechoiceresponse><label>Biện pháp nào cần thực hiện trước khi bắt đầu công việc?</label>',
    '<choicegroup type="MultipleChoice">',
    '<choice correct="true">Kiểm tra điều kiện an toàn tại khu vực làm việc.</choice>',
    '<choice correct="false">Bỏ qua bước kiểm tra khi công việc quen thuộc.</choice>',
    '<choice correct="false">Chỉ kiểm tra sau khi sự cố đã xảy ra.</choice>',
    '</choicegroup></multiplechoiceresponse>',
    '<solution><div class="detailed-solution"><p>Tài liệu yêu cầu kiểm tra điều kiện an toàn trước khi bắt đầu công việc.</p></div></solution>',
    '</problem>',
  ].join('');
  assert.equal(validateLessonAuthorSingleChoiceProblem(valid), null);
  assert.match(validateLessonAuthorSingleChoiceProblem(
    '<problem><stringresponse answer="www.example.com"><label>Nhập đáp án</label><textline /></stringresponse></problem>',
  ) ?? '', /single-answer multiple choice/);
  assert.match(validateLessonAuthorSingleChoiceProblem(valid.replace('correct="false"', 'correct="true"')) ?? '', /exactly one/);
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
