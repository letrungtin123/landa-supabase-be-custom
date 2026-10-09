import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildIdmAuthorGuidance,
  idmAuthorSmeQuestions,
  idmPendingObjectiveIds,
  readIdmAuthorGuidance,
  readIdmAuthorNotesGuidance,
} from './lesson-author-idm-guidance.logic.js';
import { idmFixture, rehashIdmDesign } from './lesson-author-idm.fixture.js';
import type { IdmCourseDesignV1 } from './lesson-author-idm.contract.js';

/** QC course 234653 (R3/R4): Hold items, held objectives and Nice to Know reach the author. */
function heldDesign(): IdmCourseDesignV1 {
  const design = structuredClone(idmFixture().design);
  design.learning_objectives.push({ lo_id: 'lo_2', statement: 'Người học có thể đánh giá đề xuất theo bộ lọc',
    bloom: 'evaluate', origin: 'ai_proposed' });
  design.must_dos.push({ must_do_id: 'md_9', lo_id: 'lo_2', statement: 'Đánh giá đề xuất theo 3 tiêu chí',
    kind: 'decide', bloom: 'evaluate' });
  design.blocked_must_do_ids = ['md_9'];
  design.hold_items[0] = { ...design.hold_items[0]!, name: 'Bộ lọc <Tam Hóa>', blocked_must_do_ids: ['md_9'] };
  design.hold_items.push({ block_id: design.hold_items[0]!.block_id, name: 'Khối thiếu lý do', reason: '-',
    sme_question: '-', blocked_must_do_ids: [] });
  return rehashIdmDesign(design);
}

test('guidance lists every Hold item with the Must Dos it blocks, held objectives and Nice to Know blocks', () => {
  const design = heldDesign();
  const guidance = readIdmAuthorGuidance(JSON.parse(JSON.stringify(design)));
  assert.deepEqual(guidance, {
    hold_items: [
      { name: 'Bộ lọc ‹Tam Hóa›', reason: 'Cần SME xác nhận.', sme_question: 'Quy định nào đang áp dụng?',
        blocked_must_dos: ['Đánh giá đề xuất theo 3 tiêu chí'] },
      { name: 'Khối thiếu lý do', reason: null, sme_question: null, blocked_must_dos: [] },
    ],
    pending_objectives: ['Người học có thể đánh giá đề xuất theo bộ lọc'],
    nice_to_know: [{ name: design.blocks.find(block => design.blueprint.find(row => row.block_id === block.block_id)
      ?.classification === 'nice_to_know')!.name, summary: 'Tóm tắt khối nội dung.' }],
  });
  assert.deepEqual(idmPendingObjectiveIds(design), ['lo_2']);
  // A partly held objective (lo_1 keeps its other Must Dos) is still taught.
  assert.deepEqual(idmPendingObjectiveIds({ ...design, blocked_must_do_ids: ['md_1', 'md_9'] }), ['lo_2']);
  assert.deepEqual(buildIdmAuthorGuidance(idmFixture().design).pending_objectives, []);
});

test('guidance is null for legacy runs and for a stored design this reader cannot verify', () => {
  assert.equal(readIdmAuthorGuidance(null), null);
  assert.equal(readIdmAuthorGuidance(undefined), null);
  const tampered = JSON.parse(JSON.stringify(heldDesign()));
  tampered.hold_items[0].name = 'Đổi sau khi băm';
  assert.equal(readIdmAuthorGuidance(tampered), null);
  assert.equal(readIdmAuthorGuidance({ pipeline_version: 'idm-1' }), null);
});

/** QLT-3 (run 8de1c76b): the course note shows 10 SME questions + "và 12 mục khác"; author notes keep all 22. */
function questionedDesign(): IdmCourseDesignV1 {
  const design = structuredClone(idmFixture().design);
  const holdBlock = design.hold_items[0]!.block_id;
  const [first, second, third] = design.blocks.filter(block => block.block_id !== holdBlock);
  first!.sme_questions = ['Câu hỏi 1 về quy trình?', 'Câu hỏi trùng?'];
  second!.sme_questions = ['Câu hỏi <ưu tiên> mâu thuẫn?', 'Câu hỏi trùng?'];
  second!.issues = [{ type: 'conflict', note: 'Hai nguồn khác nhau.', fact_keys: [] }];
  third!.sme_questions = ['Khối cb_0003 có  số liệu nào?', '-'];
  design.blocks.find(block => block.block_id === holdBlock)!.sme_questions = ['Câu hỏi của khối Hold?'];
  return rehashIdmDesign(design);
}

test('author notes keep the complete SME list in note order; the workspace read keeps its three-key contract', () => {
  const design = questionedDesign();
  assert.deepEqual(idmAuthorSmeQuestions(design), ['Câu hỏi ‹ưu tiên› mâu thuẫn?', 'Câu hỏi trùng?',
    'Câu hỏi 1 về quy trình?', 'Khối có số liệu nào?'], 'conflict first, Hold block excluded, deduped, ids scrubbed, "-" dropped');
  const notesGuidance = readIdmAuthorNotesGuidance(JSON.parse(JSON.stringify(design)))!;
  assert.deepEqual(notesGuidance.sme_questions, idmAuthorSmeQuestions(design));
  const { sme_questions: _questions, ...rest } = notesGuidance;
  assert.deepEqual(rest, readIdmAuthorGuidance(JSON.parse(JSON.stringify(design))));
  assert.deepEqual(Object.keys(readIdmAuthorGuidance(JSON.parse(JSON.stringify(design)))!).sort(),
    ['hold_items', 'nice_to_know', 'pending_objectives'], 'the dashboard workspace parser requires exactly these keys');
  const many = structuredClone(design);
  many.blocks[0]!.sme_questions = Array.from({ length: 8 }, (_, index) => `Câu hỏi số ${index + 1} cho chuyên gia?`);
  assert.equal(idmAuthorSmeQuestions(rehashIdmDesign(many)).length, 8 + 3, 'no ten-item truncation');
  assert.equal(readIdmAuthorNotesGuidance(null), null);
  const tampered = JSON.parse(JSON.stringify(design)); tampered.blocks[0].sme_questions = ['Đổi sau khi băm?'];
  assert.equal(readIdmAuthorNotesGuidance(tampered), null);
});
