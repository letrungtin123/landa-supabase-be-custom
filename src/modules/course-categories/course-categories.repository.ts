// ═══════════════════════════════════════════════════════════════
// Course categories repository: categories, the teams a category is
// assigned to, and the courses of a category. SQL only; moved unchanged
// from course-categories.service.ts, which keeps the rules (slug, public
// switch, course id cleanup, transactions, audit, cache invalidation).
// ═══════════════════════════════════════════════════════════════

import type { QueryResult, QueryResultRow } from 'pg';

/** The pool query() (joins the current transaction) or a transaction client. */
export interface CourseCategoriesDb {
  query<T extends QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface CourseCategoryContextRow {
  id: string;
  tenant_id: string;
  name: string;
  is_public: boolean;
}

export type CourseCategoryPublicImpactRow = {
  group_id: string;
  group_name: string;
  subgroup_id: string;
  subgroup_name: string;
  team_id: string;
  team_name: string;
  assigned_at: string | null;
};

/** A whole course_categories row (`cc.*`) with its course count (text) and, on request, the team flag. */
export interface CourseCategoryListRow {
  id: string;
  tenant_id: string;
  name: string;
  course_count: string;
  is_assigned_to_team?: boolean;
  [column: string]: unknown;
}

export interface CourseCategoryPageFilter {
  tenantId: string | null;
  search: string | undefined;
  assignedTeamId: string | null;
}

export interface CourseCategoryAuditRow {
  id: string;
  tenant_id: string;
  name: string;
  sort_order: number;
  is_public: boolean;
}

export interface UpdatedCourseCategoryRow extends CourseCategoryAuditRow {
  slug: string;
  description: string;
}

/** Columns the category update may write, in the order the service lists them. */
export type CourseCategoryColumn = 'name' | 'slug' | 'description' | 'sort_order' | 'is_public';

export interface CategoryCourseRow {
  id: string;
  course_id: string;
  display_name: string;
  assigned_at: Date;
}

export interface CategoryConflictRow {
  course_id: string;
  display_name: string;
  category_name: string;
}

export function createCourseCategoriesRepository(db: CourseCategoriesDb) {
  return {
    /** The category, limited to the tenant when one is given. */
    async selectCategoryContext(catId: string, tenantId?: string | null): Promise<CourseCategoryContextRow | null> {
      const params: unknown[] = [catId];
      const tenantClause = tenantId ? 'AND tenant_id = $2::uuid' : '';
      if (tenantId) params.push(tenantId);
      const result = await db.query<CourseCategoryContextRow>(
        `SELECT id, tenant_id, name, COALESCE(is_public, false) AS is_public
     FROM course_categories
     WHERE id = $1::uuid ${tenantClause}
     LIMIT 1`,
        params,
      );
      return result.rows[0] ?? null;
    },

    /** Teams of the tenant the category is assigned to: their number and the first `limit` by name. */
    async selectPublicImpact(
      catId: string,
      tenantId: string,
      limit: number,
    ): Promise<{ countRow: { count: string } | undefined; rows: CourseCategoryPublicImpactRow[] }> {
      const [countR, dataR] = await Promise.all([
        db.query<{ count: string }>(
          `SELECT COUNT(DISTINCT tcc.team_id)::int AS count
       FROM team_course_categories tcc
       JOIN teams t ON t.id = tcc.team_id
       JOIN sub_groups sg ON sg.id = t.sub_group_id
       JOIN org_groups og ON og.id = sg.org_group_id
       WHERE tcc.category_id = $1::uuid
         AND og.tenant_id = $2::uuid`,
          [catId, tenantId],
        ),
        db.query<CourseCategoryPublicImpactRow>(
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
          [catId, tenantId, limit],
        ),
      ]);
      return { countRow: countR.rows[0], rows: dataR.rows };
    },

    /** Every category (of the tenant, when one is given) with its course count, in order. */
    async selectAllCategories(tenantId: string | null): Promise<CourseCategoryListRow[]> {
      const params: unknown[] = [];
      let where = '';
      if (tenantId) { params.push(tenantId); where = `WHERE cc.tenant_id = $1`; }

      const result = await db.query<CourseCategoryListRow>(
        `SELECT cc.*,
              (SELECT COUNT(*) FROM course_category_courses ccc WHERE ccc.category_id = cc.id) AS course_count
       FROM course_categories cc ${where}
       ORDER BY cc.sort_order, cc.name`,
        params,
      );
      return result.rows;
    },

    /** One page of categories (with the team flag when `assignedTeamId` is given) and their number. */
    async selectCategoryPage(
      filter: CourseCategoryPageFilter,
      pageSize: number,
      offset: number,
    ): Promise<{ countRow: { count: string }; rows: CourseCategoryListRow[] }> {
      const { tenantId, search, assignedTeamId } = filter;
      const params: unknown[] = [];
      const conditions: string[] = [];

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
        db.query<{ count: string }>(`SELECT COUNT(*) AS count FROM course_categories cc ${where}`, params),
        db.query<CourseCategoryListRow>(
          `SELECT cc.*,
              (SELECT COUNT(*) FROM course_category_courses ccc WHERE ccc.category_id = cc.id) AS course_count${assignedSelect}
       FROM course_categories cc ${where}
       ORDER BY cc.sort_order, cc.name
       LIMIT $${dataParams.length + 1} OFFSET $${dataParams.length + 2}`,
          [...dataParams, pageSize, offset],
        ),
      ]);
      return { countRow: countR.rows[0], rows: dataR.rows };
    },

