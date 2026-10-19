// ═══════════════════════════════════════════════════════════════
// Course Categories Service — CRUD + assign courses to categories
// ═══════════════════════════════════════════════════════════════

import { getClient, query } from '../../config/database.js';
import { invalidateCourseReadCaches, invalidateTenantCourseCaches } from '../../config/cache-invalidation.js';
import { AppError } from '../../utils/errors.js';
import { appendAuditLog, type TransactionalAuditEntry } from '../../middleware/audit-log.js';
import { parsePagination, calcOffset, calcTotalPages } from '../../utils/query-helpers.js';
import {
  createCourseCategoriesRepository,
  type CourseCategoriesDb,
  type CourseCategoryColumn,
} from './course-categories.repository.js';

// query() joins the caller's current transaction (runAuditedTransaction)
// when there is one; the update transaction uses the repository over its
// own client.
const poolDb: CourseCategoriesDb = { query };
const categoriesRepository = createCourseCategoriesRepository(poolDb);

export interface CourseCategoryAuditSnapshot {
  id: string;
  tenant_id: string;
  name: string;
  sort_order: number;
  is_public: boolean;
}

function normalizeCourseIds(courseIds: string[]): string[] {
  return Array.from(new Set(
    courseIds
      .filter((id): id is string => typeof id === 'string')
      .map((id) => id.trim())
      .filter(Boolean),
  ));
}

function toCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

async function getCategoryContext(catId: string, tenantId?: string | null) {
  return categoriesRepository.selectCategoryContext(catId, tenantId);
}

export async function getCourseCategoryPublicImpact(catId: string, tenantId: string, limit = 30) {
  const category = await getCategoryContext(catId, tenantId);
  if (!category) throw new AppError('Danh mục khóa học không tồn tại', 404);

  const cappedLimit = Math.min(Math.max(Math.trunc(limit) || 30, 1), 50);
  const { countRow, rows } = await categoriesRepository.selectPublicImpact(catId, tenantId, cappedLimit);

  return {
    category: { id: category.id, name: category.name, is_public: category.is_public },
    total: toCount(countRow?.count),
    assignments: rows,
  };
}

export async function listCourseCategories(tenantId: string | null, queryParams: Record<string, unknown> = {}) {
  const hasListParams = queryParams.page !== undefined
    || queryParams.page_size !== undefined
    || queryParams.search !== undefined
    || queryParams.assigned_team_id !== undefined;

  if (!hasListParams) {
    return { results: await categoriesRepository.selectAllCategories(tenantId) };
  }

  const { page, pageSize, search } = parsePagination(queryParams);
  const offset = calcOffset(page, pageSize);
  const assignedTeamId = typeof queryParams.assigned_team_id === 'string' && queryParams.assigned_team_id.trim()
    ? queryParams.assigned_team_id.trim()
    : null;

  const { countRow, rows } = await categoriesRepository.selectCategoryPage({ tenantId, search, assignedTeamId }, pageSize, offset);

  const total = parseInt(countRow.count, 10);
  return { results: rows, total, page, pageSize, totalPages: calcTotalPages(total, pageSize) };
}

export async function createCourseCategory(
  tenantId: string,
  input: { name: string; description?: string | null; sort_order?: number | null },
) {
  const slug = input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const created = await categoriesRepository.insertCategory(tenantId, input.name, slug, input.description || '', input.sort_order || 0);
  await invalidateTenantCourseCaches(tenantId);
  return created;
}

export async function updateCourseCategory(
  catId: string,
  tenantId: string,
  input: { name?: string; description?: string; sort_order?: number; is_public?: boolean },
  auditEntry?: (
    before: CourseCategoryAuditSnapshot,
    after: CourseCategoryAuditSnapshot,
    removedAssignments: number,
  ) => TransactionalAuditEntry,
) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const tx = createCourseCategoriesRepository(client);

    const current = await tx.lockCategory(catId, tenantId);
    if (!current) throw new AppError('Danh mục khóa học không tồn tại', 404);

    const sets: [CourseCategoryColumn, unknown][] = [];
    if (input.name !== undefined) {
      const slug = input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      sets.push(['name', input.name]);
      sets.push(['slug', slug]);
    }
    if (input.description !== undefined) sets.push(['description', input.description]);
    if (input.sort_order !== undefined) sets.push(['sort_order', input.sort_order]);
    if (input.is_public !== undefined) sets.push(['is_public', input.is_public]);
    if (sets.length === 0) throw new AppError('Không có dữ liệu', 400);

    let removedAssignments = 0;
    if (input.is_public === true && current.is_public !== true) {
      removedAssignments = await tx.deleteTeamAssignments(catId, tenantId);
    }

    const updated = await tx.updateCategoryColumns(catId, tenantId, sets);
    if (!updated) throw new AppError('Danh mục khóa học không tồn tại', 404);
    if (auditEntry) await appendAuditLog(client, auditEntry(current, updated, removedAssignments));

    await client.query('COMMIT');
    await invalidateTenantCourseCaches(tenantId);
    return { ...updated, removed_assignments: removedAssignments };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined); // fails only on a broken connection, which pg-pool discards
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteCourseCategory(catId: string, tenantId: string) {
  const deleted = await categoriesRepository.deleteCategory(catId, tenantId);
  if (!deleted) throw new AppError('Danh mục khóa học không tồn tại hoặc không thuộc tenant hiện tại', 404);
  await invalidateTenantCourseCaches(deleted.tenant_id);
  return deleted;
}

export async function getCategoryCourses(catId: string, tenantId: string) {
  const { rows, count } = await categoriesRepository.selectCategoryCourses(catId, tenantId);
  return { results: rows, count };
}

export async function addCoursesToCategory(catId: string, tenantId: string, courseIds: string[]) {
  const normalizedCourseIds = normalizeCourseIds(courseIds);
  if (normalizedCourseIds.length > 500) throw new AppError('Tối đa 500 khóa học mỗi lần gán danh mục', 400);

  const category = await getCategoryContext(catId, tenantId);
  if (!category) throw new AppError('Danh mục khóa học không tồn tại hoặc không thuộc tenant hiện tại', 404);
  if (normalizedCourseIds.length === 0) return { assigned: 0, skipped: 0, categoryName: category.name, conflicts: [] };

  const conflicts = await categoriesRepository.selectCategoryConflicts(normalizedCourseIds, category.tenant_id, catId);

  const assigned = await categoriesRepository.insertCategoryCourses(catId, normalizedCourseIds, category.tenant_id);

  await invalidateTenantCourseCaches(category.tenant_id);
  return {
    assigned,
    skipped: Math.max(0, normalizedCourseIds.length - assigned),
    categoryName: category.name,
    conflicts,
  };
}

export async function removeCourseFromCategory(catId: string, tenantId: string, courseId: string) {
  const context = await categoriesRepository.selectRemovalContext(catId, courseId, tenantId);
  if (!context) throw new AppError('Danh mục khóa học không tồn tại hoặc không thuộc tenant hiện tại', 404);

  await removeCourseFromCategoryFromDb(catId, tenantId, courseId);
  await Promise.all([
    invalidateTenantCourseCaches(tenantId),
    invalidateCourseReadCaches(courseId, tenantId),
  ]);
  return {
    success: true,
    categoryName: context.category_name || catId,
    courseName: context.course_name || courseId,
  };
}

async function removeCourseFromCategoryFromDb(catId: string, tenantId: string, courseId: string) {
  if (!(await categoriesRepository.deleteCategoryCourse(catId, tenantId, courseId))) throw new AppError('Liên kết không tồn tại', 404);
}




