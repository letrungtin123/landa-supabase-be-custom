// ═══════════════════════════════════════════════════════════════
// Library Service — Documents + Document Categories
// Tenant-scoped, tối ưu cho triệu records
// ═══════════════════════════════════════════════════════════════

import { getClient, query } from '../../config/database.js';
import { invalidateTenantLibraryCaches } from '../../config/cache-invalidation.js';
import { AppError } from '../../utils/errors.js';
import { appendAuditLog, type TransactionalAuditEntry } from '../../middleware/audit-log.js';
import { parsePagination, calcOffset, calcTotalPages } from '../../utils/query-helpers.js';
import {
  createLibraryRepository,
  type DocumentRow,
  type LibraryDb,
} from './library.repository.js';

// query() joins the caller's current transaction (withDatabaseTransaction) when there is one.
const libraryRepository = createLibraryRepository({ query } satisfies LibraryDb);

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
  return libraryRepository.selectCategoryTenantIds(categoryIds);
}

async function assertDocumentCategoryInTenant(client: DbClient, tenantId: string, categoryId: string): Promise<void> {
  if (!await createLibraryRepository(client).categoryInTenant(categoryId, tenantId)) {
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

async function getDocumentCategoryContext(catId: string, tenantId?: string | null) {
  return libraryRepository.selectCategory(catId, tenantId);
}

export async function getDocCategoryPublicImpact(catId: string, tenantId: string, limit = 30) {
  const category = await getDocumentCategoryContext(catId, tenantId);
  if (!category) throw new AppError('Danh mục tài liệu không tồn tại', 404);

  const cappedLimit = Math.min(Math.max(Math.trunc(limit) || 30, 1), 50);
  const [countRow, assignments] = await Promise.all([
    libraryRepository.countCategoryTeams(catId, tenantId),
    libraryRepository.selectCategoryTeams(catId, tenantId, cappedLimit),
  ]);

  return {
    category: { id: category.id, name: category.name, is_public: category.is_public },
    total: toCount(countRow?.count),
    assignments,
  };
}

// ── Document Categories ──

export async function listDocCategories(tenantId: string | null, queryParams: Record<string, unknown>) {
  const { page, pageSize, search } = parsePagination(queryParams);
  const offset = calcOffset(page, pageSize);
  const assignedTeamId = typeof queryParams.assigned_team_id === 'string' && queryParams.assigned_team_id.trim()
    ? queryParams.assigned_team_id.trim()
    : null;

  const filter = { tenantId, search };
  const [countR, rows] = await Promise.all([
    libraryRepository.countCategories(filter),
    libraryRepository.selectCategoryPage(filter, assignedTeamId, pageSize, offset),
  ]);

  const total = parseInt(countR.count, 10);
  return { data: rows, total, page, pageSize, totalPages: calcTotalPages(total, pageSize) };
}

export async function createDocCategory(tenantId: string, input: { name: string }) {
  const slug = input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const created = await libraryRepository.insertCategory(tenantId, input.name, slug);
  await invalidateTenantLibraryCaches(tenantId);
  return created;
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
    const repository = createLibraryRepository(client);

    const current = await repository.lockCategory(catId, tenantId);
    if (!current) throw new AppError('Danh mục tài liệu không tồn tại', 404);

    const fields: { name?: string; slug?: string; is_public?: boolean } = {};
    if (input.name !== undefined) {
      const slug = input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      fields.name = input.name;
      fields.slug = slug;
    }
    if (input.is_public !== undefined) fields.is_public = input.is_public;
    if (fields.name === undefined && fields.is_public === undefined) throw new AppError('Không có dữ liệu cập nhật', 400);

    let removedAssignments = 0;
    if (input.is_public === true && current.is_public !== true) {
      removedAssignments = await repository.deleteCategoryTeamAssignments(catId, tenantId);
    }

    const updated = await repository.updateCategoryFields(catId, tenantId, fields);
    if (!updated) throw new AppError('Danh mục tài liệu không tồn tại', 404);
    if (auditEntry) await appendAuditLog(client, auditEntry(current, updated, removedAssignments));

    await client.query('COMMIT');
    await invalidateTenantLibraryCaches(tenantId);
    return { ...updated, removed_assignments: removedAssignments };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined); // fails only on a broken connection, which pg-pool discards
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
  const deleted = await libraryRepository.deleteCategory(catId, tenantId);
  if (!deleted) throw new AppError('Danh mục tài liệu không tồn tại hoặc không thuộc tenant hiện tại', 404);
  return deleted;
}

export async function bulkDeleteDocCategories(ids: string[], tenantId: string) {
  const normalizedIds = normalizeIds(ids);
  if (normalizedIds.length === 0) return { deleted: 0 };

  const deleted = await libraryRepository.deleteCategories(tenantId, normalizedIds);
  if (deleted > 0) {
    await invalidateTenantLibraryCaches(tenantId);
  }
  return { deleted };
}

// ── Documents ──

export async function listDocuments(tenantId: string | null, queryParams: Record<string, unknown>) {
  const { page, pageSize, search } = parsePagination(queryParams);
  const offset = calcOffset(page, pageSize);
  const filter = {
    tenantId,
    search,
    categoryId: queryParams.category_id as string,
    extension: queryParams.extension as string,
  };

  const [countR, rows] = await Promise.all([
    libraryRepository.countDocuments(filter),
    libraryRepository.selectDocumentPage(filter, pageSize, offset),
  ]);

  const total = parseInt(countR.count, 10);
  return { data: rows, total, page, pageSize, totalPages: calcTotalPages(total, pageSize) };
}

export async function createDocument(tenantId: string, input: {
  title: string; file_url: string; file_size?: number; extension?: string;
  category_id?: string | null; is_visible?: boolean; is_public?: boolean;
}, uploadedBy: string, options: { invalidateCache?: boolean } = {}, auditEntry?: (document: DocumentAuditSnapshot) => TransactionalAuditEntry) {
  const client = await getClient();
  let document: DocumentRow | undefined;
  try {
    await client.query('BEGIN');

    if (input.is_public !== undefined) throw new AppError('Chỉ được bật Công khai truy cập ở danh mục tài liệu', 400);
    const isVisible = input.is_visible ?? true;
    const isPublic = false;
    const categoryId = await normalizeDocumentCategory(client, tenantId, input.category_id || null);

    document = await createLibraryRepository(client).insertDocument({
      tenantId,
      title: input.title,
      fileUrl: input.file_url,
      fileSize: input.file_size || 0,
      extension: input.extension || '',
      categoryId,
      isVisible,
      isPublic,
      uploadedBy,
    });
    if (!document) throw new AppError('Không thể tạo tài liệu', 500);
    if (auditEntry) await appendAuditLog(client, auditEntry(document));
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined); // fails only on a broken connection, which pg-pool discards
    throw err;
  } finally {
    client.release();
  }

  if (options.invalidateCache !== false) {
    await invalidateTenantLibraryCaches(tenantId);
  }
  return document!;
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
    const repository = createLibraryRepository(client);

    const current = await repository.lockDocument(docId, tenantId);
    if (!current) throw new AppError('Tài liệu không tồn tại', 404);

    const nextTitle = input.title !== undefined ? input.title : current.title;
    const nextIsVisible = input.is_visible !== undefined ? input.is_visible : current.is_visible;
    const nextIsPublic = false;

    const rawCategoryId = input.category_id !== undefined ? input.category_id : current.category_id;
    const nextCategoryId = await normalizeDocumentCategory(client, tenantId, rawCategoryId);
    const nextCategory = nextCategoryId
      ? await repository.selectCategoryName(nextCategoryId, tenantId)
      : null;

    const updated = await repository.updateDocument(docId, tenantId, {
      title: nextTitle,
      isVisible: nextIsVisible,
      isPublic: nextIsPublic,
      categoryId: nextCategoryId,
    });
    if (!updated) throw new AppError('Tài liệu không tồn tại', 404);
    if (auditEntry) await appendAuditLog(client, auditEntry(current, updated, nextCategory?.name ?? null));
    await client.query('COMMIT');
    return updated;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined); // fails only on a broken connection, which pg-pool discards
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
  const deleted = await libraryRepository.deleteDocument(docId, tenantId);
  if (!deleted) throw new AppError('Tài liệu không tồn tại', 404);
  return deleted;
}

