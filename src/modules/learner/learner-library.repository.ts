// ═══════════════════════════════════════════════════════════════
// Learner library repository: the document categories and documents of the
// tenant's library a user may see. SQL only; moved unchanged from
// learner.service.ts, which keeps the role rule, caching and the mapping.
// ═══════════════════════════════════════════════════════════════

import type { LearnerDb } from './learner-courses.repository.js';

export interface LibraryCategoryRow {
  id: string;
  name: string;
  slug: string | null;
  sort_order: number | null;
  count: number;
}

export interface LibraryDocumentRow {
  id: string;
  title: string;
  extension: string | null;
  file_size: string | null;
  file_url: string | null;
  category_id: string | null;
  created_at: string;
  is_visible: boolean;
  is_public: boolean;
  category_name: string | null;
  category_slug: string | null;
  uploaded_by_name: string | null;
}

/** The documents a user may list; `learnerUserId` limits them to visible documents of the learner's categories. */
export interface LibraryDocumentFilter {
  tenantId: string;
  learnerUserId?: string;
  category?: string;
  extension?: string;
  search?: string;
}

function documentFilter(filter: LibraryDocumentFilter): { where: string; sqlParams: unknown[] } {
  const { learnerUserId, category, extension, search } = filter;
  const sqlParams: unknown[] = [filter.tenantId];
  const conditions: string[] = ['d.tenant_id = $1::uuid'];

  if (learnerUserId !== undefined) {
    sqlParams.push(learnerUserId);
    conditions.push(`d.is_visible = true AND d.category_id IS NOT NULL AND (
      COALESCE(dc.is_public, false) = true
      OR EXISTS (
        SELECT 1
        FROM team_doc_categories tdc
        JOIN team_members tm ON tm.team_id = tdc.team_id
        WHERE tm.user_id = $${sqlParams.length}::uuid
          AND tdc.category_id = d.category_id
      )
    )`);
  }

  if (category) {
    sqlParams.push(category);
    conditions.push(`(dc.slug = $${sqlParams.length} OR dc.id::text = $${sqlParams.length})`);
  }
  if (extension) {
    sqlParams.push(extension);
    conditions.push(`d.extension = $${sqlParams.length}`);
  }
  if (search) {
    sqlParams.push(`%${search}%`);
    conditions.push(`unaccent(d.title) ILIKE unaccent($${sqlParams.length})`);
  }

  return { where: conditions.join(' AND '), sqlParams };
}

/** ORDER BY of a document list: one of a fixed set, newest first otherwise. */
function documentOrder(ordering: string | undefined): string {
  let orderBy = 'd.created_at DESC';
  if (ordering === 'title') orderBy = 'd.title ASC';
  else if (ordering === '-title') orderBy = 'd.title DESC';
  else if (ordering === 'created_at') orderBy = 'd.created_at ASC';
  else if (ordering === 'file_size') orderBy = 'd.file_size DESC';
  return orderBy;
}

export function createLearnerLibraryRepository(db: LearnerDb) {
  return {
    /**
     * The tenant's document categories with their document count; with
     * `learnerUserId`, only public ones and those of the learner's teams
     * (counting visible documents only).
     */
    async selectCategories(tenantId: string, learnerUserId?: string): Promise<{ rows: LibraryCategoryRow[]; rowCount: number | null }> {
      const learner = learnerUserId !== undefined;
      const sql = learner
        ? `SELECT dc.id::text AS id,
              dc.name,
              dc.slug,
              dc.sort_order,
              COUNT(DISTINCT d.id) FILTER (WHERE d.is_visible = true)::int AS count
       FROM document_categories dc
       LEFT JOIN documents d
         ON d.category_id = dc.id
        AND d.tenant_id = $1::uuid
       WHERE dc.tenant_id = $1::uuid
         AND (
           COALESCE(dc.is_public, false) = true
           OR EXISTS (
             SELECT 1
             FROM team_doc_categories tdc
             JOIN team_members tm ON tm.team_id = tdc.team_id
             WHERE tdc.category_id = dc.id
               AND tm.user_id = $2::uuid
           )
         )
       GROUP BY dc.id
       ORDER BY dc.sort_order, dc.name`
        : `SELECT dc.id::text AS id,
              dc.name,
              dc.slug,
              dc.sort_order,
              COUNT(d.id)::int AS count
       FROM document_categories dc
       LEFT JOIN documents d
         ON d.category_id = dc.id
        AND d.tenant_id = $1::uuid
       WHERE dc.tenant_id = $1::uuid
       GROUP BY dc.id
       ORDER BY dc.sort_order, dc.name`;

      const result = await db.query<LibraryCategoryRow>(sql, learner ? [tenantId, learnerUserId] : [tenantId]);
      return { rows: result.rows, rowCount: result.rowCount };
    },

    async countDocuments(filter: LibraryDocumentFilter): Promise<number> {
      const { where, sqlParams } = documentFilter(filter);
      const countResult = await db.query<{ count: string }>(
        `SELECT COUNT(*) AS count
     FROM documents d
     LEFT JOIN document_categories dc ON dc.id = d.category_id
     WHERE ${where}`,
        sqlParams,
      );
      return parseInt(countResult.rows[0]?.count || '0', 10);
    },

    /** One page of the documents, in the requested order. */
    async selectDocuments(
      filter: LibraryDocumentFilter,
      page: { ordering?: string; limit: number; offset: number },
    ): Promise<LibraryDocumentRow[]> {
      const { where, sqlParams } = documentFilter(filter);
      const orderBy = documentOrder(page.ordering);
      sqlParams.push(page.limit, page.offset);
      const result = await db.query<LibraryDocumentRow>(
        `SELECT d.id,
            d.title,
            d.extension,
            d.file_size,
            d.file_url,
            d.category_id,
            d.created_at,
            d.is_visible,
            COALESCE(dc.is_public, false) AS is_public,
            dc.name AS category_name,
            dc.slug AS category_slug,
            u.full_name AS uploaded_by_name
     FROM documents d
     LEFT JOIN document_categories dc ON dc.id = d.category_id
     LEFT JOIN users u ON u.id = d.uploaded_by
     WHERE ${where}
     ORDER BY ${orderBy}
     LIMIT $${sqlParams.length - 1} OFFSET $${sqlParams.length}`,
        sqlParams,
      );
      return result.rows;
    },
  };
}

export type LearnerLibraryRepository = ReturnType<typeof createLearnerLibraryRepository>;
