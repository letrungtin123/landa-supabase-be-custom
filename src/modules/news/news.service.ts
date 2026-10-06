import { env } from '../../config/env.js';
import { cacheJson, getCacheVersion } from '../../config/cache.js';
import { CACHE_TTL, cacheKeys, cacheVersions } from '../../config/cache-keys.js';
import { invalidateTenantNewsCaches } from '../../config/cache-invalidation.js';
import { query } from '../../config/database.js';
import { AppError } from '../../middleware/error-handler.js';
import {
  decodeNewsCursor,
  encodeNewsCursor,
  extractNewsImagePaths,
  foldNewsSearch,
  normalizeNewsImagePath,
  normalizeNewsSearch,
  sanitizeNewsContent,
} from './news.logic.js';
import type { CreateNewsInput, ListNewsInput, UpdateNewsInput } from './news.validator.js';

interface NewsListRow {
  id: string;
  title: string;
  excerpt: string;
  preview_image_path: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  version: string | number;
}

interface NewsDetailRow extends NewsListRow {
  content_html: string;
  created_by: string | null;
  updated_by: string | null;
  archived_by: string | null;
}

interface NewsAssetRow {
  id: string;
  storage_path: string;
  status: 'pending' | 'attached' | 'delete_pending';
  post_id: string | null;
  upload_session_id: string;
}

export interface NewsMutationResult {
  post: NewsDetailRow;
  storagePathsToDelete: string[];
  previousTitle?: string;
}

function serializePost<T extends NewsListRow>(row: T): T & { version: number } {
  return { ...row, version: Number(row.version) };
}

function listSortColumn(status: 'active' | 'archived'): string {
  return status === 'archived' ? 'np.archived_at' : 'np.created_at';
}

