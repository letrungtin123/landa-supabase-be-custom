// Tenant data quota integration smoke test.
//
// This script intentionally mutates only a disposable test database and rolls
// its transaction back. It refuses to run unless the operator explicitly opts
// in. Never point TEST_DATABASE_URL at production.
//
// It works on both quota schemas: before SQL 20261018_1100 the trigger updates
// tenant_data_quota_usage directly; after it the trigger appends lock-free
// deltas that the quota worker folds, and the checks below also cover the
// unfolded deltas, the fold and writes during a reconciliation (audit M4).

import { randomUUID } from 'crypto';
import { Pool, type PoolClient } from 'pg';
import { createTenantDataQuotaLedgerRepository } from '../modules/tenants/tenant-data-quota-ledger.repository.js';

const CONFIRMATION = 'YES_RUN_QUOTA_INTEGRATION_TEST';

function requiredTestDatabaseUrl(): string {
  const value = process.env.TEST_DATABASE_URL?.trim();
  if (!value) throw new Error('Thiếu TEST_DATABASE_URL cho database staging/test tách biệt.');
  if (process.env.RUN_TENANT_DATA_QUOTA_INTEGRATION_TESTS !== CONFIRMATION) {
    throw new Error(`Đặt RUN_TENANT_DATA_QUOTA_INTEGRATION_TESTS=${CONFIRMATION} để xác nhận chạy test có ghi rồi rollback.`);
  }

  const url = new URL(value);
  const databaseName = decodeURIComponent(url.pathname).replace(/^\//, '').toLowerCase();
  if (!/(^|[-_])(test|testing|staging)([-_]|$)/.test(databaseName)) {
    throw new Error('TEST_DATABASE_URL phải trỏ database có tên chứa test/testing/staging. Production bị từ chối.');
  }
  return value;
}

async function expectSqlState(client: PoolClient, sqlState: string, sql: string, params: unknown[]): Promise<void> {
  await client.query('SAVEPOINT expect_sql_state');
  try {
    await client.query(sql, params);
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT expect_sql_state');
    if ((error as { code?: string }).code === sqlState) return;
    throw error;
  }
  throw new Error(`Expected quota SQLSTATE ${sqlState}, but the database write succeeded.`);
}

type UsageRow = { database_used_bytes: string; state: string };

async function readUsage(client: PoolClient, tenantId: string): Promise<UsageRow> {
  const result = await client.query<UsageRow>(
    'SELECT database_used_bytes::text, state FROM public.tenant_data_quota_usage WHERE tenant_id = $1::uuid',
    [tenantId],
  );
  if (!result.rows[0]) throw new Error('Tenant test không có dòng usage.');
  return result.rows[0];
}

const AUDIT_INSERT = `INSERT INTO public.audit_logs (tenant_id, action, entity_type, details)
  VALUES ($1::uuid, 'UPDATE', 'tenant', 'quota integration row') RETURNING id`;

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: requiredTestDatabaseUrl(), max: 1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = '30000'`);

    const coverage = await client.query<{ registered: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM public.tenant_data_quota_table_registry
         WHERE relation_name = 'public.audit_logs'::regclass
       ) AS registered`,
    );
    if (!coverage.rows[0]?.registered) {
      throw new Error('audit_logs không nằm trong quota registry của test database; không thể dùng nó để kiểm thử trigger an toàn.');
    }
    const ledger = createTenantDataQuotaLedgerRepository(client);
    const ledgerReady = await ledger.isReady();

    const suffix = randomUUID().replace(/-/g, '').slice(0, 16);
    const tenantResult = await client.query<{ id: string }>(
      `INSERT INTO public.tenants (name, slug)
       VALUES ($1, $2)
       RETURNING id`,
      [`Quota integration ${suffix}`, `quota-integration-${suffix}`],
    );
    const tenantId = tenantResult.rows[0]?.id;
    if (!tenantId) throw new Error('Không thể tạo tenant test.');

    const initial = await readUsage(client, tenantId);
    if (initial.state !== 'enforced') {
      throw new Error(`Tenant test phải được enforced ngay khi tạo, nhận: ${initial.state}.`);
    }
    const effectiveBytes = async (): Promise<bigint> => {
      const usage = await readUsage(client, tenantId);
      return BigInt(usage.database_used_bytes) + (ledgerReady ? await ledger.pendingBytes(tenantId) : 0n);
    };

    const firstAudit = await client.query<{ id: string }>(AUDIT_INSERT, [tenantId]);
    const firstAuditId = firstAudit.rows[0]?.id;
    if (!firstAuditId) throw new Error('Không thể tạo audit row test.');

    const limitBytes = await effectiveBytes();
    if (limitBytes <= 0n) {
      throw new Error('Database usage không tăng sau write test; quota trigger có thể không hoạt động.');
    }
    if (ledgerReady && (await readUsage(client, tenantId)).database_used_bytes !== initial.database_used_bytes) {
      throw new Error('Với delta ledger, trigger không được cập nhật trực tiếp dòng usage của tenant.');
    }

    // The limit check counts the unfolded delta of the first write.
    await client.query(
      `UPDATE public.tenants SET data_limit_bytes = $2::bigint WHERE id = $1::uuid`,
      [tenantId, limitBytes.toString()],
    );
    await expectSqlState(client, 'LQ001', AUDIT_INSERT, [tenantId]);

    await client.query('DELETE FROM public.audit_logs WHERE id = $1', [firstAuditId]);
    await client.query(AUDIT_INSERT, [tenantId]);

    if (ledgerReady) {
      const beforeFold = await effectiveBytes();
      let folded = 0;
      do {
        folded = (await ledger.fold(10_000)).foldedRows;
      } while (folded > 0);
      if (await ledger.pendingBytes(tenantId) !== 0n || await effectiveBytes() !== beforeFold) {
        throw new Error('Fold phải chuyển toàn bộ delta vào usage mà không đổi tổng.');
      }

      // M4: learner and sign-in tables stay writable while reconciling; content stays fail-closed.
      await client.query(
        `UPDATE public.tenants SET data_limit_bytes = NULL WHERE id = $1::uuid`,
        [tenantId],
      );
      await client.query(
        `UPDATE public.tenant_data_quota_usage SET state = 'reconciling' WHERE tenant_id = $1::uuid`,
        [tenantId],
      );
      await client.query(AUDIT_INSERT, [tenantId]);
      await expectSqlState(
        client,
        'LQ002',
        `INSERT INTO public.course_categories (tenant_id, name, slug) VALUES ($1::uuid, 'Quota integration', $2)`,
        [tenantId, `quota-integration-${suffix}`],
      );
      if (await ledger.pendingBytes(tenantId) <= 0n) {
        throw new Error('Write khi reconciling phải được ghi thành delta để cộng sau.');
      }
    }

    console.log(`[tenant-data-quota:integration] Passed (${ledgerReady ? 'delta ledger' : 'direct trigger'}): DB quota rejects over-limit writes and accepts a write after capacity is released${ledgerReady ? '; unfolded deltas count, the fold keeps the total, learner writes continue while reconciling' : ''}.`);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined); // fails only on a broken connection, which pg-pool discards
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error('[tenant-data-quota:integration] Failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
