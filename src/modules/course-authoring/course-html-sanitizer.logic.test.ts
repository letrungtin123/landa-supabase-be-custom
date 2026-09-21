import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeCourseHtmlData } from './course-authoring.controller.js';

test('keeps supported lesson-table structure and italic text', () => {
  const result = sanitizeCourseHtmlData(`
    <p><em>Nội dung nghiêng</em></p>
    <table style="width: 640px">
      <colgroup><col style="width: 240px"></colgroup>
      <tbody><tr data-landa-row-height="48" style="height: 48px">
        <th data-landa-cell-bg="#DBEAFE" style="background-color: #DBEAFE">Tiêu đề</th>
        <td align="center">Nội dung</td>
      </tr></tbody>
    </table>
  `);

  assert.match(result, /<em>Nội dung nghiêng<\/em>/);
  assert.match(result, /<table[^>]*style="width:640px"/);
  assert.match(result, /<col[^>]*style="width:240px"/);
  assert.match(result, /data-landa-row-height="48"/);
  assert.match(result, /data-landa-cell-bg="#DBEAFE"/);
});

test('removes active HTML while retaining harmless text', () => {
  const result = sanitizeCourseHtmlData(
    '<p><em>Giữ lại</em><script>alert(1)</script><img src="https://safe.example/a.png" onerror="alert(1)"><a href="javascript:alert(1)">Liên kết</a></p>',
  );

  assert.match(result, /<em>Giữ lại<\/em>/);
  assert.doesNotMatch(result, /script|onerror|javascript:/i);
  assert.match(result, /https:\/\/safe\.example\/a\.png/);
});

test('rejects oversized table dimensions before persistence', () => {
  const rows = Array.from({ length: 101 }, () => '<tr><td>x</td></tr>').join('');
  assert.throws(
    () => sanitizeCourseHtmlData(`<table><tbody>${rows}</tbody></table>`),
    /tối đa 100 hàng/,
  );
});
