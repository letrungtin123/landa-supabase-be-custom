// ═══════════════════════════════════════════════════════════════
// News repository: news posts and their image assets (upload sessions,
// attachment, cleanup leases). SQL only, moved unchanged from
// news.service.ts, which keeps the rules (content sanitizing, cursors,
// version checks, which assets may attach, messages, caches).
// ═══════════════════════════════════════════════════════════════

import type { QueryResult, QueryResultRow } from 'pg';

/** The pool query() (joins the current transaction) or a transaction client. */
export interface NewsDb {
  query<T extends QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface NewsListRow {
  id: string;
  title: string;
  excerpt: string;
  preview_image_path: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  version: string | number;
}

export interface NewsDetailRow extends NewsListRow {
  content_html: string;
  created_by: string | null;
  updated_by: string | null;
  archived_by: string | null;
}

export interface NewsAssetRow {
  id: string;
  storage_path: string;
  status: 'pending' | 'attached' | 'delete_pending';
  post_id: string | null;
  upload_session_id: string;
}

export interface NewsListQuery {
  tenantId: string;
  status: 'active' | 'archived';
  /** Normalized search text and its folded (accent-free) form; empty for none. */
  search: string;
  foldedSearch: string;
  cursor: { timestamp: string; id: string } | null;
  limit: number;
}

const DETAIL_COLUMNS = `id, title, content_html, excerpt, preview_image_path, created_by, updated_by, archived_by,
               created_at, updated_at, archived_at, version`;

export function createNewsRepository(db: NewsDb) {
  return {
    /** A page of posts, newest first by creation (active) or archiving (archived) time. */
    async selectPostPage(list: NewsListQuery): Promise<NewsListRow[]> {
      const params: unknown[] = [list.tenantId];
      const where = [list.status === 'archived' ? 'np.archived_at IS NOT NULL' : 'np.archived_at IS NULL'];
      if (list.search) {
        params.push(list.search, list.foldedSearch);
        where.push(`(
      np.search_vector @@ websearch_to_tsquery('simple', $${params.length - 1})
      OR np.search_vector @@ websearch_to_tsquery('simple', $${params.length})
    )`);
      }
      const sortColumn = list.status === 'archived' ? 'np.archived_at' : 'np.created_at';
      if (list.cursor) {
        params.push(list.cursor.timestamp, list.cursor.id);
        where.push(`(${sortColumn}, np.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
      }
      params.push(list.limit);

      const result = await db.query<NewsListRow>(
        `SELECT np.id, np.title, np.excerpt, np.preview_image_path,
                np.created_at, np.updated_at, np.archived_at, np.version
         FROM news_posts np
         WHERE np.tenant_id = $1::uuid
           AND ${where.join('\n       AND ')}
         ORDER BY ${sortColumn} DESC, np.id DESC
         LIMIT $${params.length}::int`,
        params,
      );
      return result.rows;
    },

    /** `includeArchived` false: only a post that is not archived. */
    async selectPost(postId: string, tenantId: string, includeArchived: boolean): Promise<QueryResult<NewsDetailRow>> {
      return db.query<NewsDetailRow>(
        `SELECT id, title, content_html, excerpt, preview_image_path, created_by, updated_by, archived_by,
                created_at, updated_at, archived_at, version
         FROM news_posts
         WHERE id = $1::uuid AND tenant_id = $2::uuid
           ${includeArchived ? '' : 'AND archived_at IS NULL'}
         LIMIT 1`,
        [postId, tenantId],
      );
    },

    async lockPost(postId: string, tenantId: string): Promise<QueryResult<NewsDetailRow>> {
      return db.query<NewsDetailRow>(
        `SELECT id, title, content_html, excerpt, preview_image_path, created_by, updated_by, archived_by,
                created_at, updated_at, archived_at, version
         FROM news_posts
         WHERE id = $1::uuid AND tenant_id = $2::uuid
         FOR UPDATE`,
        [postId, tenantId],
      );
    },

    async insertPost(values: {
      tenantId: string;
      title: string;
      contentHtml: string;
      excerpt: string;
      previewImagePath: string | null;
      actorId: string;
    }): Promise<NewsDetailRow> {
      const result = await db.query<NewsDetailRow>(
        `INSERT INTO news_posts (
           tenant_id, title, content_html, excerpt, preview_image_path, created_by, updated_by
         ) VALUES ($1::uuid, $2, $3, $4, $5, $6::uuid, $6::uuid)
         RETURNING ${DETAIL_COLUMNS}`,
        [values.tenantId, values.title, values.contentHtml, values.excerpt, values.previewImagePath, values.actorId],
      );
      return result.rows[0];
    },

    /** Replaces the content and bumps the version. */
    async updatePost(values: {
      postId: string;
      tenantId: string;
      title: string;
      contentHtml: string;
      excerpt: string;
      previewImagePath: string | null;
      actorId: string;
    }): Promise<NewsDetailRow> {
      const result = await db.query<NewsDetailRow>(
        `UPDATE news_posts
         SET title = $3, content_html = $4, excerpt = $5, preview_image_path = $6,
             updated_by = $7::uuid, updated_at = now(), version = version + 1
         WHERE id = $1::uuid AND tenant_id = $2::uuid
         RETURNING ${DETAIL_COLUMNS}`,
        [values.postId, values.tenantId, values.title, values.contentHtml, values.excerpt, values.previewImagePath, values.actorId],
      );
      return result.rows[0];
    },

    /** Archives (or restores) a post that is not (or is) archived, and bumps the version. */
    async setArchived(postId: string, tenantId: string, actorId: string, archived: boolean): Promise<QueryResult<NewsDetailRow>> {
      return db.query<NewsDetailRow>(
        `UPDATE news_posts
         SET archived_at = ${archived ? 'COALESCE(archived_at, now())' : 'NULL'},
             archived_by = ${archived ? '$3::uuid' : 'NULL'},
             updated_by = $3::uuid, updated_at = now(), version = version + 1
         WHERE id = $1::uuid AND tenant_id = $2::uuid
           AND ${archived ? 'archived_at IS NULL' : 'archived_at IS NOT NULL'}
         RETURNING ${DETAIL_COLUMNS}`,
        [postId, tenantId, actorId],
      );
    },

    // ── Assets ──

    async lockAssetsByPath(tenantId: string, storagePaths: string[]): Promise<NewsAssetRow[]> {
      const result = await db.query<NewsAssetRow>(
        `SELECT id, storage_path, status, post_id, upload_session_id
         FROM news_post_assets
         WHERE tenant_id = $1::uuid AND storage_path = ANY($2::text[])
         FOR UPDATE`,
        [tenantId, storagePaths],
      );
      return result.rows;
    },

    /** Attaches the session's pending assets with these paths to the post. */
    async attachPendingAssets(tenantId: string, postId: string, uploadSessionId: string, storagePaths: string[]): Promise<void> {
      await db.query(
        `UPDATE news_post_assets
         SET post_id = $2::uuid, status = 'attached', expires_at = NULL,
             cleanup_lease_until = NULL, updated_at = now()
         WHERE tenant_id = $1::uuid
           AND upload_session_id = $3::uuid
           AND status = 'pending'
           AND storage_path = ANY($4::text[])`,
        [tenantId, postId, uploadSessionId, storagePaths],
      );
    },

    /** Queues for deletion the post's attached assets not in `keepPaths`; returns their paths. */
    async detachOtherAssets(tenantId: string, postId: string, keepPaths: string[]): Promise<string[]> {
      const result = await db.query<{ storage_path: string }>(
        `UPDATE news_post_assets
         SET status = 'delete_pending', cleanup_lease_until = NULL, updated_at = now()
         WHERE tenant_id = $1::uuid
           AND post_id = $2::uuid
           AND status = 'attached'
           AND NOT (storage_path = ANY($3::text[]))
         RETURNING storage_path`,
        [tenantId, postId, keepPaths],
      );
      return result.rows.map((row) => row.storage_path);
    },

    async insertAsset(values: {
      tenantId: string;
      uploadSessionId: string;
      kind: 'preview' | 'inline';
      storagePath: string;
      originalName: string;
      contentType: string;
      sizeBytes: number;
      actorId: string;
    }): Promise<NewsAssetRow> {
      const result = await db.query<NewsAssetRow>(
        `INSERT INTO news_post_assets (
           tenant_id, upload_session_id, kind, storage_path, original_name, content_type, size_bytes, created_by
         ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::uuid)
         RETURNING id, storage_path, status, post_id, upload_session_id`,
        [values.tenantId, values.uploadSessionId, values.kind, values.storagePath, values.originalName,
          values.contentType, values.sizeBytes, values.actorId],
      );
      return result.rows[0];
    },

    /** Queues for deletion a pending asset of the upload session. */
    async queuePendingAssetDelete(tenantId: string, uploadSessionId: string, storagePath: string): Promise<QueryResult<{ id: string; storage_path: string }>> {
      return db.query<{ id: string; storage_path: string }>(
        `UPDATE news_post_assets
         SET status = 'delete_pending', cleanup_lease_until = NULL, updated_at = now()
         WHERE tenant_id = $1::uuid AND upload_session_id = $2::uuid
           AND storage_path = $3 AND status = 'pending'
         RETURNING id, storage_path`,
        [tenantId, uploadSessionId, storagePath],
      );
    },

    async deleteQueuedAssetsByPath(storagePaths: string[]): Promise<void> {
      await db.query(
        `DELETE FROM news_post_assets
         WHERE storage_path = ANY($1::text[]) AND status = 'delete_pending'`,
        [storagePaths],
      );
    },

    /** Leases (5 minutes) up to `limit` expired pending or queued assets, skipping locked rows. */
    async claimCleanupBatch(limit: number): Promise<{ id: string; storage_path: string }[]> {
      const result = await db.query<{ id: string; storage_path: string }>(
        `WITH candidates AS (
           SELECT id
           FROM news_post_assets
           WHERE ((status = 'pending' AND expires_at <= now()) OR status = 'delete_pending')
             AND (cleanup_lease_until IS NULL OR cleanup_lease_until < now())
           ORDER BY expires_at ASC NULLS FIRST, created_at ASC, id ASC
           LIMIT $1::int
           FOR UPDATE SKIP LOCKED
         )
         UPDATE news_post_assets asset
         SET status = 'delete_pending', cleanup_lease_until = now() + interval '5 minutes',
             cleanup_attempts = cleanup_attempts + 1, updated_at = now()
         FROM candidates
         WHERE asset.id = candidates.id
         RETURNING asset.id, asset.storage_path`,
        [limit],
      );
      return result.rows;
    },

    async deleteQueuedAsset(assetId: string): Promise<void> {
      await db.query('DELETE FROM news_post_assets WHERE id = $1::uuid AND status = \'delete_pending\'', [assetId]);
    },

    async releaseCleanupLease(assetId: string): Promise<void> {
      await db.query(
        `UPDATE news_post_assets SET cleanup_lease_until = NULL, updated_at = now()
         WHERE id = $1::uuid AND status = 'delete_pending'`,
        [assetId],
      );
    },
  };
}

export type NewsRepository = ReturnType<typeof createNewsRepository>;
