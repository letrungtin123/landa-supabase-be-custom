// ═══════════════════════════════════════════════════════════════
// Tenant data quota reconciliation — explicit operator fallback.
//
// Normal production operation uses the dedicated PM2 worker. This script
// shares the exact same durable claim/lease implementation, so it cannot race
// that worker or bypass the safety controls.
// ═══════════════════════════════════════════════════════════════

import { env } from '../config/env.js';
import { query } from '../config/database.js';
import {
  isTenantDataQuotaReconciliationSchemaReady,
  reconcileTenantDataQuota,
  type TenantDataQuotaReconciliationOptions,
} from '../modules/tenants/tenant-data-quota-reconciliation.service.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_PAGE_SIZE = 500;
const MAX_PAGE_SIZE = 1_000;

function getArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function parsePageSize(value: string | undefined): number {
  if (!value) return DEFAULT_PAGE_SIZE;
  if (!/^\d+$/.test(value)) throw new Error('--page-size must be a positive integer');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_PAGE_SIZE) {
    throw new Error(`--page-size must be between 1 and ${MAX_PAGE_SIZE}`);
  }
  return parsed;
}

async function listTenantIds(runAll: boolean, requestedTenantId: string | undefined): Promise<string[]> {
  if (!runAll) {
    if (!requestedTenantId || !UUID_PATTERN.test(requestedTenantId)) {
      throw new Error('Usage: npm run reconcile:tenant-data-quota -- --tenant <tenant UUID> [--page-size 500]');
    }
    return [requestedTenantId.toLowerCase()];
  }

  if (requestedTenantId) throw new Error('Use either --tenant <UUID> or --all, not both.');
  const result = await query<{ id: string }>('SELECT id FROM tenants ORDER BY id');
  return result.rows.map((row) => row.id);
}

function options(pageSize: number): TenantDataQuotaReconciliationOptions {
  return {
    pageSize,
    leaseSeconds: env.TENANT_DATA_QUOTA_WORKER_LEASE_SECONDS,
    databaseSnapshotTimeoutMs: env.TENANT_DATA_QUOTA_WORKER_DATABASE_SNAPSHOT_TIMEOUT_MS,
    // Operators explicitly invoking this command expect it to complete the
    // requested tenant. Crash recovery remains cursor-based and idempotent.
    maxPagesPerClaim: Number.MAX_SAFE_INTEGER,
    maxSliceMs: null,
    retryBaseSeconds: env.TENANT_DATA_QUOTA_WORKER_RETRY_BASE_SECONDS,
    retryMaxSeconds: env.TENANT_DATA_QUOTA_WORKER_RETRY_MAX_SECONDS,
  };
}

async function main(): Promise<void> {
  if (!await isTenantDataQuotaReconciliationSchemaReady()) {
    throw new Error('Quota worker SQL migration is missing. Run the approved manual SQL before using this command.');
  }

  const runAll = process.argv.includes('--all');
  const tenantIds = await listTenantIds(runAll, getArgument('--tenant'));
  const pageSize = parsePageSize(getArgument('--page-size'));
  if (tenantIds.length === 0) {
    console.log('[tenant-data-quota] No tenants found.');
    return;
  }

  for (const tenantId of tenantIds) {
    const outcome = await reconcileTenantDataQuota(tenantId, options(pageSize));
    console.log(`[tenant-data-quota] ${tenantId}: ${outcome}.`);
  }
}

main().catch((error) => {
  console.error('[tenant-data-quota] reconciliation failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
