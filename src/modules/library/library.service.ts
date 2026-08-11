// ═══════════════════════════════════════════════════════════════
// Library Service — Documents + Document Categories
// Tenant-scoped, tối ưu cho triệu records
// ═══════════════════════════════════════════════════════════════

import { query } from '../../config/database.js';
import { invalidateTenantLibraryCaches } from '../../config/cache-invalidation.js';
import { AppError } from '../../middleware/error-handler.js';
import { parsePagination, calcOffset, calcTotalPages } from '../../utils/query-helpers.js';

async function getDocumentTenantIds(docIds: readonly string[]): Promise<string[]> {
  if (docIds.length === 0) return [];
  const result = await query<{ tenant_id: string }>(
    'SELECT DISTINCT tenant_id FROM documents WHERE id = ANY($1)',
    [docIds],
  );
  return result.rows.map((row) => row.tenant_id);
}

async function getCategoryTenantIds(categoryIds: readonly string[]): Promise<string[]> {
  if (categoryIds.length === 0) return [];
  const result = await query<{ tenant_id: string }>(
    'SELECT DISTINCT tenant_id FROM document_categories WHERE id = ANY($1)',
    [categoryIds],
  );
  return result.rows.map((row) => row.tenant_id);
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
              d.is_visible, d.created_at,
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
  category_id?: string; is_visible?: boolean;
}, uploadedBy: string, options: { invalidateCache?: boolean } = {}) {
  const result = await query(
    `INSERT INTO documents (tenant_id, title, file_url, file_size, extension, category_id, is_visible, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, title, file_url, file_size, extension, category_id, is_visible`,
    [tenantId, input.title, input.file_url, input.file_size || 0, input.extension || '', input.category_id || null, input.is_visible ?? true, uploadedBy],
  );
  if (options.invalidateCache !== false) {
    await invalidateTenantLibraryCaches(tenantId);
  }
  return result.rows[0];
}

export async function invalidateLibraryCache(tenantId: string) {
  await invalidateTenantLibraryCaches(tenantId);
}

export async function updateDocument(docId: string, input: { title?: string; is_visible?: boolean; category_id?: string | null }) {
  const tenantIds = await getDocumentTenantIds([docId]);
  const document = await updateDocumentFromDb(docId, input);
  await Promise.all(tenantIds.map((tenantId) => invalidateTenantLibraryCaches(tenantId)));
  return document;
}

async function updateDocumentFromDb(docId: string, input: { title?: string; is_visible?: boolean; category_id?: string | null }) {
  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (input.title !== undefined) { sets.push(`title = $${idx++}`); params.push(input.title); }
  if (input.is_visible !== undefined) { sets.push(`is_visible = $${idx++}`); params.push(input.is_visible); }
  if (input.category_id !== undefined) { sets.push(`category_id = $${idx++}`); params.push(input.category_id); }

  if (sets.length === 0) throw new AppError('Không có dữ liệu cập nhật', 400);
  params.push(docId);
  const result = await query(`UPDATE documents SET ${sets.join(', ')} WHERE id = $${idx} RETURNING id, title`, params);
  if (result.rowCount === 0) throw new AppError('Document không tồn tại', 404);
  return result.rows[0];
}

export async function deleteDocument(docId: string) {
  const tenantIds = await getDocumentTenantIds([docId]);
  const document = await deleteDocumentFromDb(docId);
  await Promise.all(tenantIds.map((tenantId) => invalidateTenantLibraryCaches(tenantId)));
  return document;
}

async function deleteDocumentFromDb(docId: string) {
  const result = await query('DELETE FROM documents WHERE id = $1 RETURNING id, title, file_url', [docId]);
  if (result.rowCount === 0) throw new AppError('Document không tồn tại', 404);
  return result.rows[0];
}

export async function bulkDocumentAction(ids: string[], action: string, categoryId?: string | null) {
  const tenantIds = await getDocumentTenantIds(ids);
  const result = await bulkDocumentActionFromDb(ids, action, categoryId);
  await Promise.all(tenantIds.map((tenantId) => invalidateTenantLibraryCaches(tenantId)));
  return result;
}

async function bulkDocumentActionFromDb(ids: string[], action: string, categoryId?: string | null) {
  if (action === 'show') {
    const r = await query('UPDATE documents SET is_visible = true WHERE id = ANY($1)', [ids]);
    return { updated: r.rowCount || 0 };
  } else if (action === 'hide') {
    const r = await query('UPDATE documents SET is_visible = false WHERE id = ANY($1)', [ids]);
    return { updated: r.rowCount || 0 };
  } else if (action === 'set_category') {
    const r = await query('UPDATE documents SET category_id = $1 WHERE id = ANY($2)', [categoryId || null, ids]);
    return { updated: r.rowCount || 0 };
  }
  throw new AppError('Action không hợp lệ', 400);
}
