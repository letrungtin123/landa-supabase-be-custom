// ═══════════════════════════════════════════════════════════════
// Library Service — Documents + Document Categories
// Tenant-scoped, tối ưu cho triệu records
// ═══════════════════════════════════════════════════════════════

import { getClient, query } from '../../config/database.js';
import { invalidateTenantLibraryCaches } from '../../config/cache-invalidation.js';
import { AppError } from '../../middleware/error-handler.js';
import { parsePagination, calcOffset, calcTotalPages } from '../../utils/query-helpers.js';

type DocumentMutationInput = {
  title?: string;
  is_visible?: boolean;
  is_public?: boolean;
  category_id?: string | null;
};

type BulkDocumentAction = 'show' | 'hide' | 'set_category' | 'make_public' | 'make_private';

type DbClient = Awaited<ReturnType<typeof getClient>>;

function normalizeIds(ids: string[]): string[] {
  return Array.from(new Set(
    ids
      .filter((id): id is string => typeof id === 'string')
      .map((id) => id.trim())
      .filter(Boolean),
  ));
}

async function getCategoryTenantIds(categoryIds: readonly string[]): Promise<string[]> {
  if (categoryIds.length === 0) return [];
  const result = await query<{ tenant_id: string }>(
    'SELECT DISTINCT tenant_id FROM document_categories WHERE id = ANY($1)',
    [categoryIds],
  );
  return result.rows.map((row) => row.tenant_id);
}

async function assertDocumentCategoryInTenant(client: DbClient, tenantId: string, categoryId: string): Promise<void> {
  const result = await client.query<{ id: string }>(
    'SELECT id FROM document_categories WHERE id = $1::uuid AND tenant_id = $2::uuid LIMIT 1',
    [categoryId, tenantId],
  );
  if (result.rowCount === 0) {
    throw new AppError('Danh mục tài liệu không tồn tại hoặc không thuộc tenant hiện tại', 404);
  }
}

async function isDocumentCategoryAssignedToTeam(client: DbClient, tenantId: string, categoryId: string): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM team_doc_categories tdc
       JOIN teams t ON t.id = tdc.team_id
       JOIN sub_groups sg ON sg.id = t.sub_group_id
       JOIN org_groups og ON og.id = sg.org_group_id
       WHERE tdc.category_id = $1::uuid
         AND og.tenant_id = $2::uuid
     ) AS exists`,
    [categoryId, tenantId],
  );
  return result.rows[0]?.exists === true;
}

async function normalizeDocumentCategoryForVisibility(
  client: DbClient,
  tenantId: string,
  categoryId: string | null | undefined,
  isPublic: boolean,
): Promise<string | null> {
  const nextCategoryId = categoryId || null;
  if (!nextCategoryId) return null;

  await assertDocumentCategoryInTenant(client, tenantId, nextCategoryId);
  if (isPublic && await isDocumentCategoryAssignedToTeam(client, tenantId, nextCategoryId)) {
    return null;
  }
  return nextCategoryId;
}

function toCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// ── Document Categories ──

export async function listDocCategories(tenantId: string | null, queryParams: Record<string, unknown>) {
  const { page, pageSize, search } = parsePagination(queryParams);
  const offset = calcOffset(page, pageSize);
  const params: unknown[] = [];
  const conditions: string[] = [];
  const assignedTeamId = typeof queryParams.assigned_team_id === 'string' && queryParams.assigned_team_id.trim()
    ? queryParams.assigned_team_id.trim()
    : null;

  if (tenantId) { params.push(tenantId); conditions.push(`dc.tenant_id = $${params.length}`); }
  if (search) { params.push(`%${search}%`); conditions.push(`unaccent(dc.name) ILIKE unaccent($${params.length})`); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
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
                ${tenantId ? 'AND og_assign.tenant_id = $1::uuid' : ''}
            ) AS is_assigned_to_team`;
  }

  const [countR, dataR] = await Promise.all([
    query<{ count: string }>(`SELECT COUNT(*) AS count FROM document_categories dc ${where}`, params),
    query(
      `SELECT dc.*, (SELECT COUNT(*) FROM documents d WHERE d.category_id = dc.id) AS doc_count${assignedSelect}
       FROM document_categories dc ${where}
       ORDER BY dc.sort_order, dc.name
       LIMIT $${dataParams.length + 1} OFFSET $${dataParams.length + 2}`,
      [...dataParams, pageSize, offset],
    ),
  ]);

  const total = parseInt(countR.rows[0].count, 10);
  return { data: dataR.rows, total, page, pageSize, totalPages: calcTotalPages(total, pageSize) };
}

