import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildIdmAuthorGuidance,
  idmPendingObjectiveIds,
  readIdmAuthorGuidance,
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
