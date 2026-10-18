// ═══════════════════════════════════════════════════════════════
// Learner courses repository: the course access check, the visible course
// list, a course's detail, its published block tree, one block, and the
// course's reference files. SQL only; moved unchanged from learner.service.ts,
// which keeps the role rules, caching and the mapping of rows to answers.
// ═══════════════════════════════════════════════════════════════

import type { QueryResult, QueryResultRow } from 'pg';
import { learnerCourseAccessCondition, publicCourseCategoryCondition } from '../courses/course-access.js';

/** The pool query() (joins the current transaction). */
export interface LearnerDb {
  query<T extends QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface VisibleCourseRow {
  id: string;
  display_name: string;
  org: string | null;
  image_url: string | null;
  start_date: string | null;
  end_date: string | null;
  visible_to_staff_only: boolean;
  is_public: boolean;
  created_at: string;
  full_count: string;
}

export interface CourseCategoryRow {
  course_id: string;
  id: string;
  name: string;
}

export interface CourseDetailRow extends Omit<VisibleCourseRow, 'full_count'> {
  mentor_id: string | null;
  mentor_full_name: string | null;
  mentor_email: string | null;
  mentor_phone: string | null;
  mentor_avatar: string | null;
  mentor_bio: string | null;
  mentor_role: string | null;
  mentor_section_description: string | null;
  mentor_section_logo_light: string | null;
  mentor_section_logo_dark: string | null;
}

/** A published block of the course or one block, as the learner routes read it. */
export interface LearnerBlockRow extends Record<string, unknown> {
  id: string;
  course_id: string;
  parent_id: string | null;
  block_type: string;
  display_name: string | null;
  data: unknown;
  metadata: unknown;
  sort_order: number | null;
  is_published: boolean;
}

/** The block a learner submits an answer to. */
export interface SubmittableBlockRow {
  id: string;
  block_type: string;
  data: unknown;
  metadata: unknown;
  course_id: string;
}

export interface CourseFileRow {
  id: string;
  display_name: string | null;
  content_type: string | null;
  file_size: string | null;
  url: string | null;
  is_locked: boolean;
  is_reference: boolean;
  created_at: string;
}

export function createLearnerCoursesRepository(db: LearnerDb) {
  return {
    /**
     * Whether the course exists in the tenant (not deleted); with
     * `learnerUserId`, also whether that learner may open it.
     */
    async courseAccessible(input: { courseId: string; tenantId: string; learnerUserId?: string }): Promise<boolean> {
      const params: unknown[] = [input.courseId, input.tenantId];
      const conditions = ['c.id = $1', 'c.tenant_id = $2', 'c.deleted_at IS NULL'];
      if (input.learnerUserId !== undefined) {
        params.push(input.learnerUserId);
        conditions.push(learnerCourseAccessCondition('c', `$${params.length}`));
      }

      const result = await db.query<{ id: string }>(
        `SELECT c.id
     FROM courses c
     WHERE ${conditions.join(' AND ')}
     LIMIT 1`,
        params,
      );
      return result.rowCount !== 0;
    },

    /** Whether the section (chapter) is a live block of the course. */
    async sectionOfCourse(sectionId: string, courseId: string): Promise<boolean> {
      const result = await db.query<Record<string, unknown>>(
        `SELECT 1 FROM course_blocks
     WHERE id = $1::uuid AND course_id = $2 AND deleted_at IS NULL
     LIMIT 1`,
        [sectionId, courseId],
      );
      return result.rowCount !== 0;
    },

    /**
     * One page of the tenant's courses, newest first, with the total count;
     * with `learnerUserId`, only the courses that learner may open.
     */
    async selectVisibleCourses(input: {
      tenantId: string;
      learnerUserId?: string;
      categoryId?: string;
      search?: string;
      limit: number;
      offset: number;
    }): Promise<VisibleCourseRow[]> {
      const { learnerUserId, categoryId, search } = input;
      const sqlParams: unknown[] = [input.tenantId];
      let where = 'WHERE c.tenant_id = $1 AND c.deleted_at IS NULL';

      // learner: chỉ thấy courses assign qua team → category → course
      // Path: team_members → team_course_categories → course_category_courses
      // Fallback: team_courses (direct assignment, backward compat)
      if (learnerUserId !== undefined) {
        sqlParams.push(learnerUserId);
        where += ` AND ${learnerCourseAccessCondition('c', `$${sqlParams.length}`)}`;
      }

      // Filter theo category_id
      if (categoryId) {
        sqlParams.push(categoryId);
        where += ` AND c.id IN (SELECT course_id FROM course_category_courses WHERE category_id = $${sqlParams.length})`;
      }

      if (search) {
        sqlParams.push(`%${search}%`);
        where += ` AND (unaccent(c.display_name) ILIKE unaccent($${sqlParams.length}) OR unaccent(c.org) ILIKE unaccent($${sqlParams.length}))`;
      }

      sqlParams.push(input.limit, input.offset);
      const result = await db.query<VisibleCourseRow>(
        `SELECT c.id, c.display_name, c.org, c.image_url, c.start_date, c.end_date,
            c.visible_to_staff_only, ${publicCourseCategoryCondition('c.id', 'c.tenant_id')} AS is_public, c.created_at,
            COUNT(*) OVER() AS full_count
     FROM courses c
     ${where}
     ORDER BY c.created_at DESC
     LIMIT $${sqlParams.length - 1} OFFSET $${sqlParams.length}`,
        sqlParams,
      );
      return result.rows;
    },

    /** The categories of the courses, by category name. */
    async selectCategoriesOfCourses(courseIds: string[]): Promise<CourseCategoryRow[]> {
      const catResult = await db.query<CourseCategoryRow>(
        `SELECT ccc.course_id, cc.id, cc.name
       FROM course_category_courses ccc
       JOIN course_categories cc ON cc.id = ccc.category_id
       WHERE ccc.course_id = ANY($1)
       ORDER BY cc.name`,
        [courseIds],
      );
      return catResult.rows;
    },

    /**
     * The categories of the course filter: every category of the tenant;
     * with `learnerUserId`, only public ones and those of the learner's teams.
     */
    async selectFilterCategories(tenantId: string, learnerUserId?: string): Promise<Array<{ id: string; name: string }>> {
      const learner = learnerUserId !== undefined;
      const allCatsResult = await db.query<{ id: string; name: string }>(
        learner
          ? `SELECT DISTINCT cc.id, cc.name
         FROM course_categories cc
         WHERE cc.tenant_id = $1
           AND (
             COALESCE(cc.is_public, false) = true
             OR EXISTS (
               SELECT 1
               FROM team_course_categories tcc
               JOIN team_members tm ON tm.team_id = tcc.team_id
               WHERE tcc.category_id = cc.id
                 AND tm.user_id = $2
             )
           )
         ORDER BY cc.name`
          : `SELECT DISTINCT cc.id, cc.name
         FROM course_categories cc
         WHERE cc.tenant_id = $1
         ORDER BY cc.name`,
        learner ? [tenantId, learnerUserId] : [tenantId],
      );
      return allCatsResult.rows;
    },

    /** The course of the tenant with its mentor and mentor section. */
    async selectCourseDetail(courseId: string, tenantId: string): Promise<CourseDetailRow | undefined> {
      const result = await db.query<CourseDetailRow>(
        `SELECT c.id, c.display_name, c.org, c.image_url, c.start_date, c.end_date,
            c.visible_to_staff_only, ${publicCourseCategoryCondition('c.id', 'c.tenant_id')} AS is_public, c.created_at,
            mentor.id AS mentor_id,
            mentor.full_name AS mentor_full_name,
            mentor.email AS mentor_email,
            mentor.phone AS mentor_phone,
            mentor.avatar_url AS mentor_avatar,
            mentor.bio AS mentor_bio,
            mentor.role AS mentor_role,
            cms.description AS mentor_section_description,
            cms.logo_light_path AS mentor_section_logo_light,
            cms.logo_dark_path AS mentor_section_logo_dark
     FROM courses c
     LEFT JOIN users mentor ON mentor.id = c.mentor_id
     LEFT JOIN course_mentor_sections cms ON cms.course_id = c.id AND cms.tenant_id = c.tenant_id
     WHERE c.id = $1 AND c.tenant_id = $2 AND c.deleted_at IS NULL`,
        [courseId, tenantId],
      );
      return result.rowCount === 0 ? undefined : result.rows[0];
    },

    /** The blocks the learner completed in their active enrollment of the course. */
    async selectCompletedBlockIds(courseId: string, userId: string): Promise<string[]> {
      // The learner's active enrollment (at most one per user and course).
      const result = await db.query<{ block_id: string }>(
        `WITH enrollment AS (
       SELECT id FROM enrollments WHERE course_id = $1 AND user_id = $2 AND is_active = true LIMIT 1
     )
     SELECT bc.block_id
     FROM enrollment e
     JOIN block_completions bc ON bc.enrollment_id = e.id`,
        [courseId, userId],
      );
      return result.rows.map(row => row.block_id);
    },

    /** The published block tree of the course (published snapshot only), by sort order. */
    async selectPublishedBlockTree(courseId: string): Promise<Array<Record<string, unknown>>> {
      // FE Learner (5173) LUÔN chỉ hiển thị published data, bất kể role.
      // Staff/admin muốn xem draft → dùng CMS route, KHÔNG dùng learner route.
      // Learner route must read the immutable published snapshot only.  Falling
      // back to metadata would leak a saved-but-unpublished diagram draft.
      const result = await db.query<Record<string, unknown>>(
        `WITH RECURSIVE active_tree AS (
       SELECT b.id, b.parent_id, b.block_type, b.display_name,
              b.published_data, b.published_metadata,
              b.sort_order, b.is_published
       FROM course_blocks b
       WHERE b.course_id = $1
         AND b.parent_id IS NULL
         AND b.deleted_at IS NULL AND b.is_published = true
       UNION ALL
       SELECT child.id, child.parent_id, child.block_type, child.display_name,
              child.published_data, child.published_metadata,
              child.sort_order, child.is_published
       FROM course_blocks child
       JOIN active_tree parent ON parent.id = child.parent_id
       WHERE child.deleted_at IS NULL AND child.is_published = true
     )
     SELECT b.id, b.parent_id, b.block_type, b.display_name,
            b.published_data AS data, b.published_metadata AS metadata,
            b.sort_order, b.is_published
     FROM active_tree b
     ORDER BY b.sort_order`,
        [courseId],
      );
      return result.rows;
    },

    /** One live block (no deleted ancestor, course not deleted) with its published snapshot. */
    async selectBlockDetail(blockId: string): Promise<LearnerBlockRow | undefined> {
      // Learner route must never fall back to a block's draft columns.
      const dataCol = 'b.published_data';
      const metaCol = 'b.published_metadata';

      const result = await db.query<LearnerBlockRow>(
        `WITH RECURSIVE ancestors AS (
       SELECT id, parent_id, deleted_at
       FROM course_blocks
       WHERE id = $1
       UNION ALL
       SELECT parent.id, parent.parent_id, parent.deleted_at
       FROM course_blocks parent
       JOIN ancestors a ON parent.id = a.parent_id
     )
     SELECT b.id, b.course_id, b.parent_id, b.block_type, b.display_name,
            ${dataCol} AS data, ${metaCol} AS metadata,
            b.sort_order, b.is_published
     FROM course_blocks b
     JOIN courses c ON c.id = b.course_id
     WHERE b.id = $1
       AND b.deleted_at IS NULL
       AND c.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM ancestors WHERE deleted_at IS NOT NULL)`,
        [blockId],
      );
      return result.rowCount === 0 ? undefined : result.rows[0];
    },

    /** A published live block to grade, with its published snapshot (never the draft). */
    async selectSubmittableBlock(blockId: string): Promise<SubmittableBlockRow | undefined> {
      // Lấy block data — luôn dùng snapshot published, kể cả khi snapshot null.
      // Không fallback sang draft vì learner không được thấy hay dùng nội dung chưa publish.
      const blockResult = await db.query<SubmittableBlockRow>(
        `WITH RECURSIVE ancestors AS (
       SELECT id, parent_id, deleted_at
       FROM course_blocks
       WHERE id = $1
       UNION ALL
       SELECT parent.id, parent.parent_id, parent.deleted_at
       FROM course_blocks parent
       JOIN ancestors a ON parent.id = a.parent_id
     )
     SELECT b.id, b.block_type,
            b.published_data AS data,
            b.published_metadata AS metadata,
            b.course_id
     FROM course_blocks b
     JOIN courses c ON c.id = b.course_id
     WHERE b.id = $1
       AND b.is_published = true
       AND b.deleted_at IS NULL
       AND c.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM ancestors WHERE deleted_at IS NOT NULL)`,
        [blockId],
      );
      return blockResult.rowCount === 0 ? undefined : blockResult.rows[0];
    },

    /** The course's reference files of its own tenant, newest first; `learnerView` hides locked ones. */
    async selectCourseFiles(courseId: string, learnerView: boolean): Promise<{ rows: CourseFileRow[]; rowCount: number | null }> {
      const lockedFilter = learnerView ? 'AND is_locked = false' : '';
      const result = await db.query<CourseFileRow>(
        `SELECT id, display_name, content_type, file_size, url, is_locked, is_reference, created_at
     FROM course_assets
     WHERE course_id = $1
       -- The asset must belong to the course's own tenant (rows injected from
       -- another tenant before the upload check existed stay hidden).
       AND EXISTS (
         SELECT 1 FROM courses c
         WHERE c.id = course_assets.course_id
           AND c.tenant_id = course_assets.tenant_id
           AND c.deleted_at IS NULL
       )
       AND is_reference = true
       ${lockedFilter}
     ORDER BY created_at DESC`,
        [courseId],
      );
      return { rows: result.rows, rowCount: result.rowCount };
    },
  };
}

export type LearnerCoursesRepository = ReturnType<typeof createLearnerCoursesRepository>;
