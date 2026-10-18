// ═══════════════════════════════════════════════════════════════
// Tenant data quota delta ledger — SQL only (see tenant-data-quota-ledger.logic.ts).
// ═══════════════════════════════════════════════════════════════

import { TENANT_DATA_QUOTA_FOLD_MAX_ROWS } from './tenant-data-quota-ledger.logic.js';

export interface TenantDataQuotaLedgerSql {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string, params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

export type TenantDataQuotaFoldResult = { foldedRows: number; foldedTenants: number };

export type TenantDataQuotaLedgerSummary = {
  pendingDeltas: string;
  pendingTenants: string;
  pendingBytes: string;
  oldestPendingAgeSeconds: number | null;
};

export function createTenantDataQuotaLedgerRepository(db: TenantDataQuotaLedgerSql) {
  return {
    /** Catalog only: true once the ledger SQL is applied. */
    async isReady(): Promise<boolean> {
      const result = await db.query<{ ready: boolean }>(
        `SELECT to_regclass('public.tenant_data_quota_database_deltas') IS NOT NULL
            AND to_regprocedure('public.tenant_data_quota_pending_database_bytes(uuid)') IS NOT NULL
            AND to_regprocedure('public.tenant_data_quota_fold_database_deltas(integer)') IS NOT NULL
            AS ready`,
      );
      return result.rows[0]?.ready === true;
    },

    /** One bounded fold; never waits for a locked usage row (SKIP LOCKED in SQL). */
    async fold(maxRows: number): Promise<TenantDataQuotaFoldResult> {
      if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > TENANT_DATA_QUOTA_FOLD_MAX_ROWS) {
        throw new Error(`Tenant data quota fold size must be between 1 and ${TENANT_DATA_QUOTA_FOLD_MAX_ROWS}.`);
      }
      const result = await db.query<{ folded_rows: string; folded_tenants: number }>(
        'SELECT folded_rows, folded_tenants FROM public.tenant_data_quota_fold_database_deltas($1::integer)',
        [maxRows],
      );
      const row = result.rows[0];
      return { foldedRows: Number(row?.folded_rows ?? 0), foldedTenants: Number(row?.folded_tenants ?? 0) };
    },

    async pendingBytes(tenantId: string): Promise<bigint> {
      const result = await db.query<{ pending_bytes: string }>(
        'SELECT public.tenant_data_quota_pending_database_bytes($1::uuid)::text AS pending_bytes',
        [tenantId],
      );
      return BigInt(result.rows[0]?.pending_bytes ?? '0');
    },

    /** Small table (bounded by the fold interval): a full aggregate is cheap. */
    async summary(): Promise<TenantDataQuotaLedgerSummary> {
      const result = await db.query<{
        pending_deltas: string;
        pending_tenants: string;
        pending_bytes: string;
        oldest_pending_age_seconds: string | null;
      }>(
        `SELECT COUNT(*)::text AS pending_deltas,
                COUNT(DISTINCT quota_tenant_id)::text AS pending_tenants,
                COALESCE(SUM(delta_bytes), 0)::text AS pending_bytes,
                FLOOR(EXTRACT(EPOCH FROM clock_timestamp() - MIN(created_at)))::text AS oldest_pending_age_seconds
         FROM public.tenant_data_quota_database_deltas`,
      );
      const row = result.rows[0];
      return {
        pendingDeltas: row?.pending_deltas ?? '0',
        pendingTenants: row?.pending_tenants ?? '0',
        pendingBytes: row?.pending_bytes ?? '0',
        oldestPendingAgeSeconds: row?.oldest_pending_age_seconds == null ? null : Number(row.oldest_pending_age_seconds),
      };
    },
  };
}

export type TenantDataQuotaLedgerRepository = ReturnType<typeof createTenantDataQuotaLedgerRepository>;
