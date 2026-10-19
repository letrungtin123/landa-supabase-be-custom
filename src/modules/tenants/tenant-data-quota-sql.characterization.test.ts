import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  answers,
  failWhen,
  noRowsWhen,
  registerCharacterization,
  rowsWhen,
  type Answer,
  type Case,
} from '../../test-support/sql-characterization.js';

// Characterization of the tenant data quota code: Storage reservations,
// commits, releases and delete fences (tenant-data-quota.service.ts), the
// quota read, and the reconciliation worker primitives
// (tenant-data-quota-reconciliation.service.ts). Every statement is recorded
// byte for byte (rawSql), with its parameters, its pool or transaction client
// and the release of each client, so the SQL text, the lock order and the
// transaction boundaries must stay identical. The golden file was written by
// the code before the tenant repositories existed.
//
// No database or network: a pg double answers every statement with one fixed
// row (or none, or an error, per case). Rewrite the golden file only for an
// intended change:
//   TENANT_QUOTA_SQL_GOLDEN_WRITE=1 npx tsx --test src/modules/tenants/tenant-data-quota-sql.characterization.test.ts
// TENANT_QUOTA_SQL_FULL_OUT=<file> also writes every outcome in full.

process.env.TZ = 'Asia/Ho_Chi_Minh';
process.env.REDIS_URL = 'redis://127.0.0.1:1';

const redis = await import('../../config/redis.js');
const { pool } = await import('../../config/database.js');
const quota = await import('./tenant-data-quota.service.js');
const reconciliation = await import('./tenant-data-quota-reconciliation.service.js');

redis.installRedisClient(null);

const { after } = await import('node:test');
after(async () => {
  await pool.end();
});

const TENANT = '11111111-1111-4111-8111-111111111111';
const TENANT_2 = '22222222-2222-4222-8222-222222222222';
const RESERVATION = 'b0000000-0000-4000-8000-000000000001';
const RESERVATION_2 = 'b0000000-0000-4000-8000-000000000002';
const PATH = `${TENANT}/course-assets/a.pdf`;
const PATH_2 = `${TENANT}/course-assets/b.pdf`;
const PATH_3 = `${TENANT_2}/library/c.pdf`;

/** One row with every column a quota statement reads. */
const ROW = {
  ready: true,
  pending_bytes: '7',
  data_limit_bytes: '1000',
  database_used_bytes: '100',
  storage_used_bytes: '200',
  storage_reserved_bytes: '50',
  state: 'enforced',
  last_verified_at: new Date('2026-10-01T00:00:00.000Z'),
  size_bytes: '30',
  id: RESERVATION,
  tenant_id: TENANT,
  storage_path: PATH,
  previous_size_bytes: '30',
  reserved_bytes: '20',
  requested_size_bytes: '50',
  status: 'pending',
  claimed: true,
  retry_at: null,
  quota_state: 'reconciling',
  storage_scan_cursor: null,
  scanned_object_count: '0',
  bucket_id: 'landa-storage',
  name: PATH,
};

const LOCK = /FOR UPDATE OF usage/;
const RESERVATION_LOCK = /FROM tenant_storage_quota_reservations\s+WHERE id = \$1::uuid\s+FOR UPDATE/;
const lockedQuota = (changes: Record<string, unknown>): Answer => rowsWhen(LOCK, [{ ...ROW, ...changes }]);
const reservation = (changes: Record<string, unknown>): Answer =>
  rowsWhen(RESERVATION_LOCK, [{ ...ROW, ...changes }]);
const ledgerMissing = rowsWhen(/to_regclass\('public\.tenant_data_quota_database_deltas'\)/, [{ ready: false }]);

const cases: Case[] = [];
const add = (name: string, run: () => Promise<unknown>, answer?: Answer) => cases.push({ name, run, answer });
const upload = (id: string | null, tenantId: string | null = TENANT) => ({
  id,
  tenantId,
  storagePath: PATH,
  previousSizeBytes: 30n,
  requestedSizeBytes: 50n,
});

