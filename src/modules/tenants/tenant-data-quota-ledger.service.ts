// ═══════════════════════════════════════════════════════════════
// Tenant data quota delta ledger — folding and reads that include unfolded deltas.
// See tenant-data-quota-ledger.logic.ts for the design.
// ═══════════════════════════════════════════════════════════════

import { query } from '../../config/database.js';
import {
  effectiveDatabaseBytesSql,
  isMissingDeltaLedgerError,
  shouldFoldAnotherBatch,
  type TenantDataQuotaFoldOptions,
} from './tenant-data-quota-ledger.logic.js';
import {
  createTenantDataQuotaLedgerRepository,
  type TenantDataQuotaLedgerRepository,
} from './tenant-data-quota-ledger.repository.js';

/**
 * How long a process trusts its last catalog check. The ledger appears or
 * disappears only through a reviewed SQL file; a query that still finds it
 * missing after that resets the cache at once (see readWithPendingDatabaseBytes).
 */
const LEDGER_READINESS_CACHE_MS = 30_000;

const repository = createTenantDataQuotaLedgerRepository({ query });
let cachedReadiness: { ready: boolean; checkedAtMs: number } | null = null;

export async function isTenantDataQuotaLedgerReady(nowMs = Date.now()): Promise<boolean> {
  if (cachedReadiness && nowMs - cachedReadiness.checkedAtMs < LEDGER_READINESS_CACHE_MS) {
    return cachedReadiness.ready;
  }
  const ready = await repository.isReady();
  cachedReadiness = { ready, checkedAtMs: nowMs };
  return ready;
}

function forgetTenantDataQuotaLedgerReadiness(): void {
  cachedReadiness = null;
}

/**
 * Runs a read whose database usage must include the deltas not folded yet.
 * `buildSql` receives the expression builder for the current schema. When the
 * ledger SQL was rolled back after the last check, the read is repeated once
 * against the restored schema instead of failing.
 */
export async function readWithPendingDatabaseBytes<T extends Record<string, unknown>>(
  buildSql: (databaseBytes: (usageAlias: string, tenantIdSql: string) => string) => string,
  params: unknown[],
): Promise<{ rows: T[]; rowCount: number | null }> {
  const ready = await isTenantDataQuotaLedgerReady();
  try {
    return await query<T>(buildSql((alias, tenantIdSql) => effectiveDatabaseBytesSql(alias, tenantIdSql, ready)), params);
  } catch (error) {
    if (!ready || !isMissingDeltaLedgerError(error)) throw error;
    forgetTenantDataQuotaLedgerReadiness();
    return query<T>(buildSql((alias, tenantIdSql) => effectiveDatabaseBytesSql(alias, tenantIdSql, false)), params);
  }
}

export type TenantDataQuotaFoldTick = { batches: number; foldedRows: number; foldedTenants: number; ledgerReady: boolean };

/**
 * One worker tick: bounded batches until the ledger is drained, the batch
 * budget is used up, or the worker stops. Does nothing before the ledger SQL.
 */
export async function foldTenantDataQuotaDeltas(
  options: TenantDataQuotaFoldOptions,
  shouldStop: () => boolean = () => false,
  ledger: TenantDataQuotaLedgerRepository = repository,
): Promise<TenantDataQuotaFoldTick> {
  const tick: TenantDataQuotaFoldTick = { batches: 0, foldedRows: 0, foldedTenants: 0, ledgerReady: false };
  if (!await ledger.isReady()) return tick;
  tick.ledgerReady = true;

  let lastFoldedRows = options.batchSize;
  while (!shouldStop() && shouldFoldAnotherBatch(lastFoldedRows, tick.batches, options)) {
    const result = await ledger.fold(options.batchSize);
    tick.batches += 1;
    tick.foldedRows += result.foldedRows;
    tick.foldedTenants += result.foldedTenants;
    lastFoldedRows = result.foldedRows;
  }
  return tick;
}
