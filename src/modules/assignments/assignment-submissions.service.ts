// Submissions as the course staff see them: the list, feedback and its
// history, and the audit context of a submission. Moved unchanged from
// assignments.service.ts, which re-exports them.

import { getClient } from '../../config/database.js';
import { invalidateUserNotificationCaches } from '../../config/cache-invalidation.js';
import { deleteFile } from '../../config/storage.js';
import { AppError } from '../../utils/errors.js';
import { appendAuditLog, type TransactionalAuditEntry } from '../../middleware/audit-log.js';
import { calcOffset, calcTotalPages, parsePagination } from '../../utils/query-helpers.js';
import type { FeedbackAssignmentInput } from './assignments.validator.js';
import { enqueueFeedbackEmails, wakeEmailOutboxWorker } from './email-outbox.service.js';
import { swallowAndLog } from '../../utils/best-effort.js';
import { createAssignmentSubmissionsRepository, type SubmissionListRow } from './assignment-submissions.repository.js';
import { submissionsRepository, ensureCourseForAdmin } from './assignment-access.service.js';
import { normalizeFiles } from './assignment-rules.logic.js';
import { uploadAssignmentFiles, insertAssignmentFileRows } from './assignment-files.service.js';

export interface AssignmentFeedbackAuditContext {
  submissionId: string;
  assignmentId: string;
  assignmentTitle: string;
  courseId: string;
  courseName: string;
  learnerName: string;
}

export async function listCourseSubmissions(courseId: string, tenantId: string, queryParams: Record<string, unknown>) {
  const course = await ensureCourseForAdmin(courseId, tenantId);
  const { page, pageSize, search } = parsePagination(queryParams);
  const offset = calcOffset(page, pageSize);
  const status = typeof queryParams.status === 'string'
    && ['not_submitted', 'submitted', 'feedback_given'].includes(queryParams.status)
    ? queryParams.status
    : undefined;

  const filter = {
    tenantId,
    courseId,
    assignmentId: typeof queryParams.assignment_id === 'string' && queryParams.assignment_id
      ? queryParams.assignment_id
      : undefined,
    status,
    search,
  };
  const withFiles = (row: SubmissionListRow) => ({
    ...row,
    files: normalizeFiles(row.files),
    feedback_files: normalizeFiles(row.feedback_files),
  });

  if (!status || status === 'not_submitted') {
    const { countRow, rows } = await submissionsRepository.selectSubmissionStatePage(filter, course, pageSize, offset);

    const total = parseInt(countRow?.count || '0', 10);
    return {
      data: rows.map(withFiles),
      total,
      page,
      pageSize,
      totalPages: calcTotalPages(total, pageSize),
    };
  }

  const { countRow, rows } = await submissionsRepository.selectSubmissionPage(filter, course.display_name, pageSize, offset);

  const total = parseInt(countRow?.count || '0', 10);
  return {
    data: rows.map(withFiles),
    total,
    page,
    pageSize,
    totalPages: calcTotalPages(total, pageSize),
  };
}

