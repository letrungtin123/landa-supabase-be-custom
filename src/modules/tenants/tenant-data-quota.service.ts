// ═══════════════════════════════════════════════════════════════
// Tenant data quota — shared hard limit for database rows + Storage objects.
// Storage itself is external to PostgreSQL, so uploads use durable reservations
// while database writes are enforced by the matching PostgreSQL triggers.
// ═══════════════════════════════════════════════════════════════

import { randomUUID } from 'crypto';
import { getClient, query } from '../../config/database.js';
import { AppError } from '../../utils/errors.js';
import { TENANT_DATA_QUOTA_COUNTED_STATES } from './tenant-data-quota-ledger.logic.js';
import { createTenantDataQuotaLedgerRepository } from './tenant-data-quota-ledger.repository.js';
import {
  createTenantDataQuotaRepository,
  tenantDataQuotaReadSql,
  type LockedQuotaRow,
  type TenantDataQuotaDb,
  type TenantDataQuotaReadRow,
  type TenantDataQuotaState,
} from './tenant-data-quota.repository.js';
import { readWithPendingDatabaseBytes } from './tenant-data-quota-ledger.service.js';
import {
  TENANT_DATA_LIMIT_REACHED_CODE,
  TENANT_DATA_LIMIT_REACHED_MESSAGE,
  TENANT_DATA_QUOTA_RECONCILING_CODE,
  TENANT_DATA_QUOTA_RECONCILING_MESSAGE,
} from './tenant-data-quota.constants.js';
import { RFC_UUID_PATTERN } from '../../utils/uuid.js';
import { swallowAndLog } from '../../utils/best-effort.js';

export {
  TENANT_DATA_LIMIT_REACHED_CODE,
  TENANT_DATA_LIMIT_REACHED_MESSAGE,
  TENANT_DATA_QUOTA_RECONCILING_CODE,
  TENANT_DATA_QUOTA_RECONCILING_MESSAGE,
} from './tenant-data-quota.constants.js';

const STORAGE_RESERVATION_TTL_MINUTES = 30;

type QuotaState = TenantDataQuotaState;

/** Statements on the pool (they join the current transaction, if any). */
const poolRepository = createTenantDataQuotaRepository({ query } satisfies TenantDataQuotaDb);

export type StorageUploadReservation = {
  id: string | null;
  tenantId: string | null;
  storagePath: string;
  previousSizeBytes: bigint;
  requestedSizeBytes: bigint;
};

export type StorageDeleteReservation = {
  id: string;
  tenantId: string;
  storagePath: string;
};

export type TenantDataQuota = {
  limitBytes: string | null;
  databaseUsedBytes: string;
  storageUsedBytes: string;
  storageReservedBytes: string;
  totalUsedBytes: string;
  availableBytes: string | null;
  state: QuotaState;
  lastVerifiedAt: string | null;
};

function asBigInt(value: string | number | bigint | null | undefined): bigint {
  if (value === null || value === undefined) return 0n;
  return typeof value === 'bigint' ? value : BigInt(value);
}

function assertNonNegativeSize(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Invalid server-side storage byte size');
  }
  return BigInt(value);
}

function dataLimitReached(): AppError {
  return new AppError(TENANT_DATA_LIMIT_REACHED_MESSAGE, 409, TENANT_DATA_LIMIT_REACHED_CODE);
}

function dataQuotaReconciling(): AppError {
  return new AppError(TENANT_DATA_QUOTA_RECONCILING_MESSAGE, 503, TENANT_DATA_QUOTA_RECONCILING_CODE);
}

function isQuotaReconciliationState(state: QuotaState): boolean {
  return state === 'reconciling';
}

/** Returns null for platform-owned paths such as system/prompt-mascots. */
export function getTenantIdFromStoragePath(storagePath: string): string | null {
  const path = storagePath.trim();
  if (!path || path.length > 1200 || path.startsWith('/') || path.includes('..') || path.includes('\\') || path.includes('//')) {
    throw new Error('Unsafe storage path blocked by tenant quota');
  }

  const separator = path.indexOf('/');
  if (separator <= 0) return null;
  const tenantId = path.slice(0, separator);
  return RFC_UUID_PATTERN.test(tenantId) ? tenantId.toLowerCase() : null;
}

