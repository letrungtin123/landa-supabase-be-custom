// ═══════════════════════════════════════════════════════════════
// Knowledge base repository: knowledge bases and their documents, the Gemini
// store and mappings, the mutability checks, the AI engine transition check,
// the document operation queues (create, retry, delete) and the Lesson Author
// rows a source change marks stale. SQL only; moved unchanged from
// kb.service.ts, which keeps the rules, caches, Storage and queue calls.
// ═══════════════════════════════════════════════════════════════

import type { QueryResult, QueryResultRow } from 'pg';
import { LESSON_AUTHOR_CONTEXT_KB_TARGET } from '../chat/chat.constants.js';

/**
 * SQL condition: the knowledge base `alias` is not the hidden AI ID organization context knowledge base.
 * Every /kb/:kbId… route, the knowledge base list, the bot and lesson-author knowledge base choices use it,
 * so that knowledge base reads as not found there (its documents are managed by the org-context routes).
 */
export function visibleKnowledgebaseSql(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error('Invalid knowledge base SQL alias');
  return `NOT EXISTS (
       SELECT 1 FROM tenant_kb_assignments hidden_kb
       WHERE hidden_kb.tenant_id = ${alias}.tenant_id
         AND hidden_kb.kb_id = ${alias}.id
         AND hidden_kb.target = '${LESSON_AUTHOR_CONTEXT_KB_TARGET}'
     )`;
}

