// ═══════════════════════════════════════════════════════════════
// Course assets repository: the asset list (cursor or offset pages), how
// many outline blocks use each file, asset rows created, deleted or marked
// as reference, and the block content that mentions a storage path. SQL
// only; moved unchanged from course-authoring.service.ts, which keeps the
// rules, the Storage deletes and the caches.
// ═══════════════════════════════════════════════════════════════

import type { CourseAuthoringDb } from './course-blocks.repository.js';
import type { AssetRecord } from './course-authoring.types.js';
import type { ReferencingBlockRow } from './course-storage-paths.logic.js';

/** One row of the asset list, before the outline-reference annotation. */
export interface CourseAssetListRow {
  id: string;
  course_id: string;
  display_name: string;
  content_type: string;
  storage_path: string;
  file_size: number;
  url: string;
  thumbnail_url: string | null;
  is_locked: boolean;
  is_reference: boolean;
  created_at: string;
  date_added: string;
  cursor_created_at: string;
}

/** Every column of course_assets (SELECT * / RETURNING *). */
export interface CourseAssetRow {
  id: string;
  course_id: string;
  tenant_id: string;
  display_name: string;
  content_type: string;
  file_size: string | number;
  storage_path: string;
  url: string;
  thumbnail_url: string | null;
  is_locked: boolean;
  is_reference: boolean;
  uploaded_by: string | null;
  created_at: string;
  [column: string]: unknown;
}

export interface AssetListFilter {
  courseId: string;
  tenantId: string;
  search: string;
}

export interface StoragePathDeleteRow {
  storage_path: string;
  display_name: string | null;
}

/** WHERE conditions and parameters shared by the count and the page of the asset list. */
function assetListConditions(filter: AssetListFilter): { conditions: string[]; params: any[]; paramIdx: number } {
  const conditions: string[] = ['ca.course_id = $1', 'ca.tenant_id = $2'];
  const params: any[] = [filter.courseId, filter.tenantId];
  let paramIdx = 3;
  if (filter.search) {
    conditions.push(`ca.display_name ILIKE '%' || $${paramIdx++} || '%'`);
    params.push(filter.search);
  }
  return { conditions, params, paramIdx };
}

