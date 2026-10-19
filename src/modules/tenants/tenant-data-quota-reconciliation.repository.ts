// ═══════════════════════════════════════════════════════════════
// Tenant data quota reconciliation repository: the claim, lease, heartbeat
// and finalization functions of the quota SQL, and the Storage object pages.
// SQL only, moved from tenant-data-quota-reconciliation.service.ts, which
// keeps the claim flow, the transactions and the errors. Each statement text
// is byte for byte the one the service sent
// (tenant-data-quota-sql.characterization.test.ts records them exactly):
// keep the whitespace inside the literals below.
// ═══════════════════════════════════════════════════════════════

import type { QueryResult, QueryResultRow } from 'pg';

/** The pool query() or a transaction client. */
export interface TenantDataQuotaReconciliationDb {
  query<T extends QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export type ReconciliationClaimRow = {
  claimed: boolean;
  retry_at: Date | null;
  quota_state: string;
  storage_scan_cursor: string | null;
  scanned_object_count: string;
};

export type StorageObjectRow = {
  bucket_id: string;
  name: string;
  size_bytes: string | null;
};

export type WorkerHeartbeatValues = {
  workerName: string;
  instanceId: string;
  state: string;
  candidates: number;
  completed: number;
  yielded: number;
  failed: number;
  lastError: string | null;
};

const SCHEMA_READY = `SELECT to_regprocedure('public.tenant_data_quota_list_reconciliation_candidates(integer)') IS NOT NULL
         AND to_regprocedure('public.tenant_data_quota_claim_reconciliation(uuid,uuid,integer)') IS NOT NULL
         AND to_regprocedure('public.tenant_data_quota_finish_reconciliation(uuid,uuid)') IS NOT NULL
         AND to_regclass('public.tenant_data_quota_reconciliation_queue') IS NOT NULL
         AND to_regprocedure('public.tenant_data_quota_prepare_reconciliation_finalization(uuid,uuid,integer)') IS NOT NULL
         AND to_regprocedure('public.tenant_data_quota_finish_reconciliation(uuid,uuid,integer)') IS NOT NULL
         AS ready`;

const RECORD_HEARTBEAT = `SELECT public.tenant_data_quota_record_worker_heartbeat(
       $1::text, $2::uuid, $3::text, $4::integer, $5::integer,
       $6::integer, $7::integer, $8::text
     )`;

const CLAIM = `SELECT claimed, retry_at, quota_state, storage_scan_cursor, scanned_object_count
       FROM public.tenant_data_quota_claim_reconciliation($1::uuid, $2::uuid, $3::integer)`;

const UPSERT_STORAGE_PAGE = `INSERT INTO tenant_storage_quota_objects (tenant_id, storage_path, size_bytes)
       SELECT $1::uuid, input.storage_path, input.size_bytes
       FROM unnest($2::text[], $3::bigint[]) AS input(storage_path, size_bytes)
       ON CONFLICT (tenant_id, storage_path)
       DO UPDATE SET size_bytes = EXCLUDED.size_bytes, updated_at = now()`;

const RENEW_LEASE = `UPDATE tenant_data_quota_reconciliation_runs
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
       RETURNING tenant_id`;

const FAIL_CLAIM = `SELECT public.tenant_data_quota_fail_reconciliation(
       $1::uuid, $2::uuid, $3::text, $4::integer, $5::integer
     )`;

const PREPARE_FINALIZATION = `SELECT public.tenant_data_quota_prepare_reconciliation_finalization(
       $1::uuid, $2::uuid, $3::integer
     )`;

const SET_STATEMENT_TIMEOUT = `SELECT set_config('statement_timeout', $1::text, true)`;

const STORAGE_PAGE = `SELECT bucket_id, name, metadata ->> 'size' AS size_bytes
         FROM storage.objects
         WHERE bucket_id = ANY($1::text[])
           AND name COLLATE "C" >= $2::text COLLATE "C"
           AND name COLLATE "C" < $3::text COLLATE "C"
           AND ($4::text = ''
             OR bucket_id > $4::text
             OR (bucket_id = $4::text AND name COLLATE "C" > $5::text COLLATE "C"))
         ORDER BY bucket_id ASC, name COLLATE "C" ASC
         LIMIT $6::integer`;

const LIST_CANDIDATES = 'SELECT tenant_id FROM public.tenant_data_quota_list_reconciliation_candidates($1::integer)';

const RELEASE_CLAIM = 'SELECT public.tenant_data_quota_release_reconciliation_claim($1::uuid, $2::uuid, 0::integer)';

const FINISH = 'SELECT public.tenant_data_quota_finish_reconciliation($1::uuid, $2::uuid, $3::integer)';

export function createTenantDataQuotaReconciliationRepository(db: TenantDataQuotaReconciliationDb) {
  return {
    /** Catalog only: true once every reconciliation function of the quota SQL exists. */
    async isSchemaReady(): Promise<boolean> {
      const result = await db.query<{ ready: boolean }>(SCHEMA_READY);
      return result.rows[0]?.ready === true;
    },

    async recordHeartbeat(values: WorkerHeartbeatValues): Promise<void> {
      await db.query(RECORD_HEARTBEAT, [
        values.workerName,
        values.instanceId,
        values.state,
        values.candidates,
        values.completed,
        values.yielded,
        values.failed,
        values.lastError,
      ]);
    },

    async listCandidates(limit: number): Promise<string[]> {
      const result = await db.query<{ tenant_id: string }>(LIST_CANDIDATES, [limit]);
      return result.rows.map((row) => row.tenant_id);
    },

    async claim(tenantId: string, claimToken: string, leaseSeconds: number): Promise<ReconciliationClaimRow | null> {
      const result = await db.query<ReconciliationClaimRow>(CLAIM, [tenantId, claimToken, leaseSeconds]);
      return result.rows[0] || null;
    },

    /** One page of the tenant's Storage objects after the cursor, in key order (C collation). */
    async selectStoragePage(values: {
      buckets: readonly string[];
      lowerBound: string;
      upperBound: string;
      cursorBucketId: string;
      cursorName: string;
      pageSize: number;
    }): Promise<QueryResult<StorageObjectRow>> {
      return db.query<StorageObjectRow>(STORAGE_PAGE, [
        values.buckets,
        values.lowerBound,
        values.upperBound,
        values.cursorBucketId,
        values.cursorName,
        values.pageSize,
      ]);
    },

    async upsertObjectSizes(tenantId: string, storagePaths: string[], sizes: string[]): Promise<void> {
      await db.query(UPSERT_STORAGE_PAGE, [tenantId, storagePaths, sizes]);
    },

    /** Moves the cursor and renews the lease; the row count is 1 only while the claim is still held. */
    async renewLease(values: {
      tenantId: string;
      claimToken: string;
      cursor: string;
      objectCount: number;
      leaseSeconds: number;
    }): Promise<number | null> {
      const result = await db.query(RENEW_LEASE, [
        values.tenantId,
        values.claimToken,
        values.cursor,
        values.objectCount,
        values.leaseSeconds,
      ]);
      return result.rowCount;
    },

    async releaseClaim(tenantId: string, claimToken: string): Promise<void> {
      await db.query(RELEASE_CLAIM, [tenantId, claimToken]);
    },

    async failClaim(values: {
      tenantId: string;
      claimToken: string;
      message: string;
      retryBaseSeconds: number;
      retryMaxSeconds: number;
    }): Promise<void> {
      await db.query(FAIL_CLAIM, [
        values.tenantId,
        values.claimToken,
        values.message,
        values.retryBaseSeconds,
        values.retryMaxSeconds,
      ]);
    },

    async prepareFinalization(tenantId: string, claimToken: string, leaseSeconds: number): Promise<void> {
      await db.query(PREPARE_FINALIZATION, [tenantId, claimToken, leaseSeconds]);
    },

    /** Transaction-local statement timeout (set_config(..., true)). */
    async setLocalStatementTimeout(timeoutMs: number): Promise<void> {
      await db.query(SET_STATEMENT_TIMEOUT, [String(timeoutMs)]);
    },

    async finish(tenantId: string, claimToken: string, minimumWindowSeconds: number): Promise<void> {
      await db.query(FINISH, [tenantId, claimToken, minimumWindowSeconds]);
    },
  };
}

export type TenantDataQuotaReconciliationRepository = ReturnType<typeof createTenantDataQuotaReconciliationRepository>;
