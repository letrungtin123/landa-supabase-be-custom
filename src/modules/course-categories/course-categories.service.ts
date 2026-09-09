// ═══════════════════════════════════════════════════════════════
// Course Categories Service — CRUD + assign courses to categories
// ═══════════════════════════════════════════════════════════════

import { getClient, query } from '../../config/database.js';
import { invalidateCourseReadCaches, invalidateTenantCourseCaches } from '../../config/cache-invalidation.js';
import { AppError } from '../../middleware/error-handler.js';
import { appendAuditLog, type TransactionalAuditEntry } from '../../middleware/audit-log.js';
import { parsePagination, calcOffset, calcTotalPages } from '../../utils/query-helpers.js';

export interface CourseCategoryAuditSnapshot {
  id: string;
  tenant_id: string;
  name: string;
  sort_order: number;
  is_public: boolean;
}

type CourseCategoryPublicImpactRow = {
  group_id: string;
  group_name: string;
  subgroup_id: string;
  subgroup_name: string;
  team_id: string;
  team_name: string;
  assigned_at: string | null;
};

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
  const params: unknown[] = [catId];
  const tenantClause = tenantId ? 'AND tenant_id = $2::uuid' : '';
  if (tenantId) params.push(tenantId);
  const result = await query<{ id: string; tenant_id: string; name: string; is_public: boolean }>(
    `SELECT id, tenant_id, name, COALESCE(is_public, false) AS is_public
     FROM course_categories
     WHERE id = $1::uuid ${tenantClause}
     LIMIT 1`,
    params,
  );
  return result.rows[0] ?? null;
}

