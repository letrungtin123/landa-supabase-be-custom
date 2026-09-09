// ═══════════════════════════════════════════════════════════════
// Library Service — Documents + Document Categories
// Tenant-scoped, tối ưu cho triệu records
// ═══════════════════════════════════════════════════════════════

import { getClient, query } from '../../config/database.js';
import { invalidateTenantLibraryCaches } from '../../config/cache-invalidation.js';
import { AppError } from '../../middleware/error-handler.js';
import { appendAuditLog, type TransactionalAuditEntry } from '../../middleware/audit-log.js';
import { parsePagination, calcOffset, calcTotalPages } from '../../utils/query-helpers.js';

type DocumentMutationInput = {
  title?: string;
  is_visible?: boolean;
  is_public?: boolean;
  category_id?: string | null;
};

type BulkDocumentAction = 'show' | 'hide' | 'set_category';

export interface DocumentCategoryAuditSnapshot {
  id: string;
  tenant_id: string;
  name: string;
  is_public: boolean;
}

export interface DocumentAuditSnapshot {
  id: string;
  title: string;
  file_size: number;
  category_id: string | null;
  is_visible: boolean;
  is_public: boolean;
}

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

async function normalizeDocumentCategory(
  client: DbClient,
  tenantId: string,
  categoryId: string | null | undefined,
): Promise<string | null> {
  const nextCategoryId = categoryId || null;
  if (!nextCategoryId) return null;

  await assertDocumentCategoryInTenant(client, tenantId, nextCategoryId);
  return nextCategoryId;
}

function toCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

type DocumentCategoryPublicImpactRow = {
  group_id: string;
  group_name: string;
  subgroup_id: string;
  subgroup_name: string;
  team_id: string;
  team_name: string;
  assigned_at: string | null;
};

async function getDocumentCategoryContext(catId: string, tenantId?: string | null) {
  const params: unknown[] = [catId];
  const tenantClause = tenantId ? 'AND tenant_id = $2::uuid' : '';
  if (tenantId) params.push(tenantId);
  const result = await query<{ id: string; tenant_id: string; name: string; is_public: boolean }>(
    `SELECT id, tenant_id, name, COALESCE(is_public, false) AS is_public
     FROM document_categories
     WHERE id = $1::uuid ${tenantClause}
     LIMIT 1`,
    params,
  );
  return result.rows[0] ?? null;
}

