// ═══════════════════════════════════════════════════════════════
// Assignments repository (submissions and feedback): the staff submission
// list (with or without learners who have not submitted), feedback and its
// history, and the feedback notification. SQL only; moved unchanged from
// assignments.service.ts, which keeps the rules (score, transactions, audit
// entries, Storage, e-mail outbox, caches).
// ═══════════════════════════════════════════════════════════════

import type {
  AssignmentCourseRow,
  AssignmentDeadlineColumns,
  AssignmentsDb,
  CourseNotificationInsert,
} from './assignments.repository.js';

/** A submission (or a learner who has not submitted) of the staff submission list. */
export interface SubmissionListRow extends AssignmentDeadlineColumns {
  id: string;
  submission_id?: string | null;
  assignment_id: string;
  learner_id: string;
  answer_text: string | null;
  files: unknown;
  status: string;
  submitted_at: Date | null;
  submission_version: number | null;
  score: number | null;
  feedback_text: string | null;
  feedback_files: unknown;
  feedback_by: string | null;
  feedback_at: Date | null;
  assignment_title: string;
  assignment_question: string;
  learner_username: string | null;
  learner_name: string | null;
  learner_email: string | null;
  learner_role: string;
  feedback_by_username: string | null;
  feedback_by_name: string | null;
  feedback_by_email: string | null;
  course_name: string;
}

/** Filters of the staff submission list. */
export interface SubmissionFilter {
  tenantId: string;
  courseId: string;
  /** The assignment_id query value when it is a non-empty string. */
  assignmentId: string | undefined;
  /** 'not_submitted', 'submitted', 'feedback_given', or undefined for every state. */
  status: string | undefined;
  search: string | undefined;
}

/** WHERE parts of the not-submitted variant and its parameters ($1 tenant, $2 course, $3 staff-only, $4 public). */
function submissionStateWhere(
  filter: SubmissionFilter,
  visibleToStaffOnly: boolean,
  isPublic: boolean,
): { params: unknown[]; assignmentConditions: string[]; stateWhere: string } {
  const { tenantId, courseId, status, search } = filter;
  const params: unknown[] = [tenantId, courseId, visibleToStaffOnly, isPublic];
  const assignmentConditions = [
    'ca.tenant_id = $1::uuid',
    'ca.course_id = $2::varchar',
    'ca.deleted_at IS NULL',
  ];
  const stateConditions: string[] = [];

  if (filter.assignmentId) {
    params.push(filter.assignmentId);
    assignmentConditions.push(`ca.id = $${params.length}::uuid`);
  }

  if (status === 'not_submitted') {
    stateConditions.push('state.submission_id IS NULL');
  }

  if (search) {
    params.push(`%${search}%`);
    stateConditions.push(`(
        unaccent(COALESCE(state.learner_name, '')) ILIKE unaccent($${params.length})
        OR unaccent(COALESCE(state.learner_username, '')) ILIKE unaccent($${params.length})
        OR unaccent(COALESCE(state.learner_email, '')) ILIKE unaccent($${params.length})
      )`);
  }

  const stateWhere = stateConditions.length ? `WHERE ${stateConditions.join(' AND ')}` : '';
  return { params, assignmentConditions, stateWhere };
}

