// ═══════════════════════════════════════════════════════════════
// Course assets service: the asset list (signed cursor or offset pages,
// annotated with how many outline blocks use each file), asset rows created,
// deleted or marked as reference, the image check of image-choice questions,
// and the removal of files the outline no longer uses after publish or
// discard. SQL lives in course-assets.repository.ts; moved from
// course-authoring.service.ts, which still re-exports every entry point.
// ═══════════════════════════════════════════════════════════════

import { afterCommit, query } from '../../config/database.js';
import { invalidateCourseReadCaches } from '../../config/cache-invalidation.js';
import { AppError } from '../../utils/errors.js';
import { deleteFile } from '../../config/storage.js';
import { isIsoTimestamp } from '../../utils/client-error.js';
import { isUuid } from '../../utils/uuid.js';
import { assertCourseBelongsToTenant } from '../courses/course-access.service.js';
import { getImageChoiceQuizImagePaths } from './course-publish-checks.logic.js';
import {
  chunkList,
  collectCourseStoragePaths,
  countPublishedReferences,
  isCourseStoragePath,
  stripStoragePathReference,
} from './course-storage-paths.logic.js';
import { createCourseAssetsRepository, type CourseAssetListRow } from './course-assets.repository.js';
import type {
  AssetDeleteResult,
  AssetRecord,
  CourseAssetsResponse,
  DeleteAssetByStoragePathResult,
} from './course-authoring.types.js';

const assetsRepository = createCourseAssetsRepository({ query });

export async function assertImageChoiceQuizImageAssets(courseId: string, tenantId: string, raw: any): Promise<void> {
  const storagePaths = getImageChoiceQuizImagePaths(raw);
  if (storagePaths.length === 0) return;

  const rows = await assetsRepository.selectAssetsByStoragePaths(courseId, tenantId, storagePaths);

  const rowByPath = new Map(rows.map(row => [row.storage_path, row]));
  for (const storagePath of storagePaths) {
    const row = rowByPath.get(storagePath);
    if (!row) {
      throw new AppError('Ảnh đáp án phải là asset thuộc đúng khóa học hiện tại', 400);
    }
    if (!String(row.content_type || '').toLowerCase().startsWith('image/')) {
      throw new AppError('Mỗi đáp án chỉ được dùng asset hình ảnh', 400);
    }
  }
}

// ── Course Assets ──

export async function getCourseAssets(
  courseId: string,
  tenantId: string,
  page = 0,
  pageSize = 50,
  textSearch = '',
  options: { cursor?: string | null; cursorPagination?: boolean } = {},
): Promise<CourseAssetsResponse> {
  const safePage = Math.max(0, page);
  const safePageSize = Math.max(1, Math.min(pageSize, 100));
  await assertCourseBelongsToTenant(courseId, tenantId, 'Course not found');

  const filter = { courseId, tenantId, search: textSearch.trim() };

  if (options.cursorPagination || options.cursor) {
    const cursor = decodeAssetCursor(options.cursor);
    const rows = await assetsRepository.selectAssetsAfterCursor(filter, cursor, safePageSize + 1);

    const hasMore = rows.length > safePageSize;
    if (hasMore) rows.length = safePageSize;
    const assets = await annotateAssetRowsWithOutlineReferences(courseId, rows);
    const lastRow = rows[rows.length - 1];

    return {
      start: 0,
      end: assets.length,
      page: safePage,
      pageSize: safePageSize,
      totalCount: null,
      assets,
      hasMore,
      nextCursor: hasMore && lastRow ? encodeAssetCursor(lastRow) : null,
    };
  }

  const offset = safePage * safePageSize;

  const total = parseInt((await assetsRepository.countAssets(filter)) ?? '0');

  const rows = await assetsRepository.selectAssetPage(filter, safePageSize, offset);

  const assets = await annotateAssetRowsWithOutlineReferences(courseId, rows);
  const hasMore = offset + assets.length < total;
  const lastRow = rows[rows.length - 1];

  return {
    start: offset,
    end: Math.min(offset + safePageSize, total),
    page: safePage,
    pageSize: safePageSize,
    totalCount: total,
    assets,
    hasMore,
    nextCursor: hasMore && lastRow ? encodeAssetCursor(lastRow) : null,
  };
}

function encodeBase64Url(value: string): string {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + padding, 'base64').toString('utf8');
}

function encodeAssetCursor(row: { cursor_created_at?: string; created_at?: string | Date; date_added?: string | Date; id: string }): string {
  const createdAt = row.cursor_created_at ?? row.created_at ?? row.date_added;
  return encodeBase64Url(JSON.stringify({
    created_at: createdAt instanceof Date ? createdAt.toISOString() : String(createdAt),
    id: row.id,
  }));
}