async function lockQuota(client: Awaited<ReturnType<typeof getClient>>, tenantId: string): Promise<LockedQuotaRow> {
  const repository = createTenantDataQuotaRepository(client);
  await repository.ensureUsageRow(tenantId);

  const quota = await repository.lockUsage(tenantId);
  if (!quota) throw new AppError('Doanh nghiệp không tồn tại', 404);

  // Database writes append lock-free deltas (SQL 20261018_1100) that the quota
  // worker folds later: the limit check must count the unfolded ones too. The
  // catalog check runs inside this transaction, so it works on both schemas.
  const ledger = createTenantDataQuotaLedgerRepository(client);
  if ((TENANT_DATA_QUOTA_COUNTED_STATES as readonly string[]).includes(quota.state) && await ledger.isReady()) {
    const pendingBytes = await ledger.pendingBytes(tenantId);
    quota.database_used_bytes = (asBigInt(quota.database_used_bytes) + pendingBytes).toString();
  }
  return quota;
}

export function totalTenantDataQuotaBytes(
  databaseUsedBytes: string | number | bigint | null | undefined,
  storageUsedBytes: string | number | bigint | null | undefined,
  storageReservedBytes: string | number | bigint | null | undefined,
): bigint {
  return asBigInt(databaseUsedBytes) + asBigInt(storageUsedBytes) + asBigInt(storageReservedBytes);
}

export function exceedsTenantDataLimit(
  limitBytes: string | number | bigint | null | undefined,
  databaseUsedBytes: string | number | bigint | null | undefined,
  storageUsedBytes: string | number | bigint | null | undefined,
  storageReservedBytes: string | number | bigint | null | undefined,
  additionalBytes: bigint,
): boolean {
  if (limitBytes === null || limitBytes === undefined || additionalBytes <= 0n) return false;
  return totalTenantDataQuotaBytes(databaseUsedBytes, storageUsedBytes, storageReservedBytes) + additionalBytes > asBigInt(limitBytes);
}

function exceedsLimit(quota: LockedQuotaRow, additionalBytes: bigint): boolean {
  if (quota.data_limit_bytes === null || additionalBytes <= 0n) return false;
  return exceedsTenantDataLimit(
    quota.data_limit_bytes,
    quota.database_used_bytes,
    quota.storage_used_bytes,
    quota.storage_reserved_bytes,
    additionalBytes,
  );
}

/**
 * Reserve space before an external Storage upload. A non-enforced tenant is
 * deliberately not metered here: the staged backfill must establish its first
 * consistent baseline before enforcement is enabled.
 */
export async function reserveStorageUpload(storagePath: string, requestedSize: number): Promise<StorageUploadReservation> {
  const tenantId = getTenantIdFromStoragePath(storagePath);
  const requestedSizeBytes = assertNonNegativeSize(requestedSize);
  if (!tenantId) {
    return { id: null, tenantId: null, storagePath, previousSizeBytes: 0n, requestedSizeBytes };
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');
    const repository = createTenantDataQuotaRepository(client);
    const quota = await lockQuota(client, tenantId);
    if (isQuotaReconciliationState(quota.state)) throw dataQuotaReconciling();

    const existingSizeBytes = await repository.lockObjectSize(tenantId, storagePath);
    const previousSizeBytes = asBigInt(existingSizeBytes);
    const delta = requestedSizeBytes > previousSizeBytes ? requestedSizeBytes - previousSizeBytes : 0n;
    if (quota.state === 'drifted' && delta > 0n) throw dataQuotaReconciling();
    if (quota.state !== 'enforced' && quota.state !== 'drifted') {
      await client.query('COMMIT');
      return { id: null, tenantId, storagePath, previousSizeBytes, requestedSizeBytes };
    }
    if (exceedsLimit(quota, delta)) throw dataLimitReached();

    const reservationId = randomUUID();
    await repository.insertUploadReservation({
      id: reservationId,
      tenantId,
      storagePath,
      requestedSizeBytes: requestedSizeBytes.toString(),
      previousSizeBytes: previousSizeBytes.toString(),
      reservedBytes: delta.toString(),
      ttlMinutes: STORAGE_RESERVATION_TTL_MINUTES,
    });
    if (delta > 0n) {
      await repository.addReservedBytes(tenantId, delta.toString());
    }
    await client.query('COMMIT');
    return { id: reservationId, tenantId, storagePath, previousSizeBytes, requestedSizeBytes };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined); // fails only on a broken connection, which pg-pool discards
    throw error;
  } finally {
    client.release();
  }
}

