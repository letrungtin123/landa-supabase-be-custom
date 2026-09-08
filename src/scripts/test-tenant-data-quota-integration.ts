// Tenant data quota integration smoke test.
//
// This script intentionally mutates only a disposable test database and rolls
// its transaction back. It refuses to run unless the operator explicitly opts
// in. Never point TEST_DATABASE_URL at production.

import { randomUUID } from 'crypto';
import { Pool, type PoolClient } from 'pg';

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

async function expectQuotaLimit(client: PoolClient, sql: string, params: unknown[]): Promise<void> {
  try {
    await client.query(sql, params);
  } catch (error) {
    if ((error as { code?: string }).code === 'LQ001') return;
    throw error;
  }
  throw new Error('Expected quota SQLSTATE LQ001, but the database write succeeded.');
}

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

    const suffix = randomUUID().replace(/-/g, '').slice(0, 16);
    const tenantResult = await client.query<{ id: string }>(
      `INSERT INTO public.tenants (name, slug)
       VALUES ($1, $2)
       RETURNING id`,
      [`Quota integration ${suffix}`, `quota-integration-${suffix}`],
    );
    const tenantId = tenantResult.rows[0]?.id;
    if (!tenantId) throw new Error('Không thể tạo tenant test.');

    const initialState = await client.query<{ state: string }>(
      `SELECT state FROM public.tenant_data_quota_usage WHERE tenant_id = $1::uuid`,
      [tenantId],
    );
    if (initialState.rows[0]?.state !== 'enforced') {
      throw new Error(`Tenant test phải được enforced ngay khi tạo, nhận: ${initialState.rows[0]?.state ?? 'missing'}.`);
    }

    const firstAudit = await client.query<{ id: string }>(
      `INSERT INTO public.audit_logs (tenant_id, action, entity_type, details)
       VALUES ($1::uuid, 'UPDATE', 'quota_integration_test', 'quota integration row')
       RETURNING id`,
      [tenantId],
    );
    const firstAuditId = firstAudit.rows[0]?.id;
    if (!firstAuditId) throw new Error('Không thể tạo audit row test.');

    const usedAfterFirstWrite = await client.query<{ database_used_bytes: string }>(
      `SELECT database_used_bytes::text
       FROM public.tenant_data_quota_usage
       WHERE tenant_id = $1::uuid`,
      [tenantId],
    );
    const limitBytes = usedAfterFirstWrite.rows[0]?.database_used_bytes;
    if (!limitBytes || BigInt(limitBytes) <= 0n) {
      throw new Error('Database usage không tăng sau write test; quota trigger có thể không hoạt động.');
    }

    await client.query(
      `UPDATE public.tenants SET data_limit_bytes = $2::bigint WHERE id = $1::uuid`,
      [tenantId, limitBytes],
    );
    await expectQuotaLimit(
      client,
      `INSERT INTO public.audit_logs (tenant_id, action, entity_type, details)
       VALUES ($1::uuid, 'UPDATE', 'quota_integration_test', 'quota integration row')`,
      [tenantId],
    );

    await client.query('DELETE FROM public.audit_logs WHERE id = $1', [firstAuditId]);
    await client.query(
      `INSERT INTO public.audit_logs (tenant_id, action, entity_type, details)
       VALUES ($1::uuid, 'UPDATE', 'quota_integration_test', 'quota integration row')`,
      [tenantId],
    );

    console.log('[tenant-data-quota:integration] Passed: DB quota rejects over-limit writes and accepts a write after capacity is released.');
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error('[tenant-data-quota:integration] Failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