export async function getCourseCategoryPublicImpact(catId: string, tenantId: string, limit = 30) {
  const category = await getCategoryContext(catId, tenantId);
  if (!category) throw new AppError('Danh mục khóa học không tồn tại', 404);

  const cappedLimit = Math.min(Math.max(Math.trunc(limit) || 30, 1), 50);
  const [countR, dataR] = await Promise.all([
    query<{ count: string }>(
      `SELECT COUNT(DISTINCT tcc.team_id)::int AS count
       FROM team_course_categories tcc
       JOIN teams t ON t.id = tcc.team_id
       JOIN sub_groups sg ON sg.id = t.sub_group_id
       JOIN org_groups og ON og.id = sg.org_group_id
       WHERE tcc.category_id = $1::uuid
         AND og.tenant_id = $2::uuid`,
      [catId, tenantId],
    ),
    query<CourseCategoryPublicImpactRow>(
      `SELECT og.id AS group_id,
              og.name AS group_name,
              sg.id AS subgroup_id,
              sg.name AS subgroup_name,
              t.id AS team_id,
              t.name AS team_name,
              tcc.assigned_at
       FROM team_course_categories tcc
       JOIN teams t ON t.id = tcc.team_id
       JOIN sub_groups sg ON sg.id = t.sub_group_id
       JOIN org_groups og ON og.id = sg.org_group_id
       WHERE tcc.category_id = $1::uuid
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

    const current = await client.query<CourseCategoryAuditSnapshot>(
      `SELECT id, tenant_id, name, sort_order, COALESCE(is_public, false) AS is_public
       FROM course_categories
       WHERE id = $1::uuid AND tenant_id = $2::uuid
       FOR UPDATE`,
      [catId, tenantId],
    );
    if (current.rowCount === 0) throw new AppError('Danh mục khóa học không tồn tại', 404);

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
    if (input.is_public !== undefined) { sets.push(`is_public = $${idx++}`); params.push(input.is_public); }
    if (sets.length === 0) throw new AppError('Không có dữ liệu', 400);

    let removedAssignments = 0;
    if (input.is_public === true && current.rows[0].is_public !== true) {
      const removed = await client.query(
        `DELETE FROM team_course_categories tcc
         USING teams t
         JOIN sub_groups sg ON sg.id = t.sub_group_id
         JOIN org_groups og ON og.id = sg.org_group_id
         WHERE tcc.team_id = t.id
           AND tcc.category_id = $1::uuid
           AND og.tenant_id = $2::uuid`,
        [catId, tenantId],
      );
      removedAssignments = removed.rowCount || 0;
    }

    params.push(catId, tenantId);
    const result = await client.query<CourseCategoryAuditSnapshot & { slug: string; description: string }>(
      `UPDATE course_categories
       SET ${sets.join(', ')}
       WHERE id = $${idx++}::uuid AND tenant_id = $${idx}::uuid
       RETURNING id, name, slug, tenant_id, description, sort_order, is_public`,
      params,
    );

    const updated = result.rows[0];
    if (!updated) throw new AppError('Danh mục khóa học không tồn tại', 404);
    if (auditEntry) await appendAuditLog(client, auditEntry(current.rows[0], updated, removedAssignments));

    await client.query('COMMIT');
    await invalidateTenantCourseCaches(tenantId);
    return { ...updated, removed_assignments: removedAssignments };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteCourseCategory(catId: string, tenantId: string) {
  const result = await query<{ id: string; tenant_id: string; name: string }>(
    'DELETE FROM course_categories WHERE id = $1::uuid AND tenant_id = $2::uuid RETURNING id, tenant_id, name',
    [catId, tenantId],
  );
  if (result.rowCount === 0) throw new AppError('Danh mục khóa học không tồn tại hoặc không thuộc tenant hiện tại', 404);
  await invalidateTenantCourseCaches(result.rows[0].tenant_id);
  return result.rows[0];
}

export async function getCategoryCourses(catId: string, tenantId: string) {
  const result = await query(
    `SELECT ccc.id, ccc.course_id, c.display_name, ccc.assigned_at
     FROM course_category_courses ccc
     JOIN course_categories cc ON cc.id = ccc.category_id
     JOIN courses c ON c.id = ccc.course_id AND c.tenant_id = cc.tenant_id
     WHERE ccc.category_id = $1::uuid
       AND cc.tenant_id = $2::uuid
     ORDER BY ccc.assigned_at DESC`,
    [catId, tenantId],
  );
  return { results: result.rows, count: result.rowCount || 0 };
}

export async function addCoursesToCategory(catId: string, tenantId: string, courseIds: string[]) {
  const normalizedCourseIds = normalizeCourseIds(courseIds);
  if (normalizedCourseIds.length > 500) throw new AppError('Tối đa 500 khóa học mỗi lần gán danh mục', 400);

  const category = await getCategoryContext(catId, tenantId);
  if (!category) throw new AppError('Danh mục khóa học không tồn tại hoặc không thuộc tenant hiện tại', 404);
  if (normalizedCourseIds.length === 0) return { assigned: 0, skipped: 0, categoryName: category.name, conflicts: [] };

  const conflictsR = await query<{ course_id: string; display_name: string; category_name: string }>(
    `SELECT ccc.course_id,
            COALESCE(c.display_name, ccc.course_id) AS display_name,
            string_agg(DISTINCT cc.name, ', ' ORDER BY cc.name) AS category_name
     FROM course_category_courses ccc
     JOIN course_categories cc ON cc.id = ccc.category_id
     LEFT JOIN courses c ON c.id = ccc.course_id AND c.tenant_id = cc.tenant_id
     WHERE ccc.course_id = ANY($1::varchar[])
       AND cc.tenant_id = $2::uuid
       AND ccc.category_id <> $3::uuid
     GROUP BY ccc.course_id, c.display_name`,
    [normalizedCourseIds, category.tenant_id, catId],
  );

  const inserted = await query<{ course_id: string }>(
    `INSERT INTO course_category_courses (category_id, course_id)
     SELECT $1::uuid, c.id
     FROM courses c
     WHERE c.id = ANY($2::varchar[])
       AND c.tenant_id = $3::uuid
       AND c.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1
         FROM course_category_courses existing
         WHERE existing.course_id = c.id
       )
     ON CONFLICT DO NOTHING
     RETURNING course_id`,
    [catId, normalizedCourseIds, category.tenant_id],
  );

  await invalidateTenantCourseCaches(category.tenant_id);
  const assigned = inserted.rowCount || 0;
  return {
    assigned,
    skipped: Math.max(0, normalizedCourseIds.length - assigned),
    categoryName: category.name,
    conflicts: conflictsR.rows,
  };
}

export async function removeCourseFromCategory(catId: string, tenantId: string, courseId: string) {
  const context = await query<{ tenant_id: string; category_name: string; course_name: string | null }>(
    `SELECT cc.tenant_id,
            cc.name AS category_name,
            c.display_name AS course_name
     FROM course_categories cc
     LEFT JOIN courses c ON c.id = $2 AND c.tenant_id = cc.tenant_id
     WHERE cc.id = $1::uuid
       AND cc.tenant_id = $3::uuid`,
    [catId, courseId, tenantId],
  );
  if (context.rowCount === 0) throw new AppError('Danh mục khóa học không tồn tại hoặc không thuộc tenant hiện tại', 404);

  await removeCourseFromCategoryFromDb(catId, tenantId, courseId);
  await Promise.all([
    invalidateTenantCourseCaches(tenantId),
    invalidateCourseReadCaches(courseId, tenantId),
  ]);
  return {
    success: true,
    categoryName: context.rows[0]?.category_name || catId,
    courseName: context.rows[0]?.course_name || courseId,
  };
}

async function removeCourseFromCategoryFromDb(catId: string, tenantId: string, courseId: string) {
  const result = await query(
    `DELETE FROM course_category_courses ccc
     USING course_categories cc
     WHERE cc.id = ccc.category_id
       AND ccc.category_id = $1::uuid
       AND cc.tenant_id = $2::uuid
       AND ccc.course_id = $3
     RETURNING ccc.id`,
    [catId, tenantId, courseId],
  );
  if (result.rowCount === 0) throw new AppError('Liên kết không tồn tại', 404);
}