export async function createDocCategory(tenantId: string, input: { name: string }) {
  const slug = input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const result = await query(
    `INSERT INTO document_categories (tenant_id, name, slug) VALUES ($1, $2, $3)
     RETURNING id, name, slug`,
    [tenantId, input.name, slug],
  );
  await invalidateTenantLibraryCaches(tenantId);
  return result.rows[0];
}

export async function updateDocCategory(catId: string, input: { name?: string }) {
  const tenantIds = await getCategoryTenantIds([catId]);
  const category = await updateDocCategoryFromDb(catId, input);
  await Promise.all(tenantIds.map((tenantId) => invalidateTenantLibraryCaches(tenantId)));
  return category;
}

async function updateDocCategoryFromDb(catId: string, input: { name?: string }) {
  if (!input.name) throw new AppError('Không có dữ liệu cập nhật', 400);
  const slug = input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const result = await query(
    'UPDATE document_categories SET name = $1, slug = $2 WHERE id = $3 RETURNING id, name, slug',
    [input.name, slug, catId],
  );
  if (result.rowCount === 0) throw new AppError('Danh mục không tồn tại', 404);
  return result.rows[0];
}

export async function deleteDocCategory(catId: string) {
  const tenantIds = await getCategoryTenantIds([catId]);
  const category = await deleteDocCategoryFromDb(catId);
  await Promise.all(tenantIds.map((tenantId) => invalidateTenantLibraryCaches(tenantId)));
  return category;
}

async function deleteDocCategoryFromDb(catId: string) {
  const result = await query('DELETE FROM document_categories WHERE id = $1 RETURNING id, name', [catId]);
  if (result.rowCount === 0) throw new AppError('Danh mục không tồn tại', 404);
  return result.rows[0];
}

export async function bulkDeleteDocCategories(ids: string[]) {
  const tenantIds = await getCategoryTenantIds(ids);
  const result = await query('DELETE FROM document_categories WHERE id = ANY($1) RETURNING id', [ids]);
  await Promise.all(tenantIds.map((tenantId) => invalidateTenantLibraryCaches(tenantId)));
  return { deleted: result.rowCount || 0 };
}

// ── Documents ──

