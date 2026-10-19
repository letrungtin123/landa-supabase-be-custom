import { v4 as uuidv4 } from 'uuid';
import { getClient } from '../../config/database.js';
import { invalidateTenantNotificationCaches } from '../../config/cache-invalidation.js';
import { deleteFile } from '../../config/storage.js';
import { AppError } from '../../utils/errors.js';
import { appendAuditLog, type TransactionalAuditEntry } from '../../middleware/audit-log.js';
import type { CreateAssignmentInput, UpdateAssignmentInput } from './assignments.validator.js';
import { enqueueCourseNotificationEmailJob, wakeEmailOutboxWorker } from './email-outbox.service.js';
import { scheduleCourseProgressRecalculation } from '../learner/progress-recalculation-job.service.js';
import { swallowAndLog } from '../../utils/best-effort.js';
import {
  createAssignmentsRepository,
  type AssignmentRow,
  type AssignmentUpdateColumn,
} from './assignments.repository.js';
import {
  assignmentsRepository,
  type CourseRow,
  ensureCourseForAdmin,
  getAssignmentForAdmin,
} from './assignment-access.service.js';
import {
  normalizeAttachmentFile,
  attachmentStoragePath,
  normalizeAssignmentRow,
  normalizeDeadlineMode,
  normalizeSubmissionUnlockMode,
  normalizeDeadlineForWrite,
} from './assignment-rules.logic.js';
import { uploadAssignmentAttachment } from './assignment-files.service.js';
// The assignment service is split by concern; every name stays importable from here.
export { storeAssignmentFile, getAssignmentFileForDownload } from './assignment-files.service.js';
export type {
  AssignmentFileUploaders,
  AssignmentFileDownload,
  AssignmentFileDownloadOptions,
} from './assignment-files.service.js';
export { listLearnerCourseAssignments, getLearnerAssignment, submitAssignment } from './assignment-learner.service.js';
export {
  listCourseSubmissions,
  getSubmissionAuditContext,
  feedbackSubmission,
  listSubmissionFeedbackHistory,
} from './assignment-submissions.service.js';
export type { AssignmentFeedbackAuditContext } from './assignment-submissions.service.js';

export interface AssignmentAuditSnapshot {
  id: string;
  course_id: string;
  course_name: string;
  title: string;
  allow_resubmission: boolean;
  deadline_at: string | Date | null;
  submission_unlock_mode: string | null;
  has_attachment: boolean;
}

function toAssignmentAuditSnapshot(row: AssignmentRow, courseName?: string): AssignmentAuditSnapshot {
  return {
    id: String(row.id),
    course_id: String(row.course_id),
    course_name: String(courseName || row.course_name || ''),
    title: String(row.title),
    allow_resubmission: row.allow_resubmission === true,
    deadline_at: row.deadline_at ?? null,
    submission_unlock_mode: row.submission_unlock_mode ?? null,
    has_attachment: Boolean(normalizeAttachmentFile(row.attachment_file)),
  };
}

export async function listCourseAssignments(courseId: string, tenantId: string) {
  await ensureCourseForAdmin(courseId, tenantId);
  const rows = await assignmentsRepository.selectCourseAssignments(courseId, tenantId);
  return rows.map(row => normalizeAssignmentRow(row));
}

