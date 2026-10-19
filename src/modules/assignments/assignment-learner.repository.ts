// ═══════════════════════════════════════════════════════════════
// Assignments repository (learner side and downloads): a learner's
// assignments of a course with their submission, submitting, and the
// access reads of an attachment or submission file download. SQL only;
// moved unchanged from assignments.service.ts, which keeps the rules
// (who may submit or download, unlock and deadline checks, transactions,
// Storage).
// ═══════════════════════════════════════════════════════════════

import { learnerCourseAccessCondition } from '../courses/course-access.js';
import type { AssignmentDeadlineColumns, AssignmentsDb } from './assignments.repository.js';

/** The deadline that applies to a learner: absolute, or days after enrollment (or creation, if later). */
function effectiveDeadlineExpression(alias = 'ca', enrollmentAlias = 'e'): string {
  return `CASE
    WHEN COALESCE(${alias}.deadline_mode, CASE WHEN ${alias}.deadline_enabled THEN 'absolute' ELSE 'none' END) = 'absolute'
      THEN ${alias}.deadline_at
    WHEN COALESCE(${alias}.deadline_mode, CASE WHEN ${alias}.deadline_enabled THEN 'absolute' ELSE 'none' END) = 'relative_to_enrollment'
      AND ${alias}.deadline_after_days IS NOT NULL
      AND ${enrollmentAlias}.enrolled_at IS NOT NULL
      THEN GREATEST(${enrollmentAlias}.enrolled_at, ${alias}.created_at) + (${alias}.deadline_after_days * INTERVAL '1 day')
    ELSE NULL
  END`;
}

/** One assignment of the learner's course list, with the learner's submission (null columns when none). */
export interface LearnerAssignmentRow extends AssignmentDeadlineColumns {
  id: string;
  tenant_id: string;
  course_id: string;
  title: string;
  question: string;
  sort_order: number;
  effective_deadline_at: Date | null;
  attachment_file: unknown;
  is_deadline_expired: boolean | null;
  status: string;
  submission_id: string | null;
  answer_text: string | null;
  files: unknown;
  submitted_at: Date | null;
  submission_version: number | null;
  score: number | null;
  feedback_text: string | null;
  feedback_files: unknown;
  feedback_by: string | null;
  feedback_at: Date | null;
  feedback_by_username: string | null;
  feedback_by_name: string | null;
  feedback_by_email: string | null;
}

export interface SubmitAccessRow {
  assignment_id: string;
  tenant_id: string;
  course_id: string;
  title: string;
  allow_resubmission: boolean;
  deadline_enabled: boolean;
  deadline_at: string | Date | null;
  deadline_mode: 'none' | 'absolute' | 'relative_to_enrollment';
  deadline_after_days: number | null;
  effective_deadline_at: string | Date | null;
  submission_unlock_mode: 'after_content_complete' | 'anytime';
  enrollment_id: string;
}

export interface SubmissionInsertValues {
  submissionId: string;
  tenantId: string;
  courseId: string;
  assignmentId: string;
  learnerId: string;
  enrollmentId: string;
  answerText: string;
  /** JSON text. */
  files: string;
}

export interface AttachmentDownloadRow {
  assignment_id: string;
  tenant_id: string;
  course_id: string;
  storage_path: string | null;
  original_name: string | null;
  mime_type: string | null;
}

export interface AssignmentFileDownloadRow {
  id: string;
  tenant_id: string;
  learner_id: string;
  uploaded_by: string | null;
  kind: 'submission' | 'feedback';
  feedback_files: unknown;
  storage_path: string;
  original_name: string;
  mime_type: string;
}

