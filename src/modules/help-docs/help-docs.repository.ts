// ═══════════════════════════════════════════════════════════════
// Help docs repository: folders and pages of a tenant's help center. SQL
// only, moved unchanged from help-docs.service.ts, which keeps the rules
// (slugs, image path checks, which images to delete, messages).
// ═══════════════════════════════════════════════════════════════

import type { QueryResult, QueryResultRow } from 'pg';

/** The pool query() (joins the current transaction) or a transaction client. */
export interface HelpDocsDb {
  query<T extends QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

/** A whole folder row (`hf.*`) with its page count. */
export interface HelpFolderListRow {
  id: string;
  title: string;
  page_count: string;
  [column: string]: unknown;
}

export interface HelpPageListRow {
  id: string;
  folder_id: string;
  folder_title: string;
  title: string;
  slug: string;
  sort_order: number;
  is_published: boolean;
  created_at: string;
  updated_at: string;
}

/** A whole page row (`hp.*`) with its folder title and author usernames. */
export interface HelpPageDetailRow {
  id: string;
  folder_title: string;
  content: string | null;
  created_by: string | null;
  updated_by: string | null;
  [column: string]: unknown;
}

export interface HelpPageLockedRow {
  id: string;
  title: string;
  content: string | null;
  is_published: boolean;
}

/** SET assignments: always `updated_at`, then the given columns in order (values from $firstIndex). */
function assignments(fixed: string[], columns: Array<[string, unknown]>, firstIndex: number) {
  const sets = [...fixed];
  const params: unknown[] = [];
  let idx = firstIndex;
  for (const [column, value] of columns) {
    sets.push(`${column} = $${idx++}`);
    params.push(value);
  }
  return { sets, params, nextIndex: idx };
}

export function createHelpDocsRepository(db: HelpDocsDb) {
  return {
    // ── Folders ──

    async selectFolders(tenantId: string): Promise<QueryResult<HelpFolderListRow>> {
      return db.query<HelpFolderListRow>(
        `SELECT hf.*, (SELECT COUNT(*) FROM help_pages hp WHERE hp.folder_id = hf.id) AS page_count
         FROM help_folders hf
         WHERE hf.tenant_id = $1
         ORDER BY hf.sort_order, hf.title`,
        [tenantId],
      );
    },

    async insertFolder(tenantId: string, title: string, slug: string, icon: string): Promise<{ id: string; slug: string }> {
      const result = await db.query<{ id: string; slug: string }>(
        'INSERT INTO help_folders (tenant_id, title, slug, icon) VALUES ($1, $2, $3, $4) RETURNING id, slug',
        [tenantId, title, slug, icon],
      );
      return result.rows[0];
    },

    async lockFolder(folderId: string, tenantId: string): Promise<QueryResult<{ id: string; title: string }>> {
      return db.query<{ id: string; title: string }>(
        `SELECT id, title FROM help_folders WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [folderId, tenantId],
      );
    },

    /** Sets updated_at and the given columns, in order. */
    async updateFolder(folderId: string, tenantId: string, columns: Array<[string, unknown]>): Promise<QueryResult<{ id: string; title: string }>> {
      const { sets, params, nextIndex } = assignments(['updated_at = NOW()'], columns, 1);
      return db.query<{ id: string; title: string }>(
        `UPDATE help_folders SET ${sets.join(', ')} WHERE id = $${nextIndex} AND tenant_id = $${nextIndex + 1} RETURNING id, title`,
        [...params, folderId, tenantId],
      );
    },

    async selectFolder(folderId: string, tenantId: string): Promise<QueryResult<{ id: string; title: string }>> {
      return db.query<{ id: string; title: string }>('SELECT id, title FROM help_folders WHERE id = $1 AND tenant_id = $2', [folderId, tenantId]);
    },

    async folderExists(folderId: string, tenantId: string): Promise<boolean> {
      const result = await db.query<{ id: string }>('SELECT id FROM help_folders WHERE id = $1 AND tenant_id = $2', [folderId, tenantId]);
      return result.rowCount !== 0;
    },

    async deleteFolder(folderId: string, tenantId: string): Promise<void> {
      await db.query('DELETE FROM help_folders WHERE id = $1 AND tenant_id = $2', [folderId, tenantId]);
    },

    async countTenantFolders(tenantId: string, folderIds: string[]): Promise<string | number | undefined> {
      const result = await db.query<{ count: string }>(
        'SELECT COUNT(*)::int AS count FROM help_folders WHERE tenant_id = $1 AND id = ANY($2::uuid[])',
        [tenantId, folderIds],
      );
      return result.rows[0]?.count;
    },

    /** sort_order = position in `orderedIds` (from 0). */
    async reorderFolders(tenantId: string, orderedIds: string[]): Promise<void> {
      await db.query(
        `UPDATE help_folders hf
         SET sort_order = (ordered.sort_order - 1)::int, updated_at = NOW()
         FROM unnest($2::uuid[]) WITH ORDINALITY AS ordered(id, sort_order)
         WHERE hf.id = ordered.id
           AND hf.tenant_id = $1`,
        [tenantId, orderedIds],
      );
    },

    // ── Pages ──

    /** Content of every page of the tenant (to find images still in use). */
    async selectTenantPageContents(tenantId: string): Promise<{ content: string | null }[]> {
      const result = await db.query<{ content: string | null }>(
        `SELECT hp.content
         FROM help_pages hp
         JOIN help_folders hf ON hf.id = hp.folder_id
         WHERE hf.tenant_id = $1`,
        [tenantId],
      );
      return result.rows;
    },

    async selectFolderPageContents(folderId: string): Promise<{ content: string | null }[]> {
      const result = await db.query<{ content: string | null }>('SELECT content FROM help_pages WHERE folder_id = $1', [folderId]);
      return result.rows;
    },

    async selectPages(tenantId: string, folderId: string | undefined): Promise<QueryResult<HelpPageListRow>> {
      const params: unknown[] = [tenantId];
      const conditions = ['hf.tenant_id = $1'];
      if (folderId) { params.push(folderId); conditions.push(`hp.folder_id = $${params.length}`); }
      return db.query<HelpPageListRow>(
        `SELECT hp.id, hp.folder_id, hf.title AS folder_title, hp.title, hp.slug,
                hp.sort_order, hp.is_published, hp.created_at, hp.updated_at
         FROM help_pages hp
         JOIN help_folders hf ON hf.id = hp.folder_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY hp.sort_order, hp.title`,
        params,
      );
    },

    async selectPage(pageId: string, tenantId: string): Promise<QueryResult<HelpPageDetailRow>> {
      return db.query<HelpPageDetailRow>(
        `SELECT hp.*, hf.title AS folder_title,
                cu.username AS created_by, uu.username AS updated_by
         FROM help_pages hp
         JOIN help_folders hf ON hf.id = hp.folder_id
         LEFT JOIN users cu ON cu.id = hp.created_by
         LEFT JOIN users uu ON uu.id = hp.updated_by
         WHERE hp.id = $1
           AND hf.tenant_id = $2`,
        [pageId, tenantId],
      );
    },

    /** Inserts the page only when the folder belongs to the tenant. */
    async insertPage(values: {
      tenantId: string;
      folderId: string;
      title: string;
      slug: string;
      content: string;
      userId: string;
    }): Promise<QueryResult<{ id: string; slug: string }>> {
      return db.query<{ id: string; slug: string }>(
        `INSERT INTO help_pages (folder_id, title, slug, content, created_by, updated_by)
         SELECT hf.id, $3, $4, $5, $6, $6
         FROM help_folders hf
         WHERE hf.id = $2
           AND hf.tenant_id = $1
         RETURNING id, slug`,
        [values.tenantId, values.folderId, values.title, values.slug, values.content, values.userId],
      );
    },

    async lockPage(pageId: string, tenantId: string): Promise<QueryResult<HelpPageLockedRow>> {
      return db.query<HelpPageLockedRow>(
        `SELECT hp.id, hp.title, hp.content, hp.is_published
         FROM help_pages hp
         JOIN help_folders hf ON hf.id = hp.folder_id
         WHERE hp.id = $1 AND hf.tenant_id = $2
         FOR UPDATE OF hp`,
        [pageId, tenantId],
      );
    },

    /** Sets updated_at, updated_by and the given columns, in order. */
    async updatePage(
      pageId: string,
      tenantId: string,
      userId: string,
      columns: Array<[string, unknown]>,
    ): Promise<QueryResult<{ id: string; title: string }>> {
      const { sets, params, nextIndex } = assignments(['updated_at = NOW()', 'updated_by = $1'], columns, 2);
      return db.query<{ id: string; title: string }>(
        `UPDATE help_pages hp
         SET ${sets.join(', ')}
         FROM help_folders hf
         WHERE hp.folder_id = hf.id
           AND hp.id = $${nextIndex}
           AND hf.tenant_id = $${nextIndex + 1}
         RETURNING hp.id, hp.title`,
        [userId, ...params, pageId, tenantId],
      );
    },

    async deletePage(pageId: string, tenantId: string): Promise<QueryResult<{ id: string; title: string; content: string | null }>> {
      return db.query<{ id: string; title: string; content: string | null }>(
        `DELETE FROM help_pages hp
         USING help_folders hf
         WHERE hp.folder_id = hf.id
           AND hp.id = $1
           AND hf.tenant_id = $2
         RETURNING hp.id, hp.title, hp.content`,
        [pageId, tenantId],
      );
    },

    async countFolderPages(folderId: string, pageIds: string[]): Promise<string | number | undefined> {
      const result = await db.query<{ count: string }>(
        'SELECT COUNT(*)::int AS count FROM help_pages WHERE folder_id = $1 AND id = ANY($2::uuid[])',
        [folderId, pageIds],
      );
      return result.rows[0]?.count;
    },

    /** sort_order = position in `orderedIds` (from 0). */
    async reorderPages(folderId: string, orderedIds: string[]): Promise<void> {
      await db.query(
        `UPDATE help_pages hp
         SET sort_order = (ordered.sort_order - 1)::int, updated_at = NOW()
         FROM unnest($2::uuid[]) WITH ORDINALITY AS ordered(id, sort_order)
         WHERE hp.id = ordered.id
           AND hp.folder_id = $1`,
        [folderId, orderedIds],
      );
    },
  };
}

export type HelpDocsRepository = ReturnType<typeof createHelpDocsRepository>;
