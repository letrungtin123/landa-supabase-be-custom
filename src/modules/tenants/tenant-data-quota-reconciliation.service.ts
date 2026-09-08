// ═══════════════════════════════════════════════════════════════
// Tenant data quota reconciliation worker primitives.
//
// This module intentionally uses the database as the source of truth for
// claims, leases and cursors. A process-local mutex is not sufficient when
// PM2, a rolling deployment, or a second host is involved.
// ═══════════════════════════════════════════════════════════════

import { randomUUID } from 'crypto';
import { getClient, query } from '../../config/database.js';
import { STORAGE_BUCKET } from '../../config/storage.js';

const MAX_BIGINT = 9223372036854775807n;
const CANONICAL_TENANT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MINIMUM_SLICE_LEASE_GUARD_MS = 30_000;
const MINIMUM_FINALIZATION_START_GUARD_MS = 30_000;
const FINALIZATION_LEASE_GUARD_MS = 60_000;
const MAXIMUM_RECONCILIATION_LEASE_SECONDS = 900;

export type TenantDataQuotaWorkerHeartbeatState =
  | 'starting'
  | 'idle'
  | 'reconciling'
  | 'waiting_for_quota_schema'
  | 'stopping'
  | 'failed';

export type TenantDataQuotaWorkerHeartbeat = {
  workerName: string;
  instanceId: string;
  state: TenantDataQuotaWorkerHeartbeatState;
  candidates: number;
  completed: number;
  yielded: number;
  failed: number;
  lastError?: string | null;
};

export type TenantDataQuotaReconciliationOptions = {
  pageSize: number;
  leaseSeconds: number;
  databaseSnapshotTimeoutMs: number;
  maxPagesPerClaim: number;
  /**
   * Worker-only wall-clock budget for one resumable Storage scan slice. A
   * null value is reserved for the explicit operator CLI, which is expected
   * to continue until the requested tenant is complete.
   */
  maxSliceMs: number | null;
  retryBaseSeconds: number;
  retryMaxSeconds: number;
};

export type TenantDataQuotaReconciliationResult = 'completed' | 'yielded' | 'skipped';

type ClaimRow = {
  claimed: boolean;
  retry_at: Date | null;
  quota_state: string;
  storage_scan_cursor: string | null;
  scanned_object_count: string;
};

type StorageObject = {
  name: string;
  size_bytes: string | null;
};

class ReconciliationClaimLostError extends Error {
  constructor(tenantId: string) {
    super(`Quota reconciliation claim was lost for tenant ${tenantId}.`);
    this.name = 'ReconciliationClaimLostError';
  }
}

function parseStorageSize(value: string | null, storagePath: string): string {
  if (value === null || !/^\d+$/.test(value)) {
    throw new Error(`Storage object ${storagePath} has no valid byte-size metadata; quota remains protected.`);
  }
  const size = BigInt(value);
  if (size > MAX_BIGINT) {
    throw new Error(`Storage object ${storagePath} exceeds PostgreSQL bigint capacity.`);
  }
  return size.toString();
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4_000);
}

export function tenantStorageKeysetBounds(tenantId: string): { lowerBound: string; upperBound: string } {
  const normalizedTenantId = tenantId.toLowerCase();
  if (!CANONICAL_TENANT_ID_PATTERN.test(normalizedTenantId)) {
    throw new Error(`Invalid tenant UUID for Storage reconciliation: ${tenantId}`);
  }

  // Every tenant object has the canonical <uuid>/ prefix. Under the explicit
  // C collation, '/' is immediately followed by '0', so this range includes
  // exactly that prefix while matching storage.objects(bucket_id, name).
  return {
    lowerBound: `${normalizedTenantId}/`,
    upperBound: `${normalizedTenantId}0`,
  };
}

export function isTenantDataQuotaSliceExpired(
  startedAtMs: number,
  maxSliceMs: number | null,
  nowMs = Date.now(),
): boolean {
  return maxSliceMs !== null && nowMs - startedAtMs >= maxSliceMs;
}

/**
 * The final direct-database snapshot may legitimately run far longer than a
 * resumable Storage page. Keep its lease derived from the statement timeout,
 * rather than independently configurable, so an unsafe deployment setting is
 * impossible.
 */