/** Finalize an upload only after Supabase has acknowledged the object write. */
export async function commitStorageUpload(reservation: StorageUploadReservation, actualSize: number): Promise<void> {
  if (!reservation.id || !reservation.tenantId) return;
  const actualSizeBytes = assertNonNegativeSize(actualSize);
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const repository = createTenantDataQuotaRepository(client);
    const row = await repository.lockReservation(reservation.id);
    if (!row || row.status === 'committed' || row.status === 'reconciled') {
      await client.query('COMMIT');
      return;
    }
    if (row.status !== 'pending') throw new Error('Storage reservation is not finalizable');

    const quota = await lockQuota(client, row.tenant_id);
    if (isQuotaReconciliationState(quota.state)) {
      await repository.markReservationReconcileRequired(row.id);
      await client.query('COMMIT');
      return;
    }
    const previousSizeBytes = asBigInt(row.previous_size_bytes);
    const reservedBytes = asBigInt(row.reserved_bytes);
    const actualDelta = actualSizeBytes - previousSizeBytes;
    if (quota.state === 'drifted' && actualDelta > 0n) {
      await repository.markReservationReconcileRequired(row.id);
      await client.query('COMMIT');
      throw dataQuotaReconciling();
    }
    const projected = asBigInt(quota.database_used_bytes)
      + asBigInt(quota.storage_used_bytes)
      + actualDelta
      + asBigInt(quota.storage_reserved_bytes)
      - reservedBytes;

    if (quota.data_limit_bytes !== null && projected > asBigInt(quota.data_limit_bytes)) {
      await repository.markReservationReconcileRequired(row.id);
      await client.query('COMMIT');
      throw dataLimitReached();
    }

    const nextStorageUsage = asBigInt(quota.storage_used_bytes) + actualDelta;
    if (nextStorageUsage < 0n) throw new Error('Storage quota usage underflow blocked');

    await repository.upsertObjectSize(row.tenant_id, row.storage_path, actualSizeBytes.toString());
    await repository.commitUploadUsage(row.tenant_id, nextStorageUsage.toString(), reservedBytes.toString());
    await repository.markReservationCommitted(row.id);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined); // fails only on a broken connection, which pg-pool discards
    throw error;
  } finally {
    client.release();
  }
}

/**
 * A transport/provider failure is ambiguous. Keep the reservation instead of
 * freeing capacity optimistically; reconciliation will decide the final state.
 */
export async function flagStorageUploadForReconciliation(reservation: StorageUploadReservation): Promise<void> {
  if (!reservation.id) return;
  await poolRepository.flagUploadReservation(reservation.id);
}

/**
 * A provider-declared upload rejection is definitive: no object write occurred,
 * so the pre-reserved bytes must be returned immediately. Transport failures
 * deliberately do not use this path because their final provider outcome is
 * unknown and must remain fenced for reconciliation.
 */
export async function releaseStorageUploadReservation(reservation: StorageUploadReservation): Promise<void> {
  if (!reservation.id) return;
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const repository = createTenantDataQuotaRepository(client);
    const row = await repository.lockReservationForRelease(reservation.id);
    if (!row || row.status !== 'pending') {
      await client.query('COMMIT');
      return;
    }

    const quota = await lockQuota(client, row.tenant_id);
    const reservedBytes = asBigInt(row.reserved_bytes);
    const currentReservedBytes = asBigInt(quota.storage_reserved_bytes);
    if (currentReservedBytes < reservedBytes) {
      throw new Error('Storage quota reservation underflow blocked');
    }

    await repository.releaseReservedBytes(row.tenant_id, reservedBytes.toString());
    await repository.markReservationReleased(row.id);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined); // fails only on a broken connection, which pg-pool discards
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Fence a Storage delete before calling the external provider. The durable,
 * zero-byte reservation keeps a reconciliation from snapshotting between a
 * provider delete and its local object-ledger update.
 */