function decodeAssetCursor(cursor?: string | null): { created_at: string; id: string } | null {
  const value = typeof cursor === 'string' ? cursor.trim() : '';
  if (!value) return null;

  try {
    const parsed = JSON.parse(decodeBase64Url(value));
    if (
      !parsed ||
      !isIsoTimestamp(parsed.created_at) ||
      !isUuid(parsed.id)
    ) {
      throw new AppError('invalid cursor payload', 400);
    }
    return { created_at: parsed.created_at, id: parsed.id };
  } catch {
    throw new AppError('Cursor không hợp lệ', 400);
  }
}

async function annotateAssetRowsWithOutlineReferences(courseId: string, rows: CourseAssetListRow[]): Promise<AssetRecord[]> {
  const storagePaths = rows
    .map((row) => (typeof row.storage_path === 'string' ? row.storage_path.trim() : ''))
    .filter(isCourseStoragePath);
  const outlineReferenceCountByPath = new Map<string, number>();

  if (storagePaths.length > 0) {
    const referenceRows = await assetsRepository.countOutlineReferences(courseId, Array.from(new Set(storagePaths)));

    for (const row of referenceRows) {
      if (row.storage_path) outlineReferenceCountByPath.set(row.storage_path, Number(row.reference_count) || 0);
    }
  }

  return rows.map((row) => {
    const storagePath = typeof row.storage_path === 'string' ? row.storage_path : '';
    const outlineReferenceCount = outlineReferenceCountByPath.get(storagePath) ?? 0;
    const { created_at: _createdAt, cursor_created_at: _cursorCreatedAt, ...assetRow } = row;
    return {
      ...assetRow,
      is_outline_media: outlineReferenceCount > 0,
      outline_reference_count: outlineReferenceCount,
    };
  });
}
/** 404 unless the course exists, is not deleted and belongs to the tenant. */
export async function assertCourseInTenant(courseId: string, tenantId: string | null | undefined): Promise<void> {
  if (!tenantId) throw new AppError('Course not found', 404);
  await assertCourseBelongsToTenant(courseId, tenantId, 'Course not found');
}

export async function createAssetRecord(
  courseId: string,
  tenantId: string,
  displayName: string,
  contentType: string,
  fileSize: number,
  storagePath: string,
  url: string,
  uploadedBy: string,
): Promise<AssetRecord> {
  // The course must belong to the asset's tenant; otherwise nothing is inserted.
  const asset = await assetsRepository.insertAssetRecord(
    courseId, tenantId, displayName, contentType, fileSize, storagePath, url, uploadedBy,
  );
  if (!asset) throw new AppError('Course not found', 404);
  await invalidateCourseReadCaches(courseId, tenantId);
  return asset;
}

/**
 * Not called anywhere (kept unchanged from course-authoring.service.ts): strips
 * a storage path from the content of every block of the course that mentions it.
 */
export async function cleanupBlockReferences(
  courseId: string,
  storagePath: string,
  options: { includePublished: boolean },
): Promise<void> {
  try {
    const blocks = await assetsRepository.selectBlocksReferencingStoragePath(courseId, storagePath);

    for (const block of blocks) {
      const updates: Array<{ column: string; value: any }> = [];

      const newData = block.data ? stripStoragePathReference(block.data, storagePath) : block.data;
      const newMeta = block.metadata ? stripStoragePathReference(block.metadata, storagePath) : block.metadata;
      if (JSON.stringify(newData) !== JSON.stringify(block.data)) updates.push({ column: 'data', value: newData });
      if (JSON.stringify(newMeta) !== JSON.stringify(block.metadata)) updates.push({ column: 'metadata', value: newMeta });

      if (options.includePublished) {
        const newPubData = block.published_data ? stripStoragePathReference(block.published_data, storagePath) : block.published_data;
        const newPubMeta = block.published_metadata ? stripStoragePathReference(block.published_metadata, storagePath) : block.published_metadata;
        if (JSON.stringify(newPubData) !== JSON.stringify(block.published_data)) updates.push({ column: 'published_data', value: newPubData });
        if (JSON.stringify(newPubMeta) !== JSON.stringify(block.published_metadata)) updates.push({ column: 'published_metadata', value: newPubMeta });
      }

      if (updates.length === 0) continue;

      await assetsRepository.updateBlockJsonColumns(block.id, updates);
    }
  } catch (err) {
    console.error('[cleanupBlockReferences] Error:', err);
  }
}

export async function collectPublishedStoragePathsForSubtree(blockId: string): Promise<Set<string>> {
  const rows = await assetsRepository.selectPublishedContentOfChangedSubtree(blockId);

  const paths = new Set<string>();
  for (const row of rows) {
    collectCourseStoragePaths(row.published_data, paths);
    collectCourseStoragePaths(row.published_metadata, paths);
  }
  return paths;
}

export async function collectDraftStoragePathsForSubtree(blockId: string): Promise<Set<string>> {
  const rows = await assetsRepository.selectDraftContentOfChangedSubtree(blockId);

  const paths = new Set<string>();
  for (const row of rows) {
    collectCourseStoragePaths(row.data, paths);
    collectCourseStoragePaths(row.metadata, paths);
  }
  return paths;
}