export async function createAssignment(
  courseId: string,
  tenantId: string,
  userId: string,
  input: CreateAssignmentInput,
  attachmentFile?: Express.Multer.File,
  auditEntry?: (assignment: AssignmentAuditSnapshot) => TransactionalAuditEntry,
) {
  const course = await ensureCourseForAdmin(courseId, tenantId);
  if (await assignmentsRepository.courseHasAssignment(tenantId, courseId)) {
    throw new AppError('Mỗi khóa học chỉ được có 1 bài tập', 409);
  }

  const assignmentId = uuidv4();
  const uploadedAttachment = await uploadAssignmentAttachment(attachmentFile, tenantId, courseId, assignmentId);
  const client = await getClient();
  let assignmentCreatedEmailJobQueued = false;
  let createdAssignment: Record<string, unknown> = {};
  const deadline = normalizeDeadlineForWrite(input);
  const submissionUnlockMode = normalizeSubmissionUnlockMode(input.submission_unlock_mode);

  try {
    await client.query('BEGIN');
    const tx = createAssignmentsRepository(client);

    const assignment = await tx.insertAssignment({
      assignmentId,
      tenantId,
      courseId,
      title: input.title,
      question: input.question,
      allowResubmission: input.allow_resubmission,
      deadlineEnabled: deadline.deadlineEnabled,
      deadlineMode: deadline.deadlineMode,
      deadlineAt: deadline.deadlineAt,
      deadlineAfterDays: deadline.deadlineAfterDays,
      submissionUnlockMode,
      gradingEnabled: input.grading_enabled,
      attachmentFile: uploadedAttachment ? JSON.stringify(uploadedAttachment) : null,
      createdBy: userId,
    });

    if (!course.visible_to_staff_only) {
      const notificationId = await tx.insertCourseNotification({
        tenantId,
        courseId,
        type: 'assignment_created',
        metadata: JSON.stringify({
            assignment_id: assignment.id,
            course_id: course.id,
            course_name: course.display_name,
            assignment_title: assignment.title,
            assignment_question: assignment.question,
            attachment_file: normalizeAttachmentFile(assignment.attachment_file),
            deadline_enabled: assignment.deadline_enabled,
            deadline_mode: assignment.deadline_mode,
            deadline_at: assignment.deadline_at,
            deadline_after_days: assignment.deadline_after_days,
            grading_enabled: assignment.grading_enabled,
            submission_unlock_mode: assignment.submission_unlock_mode,
            created_at: assignment.created_at,
            recipient_rule: course.is_public ? 'all_active_learners' : 'course_assignments',
          }),
        title: 'Bài tập mới',
        message: assignment.deadline_mode === 'relative_to_enrollment' && assignment.deadline_after_days
          ? `Khóa học "${course.display_name}" vừa có bài tập mới: "${assignment.title}". Hạn nộp sau ${assignment.deadline_after_days} ngày, tính từ lúc học viên ghi danh hoặc từ lúc bài tập được tạo nếu học viên đã ghi danh trước đó.`
          : `Khóa học "${course.display_name}" vừa có bài tập mới: "${assignment.title}". Bài tập này không có thời hạn nộp.`,
        sentBy: userId,
      });

      const recipients = await tx.addCourseLearnerRecipients(tenantId, courseId, notificationId, course.is_public);

      const recipientCount = Number(recipients?.recipient_count || 0);
      if (recipientCount > 0) {
        const emailJobCount = await enqueueCourseNotificationEmailJob(client, {
          tenantId,
          notificationId,
          courseId,
        });
        assignmentCreatedEmailJobQueued = emailJobCount > 0;
      } else {
        await tx.deleteNotification(notificationId);
      }
    }

    if (auditEntry) await appendAuditLog(client, auditEntry(toAssignmentAuditSnapshot(assignment, course.display_name)));
    await client.query('COMMIT');
    createdAssignment = assignment;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined); // fails only on a broken connection, which pg-pool discards
    if (uploadedAttachment) {
      await deleteFile(uploadedAttachment.storage_path).catch(swallowAndLog('assignments.storage_cleanup'));
    }
    if ((err as { code?: string }).code === '23505') {
      throw new AppError('Mỗi khóa học chỉ được có 1 bài tập', 409);
    }
    throw err;
  } finally {
    client.release();
  }

  // After the commit and with the connection back in the pool: a slow
  // broker or cache never holds it, and a failure here can no longer roll
  // back (or delete the attachment of) the committed assignment.
  // Learners' unread counts include the new assignment notification.
  if (!course.visible_to_staff_only) await invalidateTenantNotificationCaches(tenantId);

  await scheduleCourseProgressRecalculation({
    tenantId,
    courseId,
    reason: 'assignment_created',
    assignmentId: String(createdAssignment.id),
  });

  if (assignmentCreatedEmailJobQueued) {
    wakeEmailOutboxWorker('assignment-created');
  }

  return normalizeAssignmentRow(createdAssignment);
}

