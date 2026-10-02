import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntimeTenantFence } from './runtime-tenant-fence.js';

const DEV_TENANT = '0d1aa27f-cb83-4a98-a857-12276c8ec2d6';
const OTHER_TENANT = '11111111-1111-4111-8111-111111111111';

test('allowlist admits only the selected development tenant', () => {
  const fence = createRuntimeTenantFence([DEV_TENANT], []);
  assert.equal(fence.isAllowed(DEV_TENANT), true);
  assert.equal(fence.isAllowed(OTHER_TENANT), false);
  assert.deepEqual(fence.sql('job.tenant_id', 3), {
    clause: ' AND job.tenant_id = ANY($3::uuid[])',
    params: [[DEV_TENANT]],
  });
});

test('denylist excludes the development tenant from the demo runtime', () => {
  const fence = createRuntimeTenantFence([], [DEV_TENANT]);
  assert.equal(fence.isAllowed(DEV_TENANT), false);
  assert.equal(fence.isAllowed(OTHER_TENANT), true);
  assert.deepEqual(fence.sql('tenant_id', 1), {
    clause: ' AND NOT (tenant_id = ANY($1::uuid[]))',
    params: [[DEV_TENANT]],
  });
});

test('invalid and overlapping tenant contracts fail closed', () => {
  assert.throws(() => createRuntimeTenantFence(['not-a-uuid'], []), /invalid tenant UUID/);
  assert.throws(() => createRuntimeTenantFence([DEV_TENANT], [DEV_TENANT]), /must not overlap/);
  const fence = createRuntimeTenantFence([], []);
  assert.throws(() => fence.sql('tenant_id;DROP TABLE tenants', 1), /Invalid runtime tenant SQL column/);
});
