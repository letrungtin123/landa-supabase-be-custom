// ═══════════════════════════════════════════════════════════════
// Knowledge base restore repository: the restore job and its documents,
// the knowledge base restore state, the store reset of a restore run and
// the dispatch bookkeeping. SQL only; moved unchanged from kb.service.ts.
// Methods run on the db they are created with: the pool query() or the
// restore run's transaction client.
// ═══════════════════════════════════════════════════════════════

import type { QueryResult } from 'pg';
import type { KbDb, KbGeminiStore } from './kb.repository.js';

export interface RestoreJobCounters {
  total_docs: number;
  learned_docs: number;
  failed_docs: number;
  skipped_docs: number;
}

export interface RestoreKbRow {
  id: string;
  restore_state: string | null;
  store_id: string | null;
  store_name: string | null;
  api_key_fingerprint: string | null;
  remote_status: string | null;
  remote_error_reason: string | null;
}

export interface RestoreDispatchRow {
  jobId: string;
  kbId: string;
  tenantId: string;
}

export function createKbRestoreRepository(db: KbDb) {
  return {
    async failRestoreJob(jobId: string, kbId: string, tenantId: string, reason: string): Promise<void> {
      await db.query(
        `UPDATE kb_restore_jobs
     SET status = 'failed',
         error_reason = $4,
         finished_at = COALESCE(finished_at, now()),
         updated_at = now()
     WHERE id = $1 AND kb_id = $2 AND tenant_id = $3 AND status <> 'completed'`,
        [jobId, kbId, tenantId, reason],
      );
    },

    async failKnowledgebaseRestore(kbId: string, tenantId: string, reason: string, jobId: string): Promise<void> {
      await db.query(
        `UPDATE knowledgebases
     SET restore_state = 'failed',
         restore_error_reason = $3,
         restore_finished_at = now(),
         updated_at = now()
     WHERE id = $1 AND tenant_id = $2 AND active_restore_job_id = $4`,
        [kbId, tenantId, reason, jobId],
      );
    },

    async setJobNewStore(jobId: string, kbId: string, tenantId: string, storeName: string): Promise<void> {
      await db.query(
        `UPDATE kb_restore_jobs
     SET new_store_name = COALESCE(new_store_name, $4),
         updated_at = now()
     WHERE id = $1 AND kb_id = $2 AND tenant_id = $3`,
        [jobId, kbId, tenantId, storeName],
      );
    },

    /** queued → uploading; the count claimed (0 or 1). */
    async claimDocumentForUpload(jobId: string, documentId: string, kbId: string, tenantId: string): Promise<number> {
      const result = await db.query(
        `UPDATE kb_restore_job_documents
     SET status = 'uploading',
         updated_at = now()
     WHERE job_id = $1
       AND document_id = $2
       AND kb_id = $3
       AND tenant_id = $4
       AND status = 'queued'`,
        [jobId, documentId, kbId, tenantId],
      );
      return result.rowCount || 0;
    },

    /** uploading → queued with the error. */
    async resetDocumentForRetry(jobId: string, documentId: string, kbId: string, tenantId: string, reason: string): Promise<void> {
      await db.query(
        `UPDATE kb_restore_job_documents
     SET status = 'queued',
         error_reason = $5,
         updated_at = now()
     WHERE job_id = $1
       AND document_id = $2
       AND kb_id = $3
       AND tenant_id = $4
       AND status = 'uploading'`,
        [jobId, documentId, kbId, tenantId, reason],
      );
    },

    /** A queued or uploading document finishes learned or failed; the count updated. */
    async finishDocument(
      jobId: string,
      documentId: string,
      kbId: string,
      tenantId: string,
      status: 'learned' | 'failed',
      reason: string | null,
    ): Promise<number> {
      const docUpdate = await db.query(
        `UPDATE kb_restore_job_documents
       SET status = $5,
           error_reason = $6,
           finished_at = now(),
           updated_at = now()
       WHERE job_id = $1
         AND document_id = $2
         AND kb_id = $3
         AND tenant_id = $4
         AND status IN ('queued', 'uploading')
       RETURNING document_id`,
        [jobId, documentId, kbId, tenantId, status, reason],
      );
      return docUpdate.rowCount || 0;
    },

    /** Adds one learned or failed document to the job's counters; the counters after. */
    async addDocumentResult(jobId: string, kbId: string, tenantId: string, learned: number, failed: number): Promise<RestoreJobCounters | undefined> {
      const jobUpdate = await db.query<RestoreJobCounters>(
        `UPDATE kb_restore_jobs
       SET learned_docs = learned_docs + $4,
           failed_docs = failed_docs + $5,
           updated_at = now()
       WHERE id = $1 AND kb_id = $2 AND tenant_id = $3
       RETURNING total_docs, learned_docs, failed_docs, skipped_docs`,
        [jobId, kbId, tenantId, learned, failed],
      );
      return jobUpdate.rows[0];
    },

    async finishJob(jobId: string, kbId: string, tenantId: string, status: string): Promise<void> {
      await db.query(
        `UPDATE kb_restore_jobs
         SET status = $4,
             finished_at = now(),
             updated_at = now()
         WHERE id = $1 AND kb_id = $2 AND tenant_id = $3`,
        [jobId, kbId, tenantId, status],
      );
    },

    async finishKnowledgebaseRestore(kbId: string, tenantId: string, jobId: string, status: string): Promise<void> {
      await db.query(
        `UPDATE knowledgebases
         SET restore_state = $4,
             restore_error_reason = CASE WHEN $4 = 'failed' THEN 'Mot so tai lieu khoi phuc that bai. Kiem tra danh sach tai lieu loi.' ELSE NULL END,
             restore_finished_at = now(),
             updated_at = now()
         WHERE id = $1 AND tenant_id = $2 AND active_restore_job_id = $3`,
        [kbId, tenantId, jobId, status],
      );
    },

    /** Sets enqueued_at once; the count updated. */
    async markDocumentEnqueued(jobId: string, documentId: string, kbId: string, tenantId: string): Promise<number> {
      const result = await db.query(
        `UPDATE kb_restore_job_documents
     SET enqueued_at = COALESCE(enqueued_at, now()),
         updated_at = now()
     WHERE job_id = $1
       AND document_id = $2
       AND kb_id = $3
       AND tenant_id = $4
       AND status = 'queued'
       AND enqueued_at IS NULL`,
        [jobId, documentId, kbId, tenantId],
      );
      return result.rowCount || 0;
    },

    async incrementEnqueuedDocs(jobId: string, kbId: string, tenantId: string): Promise<void> {
      await db.query(
        `UPDATE kb_restore_jobs
       SET enqueued_docs = enqueued_docs + 1,
           updated_at = now()
       WHERE id = $1 AND kb_id = $2 AND tenant_id = $3`,
        [jobId, kbId, tenantId],
      );
    },

    /** The next batch of queued documents (not yet enqueued unless asked) after afterDocumentId. */
    async selectQueuedDocuments(
      jobId: string,
      kbId: string,
      tenantId: string,
      batchSize: number,
      includeAlreadyEnqueued: boolean,
      afterDocumentId: string | null,
    ): Promise<{ rowCount: number | null; rows: Array<{ document_id: string }> }> {
      return db.query<{ document_id: string }>(
        `SELECT document_id
       FROM kb_restore_job_documents
       WHERE job_id = $1
         AND kb_id = $2
         AND tenant_id = $3
         AND status = 'queued'
         AND ($5::boolean OR enqueued_at IS NULL)
         AND ($6::uuid IS NULL OR document_id > $6::uuid)
       ORDER BY document_id
       LIMIT $4`,
        [jobId, kbId, tenantId, batchSize, includeAlreadyEnqueued, afterDocumentId],
      );
    },

    /** Transaction lock of the knowledge base's restore. */
    async lockKnowledgebaseRestore(tenantId: string, kbId: string): Promise<void> {
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`kb-restore:${tenantId}:${kbId}`]);
    },

    async lockRestoreJob(jobId: string, kbId: string, tenantId: string): Promise<{ status: string } | undefined> {
      const jobResult = await db.query<{ status: string }>(
        `SELECT status
       FROM kb_restore_jobs
       WHERE id = $1 AND kb_id = $2 AND tenant_id = $3
       FOR UPDATE`,
        [jobId, kbId, tenantId],
      );
      return jobResult.rows[0];
    },

    async startRestoreJob(jobId: string, kbId: string, tenantId: string, fingerprint: string): Promise<void> {
      await db.query(
        `UPDATE kb_restore_jobs
         SET status = 'restoring',
             started_at = COALESCE(started_at, now()),
             new_key_fingerprint = $4,
             updated_at = now()
         WHERE id = $1 AND kb_id = $2 AND tenant_id = $3`,
        [jobId, kbId, tenantId, fingerprint],
      );
    },

    async startKnowledgebaseRestore(kbId: string, tenantId: string, jobId: string): Promise<void> {
      await db.query(
        `UPDATE knowledgebases
         SET restore_state = 'restoring',
             restore_error_reason = NULL,
             restore_started_at = COALESCE(restore_started_at, now()),
             restore_finished_at = NULL,
             updated_at = now()
         WHERE id = $1 AND tenant_id = $2 AND active_restore_job_id = $3`,
        [kbId, tenantId, jobId],
      );
    },

    /** Documents of the knowledge base still learning or deleting. */
    async countBusyDocuments(kbId: string, tenantId: string): Promise<{ cnt: number } | undefined> {
      const busyDocs = await db.query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt
         FROM kb_documents
         WHERE kb_id = $1 AND tenant_id = $2 AND status IN ('learning', 'deleting')`,
        [kbId, tenantId],
      );
      return busyDocs.rows[0];
    },

    async lockGeminiStores(kbId: string): Promise<QueryResult<KbGeminiStore>> {
      return db.query<KbGeminiStore>(
        `SELECT id, store_name, api_key_fingerprint, remote_status, remote_error_code, remote_error_reason
         FROM kb_google_store
         WHERE kb_id = $1
         FOR UPDATE`,
        [kbId],
      );
    },

    async countRestoreDocuments(kbId: string, tenantId: string): Promise<{ total_docs: number; restore_docs: number; skipped_docs: number } | undefined> {
      const counts = await db.query<{ total_docs: number; restore_docs: number; skipped_docs: number }>(
        `SELECT COUNT(*)::int AS total_docs,
                COUNT(*) FILTER (WHERE file_path IS NOT NULL)::int AS restore_docs,
                COUNT(*) FILTER (WHERE file_path IS NULL)::int AS skipped_docs
         FROM kb_documents
         WHERE kb_id = $1 AND tenant_id = $2`,
        [kbId, tenantId],
      );
      return counts.rows[0];
    },

    /** The old store is kept as an orphan: a key change means it cannot be deleted remotely. */
    async insertOrphanedStore(tenantId: string, kbId: string, store: KbGeminiStore, restoreReason: string): Promise<void> {
      await db.query(
        `INSERT INTO kb_gemini_orphaned_stores (
             tenant_id, kb_id, store_name, api_key_fingerprint, reason, error_code, error_reason
           )
           VALUES ($1, $2, $3, $4, 'key_changed_restore_skip_remote_delete', $5, $6)`,
        [
          tenantId,
          kbId,
          store.store_name,
          store.api_key_fingerprint,
          store.remote_error_code || 'KEY_CHANGED',
          store.remote_error_reason || restoreReason,
        ],
      );
    },

    /** Deletes the Gemini mappings of the knowledge base's documents; the count deleted. */
    async deleteKbGeminiMappings(kbId: string, tenantId: string): Promise<number> {
      const mappingDelete = await db.query(
        `DELETE FROM kb_doc_gemini_mapping m
         USING kb_documents d
         WHERE d.id = m.document_id
           AND d.kb_id = $1
           AND d.tenant_id = $2`,
        [kbId, tenantId],
      );
      return mappingDelete.rowCount || 0;
    },

    async deleteGeminiStores(kbId: string): Promise<void> {
      await db.query(`DELETE FROM kb_google_store WHERE kb_id = $1`, [kbId]);
    },

    /** One job document per KB document: queued with a source file, skipped without. */
    async insertJobDocuments(jobId: string, kbId: string, tenantId: string): Promise<void> {
      await db.query(
        `INSERT INTO kb_restore_job_documents (
           job_id, document_id, tenant_id, kb_id, status, error_reason, finished_at
         )
         SELECT $1, id, tenant_id, kb_id,
                CASE WHEN file_path IS NULL THEN 'skipped' ELSE 'queued' END,
                CASE WHEN file_path IS NULL THEN 'Khong co file goc de khoi phuc lai kho tri thuc' ELSE NULL END,
                CASE WHEN file_path IS NULL THEN now() ELSE NULL END
         FROM kb_documents
         WHERE kb_id = $2 AND tenant_id = $3
         ON CONFLICT (job_id, document_id) DO NOTHING`,
        [jobId, kbId, tenantId],
      );
    },

    async markFileDocumentsLearning(kbId: string, tenantId: string): Promise<void> {
      await db.query(
        `UPDATE kb_documents
         SET status = 'learning',
             error_reason = NULL,
             updated_at = now()
         WHERE kb_id = $1 AND tenant_id = $2 AND file_path IS NOT NULL`,
        [kbId, tenantId],
      );
    },

    async markFilelessDocumentsError(kbId: string, tenantId: string): Promise<void> {
      await db.query(
        `UPDATE kb_documents
         SET status = 'error',
             error_reason = 'Khong co file goc de khoi phuc lai kho tri thuc',
             updated_at = now()
         WHERE kb_id = $1 AND tenant_id = $2 AND file_path IS NULL AND status <> 'draft'`,
        [kbId, tenantId],
      );
    },

    async setRestoreJobProgress(jobId: string, kbId: string, tenantId: string, status: string, totalDocs: number, skippedDocs: number): Promise<void> {
      await db.query(
        `UPDATE kb_restore_jobs
         SET status = $4,
             total_docs = $5,
             skipped_docs = $6,
             finished_at = CASE WHEN $4 = 'completed' THEN now() ELSE finished_at END,
             updated_at = now()
         WHERE id = $1 AND kb_id = $2 AND tenant_id = $3`,
        [jobId, kbId, tenantId, status, totalDocs, skippedDocs],
      );
    },

    async setKnowledgebaseRestoreState(kbId: string, tenantId: string, jobId: string, status: string): Promise<void> {
      await db.query(
        `UPDATE knowledgebases
         SET restore_state = $4,
             restore_error_reason = NULL,
             restore_finished_at = CASE WHEN $4 = 'completed' THEN now() ELSE NULL END,
             updated_at = now()
         WHERE id = $1 AND tenant_id = $2 AND active_restore_job_id = $3`,
        [kbId, tenantId, jobId, status],
      );
    },

    /** The knowledge base with its store, locked for a new restore job. */
    async lockKnowledgebaseForRestore(kbId: string, tenantId: string): Promise<RestoreKbRow | undefined> {
      const kbResult = await db.query<RestoreKbRow>(
        `SELECT kb.id, kb.restore_state,
                kgs.id AS store_id, kgs.store_name, kgs.api_key_fingerprint, kgs.remote_status, kgs.remote_error_reason
         FROM knowledgebases kb
         LEFT JOIN kb_google_store kgs ON kgs.kb_id = kb.id
         WHERE kb.id = $1 AND kb.tenant_id = $2
         LIMIT 1
         FOR UPDATE OF kb`,
        [kbId, tenantId],
      );
      return kbResult.rows[0];
    },

    async insertRestoreJob(
      jobId: string,
      tenantId: string,
      kbId: string,
      oldStoreName: string | null,
      oldFingerprint: string | null,
      newFingerprint: string,
    ): Promise<void> {
      await db.query(
        `INSERT INTO kb_restore_jobs (
           id, tenant_id, kb_id, status, reason, old_store_name,
           old_key_fingerprint, new_key_fingerprint, started_at
         )
         VALUES ($1, $2, $3, 'queued', 'key_changed', $4, $5, $6, now())`,
        [jobId, tenantId, kbId, oldStoreName, oldFingerprint, newFingerprint],
      );
    },

    async queueKnowledgebaseRestore(kbId: string, tenantId: string, jobId: string): Promise<void> {
      await db.query(
        `UPDATE knowledgebases
         SET restore_state = 'queued',
             active_restore_job_id = $3,
             restore_error_reason = NULL,
             restore_started_at = now(),
             restore_finished_at = NULL,
             updated_at = now()
         WHERE id = $1 AND tenant_id = $2`,
        [kbId, tenantId, jobId],
      );
    },

    async recordDispatchAttempt(target: RestoreDispatchRow, confirmed: boolean): Promise<void> {
      await db.query(
        `UPDATE kb_restore_jobs
     SET dispatch_attempted_at = now(),
         dispatch_failures = CASE WHEN $4 THEN 0 ELSE dispatch_failures + 1 END,
         updated_at = now()
     WHERE id = $1 AND kb_id = $2 AND tenant_id = $3
       AND status IN ('queued', 'restoring', 'uploading')`,
        [target.jobId, target.kbId, target.tenantId, confirmed],
      );
    },

    /** Queued jobs not dispatched for a minute, and running ones stalled for 15 minutes. */
    async selectRecoverableJobs(limit: number): Promise<RestoreDispatchRow[]> {
      const jobs = await db.query<RestoreDispatchRow>(
        `SELECT id AS "jobId", kb_id AS "kbId", tenant_id AS "tenantId"
     FROM kb_restore_jobs
     WHERE (status = 'queued' AND (
              dispatch_attempted_at IS NULL
              OR dispatch_attempted_at < now() - interval '1 minute'
            ))
        OR (status IN ('restoring', 'uploading')
            AND updated_at < now() - interval '15 minutes'
            AND (dispatch_attempted_at IS NULL OR dispatch_attempted_at < now() - interval '5 minutes'))
     ORDER BY updated_at ASC, id ASC
     LIMIT $1`,
        [limit],
      );
      return jobs.rows;
    },
  };
}

export type KbRestoreRepository = ReturnType<typeof createKbRestoreRepository>;