export async function updateAssignment(
  assignmentId: string,
  tenantId: string,
  userId: string,
  input: UpdateAssignmentInput,
  attachmentFile?: Express.Multer.File,
  auditEntry?: (before: AssignmentAuditSnapshot, after: AssignmentAuditSnapshot) => TransactionalAuditEntry,
) {
  const current = await getAssignmentForAdmin(assignmentId, tenantId);
  const currentDeadlineMode = normalizeDeadlineMode(
    current.deadline_mode,
    current.deadline_enabled ? 'absolute' : 'none',
  );

  if (
    input.deadline_mode !== undefined
    || input.deadline_enabled !== undefined
    || input.deadline_at !== undefined
    || input.deadline_after_days !== undefined
  ) {
    throw new AppError('Không thể chỉnh hạn bài tập sau khi đã tạo', 400);
  }

  if (input.deadline_mode !== undefined && input.deadline_mode !== currentDeadlineMode) {
    throw new AppError('Không thể đổi kiểu thời hạn sau khi tạo bài tập', 400);
  }
  if (input.deadline_enabled !== undefined && input.deadline_enabled !== (currentDeadlineMode !== 'none')) {
    throw new AppError('Không thể đổi kiểu thời hạn sau khi tạo bài tập', 400);
  }
  if (input.deadline_after_days !== undefined) {
    if (currentDeadlineMode !== 'relative_to_enrollment' || input.deadline_after_days !== current.deadline_after_days) {
      throw new AppError('Không thể đổi số ngày hết hạn sau khi tạo bài tập', 400);
    }
  }
  if (input.deadline_at !== undefined) {
    if (currentDeadlineMode !== 'absolute') {
      throw new AppError('Chỉ bài tập có hạn cụ thể mới được sửa ngày hết hạn', 400);
    }
    if (!input.deadline_at) {
      throw new AppError('Vui lòng chọn thời hạn nộp bài', 400);
    }
  }

  const uploadedAttachment = await uploadAssignmentAttachment(
    attachmentFile,
    tenantId,
    current.course_id,
    assignmentId,
  );
  const shouldChangeAttachment = Boolean(uploadedAttachment || input.remove_attachment);
  const oldAttachmentPath = shouldChangeAttachment ? attachmentStoragePath(current.attachment_file) : null;

  const sets: [AssignmentUpdateColumn, unknown][] = [];

  if (input.title !== undefined) sets.push(['title = $n::varchar', input.title]);
  if (input.question !== undefined) sets.push(['question = $n::text', input.question]);
  if (input.allow_resubmission !== undefined) sets.push(['allow_resubmission = $n::boolean', input.allow_resubmission]);
  if (input.deadline_at !== undefined) {
    sets.push(['deadline_at = $n::timestamptz', input.deadline_at]);
  }
  if (input.submission_unlock_mode !== undefined) sets.push(['submission_unlock_mode = $n::varchar', input.submission_unlock_mode]);
  if (shouldChangeAttachment) {
    sets.push(['attachment_file = $n::jsonb', uploadedAttachment ? JSON.stringify(uploadedAttachment) : null]);
  }
  if (sets.length === 0) throw new AppError('Không có dữ liệu cần cập nhật', 400);
  const client = await getClient();
  try {
    await client.query('BEGIN');

    const updated = await createAssignmentsRepository(client).updateAssignmentColumns(assignmentId, tenantId, sets);
    if (!updated) throw new AppError('Assignment khong ton tai', 404);
    if (auditEntry) {
      await appendAuditLog(
        client,
        auditEntry(
          toAssignmentAuditSnapshot(current),
          toAssignmentAuditSnapshot(updated, current.course_name),
        ),
      );
    }
    await client.query('COMMIT');
    if (oldAttachmentPath) {
      await deleteFile(oldAttachmentPath).catch(swallowAndLog('assignments.storage_cleanup'));
    }
    return normalizeAssignmentRow(updated);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined); // fails only on a broken connection, which pg-pool discards
    if (uploadedAttachment) {
      await deleteFile(uploadedAttachment.storage_path).catch(swallowAndLog('assignments.storage_cleanup'));
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteAssignment(
  assignmentId: string,
  tenantId: string,
  auditEntry?: (assignment: AssignmentAuditSnapshot) => TransactionalAuditEntry,
) {
  const current = await getAssignmentForAdmin(assignmentId, tenantId);
  const client = await getClient();
  try {
    await client.query('BEGIN');
    if (!(await createAssignmentsRepository(client).softDeleteAssignment(assignmentId, tenantId))) {
      throw new AppError('Assignment khong ton tai', 404);
    }
    if (auditEntry) await appendAuditLog(client, auditEntry(toAssignmentAuditSnapshot(current)));
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined); // fails only on a broken connection, which pg-pool discards
    throw err;
  } finally {
    client.release();
  }

  // After the commit and with the connection back in the pool.
  await scheduleCourseProgressRecalculation({
    tenantId,
    courseId: current.course_id,
    reason: 'assignment_deleted',
    assignmentId: current.id,
  });

  return {
    id: current.id,
    title: current.title,
    course_id: current.course_id,
    course_name: current.course_name,
  };
}

export async function reorderAssignments(
  courseId: string,
  tenantId: string,
  assignmentIds: string[],
  auditEntry?: (course: CourseRow, affectedCount: number) => TransactionalAuditEntry | null,
) {
  const course = await ensureCourseForAdmin(courseId, tenantId);
  const existingIds = new Set(await assignmentsRepository.selectCourseAssignmentIds(tenantId, courseId));
  if (assignmentIds.some(id => !existingIds.has(id))) {
    throw new AppError('Danh sach assignment reorder khong hop le', 400);
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');
    const tx = createAssignmentsRepository(client);
    for (let i = 0; i < assignmentIds.length; i += 1) {
      await tx.updateSortOrder(i, assignmentIds[i], tenantId, courseId);
    }
    if (auditEntry) {
      const entry = auditEntry(course, assignmentIds.length);
      if (entry) await appendAuditLog(client, entry);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  // The course's assignments in their new order, as the list route answers
  // them (the dashboard's reorderCourseAssignments reads an array).
  return listCourseAssignments(courseId, tenantId);
}
