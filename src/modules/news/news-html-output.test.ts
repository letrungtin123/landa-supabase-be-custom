import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeNewsContent } from './news.logic.js';

// Exact output of the news allowlist for a typical article and for markup it
// must drop. Written against sanitize-html 2.17.0 and kept byte-for-byte
// across sanitize-html updates.

const TENANT_ID = '11111111-2222-4333-8444-555555555555';

test('a typical news article keeps its structure, links and owned images', () => {
  const result = sanitizeNewsContent(
    `<h2>Tin mới</h2><p>Nội dung <strong>quan trọng</strong> <a href="https://landa.vn/tin" target="_blank">xem</a> <a href="https://landa.vn/x" target="_self">self</a></p><figure><img src="/api/storage/${TENANT_ID}/news/a.png" alt="Ảnh" width="640" data-landa-image-mode="full"><figcaption>Chú thích</figcaption></figure><ul><li>Một</li></ul><blockquote>Trích</blockquote>`,
    TENANT_ID,
  );
  assert.deepEqual(result, {
    html: `<h2>Tin mới</h2><p>Nội dung <strong>quan trọng</strong> <a href="https://landa.vn/tin" target="_blank" rel="noopener noreferrer">xem</a> <a href="https://landa.vn/x" target="_self" rel="noopener noreferrer">self</a></p><figure><img src="${TENANT_ID}/news/a.png" alt="Ảnh" width="640" data-landa-image-mode="full" /><figcaption>Chú thích</figcaption></figure><ul><li>Một</li></ul><blockquote>Trích</blockquote>`,
    imagePaths: [`${TENANT_ID}/news/a.png`],
    excerpt: 'Tin mớiNội dung quan trọng xem selfChú thíchMộtTrích',
  });
});

test('news drops handlers, scripts, frames, script links, tables, styles and h5', () => {
  assert.deepEqual(
    sanitizeNewsContent(
      '<p onclick="x">a</p><script>alert(1)</script><iframe src="https://youtube.com/embed/x"></iframe><a href="javascript:alert(1)">j</a><h5>h5</h5><table><tr><td>t</td></tr></table><span style="color:red">s</span>',
      TENANT_ID,
    ),
    { html: '<p>a</p><a rel="noopener noreferrer">j</a>h5t<span>s</span>', imagePaths: [], excerpt: 'ajh5ts' },
  );
});

test('news: a textarea or xmp cannot smuggle markup into the article', () => {
  const { html } = sanitizeNewsContent('<p>x</p><textarea></textarea/><b onclick="x">t</b></textarea><xmp><b>y</b></xmp><p>z</p>', TENANT_ID);
  assert.doesNotMatch(html, /onclick|<textarea|<xmp/i);
  assert.match(html, /^<p>x<\/p>/);
  assert.match(html, /<p>z<\/p>$/);
});