export async function getDocCategoryPublicImpact(catId: string, tenantId: string, limit = 30) {
  const category = await getDocumentCategoryContext(catId, tenantId);
  if (!category) throw new AppError('Danh mục tài liệu không tồn tại', 404);

  const cappedLimit = Math.min(Math.max(Math.trunc(limit) || 30, 1), 50);
  const [countR, dataR] = await Promise.all([
    query<{ count: string }>(
      `SELECT COUNT(DISTINCT tdc.team_id)::int AS count
       FROM team_doc_categories tdc
       JOIN teams t ON t.id = tdc.team_id
       JOIN sub_groups sg ON sg.id = t.sub_group_id
       JOIN org_groups og ON og.id = sg.org_group_id
       WHERE tdc.category_id = $1::uuid
         AND og.tenant_id = $2::uuid`,
      [catId, tenantId],
    ),
    query<DocumentCategoryPublicImpactRow>(
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
      [catId, tenantId, cappedLimit],
    ),
  ]);

  return {
    category: { id: category.id, name: category.name, is_public: category.is_public },
    total: toCount(countR.rows[0]?.count),
    assignments: dataR.rows,
  };
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
      `SELECT dc.*, COALESCE(dc.is_public, false) AS is_public, (SELECT COUNT(*) FROM documents d WHERE d.category_id = dc.id) AS doc_count${assignedSelect}
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
    `INSERT INTO document_categories (tenant_id, name, slug, is_public) VALUES ($1, $2, $3, false)
     RETURNING id, name, slug, is_public`,
    [tenantId, input.name, slug],
  );
  await invalidateTenantLibraryCaches(tenantId);
  return result.rows[0];
}

export async function updateDocCategory(
  catId: string,
  tenantId: string,
  input: { name?: string; is_public?: boolean },
  auditEntry?: (
    before: DocumentCategoryAuditSnapshot,
    after: DocumentCategoryAuditSnapshot,
    removedAssignments: number,
  ) => TransactionalAuditEntry,
) {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    const current = await client.query<DocumentCategoryAuditSnapshot>(
      `SELECT id, tenant_id, name, COALESCE(is_public, false) AS is_public
       FROM document_categories
       WHERE id = $1::uuid AND tenant_id = $2::uuid
       FOR UPDATE`,
      [catId, tenantId],
    );
    if (current.rowCount === 0) throw new AppError('Danh mục tài liệu không tồn tại', 404);

    const sets: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    if (input.name !== undefined) {
      const slug = input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      sets.push(`name = $${idx++}`); params.push(input.name);
      sets.push(`slug = $${idx++}`); params.push(slug);
    }
    if (input.is_public !== undefined) { sets.push(`is_public = $${idx++}`); params.push(input.is_public); }
    if (sets.length === 0) throw new AppError('Không có dữ liệu cập nhật', 400);

    let removedAssignments = 0;
    if (input.is_public === true && current.rows[0].is_public !== true) {
      const removed = await client.query(
        `DELETE FROM team_doc_categories tdc
         USING teams t
         JOIN sub_groups sg ON sg.id = t.sub_group_id
         JOIN org_groups og ON og.id = sg.org_group_id
         WHERE tdc.team_id = t.id
           AND tdc.category_id = $1::uuid
           AND og.tenant_id = $2::uuid`,
        [catId, tenantId],
      );
      removedAssignments = removed.rowCount || 0;
    }

    params.push(catId, tenantId);
    const result = await client.query<DocumentCategoryAuditSnapshot & { slug: string; sort_order: number }>(
      `UPDATE document_categories
       SET ${sets.join(', ')}
       WHERE id = $${idx++}::uuid AND tenant_id = $${idx}::uuid
       RETURNING id, name, slug, tenant_id, sort_order, is_public`,
      params,
    );

    const updated = result.rows[0];
    if (!updated) throw new AppError('Danh mục tài liệu không tồn tại', 404);
    if (auditEntry) await appendAuditLog(client, auditEntry(current.rows[0], updated, removedAssignments));

    await client.query('COMMIT');
    await invalidateTenantLibraryCaches(tenantId);
    return { ...updated, removed_assignments: removedAssignments };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteDocCategory(catId: string, tenantId: string) {
  const category = await deleteDocCategoryFromDb(catId, tenantId);
  await invalidateTenantLibraryCaches(tenantId);
  return category;
}

async function deleteDocCategoryFromDb(catId: string, tenantId: string) {
  const result = await query(
    'DELETE FROM document_categories WHERE id = $1::uuid AND tenant_id = $2::uuid RETURNING id, name',
    [catId, tenantId],
  );
  if (result.rowCount === 0) throw new AppError('Danh mục tài liệu không tồn tại hoặc không thuộc tenant hiện tại', 404);
  return result.rows[0];
}

export async function bulkDeleteDocCategories(ids: string[], tenantId: string) {
  const normalizedIds = normalizeIds(ids);
  if (normalizedIds.length === 0) return { deleted: 0 };

  const result = await query(
    'DELETE FROM document_categories WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[]) RETURNING id',
    [tenantId, normalizedIds],
  );
  if ((result.rowCount || 0) > 0) {
    await invalidateTenantLibraryCaches(tenantId);
  }
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
    ),
  ]);

  const total = parseInt(countR.rows[0].count, 10);
  return { data: dataR.rows, total, page, pageSize, totalPages: calcTotalPages(total, pageSize) };
}

export async function createDocument(tenantId: string, input: {
  title: string; file_url: string; file_size?: number; extension?: string;
  category_id?: string | null; is_visible?: boolean; is_public?: boolean;
}, uploadedBy: string, options: { invalidateCache?: boolean } = {}, auditEntry?: (document: DocumentAuditSnapshot) => TransactionalAuditEntry) {
  const client = await getClient();
  let document: any;
  try {
    await client.query('BEGIN');

    if (input.is_public !== undefined) throw new AppError('Chỉ được bật Công khai truy cập ở danh mục tài liệu', 400);
    const isVisible = input.is_visible ?? true;
    const isPublic = false;
    const categoryId = await normalizeDocumentCategory(client, tenantId, input.category_id || null);

    const result = await client.query(
      `INSERT INTO documents (tenant_id, title, file_url, file_size, extension, category_id, is_visible, is_public, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, title, file_url, file_size, extension, category_id, is_visible, is_public`,
      [tenantId, input.title, input.file_url, input.file_size || 0, input.extension || '', categoryId, isVisible, isPublic, uploadedBy],
    );
    document = result.rows[0];
    if (!document) throw new AppError('Không thể tạo tài liệu', 500);
    if (auditEntry) await appendAuditLog(client, auditEntry(document));
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

export async function updateDocument(
  docId: string,
  tenantId: string,
  input: DocumentMutationInput,
  auditEntry?: (before: DocumentAuditSnapshot, after: DocumentAuditSnapshot, categoryName: string | null) => TransactionalAuditEntry,
) {
  const document = await updateDocumentFromDb(docId, tenantId, input, auditEntry);
  await invalidateTenantLibraryCaches(tenantId);
  return document;
}

async function updateDocumentFromDb(
  docId: string,
  tenantId: string,
  input: DocumentMutationInput,
  auditEntry?: (before: DocumentAuditSnapshot, after: DocumentAuditSnapshot, categoryName: string | null) => TransactionalAuditEntry,
) {
  if (
    input.title === undefined &&
    input.is_visible === undefined &&
    input.is_public === undefined &&
    input.category_id === undefined
  ) {
    throw new AppError('Không có dữ liệu cập nhật', 400);
  }

  if (input.is_public !== undefined) throw new AppError('Chỉ được bật Công khai truy cập ở danh mục tài liệu', 400);

  const client = await getClient();
  try {
    await client.query('BEGIN');

    const currentResult = await client.query<DocumentAuditSnapshot>(
      `SELECT id, title, file_size, category_id, is_visible, COALESCE(is_public, false) AS is_public
       FROM documents
       WHERE id = $1::uuid AND tenant_id = $2::uuid
       FOR UPDATE`,
      [docId, tenantId],
    );

    const current = currentResult.rows[0];
    if (!current) throw new AppError('Tài liệu không tồn tại', 404);

    const nextTitle = input.title !== undefined ? input.title : current.title;
    const nextIsVisible = input.is_visible !== undefined ? input.is_visible : current.is_visible;
    const nextIsPublic = false;

    const rawCategoryId = input.category_id !== undefined ? input.category_id : current.category_id;
    const nextCategoryId = await normalizeDocumentCategory(client, tenantId, rawCategoryId);
    const nextCategory = nextCategoryId
      ? await client.query<{ name: string }>(
        'SELECT name FROM document_categories WHERE id = $1::uuid AND tenant_id = $2::uuid',
        [nextCategoryId, tenantId],
      )
      : null;

    const result = await client.query<DocumentAuditSnapshot & { file_url: string; extension: string }>(
      `UPDATE documents
       SET title = $3,
           is_visible = $4,
           is_public = $5,
           category_id = $6
       WHERE id = $1::uuid AND tenant_id = $2::uuid
       RETURNING id, title, file_url, file_size, extension, category_id, is_visible, is_public`,
      [docId, tenantId, nextTitle, nextIsVisible, nextIsPublic, nextCategoryId],
    );

    const updated = result.rows[0];
    if (!updated) throw new AppError('Tài liệu không tồn tại', 404);
    if (auditEntry) await appendAuditLog(client, auditEntry(current, updated, nextCategory?.rows[0]?.name ?? null));
    await client.query('COMMIT');
    return updated;
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
    'DELETE FROM documents WHERE id = $1::uuid AND tenant_id = $2::uuid RETURNING id, title, file_url, file_size',
    [docId, tenantId],
  );
  if (result.rowCount === 0) throw new AppError('Tài liệu không tồn tại', 404);
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
  auditEntry?: (result: { updated: number; detached: number; categoryName: string | null }) => TransactionalAuditEntry | null,
) {
  const normalizedIds = normalizeIds(ids);
  if (normalizedIds.length === 0) return { updated: 0, detached: 0 };
  const normalizedAction = action as BulkDocumentAction;
  if (!['show', 'hide', 'set_category'].includes(normalizedAction)) {
    throw new AppError('Action không hợp lệ', 400);
  }

  const result = await bulkDocumentActionFromDb(normalizedIds, tenantId, normalizedAction, categoryId, auditEntry);
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
  auditEntry?: (result: { updated: number; detached: number; categoryName: string | null }) => TransactionalAuditEntry | null,
) {

  const client = await getClient();
  try {
    await client.query('BEGIN');
    let result: { updated: number; detached: number; categoryName: string | null };

    if (action === 'show') {
      const r = await client.query('UPDATE documents SET is_visible = true WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[])', [tenantId, ids]);
      result = { updated: r.rowCount || 0, detached: 0, categoryName: null };
    } else if (action === 'hide') {
      const r = await client.query('UPDATE documents SET is_visible = false, is_public = false WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[])', [tenantId, ids]);
      result = { updated: r.rowCount || 0, detached: 0, categoryName: null };
    } else {
      const nextCategoryId = categoryId || null;
      if (!nextCategoryId) {
        const r = await client.query('UPDATE documents SET category_id = NULL WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[])', [tenantId, ids]);
        result = { updated: r.rowCount || 0, detached: r.rowCount || 0, categoryName: null };
      } else {
        const category = await client.query<{ name: string }>(
          'SELECT name FROM document_categories WHERE id = $1::uuid AND tenant_id = $2::uuid LIMIT 1',
          [nextCategoryId, tenantId],
        );
        if (category.rowCount === 0) {
          throw new AppError('Danh mục tài liệu không tồn tại hoặc không thuộc tenant hiện tại', 404);
        }
        const r = await client.query(
          'UPDATE documents SET category_id = $3::uuid WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[])',
          [tenantId, ids, nextCategoryId],
        );
        result = { updated: r.rowCount || 0, detached: 0, categoryName: category.rows[0].name };
      }
    }

    if (result.updated > 0 && auditEntry) {
      const entry = auditEntry(result);
      if (entry) await appendAuditLog(client, entry);
    }
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}


