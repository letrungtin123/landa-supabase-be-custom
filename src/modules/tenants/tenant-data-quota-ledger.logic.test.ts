import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertTenantDataQuotaFoldOptions,
  effectiveDatabaseBytesSql,
  isMissingDeltaLedgerError,
  shouldFoldAnotherBatch,
} from './tenant-data-quota-ledger.logic.js';
import {
  createTenantDataQuotaLedgerRepository,
  type TenantDataQuotaLedgerSql,
} from './tenant-data-quota-ledger.repository.js';
import { foldTenantDataQuotaDeltas } from './tenant-data-quota-ledger.service.js';

const OPTIONS = { intervalMs: 2_000, batchSize: 5_000, maxBatchesPerTick: 3 };

function scriptedSql(responses: Array<Record<string, unknown>[]>, seen: string[] = []): TenantDataQuotaLedgerSql {
  return {
    async query<T extends Record<string, unknown>>(sql: string) {
      seen.push(sql);
      const rows = responses.shift();
      assert.ok(rows, `unexpected SQL: ${sql}`);
      return { rows: rows as T[], rowCount: rows.length };
    },
  };
}

test('fold options are bounded like the SQL function', () => {
  assert.doesNotThrow(() => assertTenantDataQuotaFoldOptions(OPTIONS));
  assert.throws(() => assertTenantDataQuotaFoldOptions({ ...OPTIONS, intervalMs: 499 }));
  assert.throws(() => assertTenantDataQuotaFoldOptions({ ...OPTIONS, batchSize: 100_001 }));
  assert.throws(() => assertTenantDataQuotaFoldOptions({ ...OPTIONS, batchSize: 99 }));
  assert.throws(() => assertTenantDataQuotaFoldOptions({ ...OPTIONS, maxBatchesPerTick: 0 }));
});

test('a tick keeps folding only while batches come back full', () => {
  assert.equal(shouldFoldAnotherBatch(5_000, 0, OPTIONS), true);
  assert.equal(shouldFoldAnotherBatch(4_999, 1, OPTIONS), false);
  assert.equal(shouldFoldAnotherBatch(5_000, 3, OPTIONS), false);
});

test('only a missing function or table means the ledger SQL is absent', () => {
  assert.equal(isMissingDeltaLedgerError({ code: '42883' }), true);
  assert.equal(isMissingDeltaLedgerError({ code: '42P01' }), true);
  assert.equal(isMissingDeltaLedgerError({ code: 'LQ001' }), false);
  assert.equal(isMissingDeltaLedgerError(new Error('boom')), false);
  assert.equal(isMissingDeltaLedgerError(null), false);
});

test('database usage adds unfolded deltas only for counted states and only with the ledger', () => {
  assert.equal(effectiveDatabaseBytesSql('usage', 't.id', false), 'COALESCE(usage.database_used_bytes, 0)');
  const sql = effectiveDatabaseBytesSql('usage', '$1::uuid', true);
  assert.match(sql, /COALESCE\(usage\.database_used_bytes, 0\) \+ CASE WHEN usage\.state IN \('enforced', 'drifted', 'reconciling'\)/);
  assert.match(sql, /public\.tenant_data_quota_pending_database_bytes\(\$1::uuid\) ELSE 0 END/);
  assert.throws(() => effectiveDatabaseBytesSql('usage', "t.id); DROP TABLE x; --", true));
  assert.throws(() => effectiveDatabaseBytesSql('usage u', 't.id', true));
});

test('fold tick does nothing before the ledger SQL exists', async () => {
  const seen: string[] = [];
  const ledger = createTenantDataQuotaLedgerRepository(scriptedSql([[{ ready: false }]], seen));
  const tick = await foldTenantDataQuotaDeltas(OPTIONS, () => false, ledger);
  assert.deepEqual(tick, { batches: 0, foldedRows: 0, foldedTenants: 0, ledgerReady: false });
  assert.equal(seen.length, 1);
  assert.match(seen[0], /to_regclass\('public\.tenant_data_quota_database_deltas'\)/);
});

test('fold tick drains full batches and stops at the first short one', async () => {
  const seen: string[] = [];
  const ledger = createTenantDataQuotaLedgerRepository(scriptedSql([
    [{ ready: true }],
    [{ folded_rows: '5000', folded_tenants: 2 }],
    [{ folded_rows: '1200', folded_tenants: 1 }],
  ], seen));
  const tick = await foldTenantDataQuotaDeltas(OPTIONS, () => false, ledger);
  assert.deepEqual(tick, { batches: 2, foldedRows: 6_200, foldedTenants: 3, ledgerReady: true });
  assert.match(seen[1], /tenant_data_quota_fold_database_deltas\(\$1::integer\)/);
});

test('fold tick respects its batch budget and a stop request', async () => {
  const full = { folded_rows: '5000', folded_tenants: 1 };
  const budget = await foldTenantDataQuotaDeltas(OPTIONS, () => false,
    createTenantDataQuotaLedgerRepository(scriptedSql([[{ ready: true }], [full], [full], [full]])));
  assert.equal(budget.batches, 3);

  let calls = 0;
  const stopped = await foldTenantDataQuotaDeltas(OPTIONS, () => calls++ > 0,
    createTenantDataQuotaLedgerRepository(scriptedSql([[{ ready: true }], [full]])));
  assert.equal(stopped.batches, 1);
});

test('the repository refuses a fold size the SQL function would reject', async () => {
  const ledger = createTenantDataQuotaLedgerRepository(scriptedSql([]));
  await assert.rejects(() => ledger.fold(0));
  await assert.rejects(() => ledger.fold(100_001));
});