/** WHERE of the submitted variant and its parameters. */
function submissionWhere(filter: SubmissionFilter): { params: unknown[]; where: string } {
  const { tenantId, courseId, status, search } = filter;
  const params: unknown[] = [tenantId, courseId];
  const conditions = ['s.tenant_id = $1', 's.course_id = $2', 'ca.deleted_at IS NULL'];

  if (filter.assignmentId) {
    params.push(filter.assignmentId);
    conditions.push(`s.assignment_id = $${params.length}`);
  }

  if (status) {
    params.push(status);
    conditions.push(`s.status = $${params.length}`);
  }

  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(
      unaccent(COALESCE(u.full_name, '')) ILIKE unaccent($${params.length})
      OR unaccent(COALESCE(u.username, '')) ILIKE unaccent($${params.length})
      OR unaccent(COALESCE(u.email, '')) ILIKE unaccent($${params.length})
    )`);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;
  return { params, where };
}

export interface FeedbackContextRow {
  id: string;
  tenant_id: string;
  course_id: string;
  assignment_id: string;
  learner_id: string;
  status: 'submitted' | 'feedback_given';
  feedback_at: string | null;
  course_name: string;
  assignment_title: string;
  assignment_question: string;
  grading_enabled: boolean;
  learner_name: string;
  learner_email: string;
}

export interface LockedSubmissionRow {
  status: 'submitted' | 'feedback_given';
  feedback_at: string | null;
  feedback_files: unknown;
  score: number | null;
}

export interface FeedbackUpdateValues {
  feedbackText: string;
  /** JSON text. */
  feedbackFiles: string;
  score: number | null;
  feedbackBy: string;
  submissionId: string;
  tenantId: string;
}

export interface FeedbackHistoryInsert {
  tenantId: string;
  courseId: string;
  assignmentId: string;
  submissionId: string;
  learnerId: string;
  feedbackText: string;
  /** JSON text. */
  feedbackFiles: string;
  score: number | null;
  feedbackBy: string;
  feedbackAt: string;
}

export interface FeedbackHistoryRow {
  id: string;
  submission_id: string;
  assignment_id: string;
  learner_id: string;
  feedback_text: string | null;
  feedback_files: unknown;
  score: number | null;
  feedback_by: string | null;
  feedback_at: Date;
  created_at: Date;
  feedback_by_username: string | null;
  feedback_by_name: string | null;
  feedback_by_email: string | null;
}

export interface SubmissionAuditContextRow {
  id: string;
  assignment_title: string;
  course_name: string;
  learner_name: string;
}

export function createAssignmentSubmissionsRepository(db: AssignmentsDb) {
  return {
    /**
     * Every eligible learner x assignment of the course, submitted or not
     * (the not-submitted list): count and one page.
     */
    async selectSubmissionStatePage(
      filter: SubmissionFilter,
      course: Pick<AssignmentCourseRow, 'display_name' | 'visible_to_staff_only' | 'is_public'>,
      pageSize: number,
      offset: number,
    ): Promise<{ countRow: { count: string } | undefined; rows: SubmissionListRow[] }> {
      const { params, assignmentConditions, stateWhere } = submissionStateWhere(
        filter,
        course.visible_to_staff_only,
        course.is_public,
      );
      const courseName = course.display_name;
      const baseSql = `
      WITH eligible_learners AS (
        SELECT DISTINCT u.id, u.username, u.full_name, u.email, u.role::text AS learner_role
        FROM users u
        LEFT JOIN team_members tm ON tm.user_id = u.id
        WHERE $3::boolean = false
          AND u.tenant_id = $1::uuid
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
      filtered_assignments AS (
        SELECT ca.id, ca.title, ca.question, ca.deadline_enabled, ca.deadline_at,
               COALESCE(ca.deadline_mode, CASE WHEN ca.deadline_enabled THEN 'absolute' ELSE 'none' END) AS deadline_mode,
               ca.deadline_after_days,
               COALESCE(ca.submission_unlock_mode, 'after_content_complete') AS submission_unlock_mode,
               ca.grading_enabled, ca.sort_order, ca.created_at
        FROM course_assignments ca
        WHERE ${assignmentConditions.join(' AND ')}
      ),
      state AS (
        SELECT s.id AS submission_id,
               COALESCE(s.id::text, fa.id::text || ':' || el.id::text || ':not_submitted') AS id,
               fa.id AS assignment_id,
               el.id AS learner_id,
               COALESCE(s.answer_text, '') AS answer_text,
               COALESCE(s.files, '[]'::jsonb) AS files,
               COALESCE(s.status::text, 'not_submitted') AS status,
               s.submitted_at,
               COALESCE(s.submission_version, 0) AS submission_version,
               s.score,
               s.feedback_text,
               COALESCE(s.feedback_files, '[]'::jsonb) AS feedback_files,
               s.feedback_by,
               s.feedback_at,
               fa.title AS assignment_title,
               fa.question AS assignment_question,
               fa.deadline_enabled,
               fa.deadline_mode,
               fa.deadline_at,
               fa.deadline_after_days,
               fa.submission_unlock_mode,
               fa.grading_enabled,
               el.username AS learner_username,
               el.full_name AS learner_name,
               el.email AS learner_email,
               el.learner_role,
               fb.username AS feedback_by_username,
               fb.full_name AS feedback_by_name,
               fb.email AS feedback_by_email
        FROM filtered_assignments fa
        CROSS JOIN eligible_learners el
        LEFT JOIN assignment_submissions s
          ON s.assignment_id = fa.id
         AND s.learner_id = el.id
         AND s.tenant_id = $1::uuid
        LEFT JOIN users fb ON fb.id = s.feedback_by
      )`;

      const [countResult, dataResult] = await Promise.all([
        db.query<{ count: string }>(
          `${baseSql}
         SELECT COUNT(*) AS count
         FROM state
         ${stateWhere}`,
          params,
        ),
        db.query<SubmissionListRow>(
          `${baseSql}
         SELECT state.*, $${params.length + 1}::text AS course_name
         FROM state
         ${stateWhere}
         ORDER BY
           CASE WHEN state.submitted_at IS NULL THEN 1 ELSE 0 END,
           state.submitted_at DESC NULLS LAST,
           state.assignment_title ASC,
           COALESCE(NULLIF(state.learner_name, ''), state.learner_username, state.learner_email) ASC,
           state.learner_id ASC
         LIMIT $${params.length + 2} OFFSET $${params.length + 3}`,
          [...params, courseName, pageSize, offset],
        ),
      ]);
      return { countRow: countResult.rows[0], rows: dataResult.rows };
    },

    /** The course's submissions (submitted or with feedback): count and one page, newest first. */
    async selectSubmissionPage(
      filter: SubmissionFilter,
      courseName: string,
      pageSize: number,
      offset: number,
    ): Promise<{ countRow: { count: string } | undefined; rows: SubmissionListRow[] }> {
      const { params, where } = submissionWhere(filter);
      const [countResult, dataResult] = await Promise.all([
        db.query<{ count: string }>(
          `SELECT COUNT(*) AS count
       FROM assignment_submissions s
       JOIN users u ON u.id = s.learner_id
       JOIN course_assignments ca ON ca.id = s.assignment_id AND ca.tenant_id = s.tenant_id AND ca.course_id = s.course_id
       ${where}`,
          params,
        ),
        db.query<SubmissionListRow>(
          `SELECT s.id, s.assignment_id, s.learner_id, s.answer_text, s.files, s.status,
              s.submitted_at, s.submission_version, s.score, s.feedback_text, s.feedback_files,
              s.feedback_by, s.feedback_at, ca.title AS assignment_title, ca.question AS assignment_question,
              ca.deadline_enabled,
              COALESCE(ca.deadline_mode, CASE WHEN ca.deadline_enabled THEN 'absolute' ELSE 'none' END) AS deadline_mode,
              ca.deadline_at, ca.deadline_after_days,
              COALESCE(ca.submission_unlock_mode, 'after_content_complete') AS submission_unlock_mode,
              ca.grading_enabled,
              u.username AS learner_username, u.full_name AS learner_name, u.email AS learner_email,
              u.role AS learner_role,
              fb.username AS feedback_by_username, fb.full_name AS feedback_by_name, fb.email AS feedback_by_email,
              $${params.length + 1}::text AS course_name
       FROM assignment_submissions s
       JOIN users u ON u.id = s.learner_id
       JOIN course_assignments ca ON ca.id = s.assignment_id AND ca.tenant_id = s.tenant_id AND ca.course_id = s.course_id
       LEFT JOIN users fb ON fb.id = s.feedback_by
       ${where}
       ORDER BY s.submitted_at DESC, s.id DESC
       LIMIT $${params.length + 2} OFFSET $${params.length + 3}`,
          [...params, courseName, pageSize, offset],
        ),
      ]);
      return { countRow: countResult.rows[0], rows: dataResult.rows };
    },

    /** Names for the audit entry of a submission of the tenant. */
    async selectSubmissionAuditContext(submissionId: string, tenantId: string): Promise<SubmissionAuditContextRow | null> {
      const result = await db.query<SubmissionAuditContextRow>(
        `SELECT s.id,
            ca.title AS assignment_title,
            c.display_name AS course_name,
            COALESCE(NULLIF(u.full_name, ''), u.username, u.email, s.learner_id::text) AS learner_name
     FROM assignment_submissions s
     JOIN course_assignments ca ON ca.id = s.assignment_id AND ca.tenant_id = s.tenant_id AND ca.course_id = s.course_id
     JOIN courses c ON c.id = s.course_id
     JOIN users u ON u.id = s.learner_id
     WHERE s.id = $1 AND s.tenant_id = $2`,
        [submissionId, tenantId],
      );
      return result.rowCount === 0 ? null : result.rows[0];
    },

    /** The submission of the tenant with its assignment, course and learner. */
    async selectFeedbackContext(submissionId: string, tenantId: string): Promise<FeedbackContextRow | null> {
      const submission = await db.query<FeedbackContextRow>(
        `SELECT s.id, s.tenant_id, s.course_id, s.assignment_id, s.learner_id,
            s.status::text AS status, s.feedback_at,
            c.display_name AS course_name, ca.title AS assignment_title, ca.question AS assignment_question,
            ca.grading_enabled,
            COALESCE(NULLIF(u.full_name, ''), u.username) AS learner_name,
            u.email AS learner_email
     FROM assignment_submissions s
     JOIN course_assignments ca ON ca.id = s.assignment_id AND ca.tenant_id = s.tenant_id AND ca.course_id = s.course_id
     JOIN courses c ON c.id = s.course_id
     JOIN users u ON u.id = s.learner_id
     WHERE s.id = $1 AND s.tenant_id = $2`,
        [submissionId, tenantId],
      );
      return submission.rowCount === 0 ? null : submission.rows[0];
    },

    /** Display name and email of the staff member giving feedback. */
    async selectFeedbackAuthor(adminId: string): Promise<{ name: string; email: string | null } | undefined> {
      const admin = await db.query<{ name: string; email: string | null }>(
        `SELECT COALESCE(NULLIF(full_name, ''), username, email, 'Quản trị viên') AS name,
            email
     FROM users
     WHERE id = $1::uuid
     LIMIT 1`,
        [adminId],
      );
      return admin.rows[0];
    },

    /** The submission's feedback state, row-locked (FOR UPDATE) until commit. */
    async lockSubmission(submissionId: string, tenantId: string): Promise<LockedSubmissionRow | null> {
      const current = await db.query<LockedSubmissionRow>(
        `SELECT status::text AS status, feedback_at, feedback_files, score
       FROM assignment_submissions
       WHERE id = $1 AND tenant_id = $2
       FOR UPDATE`,
        [submissionId, tenantId],
      );
      return current.rowCount === 0 ? null : current.rows[0];
    },

    /** Stores the feedback; its time, or null when the submission is not ready. */
    async updateFeedback(values: FeedbackUpdateValues): Promise<string | null> {
      const feedbackUpdate = await db.query<{ feedback_at: string }>(
        `UPDATE assignment_submissions
       SET status = 'feedback_given',
           feedback_text = $1,
           feedback_files = $2,
           score = $3,
           feedback_by = $4,
           feedback_at = now()
       WHERE id = $5
         AND tenant_id = $6
         AND status IN ('submitted', 'feedback_given')
       RETURNING feedback_at`,
        [
          values.feedbackText,
          values.feedbackFiles,
          values.score,
          values.feedbackBy,
          values.submissionId,
          values.tenantId,
        ],
      );
      return feedbackUpdate.rowCount === 0 ? null : feedbackUpdate.rows[0].feedback_at;
    },

    async insertFeedbackHistory(values: FeedbackHistoryInsert): Promise<void> {
      await db.query(
        `INSERT INTO assignment_feedback_history (
         tenant_id, course_id, assignment_id, submission_id, learner_id,
         feedback_text, feedback_files, score, feedback_by, feedback_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          values.tenantId,
          values.courseId,
          values.assignmentId,
          values.submissionId,
          values.learnerId,
          values.feedbackText,
          values.feedbackFiles,
          values.score,
          values.feedbackBy,
          values.feedbackAt,
        ],
      );
    },

    /** A notification for one recipient (recipient_count 1); its id. */
    async insertSingleRecipientNotification(values: CourseNotificationInsert): Promise<string> {
      const notification = await db.query<{ id: string }>(
        `INSERT INTO notifications (tenant_id, course_id, type, metadata, title, message, sent_by, recipient_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 1)
       RETURNING id`,
        [values.tenantId, values.courseId, values.type, values.metadata, values.title, values.message, values.sentBy],
      );
      return notification.rows[0].id;
    },

    async insertNotificationRecipient(notificationId: string, userId: string): Promise<void> {
      await db.query(
        `INSERT INTO notification_recipients (notification_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
        [notificationId, userId],
      );
    },

    /** Whether the submission exists in the tenant. */
    async submissionExists(submissionId: string, tenantId: string): Promise<boolean> {
      const submission = await db.query<{ id: string }>(
        `SELECT id
     FROM assignment_submissions
     WHERE id = $1::uuid AND tenant_id = $2::uuid`,
        [submissionId, tenantId],
      );
      return submission.rowCount !== 0;
    },

    /** The submission's feedback history, newest first (at most 100). */
    async selectFeedbackHistory(submissionId: string, tenantId: string): Promise<FeedbackHistoryRow[]> {
      const result = await db.query<FeedbackHistoryRow>(
        `SELECT h.id, h.submission_id, h.assignment_id, h.learner_id,
            h.feedback_text, h.feedback_files, h.score, h.feedback_by, h.feedback_at, h.created_at,
            u.username AS feedback_by_username,
            u.full_name AS feedback_by_name,
            u.email AS feedback_by_email
     FROM assignment_feedback_history h
     LEFT JOIN users u ON u.id = h.feedback_by
     WHERE h.submission_id = $1::uuid
       AND h.tenant_id = $2::uuid
     ORDER BY h.feedback_at DESC, h.id DESC
     LIMIT 100`,
        [submissionId, tenantId],
      );
      return result.rows;
    },
  };
}