export async function reserveStorageDeletes(storagePaths: readonly string[]): Promise<StorageDeleteReservation[]> {
  const byTenant = new Map<string, string[]>();
  for (const rawPath of storagePaths) {
    const storagePath = rawPath.trim();
    if (!storagePath) continue;
    const tenantId = getTenantIdFromStoragePath(storagePath);
    if (!tenantId) continue;
    const paths = byTenant.get(tenantId) || [];
    paths.push(storagePath);
    byTenant.set(tenantId, paths);
  }

  const reservations: StorageDeleteReservation[] = [];
  try {
    for (const [tenantId, rawPaths] of byTenant) {
      const paths = [...new Set(rawPaths)];
      const client = await getClient();
      try {
        await client.query('BEGIN');
        const repository = createTenantDataQuotaRepository(client);
        const quota = await lockQuota(client, tenantId);
        if (isQuotaReconciliationState(quota.state)) throw dataQuotaReconciling();
        const existing = await repository.lockObjectSizes(tenantId, paths);
        const sizes = new Map(existing.map((row) => [row.storage_path, row.size_bytes]));
        for (const storagePath of paths) {
          const id = randomUUID();
          await repository.insertDeleteReservation({
            id,
            tenantId,
            storagePath,
            previousSizeBytes: asBigInt(sizes.get(storagePath)).toString(),
            ttlMinutes: STORAGE_RESERVATION_TTL_MINUTES,
          });
          reservations.push({ id, tenantId, storagePath });
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined); // fails only on a broken connection, which pg-pool discards
        throw error;
      } finally {
        client.release();
      }
    }
  } catch (error) {
    await flagStorageDeletesForReconciliation(reservations).catch(swallowAndLog('storage.reconciliation_flag'));
    throw error;
  }
  return reservations;
}

export async function flagStorageDeletesForReconciliation(reservations: readonly StorageDeleteReservation[]): Promise<void> {
  if (reservations.length === 0) return;
  await poolRepository.flagDeleteReservations(reservations.map((reservation) => reservation.id));
}

/** Release zero-byte delete fences after a provider-declared rejection. */
export async function releaseStorageDeleteReservations(reservations: readonly StorageDeleteReservation[]): Promise<void> {
  if (reservations.length === 0) return;
  await poolRepository.releaseDeleteReservations(reservations.map((reservation) => reservation.id));
}

/** Call only after Supabase successfully removes every supplied object. */
export async function recordStorageDelete(
  storagePaths: readonly string[],
  reservations: readonly StorageDeleteReservation[] = [],
): Promise<void> {
  const byTenant = new Map<string, string[]>();
  for (const rawPath of storagePaths) {
    const storagePath = rawPath.trim();
    if (!storagePath) continue;
    const tenantId = getTenantIdFromStoragePath(storagePath);
    if (!tenantId) continue;
    const paths = byTenant.get(tenantId) || [];
    paths.push(storagePath);
    byTenant.set(tenantId, paths);
  }

  for (const [tenantId, paths] of byTenant) {
    const client = await getClient();
    try {
      await client.query('BEGIN');
      const repository = createTenantDataQuotaRepository(client);
      const quota = await lockQuota(client, tenantId);
      if (isQuotaReconciliationState(quota.state)) throw dataQuotaReconciling();
      const rows = await repository.deleteObjects(tenantId, [...new Set(paths)]);
      const freed = rows.reduce((sum, row) => sum + asBigInt(row.size_bytes), 0n);
      if (freed > 0n) {
        const nextUsage = asBigInt(quota.storage_used_bytes) - freed;
        if (nextUsage < 0n) throw new Error('Storage quota usage underflow blocked');
        await repository.setStorageUsed(tenantId, nextUsage.toString());
      }
      const reservationIds = reservations
        .filter((reservation) => reservation.tenantId === tenantId)
        .map((reservation) => reservation.id);
      if (reservationIds.length > 0) {
        await repository.commitDeleteReservations(reservationIds);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined); // fails only on a broken connection, which pg-pool discards
      throw error;
    } finally {
      client.release();
    }
  }
}

export async function getTenantDataQuota(tenantId: string): Promise<TenantDataQuota | null> {
  // Database usage includes the deltas the quota worker has not folded yet.
  const result = await readWithPendingDatabaseBytes<TenantDataQuotaReadRow>(tenantDataQuotaReadSql, [tenantId]);
  const row = result.rows[0];
  if (!row) return null;
  const databaseUsedBytes = row.database_used_bytes || '0';
  const storageUsedBytes = row.storage_used_bytes || '0';
  const storageReservedBytes = row.storage_reserved_bytes || '0';
  const total = asBigInt(databaseUsedBytes) + asBigInt(storageUsedBytes) + asBigInt(storageReservedBytes);
  const available = row.data_limit_bytes === null ? null : asBigInt(row.data_limit_bytes) - total;
  return {
    limitBytes: row.data_limit_bytes,
    databaseUsedBytes,
    storageUsedBytes,
    storageReservedBytes,
    totalUsedBytes: total.toString(),
    availableBytes: available === null ? null : (available > 0n ? available : 0n).toString(),
    state: row.state || 'initializing',
    lastVerifiedAt: row.last_verified_at ? row.last_verified_at.toISOString() : null,
  };
}
