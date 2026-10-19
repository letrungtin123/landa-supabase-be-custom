// ═══════════════════════════════════════════════════════════════
// Assignments repository (staff side): the course an assignment belongs
// to, the course permission of a staff member, assignment CRUD and order,
// the "assignment created" notification, assignment files, the submission
// lists and feedback. SQL only; moved unchanged from assignments.service.ts,
// which keeps the rules (one assignment per course, deadlines, transactions,
// audit entries, Storage, e-mail outbox, caches).
// ═══════════════════════════════════════════════════════════════

import type { QueryResult, QueryResultRow } from 'pg';

/** The pool query() or a transaction client (PoolClient). */
export interface AssignmentsDb {
  query<T extends QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface AssignmentCourseRow {
  id: string;
  display_name: string;
  tenant_id: string;
  visible_to_staff_only: boolean;
  is_public: boolean;
}

/** The deadline and unlock columns an assignment row carries. Timestamps are pg Dates. */
export interface AssignmentDeadlineColumns {
  allow_resubmission: boolean;
  deadline_enabled: boolean;
  deadline_at: string | Date | null;
  deadline_mode: string | null;
  deadline_after_days: number | null;
  submission_unlock_mode: string | null;
  grading_enabled: boolean;
}

/** A whole course_assignments row (`RETURNING *`, `ca.*`): the columns the code reads, and every other column. */
export interface AssignmentRow extends AssignmentDeadlineColumns {
  id: string;
  tenant_id: string;
  course_id: string;
  title: string;
  question: string;
  attachment_file: unknown;
  created_at: string | Date;
  [column: string]: unknown;
}

export interface AssignmentWithCourseNameRow extends AssignmentRow {
  course_name: string;
}

export interface AssignmentListRow extends AssignmentDeadlineColumns {
  id: string;
  tenant_id: string;
  course_id: string;
  title: string;
  question: string;
  sort_order: number;
  attachment_file: unknown;
  created_at: Date;
  updated_at: Date;
  submitted_count: number;
  feedback_count: number;
}

export interface AssignmentInsertValues {
  assignmentId: string;
  tenantId: string;
  courseId: string;
  title: string;
  question: string;
  allowResubmission: boolean;
  deadlineEnabled: boolean;
  deadlineMode: string;
  deadlineAt: string | null;
  deadlineAfterDays: number | null;
  submissionUnlockMode: string;
  gradingEnabled: boolean;
  /** The attachment as JSON text, or null. */
  attachmentFile: string | null;
  createdBy: string;
}

export interface CourseNotificationInsert {
  tenantId: string;
  courseId: string;
  type: string;
  /** JSON text. */
  metadata: string;
  title: string;
  message: string;
  sentBy: string;
}

/** Columns the assignment update may write, with their casts, in the order the service lists them. */
export type AssignmentUpdateColumn =
  | 'title = $n::varchar'
  | 'question = $n::text'
  | 'allow_resubmission = $n::boolean'
  | 'deadline_at = $n::timestamptz'
  | 'submission_unlock_mode = $n::varchar'
  | 'attachment_file = $n::jsonb';

export interface AssignmentFileInsert {
  id: string;
  storage_path: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
}

export function createAssignmentsRepository(db: AssignmentsDb) {
  return {
    /** The course (not deleted) of the tenant, with its staff-only and public flags. */
    async selectCourse(courseId: string, tenantId: string): Promise<AssignmentCourseRow | null> {
      const result = await db.query<AssignmentCourseRow>(
        `SELECT id, display_name, tenant_id, COALESCE(visible_to_staff_only, false) AS visible_to_staff_only,
            EXISTS (
              SELECT 1
              FROM course_category_courses ccc_public
              JOIN course_categories cc_public ON cc_public.id = ccc_public.category_id
              WHERE ccc_public.course_id = courses.id
                AND cc_public.tenant_id = courses.tenant_id
                AND COALESCE(cc_public.is_public, false) = true
            ) AS is_public
     FROM courses
     WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
        [courseId, tenantId],
      );
      return result.rowCount === 0 ? null : result.rows[0];
    },

    /** Whether a staff member's permission groups of the tenant may view or edit courses. */
    async staffHasCoursePermission(userId: string, tenantId: string): Promise<boolean> {
      const result = await db.query<{ allowed: boolean }>(
        `SELECT bool_or(pgm.can_view OR pgm.can_edit) AS allowed
     FROM user_permission_groups upg
     JOIN permission_group_modules pgm
       ON pgm.permission_group_id = upg.permission_group_id
      AND pgm.tenant_id = upg.tenant_id
     JOIN modules m ON m.id = pgm.module_id
     JOIN permission_groups pg ON pg.id = upg.permission_group_id
     WHERE upg.user_id = $1
       AND upg.tenant_id = $2
       AND m.code = 'courses'
       AND pg.tenant_id = $2`,
        [userId, tenantId],
      );
      return result.rows[0]?.allowed === true;
    },

    /** The assignment (not deleted) of the tenant with its course name. */
    async selectAssignment(assignmentId: string, tenantId: string): Promise<AssignmentWithCourseNameRow | null> {
      const result = await db.query<AssignmentWithCourseNameRow>(
        `SELECT ca.*, c.display_name AS course_name
     FROM course_assignments ca
     JOIN courses c ON c.id = ca.course_id
     WHERE ca.id = $1 AND ca.tenant_id = $2 AND ca.deleted_at IS NULL`,
        [assignmentId, tenantId],
      );
      return result.rowCount === 0 ? null : result.rows[0];
    },

    /** One assignment_files row per file, one statement each. */
    async insertAssignmentFiles(
      tenantId: string,
      courseId: string,
      assignmentId: string,
      submissionId: string,
      uploadedBy: string,
      kind: 'submission' | 'feedback',
      files: AssignmentFileInsert[],
    ): Promise<void> {
      for (const file of files) {
        await db.query(
          `INSERT INTO assignment_files (
         id, tenant_id, course_id, assignment_id, submission_id, uploaded_by, kind,
         storage_path, original_name, mime_type, size_bytes
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            file.id,
            tenantId,
            courseId,
            assignmentId,
            submissionId,
            uploadedBy,
            kind,
            file.storage_path,
            file.original_name,
            file.mime_type,
            file.size_bytes,
          ],
        );
      }
    },

    /** The course's assignments in order, with submitted and feedback counts. */
    async selectCourseAssignments(courseId: string, tenantId: string): Promise<AssignmentListRow[]> {
      const result = await db.query<AssignmentListRow>(
        `SELECT ca.id, ca.tenant_id, ca.course_id, ca.title, ca.question, ca.sort_order,
            ca.allow_resubmission, ca.deadline_enabled, ca.deadline_at,
            COALESCE(ca.deadline_mode, CASE WHEN ca.deadline_enabled THEN 'absolute' ELSE 'none' END) AS deadline_mode,
            ca.deadline_after_days,
            ca.attachment_file,
            ca.grading_enabled,
            COALESCE(ca.submission_unlock_mode, 'after_content_complete') AS submission_unlock_mode,
            ca.created_at, ca.updated_at,
            COUNT(s.id) FILTER (WHERE s.status = 'submitted')::int AS submitted_count,
            COUNT(s.id) FILTER (WHERE s.status = 'feedback_given')::int AS feedback_count
     FROM course_assignments ca
     LEFT JOIN assignment_submissions s ON s.assignment_id = ca.id
     WHERE ca.tenant_id = $1 AND ca.course_id = $2 AND ca.deleted_at IS NULL
     GROUP BY ca.id
     ORDER BY ca.sort_order ASC, ca.created_at ASC`,
        [tenantId, courseId],
      );
      return result.rows;
    },

    /** Whether the course already has an assignment (not deleted). */
    async courseHasAssignment(tenantId: string, courseId: string): Promise<boolean> {
      const existing = await db.query<{ id: string }>(
        `SELECT id
     FROM course_assignments
     WHERE tenant_id = $1::uuid
       AND course_id = $2::varchar
       AND deleted_at IS NULL
     LIMIT 1`,
        [tenantId, courseId],
      );
      return (existing.rowCount ?? 0) > 0;
    },

    /** Inserts the assignment last in the course order. */
    async insertAssignment(values: AssignmentInsertValues): Promise<AssignmentRow> {
      const result = await db.query<AssignmentRow>(
        `INSERT INTO course_assignments (
         id, tenant_id, course_id, title, question, allow_resubmission,
         deadline_enabled, deadline_mode, deadline_at, deadline_after_days,
         submission_unlock_mode, grading_enabled, attachment_file, sort_order, created_by
       )
       VALUES (
         $1::uuid, $2::uuid, $3::varchar, $4::varchar, $5::text, $6::boolean, $7::boolean,
         $8::varchar, $9::timestamptz, $10::integer,
         $11::varchar, $12::boolean, $13::jsonb,
         COALESCE((SELECT MAX(sort_order) + 1 FROM course_assignments WHERE tenant_id = $2::uuid AND course_id = $3::varchar AND deleted_at IS NULL), 0),
         $14::uuid
       )
       RETURNING *`,
        [
          values.assignmentId,
          values.tenantId,
          values.courseId,
          values.title,
          values.question,
          values.allowResubmission,
          values.deadlineEnabled,
          values.deadlineMode,
          values.deadlineAt,
          values.deadlineAfterDays,
          values.submissionUnlockMode,
          values.gradingEnabled,
          values.attachmentFile,
          values.createdBy,
        ],
      );
      return result.rows[0];
    },

    /** A course notification with no recipients yet; its id. */
    async insertCourseNotification(values: CourseNotificationInsert): Promise<string> {
      const notification = await db.query<{ id: string }>(
        `INSERT INTO notifications (tenant_id, course_id, type, metadata, title, message, sent_by, recipient_count)
         VALUES ($1::uuid, $2::varchar, $3::varchar, $4::jsonb, $5::varchar, $6::text, $7::uuid, 0)
         RETURNING id`,
        [values.tenantId, values.courseId, values.type, values.metadata, values.title, values.message, values.sentBy],
      );
      return notification.rows[0].id;
    },

    /**
     * Adds the course's eligible active learners (every learner of the tenant
     * when `isPublic`) as recipients and stores their number; the number, or
     * undefined without a row.
     */
    async addCourseLearnerRecipients(
      tenantId: string,
      courseId: string,
      notificationId: string,
      isPublic: boolean,
    ): Promise<{ recipient_count: number } | undefined> {
      const recipientResult = await db.query<{ recipient_count: number }>(
        `WITH eligible_learners AS (
           SELECT DISTINCT u.id AS user_id
           FROM users u
           LEFT JOIN team_members tm ON tm.user_id = u.id
           WHERE u.tenant_id = $1::uuid
             AND u.is_active = true
             AND u.role IN ('learner'::user_role, 'learner_plus'::user_role)
             AND (
               $4::boolean = true
               OR EXISTS (
                 SELECT 1
                 FROM team_courses tc
                 WHERE tc.team_id = tm.team_id
                   AND tc.course_id = $2::varchar
                 UNION ALL
                 SELECT 1
                 FROM team_course_categories tcc
                 JOIN course_category_courses ccc ON ccc.category_id = tcc.category_id
                 WHERE tcc.team_id = tm.team_id
                   AND ccc.course_id = $2::varchar
               )
             )
         ),
         inserted AS (
           INSERT INTO notification_recipients (notification_id, user_id)
           SELECT $3::uuid, user_id
           FROM eligible_learners
           ON CONFLICT DO NOTHING
           RETURNING user_id
         )
         UPDATE notifications
         SET recipient_count = (SELECT COUNT(*)::int FROM inserted)
         WHERE id = $3::uuid
         RETURNING recipient_count`,
        [tenantId, courseId, notificationId, isPublic],
      );
      return recipientResult.rows[0];
    },

    async deleteNotification(notificationId: string): Promise<void> {
      await db.query('DELETE FROM notifications WHERE id = $1::uuid', [notificationId]);
    },

    /**
     * Writes `columns` (each "col = $n::type", numbered here in order) to the
     * assignment of the tenant (not deleted); the updated row, or undefined.
     */
    async updateAssignmentColumns(
      assignmentId: string,
      tenantId: string,
      columns: [AssignmentUpdateColumn, unknown][],
    ): Promise<AssignmentRow | undefined> {
      const sets: string[] = [];
      const params: unknown[] = [];
      let idx = 1;
      for (const [column, value] of columns) {
        const placeholder = `$${idx++}`;
        sets.push(column.replace('$n', () => placeholder));
        params.push(value);
      }
      params.push(assignmentId, tenantId);
      const result = await db.query<AssignmentRow>(
        `UPDATE course_assignments
       SET ${sets.join(', ')}
       WHERE id = $${idx++}::uuid AND tenant_id = $${idx}::uuid AND deleted_at IS NULL
       RETURNING *`,
        params,
      );
      return result.rows[0];
    },

    /** Soft-deletes the assignment; false when no row matched. */
    async softDeleteAssignment(assignmentId: string, tenantId: string): Promise<boolean> {
      const result = await db.query<{ id: string }>(
        `UPDATE course_assignments
       SET deleted_at = now()
       WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
       RETURNING id`,
        [assignmentId, tenantId],
      );
      return result.rowCount !== 0;
    },

    /** Ids of the course's assignments (not deleted). */
    async selectCourseAssignmentIds(tenantId: string, courseId: string): Promise<string[]> {
      const existing = await db.query<{ id: string }>(
        `SELECT id
     FROM course_assignments
     WHERE tenant_id = $1 AND course_id = $2 AND deleted_at IS NULL`,
        [tenantId, courseId],
      );
      return existing.rows.map(row => row.id);
    },

    async updateSortOrder(sortOrder: number, assignmentId: string, tenantId: string, courseId: string): Promise<void> {
      await db.query(
        `UPDATE course_assignments
         SET sort_order = $1
         WHERE id = $2 AND tenant_id = $3 AND course_id = $4`,
        [sortOrder, assignmentId, tenantId, courseId],
      );
    },

  };
}

export type AssignmentsRepository = ReturnType<typeof createAssignmentsRepository>;
