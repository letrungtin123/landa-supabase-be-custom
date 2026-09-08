// ═══════════════════════════════════════════════════════════════
// Tenant data quota — shared hard limit for database rows + Storage objects.
// Storage itself is external to PostgreSQL, so uploads use durable reservations
// while database writes are enforced by the matching PostgreSQL triggers.
// ═══════════════════════════════════════════════════════════════

import { randomUUID } from 'crypto';
import { getClient, query } from '../../config/database.js';
import { AppError } from '../../middleware/error-handler.js';
import {
  TENANT_DATA_LIMIT_REACHED_CODE,
  TENANT_DATA_LIMIT_REACHED_MESSAGE,
  TENANT_DATA_QUOTA_RECONCILING_CODE,
  TENANT_DATA_QUOTA_RECONCILING_MESSAGE,
} from './tenant-data-quota.constants.js';

export {
  TENANT_DATA_LIMIT_REACHED_CODE,
  TENANT_DATA_LIMIT_REACHED_MESSAGE,
  TENANT_DATA_QUOTA_RECONCILING_CODE,
  TENANT_DATA_QUOTA_RECONCILING_MESSAGE,
} from './tenant-data-quota.constants.js';

const STORAGE_RESERVATION_TTL_MINUTES = 30;
const TENANT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type QuotaState = 'initializing' | 'observing' | 'enforced' | 'reconciling' | 'drifted';

type LockedQuotaRow = {
  data_limit_bytes: string | null;
  database_used_bytes: string;
  storage_used_bytes: string;
  storage_reserved_bytes: string;
  state: QuotaState;
};

type ReservationRow = {
  id: string;
  tenant_id: string;
  storage_path: string;
  previous_size_bytes: string;
  reserved_bytes: string;
  requested_size_bytes: string;
  status: 'pending' | 'committed' | 'released' | 'reconcile_required' | 'reconciled';
};

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
  return TENANT_ID_PATTERN.test(tenantId) ? tenantId.toLowerCase() : null;
}