async function deleteCourseAssetsByStoragePaths(courseId: string, storagePaths: string[]): Promise<string[]> {
  const uniquePaths = Array.from(new Set(storagePaths.filter(isCourseStoragePath)));
  if (uniquePaths.length === 0) return [];

  const rows = await assetsRepository.deleteNonReferenceAssetsByPaths(courseId, uniquePaths);

  const deletedPaths = Array.from(new Set(rows.map((row) => row.storage_path).filter(Boolean)));
  // Publish and discard run this inside their audited transaction. The objects
  // are removed once it committed: each delete's quota fence waits for the
  // tenant quota row this transaction already locked (a statement_timeout
  // later the file stayed), and a rollback must keep the files its rows use.
  if (deletedPaths.length > 0) {
    await afterCommit(async () => {
      await Promise.allSettled(deletedPaths.map((path) => deleteFile(path)));
    });
  }
  return deletedPaths;
}

async function collectReferencedCandidateStoragePaths(courseId: string, storagePaths: string[]): Promise<Set<string>> {
  const uniquePaths = Array.from(new Set(storagePaths.filter(isCourseStoragePath)));
  const referenced = new Set<string>();
  if (uniquePaths.length === 0) return referenced;

  for (const chunk of chunkList(uniquePaths, 100)) {
    const rows = await assetsRepository.selectReferencedStoragePaths(courseId, chunk);

    for (const row of rows) {
      if (row.storage_path) referenced.add(row.storage_path);
    }
  }

  return referenced;
}

export async function cleanupStoragePathsNoLongerReferenced(courseId: string, candidateStoragePaths: Set<string>): Promise<string[]> {
  if (candidateStoragePaths.size === 0) return [];

  const candidatePaths = Array.from(candidateStoragePaths).filter(isCourseStoragePath);
  const currentPaths = await collectReferencedCandidateStoragePaths(courseId, candidatePaths);
  const removedPaths = candidatePaths.filter((path) => !currentPaths.has(path));
  return deleteCourseAssetsByStoragePaths(courseId, removedPaths);
}

export async function deleteAsset(assetId: string, courseId: string, tenantId: string): Promise<AssetDeleteResult | null> {
  const asset = await assetsRepository.selectAsset(assetId, courseId, tenantId);
  if (!asset) return null;

  const referencingBlocks = await assetsRepository.selectBlocksReferencingStoragePath(asset.course_id, asset.storage_path);
  const publishedReferenceCount = countPublishedReferences(referencingBlocks, asset.storage_path);
  if (referencingBlocks.length > 0) {
    return {
      asset,
      deleted: false,
      pendingPublishedReferences: true,
      publishedReferenceCount: Math.max(publishedReferenceCount, referencingBlocks.length),
      storagePathsToDelete: [],
    };
  }

  const deleted = await assetsRepository.deleteAsset(assetId, courseId, tenantId);
  await invalidateCourseReadCaches(courseId, tenantId);

  return {
    asset: deleted,
    deleted: true,
    pendingPublishedReferences: false,
    publishedReferenceCount: 0,
    storagePathsToDelete: asset.storage_path ? [asset.storage_path] : [],
  };
}

export async function deleteAssetByStoragePath(
  courseId: string,
  tenantId: string,
  storagePath: string,
): Promise<DeleteAssetByStoragePathResult> {
  // Tenant first: the block-reference lookup below must never answer for a
  // course of another tenant (it would reveal which files that course uses).
  await assertCourseInTenant(courseId, tenantId);
  const referencingBlocks = await assetsRepository.selectBlocksReferencingStoragePath(courseId, storagePath);
  const publishedReferenceCount = countPublishedReferences(referencingBlocks, storagePath);
  if (referencingBlocks.length > 0) {
    return {
      deletedRows: [],
      pendingPublishedReferences: true,
      publishedReferenceCount: Math.max(publishedReferenceCount, referencingBlocks.length),
      storagePathsToDelete: [],
    };
  }

  const rows = await assetsRepository.deleteAssetsByStoragePath(courseId, tenantId, storagePath);
  if (rows.length > 0) await invalidateCourseReadCaches(courseId, tenantId);

  return {
    deletedRows: rows,
    pendingPublishedReferences: false,
    publishedReferenceCount: 0,
    storagePathsToDelete: rows.map((row) => row.storage_path).filter(Boolean),
  };
}

export async function updateCourseAssetReference(
  courseId: string,
  assetIds: string[],
  isReference: boolean,
  tenantId: string,
): Promise<void> {
  if (!assetIds.length) return;
  await assetsRepository.updateAssetReference(courseId, assetIds, isReference, tenantId);
  await invalidateCourseReadCaches(courseId, tenantId);
}
