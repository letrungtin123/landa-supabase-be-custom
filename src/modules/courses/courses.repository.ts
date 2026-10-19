// ═══════════════════════════════════════════════════════════════
// Courses repository: the staff course list, Markdown export, create,
// update, bulk visibility, the course mentor and its assignment history.
// SQL only; moved unchanged from courses.service.ts, which keeps the rules
// (quota, which fields may change, transactions, audit, cache invalidation).
// ═══════════════════════════════════════════════════════════════

import type { QueryResult, QueryResultRow } from 'pg';
import type { CourseMarkdownBlock, CourseMarkdownCourse } from './course-markdown-exporter.js';

/** The pool query() (joins the current transaction) or a transaction client. */
export interface CoursesDb {
  query<T extends QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

/** Timestamps are typed as the answer types them: pg's Date reaches the client as ISO text. */
export interface CourseSnapshotRow {
  id: string;
  tenant_id: string;
  display_name: string;
  visible_to_staff_only: boolean;
  image_url: string | null;
}

/** A whole courses row (`RETURNING *`, `c.*`): the columns the code reads, and every other column. */
export interface CourseRow extends CourseSnapshotRow {
  [column: string]: unknown;
}

/** The mentor columns of a course row, null when the course has no mentor. */
export interface CourseMentorColumns {
  mentor_id: string | null;
  mentor_username: string | null;
  mentor_full_name: string | null;
  mentor_email: string | null;
  mentor_phone: string | null;
  mentor_avatar: string | null;
  mentor_role: string | null;
  mentor_bio: string | null;
}

export interface CourseListRow extends CourseRow, CourseMentorColumns {
  category_id: string | null;
  category_name: string | null;
  is_public: boolean;
  creator_id: string | null;
  creator_display_name: string | null;
}

export interface MentorUserRow {
  id: string;
  username: string;
  email: string;
  full_name: string | null;
  phone: string | null;
  avatar: string | null;
  role: string;
  bio: string | null;
}

export interface MentorCandidateRow extends MentorUserRow {
  full_count: string;
}

export interface LockedCourseMentorRow {
  mentor_id: string | null;
  display_name: string;
  mentor_name: string | null;
}

export interface MentorAssignmentHistoryRow {
  id: string;
  assigned_by: string | null;
  assigned_to: string | null;
  assigned_by_display_name: string | null;
  assigned_to_display_name: string | null;
  action: 'assign' | 'remove';
  assigned_at: string;
}

export interface CourseListFilter {
  tenantId: string | null;
  search: string | undefined;
  visibility: string;
}

export interface CourseCreateValues {
  id: string;
  tenantId: string;
  displayName: string;
  description: string;
  org: string;
  visibleToStaffOnly: boolean;
  imageUrl: string;
  startDate: string | null;
  endDate: string | null;
  createdBy: string;
}

export interface CourseUpdateValues {
  display_name?: string;
  description?: string;
  visible_to_staff_only?: boolean;
  image_url?: string;
}

export interface MentorHistoryFilter {
  tenantId: string;
  courseId: string;
  dateFrom: string | null;
  dateTo: string | null;
  /** The LIKE pattern, already escaped and wrapped in %. */
  searchPattern: string | null;
}

export interface MentorHistoryInsert {
  tenantId: string;
  courseId: string;
  assignedBy: string | null;
  assignedTo: string | null;
  assignedByName: string;
  assignedToName: string | null;
  action: 'assign' | 'remove';
}

/** WHERE of the staff course list and its parameters. */
function courseListWhere(filter: CourseListFilter): { where: string; params: unknown[] } {
  const params: unknown[] = [];
  const conditions: string[] = ['c.deleted_at IS NULL'];

  if (filter.tenantId) { params.push(filter.tenantId); conditions.push(`c.tenant_id = $${params.length}`); }
  if (filter.search) { params.push(`%${filter.search}%`); conditions.push(`c.display_name ILIKE $${params.length}`); }
  const vis = filter.visibility;
  if (vis === 'staff_only') conditions.push('c.visible_to_staff_only = true');
  else if (vis === 'public') conditions.push('c.visible_to_staff_only = false');

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return { where, params };
}

/** WHERE of the mentor assignment history and its parameters. */
function mentorHistoryWhere(filter: MentorHistoryFilter): { where: string; params: unknown[] } {
  const params: unknown[] = [filter.tenantId, filter.courseId];
  const conditions = ['tenant_id = $1', 'course_id = $2'];

  if (filter.dateFrom) {
    params.push(filter.dateFrom);
    conditions.push(`assigned_at >= $${params.length}::timestamptz`);
  }

  if (filter.dateTo) {
    params.push(filter.dateTo);
    conditions.push(`assigned_at < $${params.length}::timestamptz`);
  }

  if (filter.searchPattern) {
    params.push(filter.searchPattern);
    conditions.push(`lower(COALESCE(assigned_by_display_name, '') || ' ' || COALESCE(assigned_to_display_name, '')) LIKE $${params.length} ESCAPE '\\'`);
  }

  return { where: conditions.join(' AND '), params };
}

export function createCoursesRepository(db: CoursesDb) {
  return {
    /** The course's name when it exists in the tenant and is not deleted. */
    async selectCourseName(courseId: string, tenantId: string): Promise<{ display_name: string } | null> {
      const result = await db.query<{ display_name: string }>(
        'SELECT display_name FROM courses WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL',
        [courseId, tenantId],
      );
      return result.rowCount === 0 ? null : result.rows[0];
    },

    /** Number of courses of the staff list filter, as text (COUNT(*) always answers one row). */
    async countCourses(filter: CourseListFilter): Promise<{ count: string }> {
      const { where, params } = courseListWhere(filter);
      const result = await db.query<{ count: string }>(`SELECT COUNT(*) AS count FROM courses c ${where}`, params);
      return result.rows[0];
    },

    /** One page of the staff list, last updated first, with category, public flag, creator and mentor. */
    async selectCoursePage(filter: CourseListFilter, pageSize: number, offset: number): Promise<CourseListRow[]> {
      const { where, params } = courseListWhere(filter);
      const result = await db.query<CourseListRow>(
        `SELECT c.*,
              current_category.category_id,
              current_category.category_name,
              EXISTS (
                SELECT 1
                FROM course_category_courses ccc_public
                JOIN course_categories cc_public ON cc_public.id = ccc_public.category_id
                WHERE ccc_public.course_id = c.id
                  AND cc_public.tenant_id = c.tenant_id
                  AND COALESCE(cc_public.is_public, false) = true
              ) AS is_public,
              creator.id AS creator_id,
              NULLIF(creator.full_name, '') AS creator_display_name,
              mentor.id AS mentor_id,
              mentor.username AS mentor_username,
              mentor.full_name AS mentor_full_name,
              mentor.email AS mentor_email,
              mentor.phone AS mentor_phone,
              mentor.avatar_url AS mentor_avatar,
              mentor.role AS mentor_role,
              mentor.bio AS mentor_bio
       FROM courses c
       LEFT JOIN users creator ON creator.id = c.created_by
       LEFT JOIN users mentor ON mentor.id = c.mentor_id
       LEFT JOIN LATERAL (
         SELECT cc.id AS category_id,
                cc.name AS category_name
         FROM course_category_courses ccc_current
         JOIN course_categories cc
           ON cc.id = ccc_current.category_id
          AND cc.tenant_id = c.tenant_id
         WHERE ccc_current.course_id = c.id
         ORDER BY ccc_current.assigned_at DESC NULLS LAST, ccc_current.id DESC
         LIMIT 1
       ) current_category ON true
       ${where}
       ORDER BY c.updated_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, pageSize, offset],
      );
      return result.rows;
    },

    /** The course fields of the Markdown export, when the course is in the tenant and not deleted. */
    async selectMarkdownCourse(courseId: string, tenantId: string): Promise<CourseMarkdownCourse | null> {
      const result = await db.query<CourseMarkdownCourse>(
        `SELECT id, display_name, description, org, start_date, end_date, created_at, updated_at
     FROM courses
     WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
        [courseId, tenantId],
      );
      return result.rowCount === 0 ? null : result.rows[0];
    },

    /** The published, not deleted block tree of the course, in reading order. */
    async selectMarkdownBlocks(courseId: string): Promise<CourseMarkdownBlock[]> {
      const result = await db.query<CourseMarkdownBlock>(
        `WITH RECURSIVE active_tree AS (
       SELECT id, parent_id, block_type::text AS block_type, display_name,
              published_data AS data,
              COALESCE(published_metadata, metadata, '{}'::jsonb) AS metadata,
              sort_order, created_at
       FROM course_blocks
       WHERE course_id = $1
         AND parent_id IS NULL
         AND deleted_at IS NULL
         AND is_published = true
       UNION ALL
       SELECT child.id, child.parent_id, child.block_type::text AS block_type, child.display_name,
              child.published_data AS data,
              COALESCE(child.published_metadata, child.metadata, '{}'::jsonb) AS metadata,
              child.sort_order, child.created_at
       FROM course_blocks child
       JOIN active_tree parent ON parent.id = child.parent_id
       WHERE child.deleted_at IS NULL
         AND child.is_published = true
     )
     SELECT id, parent_id, block_type, display_name, data, metadata, sort_order, created_at
     FROM active_tree
     ORDER BY COALESCE(sort_order, 0), created_at, id`,
        [courseId],
      );
      return result.rows;
    },

    /** Inserts the course; its creator is also its first mentor. */
    async insertCourse(values: CourseCreateValues): Promise<CourseRow> {
      const result = await db.query<CourseRow>(
        `INSERT INTO courses (id, tenant_id, display_name, description, org, visible_to_staff_only, image_url, start_date, end_date, created_by, mentor_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
     RETURNING *`,
        [values.id, values.tenantId, values.displayName, values.description, values.org, values.visibleToStaffOnly, values.imageUrl, values.startDate, values.endDate, values.createdBy],
      );
      return result.rows[0];
    },

    /** Locks the course row of the tenant (not deleted) for the rest of the transaction. */
    async lockCourseSnapshot(courseId: string, tenantId: string): Promise<CourseSnapshotRow | null> {
      const result = await db.query<CourseSnapshotRow>(
        `SELECT id, tenant_id, display_name, visible_to_staff_only, image_url
       FROM courses
       WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
       FOR UPDATE`,
        [courseId, tenantId],
      );
      return result.rowCount === 0 ? null : result.rows[0];
    },

    /** Sets updated_at and every given field; null when the course is no longer there. */
    async updateCourseFields(courseId: string, tenantId: string, input: CourseUpdateValues): Promise<CourseRow | null> {
      const sets: string[] = ['updated_at = NOW()'];
      const params: unknown[] = [];
      let idx = 1;
      if (input.display_name !== undefined) { sets.push(`display_name = $${idx++}`); params.push(input.display_name); }
      if (input.description !== undefined) { sets.push(`description = $${idx++}`); params.push(input.description); }
      if (input.visible_to_staff_only !== undefined) { sets.push(`visible_to_staff_only = $${idx++}`); params.push(input.visible_to_staff_only); }
      if (input.image_url !== undefined) { sets.push(`image_url = $${idx++}`); params.push(input.image_url); }

      params.push(courseId, tenantId);
      const result = await db.query<CourseRow>(
        `UPDATE courses
       SET ${sets.join(', ')}
       WHERE id = $${idx++} AND tenant_id = $${idx} AND deleted_at IS NULL
       RETURNING *`,
        params,
      );
      return result.rows[0] ?? null;
    },

    /** Staff only (and so never public) or visible to learners, for the tenant's courses among `ids`. */
    async updateCoursesVisibility(ids: string[], staffOnly: boolean, tenantId: string): Promise<{ rows: Array<{ id: string; tenant_id: string }>; rowCount: number }> {
      const r = await db.query<{ id: string; tenant_id: string }>(
        `UPDATE courses
     SET visible_to_staff_only = $1,
         is_public = CASE WHEN $1::boolean THEN false ELSE is_public END,
         updated_at = NOW()
     WHERE id = ANY($2) AND tenant_id = $3 AND deleted_at IS NULL
     RETURNING id, tenant_id`,
        [staffOnly, ids, tenantId],
      );
      return { rows: r.rows, rowCount: r.rowCount || 0 };
    },

    /** The mentor columns of the course (all null without a mentor); null when the course is not in the tenant. */
    async selectCourseMentor(courseId: string, tenantId: string): Promise<CourseMentorColumns | null> {
      const result = await db.query<CourseMentorColumns>(
        `SELECT mentor.id AS mentor_id,
            mentor.username AS mentor_username,
            mentor.full_name AS mentor_full_name,
            mentor.email AS mentor_email,
            mentor.phone AS mentor_phone,
            mentor.avatar_url AS mentor_avatar,
            mentor.role AS mentor_role,
            mentor.bio AS mentor_bio
     FROM courses c
     LEFT JOIN users mentor ON mentor.id = c.mentor_id
     WHERE c.id = $1 AND c.tenant_id = $2 AND c.deleted_at IS NULL`,
        [courseId, tenantId],
      );
      return result.rowCount === 0 ? null : result.rows[0];
    },

    /** One page of the tenant's active staff and superusers, with the total in full_count. */
    async selectMentorCandidates(tenantId: string, search: string | undefined, pageSize: number, offset: number): Promise<MentorCandidateRow[]> {
      const params: unknown[] = [tenantId];
      const conditions = ['u.tenant_id = $1', "u.role IN ('staff', 'superuser')", 'u.is_active = true'];

      if (search) {
        params.push(`%${search.toLowerCase()}%`);
        conditions.push(`(
      lower(COALESCE(u.full_name, '')) LIKE $${params.length}
      OR lower(u.email) LIKE $${params.length}
      OR lower(u.username) LIKE $${params.length}
    )`);
      }

      const result = await db.query<MentorCandidateRow>(
        `SELECT u.id, u.username, u.email, u.full_name, u.phone, u.avatar_url AS avatar,
              u.role, u.bio, COUNT(*) OVER() AS full_count
     FROM users u
     WHERE ${conditions.join(' AND ')}
     ORDER BY COALESCE(NULLIF(u.full_name, ''), u.username), u.id
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, pageSize, offset],
      );
      return result.rows;
    },

    /** Locks the course row (not the optional mentor) and reads its mentor; null when not in the tenant. */
    async lockCourseMentor(courseId: string, tenantId: string): Promise<LockedCourseMentorRow | null> {
      const courseResult = await db.query<LockedCourseMentorRow>(
        `SELECT c.mentor_id, c.display_name,
              COALESCE(NULLIF(u.full_name, ''), u.username) AS mentor_name
       FROM courses c
       LEFT JOIN users u ON u.id = c.mentor_id
       WHERE c.id = $1 AND c.tenant_id = $2 AND c.deleted_at IS NULL
       -- The mentor join is optional. Lock only the course row; PostgreSQL
       -- rejects an unqualified FOR UPDATE on the nullable side of a LEFT JOIN.
       FOR UPDATE OF c`,
        [courseId, tenantId],
      );
      return courseResult.rowCount === 0 ? null : courseResult.rows[0];
    },

    /** The user when it is an active staff member or superuser of the tenant. */
    async selectEligibleMentor(mentorId: string, tenantId: string): Promise<MentorUserRow | null> {
      const mentorResult = await db.query<MentorUserRow>(
        `SELECT id, username, full_name, email, phone, avatar_url AS avatar, role, bio
         FROM users
         WHERE id = $1
           AND tenant_id = $2
           AND role IN ('staff', 'superuser')
           AND is_active = true`,
        [mentorId, tenantId],
      );
      return mentorResult.rowCount === 0 ? null : mentorResult.rows[0];
    },

    async updateCourseMentorId(courseId: string, tenantId: string, mentorId: string | null): Promise<void> {
      await db.query(
        `UPDATE courses
         SET mentor_id = $3, updated_at = NOW()
         WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
        [courseId, tenantId, mentorId],
      );
    },

    /** Full name, else username, else email of the user; null for an unknown user. */
    async selectUserDisplayName(userId: string): Promise<string | null> {
      const sql = `SELECT COALESCE(NULLIF(full_name, ''), username, email, 'Không xác định') AS display_name
               FROM users
               WHERE id = $1
               LIMIT 1`;
      const result = await db.query<{ display_name: string }>(sql, [userId]);
      return result.rows[0]?.display_name || null;
    },

    async insertMentorAssignmentHistory(values: MentorHistoryInsert): Promise<void> {
      const sql = `INSERT INTO course_mentor_assignment_history
                 (tenant_id, course_id, assigned_by, assigned_to, assigned_by_display_name, assigned_to_display_name, action)
               VALUES ($1, $2, $3, $4, $5, $6, $7)`;
      const params = [values.tenantId, values.courseId, values.assignedBy, values.assignedTo, values.assignedByName, values.assignedToName, values.action];
      await db.query(sql, params);
    },

    /** Number of history entries of the filter. */
    async countMentorHistory(filter: MentorHistoryFilter): Promise<number> {
      const { where, params } = mentorHistoryWhere(filter);
      const countResult = await db.query<{ count: string }>(
        `SELECT COUNT(*) AS count
     FROM course_mentor_assignment_history
     WHERE ${where}`,
        params,
      );
      return parseInt(countResult.rows[0]?.count ?? '0', 10);
    },

    /** One page of history entries of the filter, newest first. */
    async selectMentorHistoryPage(filter: MentorHistoryFilter, pageSize: number, offset: number): Promise<MentorAssignmentHistoryRow[]> {
      const { where, params } = mentorHistoryWhere(filter);
      const result = await db.query<MentorAssignmentHistoryRow>(
        `SELECT id::text, assigned_by, assigned_to, assigned_by_display_name,
            assigned_to_display_name, action, assigned_at
     FROM course_mentor_assignment_history
     WHERE ${where}
     ORDER BY assigned_at DESC, id DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, pageSize, offset],
      );
      return result.rows;
    },
  };
}