export function createCourseAssetsRepository(db: CourseAuthoringDb) {
  return {
    /** Newest first; after the cursor (created_at, id) when one is given; limit rows. */
    async selectAssetsAfterCursor(
      filter: AssetListFilter,
      cursor: { created_at: string; id: string } | null,
      limit: number,
    ): Promise<CourseAssetListRow[]> {
      const built = assetListConditions(filter);
      const { conditions, params } = built;
      let paramIdx = built.paramIdx;
      if (cursor) {
        conditions.push(`(ca.created_at < $${paramIdx} OR (ca.created_at = $${paramIdx} AND ca.id < $${paramIdx + 1}))`);
        params.push(cursor.created_at, cursor.id);
        paramIdx += 2;
      }

      const whereClause = conditions.join(' AND ');
      params.push(limit);
      const result = await db.query<CourseAssetListRow>(
        `SELECT ca.id, ca.course_id, ca.display_name, ca.content_type,
              ca.storage_path,
              ca.file_size, ca.url, ca.thumbnail_url, ca.is_locked, ca.is_reference,
              ca.created_at, ca.created_at AS date_added,
              to_char(ca.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at
       FROM course_assets ca
       WHERE ${whereClause}
       ORDER BY ca.created_at DESC, ca.id DESC
       LIMIT $${paramIdx}`,
        params,
      );
      return result.rows;
    },

    /** The total of the offset list. */
    async countAssets(filter: AssetListFilter): Promise<string | undefined> {
      const { conditions, params } = assetListConditions(filter);
      const whereClause = conditions.join(' AND ');
      const countResult = await db.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM course_assets ca WHERE ${whereClause}`,
        params,
      );
      return countResult.rows[0]?.count;
    },

    /** Newest first, one offset page. */
    async selectAssetPage(filter: AssetListFilter, pageSize: number, offset: number): Promise<CourseAssetListRow[]> {
      const { conditions, params, paramIdx } = assetListConditions(filter);
      const whereClause = conditions.join(' AND ');
      params.push(pageSize, offset);
      const result = await db.query<CourseAssetListRow>(
        `SELECT ca.id, ca.course_id, ca.display_name, ca.content_type,
            ca.storage_path,
            ca.file_size, ca.url, ca.thumbnail_url, ca.is_locked, ca.is_reference,
            ca.created_at, ca.created_at AS date_added,
              to_char(ca.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at
     FROM course_assets ca
     WHERE ${whereClause}
     ORDER BY ca.created_at DESC, ca.id DESC
     LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
        params,
      );
      return result.rows;
    },

    /** How many active blocks of the course mention each storage path (paths with none are absent). */
    async countOutlineReferences(courseId: string, storagePaths: string[]): Promise<Array<{ storage_path: string; reference_count: string }>> {
      const referenceResult = await db.query<{ storage_path: string; reference_count: string }>(
        `WITH candidate(storage_path) AS (
         SELECT unnest($2::text[])
       )
       SELECT c.storage_path, COUNT(DISTINCT cb.id)::text AS reference_count
       FROM candidate c
       JOIN course_blocks cb ON cb.course_id = $1
        AND cb.deleted_at IS NULL
        AND (
          position(c.storage_path in COALESCE(cb.data::text, '')) > 0 OR
          position(c.storage_path in COALESCE(cb.metadata::text, '')) > 0 OR
          position(c.storage_path in COALESCE(cb.published_data::text, '')) > 0 OR
          position(c.storage_path in COALESCE(cb.published_metadata::text, '')) > 0
        )
       GROUP BY c.storage_path`,
        [courseId, storagePaths],
      );
      return referenceResult.rows;
    },

    /** The asset row, only when the course belongs to the tenant (otherwise nothing is inserted). */
    async insertAssetRecord(
      courseId: string,
      tenantId: string,
      displayName: string,
      contentType: string,
      fileSize: number,
      storagePath: string,
      url: string,
      uploadedBy: string,
    ): Promise<AssetRecord | undefined> {
      // Every parameter is typed: $1 and $2 appear twice, and an untyped SELECT-list
      // parameter is deduced as text while `c.id = $1` deduces varchar, which
      // PostgreSQL refuses ("inconsistent types deduced for parameter $1").
      const result = await db.query<AssetRecord>(
        `INSERT INTO course_assets (course_id, tenant_id, display_name, content_type, file_size, storage_path, url, uploaded_by)
     SELECT $1::varchar, $2::uuid, $3::varchar, $4::varchar, $5::bigint, $6::text, $7::text, $8::uuid
     WHERE EXISTS (SELECT 1 FROM courses c WHERE c.id = $1::varchar AND c.tenant_id = $2::uuid AND c.deleted_at IS NULL)
     RETURNING id, course_id, display_name, content_type, file_size, storage_path, url, thumbnail_url, is_locked, created_at AS date_added`,
        [courseId, tenantId, displayName, contentType, fileSize, storagePath, url, uploadedBy],
      );
      return result.rowCount === 0 ? undefined : result.rows[0];
    },

    /** Active blocks of the course whose draft or published content mentions the path. */
    async selectBlocksReferencingStoragePath(courseId: string, storagePath: string): Promise<ReferencingBlockRow[]> {
      const result = await db.query<ReferencingBlockRow>(
        `SELECT id, data, metadata, published_data, published_metadata
       FROM course_blocks
      WHERE course_id = $1
        AND deleted_at IS NULL
        AND (
          position($2 in COALESCE(data::text, '')) > 0 OR
          position($2 in COALESCE(metadata::text, '')) > 0 OR
          position($2 in COALESCE(published_data::text, '')) > 0 OR
          position($2 in COALESCE(published_metadata::text, '')) > 0
        )`,
        [courseId, storagePath],
      );
      return result.rows;
    },

    /** Writes new JSON values into the given content columns of a block. */
    async updateBlockJsonColumns(blockId: string, updates: Array<{ column: string; value: any }>): Promise<void> {
      const params: any[] = [blockId];
      const setClauses = updates.map((update, index) => {
        params.push(JSON.stringify(update.value));
        return `${update.column} = $${index + 2}::jsonb`;
      });
      setClauses.push('updated_at = now()');

      await db.query(
        `UPDATE course_blocks SET ${setClauses.join(', ')} WHERE id = $1`,
        params,
      );
    },

    /** The published content of every subtree block a publish would change. */
    async selectPublishedContentOfChangedSubtree(blockId: string): Promise<Array<{ published_data: any; published_metadata: any }>> {
      const result = await db.query<{ published_data: any; published_metadata: any }>(
        `WITH RECURSIVE descendants AS (
       SELECT id FROM course_blocks WHERE id = $1 AND deleted_at IS NULL
       UNION ALL
       SELECT cb.id FROM course_blocks cb
       JOIN descendants d ON cb.parent_id = d.id
       WHERE cb.deleted_at IS NULL
     )
     SELECT published_data, published_metadata
     FROM course_blocks
     WHERE id IN (SELECT id FROM descendants)
       AND (
         has_draft_changes = true OR
         data IS DISTINCT FROM published_data OR
         metadata IS DISTINCT FROM published_metadata OR
         is_published = false
       )`,
        [blockId],
      );
      return result.rows;
    },

    /** The draft content of every subtree block a discard would change. */
    async selectDraftContentOfChangedSubtree(blockId: string): Promise<Array<{ data: any; metadata: any }>> {
      const result = await db.query<{ data: any; metadata: any }>(
        `WITH RECURSIVE descendants AS (
       SELECT id FROM course_blocks WHERE id = $1 AND deleted_at IS NULL
       UNION ALL
       SELECT cb.id FROM course_blocks cb
       JOIN descendants d ON cb.parent_id = d.id
       WHERE cb.deleted_at IS NULL
     )
     SELECT data, metadata
     FROM course_blocks
     WHERE id IN (SELECT id FROM descendants)
       AND (
         has_draft_changes = true OR
         data IS DISTINCT FROM published_data OR
         metadata IS DISTINCT FROM published_metadata
       )`,
        [blockId],
      );
      return result.rows;
    },

    /** Deletes the course's non-reference asset rows of these paths; the deleted storage paths. */
    async deleteNonReferenceAssetsByPaths(courseId: string, storagePaths: string[]): Promise<Array<{ storage_path: string }>> {
      const result = await db.query<{ storage_path: string }>(
        `DELETE FROM course_assets
      WHERE course_id = $1
        AND COALESCE(is_reference, false) = false
        AND (storage_path = ANY($2::text[]) OR url = ANY($2::text[]))
      RETURNING storage_path`,
        [courseId, storagePaths],
      );
      return result.rows;
    },

    /** Which of these paths (at most 100) an active block of the course still mentions. */
    async selectReferencedStoragePaths(courseId: string, storagePaths: string[]): Promise<Array<{ storage_path: string }>> {
      const result = await db.query<{ storage_path: string }>(
        `WITH candidate(storage_path) AS (
         SELECT unnest($2::text[])
       )
       SELECT DISTINCT c.storage_path
       FROM course_blocks cb
       JOIN candidate c ON (
         position(c.storage_path in COALESCE(cb.data::text, '')) > 0 OR
         position(c.storage_path in COALESCE(cb.metadata::text, '')) > 0 OR
         position(c.storage_path in COALESCE(cb.published_data::text, '')) > 0 OR
         position(c.storage_path in COALESCE(cb.published_metadata::text, '')) > 0
       )
       WHERE cb.course_id = $1
         AND cb.deleted_at IS NULL`,
        [courseId, storagePaths],
      );
      return result.rows;
    },

    async selectAsset(assetId: string, courseId: string, tenantId: string): Promise<CourseAssetRow | undefined> {
      const assetResult = await db.query<CourseAssetRow>(
        `SELECT * FROM course_assets WHERE id = $1 AND course_id = $2 AND tenant_id = $3`,
        [assetId, courseId, tenantId],
      );
      return assetResult.rows[0];
    },

    async deleteAsset(assetId: string, courseId: string, tenantId: string): Promise<CourseAssetRow | undefined> {
      const deleted = await db.query<CourseAssetRow>(
        `DELETE FROM course_assets WHERE id = $1 AND course_id = $2 AND tenant_id = $3 RETURNING *`,
        [assetId, courseId, tenantId],
      );
      return deleted.rows[0];
    },

    /** Deletes the tenant course's asset rows of this storage path or URL. */
    async deleteAssetsByStoragePath(courseId: string, tenantId: string, storagePath: string): Promise<StoragePathDeleteRow[]> {
      const result = await db.query<StoragePathDeleteRow>(
        `DELETE FROM course_assets
     WHERE course_id = $1
       AND tenant_id = $2
       AND (storage_path = $3 OR url = $3)
     RETURNING storage_path, display_name`,
        [courseId, tenantId, storagePath],
      );
      return result.rows;
    },

    async updateAssetReference(courseId: string, assetIds: string[], isReference: boolean, tenantId: string): Promise<void> {
      await db.query(
        `UPDATE course_assets SET is_reference = $3
     WHERE course_id = $1 AND tenant_id = $4 AND id = ANY($2)`,
        [courseId, assetIds, isReference, tenantId],
      );
    },

    /** The tenant course's assets of these storage paths, with their content type. */
    async selectAssetsByStoragePaths(
      courseId: string,
      tenantId: string,
      storagePaths: string[],
    ): Promise<Array<{ storage_path: string; content_type: string }>> {
      const result = await db.query<{ storage_path: string; content_type: string }>(
        `SELECT storage_path, content_type
     FROM course_assets
     WHERE course_id = $1
       AND tenant_id = $2
       AND storage_path = ANY($3::text[])`,
        [courseId, tenantId, storagePaths],
      );
      return result.rows;
    },
  };
}

export type CourseAssetsRepository = ReturnType<typeof createCourseAssetsRepository>;
