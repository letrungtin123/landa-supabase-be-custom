// ═══════════════════════════════════════════════════════════════
// Tenant data quota repository: the usage row, Storage object sizes and
// Storage reservations. SQL only, moved from tenant-data-quota.service.ts,
// which keeps the transactions, the lock order, the limit checks and the
// errors. Each statement text is byte for byte the one the service sent
// (tenant-data-quota-sql.characterization.test.ts records them exactly):
// keep the whitespace inside the literals below.
// ═══════════════════════════════════════════════════════════════

import type { QueryResult, QueryResultRow } from 'pg';

/** The pool query() (joins the current transaction) or a transaction client. */
export interface TenantDataQuotaDb {
  query<T extends QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export type TenantDataQuotaState = 'initializing' | 'observing' | 'enforced' | 'reconciling' | 'drifted';

export type LockedQuotaRow = {
  data_limit_bytes: string | null;
  database_used_bytes: string;
  storage_used_bytes: string;
  storage_reserved_bytes: string;
  state: TenantDataQuotaState;
};

export type StorageReservationStatus = 'pending' | 'committed' | 'released' | 'reconcile_required' | 'reconciled';

export type StorageReservationRow = {
  id: string;
  tenant_id: string;
  storage_path: string;
  previous_size_bytes: string;
  reserved_bytes: string;
  requested_size_bytes: string;
  status: StorageReservationStatus;
};

/** The columns the release of an upload reservation reads. */
export type StorageReservationReleaseRow = Pick<StorageReservationRow, 'id' | 'tenant_id' | 'reserved_bytes' | 'status'>;

export type TenantDataQuotaReadRow = {
  data_limit_bytes: string | null;
  database_used_bytes: string | null;
  storage_used_bytes: string | null;
  storage_reserved_bytes: string | null;
  state: TenantDataQuotaState | null;
  last_verified_at: Date | null;
};

/** Builds the tenant's database bytes expression (tenant-data-quota-ledger.logic.ts). */
export type DatabaseBytesSql = (usageAlias: string, tenantIdSql: string) => string;

const ENSURE_USAGE_ROW = `INSERT INTO tenant_data_quota_usage (tenant_id)
     VALUES ($1::uuid)
     ON CONFLICT (tenant_id) DO NOTHING`;

const LOCK_USAGE = `SELECT t.data_limit_bytes,
            usage.database_used_bytes,
            usage.storage_used_bytes,
            usage.storage_reserved_bytes,
            usage.state
     FROM tenants t
     JOIN tenant_data_quota_usage usage ON usage.tenant_id = t.id
     WHERE t.id = $1::uuid
     FOR UPDATE OF usage`;

const LOCK_OBJECT_SIZE = `SELECT size_bytes
       FROM tenant_storage_quota_objects
       WHERE tenant_id = $1::uuid AND storage_path = $2
       FOR UPDATE`;

const INSERT_UPLOAD_RESERVATION = `INSERT INTO tenant_storage_quota_reservations
         (id, tenant_id, storage_path, requested_size_bytes, previous_size_bytes, reserved_bytes, expires_at)
       VALUES ($1::uuid, $2::uuid, $3, $4::bigint, $5::bigint, $6::bigint,
               now() + ($7::int * interval '1 minute'))`;

const ADD_RESERVED_BYTES = `UPDATE tenant_data_quota_usage
         SET storage_reserved_bytes = storage_reserved_bytes + $2::bigint,
             revision = revision + 1,
             updated_at = now()
         WHERE tenant_id = $1::uuid`;

const LOCK_RESERVATION = `SELECT id, tenant_id, storage_path, previous_size_bytes, reserved_bytes, requested_size_bytes, status
       FROM tenant_storage_quota_reservations
       WHERE id = $1::uuid
       FOR UPDATE`;

const MARK_RECONCILE_REQUIRED = `UPDATE tenant_storage_quota_reservations
         SET status = 'reconcile_required', updated_at = now()
         WHERE id = $1::uuid`;

const UPSERT_OBJECT_SIZE = `INSERT INTO tenant_storage_quota_objects (tenant_id, storage_path, size_bytes)
       VALUES ($1::uuid, $2, $3::bigint)
       ON CONFLICT (tenant_id, storage_path)
       DO UPDATE SET size_bytes = EXCLUDED.size_bytes, updated_at = now()`;

const COMMIT_UPLOAD_USAGE = `UPDATE tenant_data_quota_usage
       SET storage_used_bytes = $2::bigint,
           storage_reserved_bytes = storage_reserved_bytes - $3::bigint,
           revision = revision + 1,
           updated_at = now()
       WHERE tenant_id = $1::uuid`;

const MARK_COMMITTED = `UPDATE tenant_storage_quota_reservations
       SET status = 'committed', committed_at = now(), updated_at = now()
       WHERE id = $1::uuid`;

const FLAG_UPLOAD_RESERVATION = `UPDATE tenant_storage_quota_reservations
     SET status = 'reconcile_required', updated_at = now()
     WHERE id = $1::uuid AND status = 'pending'`;

const LOCK_RESERVATION_FOR_RELEASE = `SELECT id, tenant_id, reserved_bytes, status
       FROM tenant_storage_quota_reservations
       WHERE id = $1::uuid
       FOR UPDATE`;

const RELEASE_RESERVED_BYTES = `UPDATE tenant_data_quota_usage
       SET storage_reserved_bytes = storage_reserved_bytes - $2::bigint,
           revision = revision + 1,
           updated_at = now()
       WHERE tenant_id = $1::uuid`;

const MARK_RELEASED = `UPDATE tenant_storage_quota_reservations
       SET status = 'released', updated_at = now()
       WHERE id = $1::uuid`;

const LOCK_OBJECT_SIZES = `SELECT storage_path, size_bytes
           FROM tenant_storage_quota_objects
           WHERE tenant_id = $1::uuid AND storage_path = ANY($2::text[])
           FOR UPDATE`;

const INSERT_DELETE_RESERVATION = `INSERT INTO tenant_storage_quota_reservations
               (id, tenant_id, storage_path, requested_size_bytes, previous_size_bytes, reserved_bytes, expires_at)
             VALUES ($1::uuid, $2::uuid, $3, 0, $4::bigint, 0,
                     now() + ($5::int * interval '1 minute'))`;

const FLAG_DELETE_RESERVATIONS = `UPDATE tenant_storage_quota_reservations
     SET status = 'reconcile_required', updated_at = now()
     WHERE id = ANY($1::uuid[]) AND status = 'pending'`;

const RELEASE_DELETE_RESERVATIONS = `UPDATE tenant_storage_quota_reservations
     SET status = 'released', updated_at = now()
     WHERE id = ANY($1::uuid[]) AND status = 'pending'`;

const DELETE_OBJECTS = `DELETE FROM tenant_storage_quota_objects
         WHERE tenant_id = $1::uuid AND storage_path = ANY($2::text[])
         RETURNING size_bytes`;

const SET_STORAGE_USED = `UPDATE tenant_data_quota_usage
           SET storage_used_bytes = $2::bigint, revision = revision + 1, updated_at = now()
           WHERE tenant_id = $1::uuid`;

const COMMIT_DELETE_RESERVATIONS = `UPDATE tenant_storage_quota_reservations
           SET status = 'committed', committed_at = now(), updated_at = now()
           WHERE id = ANY($1::uuid[]) AND status = 'pending'`;

/** The tenant's limit and usage, the database bytes including the deltas not folded yet. */
export const tenantDataQuotaReadSql = (databaseBytes: DatabaseBytesSql): string => `SELECT t.data_limit_bytes,
            CASE WHEN usage.tenant_id IS NOT NULL THEN ${databaseBytes('usage', 't.id')}::text END AS database_used_bytes,
            usage.storage_used_bytes, usage.storage_reserved_bytes, usage.state, usage.last_verified_at
     FROM tenants t
     LEFT JOIN tenant_data_quota_usage usage ON usage.tenant_id = t.id
     WHERE t.id = $1::uuid`;

export function createTenantDataQuotaRepository(db: TenantDataQuotaDb) {
  return {
    /** Creates the tenant's usage row when it does not exist yet. */
    async ensureUsageRow(tenantId: string): Promise<void> {
      await db.query(ENSURE_USAGE_ROW, [tenantId]);
    },

    /** The tenant's limit and usage, locking the usage row (FOR UPDATE OF usage). */
    async lockUsage(tenantId: string): Promise<LockedQuotaRow | undefined> {
      const result = await db.query<LockedQuotaRow>(LOCK_USAGE, [tenantId]);
      return result.rows[0];
    },

    /** The recorded size of one object, locking its row. */
    async lockObjectSize(tenantId: string, storagePath: string): Promise<string | undefined> {
      const result = await db.query<{ size_bytes: string }>(LOCK_OBJECT_SIZE, [tenantId, storagePath]);
      return result.rows[0]?.size_bytes;
    },

    /** The recorded sizes of these objects, locking their rows. */
    async lockObjectSizes(tenantId: string, storagePaths: string[]): Promise<{ storage_path: string; size_bytes: string }[]> {
      const result = await db.query<{ storage_path: string; size_bytes: string }>(LOCK_OBJECT_SIZES, [tenantId, storagePaths]);
      return result.rows;
    },

    async insertUploadReservation(values: {
      id: string;
      tenantId: string;
      storagePath: string;
      requestedSizeBytes: string;
      previousSizeBytes: string;
      reservedBytes: string;
      ttlMinutes: number;
    }): Promise<void> {
      await db.query(INSERT_UPLOAD_RESERVATION, [
        values.id,
        values.tenantId,
        values.storagePath,
        values.requestedSizeBytes,
        values.previousSizeBytes,
        values.reservedBytes,
        values.ttlMinutes,
      ]);
    },

    /** A zero-byte reservation that fences one object delete. */
    async insertDeleteReservation(values: {
      id: string;
      tenantId: string;
      storagePath: string;
      previousSizeBytes: string;
      ttlMinutes: number;
    }): Promise<void> {
      await db.query(INSERT_DELETE_RESERVATION, [
        values.id,
        values.tenantId,
        values.storagePath,
        values.previousSizeBytes,
        values.ttlMinutes,
      ]);
    },

    async addReservedBytes(tenantId: string, bytes: string): Promise<void> {
      await db.query(ADD_RESERVED_BYTES, [tenantId, bytes]);
    },

    async lockReservation(id: string): Promise<StorageReservationRow | undefined> {
      const result = await db.query<StorageReservationRow>(LOCK_RESERVATION, [id]);
      return result.rows[0];
    },

    async lockReservationForRelease(id: string): Promise<StorageReservationReleaseRow | undefined> {
      const result = await db.query<StorageReservationReleaseRow>(LOCK_RESERVATION_FOR_RELEASE, [id]);
      return result.rows[0];
    },

    async markReservationReconcileRequired(id: string): Promise<void> {
      await db.query(MARK_RECONCILE_REQUIRED, [id]);
    },

    async upsertObjectSize(tenantId: string, storagePath: string, sizeBytes: string): Promise<void> {
      await db.query(UPSERT_OBJECT_SIZE, [tenantId, storagePath, sizeBytes]);
    },

    /** Sets the Storage usage and takes the reservation's bytes off the reserved total. */
    async commitUploadUsage(tenantId: string, storageUsedBytes: string, reservedBytes: string): Promise<void> {
      await db.query(COMMIT_UPLOAD_USAGE, [tenantId, storageUsedBytes, reservedBytes]);
    },

    async markReservationCommitted(id: string): Promise<void> {
      await db.query(MARK_COMMITTED, [id]);
    },

    /** Only a pending reservation is flagged. */
    async flagUploadReservation(id: string): Promise<void> {
      await db.query(FLAG_UPLOAD_RESERVATION, [id]);
    },

    async releaseReservedBytes(tenantId: string, reservedBytes: string): Promise<void> {
      await db.query(RELEASE_RESERVED_BYTES, [tenantId, reservedBytes]);
    },

    async markReservationReleased(id: string): Promise<void> {
      await db.query(MARK_RELEASED, [id]);
    },

    /** Only pending reservations are flagged. */
    async flagDeleteReservations(ids: string[]): Promise<void> {
      await db.query(FLAG_DELETE_RESERVATIONS, [ids]);
    },

    /** Only pending reservations are released. */
    async releaseDeleteReservations(ids: string[]): Promise<void> {
      await db.query(RELEASE_DELETE_RESERVATIONS, [ids]);
    },

    /** Deletes the objects' size rows and returns the sizes deleted. */
    async deleteObjects(tenantId: string, storagePaths: string[]): Promise<{ size_bytes: string }[]> {
      const result = await db.query<{ size_bytes: string }>(DELETE_OBJECTS, [tenantId, storagePaths]);
      return result.rows;
    },

    async setStorageUsed(tenantId: string, storageUsedBytes: string): Promise<void> {
      await db.query(SET_STORAGE_USED, [tenantId, storageUsedBytes]);
    },

    /** Only pending reservations are committed. */
    async commitDeleteReservations(ids: string[]): Promise<void> {
      await db.query(COMMIT_DELETE_RESERVATIONS, [ids]);
    },
  };
}

export type TenantDataQuotaRepository = ReturnType<typeof createTenantDataQuotaRepository>;
