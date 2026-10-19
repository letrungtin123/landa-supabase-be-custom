import { env } from '../../config/env.js';
import { cacheJson, getCacheVersion } from '../../config/cache.js';
import { CACHE_TTL, cacheKeys, cacheVersions } from '../../config/cache-keys.js';
import { invalidateTenantNewsCaches } from '../../config/cache-invalidation.js';
import { query } from '../../config/database.js';
import { AppError } from '../../utils/errors.js';
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
import {
  createNewsRepository,
  type NewsDb,
  type NewsDetailRow,
  type NewsListRow,
} from './news.repository.js';

const newsRepository = createNewsRepository({ query } satisfies NewsDb);

export interface NewsMutationResult {
  post: NewsDetailRow;
  storagePathsToDelete: string[];
  previousTitle?: string;
}

function serializePost<T extends NewsListRow>(row: T): T & { version: number } {
  return { ...row, version: Number(row.version) };
}

async function listNewsRows(tenantId: string, input: ListNewsInput, allowArchived: boolean) {
  const status = allowArchived ? input.status : 'active';
  const search = normalizeNewsSearch(input.search);
  const cursor = decodeNewsCursor(input.cursor, env.JWT_SECRET);
  if (cursor && (cursor.status !== status || cursor.search !== search)) {
    throw new AppError('Cursor không khớp bộ lọc hiện tại', 400, 'INVALID_CURSOR');
  }

  const found = await newsRepository.selectPostPage({
    tenantId,
    status,
    search,
    foldedSearch: search ? foldNewsSearch(search) : '',
    cursor: cursor ? { timestamp: cursor.timestamp, id: cursor.id } : null,
    limit: input.limit + 1,
  });

  const hasMore = found.length > input.limit;
  const rows = hasMore ? found.slice(0, input.limit) : found;
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
    const result = await newsRepository.selectPost(postId, tenantId, includeArchived);
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
  const rows = await newsRepository.lockAssetsByPath(tenantId, storagePaths);
  const byPath = new Map(rows.map((row) => [row.storage_path, row]));
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
    await newsRepository.attachPendingAssets(tenantId, postId, uploadSessionId, desired);
  }

  return newsRepository.detachOtherAssets(tenantId, postId, desired);
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

  const post = await newsRepository.insertPost({
    tenantId,
    title: input.title,
    contentHtml: content.html,
    excerpt: content.excerpt,
    previewImagePath: previewPath,
    actorId,
  });
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
  const currentResult = await newsRepository.lockPost(postId, tenantId);
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

  const updated = await newsRepository.updatePost({
    postId,
    tenantId,
    title: input.title ?? current.title,
    contentHtml: content.html,
    excerpt: content.excerpt,
    previewImagePath: previewPath,
    actorId,
  });
  const storagePathsToDelete = await reconcilePostAssets(tenantId, postId, input.upload_session_id, desiredPaths);
  await invalidateTenantNewsCaches(tenantId);
  return { post: serializePost(updated), storagePathsToDelete, previousTitle: current.title };
}

async function setArchived(tenantId: string, postId: string, actorId: string, archived: boolean) {
  const result = await newsRepository.setArchived(postId, tenantId, actorId, archived);
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
  return newsRepository.insertAsset({
    tenantId: input.tenantId,
    uploadSessionId: input.uploadSessionId,
    kind: input.kind,
    storagePath: input.storagePath,
    originalName: input.originalName,
    contentType: input.contentType,
    sizeBytes: input.sizeBytes,
    actorId: input.actorId,
  });
}

export async function queuePendingNewsAssetDelete(
  tenantId: string,
  uploadSessionId: string,
  storagePathValue: string,
) {
  const storagePath = normalizeNewsImagePath(storagePathValue, tenantId);
  if (!storagePath) throw new AppError('Ảnh bài viết không hợp lệ', 400, 'INVALID_NEWS_IMAGE');
  const result = await newsRepository.queuePendingAssetDelete(tenantId, uploadSessionId, storagePath);
  if (result.rowCount === 0) throw new AppError('Ảnh không tồn tại hoặc đã được gắn vào bài viết', 409, 'NEWS_ASSET_NOT_PENDING');
  return result.rows[0];
}

export async function completeNewsAssetDeletes(storagePaths: string[]): Promise<void> {
  if (storagePaths.length === 0) return;
  await newsRepository.deleteQueuedAssetsByPath(storagePaths);
}

export async function claimNewsAssetCleanupBatch(limit = 50) {
  return newsRepository.claimCleanupBatch(Math.max(1, Math.min(100, limit)));
}

export async function completeClaimedNewsAsset(assetId: string): Promise<void> {
  await newsRepository.deleteQueuedAsset(assetId);
}

export async function releaseClaimedNewsAsset(assetId: string): Promise<void> {
  await newsRepository.releaseCleanupLease(assetId);
}