// ── Storage path ──
add('tenant from path', async () =>
  [PATH, 'system/prompt-mascots/a.png', 'nouuid/x', `${TENANT.toUpperCase()}/x`, 'x'].map(p =>
    quota.getTenantIdFromStoragePath(p),
  ),
);
for (const unsafe of ['', '/abs', 'a/../b', 'a\\b', 'a//b']) {
  add(`unsafe path ${JSON.stringify(unsafe)}`, async () => quota.getTenantIdFromStoragePath(unsafe));
}

// ── Upload reservations ──
add('reserve upload', () => quota.reserveStorageUpload(PATH, 50));
add('reserve upload platform path', () => quota.reserveStorageUpload('system/prompt-mascots/a.png', 50));
add('reserve upload same size', () => quota.reserveStorageUpload(PATH, 30));
add('reserve upload new object', () => quota.reserveStorageUpload(PATH, 50), noRowsWhen(/SELECT size_bytes/));
add('reserve upload over limit', () => quota.reserveStorageUpload(PATH, 900));
add('reserve upload exactly at limit', () => quota.reserveStorageUpload(PATH, 30 + 1000 - 357));
add('reserve upload no limit', () => quota.reserveStorageUpload(PATH, 9000), lockedQuota({ data_limit_bytes: null }));
add('reserve upload ledger missing', () => quota.reserveStorageUpload(PATH, 50), ledgerMissing);
for (const state of ['observing', 'initializing']) {
  add(`reserve upload ${state}`, () => quota.reserveStorageUpload(PATH, 50), lockedQuota({ state }));
}
add('reserve upload reconciling', () => quota.reserveStorageUpload(PATH, 50), lockedQuota({ state: 'reconciling' }));
add('reserve upload drifted growing', () => quota.reserveStorageUpload(PATH, 50), lockedQuota({ state: 'drifted' }));
add('reserve upload drifted shrinking', () => quota.reserveStorageUpload(PATH, 10), lockedQuota({ state: 'drifted' }));
add('reserve upload no tenant row', () => quota.reserveStorageUpload(PATH, 50), noRowsWhen(LOCK));
add('reserve upload bad size', () => quota.reserveStorageUpload(PATH, -1));
add('reserve upload fractional size', () => quota.reserveStorageUpload(PATH, 1.5));
add('reserve upload unsafe path', () => quota.reserveStorageUpload('../x', 1));
add(
  'reserve upload database error',
  () => quota.reserveStorageUpload(PATH, 50),
  failWhen(/INSERT INTO tenant_storage_quota_reservations/, { code: '40001', message: 'serialization failure' }),
);

// ── Upload commits ──
add('commit upload', () => quota.commitStorageUpload(upload(RESERVATION), 45));
add('commit upload no reservation id', () => quota.commitStorageUpload(upload(null), 45));
add('commit upload no tenant', () => quota.commitStorageUpload(upload(RESERVATION, null), 45));
add('commit upload missing', () => quota.commitStorageUpload(upload(RESERVATION), 45), noRowsWhen(RESERVATION_LOCK));
for (const status of ['committed', 'reconciled', 'released', 'reconcile_required']) {
  add(`commit upload ${status}`, () => quota.commitStorageUpload(upload(RESERVATION), 45), reservation({ status }));
}
add('commit upload reconciling', () => quota.commitStorageUpload(upload(RESERVATION), 45), lockedQuota({ state: 'reconciling' }));
add('commit upload drifted growing', () => quota.commitStorageUpload(upload(RESERVATION), 45), lockedQuota({ state: 'drifted' }));
add('commit upload drifted shrinking', () => quota.commitStorageUpload(upload(RESERVATION), 10), lockedQuota({ state: 'drifted' }));
add('commit upload over limit', () => quota.commitStorageUpload(upload(RESERVATION), 2000));
add('commit upload no limit', () => quota.commitStorageUpload(upload(RESERVATION), 2000), lockedQuota({ data_limit_bytes: null }));
add('commit upload observing', () => quota.commitStorageUpload(upload(RESERVATION), 45), lockedQuota({ state: 'observing' }));
add(
  'commit upload underflow',
  () => quota.commitStorageUpload(upload(RESERVATION), 0),
  answers(reservation({ previous_size_bytes: '500' }), lockedQuota({ storage_used_bytes: '100' })),
);
add('commit upload bad size', () => quota.commitStorageUpload(upload(RESERVATION), -5));
add('commit upload ledger missing', () => quota.commitStorageUpload(upload(RESERVATION), 45), ledgerMissing);

