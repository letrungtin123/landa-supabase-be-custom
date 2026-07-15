// ═══════════════════════════════════════════════════════════════
// Course Categories Service — CRUD + assign courses to categories
// ═══════════════════════════════════════════════════════════════

import { query } from '../../config/database.js';
import { invalidateCourseReadCaches, invalidateTenantCourseCaches } from '../../config/cache-invalidation.js';
import { AppError } from '../../middleware/error-handler.js';

async function getCategoryTenantId(catId: string): Promise<string | null> {
  const result = await query<{ tenant_id: string }>('SELECT tenant_id FROM course_categories WHERE id = $1', [catId]);
  return result.rows[0]?.tenant_id ?? null;
}

export async function listCourseCategories(tenantId: string | null) {
  const params: unknown[] = [];
  let where = '';
  if (tenantId) { params.push(tenantId); where = `WHERE cc.tenant_id = $1`; }

  const result = await query(
    `SELECT cc.*,
            (SELECT COUNT(*) FROM course_category_courses ccc WHERE ccc.category_id = cc.id) AS course_count
     FROM course_categories cc ${where}
     ORDER BY cc.sort_order, cc.name`,
    params,
  );
  return { results: result.rows };
}

export async function createCourseCategory(tenantId: string, input: { name: string; description?: string; sort_order?: number }) {
  const slug = input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const result = await query(
    'INSERT INTO course_categories (tenant_id, name, slug, description, sort_order) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, slug',
    [tenantId, input.name, slug, input.description || '', input.sort_order || 0],
  );
  await invalidateTenantCourseCaches(tenantId);
  return result.rows[0];
}

export async function updateCourseCategory(catId: string, input: { name?: string; description?: string; sort_order?: number }) {
  const category = await updateCourseCategoryFromDb(catId, input);
  await invalidateTenantCourseCaches(category.tenant_id);
  return category;
}

async function updateCourseCategoryFromDb(catId: string, input: { name?: string; description?: string; sort_order?: number }) {
  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;
  if (input.name !== undefined) {
    const slug = input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    sets.push(`name = $${idx++}`); params.push(input.name);
    sets.push(`slug = $${idx++}`); params.push(slug);
  }
  if (input.description !== undefined) { sets.push(`description = $${idx++}`); params.push(input.description); }
  if (input.sort_order !== undefined) { sets.push(`sort_order = $${idx++}`); params.push(input.sort_order); }
  if (sets.length === 0) throw new AppError('Không có dữ liệu', 400);
  params.push(catId);
  const result = await query(`UPDATE course_categories SET ${sets.join(', ')} WHERE id = $${idx} RETURNING id, name, slug, tenant_id`, params);
  if (result.rowCount === 0) throw new AppError('Danh mục không tồn tại', 404);
  return result.rows[0];
}

export async function deleteCourseCategory(catId: string) {
  const result = await query('DELETE FROM course_categories WHERE id = $1 RETURNING id, tenant_id', [catId]);
  if (result.rowCount === 0) throw new AppError('Danh mục không tồn tại', 404);
  await invalidateTenantCourseCaches(result.rows[0].tenant_id);
}

export async function getCategoryCourses(catId: string) {
  const result = await query(
    `SELECT ccc.id, ccc.course_id, c.display_name, ccc.assigned_at
     FROM course_category_courses ccc
     JOIN courses c ON c.id = ccc.course_id
     WHERE ccc.category_id = $1
     ORDER BY ccc.assigned_at DESC`,
    [catId],
  );
  return { results: result.rows, count: result.rowCount || 0 };
}

export async function addCoursesToCategory(catId: string, courseIds: string[]) {
  const tenantId = await getCategoryTenantId(catId);
  let assigned = 0;
  let skipped = 0;
  for (const courseId of courseIds) {
    const r = await query(
      'INSERT INTO course_category_courses (category_id, course_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [catId, courseId],
    );
    if (r.rowCount! > 0) assigned++; else skipped++;
  }
  if (tenantId) {
    await Promise.all([
      invalidateTenantCourseCaches(tenantId),
      ...courseIds.map((courseId) => invalidateCourseReadCaches(courseId, tenantId)),
    ]);
  }
  return { assigned, skipped };
}

export async function removeCourseFromCategory(catId: string, courseId: string) {
  const tenantId = await getCategoryTenantId(catId);
  await removeCourseFromCategoryFromDb(catId, courseId);
  if (tenantId) {
    await Promise.all([
      invalidateTenantCourseCaches(tenantId),
      invalidateCourseReadCaches(courseId, tenantId),
    ]);
  }
}

async function removeCourseFromCategoryFromDb(catId: string, courseId: string) {
  const result = await query(
    'DELETE FROM course_category_courses WHERE category_id = $1 AND course_id = $2 RETURNING id',
    [catId, courseId],
  );
  if (result.rowCount === 0) throw new AppError('Liên kết không tồn tại', 404);
}