async function listNewsRows(tenantId: string, input: ListNewsInput, allowArchived: boolean) {
  const status = allowArchived ? input.status : 'active';
  const search = normalizeNewsSearch(input.search);
  const cursor = decodeNewsCursor(input.cursor, env.JWT_SECRET);
  if (cursor && (cursor.status !== status || cursor.search !== search)) {
    throw new AppError('Cursor không khớp bộ lọc hiện tại', 400, 'INVALID_CURSOR');
  }

  const params: unknown[] = [tenantId];
  const where = [status === 'archived' ? 'np.archived_at IS NOT NULL' : 'np.archived_at IS NULL'];
  if (search) {
    params.push(search, foldNewsSearch(search));
    where.push(`(
      np.search_vector @@ websearch_to_tsquery('simple', $${params.length - 1})
      OR np.search_vector @@ websearch_to_tsquery('simple', $${params.length})
    )`);
  }
  const sortColumn = listSortColumn(status);
  if (cursor) {
    params.push(cursor.timestamp, cursor.id);
    where.push(`(${sortColumn}, np.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(input.limit + 1);

  const result = await query<NewsListRow>(
    `SELECT np.id, np.title, np.excerpt, np.preview_image_path,
            np.created_at, np.updated_at, np.archived_at, np.version
     FROM news_posts np
     WHERE np.tenant_id = $1::uuid
       AND ${where.join('\n       AND ')}
     ORDER BY ${sortColumn} DESC, np.id DESC
     LIMIT $${params.length}::int`,
    params,
  );

  const hasMore = result.rows.length > input.limit;
  const rows = hasMore ? result.rows.slice(0, input.limit) : result.rows;
  const last = rows.at(-1);
  const timestamp = last ? (status === 'archived' ? last.archived_at : last.created_at) : null;
  return {
    results: rows.map(serializePost),
    page_size: input.limit,
    has_more: hasMore,
    next_cursor: hasMore && last && timestamp
      ? encodeNewsCursor({ timestamp, id: last.id, status, search }, env.JWT_SECRET)
      : null,
  };
}

export async function listPublishedNews(tenantId: string, input: ListNewsInput) {
  const cacheable = !input.cursor && !normalizeNewsSearch(input.search) && input.limit === 20;
  if (!cacheable) return listNewsRows(tenantId, { ...input, status: 'active' }, false);
  const version = await getCacheVersion(...cacheVersions.tenantNews(tenantId));
  const key = cacheKeys.tenantResource(tenantId, 'news-feed-first-page', version, { limit: input.limit });
  return cacheJson(key, CACHE_TTL.news, () => listNewsRows(tenantId, { ...input, status: 'active' }, false));
}

export async function listManagedNews(tenantId: string, input: ListNewsInput) {
  return listNewsRows(tenantId, input, true);
}

export async function getNewsPost(tenantId: string, postId: string, includeArchived: boolean) {
  const loader = async () => {
    const result = await query<NewsDetailRow>(
      `SELECT id, title, content_html, excerpt, preview_image_path, created_by, updated_by, archived_by,
              created_at, updated_at, archived_at, version
       FROM news_posts
       WHERE id = $1::uuid AND tenant_id = $2::uuid
         ${includeArchived ? '' : 'AND archived_at IS NULL'}
       LIMIT 1`,
      [postId, tenantId],
    );
    if (result.rowCount === 0) throw new AppError('Bài viết không tồn tại', 404, 'NEWS_NOT_FOUND');
    return serializePost(result.rows[0]);
  };
  if (includeArchived) return loader();
  const version = await getCacheVersion(...cacheVersions.tenantNews(tenantId));
  const key = cacheKeys.tenantResource(tenantId, 'news-detail', version, { postId });
  return cacheJson(key, CACHE_TTL.news, loader);
}

async function assertAssetsCanAttach(
  tenantId: string,
  postId: string | null,
  uploadSessionId: string | undefined,
  storagePaths: string[],
): Promise<void> {
  if (storagePaths.length === 0) return;
  const result = await query<NewsAssetRow>(
    `SELECT id, storage_path, status, post_id, upload_session_id
     FROM news_post_assets
     WHERE tenant_id = $1::uuid AND storage_path = ANY($2::text[])
     FOR UPDATE`,
    [tenantId, storagePaths],
  );
  const byPath = new Map(result.rows.map((row) => [row.storage_path, row]));
  for (const path of storagePaths) {
    const row = byPath.get(path);
    const alreadyAttached = row?.status === 'attached' && !!postId && row.post_id === postId;
    const pendingForSession = row?.status === 'pending' && !!uploadSessionId && row.upload_session_id === uploadSessionId;
    if (!alreadyAttached && !pendingForSession) {
      throw new AppError('Ảnh bài viết không hợp lệ hoặc đã hết hạn', 409, 'NEWS_ASSET_INVALID');
    }
  }
}

async function reconcilePostAssets(
  tenantId: string,
  postId: string,
  uploadSessionId: string | undefined,
  desiredPaths: string[],
): Promise<string[]> {
  const desired = [...new Set(desiredPaths)];
  await assertAssetsCanAttach(tenantId, postId, uploadSessionId, desired);
  if (uploadSessionId && desired.length > 0) {
    await query(
      `UPDATE news_post_assets
       SET post_id = $2::uuid, status = 'attached', expires_at = NULL,
           cleanup_lease_until = NULL, updated_at = now()
       WHERE tenant_id = $1::uuid
         AND upload_session_id = $3::uuid
         AND status = 'pending'
         AND storage_path = ANY($4::text[])`,
      [tenantId, postId, uploadSessionId, desired],
    );
  }

  const removed = await query<{ storage_path: string }>(
    `UPDATE news_post_assets
     SET status = 'delete_pending', cleanup_lease_until = NULL, updated_at = now()
     WHERE tenant_id = $1::uuid
       AND post_id = $2::uuid
       AND status = 'attached'
       AND NOT (storage_path = ANY($3::text[]))
     RETURNING storage_path`,
    [tenantId, postId, desired],
  );
  return removed.rows.map((row) => row.storage_path);
}

function desiredPostAssetPaths(contentHtml: string, previewPath: string | null, tenantId: string): string[] {
  return [...new Set([
    ...extractNewsImagePaths(contentHtml, tenantId),
    ...(previewPath ? [previewPath] : []),
  ])];
}

export async function createNewsPost(tenantId: string, actorId: string, input: CreateNewsInput): Promise<NewsMutationResult> {
  const content = sanitizeNewsContent(input.content_html, tenantId);
  const previewPath = input.preview_image_path == null ? null : normalizeNewsImagePath(input.preview_image_path, tenantId);
  if (input.preview_image_path && !previewPath) {
    throw new AppError('Ảnh đại diện không hợp lệ', 400, 'INVALID_NEWS_IMAGE');
  }
  const desiredPaths = desiredPostAssetPaths(content.html, previewPath, tenantId);
  await assertAssetsCanAttach(tenantId, null, input.upload_session_id, desiredPaths);

  const result = await query<NewsDetailRow>(
    `INSERT INTO news_posts (
       tenant_id, title, content_html, excerpt, preview_image_path, created_by, updated_by
     ) VALUES ($1::uuid, $2, $3, $4, $5, $6::uuid, $6::uuid)
     RETURNING id, title, content_html, excerpt, preview_image_path, created_by, updated_by, archived_by,
               created_at, updated_at, archived_at, version`,
    [tenantId, input.title, content.html, content.excerpt, previewPath, actorId],
  );
  const post = result.rows[0];
  const storagePathsToDelete = await reconcilePostAssets(
    tenantId,
    post.id,
    input.upload_session_id,
    desiredPaths,
  );
  await invalidateTenantNewsCaches(tenantId);
  return { post: serializePost(post), storagePathsToDelete };
}

export async function updateNewsPost(
  tenantId: string,
  postId: string,
  actorId: string,
  input: UpdateNewsInput,
): Promise<NewsMutationResult> {
  const currentResult = await query<NewsDetailRow>(
    `SELECT id, title, content_html, excerpt, preview_image_path, created_by, updated_by, archived_by,
            created_at, updated_at, archived_at, version
     FROM news_posts
     WHERE id = $1::uuid AND tenant_id = $2::uuid
     FOR UPDATE`,
    [postId, tenantId],
  );
  if (currentResult.rowCount === 0) throw new AppError('Bài viết không tồn tại', 404, 'NEWS_NOT_FOUND');
  const current = currentResult.rows[0];
  if (Number(current.version) !== input.expected_version) {
    throw new AppError('Bài viết vừa được cập nhật ở nơi khác. Hãy tải lại trước khi lưu.', 409, 'NEWS_VERSION_CONFLICT');
  }

  const content = input.content_html === undefined
    ? { html: current.content_html, excerpt: current.excerpt }
    : sanitizeNewsContent(input.content_html, tenantId);
  let previewPath = current.preview_image_path;
  if (input.preview_image_path !== undefined) {
    previewPath = input.preview_image_path == null ? null : normalizeNewsImagePath(input.preview_image_path, tenantId);
    if (input.preview_image_path && !previewPath) throw new AppError('Ảnh đại diện không hợp lệ', 400, 'INVALID_NEWS_IMAGE');
  }
  const desiredPaths = desiredPostAssetPaths(content.html, previewPath, tenantId);
  await assertAssetsCanAttach(tenantId, postId, input.upload_session_id, desiredPaths);

  const updated = await query<NewsDetailRow>(
    `UPDATE news_posts
     SET title = $3, content_html = $4, excerpt = $5, preview_image_path = $6,
         updated_by = $7::uuid, updated_at = now(), version = version + 1
     WHERE id = $1::uuid AND tenant_id = $2::uuid
     RETURNING id, title, content_html, excerpt, preview_image_path, created_by, updated_by, archived_by,
               created_at, updated_at, archived_at, version`,
    [postId, tenantId, input.title ?? current.title, content.html, content.excerpt, previewPath, actorId],
  );
  const storagePathsToDelete = await reconcilePostAssets(tenantId, postId, input.upload_session_id, desiredPaths);
  await invalidateTenantNewsCaches(tenantId);
  return { post: serializePost(updated.rows[0]), storagePathsToDelete, previousTitle: current.title };
}

async function setArchived(tenantId: string, postId: string, actorId: string, archived: boolean) {
  const result = await query<NewsDetailRow>(
    `UPDATE news_posts
     SET archived_at = ${archived ? 'COALESCE(archived_at, now())' : 'NULL'},
         archived_by = ${archived ? '$3::uuid' : 'NULL'},
         updated_by = $3::uuid, updated_at = now(), version = version + 1
     WHERE id = $1::uuid AND tenant_id = $2::uuid
       AND ${archived ? 'archived_at IS NULL' : 'archived_at IS NOT NULL'}
     RETURNING id, title, content_html, excerpt, preview_image_path, created_by, updated_by, archived_by,
               created_at, updated_at, archived_at, version`,
    [postId, tenantId, actorId],
  );
  if (result.rowCount === 0) throw new AppError('Bài viết không tồn tại hoặc trạng thái không thay đổi', 404, 'NEWS_NOT_FOUND');
  await invalidateTenantNewsCaches(tenantId);
  return serializePost(result.rows[0]);
}

export function archiveNewsPost(tenantId: string, postId: string, actorId: string) {
  return setArchived(tenantId, postId, actorId, true);
}

export function restoreNewsPost(tenantId: string, postId: string, actorId: string) {
  return setArchived(tenantId, postId, actorId, false);
}

export async function registerNewsAsset(input: {
  tenantId: string;
  actorId: string;
  uploadSessionId: string;
  kind: 'preview' | 'inline';
  storagePath: string;
  originalName: string;
  contentType: string;
  sizeBytes: number;
}) {
  const result = await query<NewsAssetRow>(
    `INSERT INTO news_post_assets (
       tenant_id, upload_session_id, kind, storage_path, original_name, content_type, size_bytes, created_by
     ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::uuid)
     RETURNING id, storage_path, status, post_id, upload_session_id`,
    [input.tenantId, input.uploadSessionId, input.kind, input.storagePath, input.originalName,
      input.contentType, input.sizeBytes, input.actorId],
  );
  return result.rows[0];
}

export async function queuePendingNewsAssetDelete(
  tenantId: string,
  uploadSessionId: string,
  storagePathValue: string,
) {
  const storagePath = normalizeNewsImagePath(storagePathValue, tenantId);
  if (!storagePath) throw new AppError('Ảnh bài viết không hợp lệ', 400, 'INVALID_NEWS_IMAGE');
  const result = await query<{ id: string; storage_path: string }>(
    `UPDATE news_post_assets
     SET status = 'delete_pending', cleanup_lease_until = NULL, updated_at = now()
     WHERE tenant_id = $1::uuid AND upload_session_id = $2::uuid
       AND storage_path = $3 AND status = 'pending'
     RETURNING id, storage_path`,
    [tenantId, uploadSessionId, storagePath],
  );
  if (result.rowCount === 0) throw new AppError('Ảnh không tồn tại hoặc đã được gắn vào bài viết', 409, 'NEWS_ASSET_NOT_PENDING');
  return result.rows[0];
}

export async function completeNewsAssetDeletes(storagePaths: string[]): Promise<void> {
  if (storagePaths.length === 0) return;
  await query(
    `DELETE FROM news_post_assets
     WHERE storage_path = ANY($1::text[]) AND status = 'delete_pending'`,
    [storagePaths],
  );
}

export async function claimNewsAssetCleanupBatch(limit = 50) {
  const result = await query<{ id: string; storage_path: string }>(
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
    [Math.max(1, Math.min(100, limit))],
  );
  return result.rows;
}

export async function completeClaimedNewsAsset(assetId: string): Promise<void> {
  await query('DELETE FROM news_post_assets WHERE id = $1::uuid AND status = \'delete_pending\'', [assetId]);
}

export async function releaseClaimedNewsAsset(assetId: string): Promise<void> {
  await query(
    `UPDATE news_post_assets SET cleanup_lease_until = NULL, updated_at = now()
     WHERE id = $1::uuid AND status = 'delete_pending'`,
    [assetId],
  );
}
