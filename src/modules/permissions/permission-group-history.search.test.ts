import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeVietnameseSearchText } from './permission-group-history.search.js';

test('permission group history search normalizes Vietnamese diacritics', () => {
  assert.equal(
    normalizeVietnameseSearchText('  Quản lý Đào tạo  '),
    'quan ly dao tao',
  );
  assert.equal(normalizeVietnameseSearchText('Nhóm quyền Đặc biệt'), 'nhom quyen dac biet');
});

test('permission group history search normalizes whitespace without changing search terms', () => {
  assert.equal(normalizeVietnameseSearchText('  Nguyễn   Văn\nAn '), 'nguyen van an');
});