export function tenantDataQuotaFinalizationLeaseSeconds(databaseSnapshotTimeoutMs: number): number {
  return Math.ceil((databaseSnapshotTimeoutMs + FINALIZATION_LEASE_GUARD_MS) / 1_000);
}

export function tenantDataQuotaMinimumFinalizationWindowSeconds(databaseSnapshotTimeoutMs: number): number {
  return Math.ceil((databaseSnapshotTimeoutMs + MINIMUM_FINALIZATION_START_GUARD_MS) / 1_000);
}

export function assertTenantDataQuotaReconciliationOptions(
  options: TenantDataQuotaReconciliationOptions,
): void {
  if (!Number.isSafeInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 1_000) {
    throw new Error('Tenant data quota worker pageSize must be between 1 and 1000.');
  }
  if (!Number.isSafeInteger(options.leaseSeconds) || options.leaseSeconds < 30 || options.leaseSeconds > MAXIMUM_RECONCILIATION_LEASE_SECONDS) {
    throw new Error('Tenant data quota worker leaseSeconds must be between 30 and 900.');
  }
  if (!Number.isSafeInteger(options.databaseSnapshotTimeoutMs)
    || options.databaseSnapshotTimeoutMs < 30_000
    || options.databaseSnapshotTimeoutMs > 600_000) {
    throw new Error('Tenant data quota worker databaseSnapshotTimeoutMs must be between 30000 and 600000.');
  }
  if (tenantDataQuotaFinalizationLeaseSeconds(options.databaseSnapshotTimeoutMs) > MAXIMUM_RECONCILIATION_LEASE_SECONDS) {
    throw new Error('Tenant data quota worker finalization lease exceeds the SQL safety maximum.');
  }
  if (!Number.isSafeInteger(options.maxPagesPerClaim) || options.maxPagesPerClaim < 1) {
    throw new Error('Tenant data quota worker maxPagesPerClaim must be a positive safe integer.');
  }
  if (options.maxSliceMs === null) return;

  const maxSafeSliceMs = options.leaseSeconds * 1_000 - MINIMUM_SLICE_LEASE_GUARD_MS;
  if (!Number.isSafeInteger(options.maxSliceMs) || options.maxSliceMs < 5_000 || options.maxSliceMs > maxSafeSliceMs) {
    throw new Error(
      `Tenant data quota worker maxSliceMs must be between 5000 and ${maxSafeSliceMs} for a ${options.leaseSeconds}s lease.`,
    );
  }
}

/**
 * A new deploy can safely ship before its companion manual SQL runs. The
 * worker stays idle instead of entering a PM2 crash loop or using a legacy,
 * lease-less reconciliation interface.
 */
export async function isTenantDataQuotaReconciliationSchemaReady(): Promise<boolean> {
  const result = await query<{ ready: boolean }>(
    `SELECT to_regprocedure('public.tenant_data_quota_list_reconciliation_candidates(integer)') IS NOT NULL
         AND to_regprocedure('public.tenant_data_quota_claim_reconciliation(uuid,uuid,integer)') IS NOT NULL
         AND to_regprocedure('public.tenant_data_quota_finish_reconciliation(uuid,uuid)') IS NOT NULL
         AND to_regclass('public.tenant_data_quota_reconciliation_queue') IS NOT NULL
         AND to_regprocedure('public.tenant_data_quota_prepare_reconciliation_finalization(uuid,uuid,integer)') IS NOT NULL
         AND to_regprocedure('public.tenant_data_quota_finish_reconciliation(uuid,uuid,integer)') IS NOT NULL
         AS ready`,
  );
  return result.rows[0]?.ready === true;
}

/**
 * Worker liveness is intentionally optional during a rolling deploy: quota
 * enforcement must keep working even before the additive heartbeat SQL has
 * been applied. Callers treat a missing function as an observability warning,
 * never as a reason to weaken the quota boundary.
 */
export async function recordTenantDataQuotaWorkerHeartbeat(
  heartbeat: TenantDataQuotaWorkerHeartbeat,
): Promise<void> {
  await query(
    `SELECT public.tenant_data_quota_record_worker_heartbeat(
       $1::text, $2::uuid, $3::text, $4::integer, $5::integer,
       $6::integer, $7::integer, $8::text
     )`,
    [
      heartbeat.workerName,
      heartbeat.instanceId,
      heartbeat.state,
      heartbeat.candidates,
      heartbeat.completed,
      heartbeat.yielded,
      heartbeat.failed,
      heartbeat.lastError ? heartbeat.lastError.slice(0, 4_000) : null,
    ],
  );
}