async function lockQuota(client: Awaited<ReturnType<typeof getClient>>, tenantId: string): Promise<LockedQuotaRow> {
  await client.query(
    `INSERT INTO tenant_data_quota_usage (tenant_id)
     VALUES ($1::uuid)
     ON CONFLICT (tenant_id) DO NOTHING`,
    [tenantId],
  );

  const result = await client.query<LockedQuotaRow>(
    `SELECT t.data_limit_bytes,
            usage.database_used_bytes,
            usage.storage_used_bytes,
            usage.storage_reserved_bytes,
            usage.state
     FROM tenants t
     JOIN tenant_data_quota_usage usage ON usage.tenant_id = t.id
     WHERE t.id = $1::uuid
     FOR UPDATE OF usage`,
    [tenantId],
  );

  if (!result.rows[0]) throw new AppError('Doanh nghiệp không tồn tại', 404);
  return result.rows[0];
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
    const quota = await lockQuota(client, tenantId);
    if (isQuotaReconciliationState(quota.state)) throw dataQuotaReconciling();

    const existing = await client.query<{ size_bytes: string }>(
      `SELECT size_bytes
       FROM tenant_storage_quota_objects
       WHERE tenant_id = $1::uuid AND storage_path = $2
       FOR UPDATE`,
      [tenantId, storagePath],
    );
    const previousSizeBytes = asBigInt(existing.rows[0]?.size_bytes);
    const delta = requestedSizeBytes > previousSizeBytes ? requestedSizeBytes - previousSizeBytes : 0n;
    if (quota.state === 'drifted' && delta > 0n) throw dataQuotaReconciling();
    if (quota.state !== 'enforced' && quota.state !== 'drifted') {
      await client.query('COMMIT');
      return { id: null, tenantId, storagePath, previousSizeBytes, requestedSizeBytes };
    }
    if (exceedsLimit(quota, delta)) throw dataLimitReached();

    const reservationId = randomUUID();
    await client.query(
      `INSERT INTO tenant_storage_quota_reservations
         (id, tenant_id, storage_path, requested_size_bytes, previous_size_bytes, reserved_bytes, expires_at)
       VALUES ($1::uuid, $2::uuid, $3, $4::bigint, $5::bigint, $6::bigint,
               now() + ($7::int * interval '1 minute'))`,
      [reservationId, tenantId, storagePath, requestedSizeBytes.toString(), previousSizeBytes.toString(), delta.toString(), STORAGE_RESERVATION_TTL_MINUTES],
    );
    if (delta > 0n) {
      await client.query(
        `UPDATE tenant_data_quota_usage
         SET storage_reserved_bytes = storage_reserved_bytes + $2::bigint,
             revision = revision + 1,
             updated_at = now()
         WHERE tenant_id = $1::uuid`,
        [tenantId, delta.toString()],
      );
    }
    await client.query('COMMIT');
    return { id: reservationId, tenantId, storagePath, previousSizeBytes, requestedSizeBytes };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
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
    const reservationResult = await client.query<ReservationRow>(
      `SELECT id, tenant_id, storage_path, previous_size_bytes, reserved_bytes, requested_size_bytes, status
       FROM tenant_storage_quota_reservations
       WHERE id = $1::uuid
       FOR UPDATE`,
      [reservation.id],
    );
    const row = reservationResult.rows[0];
    if (!row || row.status === 'committed' || row.status === 'reconciled') {
      await client.query('COMMIT');
      return;
    }
    if (row.status !== 'pending') throw new Error('Storage reservation is not finalizable');

    const quota = await lockQuota(client, row.tenant_id);
    if (isQuotaReconciliationState(quota.state)) {
      await client.query(
        `UPDATE tenant_storage_quota_reservations
         SET status = 'reconcile_required', updated_at = now()
         WHERE id = $1::uuid`,
        [row.id],
      );
      await client.query('COMMIT');
      return;
    }
    const previousSizeBytes = asBigInt(row.previous_size_bytes);
    const reservedBytes = asBigInt(row.reserved_bytes);
    const actualDelta = actualSizeBytes - previousSizeBytes;
    if (quota.state === 'drifted' && actualDelta > 0n) {
      await client.query(
        `UPDATE tenant_storage_quota_reservations
         SET status = 'reconcile_required', updated_at = now()
         WHERE id = $1::uuid`,
        [row.id],
      );
      await client.query('COMMIT');
      throw dataQuotaReconciling();
    }
    const projected = asBigInt(quota.database_used_bytes)
      + asBigInt(quota.storage_used_bytes)
      + actualDelta
      + asBigInt(quota.storage_reserved_bytes)
      - reservedBytes;

    if (quota.data_limit_bytes !== null && projected > asBigInt(quota.data_limit_bytes)) {
      await client.query(
        `UPDATE tenant_storage_quota_reservations
         SET status = 'reconcile_required', updated_at = now()
         WHERE id = $1::uuid`,
        [row.id],
      );
      await client.query('COMMIT');
      throw dataLimitReached();
    }

    const nextStorageUsage = asBigInt(quota.storage_used_bytes) + actualDelta;
    if (nextStorageUsage < 0n) throw new Error('Storage quota usage underflow blocked');

    await client.query(
      `INSERT INTO tenant_storage_quota_objects (tenant_id, storage_path, size_bytes)
       VALUES ($1::uuid, $2, $3::bigint)
       ON CONFLICT (tenant_id, storage_path)
       DO UPDATE SET size_bytes = EXCLUDED.size_bytes, updated_at = now()`,
      [row.tenant_id, row.storage_path, actualSizeBytes.toString()],
    );
    await client.query(
      `UPDATE tenant_data_quota_usage
       SET storage_used_bytes = $2::bigint,
           storage_reserved_bytes = storage_reserved_bytes - $3::bigint,
           revision = revision + 1,
           updated_at = now()
       WHERE tenant_id = $1::uuid`,
      [row.tenant_id, nextStorageUsage.toString(), reservedBytes.toString()],
    );
    await client.query(
      `UPDATE tenant_storage_quota_reservations
       SET status = 'committed', committed_at = now(), updated_at = now()
       WHERE id = $1::uuid`,
      [row.id],
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
 * A transport/provider failure is ambiguous. Keep the reservation instead of
 * freeing capacity optimistically; reconciliation will decide the final state.
 */
export async function flagStorageUploadForReconciliation(reservation: StorageUploadReservation): Promise<void> {
  if (!reservation.id) return;
  await query(
    `UPDATE tenant_storage_quota_reservations
     SET status = 'reconcile_required', updated_at = now()
     WHERE id = $1::uuid AND status = 'pending'`,
    [reservation.id],
  );
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
    const reservationResult = await client.query<ReservationRow>(
      `SELECT id, tenant_id, reserved_bytes, status
       FROM tenant_storage_quota_reservations
       WHERE id = $1::uuid
       FOR UPDATE`,
      [reservation.id],
    );
    const row = reservationResult.rows[0];
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

    await client.query(
      `UPDATE tenant_data_quota_usage
       SET storage_reserved_bytes = storage_reserved_bytes - $2::bigint,
           revision = revision + 1,
           updated_at = now()
       WHERE tenant_id = $1::uuid`,
      [row.tenant_id, reservedBytes.toString()],
    );
    await client.query(
      `UPDATE tenant_storage_quota_reservations
       SET status = 'released', updated_at = now()
       WHERE id = $1::uuid`,
      [row.id],
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
        const quota = await lockQuota(client, tenantId);
        if (isQuotaReconciliationState(quota.state)) throw dataQuotaReconciling();
        const existing = await client.query<{ storage_path: string; size_bytes: string }>(
          `SELECT storage_path, size_bytes
           FROM tenant_storage_quota_objects
           WHERE tenant_id = $1::uuid AND storage_path = ANY($2::text[])
           FOR UPDATE`,
          [tenantId, paths],
        );
        const sizes = new Map(existing.rows.map((row) => [row.storage_path, row.size_bytes]));
        for (const storagePath of paths) {
          const id = randomUUID();
          await client.query(
            `INSERT INTO tenant_storage_quota_reservations
               (id, tenant_id, storage_path, requested_size_bytes, previous_size_bytes, reserved_bytes, expires_at)
             VALUES ($1::uuid, $2::uuid, $3, 0, $4::bigint, 0,
                     now() + ($5::int * interval '1 minute'))`,
            [id, tenantId, storagePath, asBigInt(sizes.get(storagePath)).toString(), STORAGE_RESERVATION_TTL_MINUTES],
          );
          reservations.push({ id, tenantId, storagePath });
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    }
  } catch (error) {
    await flagStorageDeletesForReconciliation(reservations).catch(() => undefined);
    throw error;
  }
  return reservations;
}

export async function flagStorageDeletesForReconciliation(reservations: readonly StorageDeleteReservation[]): Promise<void> {
  if (reservations.length === 0) return;
  await query(
    `UPDATE tenant_storage_quota_reservations
     SET status = 'reconcile_required', updated_at = now()
     WHERE id = ANY($1::uuid[]) AND status = 'pending'`,
    [reservations.map((reservation) => reservation.id)],
  );
}

/** Release zero-byte delete fences after a provider-declared rejection. */
export async function releaseStorageDeleteReservations(reservations: readonly StorageDeleteReservation[]): Promise<void> {
  if (reservations.length === 0) return;
  await query(
    `UPDATE tenant_storage_quota_reservations
     SET status = 'released', updated_at = now()
     WHERE id = ANY($1::uuid[]) AND status = 'pending'`,
    [reservations.map((reservation) => reservation.id)],
  );
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
      const quota = await lockQuota(client, tenantId);
      if (isQuotaReconciliationState(quota.state)) throw dataQuotaReconciling();
      const rows = await client.query<{ size_bytes: string }>(
        `DELETE FROM tenant_storage_quota_objects
         WHERE tenant_id = $1::uuid AND storage_path = ANY($2::text[])
         RETURNING size_bytes`,
        [tenantId, [...new Set(paths)]],
      );
      const freed = rows.rows.reduce((sum, row) => sum + asBigInt(row.size_bytes), 0n);
      if (freed > 0n) {
        const nextUsage = asBigInt(quota.storage_used_bytes) - freed;
        if (nextUsage < 0n) throw new Error('Storage quota usage underflow blocked');
        await client.query(
          `UPDATE tenant_data_quota_usage
           SET storage_used_bytes = $2::bigint, revision = revision + 1, updated_at = now()
           WHERE tenant_id = $1::uuid`,
          [tenantId, nextUsage.toString()],
        );
      }
      const reservationIds = reservations
        .filter((reservation) => reservation.tenantId === tenantId)
        .map((reservation) => reservation.id);
      if (reservationIds.length > 0) {
        await client.query(
          `UPDATE tenant_storage_quota_reservations
           SET status = 'committed', committed_at = now(), updated_at = now()
           WHERE id = ANY($1::uuid[]) AND status = 'pending'`,
          [reservationIds],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

export async function getTenantDataQuota(tenantId: string): Promise<TenantDataQuota | null> {
  const result = await query<{
    data_limit_bytes: string | null;
    database_used_bytes: string;
    storage_used_bytes: string;
    storage_reserved_bytes: string;
    state: QuotaState;
    last_verified_at: Date | null;
  }>(
    `SELECT t.data_limit_bytes, usage.database_used_bytes, usage.storage_used_bytes,
            usage.storage_reserved_bytes, usage.state, usage.last_verified_at
     FROM tenants t
     LEFT JOIN tenant_data_quota_usage usage ON usage.tenant_id = t.id
     WHERE t.id = $1::uuid`,
    [tenantId],
  );
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