/** The pool query() (joins the current transaction) or a transaction client. */
export interface KbDb {
  query<T extends QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface KbGeminiStore {
  id: string;
  store_name: string;
  api_key_fingerprint: string | null;
  remote_status: string;
  remote_error_code: string | null;
  remote_error_reason: string | null;
}

export interface KbGeminiMapping {
  gemini_path: string;
}

/** A knowledge base with its store, document count, restore job and AI engine transition (before mapping). */
export type KnowledgebaseListRow = Record<string, any>;

export interface KbMutabilityRow {
  id: string;
  restore_state: string | null;
  api_key_fingerprint: string | null;
  remote_status: string | null;
  remote_error_reason: string | null;
}

/** A kb_documents row (SELECT * / RETURNING *). */
export interface KbDocumentRow {
  id: string;
  tenant_id: string;
  kb_id: string;
  type: string;
  name: string;
  status: string;
  error_reason: string | null;
  source_info: Record<string, unknown>;
  file_path: string | null;
  content: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** A knowledgebases row (SELECT * / RETURNING *). */
export interface KnowledgebaseRow {
  id: string;
  tenant_id: string;
  name: string;
  description: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  restore_state?: string | null;
  [column: string]: unknown;
}

export interface DocumentListFilter {
  kbId: string;
  tenantId: string;
  search?: string;
  status?: string;
  type?: string;
}

/** True when the store needs a restore for the fingerprint in the given parameter (SQL fragment). */
function restoreRequiredSql(currentFingerprintParam: string): string {
  return `(
    kgs.id IS NOT NULL
    AND (
      kgs.remote_status IN ('key_changed', 'permission_denied', 'not_found')
      OR (
        kgs.remote_status = 'active'
        AND kgs.api_key_fingerprint IS NOT NULL
        AND ${currentFingerprintParam}::text IS NOT NULL
        AND kgs.api_key_fingerprint <> ${currentFingerprintParam}::text
      )
    )
  )`;
}

export function createKbRepository(db: KbDb) {
  return {
    async selectGeminiStores(kbId: string): Promise<KbGeminiStore[]> {
      const stores = await db.query<KbGeminiStore>(
        `SELECT id, store_name, api_key_fingerprint, remote_status, remote_error_code, remote_error_reason
     FROM kb_google_store
     WHERE kb_id = $1`,
        [kbId],
      );
      return stores.rows;
    },

    async selectKbGeminiMappings(kbId: string, tenantId: string): Promise<KbGeminiMapping[]> {
      const mappings = await db.query<KbGeminiMapping>(
        `SELECT m.gemini_path FROM kb_doc_gemini_mapping m
     JOIN kb_documents d ON d.id = m.document_id
     WHERE d.kb_id = $1 AND d.tenant_id = $2`,
        [kbId, tenantId],
      );
      return mappings.rows;
    },

    async selectDocumentGeminiMappings(docIds: string[], tenantId: string): Promise<QueryResult<KbGeminiMapping>> {
      return db.query<KbGeminiMapping>(
        `SELECT m.gemini_path FROM kb_doc_gemini_mapping m
     JOIN kb_documents d ON d.id = m.document_id
     WHERE d.id = ANY($1) AND d.tenant_id = $2`,
        [docIds, tenantId],
      );
    },

    /** The tenant's AI engine transition when queued or running. */
    async selectActiveAiEngineTransition(tenantId: string): Promise<{ transition_state: string | null } | undefined> {
      const transition = await db.query<{ transition_state: string | null }>(
        `SELECT transition_state
     FROM tenant_ai_settings
     WHERE tenant_id = $1
       AND transition_state IN ('queued', 'running')
     LIMIT 1`,
        [tenantId],
      );
      return transition.rows[0];
    },

    /** The tenant's knowledge base with its restore state and store. */
    async selectKbForMutation(kbId: string, tenantId: string): Promise<KbMutabilityRow | undefined> {
      const result = await db.query<KbMutabilityRow>(
        `SELECT kb.id, kb.restore_state,
            kgs.api_key_fingerprint, kgs.remote_status, kgs.remote_error_reason
     FROM knowledgebases kb
     LEFT JOIN kb_google_store kgs ON kgs.kb_id = kb.id
     WHERE kb.id = $1 AND kb.tenant_id = $2
     LIMIT 1`,
        [kbId, tenantId],
      );
      return result.rows[0];
    },

    /** One page of the tenant's knowledge bases not queued for deletion, newest first, with the total. */
    async selectKnowledgebasePage(
      tenantId: string,
      currentFingerprint: string | null,
      search: string | undefined,
      pageSize: number,
      offset: number,
    ): Promise<KnowledgebaseListRow[]> {
      const conditions: string[] = [
        'kb.tenant_id = $1',
        `NOT EXISTS (
       SELECT 1 FROM kb_operation_jobs operation_job
       WHERE operation_job.kb_id = kb.id
         AND operation_job.tenant_id = kb.tenant_id
         AND operation_job.operation = 'knowledgebase_delete'
         AND operation_job.status IN ('queued', 'running')
     )`,
        visibleKnowledgebaseSql('kb'),
      ];
      const params: unknown[] = [tenantId, currentFingerprint];
      let idx = 3;

      if (search?.trim()) {
        conditions.push(`kb.name ILIKE $${idx++}`);
        params.push(`%${search.trim()}%`);
      }

      const where = conditions.join(' AND ');
      params.push(pageSize, offset);

      const result = await db.query<KnowledgebaseListRow>(
        `SELECT kb.*, COALESCE(dc.cnt, 0)::int AS document_count,
            ${restoreRequiredSql('$2')} AS restore_required,
            CASE
              WHEN ${restoreRequiredSql('$2')} THEN
                COALESCE(kgs.remote_error_reason, 'Gemini API key changed or cannot access the current store.')
              ELSE NULL
            END AS restore_reason,
            j.total_docs, j.enqueued_docs, j.learned_docs, j.failed_docs, j.skipped_docs,
            tas.active_engine AS ai_active_engine,
            tas.transition_state AS ai_transition_state,
            aitj.to_engine AS ai_pending_engine,
            aitj.phase AS ai_transition_phase,
            aitj.total_documents::text AS ai_transition_total_documents,
            aitj.processed_documents::text AS ai_transition_processed_documents,
            aitj.cleanup_processed_documents::text AS ai_transition_cleanup_processed_documents,
            aitj.last_error AS ai_transition_last_error,
            COUNT(*) OVER() AS full_count
     FROM knowledgebases kb
     LEFT JOIN kb_google_store kgs ON kgs.kb_id = kb.id
     LEFT JOIN (
       SELECT kb_id, COUNT(*)::int AS cnt FROM kb_documents GROUP BY kb_id
     ) dc ON dc.kb_id = kb.id
     LEFT JOIN kb_restore_jobs j ON j.id = kb.active_restore_job_id
     LEFT JOIN tenant_ai_settings tas ON tas.tenant_id = kb.tenant_id
     LEFT JOIN ai_engine_transition_jobs aitj ON aitj.id = tas.active_transition_job_id
     WHERE ${where}
     ORDER BY kb.created_at DESC
     LIMIT $${idx++} OFFSET $${idx++}`,
        params,
      );
      return result.rows;
    },

    async selectKnowledgebase(id: string, tenantId: string, currentFingerprint: string | null): Promise<KnowledgebaseListRow | undefined> {
      const result = await db.query<KnowledgebaseListRow>(
        `SELECT kb.*, COALESCE(dc.cnt, 0)::int AS document_count,
            ${restoreRequiredSql('$3')} AS restore_required,
            CASE
              WHEN ${restoreRequiredSql('$3')} THEN
                COALESCE(kgs.remote_error_reason, 'Gemini API key changed or cannot access the current store.')
              ELSE NULL
            END AS restore_reason,
            j.total_docs, j.enqueued_docs, j.learned_docs, j.failed_docs, j.skipped_docs,
            tas.active_engine AS ai_active_engine,
            tas.transition_state AS ai_transition_state,
            aitj.to_engine AS ai_pending_engine,
            aitj.phase AS ai_transition_phase,
            aitj.total_documents::text AS ai_transition_total_documents,
            aitj.processed_documents::text AS ai_transition_processed_documents,
            aitj.cleanup_processed_documents::text AS ai_transition_cleanup_processed_documents,
            aitj.last_error AS ai_transition_last_error
     FROM knowledgebases kb
     LEFT JOIN kb_google_store kgs ON kgs.kb_id = kb.id
     LEFT JOIN (
       SELECT kb_id, COUNT(*)::int AS cnt FROM kb_documents GROUP BY kb_id
     ) dc ON dc.kb_id = kb.id
     LEFT JOIN kb_restore_jobs j ON j.id = kb.active_restore_job_id
     LEFT JOIN tenant_ai_settings tas ON tas.tenant_id = kb.tenant_id
     LEFT JOIN ai_engine_transition_jobs aitj ON aitj.id = tas.active_transition_job_id
     WHERE kb.id = $1 AND kb.tenant_id = $2 AND ${visibleKnowledgebaseSql('kb')}
     LIMIT 1`,
        [id, tenantId, currentFingerprint],
      );
      return result.rows[0];
    },

    async insertKnowledgebase(tenantId: string, name: string, description: string, userId: string): Promise<KnowledgebaseRow> {
      const result = await db.query<KnowledgebaseRow>(
        `INSERT INTO knowledgebases (tenant_id, name, description, created_by)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
        [tenantId, name, description, userId],
      );
      return result.rows[0];
    },

    /** Writes the given name and description; undefined when no row matched. */
    async updateKnowledgebase(
      id: string,
      tenantId: string,
      input: { name?: string; description?: string },
    ): Promise<KnowledgebaseRow | undefined> {
      const sets: string[] = [];
      const params: unknown[] = [];
      let idx = 1;

      if (input.name !== undefined) { sets.push(`name = $${idx++}`); params.push(input.name); }
      if (input.description !== undefined) { sets.push(`description = $${idx++}`); params.push(input.description); }
      sets.push(`updated_at = now()`);

      params.push(id, tenantId);
      const result = await db.query<KnowledgebaseRow>(
        `UPDATE knowledgebases SET ${sets.join(', ')} WHERE id = $${idx++} AND tenant_id = $${idx++} RETURNING *`,
        params,
      );
      return result.rows[0];
    },

    /** One page of the knowledge base's documents, newest first, with the total (window count). */
    async selectDocumentPage(filter: DocumentListFilter, pageSize: number, offset: number): Promise<Array<KbDocumentRow & { full_count: string }>> {
      // Build WHERE dynamically — always filter by kb_id + tenant_id
      const conditions: string[] = ['kb_id = $1', 'tenant_id = $2'];
      const params: unknown[] = [filter.kbId, filter.tenantId];
      let idx = 3;

      if (filter.search?.trim()) {
        conditions.push(`name ILIKE $${idx++}`);
        params.push(`%${filter.search.trim()}%`);
      }
      if (filter.status?.trim()) {
        conditions.push(`status = $${idx++}`);
        params.push(filter.status.trim());
      }
      if (filter.type?.trim()) {
        conditions.push(`type = $${idx++}`);
        params.push(filter.type.trim());
      }

      const where = conditions.join(' AND ');

      // Single query with window function COUNT(*) OVER() — more efficient than 2 queries
      params.push(pageSize, offset);
      const result = await db.query<KbDocumentRow & { full_count: string }>(
        `SELECT *, COUNT(*) OVER() AS full_count
     FROM kb_documents
     WHERE ${where}
     ORDER BY created_at DESC
     LIMIT $${idx++} OFFSET $${idx++}`,
        params,
      );
      return result.rows;
    },

    async selectDocument(docId: string, tenantId: string): Promise<KbDocumentRow | undefined> {
      const result = await db.query<KbDocumentRow>(
        `SELECT * FROM kb_documents WHERE id = $1 AND tenant_id = $2`,
        [docId, tenantId],
      );
      return result.rows[0];
    },

    /** Deletes the document of the knowledge base; the count deleted. */
    async deleteDocument(docId: string, kbId: string, tenantId: string): Promise<number> {
      const result = await db.query(
        `DELETE FROM kb_documents WHERE id = $1 AND kb_id = $2 AND tenant_id = $3`,
        [docId, kbId, tenantId],
      );
      return result.rowCount || 0;
    },

    async selectDocumentStatuses(docIds: string[], kbId: string, tenantId: string): Promise<Array<{ id: string; status: string }>> {
      const statusCheck = await db.query<{ id: string; status: string }>(
        `SELECT id, status FROM kb_documents WHERE id = ANY($1) AND kb_id = $2 AND tenant_id = $3`,
        [docIds, kbId, tenantId],
      );
      return statusCheck.rows;
    },

    async selectDocumentFilePaths(docIds: string[], kbId: string, tenantId: string): Promise<Array<{ id: string; file_path: string | null }>> {
      const filePaths = await db.query<{ id: string; file_path: string | null }>(
        `SELECT id, file_path FROM kb_documents WHERE id = ANY($1) AND kb_id = $2 AND tenant_id = $3`,
        [docIds, kbId, tenantId],
      );
      return filePaths.rows;
    },

    /** Deletes the documents of the knowledge base; the count deleted. */
    async deleteDocuments(docIds: string[], kbId: string, tenantId: string): Promise<number> {
      const result = await db.query(
        `DELETE FROM kb_documents WHERE id = ANY($1) AND kb_id = $2 AND tenant_id = $3`,
        [docIds, kbId, tenantId],
      );
      return result.rowCount || 0;
    },

    /** Sets the status and notifies the Lesson Author source listeners; the document's tenant. */
    async updateDocumentStatus(docId: string, status: string, errorReason: string | null): Promise<string | undefined> {
      const result = await db.query<{ tenant_id: string }>(
        `WITH updated AS (
       UPDATE kb_documents
          SET status = $1, error_reason = $2, updated_at = now()
        WHERE id = $3
        RETURNING id, tenant_id, kb_id, status, updated_at
     )
     SELECT tenant_id,
            pg_notify('lesson_author_source_document_event', json_build_object(
              'document_id', id, 'tenant_id', tenant_id, 'kb_id', kb_id,
              'status', status, 'updated_at', updated_at
            )::text)
       FROM updated`,
        [status, errorReason, docId],
      );
      return result.rows[0]?.tenant_id;
    },

    /** Per-document transaction lock of the Gemini mapping (the client holds the transaction). */
    async lockDocumentGeminiMapping(documentId: string): Promise<void> {
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`kb-doc-gemini-mapping:${documentId}`]);
    },

    async hasDocumentGeminiMapping(documentId: string): Promise<boolean> {
      const existing = await db.query<{ id: string }>(
        `SELECT id FROM kb_doc_gemini_mapping WHERE document_id = $1 LIMIT 1`,
        [documentId],
      );
      return Boolean(existing.rowCount && existing.rowCount > 0);
    },

    async insertDocumentGeminiMapping(documentId: string, storeId: string, geminiPath: string): Promise<void> {
      await db.query(
        `INSERT INTO kb_doc_gemini_mapping (document_id, store_id, gemini_path) VALUES ($1, $2, $3)`,
        [documentId, storeId, geminiPath],
      );
    },

    async insertLearningDocument(
      tenantId: string,
      kbId: string,
      source: { type: string; name: string; sourceInfo: Record<string, unknown>; content: string | null; storagePath: string | null },
      userId: string,
    ): Promise<KbDocumentRow> {
      const inserted = await db.query<KbDocumentRow>(
        `INSERT INTO kb_documents
       (tenant_id, kb_id, type, name, status, source_info, content, file_path, created_by)
     VALUES ($1, $2, $3, $4, 'learning', $5::jsonb, $6, $7, $8)
     RETURNING *`,
        [tenantId, kbId, source.type, source.name, JSON.stringify(source.sourceInfo), source.content, source.storagePath, userId],
      );
      return inserted.rows[0];
    },

    /** Proposed blueprints of the knowledge base built from any of the documents (or the whole KB) become superseded. */
    async supersedeBlueprintsForDocuments(tenantId: string, kbId: string, documentIds: readonly string[], reason: string): Promise<void> {
      await db.query(
        `UPDATE lesson_author_blueprints blueprint
       SET status = 'superseded',
           error_reason = $4,
           updated_at = now()
       WHERE blueprint.tenant_id = $1
         AND blueprint.kb_id = $2
         AND blueprint.status = 'proposed'
         AND (
           jsonb_array_length(blueprint.source_documents) = 0
           OR EXISTS (
             SELECT 1
             FROM jsonb_array_elements(blueprint.source_documents) AS source(document)
             WHERE source.document ->> 'document_id' = ANY($3::text[])
           )
         )`,
        [tenantId, kbId, [...documentIds], reason],
      );
    },

    async supersedeBlueprintsForKnowledgebase(tenantId: string, kbId: string, reason: string): Promise<void> {
      await db.query(
        `UPDATE lesson_author_blueprints
       SET status = 'superseded',
           error_reason = $3,
           updated_at = now()
       WHERE tenant_id = $1 AND kb_id = $2 AND status = 'proposed'`,
        [tenantId, kbId, reason],
      );
    },

    /** Transcript jobs that produced these documents keep their result but lose the link; their ids. */
    async detachTranscriptJobs(tenantId: string, kbId: string, documentIds: readonly string[]): Promise<string[]> {
      const detached = await db.query<{ id: string }>(
        `UPDATE lesson_author_transcription_jobs
       SET status = 'succeeded',
           kb_document_id = NULL,
           last_error = NULL,
           updated_at = now()
       WHERE tenant_id = $1
         AND kb_id = $2
         AND kb_document_id = ANY($3::uuid[])
       RETURNING id::text`,
        [tenantId, kbId, [...documentIds]],
      );
      return detached.rows.map(job => job.id);
    },

    async lockDocument(docId: string, kbId: string, tenantId: string): Promise<KbDocumentRow | undefined> {
      const current = await db.query<KbDocumentRow>(
        `SELECT * FROM kb_documents
     WHERE id = $1 AND kb_id = $2 AND tenant_id = $3
     FOR UPDATE`,
        [docId, kbId, tenantId],
      );
      return current.rows[0];
    },

    async selectDocumentMappingPaths(docId: string): Promise<Array<{ gemini_path: string }>> {
      const mappings = await db.query<{ gemini_path: string }>(
        `SELECT gemini_path FROM kb_doc_gemini_mapping WHERE document_id = $1`,
        [docId],
      );
      return mappings.rows;
    },

    /** The documents not learning or deleting, locked. */
    async lockDeletableDocuments(docIds: string[], kbId: string, tenantId: string): Promise<KbDocumentRow[]> {
      const documents = await db.query<KbDocumentRow>(
        `SELECT * FROM kb_documents
     WHERE id = ANY($1) AND kb_id = $2 AND tenant_id = $3
       AND status <> 'learning' AND status <> 'deleting'
     FOR UPDATE`,
        [docIds, kbId, tenantId],
      );
      return documents.rows;
    },

    async selectMappingPathsOfDocuments(docIds: string[]): Promise<Array<{ document_id: string; gemini_path: string }>> {
      const mappings = await db.query<{ document_id: string; gemini_path: string }>(
        `SELECT document_id, gemini_path
     FROM kb_doc_gemini_mapping
     WHERE document_id = ANY($1)`,
        [docIds],
      );
      return mappings.rows;
    },

    /** Failed documents with a source file and no failed delete go back to learning. */
    async markDocumentsForRetry(docIds: string[], kbId: string, tenantId: string): Promise<KbDocumentRow[]> {
      const updated = await db.query<KbDocumentRow>(
        `UPDATE kb_documents
     SET status = 'learning', error_reason = NULL, updated_at = now()
     WHERE id = ANY($1) AND kb_id = $2 AND tenant_id = $3
       AND status = 'error' AND file_path IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM kb_operation_jobs failed_delete
         WHERE failed_delete.target_document_id = kb_documents.id
           AND failed_delete.operation = 'document_delete'
           AND failed_delete.status = 'failed'
       )
     RETURNING *`,
        [docIds, kbId, tenantId],
      );
      return updated.rows;
    },

    async deleteFailedUploadJobs(docIds: string[]): Promise<void> {
      await db.query(
        `DELETE FROM kb_operation_jobs
       WHERE document_id = ANY($1)
         AND operation IN ('document_upload', 'document_reupload')
         AND status = 'failed'`,
        [docIds],
      );
    },

    async lockKnowledgebase(id: string, tenantId: string): Promise<KnowledgebaseRow | undefined> {
      const kb = await db.query<KnowledgebaseRow>(
        `SELECT * FROM knowledgebases WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [id, tenantId],
      );
      return kb.rows[0];
    },

    async countChatbotsUsingKb(id: string, tenantId: string): Promise<{ cnt: number } | undefined> {
      const bots = await db.query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt FROM chatbots WHERE kb_id = $1 AND tenant_id = $2`,
        [id, tenantId],
      );
      return bots.rows[0];
    },

    async countKbAssignments(id: string, tenantId: string): Promise<{ cnt: number } | undefined> {
      const assignments = await db.query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt FROM tenant_kb_assignments WHERE kb_id = $1 AND tenant_id = $2`,
        [id, tenantId],
      );
      return assignments.rows[0];
    },

    async lockArticle(docId: string, kbId: string, tenantId: string): Promise<KbDocumentRow | undefined> {
      const current = await db.query<KbDocumentRow>(
        `SELECT * FROM kb_documents
     WHERE id = $1 AND kb_id = $2 AND tenant_id = $3 AND type = 'article'
     FOR UPDATE`,
        [docId, kbId, tenantId],
      );
      return current.rows[0];
    },

    async updateArticleSource(
      docId: string,
      kbId: string,
      tenantId: string,
      source: { name: string; content: string | null; storagePath: string | null; sourceInfo: Record<string, unknown> },
    ): Promise<KbDocumentRow | undefined> {
      const updated = await db.query<KbDocumentRow>(
        `UPDATE kb_documents
     SET name = $1, content = $2, file_path = $3, status = 'learning', source_info = $4::jsonb,
         error_reason = NULL, updated_at = now()
     WHERE id = $5 AND kb_id = $6 AND tenant_id = $7
     RETURNING *`,
        [source.name, source.content, source.storagePath, JSON.stringify(source.sourceInfo), docId, kbId, tenantId],
      );
      return updated.rows[0];
    },
  };
}

export type KbRepository = ReturnType<typeof createKbRepository>;
