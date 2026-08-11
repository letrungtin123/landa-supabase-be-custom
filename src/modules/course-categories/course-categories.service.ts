// ═══════════════════════════════════════════════════════════════
// Course Categories Service — CRUD + assign courses to categories
// ═══════════════════════════════════════════════════════════════

import { query } from '../../config/database.js';
import { invalidateCourseReadCaches, invalidateTenantCourseCaches } from '../../config/cache-invalidation.js';
import { AppError } from '../../middleware/error-handler.js';
import { parsePagination, calcOffset, calcTotalPages } from '../../utils/query-helpers.js';

async function getCategoryTenantId(catId: string): Promise<string | null> {
  const result = await query<{ tenant_id: string }>('SELECT tenant_id FROM course_categories WHERE id = $1', [catId]);
  return result.rows[0]?.tenant_id ?? null;
}

export async function listCourseCategories(tenantId: string | null, queryParams: Record<string, unknown> = {}) {
  const hasListParams = queryParams.page !== undefined
    || queryParams.page_size !== undefined
    || queryParams.search !== undefined
    || queryParams.assigned_team_id !== undefined;

  if (!hasListParams) {
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

  const { page, pageSize, search } = parsePagination(queryParams);
  const offset = calcOffset(page, pageSize);
  const params: unknown[] = [];
  const conditions: string[] = [];
  const assignedTeamId = typeof queryParams.assigned_team_id === 'string' && queryParams.assigned_team_id.trim()
    ? queryParams.assigned_team_id.trim()
    : null;

  if (tenantId) { params.push(tenantId); conditions.push(`cc.tenant_id = $${params.length}::uuid`); }
  if (search) { params.push(`%${search}%`); conditions.push(`unaccent(cc.name) ILIKE unaccent($${params.length})`); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const dataParams = [...params];
  let assignedSelect = '';
  if (assignedTeamId) {
    dataParams.push(assignedTeamId);
    const teamParam = dataParams.length;
    assignedSelect = `,
              EXISTS (
                SELECT 1
                FROM team_course_categories tcc
                JOIN teams t_assign ON t_assign.id = tcc.team_id
                JOIN sub_groups sg_assign ON sg_assign.id = t_assign.sub_group_id
                JOIN org_groups og_assign ON og_assign.id = sg_assign.org_group_id
                WHERE tcc.category_id = cc.id
                  AND tcc.team_id = $${teamParam}::uuid
                  ${tenantId ? 'AND og_assign.tenant_id = $1::uuid' : ''}
              ) AS is_assigned_to_team`;
  }

  const [countR, dataR] = await Promise.all([
    query<{ count: string }>(`SELECT COUNT(*) AS count FROM course_categories cc ${where}`, params),
    query(
      `SELECT cc.*,
              (SELECT COUNT(*) FROM course_category_courses ccc WHERE ccc.category_id = cc.id) AS course_count${assignedSelect}
       FROM course_categories cc ${where}
       ORDER BY cc.sort_order, cc.name
       LIMIT $${dataParams.length + 1} OFFSET $${dataParams.length + 2}`,
      [...dataParams, pageSize, offset],
    ),
  ]);

  const total = parseInt(countR.rows[0].count, 10);
  return { results: dataR.rows, total, page, pageSize, totalPages: calcTotalPages(total, pageSize) };
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
  const result = await query<{ id: string; tenant_id: string; name: string }>('DELETE FROM course_categories WHERE id = $1 RETURNING id, tenant_id, name', [catId]);
  if (result.rowCount === 0) throw new AppError('Danh mục không tồn tại', 404);
  await invalidateTenantCourseCaches(result.rows[0].tenant_id);
  return result.rows[0];
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
  const category = await query<{ tenant_id: string; name: string }>('SELECT tenant_id, name FROM course_categories WHERE id = $1', [catId]);
  const tenantId = category.rows[0]?.tenant_id ?? null;
  const categoryName = category.rows[0]?.name || catId;
  let assigned = 0;
  let skipped = 0;
  for (const courseId of courseIds) {
    const r = await query(
      `INSERT INTO course_category_courses (category_id, course_id)
       SELECT cc.id, c.id
       FROM course_categories cc
       JOIN courses c ON c.id = $2
        AND c.tenant_id = cc.tenant_id
        AND c.deleted_at IS NULL
       WHERE cc.id = $1
         AND NOT (
           COALESCE(c.is_public, false) = true
           AND EXISTS (
             SELECT 1
             FROM team_course_categories tcc
             JOIN teams t ON t.id = tcc.team_id
             JOIN sub_groups sg ON sg.id = t.sub_group_id
             JOIN org_groups og ON og.id = sg.org_group_id
             WHERE tcc.category_id = cc.id
               AND og.tenant_id = cc.tenant_id
           )
         )
       ON CONFLICT DO NOTHING`,
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
  return { assigned, skipped, categoryName };
}

export async function removeCourseFromCategory(catId: string, courseId: string) {
  const context = await query<{ tenant_id: string; category_name: string; course_name: string | null }>(
    `SELECT cc.tenant_id,
            cc.name AS category_name,
            c.display_name AS course_name
     FROM course_categories cc
     LEFT JOIN courses c ON c.id = $2 AND c.tenant_id = cc.tenant_id
     WHERE cc.id = $1`,
    [catId, courseId],
  );
  const tenantId = context.rows[0]?.tenant_id ?? null;
  await removeCourseFromCategoryFromDb(catId, courseId);
  if (tenantId) {
    await Promise.all([
      invalidateTenantCourseCaches(tenantId),
      invalidateCourseReadCaches(courseId, tenantId),
    ]);
  }
  return {
    success: true,
    categoryName: context.rows[0]?.category_name || catId,
    courseName: context.rows[0]?.course_name || courseId,
  };
}

async function removeCourseFromCategoryFromDb(catId: string, courseId: string) {
  const result = await query(
    'DELETE FROM course_category_courses WHERE category_id = $1 AND course_id = $2 RETURNING id',
    [catId, courseId],
  );
  if (result.rowCount === 0) throw new AppError('Liên kết không tồn tại', 404);
}