export async function listTenantDataQuotaReconciliationCandidates(limit: number): Promise<string[]> {
  const result = await query<{ tenant_id: string }>(
    'SELECT tenant_id FROM public.tenant_data_quota_list_reconciliation_candidates($1::integer)',
    [limit],
  );
  return result.rows.map((row) => row.tenant_id);
}

async function claimTenant(
  tenantId: string,
  claimToken: string,
  leaseSeconds: number,
): Promise<ClaimRow | null> {
  const result = await query<ClaimRow>(
    `SELECT claimed, retry_at, quota_state, storage_scan_cursor, scanned_object_count
       FROM public.tenant_data_quota_claim_reconciliation($1::uuid, $2::uuid, $3::integer)`,
    [tenantId, claimToken, leaseSeconds],
  );
  return result.rows[0] || null;
}

async function writeStoragePage(
  tenantId: string,
  claimToken: string,
  leaseSeconds: number,
  objects: StorageObject[],
): Promise<void> {
  const storagePaths = objects.map((object) => object.name);
  const sizes = objects.map((object) => parseStorageSize(object.size_bytes, object.name));
  const cursor = storagePaths[storagePaths.length - 1];
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO tenant_storage_quota_objects (tenant_id, storage_path, size_bytes)
       SELECT $1::uuid, input.storage_path, input.size_bytes
       FROM unnest($2::text[], $3::bigint[]) AS input(storage_path, size_bytes)
       ON CONFLICT (tenant_id, storage_path)
       DO UPDATE SET size_bytes = EXCLUDED.size_bytes, updated_at = now()`,
      [tenantId, storagePaths, sizes],
    );
    const leaseUpdate = await client.query(
      `UPDATE tenant_data_quota_reconciliation_runs
       SET storage_scan_cursor = $3,
           scanned_object_count = scanned_object_count + $4::bigint,
           status = 'running',
           lease_expires_at = clock_timestamp() + ($5::integer * interval '1 second'),
           heartbeat_at = clock_timestamp(),
           last_error = NULL,
           updated_at = clock_timestamp()
       WHERE tenant_id = $1::uuid
         AND claim_token = $2::uuid
         AND lease_expires_at > clock_timestamp()
       RETURNING tenant_id`,
      [tenantId, claimToken, cursor, objects.length, leaseSeconds],
    );
    if (leaseUpdate.rowCount !== 1) throw new ReconciliationClaimLostError(tenantId);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function releaseClaim(tenantId: string, claimToken: string): Promise<void> {
  await query(
    'SELECT public.tenant_data_quota_release_reconciliation_claim($1::uuid, $2::uuid, 0::integer)',
    [tenantId, claimToken],
  );
}

async function failClaim(
  tenantId: string,
  claimToken: string,
  error: unknown,
  options: TenantDataQuotaReconciliationOptions,
): Promise<void> {
  await query(
    `SELECT public.tenant_data_quota_fail_reconciliation(
       $1::uuid, $2::uuid, $3::text, $4::integer, $5::integer
     )`,
    [tenantId, claimToken, errorMessage(error), options.retryBaseSeconds, options.retryMaxSeconds],
  );
}

async function finishReconciliation(
  tenantId: string,
  claimToken: string,
  databaseSnapshotTimeoutMs: number,
): Promise<void> {
  const finalizationLeaseSeconds = tenantDataQuotaFinalizationLeaseSeconds(databaseSnapshotTimeoutMs);
  const minimumFinalizationWindowSeconds = tenantDataQuotaMinimumFinalizationWindowSeconds(databaseSnapshotTimeoutMs);

  // This autocommitted, token-checked renewal must complete before the long
  // transaction begins. If the worker lost its original claim, no snapshot is
  // attempted and the tenant remains safely reconciling.
  await query(
    `SELECT public.tenant_data_quota_prepare_reconciliation_finalization(
       $1::uuid, $2::uuid, $3::integer
     )`,
    [tenantId, claimToken, finalizationLeaseSeconds],
  );

  const client = await getClient();
  try {
    await client.query('BEGIN');
    // The application pool stays at a short timeout for HTTP traffic. Only the
    // exact, fenced database baseline gets this longer transaction-local budget.
    await client.query(
      `SELECT set_config('statement_timeout', $1::text, true)`,
      [String(databaseSnapshotTimeoutMs)],
    );
    await client.query(
      'SELECT public.tenant_data_quota_finish_reconciliation($1::uuid, $2::uuid, $3::integer)',
      [tenantId, claimToken, minimumFinalizationWindowSeconds],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Rebuild one tenant ledger under a durable database claim. A successful
 * process restart resumes from the last committed object key. It does not
 * re-scan an already enforced tenant because the claim function rejects it.
 */
export async function reconcileTenantDataQuota(
  tenantId: string,
  options: TenantDataQuotaReconciliationOptions,
  shouldStop: () => boolean = () => false,
): Promise<TenantDataQuotaReconciliationResult> {
  assertTenantDataQuotaReconciliationOptions(options);
  const claimToken = randomUUID();
  const claim = await claimTenant(tenantId, claimToken, options.leaseSeconds);
  if (!claim?.claimed) return 'skipped';

  let ownsClaim = true;
  try {
    let cursor = claim.storage_scan_cursor || '';
    let pages = 0;
    const scanStartedAtMs = Date.now();
    const { lowerBound, upperBound } = tenantStorageKeysetBounds(tenantId);

    while (!shouldStop()
      && pages < options.maxPagesPerClaim
      && !isTenantDataQuotaSliceExpired(scanStartedAtMs, options.maxSliceMs)) {
      const objects = await query<StorageObject>(
        `SELECT name, metadata ->> 'size' AS size_bytes
         FROM storage.objects
         WHERE bucket_id = $1
           AND name COLLATE "C" >= $2::text COLLATE "C"
           AND name COLLATE "C" < $3::text COLLATE "C"
           AND ($4::text = '' OR name COLLATE "C" > $4::text COLLATE "C")
         ORDER BY name COLLATE "C" ASC
         LIMIT $5::integer`,
        [STORAGE_BUCKET, lowerBound, upperBound, cursor, options.pageSize],
      );

      if (objects.rowCount === 0) {
        await finishReconciliation(tenantId, claimToken, options.databaseSnapshotTimeoutMs);
        ownsClaim = false;
        return 'completed';
      }

      await writeStoragePage(tenantId, claimToken, options.leaseSeconds, objects.rows);
      cursor = objects.rows[objects.rows.length - 1].name;
      pages += 1;
    }

    // Yield between bounded batches and during graceful shutdown. The state
    // remains reconciling (writes stay fail-closed), but another valid worker
    // can resume immediately from the durable cursor.
    await releaseClaim(tenantId, claimToken);
    ownsClaim = false;
    return 'yielded';
  } catch (error) {
    if (ownsClaim) {
      await failClaim(tenantId, claimToken, error, options).catch(() => undefined);
    }
    throw error;
  }
}

export type TenantDataQuotaCycleResult = {
  candidates: number;
  completed: number;
  yielded: number;
  skipped: number;
  failed: number;
};

/** Run a small, sequential cycle. Parallel tenant scans would multiply DB load and write fences. */
export async function runTenantDataQuotaReconciliationCycle(
  maxTenants: number,
  options: TenantDataQuotaReconciliationOptions,
  shouldStop: () => boolean = () => false,
): Promise<TenantDataQuotaCycleResult> {
  const tenantIds = await listTenantDataQuotaReconciliationCandidates(maxTenants);
  const result: TenantDataQuotaCycleResult = {
    candidates: tenantIds.length,
    completed: 0,
    yielded: 0,
    skipped: 0,
    failed: 0,
  };

  for (const tenantId of tenantIds) {
    if (shouldStop()) break;
    try {
      const outcome = await reconcileTenantDataQuota(tenantId, options, shouldStop);
      result[outcome] += 1;
      if (outcome === 'completed') {
        console.log(`[TenantDataQuotaWorker] ${tenantId}: reconciliation completed; enforcement enabled.`);
      } else if (outcome === 'yielded') {
        console.log(`[TenantDataQuotaWorker] ${tenantId}: reconciliation yielded safely; cursor progress was committed for the next slice.`);
      }
    } catch (error) {
      result.failed += 1;
      console.error(`[TenantDataQuotaWorker] ${tenantId}: reconciliation failed and was queued for retry: ${errorMessage(error)}`);
    }
  }

  return result;
}
