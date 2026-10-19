// ═══════════════════════════════════════════════════════════════
// Tenant data quota reconciliation worker primitives.
//
// This module intentionally uses the database as the source of truth for
// claims, leases and cursors. A process-local mutex is not sufficient when
// PM2, a rolling deployment, or a second host is involved.
// ═══════════════════════════════════════════════════════════════

import { randomUUID } from 'crypto';
import { getClient, query } from '../../config/database.js';
import { TENANT_STORAGE_BUCKETS } from '../../config/storage.js';
import { RFC_UUID_PATTERN } from '../../utils/uuid.js';
import { swallowAndLog } from '../../utils/best-effort.js';
import {
  createTenantDataQuotaReconciliationRepository,
  type ReconciliationClaimRow,
  type StorageObjectRow,
  type TenantDataQuotaReconciliationDb,
} from './tenant-data-quota-reconciliation.repository.js';

const MAX_BIGINT = 9223372036854775807n;
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

type ClaimRow = ReconciliationClaimRow;

type StorageObject = StorageObjectRow;

/** Statements on the pool. */
const repository = createTenantDataQuotaReconciliationRepository({ query } satisfies TenantDataQuotaReconciliationDb);

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

function decodeStorageCursor(value: string | null): { bucketId: string; name: string } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === 'string' && typeof parsed[1] === 'string') {
      return { bucketId: parsed[0], name: parsed[1] };
    }
  } catch {
    // A legacy single-bucket cursor can be safely replayed.
  }
  return null;
}

function encodeStorageCursor(bucketId: string, name: string): string {
  return JSON.stringify([bucketId, name]);
}

export function tenantStorageKeysetBounds(tenantId: string): { lowerBound: string; upperBound: string } {
  const normalizedTenantId = tenantId.toLowerCase();
  if (!RFC_UUID_PATTERN.test(normalizedTenantId)) {
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
  return repository.isSchemaReady();
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
  await repository.recordHeartbeat({
    workerName: heartbeat.workerName,
    instanceId: heartbeat.instanceId,
    state: heartbeat.state,
    candidates: heartbeat.candidates,
    completed: heartbeat.completed,
    yielded: heartbeat.yielded,
    failed: heartbeat.failed,
    lastError: heartbeat.lastError ? heartbeat.lastError.slice(0, 4_000) : null,
  });
}

export async function listTenantDataQuotaReconciliationCandidates(limit: number): Promise<string[]> {
  return repository.listCandidates(limit);
}

async function claimTenant(
  tenantId: string,
  claimToken: string,
  leaseSeconds: number,
): Promise<ClaimRow | null> {
  return repository.claim(tenantId, claimToken, leaseSeconds);
}

async function writeStoragePage(
  tenantId: string,
  claimToken: string,
  leaseSeconds: number,
  objects: StorageObject[],
): Promise<void> {
  const storagePaths = objects.map((object) => object.name);
  const sizes = objects.map((object) => parseStorageSize(object.size_bytes, object.name));
  const lastObject = objects[objects.length - 1];
  const cursor = encodeStorageCursor(lastObject.bucket_id, lastObject.name);
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const transaction = createTenantDataQuotaReconciliationRepository(client);
    await transaction.upsertObjectSizes(tenantId, storagePaths, sizes);
    const renewed = await transaction.renewLease({
      tenantId,
      claimToken,
      cursor,
      objectCount: objects.length,
      leaseSeconds,
    });
    if (renewed !== 1) throw new ReconciliationClaimLostError(tenantId);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined); // fails only on a broken connection, which pg-pool discards
    throw error;
  } finally {
    client.release();
  }
}

async function releaseClaim(tenantId: string, claimToken: string): Promise<void> {
  await repository.releaseClaim(tenantId, claimToken);
}

async function failClaim(
  tenantId: string,
  claimToken: string,
  error: unknown,
  options: TenantDataQuotaReconciliationOptions,
): Promise<void> {
  await repository.failClaim({
    tenantId,
    claimToken,
    message: errorMessage(error),
    retryBaseSeconds: options.retryBaseSeconds,
    retryMaxSeconds: options.retryMaxSeconds,
  });
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
  await repository.prepareFinalization(tenantId, claimToken, finalizationLeaseSeconds);

  const client = await getClient();
  try {
    await client.query('BEGIN');
    const transaction = createTenantDataQuotaReconciliationRepository(client);
    // The application pool stays at a short timeout for HTTP traffic. Only the
    // exact, fenced database baseline gets this longer transaction-local budget.
    // With the delta ledger (SQL 20261018_1100) the finish function consumes
    // exactly the unfolded deltas its per-relation snapshots already contain.
    await transaction.setLocalStatementTimeout(databaseSnapshotTimeoutMs);
    await transaction.finish(tenantId, claimToken, minimumFinalizationWindowSeconds);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined); // fails only on a broken connection, which pg-pool discards
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
    let cursor = decodeStorageCursor(claim.storage_scan_cursor);
    let pages = 0;
    const scanStartedAtMs = Date.now();
    const { lowerBound, upperBound } = tenantStorageKeysetBounds(tenantId);

    while (!shouldStop()
      && pages < options.maxPagesPerClaim
      && !isTenantDataQuotaSliceExpired(scanStartedAtMs, options.maxSliceMs)) {
      const objects = await repository.selectStoragePage({
        buckets: TENANT_STORAGE_BUCKETS,
        lowerBound,
        upperBound,
        cursorBucketId: cursor?.bucketId || '',
        cursorName: cursor?.name || '',
        pageSize: options.pageSize,
      });

      if (objects.rowCount === 0) {
        await finishReconciliation(tenantId, claimToken, options.databaseSnapshotTimeoutMs);
        ownsClaim = false;
        return 'completed';
      }

      await writeStoragePage(tenantId, claimToken, options.leaseSeconds, objects.rows);
      const lastObject = objects.rows[objects.rows.length - 1];
      cursor = { bucketId: lastObject.bucket_id, name: lastObject.name };
      pages += 1;
    }

    // Yield between bounded batches and during graceful shutdown. The state
    // remains reconciling (content writes stay fail-closed; with SQL
    // 20261018_1100 learner and sign-in writes continue and their deltas are
    // folded on top of the baseline), but another valid worker can resume
    // immediately from the durable cursor.
    await releaseClaim(tenantId, claimToken);
    ownsClaim = false;
    return 'yielded';
  } catch (error) {
    if (ownsClaim) {
      await failClaim(tenantId, claimToken, error, options).catch(swallowAndLog('tenant_quota.claim_release'));
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
