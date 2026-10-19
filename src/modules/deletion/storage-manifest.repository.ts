// ═══════════════════════════════════════════════════════════════
// Deletion Storage manifest repository: the durable list of object keys a
// deletion job must remove, its prefix scan cursors and the Storage catalog
// pages they read. SQL only, moved unchanged from storage-manifest.service.ts,
// which keeps the rules (path normalizing, tenant prefixes, the drain order).
// ═══════════════════════════════════════════════════════════════

import type { QueryResult, QueryResultRow } from 'pg';

/** The pool query() (joins the current transaction) or a transaction client. */
export interface StorageManifestDb {
  query<T extends QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export type StorageItemRow = {
  id: string;
  storage_path: string;
};

export type StorageScanCursorRow = {
  last_storage_path: string | null;
  completed_at: Date | null;
};

export function createStorageManifestRepository(db: StorageManifestDb) {
  return {
    /** Adds the (already normalized) paths; returns how many were new. */
    async insertItems(jobKind: string, jobId: string, tenantId: string, paths: string[]): Promise<number> {
      const result = await db.query(
        `INSERT INTO deletion_storage_items (job_kind, job_id, tenant_id, storage_path)
         SELECT $1::varchar, $2::uuid, $3::uuid, path
         FROM unnest($4::text[]) AS path
         ON CONFLICT (job_kind, job_id, storage_path) DO NOTHING`,
        [jobKind, jobId, tenantId, paths],
      );
      return result.rowCount || 0;
    },

    async ensureScanCursor(jobKind: string, jobId: string, tenantId: string, prefix: string): Promise<void> {
      await db.query(
        `INSERT INTO deletion_storage_scan_cursors (job_kind, job_id, tenant_id, prefix)
         VALUES ($1::varchar, $2::uuid, $3::uuid, $4::text)
         ON CONFLICT (job_kind, job_id, prefix) DO NOTHING`,
        [jobKind, jobId, tenantId, prefix],
      );
    },

    async selectScanCursor(jobKind: string, jobId: string, prefix: string): Promise<StorageScanCursorRow | undefined> {
      const result = await db.query<StorageScanCursorRow>(
        `SELECT last_storage_path, completed_at
         FROM deletion_storage_scan_cursors
         WHERE job_kind = $1::varchar AND job_id = $2::uuid AND prefix = $3::text`,
        [jobKind, jobId, prefix],
      );
      return result.rows[0];
    },

    /** Moves the cursor forward only. */
    async advanceScanCursor(jobKind: string, jobId: string, prefix: string, lastStoragePath: string): Promise<void> {
      await db.query(
        `UPDATE deletion_storage_scan_cursors
         SET last_storage_path = $4::text, updated_at = now()
         WHERE job_kind = $1::varchar
           AND job_id = $2::uuid
           AND prefix = $3::text
           AND (last_storage_path IS NULL OR last_storage_path < $4::text)`,
        [jobKind, jobId, prefix, lastStoragePath],
      );
    },

    async completeScanCursor(jobKind: string, jobId: string, prefix: string): Promise<void> {
      await db.query(
        `UPDATE deletion_storage_scan_cursors
         SET completed_at = now(), updated_at = now()
         WHERE job_kind = $1::varchar AND job_id = $2::uuid AND prefix = $3::text`,
        [jobKind, jobId, prefix],
      );
    },

    /**
     * One page of the bucket's objects whose key starts with `scanPrefix`,
     * after `after`, in key order; with `excludeCourseId`, objects that a
     * course_assets row of another course of the tenant owns are left out.
     */
    async selectStorageObjectPage(values: {
      bucket: string;
      scanPrefix: string;
      after: string;
      tenantId: string;
      excludeCourseId: string | null;
      limit: number;
    }): Promise<QueryResult<{ storage_path: string }>> {
      return db.query<{ storage_path: string }>(
        `SELECT storage_object.name AS storage_path
         FROM storage.objects storage_object
         WHERE storage_object.bucket_id = $1
           AND storage_object.name LIKE $2 || '%'
           AND ($3 = '' OR storage_object.name > $3)
           AND (
             $5::text IS NULL
             OR NOT EXISTS (
               SELECT 1
               FROM course_assets asset
               WHERE asset.tenant_id = $4::uuid
                 AND asset.course_id <> $5::text
                 AND asset.storage_path = storage_object.name
             )
           )
         ORDER BY storage_object.name ASC
         LIMIT $6::int`,
        [values.bucket, values.scanPrefix, values.after, values.tenantId, values.excludeCourseId, values.limit],
      );
    },

    /** Releases expired leases, then leases up to `limit` pending items (SKIP LOCKED). */
    async claimItems(jobKind: string, jobId: string, limit: number, leaseSeconds: number): Promise<StorageItemRow[]> {
      const result = await db.query<StorageItemRow>(
        `WITH expired AS (
           UPDATE deletion_storage_items
           SET status = 'pending', lease_expires_at = NULL, updated_at = now()
           WHERE job_kind = $1::varchar
             AND job_id = $2::uuid
             AND status = 'running'
             AND lease_expires_at < now()
         ),
         picked AS (
           SELECT id
           FROM deletion_storage_items
           WHERE job_kind = $1::varchar
             AND job_id = $2::uuid
             AND status = 'pending'
           ORDER BY id
           LIMIT $3::int
           FOR UPDATE SKIP LOCKED
         )
         UPDATE deletion_storage_items item
         SET status = 'running',
             attempts = item.attempts + 1,
             lease_expires_at = now() + ($4::int * interval '1 second'),
             updated_at = now(),
             last_error = NULL
         FROM picked
         WHERE item.id = picked.id
         RETURNING item.id, item.storage_path`,
        [jobKind, jobId, limit, leaseSeconds],
      );
      return result.rows;
    },

    async markItemsSucceeded(ids: readonly string[]): Promise<void> {
      await db.query(
        `UPDATE deletion_storage_items
         SET status = 'succeeded', lease_expires_at = NULL, last_error = NULL, updated_at = now()
         WHERE id = ANY($1::uuid[])`,
        [ids],
      );
    },

    async releaseItems(ids: readonly string[], message: string): Promise<void> {
      await db.query(
        `UPDATE deletion_storage_items
         SET status = 'pending', lease_expires_at = NULL, last_error = $2, updated_at = now()
         WHERE id = ANY($1::uuid[])`,
        [ids, message],
      );
    },

    async countUnfinished(jobKind: string, jobId: string): Promise<string | undefined> {
      const result = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM deletion_storage_items
         WHERE job_kind = $1::varchar
           AND job_id = $2::uuid
           AND status <> 'succeeded'`,
        [jobKind, jobId],
      );
      return result.rows[0]?.count;
    },
  };
}

export type StorageManifestRepository = ReturnType<typeof createStorageManifestRepository>;