export async function getSubmissionAuditContext(submissionId: string, tenantId: string) {
  const context = await submissionsRepository.selectSubmissionAuditContext(submissionId, tenantId);
  if (!context) throw new AppError('Submission khong ton tai', 404);
  return context;
}
export async function feedbackSubmission(
  submissionId: string,
  tenantId: string,
  adminId: string,
  input: FeedbackAssignmentInput,
  files?: Express.Multer.File[],
  auditEntry?: (context: AssignmentFeedbackAuditContext, beforeScore: number | null, afterScore: number | null) => TransactionalAuditEntry,
) {
  const ctx = await submissionsRepository.selectFeedbackContext(submissionId, tenantId);
  if (!ctx) throw new AppError('Submission khong ton tai', 404);
  if (ctx.grading_enabled && input.score === undefined) {
    throw new AppError('Vui long nhap diem tu 0 den 100', 400);
  }
  if (!ctx.grading_enabled && input.score !== undefined) {
    throw new AppError('Bai tap nay khong bat cham diem', 400);
  }

  const admin = await submissionsRepository.selectFeedbackAuthor(adminId);
  const feedbackByName = admin?.name || 'Quản trị viên';
  const feedbackByEmail = admin?.email || null;

  const uploadedFiles = await uploadAssignmentFiles(
    files,
    ctx.tenant_id,
    ctx.course_id,
    ctx.assignment_id,
    ctx.id,
    adminId,
    'feedback',
  );

  const client = await getClient();
  try {
    await client.query('BEGIN');

    const tx = createAssignmentSubmissionsRepository(client);
    const current = await tx.lockSubmission(submissionId, tenantId);
    if (!current) throw new AppError('Submission khong ton tai', 404);
    if (current.status !== 'submitted' && current.status !== 'feedback_given') {
      throw new AppError('Submission chua san sang de feedback', 409);
    }

    const uploadedFeedbackFiles = uploadedFiles.map(({ storage_path, ...rest }) => rest);
    const nextFeedbackFiles = uploadedFeedbackFiles.length > 0
      ? uploadedFeedbackFiles
      : normalizeFiles(current.feedback_files);
    const score = ctx.grading_enabled ? input.score! : null;

    const feedbackAt = await tx.updateFeedback({
      feedbackText: input.feedback_text,
      feedbackFiles: JSON.stringify(nextFeedbackFiles),
      score,
      feedbackBy: adminId,
      submissionId,
      tenantId,
    });
    if (feedbackAt === null) {
      throw new AppError('Khong the cap nhat feedback cho submission nay', 409);
    }

    await insertAssignmentFileRows(
      client,
      ctx.tenant_id,
      ctx.course_id,
      ctx.assignment_id,
      ctx.id,
      adminId,
      'feedback',
      uploadedFiles,
    );

    await tx.insertFeedbackHistory({
      tenantId: ctx.tenant_id,
      courseId: ctx.course_id,
      assignmentId: ctx.assignment_id,
      submissionId: ctx.id,
      learnerId: ctx.learner_id,
      feedbackText: input.feedback_text,
      feedbackFiles: JSON.stringify(nextFeedbackFiles),
      score,
      feedbackBy: adminId,
      feedbackAt,
    });

    const notificationId = await tx.insertSingleRecipientNotification({
      tenantId: ctx.tenant_id,
      courseId: ctx.course_id,
      type: 'assignment_feedback',
      metadata: JSON.stringify({
        assignment_id: ctx.assignment_id,
        submission_id: ctx.id,
        course_id: ctx.course_id,
        course_name: ctx.course_name,
        assignment_title: ctx.assignment_title,
        assignment_question: ctx.assignment_question,
        grading_enabled: ctx.grading_enabled,
        feedback_by_name: feedbackByName,
        feedback_by_email: feedbackByEmail,
        feedback_at: feedbackAt,
      }),
      title: 'Bài tập đã có feedback',
      message: `Bài tập "${ctx.assignment_title}" trong khóa học "${ctx.course_name}" đã có feedback mới.`,
      sentBy: adminId,
    });
    await tx.insertNotificationRecipient(notificationId, ctx.learner_id);

    await enqueueFeedbackEmails(client, {
      tenantId: ctx.tenant_id,
      submissionId: ctx.id,
      learnerId: ctx.learner_id,
      learnerName: ctx.learner_name,
      learnerEmail: ctx.learner_email,
      courseName: ctx.course_name,
      assignmentTitle: ctx.assignment_title,
      feedbackText: input.feedback_text,
      feedbackByName,
      feedbackByEmail,
      score,
    });

    if (auditEntry) {
      await appendAuditLog(client, auditEntry({
        submissionId: ctx.id,
        assignmentId: ctx.assignment_id,
        assignmentTitle: ctx.assignment_title,
        courseId: ctx.course_id,
        courseName: ctx.course_name,
        learnerName: ctx.learner_name,
      }, current.score, score));
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    await Promise.all(uploadedFiles.map(file => deleteFile(file.storage_path).catch(swallowAndLog('assignments.storage_cleanup'))));
    throw err;
  } finally {
    client.release();
  }

  // The learner's unread count includes the feedback notification.
  await invalidateUserNotificationCaches(ctx.learner_id);
  wakeEmailOutboxWorker('assignment-feedback');

  return listCourseSubmissions(ctx.course_id, tenantId, { page: '1', page_size: '1', assignment_id: ctx.assignment_id });
}

export async function listSubmissionFeedbackHistory(submissionId: string, tenantId: string) {
  if (!(await submissionsRepository.submissionExists(submissionId, tenantId))) {
    throw new AppError('Submission khong ton tai', 404);
  }

  const rows = await submissionsRepository.selectFeedbackHistory(submissionId, tenantId);

  return rows.map(row => ({
    ...row,
    feedback_files: normalizeFiles(row.feedback_files),
  }));
}