// ── Upload flags and releases ──
add('flag upload', () => quota.flagStorageUploadForReconciliation(upload(RESERVATION)));
add('flag upload no id', () => quota.flagStorageUploadForReconciliation(upload(null)));
add('release upload', () => quota.releaseStorageUploadReservation(upload(RESERVATION)));
add('release upload no id', () => quota.releaseStorageUploadReservation(upload(null)));
add('release upload missing', () => quota.releaseStorageUploadReservation(upload(RESERVATION)), noRowsWhen(/SELECT id, tenant_id, reserved_bytes, status/));
add(
  'release upload not pending',
  () => quota.releaseStorageUploadReservation(upload(RESERVATION)),
  rowsWhen(/SELECT id, tenant_id, reserved_bytes, status/, [{ ...ROW, status: 'committed' }]),
);
add(
  'release upload underflow',
  () => quota.releaseStorageUploadReservation(upload(RESERVATION)),
  lockedQuota({ storage_reserved_bytes: '5' }),
);
add('release upload reconciling', () => quota.releaseStorageUploadReservation(upload(RESERVATION)), lockedQuota({ state: 'reconciling' }));

// ── Delete fences ──
const deletes = [
  { id: RESERVATION, tenantId: TENANT, storagePath: PATH },
  { id: RESERVATION_2, tenantId: TENANT_2, storagePath: PATH_3 },
];
add('reserve deletes', () => quota.reserveStorageDeletes([PATH, ` ${PATH_2} `, PATH, PATH_3, '', 'system/a.png']));
add('reserve deletes none', () => quota.reserveStorageDeletes(['', 'system/a.png']));
add('reserve deletes unknown sizes', () => quota.reserveStorageDeletes([PATH, PATH_2]), noRowsWhen(/SELECT storage_path, size_bytes/));
add('reserve deletes reconciling', () => quota.reserveStorageDeletes([PATH, PATH_3]), lockedQuota({ state: 'reconciling' }));
add(
  'reserve deletes second tenant fails',
  () => quota.reserveStorageDeletes([PATH, PATH_3]),
  (text, index) => (index > 8 && LOCK.test(text) ? { rows: [] } : undefined),
);
add('reserve deletes unsafe path', () => quota.reserveStorageDeletes(['a/../b']));
add('flag deletes', () => quota.flagStorageDeletesForReconciliation(deletes));
add('flag deletes none', () => quota.flagStorageDeletesForReconciliation([]));
add('release deletes', () => quota.releaseStorageDeleteReservations(deletes));
add('release deletes none', () => quota.releaseStorageDeleteReservations([]));
add('record delete', () => quota.recordStorageDelete([PATH, PATH_2, ` ${PATH} `, PATH_3, 'system/a.png', ''], deletes));
add('record delete no reservations', () => quota.recordStorageDelete([PATH]));
add('record delete nothing freed', () => quota.recordStorageDelete([PATH], deletes), noRowsWhen(/DELETE FROM tenant_storage_quota_objects/));
add(
  'record delete underflow',
  () => quota.recordStorageDelete([PATH], deletes),
  rowsWhen(/DELETE FROM tenant_storage_quota_objects/, [{ size_bytes: '150' }, { size_bytes: '60' }]),
);
add('record delete reconciling', () => quota.recordStorageDelete([PATH], deletes), lockedQuota({ state: 'reconciling' }));
add('record delete none', () => quota.recordStorageDelete(['', 'system/a.png']));