export async function listDocuments(tenantId: string | null, queryParams: Record<string, unknown>) {
  const { page, pageSize, search } = parsePagination(queryParams);
  const offset = calcOffset(page, pageSize);
  const params: unknown[] = [];
  const conditions: string[] = [];

  if (tenantId) { params.push(tenantId); conditions.push(`d.tenant_id = $${params.length}`); }
  if (search) { params.push(`%${search}%`); conditions.push(`unaccent(d.title) ILIKE unaccent($${params.length})`); }
  const catFilter = queryParams.category_id as string;
  if (catFilter) { params.push(catFilter); conditions.push(`d.category_id = $${params.length}`); }
  const extFilter = queryParams.extension as string;
  if (extFilter) { params.push(extFilter); conditions.push(`d.extension = $${params.length}`); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const [countR, dataR] = await Promise.all([
    query<{ count: string }>(`SELECT COUNT(*) AS count FROM documents d ${where}`, params),
    query(
      `SELECT d.id, d.title, d.file_url, d.file_size, d.extension, d.category_id,
              d.is_visible, COALESCE(d.is_public, false) AS is_public, d.created_at,
              dc.name AS category_name,
              u.username AS uploaded_by_name
       FROM documents d
       LEFT JOIN document_categories dc ON dc.id = d.category_id
       LEFT JOIN users u ON u.id = d.uploaded_by
       ${where}
       ORDER BY d.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset],
    ),
  ]);

  const total = parseInt(countR.rows[0].count, 10);
  return { data: dataR.rows, total, page, pageSize, totalPages: calcTotalPages(total, pageSize) };
}

export async function createDocument(tenantId: string, input: {
  title: string; file_url: string; file_size?: number; extension?: string;
  category_id?: string | null; is_visible?: boolean; is_public?: boolean;
}, uploadedBy: string, options: { invalidateCache?: boolean } = {}) {
  const client = await getClient();
  let document: any;
  try {
    await client.query('BEGIN');

    let isVisible = input.is_visible ?? true;
    let isPublic = input.is_public === true;
    if (isPublic) isVisible = true;
    if (isVisible === false) isPublic = false;
    const categoryId = await normalizeDocumentCategoryForVisibility(client, tenantId, input.category_id || null, isPublic);

    const result = await client.query(
      `INSERT INTO documents (tenant_id, title, file_url, file_size, extension, category_id, is_visible, is_public, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, title, file_url, file_size, extension, category_id, is_visible, is_public`,
      [tenantId, input.title, input.file_url, input.file_size || 0, input.extension || '', categoryId, isVisible, isPublic, uploadedBy],
    );
    document = result.rows[0];
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  if (options.invalidateCache !== false) {
    await invalidateTenantLibraryCaches(tenantId);
  }
  return document;
}

export async function invalidateLibraryCache(tenantId: string) {
  await invalidateTenantLibraryCaches(tenantId);
}

export async function updateDocument(docId: string, tenantId: string, input: DocumentMutationInput) {
  const document = await updateDocumentFromDb(docId, tenantId, input);
  await invalidateTenantLibraryCaches(tenantId);
  return document;
}

async function updateDocumentFromDb(docId: string, tenantId: string, input: DocumentMutationInput) {
  if (
    input.title === undefined &&
    input.is_visible === undefined &&
    input.is_public === undefined &&
    input.category_id === undefined
  ) {
    throw new AppError('Không có dữ liệu cập nhật', 400);
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');

    const currentResult = await client.query<{
      id: string;
      title: string;
      category_id: string | null;
      is_visible: boolean;
      is_public: boolean;
    }>(
      `SELECT id, title, category_id, is_visible, COALESCE(is_public, false) AS is_public
       FROM documents
       WHERE id = $1::uuid AND tenant_id = $2::uuid
       FOR UPDATE`,
      [docId, tenantId],
    );

    const current = currentResult.rows[0];
    if (!current) throw new AppError('Document không tồn tại', 404);

    const nextTitle = input.title !== undefined ? input.title : current.title;
    let nextIsVisible = input.is_visible !== undefined ? input.is_visible : current.is_visible;
    let nextIsPublic = input.is_public !== undefined ? input.is_public : current.is_public;
    if (nextIsPublic) nextIsVisible = true;
    if (nextIsVisible === false) nextIsPublic = false;

    const rawCategoryId = input.category_id !== undefined ? input.category_id : current.category_id;
    const nextCategoryId = await normalizeDocumentCategoryForVisibility(client, tenantId, rawCategoryId, nextIsPublic);

    const result = await client.query(
      `UPDATE documents
       SET title = $3,
           is_visible = $4,
           is_public = $5,
           category_id = $6
       WHERE id = $1::uuid AND tenant_id = $2::uuid
       RETURNING id, title, file_url, file_size, extension, category_id, is_visible, is_public`,
      [docId, tenantId, nextTitle, nextIsVisible, nextIsPublic, nextCategoryId],
    );

    await client.query('COMMIT');
    return result.rows[0];
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteDocument(docId: string, tenantId: string) {
  const document = await deleteDocumentFromDb(docId, tenantId);
  await invalidateTenantLibraryCaches(tenantId);
  return document;
}

async function deleteDocumentFromDb(docId: string, tenantId: string) {
  const result = await query(
    'DELETE FROM documents WHERE id = $1::uuid AND tenant_id = $2::uuid RETURNING id, title, file_url',
    [docId, tenantId],
  );
  if (result.rowCount === 0) throw new AppError('Document không tồn tại', 404);
  return result.rows[0];
}

export async function bulkDeleteDocuments(ids: string[], tenantId: string) {
  const normalizedIds = normalizeIds(ids);
  if (normalizedIds.length === 0) return { deleted: 0, rows: [] as Array<{ id: string; title: string; file_url: string | null }> };

  const result = await query<{ id: string; title: string; file_url: string | null }>(
    'DELETE FROM documents WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[]) RETURNING id, title, file_url',
    [tenantId, normalizedIds],
  );
  if ((result.rowCount || 0) > 0) {
    await invalidateTenantLibraryCaches(tenantId);
  }
  return { deleted: result.rowCount || 0, rows: result.rows };
}

export async function bulkDocumentAction(
  ids: string[],
  tenantId: string,
  action: string,
  categoryId?: string | null,
) {
  const normalizedIds = normalizeIds(ids);
  if (normalizedIds.length === 0) return { updated: 0, detached: 0 };
  const normalizedAction = action as BulkDocumentAction;
  if (!['show', 'hide', 'set_category', 'make_public', 'make_private'].includes(normalizedAction)) {
    throw new AppError('Action không hợp lệ', 400);
  }

  const result = await bulkDocumentActionFromDb(normalizedIds, tenantId, normalizedAction, categoryId);
  if (result.updated > 0) {
    await invalidateTenantLibraryCaches(tenantId);
  }
  return result;
}

async function bulkDocumentActionFromDb(
  ids: string[],
  tenantId: string,
  action: BulkDocumentAction,
  categoryId?: string | null,
) {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    if (action === 'show') {
      const r = await client.query('UPDATE documents SET is_visible = true WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[])', [tenantId, ids]);
      await client.query('COMMIT');
      return { updated: r.rowCount || 0, detached: 0 };
    }

    if (action === 'hide') {
      const r = await client.query('UPDATE documents SET is_visible = false, is_public = false WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[])', [tenantId, ids]);
      await client.query('COMMIT');
      return { updated: r.rowCount || 0, detached: 0 };
    }

    if (action === 'make_private') {
      const r = await client.query('UPDATE documents SET is_public = false WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[])', [tenantId, ids]);
      await client.query('COMMIT');
      return { updated: r.rowCount || 0, detached: 0 };
    }

    if (action === 'make_public') {
      const r = await client.query<{ updated: number | string; detached: number | string }>(
        `WITH target AS (
           SELECT d.id,
                  EXISTS (
                    SELECT 1
                    FROM team_doc_categories tdc
                    JOIN teams t ON t.id = tdc.team_id
                    JOIN sub_groups sg ON sg.id = t.sub_group_id
                    JOIN org_groups og ON og.id = sg.org_group_id
                    WHERE tdc.category_id = d.category_id
                      AND og.tenant_id = $1::uuid
                  ) AS detach_category
           FROM documents d
           WHERE d.tenant_id = $1::uuid
             AND d.id = ANY($2::uuid[])
           FOR UPDATE
         ), updated AS (
           UPDATE documents d
           SET is_visible = true,
               is_public = true,
               category_id = CASE WHEN target.detach_category THEN NULL ELSE d.category_id END
           FROM target
           WHERE d.id = target.id
           RETURNING target.detach_category
         )
         SELECT COUNT(*)::int AS updated,
                COALESCE(COUNT(*) FILTER (WHERE detach_category), 0)::int AS detached
         FROM updated`,
        [tenantId, ids],
      );
      await client.query('COMMIT');
      return { updated: toCount(r.rows[0]?.updated), detached: toCount(r.rows[0]?.detached) };
    }

    const nextCategoryId = categoryId || null;
    if (!nextCategoryId) {
      const r = await client.query('UPDATE documents SET category_id = NULL WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[])', [tenantId, ids]);
      await client.query('COMMIT');
      return { updated: r.rowCount || 0, detached: 0 };
    }

    await assertDocumentCategoryInTenant(client, tenantId, nextCategoryId);
    const assignedToTeam = await isDocumentCategoryAssignedToTeam(client, tenantId, nextCategoryId);

    if (!assignedToTeam) {
      const r = await client.query(
        'UPDATE documents SET category_id = $3::uuid WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[])',
        [tenantId, ids, nextCategoryId],
      );
      await client.query('COMMIT');
      return { updated: r.rowCount || 0, detached: 0 };
    }

    const r = await client.query<{ updated: number | string; detached: number | string }>(
      `WITH target AS (
         SELECT id, COALESCE(is_public, false) AS detach_category
         FROM documents
         WHERE tenant_id = $1::uuid
           AND id = ANY($2::uuid[])
         FOR UPDATE
       ), updated AS (
         UPDATE documents d
         SET category_id = CASE WHEN target.detach_category THEN NULL ELSE $3::uuid END
         FROM target
         WHERE d.id = target.id
         RETURNING target.detach_category
       )
       SELECT COUNT(*)::int AS updated,
              COALESCE(COUNT(*) FILTER (WHERE detach_category), 0)::int AS detached
       FROM updated`,
      [tenantId, ids, nextCategoryId],
    );
    await client.query('COMMIT');
    return { updated: toCount(r.rows[0]?.updated), detached: toCount(r.rows[0]?.detached) };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}