import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeNewsCursor,
  encodeNewsCursor,
  foldNewsSearch,
  normalizeNewsImagePath,
  normalizeNewsSearch,
  sanitizeNewsContent,
} from './news.logic.js';
import {
  detectNewsImage,
  isBlockedNewsImageAddress,
  parseRemoteNewsImageUrl,
} from './news-remote-image.logic.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';

test('news cursor is signed and round-trips its boundary', () => {
  const cursor = encodeNewsCursor({
    timestamp: '2026-10-05T07:00:00.000Z',
    id: '22222222-2222-4222-8222-222222222222',
    status: 'active',
    search: '',
  }, 'test-secret');
  assert.deepEqual(decodeNewsCursor(cursor, 'test-secret'), {
    v: 1,
    timestamp: '2026-10-05T07:00:00.000Z',
    id: '22222222-2222-4222-8222-222222222222',
    status: 'active',
    search: '',
  });
  assert.throws(() => decodeNewsCursor(`${cursor}x`, 'test-secret'));
});

test('news search folds Vietnamese accents and letter d with stroke', () => {
  const search = normalizeNewsSearch('  Đào   tạo & THÔNG BÁO  ');
  assert.equal(search, 'Đào tạo & THÔNG BÁO');
  assert.equal(foldNewsSearch(search), 'dao tao & thong bao');
});

test('news HTML strips executable markup and persists owned image paths', () => {
  const value = sanitizeNewsContent(
    `<p onclick="alert(1)">Hello <strong>world</strong></p><script>alert(2)</script><img src="/api/storage/${TENANT_ID}/news/x.webp" onerror="alert(3)">`,
    TENANT_ID,
  );
  assert.equal(value.html.includes('script'), false);
  assert.equal(value.html.includes('onclick'), false);
  assert.equal(value.html.includes('onerror'), false);
  assert.equal(value.html.includes(`${TENANT_ID}/news/x.webp`), true);
  assert.deepEqual(value.imagePaths, [`${TENANT_ID}/news/x.webp`]);
  assert.equal(value.excerpt, 'Hello world');
});

test('news images cannot cross tenant boundaries', () => {
  assert.equal(normalizeNewsImagePath('33333333-3333-4333-8333-333333333333/news/a.png', TENANT_ID), null);
  assert.throws(() => sanitizeNewsContent('<img src="https://example.com/tracker.png">', TENANT_ID));
});

test('remote news images require public HTTPS targets', () => {
  assert.equal(parseRemoteNewsImageUrl('https://cdn.example.com/image.png').hostname, 'cdn.example.com');
  assert.throws(() => parseRemoteNewsImageUrl('http://cdn.example.com/image.png'));
  assert.throws(() => parseRemoteNewsImageUrl('https://user:pass@cdn.example.com/image.png'));
  assert.equal(isBlockedNewsImageAddress('127.0.0.1', 4), true);
  assert.equal(isBlockedNewsImageAddress('192.168.0.226', 4), true);
  assert.equal(isBlockedNewsImageAddress('8.8.8.8', 4), false);
  assert.equal(isBlockedNewsImageAddress('::1', 6), true);
});

test('remote news image type is determined by file signature', () => {
  assert.deepEqual(
    detectNewsImage(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    { mime: 'image/png', extension: '.png' },
  );
  assert.equal(detectNewsImage(Buffer.from('<html>not an image</html>')), null);
});