    async insertCategory(
      tenantId: string,
      name: string,
      slug: string,
      description: string,
      sortOrder: number,
    ): Promise<{ id: string; name: string; slug: string }> {
      const result = await db.query<{ id: string; name: string; slug: string }>(
        'INSERT INTO course_categories (tenant_id, name, slug, description, sort_order) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, slug',
        [tenantId, name, slug, description, sortOrder],
      );
      return result.rows[0];
    },

    /** The category of the tenant, row-locked (FOR UPDATE) until commit. */
    async lockCategory(catId: string, tenantId: string): Promise<CourseCategoryAuditRow | null> {
      const current = await db.query<CourseCategoryAuditRow>(
        `SELECT id, tenant_id, name, sort_order, COALESCE(is_public, false) AS is_public
       FROM course_categories
       WHERE id = $1::uuid AND tenant_id = $2::uuid
       FOR UPDATE`,
        [catId, tenantId],
      );
      return current.rowCount === 0 ? null : current.rows[0];
    },

    /** Removes the category from every team of the tenant; the number removed. */
    async deleteTeamAssignments(catId: string, tenantId: string): Promise<number> {
      const removed = await db.query(
        `DELETE FROM team_course_categories tcc
         USING teams t
         JOIN sub_groups sg ON sg.id = t.sub_group_id
         JOIN org_groups og ON og.id = sg.org_group_id
         WHERE tcc.team_id = t.id
           AND tcc.category_id = $1::uuid
           AND og.tenant_id = $2::uuid`,
        [catId, tenantId],
      );
      return removed.rowCount || 0;
    },

    /** Writes `columns` to the category of the tenant; the updated row, or undefined. */
    async updateCategoryColumns(
      catId: string,
      tenantId: string,
      columns: [CourseCategoryColumn, unknown][],
    ): Promise<UpdatedCourseCategoryRow | undefined> {
      const sets: string[] = [];
      const params: unknown[] = [];
      let idx = 1;
      for (const [column, value] of columns) {
        sets.push(`${column} = $${idx++}`);
        params.push(value);
      }
      params.push(catId, tenantId);
      const result = await db.query<UpdatedCourseCategoryRow>(
        `UPDATE course_categories
       SET ${sets.join(', ')}
       WHERE id = $${idx++}::uuid AND tenant_id = $${idx}::uuid
       RETURNING id, name, slug, tenant_id, description, sort_order, is_public`,
        params,
      );
      return result.rows[0];
    },

    /** Deletes the category of the tenant; the deleted row, or null. */
    async deleteCategory(catId: string, tenantId: string): Promise<{ id: string; tenant_id: string; name: string } | null> {
      const result = await db.query<{ id: string; tenant_id: string; name: string }>(
        'DELETE FROM course_categories WHERE id = $1::uuid AND tenant_id = $2::uuid RETURNING id, tenant_id, name',
        [catId, tenantId],
      );
      return result.rowCount === 0 ? null : result.rows[0];
    },

    /** The category's courses of its own tenant, newest assignment first. */
    async selectCategoryCourses(catId: string, tenantId: string): Promise<{ rows: CategoryCourseRow[]; count: number }> {
      const result = await db.query<CategoryCourseRow>(
        `SELECT ccc.id, ccc.course_id, c.display_name, ccc.assigned_at
     FROM course_category_courses ccc
     JOIN course_categories cc ON cc.id = ccc.category_id
     JOIN courses c ON c.id = ccc.course_id AND c.tenant_id = cc.tenant_id
     WHERE ccc.category_id = $1::uuid
       AND cc.tenant_id = $2::uuid
     ORDER BY ccc.assigned_at DESC`,
        [catId, tenantId],
      );
      return { rows: result.rows, count: result.rowCount || 0 };
    },

    /** Courses among `courseIds` already in another category of the tenant, with those categories' names. */
    async selectCategoryConflicts(courseIds: string[], tenantId: string, catId: string): Promise<CategoryConflictRow[]> {
      const conflictsR = await db.query<CategoryConflictRow>(
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
        [courseIds, tenantId, catId],
      );
      return conflictsR.rows;
    },

    /** Adds the tenant's courses (not deleted, in no category yet) to the category; the number added. */
    async insertCategoryCourses(catId: string, courseIds: string[], tenantId: string): Promise<number> {
      const inserted = await db.query<{ course_id: string }>(
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
        [catId, courseIds, tenantId],
      );
      return inserted.rowCount || 0;
    },

    /** Category and course names for removing a course (the category must be the tenant's). */
    async selectRemovalContext(
      catId: string,
      courseId: string,
      tenantId: string,
    ): Promise<{ tenant_id: string; category_name: string; course_name: string | null } | null> {
      const context = await db.query<{ tenant_id: string; category_name: string; course_name: string | null }>(
        `SELECT cc.tenant_id,
            cc.name AS category_name,
            c.display_name AS course_name
     FROM course_categories cc
     LEFT JOIN courses c ON c.id = $2 AND c.tenant_id = cc.tenant_id
     WHERE cc.id = $1::uuid
       AND cc.tenant_id = $3::uuid`,
        [catId, courseId, tenantId],
      );
      return context.rowCount === 0 ? null : context.rows[0];
    },

    /** Removes the course from the tenant's category; false when it was not in it. */
    async deleteCategoryCourse(catId: string, tenantId: string, courseId: string): Promise<boolean> {
      const result = await db.query(
        `DELETE FROM course_category_courses ccc
     USING course_categories cc
     WHERE cc.id = ccc.category_id
       AND ccc.category_id = $1::uuid
       AND cc.tenant_id = $2::uuid
       AND ccc.course_id = $3
     RETURNING ccc.id`,
        [catId, tenantId, courseId],
      );
      return result.rowCount !== 0;
    },
  };
}
