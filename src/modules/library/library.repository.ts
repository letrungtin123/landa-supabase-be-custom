// ═══════════════════════════════════════════════════════════════
// Library repository: document categories (with their team assignments
// and public impact) and documents. SQL only; moved unchanged from
// library.service.ts, which keeps the rules (tenant checks and their
// messages, slugs, public categories, transactions, audit, caches).
// ═══════════════════════════════════════════════════════════════

import type { QueryResult, QueryResultRow } from 'pg';

/** The pool query() (joins the current transaction) or a transaction client. */
export interface LibraryDb {
  query<T extends QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface DocumentCategoryRow {
  id: string;
  tenant_id: string;
  name: string;
  is_public: boolean;
}

/** A whole category row (`dc.*`) with its document count and, on request, its team assignment. */
export interface DocumentCategoryListRow extends DocumentCategoryRow {
  doc_count: string;
  is_assigned_to_team?: boolean;
  [column: string]: unknown;
}

export interface UpdatedDocumentCategoryRow extends DocumentCategoryRow {
  slug: string;
  sort_order: number;
}

/** Timestamps are typed as the answer types them: pg's Date reaches the client as ISO text. */
export interface DocumentCategoryPublicImpactRow {
  group_id: string;
  group_name: string;
  subgroup_id: string;
  subgroup_name: string;
  team_id: string;
  team_name: string;
  assigned_at: string | null;
}

export interface DocumentSnapshotRow {
  id: string;
  title: string;
  file_size: number;
  category_id: string | null;
  is_visible: boolean;
  is_public: boolean;
}

export interface DocumentRow extends DocumentSnapshotRow {
  file_url: string;
  extension: string;
}

export interface DocumentListRow extends DocumentRow {
  created_at: string;
  category_name: string | null;
  uploaded_by_name: string | null;
}

export interface LibraryListFilter {
  tenantId: string | null;
  search: string | undefined;
}

export interface DocumentListFilter extends LibraryListFilter {
  categoryId: string;
  extension: string;
}

export interface DocumentInsertValues {
  tenantId: string;
  title: string;
  fileUrl: string;
  fileSize: number;
  extension: string;
  categoryId: string | null;
  isVisible: boolean;
  isPublic: boolean;
  uploadedBy: string;
}

export interface DocumentUpdateValues {
  title: string | undefined;
  isVisible: boolean | undefined;
  isPublic: boolean;
  categoryId: string | null;
}

function categoryListWhere(filter: LibraryListFilter): { where: string; params: unknown[] } {
  const params: unknown[] = [];
  const conditions: string[] = [];

  if (filter.tenantId) { params.push(filter.tenantId); conditions.push(`dc.tenant_id = $${params.length}`); }
  if (filter.search) { params.push(`%${filter.search}%`); conditions.push(`unaccent(dc.name) ILIKE unaccent($${params.length})`); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return { where, params };
}

function documentListWhere(filter: DocumentListFilter): { where: string; params: unknown[] } {
  const params: unknown[] = [];
  const conditions: string[] = [];

  if (filter.tenantId) { params.push(filter.tenantId); conditions.push(`d.tenant_id = $${params.length}`); }
  if (filter.search) { params.push(`%${filter.search}%`); conditions.push(`unaccent(d.title) ILIKE unaccent($${params.length})`); }
  const catFilter = filter.categoryId;
  if (catFilter) { params.push(catFilter); conditions.push(`d.category_id = $${params.length}`); }
  const extFilter = filter.extension;
  if (extFilter) { params.push(extFilter); conditions.push(`d.extension = $${params.length}`); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return { where, params };
}

export function createLibraryRepository(db: LibraryDb) {
  return {
    // ── Document categories ──

    async selectCategoryTenantIds(categoryIds: readonly string[]): Promise<string[]> {
      const result = await db.query<{ tenant_id: string }>(
        'SELECT DISTINCT tenant_id FROM document_categories WHERE id = ANY($1)',
        [categoryIds],
      );
      return result.rows.map((row) => row.tenant_id);
    },

    /** True when the category exists in the tenant. */
    async categoryInTenant(categoryId: string, tenantId: string): Promise<boolean> {
      const result = await db.query<{ id: string }>(
        'SELECT id FROM document_categories WHERE id = $1::uuid AND tenant_id = $2::uuid LIMIT 1',
        [categoryId, tenantId],
      );
      return result.rowCount !== 0;
    },

    /** The category, in the tenant when one is given; null when there is none. */
    async selectCategory(catId: string, tenantId?: string | null): Promise<DocumentCategoryRow | null> {
      const params: unknown[] = [catId];
      const tenantClause = tenantId ? 'AND tenant_id = $2::uuid' : '';
      if (tenantId) params.push(tenantId);
      const result = await db.query<DocumentCategoryRow>(
        `SELECT id, tenant_id, name, COALESCE(is_public, false) AS is_public
     FROM document_categories
     WHERE id = $1::uuid ${tenantClause}
     LIMIT 1`,
        params,
      );
      return result.rows[0] ?? null;
    },

    /** Number of teams of the tenant the category is assigned to (as the driver sends it). */
    async countCategoryTeams(catId: string, tenantId: string): Promise<{ count: string } | undefined> {
      const countR = await db.query<{ count: string }>(
        `SELECT COUNT(DISTINCT tdc.team_id)::int AS count
       FROM team_doc_categories tdc
       JOIN teams t ON t.id = tdc.team_id
       JOIN sub_groups sg ON sg.id = t.sub_group_id
       JOIN org_groups og ON og.id = sg.org_group_id
       WHERE tdc.category_id = $1::uuid
         AND og.tenant_id = $2::uuid`,
        [catId, tenantId],
      );
      return countR.rows[0];
    },

    /** The first `limit` team assignments of the category in the tenant, by group, subgroup and team name. */
    async selectCategoryTeams(catId: string, tenantId: string, limit: number): Promise<DocumentCategoryPublicImpactRow[]> {
      const dataR = await db.query<DocumentCategoryPublicImpactRow>(
        `SELECT og.id AS group_id,
              og.name AS group_name,
              sg.id AS subgroup_id,
              sg.name AS subgroup_name,
              t.id AS team_id,
              t.name AS team_name,
              tdc.assigned_at
       FROM team_doc_categories tdc
       JOIN teams t ON t.id = tdc.team_id
       JOIN sub_groups sg ON sg.id = t.sub_group_id
       JOIN org_groups og ON og.id = sg.org_group_id
       WHERE tdc.category_id = $1::uuid
         AND og.tenant_id = $2::uuid
       ORDER BY og.name, sg.name, t.name
       LIMIT $3`,
        [catId, tenantId, limit],
      );
      return dataR.rows;
    },

    /** COUNT(*) of the category list, as text (always one row). */
    async countCategories(filter: LibraryListFilter): Promise<{ count: string }> {
      const { where, params } = categoryListWhere(filter);
      const countR = await db.query<{ count: string }>(`SELECT COUNT(*) AS count FROM document_categories dc ${where}`, params);
      return countR.rows[0];
    },

    /** One page of categories with their document count; with `assignedTeamId`, whether that team has each one. */
    async selectCategoryPage(filter: LibraryListFilter, assignedTeamId: string | null, pageSize: number, offset: number): Promise<DocumentCategoryListRow[]> {
      const { where, params } = categoryListWhere(filter);
      const dataParams = [...params];
      let assignedSelect = '';
      if (assignedTeamId) {
        dataParams.push(assignedTeamId);
        const teamParam = dataParams.length;
        assignedSelect = `,
            EXISTS (
              SELECT 1
              FROM team_doc_categories tdc
              JOIN teams t_assign ON t_assign.id = tdc.team_id
              JOIN sub_groups sg_assign ON sg_assign.id = t_assign.sub_group_id
              JOIN org_groups og_assign ON og_assign.id = sg_assign.org_group_id
              WHERE tdc.category_id = dc.id
                AND tdc.team_id = $${teamParam}::uuid
                ${filter.tenantId ? 'AND og_assign.tenant_id = $1::uuid' : ''}
            ) AS is_assigned_to_team`;
      }

      const dataR = await db.query<DocumentCategoryListRow>(
        `SELECT dc.*, COALESCE(dc.is_public, false) AS is_public, (SELECT COUNT(*) FROM documents d WHERE d.category_id = dc.id) AS doc_count${assignedSelect}
       FROM document_categories dc ${where}
       ORDER BY dc.sort_order, dc.name
       LIMIT $${dataParams.length + 1} OFFSET $${dataParams.length + 2}`,
        [...dataParams, pageSize, offset],
      );
      return dataR.rows;
    },

    async insertCategory(tenantId: string, name: string, slug: string): Promise<{ id: string; name: string; slug: string; is_public: boolean }> {
      const result = await db.query<{ id: string; name: string; slug: string; is_public: boolean }>(
        `INSERT INTO document_categories (tenant_id, name, slug, is_public) VALUES ($1, $2, $3, false)
     RETURNING id, name, slug, is_public`,
        [tenantId, name, slug],
      );
      return result.rows[0];
    },

    /** Locks the category of the tenant for the rest of the transaction; null when not in the tenant. */
    async lockCategory(catId: string, tenantId: string): Promise<DocumentCategoryRow | null> {
      const current = await db.query<DocumentCategoryRow>(
        `SELECT id, tenant_id, name, COALESCE(is_public, false) AS is_public
       FROM document_categories
       WHERE id = $1::uuid AND tenant_id = $2::uuid
       FOR UPDATE`,
        [catId, tenantId],
      );
      return current.rowCount === 0 ? null : current.rows[0];
    },

    /** Removes the category from every team of the tenant; answers how many assignments went. */
    async deleteCategoryTeamAssignments(catId: string, tenantId: string): Promise<number> {
      const removed = await db.query(
        `DELETE FROM team_doc_categories tdc
         USING teams t
         JOIN sub_groups sg ON sg.id = t.sub_group_id
         JOIN org_groups og ON og.id = sg.org_group_id
         WHERE tdc.team_id = t.id
           AND tdc.category_id = $1::uuid
           AND og.tenant_id = $2::uuid`,
        [catId, tenantId],
      );
      return removed.rowCount || 0;
    },

    /** Sets name and slug (given together) and is_public, those given; at least one must be. */
    async updateCategoryFields(catId: string, tenantId: string, input: { name?: string; slug?: string; is_public?: boolean }): Promise<UpdatedDocumentCategoryRow | undefined> {
      const sets: string[] = [];
      const params: unknown[] = [];
      let idx = 1;
      if (input.name !== undefined) {
        sets.push(`name = $${idx++}`); params.push(input.name);
        sets.push(`slug = $${idx++}`); params.push(input.slug);
      }
      if (input.is_public !== undefined) { sets.push(`is_public = $${idx++}`); params.push(input.is_public); }

      params.push(catId, tenantId);
      const result = await db.query<UpdatedDocumentCategoryRow>(
        `UPDATE document_categories
       SET ${sets.join(', ')}
       WHERE id = $${idx++}::uuid AND tenant_id = $${idx}::uuid
       RETURNING id, name, slug, tenant_id, sort_order, is_public`,
        params,
      );
      return result.rows[0];
    },

    async deleteCategory(catId: string, tenantId: string): Promise<{ id: string; name: string } | null> {
      const result = await db.query<{ id: string; name: string }>(
        'DELETE FROM document_categories WHERE id = $1::uuid AND tenant_id = $2::uuid RETURNING id, name',
        [catId, tenantId],
      );
      return result.rowCount === 0 ? null : result.rows[0];
    },

    /** Deletes the tenant's categories among `ids`; answers how many went. */
    async deleteCategories(tenantId: string, ids: string[]): Promise<number> {
      const result = await db.query(
        'DELETE FROM document_categories WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[]) RETURNING id',
        [tenantId, ids],
      );
      return result.rowCount || 0;
    },

    /** The category's name in the tenant (update of one document). */
    async selectCategoryName(categoryId: string, tenantId: string): Promise<{ name: string } | undefined> {
      const nextCategory = await db.query<{ name: string }>(
        'SELECT name FROM document_categories WHERE id = $1::uuid AND tenant_id = $2::uuid',
        [categoryId, tenantId],
      );
      return nextCategory.rows[0];
    },

    /** The category's name in the tenant (bulk move); null when not in the tenant. */
    async selectCategoryNameForBulk(categoryId: string, tenantId: string): Promise<{ name: string } | null> {
      const category = await db.query<{ name: string }>(
        'SELECT name FROM document_categories WHERE id = $1::uuid AND tenant_id = $2::uuid LIMIT 1',
        [categoryId, tenantId],
      );
      return category.rowCount === 0 ? null : category.rows[0];
    },

    // ── Documents ──

    /** COUNT(*) of the document list, as text (always one row). */
    async countDocuments(filter: DocumentListFilter): Promise<{ count: string }> {
      const { where, params } = documentListWhere(filter);
      const countR = await db.query<{ count: string }>(`SELECT COUNT(*) AS count FROM documents d ${where}`, params);
      return countR.rows[0];
    },

    /** One page of documents, newest first, with category and uploader names. */
    async selectDocumentPage(filter: DocumentListFilter, pageSize: number, offset: number): Promise<DocumentListRow[]> {
      const { where, params } = documentListWhere(filter);
      const dataR = await db.query<DocumentListRow>(
        `SELECT d.id, d.title, d.file_url, d.file_size, d.extension, d.category_id,
              d.is_visible, COALESCE(dc.is_public, false) AS is_public, d.created_at,
              dc.name AS category_name,
              u.username AS uploaded_by_name
       FROM documents d
       LEFT JOIN document_categories dc ON dc.id = d.category_id AND dc.tenant_id = d.tenant_id
       LEFT JOIN users u ON u.id = d.uploaded_by
       ${where}
       ORDER BY d.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, pageSize, offset],
      );
      return dataR.rows;
    },

    async insertDocument(values: DocumentInsertValues): Promise<DocumentRow | undefined> {
      const result = await db.query<DocumentRow>(
        `INSERT INTO documents (tenant_id, title, file_url, file_size, extension, category_id, is_visible, is_public, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, title, file_url, file_size, extension, category_id, is_visible, is_public`,
        [values.tenantId, values.title, values.fileUrl, values.fileSize, values.extension, values.categoryId, values.isVisible, values.isPublic, values.uploadedBy],
      );
      return result.rows[0];
    },

    /** Locks the document of the tenant for the rest of the transaction. */
    async lockDocument(docId: string, tenantId: string): Promise<DocumentSnapshotRow | undefined> {
      const currentResult = await db.query<DocumentSnapshotRow>(
        `SELECT id, title, file_size, category_id, is_visible, COALESCE(is_public, false) AS is_public
       FROM documents
       WHERE id = $1::uuid AND tenant_id = $2::uuid
       FOR UPDATE`,
        [docId, tenantId],
      );
      return currentResult.rows[0];
    },

    async updateDocument(docId: string, tenantId: string, values: DocumentUpdateValues): Promise<DocumentRow | undefined> {
      const result = await db.query<DocumentRow>(
        `UPDATE documents
       SET title = $3,
           is_visible = $4,
           is_public = $5,
           category_id = $6
       WHERE id = $1::uuid AND tenant_id = $2::uuid
       RETURNING id, title, file_url, file_size, extension, category_id, is_visible, is_public`,
        [docId, tenantId, values.title, values.isVisible, values.isPublic, values.categoryId],
      );
      return result.rows[0];
    },

    async deleteDocument(docId: string, tenantId: string): Promise<{ id: string; title: string; file_url: string; file_size: number } | null> {
      const result = await db.query<{ id: string; title: string; file_url: string; file_size: number }>(
        'DELETE FROM documents WHERE id = $1::uuid AND tenant_id = $2::uuid RETURNING id, title, file_url, file_size',
        [docId, tenantId],
      );
      return result.rowCount === 0 ? null : result.rows[0];
    },

    /** Deletes the tenant's documents among `ids`; answers the deleted rows and their count. */
    async deleteDocuments(tenantId: string, ids: string[]): Promise<{ rows: Array<{ id: string; title: string; file_url: string | null }>; rowCount: number }> {
      const result = await db.query<{ id: string; title: string; file_url: string | null }>(
        'DELETE FROM documents WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[]) RETURNING id, title, file_url',
        [tenantId, ids],
      );
      return { rows: result.rows, rowCount: result.rowCount || 0 };
    },

    /** Makes the tenant's documents among `ids` visible; answers how many changed. */
    async showDocuments(tenantId: string, ids: string[]): Promise<number> {
      const r = await db.query('UPDATE documents SET is_visible = true WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[])', [tenantId, ids]);
      return r.rowCount || 0;
    },

    /** Hides (and so makes private) the tenant's documents among `ids`; answers how many changed. */
    async hideDocuments(tenantId: string, ids: string[]): Promise<number> {
      const r = await db.query('UPDATE documents SET is_visible = false, is_public = false WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[])', [tenantId, ids]);
      return r.rowCount || 0;
    },

    async clearDocumentsCategory(tenantId: string, ids: string[]): Promise<number> {
      const r = await db.query('UPDATE documents SET category_id = NULL WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[])', [tenantId, ids]);
      return r.rowCount || 0;
    },

    async setDocumentsCategory(tenantId: string, ids: string[], categoryId: string): Promise<number> {
      const r = await db.query(
        'UPDATE documents SET category_id = $3::uuid WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[])',
        [tenantId, ids, categoryId],
      );
      return r.rowCount || 0;
    },
  };
}
