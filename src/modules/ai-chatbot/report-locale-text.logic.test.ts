import assert from 'node:assert/strict';
import test from 'node:test';
import { isUnaccentedVietnamese } from './report-locale-text.logic.js';

test('unaccented Vietnamese prose is detected', () => {
  assert.equal(isUnaccentedVietnamese(['Thong tin han che ve phan hoi truc tiep tu hoc vien.']), true);
  assert.equal(isUnaccentedVietnamese(['Dieu chinh thong bao', 'Kiem tra quy trinh ho tro hoc tap']), true);
});

test('accented Vietnamese, short texts and machine codes are not flagged', () => {
  assert.equal(isUnaccentedVietnamese(['Rà soát hành trình học liên quan và xác nhận hành động tiếp theo.']), false);
  assert.equal(isUnaccentedVietnamese(['Ghi nhan', 'OK']), false);
  assert.equal(isUnaccentedVietnamese(['completion_decline_insufficient_sample:v1', 'enrollment_period_change']), false);
  assert.equal(isUnaccentedVietnamese(['Thông tin về {{C1}} tăng', 'completion_decline_insufficient_sample:v1']), false);
});