// ── Quota read ──
add('quota read', () => quota.getTenantDataQuota(TENANT));
add('quota read missing', () => quota.getTenantDataQuota(TENANT), noRowsWhen(/FROM tenants t/));
add(
  'quota read no usage row',
  () => quota.getTenantDataQuota(TENANT),
  rowsWhen(/FROM tenants t/, [
    {
      data_limit_bytes: null,
      database_used_bytes: null,
      storage_used_bytes: null,
      storage_reserved_bytes: null,
      state: null,
      last_verified_at: null,
    },
  ]),
);
add('quota read over limit', () => quota.getTenantDataQuota(TENANT), rowsWhen(/FROM tenants t/, [{ ...ROW, data_limit_bytes: '10' }]));
add('quota read ledger missing', () => quota.getTenantDataQuota(TENANT), ledgerMissing);
add('quota read ledger dropped', () => quota.getTenantDataQuota(TENANT), (text, index) =>
  index === 1 && /tenant_data_quota_pending_database_bytes/.test(text) ? { error: { code: '42883', message: 'function does not exist' } } : undefined,
);
add('quota read other error', () => quota.getTenantDataQuota(TENANT), failWhen(/FROM tenants t/, { code: '57014', message: 'canceled' }));
add('quota totals', async () => [
  quota.totalTenantDataQuotaBytes('1', 2, 3n).toString(),
  quota.totalTenantDataQuotaBytes(null, undefined, '4').toString(),
  quota.exceedsTenantDataLimit('10', '1', '2', '3', 5n),
  quota.exceedsTenantDataLimit('10', '1', '2', '3', 4n),
  quota.exceedsTenantDataLimit(null, '1', '2', '3', 50n),
  quota.exceedsTenantDataLimit('1', '1', '2', '3', 0n),
]);