export async function bulkDeleteDocuments(ids: string[], tenantId: string) {
  const normalizedIds = normalizeIds(ids);
  if (normalizedIds.length === 0) return { deleted: 0, rows: [] as Array<{ id: string; title: string; file_url: string | null }> };

  const result = await libraryRepository.deleteDocuments(tenantId, normalizedIds);
  if (result.rowCount > 0) {
    await invalidateTenantLibraryCaches(tenantId);
  }
  return { deleted: result.rowCount, rows: result.rows };
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
    const repository = createLibraryRepository(client);
    let result: { updated: number; detached: number; categoryName: string | null };

    if (action === 'show') {
      result = { updated: await repository.showDocuments(tenantId, ids), detached: 0, categoryName: null };
    } else if (action === 'hide') {
      result = { updated: await repository.hideDocuments(tenantId, ids), detached: 0, categoryName: null };
    } else {
      const nextCategoryId = categoryId || null;
      if (!nextCategoryId) {
        const cleared = await repository.clearDocumentsCategory(tenantId, ids);
        result = { updated: cleared, detached: cleared, categoryName: null };
      } else {
        const category = await repository.selectCategoryNameForBulk(nextCategoryId, tenantId);
        if (!category) {
          throw new AppError('Danh mục tài liệu không tồn tại hoặc không thuộc tenant hiện tại', 404);
        }
        const moved = await repository.setDocumentsCategory(tenantId, ids, nextCategoryId);
        result = { updated: moved, detached: 0, categoryName: category.name };
      }
    }

    if (result.updated > 0 && auditEntry) {
      const entry = auditEntry(result);
      if (entry) await appendAuditLog(client, entry);
    }
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined); // fails only on a broken connection, which pg-pool discards
    throw err;
  } finally {
    client.release();
  }
}


