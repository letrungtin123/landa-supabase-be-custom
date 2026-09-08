import assert from 'node:assert/strict';
import test from 'node:test';
import {
  exceedsTenantDataLimit,
  getTenantIdFromStoragePath,
  totalTenantDataQuotaBytes,
} from './tenant-data-quota.service.js';
import {
  assertTenantDataQuotaReconciliationOptions,
  isTenantDataQuotaSliceExpired,
  tenantDataQuotaFinalizationLeaseSeconds,
  tenantDataQuotaMinimumFinalizationWindowSeconds,
  tenantStorageKeysetBounds,
} from './tenant-data-quota-reconciliation.service.js';

const TENANT_ID = '7e478869-beb6-4f42-a789-2c090d2d7b08';

test('quota total keeps bigint precision beyond JavaScript safe integers', () => {
  const total = totalTenantDataQuotaBytes('9007199254740993', '7', '11');
  assert.equal(total, 9007199254741011n);
});

test('quota rejects only the byte that exceeds a finite limit', () => {
  assert.equal(exceedsTenantDataLimit('1000', '600', '300', '90', 10n), false);
  assert.equal(exceedsTenantDataLimit('1000', '600', '300', '90', 11n), true);
  assert.equal(exceedsTenantDataLimit(null, '999', '0', '0', 1n), false);
});

test('storage replacement only consumes quota for a positive delta', () => {
  assert.equal(exceedsTenantDataLimit('1000', '0', '990', '0', 0n), false);
  assert.equal(exceedsTenantDataLimit('1000', '0', '990', '0', -100n), false);
  assert.equal(exceedsTenantDataLimit('1000', '0', '990', '0', 11n), true);
});

test('only canonical tenant storage prefixes enter tenant quota accounting', () => {
  assert.equal(getTenantIdFromStoragePath(`${TENANT_ID}/kb-files/a.pdf`), TENANT_ID);
  assert.equal(getTenantIdFromStoragePath('system/prompt-mascots/default.png'), null);
  assert.throws(() => getTenantIdFromStoragePath(`${TENANT_ID}/../private.pdf`));
  assert.throws(() => getTenantIdFromStoragePath(`/${TENANT_ID}/private.pdf`));
});

test('Storage reconciliation uses an exact C-collation keyset range for one tenant', () => {
  assert.deepEqual(tenantStorageKeysetBounds(TENANT_ID.toUpperCase()), {
    lowerBound: `${TENANT_ID}/`,
    upperBound: `${TENANT_ID}0`,
  });
  assert.throws(() => tenantStorageKeysetBounds('not-a-tenant-id'));
});

test('worker yields before its lease guard and rejects an unsafe slice configuration', () => {
  assert.equal(isTenantDataQuotaSliceExpired(1_000, 60_000, 60_999), false);
  assert.equal(isTenantDataQuotaSliceExpired(1_000, 60_000, 61_000), true);
  assert.equal(isTenantDataQuotaSliceExpired(1_000, null, 9_999_999), false);

  assert.doesNotThrow(() => assertTenantDataQuotaReconciliationOptions({
    pageSize: 500,
    leaseSeconds: 120,
    databaseSnapshotTimeoutMs: 600_000,
    maxPagesPerClaim: 100,
    maxSliceMs: 60_000,
    retryBaseSeconds: 30,
    retryMaxSeconds: 3_600,
  }));
  assert.throws(() => assertTenantDataQuotaReconciliationOptions({
    pageSize: 500,
    leaseSeconds: 120,
    databaseSnapshotTimeoutMs: 600_000,
    maxPagesPerClaim: 100,
    maxSliceMs: 90_001,
    retryBaseSeconds: 30,
    retryMaxSeconds: 3_600,
  }));
});

test('final database snapshot lease is derived safely from its statement timeout', () => {
  assert.equal(tenantDataQuotaMinimumFinalizationWindowSeconds(600_000), 630);
  assert.equal(tenantDataQuotaFinalizationLeaseSeconds(600_000), 660);
  assert.equal(tenantDataQuotaFinalizationLeaseSeconds(30_000), 90);

  assert.throws(() => assertTenantDataQuotaReconciliationOptions({
    pageSize: 500,
    leaseSeconds: 120,
    databaseSnapshotTimeoutMs: 600_001,
    maxPagesPerClaim: 100,
    maxSliceMs: 60_000,
    retryBaseSeconds: 30,
    retryMaxSeconds: 3_600,
  }));
});
