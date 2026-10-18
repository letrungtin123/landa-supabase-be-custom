// ═══════════════════════════════════════════════════════════════
// Tenant data quota delta ledger — pure rules.
//
// Since supabase/manual_sql/20261018_1100_perf_tenant_quota_lock_free_deltas.sql
// the quota trigger no longer locks and updates the tenant's usage row: every
// statement appends its database-size change to
// public.tenant_data_quota_database_deltas and the quota worker folds the
// deltas into tenant_data_quota_usage. A tenant's database usage is therefore
// the folded counter plus its unfolded deltas. The backend must keep working
// before that SQL is applied, so every read checks that the ledger exists.
// ═══════════════════════════════════════════════════════════════

/** Upper bound enforced by public.tenant_data_quota_fold_database_deltas(integer). */
export const TENANT_DATA_QUOTA_FOLD_MAX_ROWS = 100_000;

/** States whose database counter is maintained; the fold discards deltas of the others, as before. */
export const TENANT_DATA_QUOTA_COUNTED_STATES = ['enforced', 'drifted', 'reconciling'] as const;

const MISSING_LEDGER_SQLSTATES: ReadonlySet<string> = new Set(['42883', '42P01']);
const SQL_OPERAND_PATTERN = /^(?:[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*|\$[1-9][0-9]*::uuid)$/;

export type TenantDataQuotaFoldOptions = {
  intervalMs: number;
  batchSize: number;
  maxBatchesPerTick: number;
};

export function assertTenantDataQuotaFoldOptions(options: TenantDataQuotaFoldOptions): void {
  if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 500 || options.intervalMs > 60_000) {
    throw new Error('Tenant data quota fold intervalMs must be between 500 and 60000.');
  }
  if (!Number.isSafeInteger(options.batchSize) || options.batchSize < 100 || options.batchSize > TENANT_DATA_QUOTA_FOLD_MAX_ROWS) {
    throw new Error(`Tenant data quota fold batchSize must be between 100 and ${TENANT_DATA_QUOTA_FOLD_MAX_ROWS}.`);
  }
  if (!Number.isSafeInteger(options.maxBatchesPerTick) || options.maxBatchesPerTick < 1 || options.maxBatchesPerTick > 1_000) {
    throw new Error('Tenant data quota fold maxBatchesPerTick must be between 1 and 1000.');
  }
}

/**
 * A tick keeps folding while the last batch was full (more deltas are waiting)
 * and its batch budget is not used up. A short batch means the ledger is
 * drained, or the remaining tenants are locked by a reservation or a
 * reconciliation and will be folded by a later tick.
 */
export function shouldFoldAnotherBatch(
  lastFoldedRows: number,
  batchesDone: number,
  options: Pick<TenantDataQuotaFoldOptions, 'batchSize' | 'maxBatchesPerTick'>,
): boolean {
  return lastFoldedRows >= options.batchSize && batchesDone < options.maxBatchesPerTick;
}

/** The ledger SQL is not applied (yet, or any more after its rollback). */
export function isMissingDeltaLedgerError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && MISSING_LEDGER_SQLSTATES.has(code);
}

/**
 * SQL expression for a tenant's database bytes including the deltas the
 * folder has not applied yet. Operands are code constants (`alias.column` or
 * `$n::uuid`), never request data.
 */
export function effectiveDatabaseBytesSql(usageAlias: string, tenantIdSql: string, ledgerReady: boolean): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(usageAlias) || !SQL_OPERAND_PATTERN.test(tenantIdSql)) {
    throw new Error('Unsafe SQL operand for tenant data quota usage');
  }
  const folded = `COALESCE(${usageAlias}.database_used_bytes, 0)`;
  if (!ledgerReady) return folded;
  const states = TENANT_DATA_QUOTA_COUNTED_STATES.map((state) => `'${state}'`).join(', ');
  return `(${folded} + CASE WHEN ${usageAlias}.state IN (${states})`
    + ` THEN public.tenant_data_quota_pending_database_bytes(${tenantIdSql}) ELSE 0 END)`;
}
