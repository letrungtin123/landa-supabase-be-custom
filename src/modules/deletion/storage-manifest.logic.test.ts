import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeTenantStoragePath, shouldAdvanceStorageScanCursor } from './storage-manifest.service.js';

const tenantId = '11111111-1111-1111-1111-111111111111';

test('storage manifest accepts only a safe object key owned by the tenant', () => {
  assert.equal(
    normalizeTenantStoragePath(`${tenantId}/courses/course-a/asset.pdf`, tenantId),
    `${tenantId}/courses/course-a/asset.pdf`,
  );
});

test('storage manifest refuses cross-tenant, traversal, and unrelated public URLs', () => {
  assert.equal(normalizeTenantStoragePath('22222222-2222-2222-2222-222222222222/avatars/a.png', tenantId), null);
  assert.equal(normalizeTenantStoragePath(`${tenantId}/courses/../other/a.png`, tenantId), null);
  assert.equal(normalizeTenantStoragePath('https://example.com/file.png', tenantId), null);
});

test('storage scan cursor advances monotonically and never moves backwards', () => {
  assert.equal(shouldAdvanceStorageScanCursor(null, `${tenantId}/courses/course-a/a.png`), true);
  assert.equal(
    shouldAdvanceStorageScanCursor(`${tenantId}/courses/course-a/a.png`, `${tenantId}/courses/course-a/z.png`),
    true,
  );
  assert.equal(
    shouldAdvanceStorageScanCursor(`${tenantId}/courses/course-a/z.png`, `${tenantId}/courses/course-a/a.png`),
    false,
  );
});