// ── Reconciliation worker ──
const OPTIONS = {
  pageSize: 100,
  leaseSeconds: 300,
  databaseSnapshotTimeoutMs: 60_000,
  maxPagesPerClaim: 2,
  maxSliceMs: null,
  retryBaseSeconds: 30,
  retryMaxSeconds: 600,
};
const OBJECTS = /FROM storage\.objects/;
add('reconciliation schema ready', () => reconciliation.isTenantDataQuotaReconciliationSchemaReady());
add('reconciliation schema missing', () => reconciliation.isTenantDataQuotaReconciliationSchemaReady(), rowsWhen(/AS ready/, [{ ready: false }]));
add('reconciliation heartbeat', () =>
  reconciliation.recordTenantDataQuotaWorkerHeartbeat({
    workerName: 'tenant-data-quota',
    instanceId: RESERVATION,
    state: 'idle',
    candidates: 1,
    completed: 2,
    yielded: 3,
    failed: 4,
    lastError: 'x'.repeat(5000),
  }),
);
add('reconciliation heartbeat no error', () =>
  reconciliation.recordTenantDataQuotaWorkerHeartbeat({
    workerName: 'tenant-data-quota',
    instanceId: RESERVATION,
    state: 'starting',
    candidates: 0,
    completed: 0,
    yielded: 0,
    failed: 0,
  }),
);
add('reconciliation candidates', () => reconciliation.listTenantDataQuotaReconciliationCandidates(5));
add('reconcile yields after pages', () => reconciliation.reconcileTenantDataQuota(TENANT, OPTIONS));
add('reconcile completes', () => reconciliation.reconcileTenantDataQuota(TENANT, OPTIONS), noRowsWhen(OBJECTS));
add(
  'reconcile completes after a page',
  () => reconciliation.reconcileTenantDataQuota(TENANT, OPTIONS),
  (text, index) => (OBJECTS.test(text) && index > 3 ? { rows: [] } : undefined),
);
add(
  'reconcile resumes from cursor',
  () => reconciliation.reconcileTenantDataQuota(TENANT, { ...OPTIONS, maxPagesPerClaim: 1 }),
  rowsWhen(/tenant_data_quota_claim_reconciliation/, [{ ...ROW, storage_scan_cursor: JSON.stringify(['landa-storage', PATH]) }]),
);
add(
  'reconcile legacy cursor',
  () => reconciliation.reconcileTenantDataQuota(TENANT, { ...OPTIONS, maxPagesPerClaim: 1 }),
  rowsWhen(/tenant_data_quota_claim_reconciliation/, [{ ...ROW, storage_scan_cursor: 'legacy' }]),
);
add(
  'reconcile not claimed',
  () => reconciliation.reconcileTenantDataQuota(TENANT, OPTIONS),
  rowsWhen(/tenant_data_quota_claim_reconciliation/, [{ ...ROW, claimed: false }]),
);
add('reconcile no claim row', () => reconciliation.reconcileTenantDataQuota(TENANT, OPTIONS), noRowsWhen(/tenant_data_quota_claim_reconciliation/));
add('reconcile lease lost', () => reconciliation.reconcileTenantDataQuota(TENANT, OPTIONS), noRowsWhen(/UPDATE tenant_data_quota_reconciliation_runs/));
add(
  'reconcile bad size',
  () => reconciliation.reconcileTenantDataQuota(TENANT, OPTIONS),
  rowsWhen(OBJECTS, [{ ...ROW, size_bytes: null }]),
);
add(
  'reconcile huge size',
  () => reconciliation.reconcileTenantDataQuota(TENANT, OPTIONS),
  rowsWhen(OBJECTS, [{ ...ROW, size_bytes: '9223372036854775808' }]),
);
add(
  'reconcile fail claim fails too',
  () => reconciliation.reconcileTenantDataQuota(TENANT, OPTIONS),
  answers(
    rowsWhen(OBJECTS, [{ ...ROW, size_bytes: 'x' }]),
    failWhen(/tenant_data_quota_fail_reconciliation/, { code: '08006', message: 'connection lost' }),
  ),
);
add('reconcile stop at once', () => reconciliation.reconcileTenantDataQuota(TENANT, OPTIONS, () => true));
add('reconcile bad options', () => reconciliation.reconcileTenantDataQuota(TENANT, { ...OPTIONS, pageSize: 0 }));
add('reconcile bad tenant', () => reconciliation.reconcileTenantDataQuota('not-a-uuid', OPTIONS));
add('reconciliation cycle', () =>
  reconciliation.runTenantDataQuotaReconciliationCycle(3, { ...OPTIONS, maxPagesPerClaim: 1 }),
);
add(
  'reconciliation cycle mixed',
  () => reconciliation.runTenantDataQuotaReconciliationCycle(3, OPTIONS),
  answers(
    rowsWhen(/tenant_data_quota_list_reconciliation_candidates/, [
      { tenant_id: TENANT },
      { tenant_id: TENANT_2 },
      { tenant_id: 'bad' },
    ]),
    (text, index) => (OBJECTS.test(text) && index > 3 ? { rows: [] } : undefined),
  ),
);
add('reconciliation cycle stopped', () => reconciliation.runTenantDataQuotaReconciliationCycle(3, OPTIONS, () => true));

registerCharacterization({
  title: 'tenant data quota characterization',
  goldenPath: path.join(path.dirname(fileURLToPath(import.meta.url)), 'tenant-data-quota-sql.characterization.golden.json'),
  writeEnv: 'TENANT_QUOTA_SQL_GOLDEN_WRITE',
  fullOutEnv: 'TENANT_QUOTA_SQL_FULL_OUT',
  pool,
  defaultRow: ROW,
  cases,
  fixedIds: [TENANT, TENANT_2, RESERVATION, RESERVATION_2],
  now: Date.parse('2026-10-18T03:04:05.000Z'),
  rawSql: true,
});