export function createAssignmentLearnerRepository(db: AssignmentsDb) {
  return {
    /**
     * The course (not deleted) of the tenant and the user's active
     * enrollment id (null when not enrolled); `learnerOnly` adds the learner
     * course access condition. Undefined when the course is not accessible.
     */
    async selectCourseAccess(
      courseId: string,
      userId: string,
      tenantId: string,
      learnerOnly: boolean,
    ): Promise<{ enrollment_id: string | null } | undefined> {
      const learnerVisibilityFilter = learnerOnly
        ? `AND ${learnerCourseAccessCondition('c', '$2')}`
        : '';

      const access = await db.query<{ enrollment_id: string | null }>(
        `SELECT e.id AS enrollment_id
     FROM courses c
     LEFT JOIN enrollments e
       ON e.course_id = c.id
      AND e.user_id = $2
      AND e.tenant_id = c.tenant_id
      AND e.is_active = true
     WHERE c.id = $1
       AND c.tenant_id = $3
       AND c.deleted_at IS NULL
       ${learnerVisibilityFilter}`,
        [courseId, userId, tenantId],
      );
      return access.rowCount === 0 ? undefined : access.rows[0];
    },

    /** The course's assignments in order with the user's effective deadline and submission. */
    async selectLearnerAssignments(courseId: string, tenantId: string, userId: string): Promise<LearnerAssignmentRow[]> {
      const effectiveDeadlineSql = effectiveDeadlineExpression('ca', 'e');
      const result = await db.query<LearnerAssignmentRow>(
        `SELECT ca.id, ca.tenant_id, ca.course_id, ca.title, ca.question, ca.sort_order,
            ca.allow_resubmission, ca.deadline_enabled, ca.deadline_at,
            COALESCE(ca.deadline_mode, CASE WHEN ca.deadline_enabled THEN 'absolute' ELSE 'none' END) AS deadline_mode,
            ca.deadline_after_days,
            ${effectiveDeadlineSql} AS effective_deadline_at,
            ca.attachment_file,
            ca.grading_enabled,
            COALESCE(ca.submission_unlock_mode, 'after_content_complete') AS submission_unlock_mode,
            (${effectiveDeadlineSql} IS NOT NULL AND ${effectiveDeadlineSql} <= now()) AS is_deadline_expired,
            COALESCE(s.status::text, 'not_submitted') AS status,
            s.id AS submission_id, s.answer_text, s.files, s.submitted_at,
            s.submission_version, s.score, s.feedback_text, s.feedback_files,
            s.feedback_by, s.feedback_at,
            fb.username AS feedback_by_username,
            fb.full_name AS feedback_by_name,
            fb.email AS feedback_by_email
     FROM course_assignments ca
     LEFT JOIN enrollments e
       ON e.course_id = ca.course_id
      AND e.user_id = $3
      AND e.tenant_id = ca.tenant_id
      AND e.is_active = true
     LEFT JOIN assignment_submissions s
       ON s.assignment_id = ca.id AND s.learner_id = $3
     LEFT JOIN users fb ON fb.id = s.feedback_by
     WHERE ca.course_id = $1
       AND ca.tenant_id = $2
       AND ca.deleted_at IS NULL
     ORDER BY ca.sort_order ASC, ca.created_at ASC`,
        [courseId, tenantId, userId],
      );
      return result.rows;
    },

    /** The course of an assignment (not deleted) of the tenant. */
    async selectAssignmentCourseId(assignmentId: string, tenantId: string): Promise<string | null> {
      const result = await db.query<{ course_id: string }>(
        `SELECT course_id
     FROM course_assignments
     WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
        [assignmentId, tenantId],
      );
      return result.rowCount === 0 ? null : result.rows[0].course_id;
    },

    /** The assignment when the user is actively enrolled in its course and the course is open to them. */
    async selectSubmitAccess(assignmentId: string, tenantId: string, userId: string): Promise<SubmitAccessRow | null> {
      const access = await db.query<SubmitAccessRow>(
        `SELECT ca.id AS assignment_id, ca.tenant_id, ca.course_id, ca.title, ca.allow_resubmission,
            ca.deadline_enabled,
            COALESCE(ca.deadline_mode, CASE WHEN ca.deadline_enabled THEN 'absolute' ELSE 'none' END) AS deadline_mode,
            ca.deadline_at,
            ca.deadline_after_days,
            ${effectiveDeadlineExpression('ca', 'e')} AS effective_deadline_at,
            COALESCE(ca.submission_unlock_mode, 'after_content_complete') AS submission_unlock_mode,
            e.id AS enrollment_id
     FROM course_assignments ca
     JOIN courses c ON c.id = ca.course_id
     JOIN enrollments e ON e.course_id = ca.course_id AND e.user_id = $3 AND e.tenant_id = ca.tenant_id AND e.is_active = true
     WHERE ca.id = $1
       AND ca.tenant_id = $2
       AND ca.deleted_at IS NULL
       AND c.deleted_at IS NULL
       AND ${learnerCourseAccessCondition('c', 'e.user_id')}`,
        [assignmentId, tenantId, userId],
      );
      return access.rowCount === 0 ? null : access.rows[0];
    },

    /** The learner's submission of the assignment (any tenant: the assignment id decides). */
    async selectOwnSubmission(
      assignmentId: string,
      userId: string,
    ): Promise<{ id: string; status: 'submitted' | 'feedback_given' } | undefined> {
      const existing = await db.query<{
        id: string;
        status: 'submitted' | 'feedback_given';
      }>(
        `SELECT id, status
     FROM assignment_submissions
     WHERE assignment_id = $1 AND learner_id = $2`,
        [assignmentId, userId],
      );
      return existing.rows[0];
    },

    /** Removes the submission's files rows; their Storage paths. */
    async deleteSubmissionFiles(submissionId: string): Promise<string[]> {
      const oldFiles = await db.query<{ storage_path: string }>(
        `DELETE FROM assignment_files
         WHERE submission_id = $1 AND kind = 'submission'
         RETURNING storage_path`,
        [submissionId],
      );
      return oldFiles.rows.map(row => row.storage_path);
    },

    /** A new version of the submission; the feedback is cleared. */
    async resubmit(answerText: string, files: string, submissionId: string): Promise<void> {
      await db.query(
        `UPDATE assignment_submissions
         SET answer_text = $1,
             files = $2,
             status = 'submitted',
             submitted_at = now(),
             submission_version = submission_version + 1,
             feedback_text = NULL,
             feedback_files = '[]'::jsonb,
             feedback_by = NULL,
             feedback_at = NULL,
             score = NULL
         WHERE id = $3`,
        [answerText, files, submissionId],
      );
    },

    async insertSubmission(values: SubmissionInsertValues): Promise<void> {
      await db.query(
        `INSERT INTO assignment_submissions (
           id, tenant_id, course_id, assignment_id, learner_id, enrollment_id,
           answer_text, files, status, submitted_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'submitted', now())`,
        [
          values.submissionId,
          values.tenantId,
          values.courseId,
          values.assignmentId,
          values.learnerId,
          values.enrollmentId,
          values.answerText,
          values.files,
        ],
      );
    },

    /** The assignment (not deleted, any tenant) whose attachment has this file id. */
    async selectAttachmentDownload(fileId: string): Promise<AttachmentDownloadRow | undefined> {
      const attachment = await db.query<AttachmentDownloadRow>(
        `SELECT ca.id AS assignment_id,
            ca.tenant_id,
            ca.course_id,
            ca.attachment_file ->> 'storage_path' AS storage_path,
            ca.attachment_file ->> 'original_name' AS original_name,
            ca.attachment_file ->> 'mime_type' AS mime_type
     FROM course_assignments ca
     WHERE ca.attachment_file ->> 'id' = $1
       AND ca.deleted_at IS NULL`,
        [fileId],
      );
      return (attachment.rowCount ?? 0) > 0 ? attachment.rows[0] : undefined;
    },

    /** Whether the learner may open the course (tenant, not deleted, learner access condition). */
    async learnerCanOpenCourse(courseId: string, tenantId: string, userId: string): Promise<boolean> {
      const access = await db.query<{ allowed: boolean }>(
        `SELECT true AS allowed
         FROM courses c
         WHERE c.id = $1::varchar
           AND c.tenant_id = $2::uuid
           AND c.deleted_at IS NULL
           AND ${learnerCourseAccessCondition('c', '$3::uuid')}
         LIMIT 1`,
        [courseId, tenantId, userId],
      );
      return (access.rowCount ?? 0) > 0;
    },

    /** A submission or feedback file (any tenant: the caller checks) with its submission's learner. */
    async selectAssignmentFileDownload(fileId: string): Promise<AssignmentFileDownloadRow | null> {
      const result = await db.query<AssignmentFileDownloadRow>(
        `SELECT af.id, af.tenant_id, af.uploaded_by, af.kind, af.storage_path,
            af.original_name, af.mime_type, s.learner_id, s.feedback_files
     FROM assignment_files af
     JOIN assignment_submissions s ON s.id = af.submission_id
     WHERE af.id = $1`,
        [fileId],
      );
      return result.rowCount === 0 ? null : result.rows[0];
    },
  };
}
