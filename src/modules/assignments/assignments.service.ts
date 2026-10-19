import type { PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { getClient, query } from '../../config/database.js';
import {
  invalidateTenantNotificationCaches,
  invalidateUserBadgeCaches,
  invalidateUserNotificationCaches,
} from '../../config/cache-invalidation.js';
import {
  buildFileName,
  buildStoragePath,
  deleteFile,
  fixMulterFilename,
  openStorageObjectStream,
  uploadCourseAssetFileFromPath,
  uploadFile,
  type StorageObjectStream,
} from '../../config/storage.js';
import { AppError } from '../../utils/errors.js';
import { appendAuditLog, type TransactionalAuditEntry } from '../../middleware/audit-log.js';
import { isLearnerRole } from '../../types/index.js';
import { calcOffset, calcTotalPages, parsePagination } from '../../utils/query-helpers.js';
import type { AuthUser } from '../../types/express.js';
import type {
  CreateAssignmentInput,
  FeedbackAssignmentInput,
  SubmitAssignmentInput,
  UpdateAssignmentInput,
} from './assignments.validator.js';
import type { AssignmentFileMeta } from './assignments.types.js';
import {
  enqueueCourseNotificationEmailJob,
  enqueueFeedbackEmails,
  wakeEmailOutboxWorker,
} from './email-outbox.service.js';
import {
  getEnrollmentContentCompletion,
  recalculateEnrollmentProgress,
} from '../learner/progress-calculation.service.js';
import { scheduleCourseProgressRecalculation } from '../learner/progress-recalculation-job.service.js';
import { assertUserNotActiveDemoIframeAccount } from '../demo-login/demo-iframe.service.js';
import { swallowAndLog } from '../../utils/best-effort.js';
import {
  createAssignmentsRepository,
  type AssignmentCourseRow,
  type AssignmentRow,
  type AssignmentUpdateColumn,
  type AssignmentsDb,
} from './assignments.repository.js';
import { createAssignmentLearnerRepository } from './assignment-learner.repository.js';
import {
  createAssignmentSubmissionsRepository,
  type SubmissionListRow,
} from './assignment-submissions.repository.js';

// query() joins the caller's current transaction when there is one; the
// transaction blocks below use the repositories over their own client.
const poolDb: AssignmentsDb = { query };
const assignmentsRepository = createAssignmentsRepository(poolDb);
const learnerRepository = createAssignmentLearnerRepository(poolDb);
const submissionsRepository = createAssignmentSubmissionsRepository(poolDb);

const MAX_ASSIGNMENT_FILES = 5;
const MAX_ASSIGNMENT_FILE_SIZE_BYTES = 25 * 1024 * 1024;
const DEADLINE_MODES = ['none', 'absolute', 'relative_to_enrollment'] as const;
const SUBMISSION_UNLOCK_MODES = ['after_content_complete', 'anytime'] as const;

type AssignmentDeadlineMode = typeof DEADLINE_MODES[number];
type AssignmentSubmissionUnlockMode = typeof SUBMISSION_UNLOCK_MODES[number];

type CourseRow = AssignmentCourseRow;

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

export interface AssignmentFeedbackAuditContext {
  submissionId: string;
  assignmentId: string;
  assignmentTitle: string;
  courseId: string;
  courseName: string;
  learnerName: string;
}

interface UploadedAssignmentFile extends AssignmentFileMeta {
  storage_path: string;
}

interface StoredAssignmentAttachment extends UploadedAssignmentFile {
  created_at?: string;
}

function fileDownloadUrl(id: string): string {
  return `/api/assignments/files/${id}`;
}

function normalizeFiles(value: unknown): AssignmentFileMeta[] {
  if (!Array.isArray(value)) return [];
  return value.map((file: any) => ({
    id: String(file.id),
    original_name: String(file.original_name || file.originalName || 'file'),
    mime_type: String(file.mime_type || file.mimeType || 'application/octet-stream'),
    size_bytes: Number(file.size_bytes || file.size || 0),
    download_url: fileDownloadUrl(String(file.id)),
    created_at: file.created_at,
  }));
}

function normalizeAttachmentFile(value: unknown): AssignmentFileMeta | null {
  if (!value || typeof value !== 'object') return null;
  const file = value as Record<string, unknown>;
  const id = typeof file.id === 'string' ? file.id : '';
  if (!id) return null;
  return {
    id,
    original_name: String(file.original_name || file.originalName || 'file'),
    mime_type: String(file.mime_type || file.mimeType || 'application/octet-stream'),
    size_bytes: Number(file.size_bytes || file.size || 0),
    download_url: fileDownloadUrl(id),
    created_at: typeof file.created_at === 'string' ? file.created_at : undefined,
  };
}

function attachmentStoragePath(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const storagePath = (value as Record<string, unknown>).storage_path;
  return typeof storagePath === 'string' && storagePath ? storagePath : null;
}

function normalizeAssignmentRow<T extends Record<string, any>>(row: T): Omit<T, 'is_published'> & { attachment_file: AssignmentFileMeta | null } {
  const rest = { ...row };
  delete rest.is_published;
  return {
    ...rest,
    attachment_file: normalizeAttachmentFile(row.attachment_file),
  };
}

function isDeadlineExpired(deadlineAt?: string | Date | null): boolean {
  if (!deadlineAt) return false;
  const deadlineTime = new Date(deadlineAt).getTime();
  return Number.isFinite(deadlineTime) && deadlineTime <= Date.now();
}

function normalizeDeadlineMode(value: unknown, fallback: AssignmentDeadlineMode = 'none'): AssignmentDeadlineMode {
  return DEADLINE_MODES.includes(value as AssignmentDeadlineMode) ? value as AssignmentDeadlineMode : fallback;
}

function normalizeSubmissionUnlockMode(value: unknown): AssignmentSubmissionUnlockMode {
  return SUBMISSION_UNLOCK_MODES.includes(value as AssignmentSubmissionUnlockMode)
    ? value as AssignmentSubmissionUnlockMode
    : 'after_content_complete';
}

function normalizeDeadlineForWrite(input: {
  deadline_mode?: string;
  deadline_enabled?: boolean;
  deadline_at?: string | null;
  deadline_after_days?: number | null;
}) {
  if (input.deadline_at) {
    throw new AppError('Không còn hỗ trợ hạn cụ thể cho bài tập', 400);
  }
  if (input.deadline_mode === 'absolute') {
    throw new AppError('Không còn hỗ trợ hạn cụ thể cho bài tập', 400);
  }

  const mode = input.deadline_mode === 'none' || input.deadline_enabled === false
    ? 'none'
    : 'relative_to_enrollment';

  if (mode === 'none') {
    return {
      deadlineEnabled: false,
      deadlineMode: 'none' as const,
      deadlineAt: null,
      deadlineAfterDays: null,
    };
  }

  const afterDays = input.deadline_after_days || 7;
  if (!Number.isInteger(afterDays) || afterDays < 1 || afterDays > 3650) {
    throw new AppError('Vui lòng nhập số ngày từ 1 đến 3650', 400);
  }
  return {
    deadlineEnabled: true,
    deadlineMode: 'relative_to_enrollment' as const,
    deadlineAt: null,
    deadlineAfterDays: afterDays,
  };
}

async function ensureCourseForAdmin(courseId: string, tenantId: string): Promise<CourseRow> {
  const course = await assignmentsRepository.selectCourse(courseId, tenantId);
  if (!course) throw new AppError('Course khong ton tai', 404);
  return course;
}

async function hasCoursePermission(user: AuthUser): Promise<boolean> {
  if (user.role === 'superadmin' || user.role === 'superuser') return true;
  if (user.role !== 'staff' || !user.tenantId) return false;
  return assignmentsRepository.staffHasCoursePermission(user.id, user.tenantId);
}

async function getAssignmentForAdmin(assignmentId: string, tenantId: string) {
  const assignment = await assignmentsRepository.selectAssignment(assignmentId, tenantId);
  if (!assignment) throw new AppError('Assignment khong ton tai', 404);
  return assignment;
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

export interface AssignmentFileUploaders {
  fromPath: (storagePath: string, filePath: string, contentType: string) => Promise<unknown>;
  fromBuffer: (storagePath: string, buffer: Buffer, contentType: string) => Promise<unknown>;
}

const defaultAssignmentFileUploaders: AssignmentFileUploaders = {
  fromPath: uploadCourseAssetFileFromPath,
  fromBuffer: uploadFile,
};

/**
 * Learner submissions arrive as temp files (assignments.routes.ts) and are
 * streamed to Storage, so a submission deadline does not hold every file in
 * the heap; admin uploads still arrive in memory. An empty file has nothing
 * to stream and keeps the buffer upload.
 */
export async function storeAssignmentFile(
  storagePath: string,
  file: Pick<Express.Multer.File, 'path' | 'buffer' | 'size' | 'mimetype'>,
  uploaders: AssignmentFileUploaders = defaultAssignmentFileUploaders,
): Promise<void> {
  const contentType = file.mimetype || 'application/octet-stream';
  if (file.path && file.size > 0) {
    await uploaders.fromPath(storagePath, file.path, contentType);
    return;
  }
  await uploaders.fromBuffer(storagePath, file.buffer ?? Buffer.alloc(0), contentType);
}

async function uploadAssignmentFiles(
  files: Express.Multer.File[] | undefined,
  tenantId: string,
  courseId: string,
  assignmentId: string,
  submissionId: string,
  uploadedBy: string,
  kind: 'submission' | 'feedback',
): Promise<UploadedAssignmentFile[]> {
  if (!files || files.length === 0) return [];
  if (files.length > MAX_ASSIGNMENT_FILES) {
    throw new AppError(`Chi duoc upload toi da ${MAX_ASSIGNMENT_FILES} files`, 400);
  }

  const uploaded: UploadedAssignmentFile[] = [];
  try {
    for (const file of files) {
      const id = uuidv4();
      const originalName = fixMulterFilename(file.originalname);
      const storageName = `${id}_${buildFileName(originalName)}`;
      const storagePath = buildStoragePath(
        tenantId,
        'assignments',
        storageName,
        `${courseId}/${assignmentId}/${submissionId}/${kind}/${uploadedBy}`,
      );
      await storeAssignmentFile(storagePath, file);
      uploaded.push({
        id,
        original_name: originalName,
        mime_type: file.mimetype || 'application/octet-stream',
        size_bytes: file.size,
        storage_path: storagePath,
        download_url: fileDownloadUrl(id),
      });
    }
    return uploaded;
  } catch (err) {
    await Promise.all(uploaded.map(file => deleteFile(file.storage_path).catch(swallowAndLog('assignments.storage_cleanup'))));
    throw err;
  }
}

async function uploadAssignmentAttachment(
  file: Express.Multer.File | undefined,
  tenantId: string,
  courseId: string,
  assignmentId: string,
): Promise<StoredAssignmentAttachment | null> {
  if (!file) return null;
  if (file.size > MAX_ASSIGNMENT_FILE_SIZE_BYTES) {
    throw new AppError('File đính kèm không được vượt quá 25MB', 400);
  }

  const id = uuidv4();
  const originalName = fixMulterFilename(file.originalname);
  const storageName = `${id}_${buildFileName(originalName)}`;
  const storagePath = buildStoragePath(
    tenantId,
    'assignments',
    storageName,
    // Assignment attachments belong to the course, not to the staff member
    // who uploaded them. Do not embed a deletable user ID in a long-lived
    // course asset path.
    `${courseId}/${assignmentId}/attachment`,
  );
  await uploadFile(storagePath, file.buffer, file.mimetype || 'application/octet-stream');
  return {
    id,
    original_name: originalName,
    mime_type: file.mimetype || 'application/octet-stream',
    size_bytes: file.size,
    storage_path: storagePath,
    download_url: fileDownloadUrl(id),
    created_at: new Date().toISOString(),
  };
}

async function insertAssignmentFileRows(
  client: PoolClient,
  tenantId: string,
  courseId: string,
  assignmentId: string,
  submissionId: string,
  uploadedBy: string,
  kind: 'submission' | 'feedback',
  files: UploadedAssignmentFile[],
): Promise<void> {
  await createAssignmentsRepository(client).insertAssignmentFiles(
    tenantId,
    courseId,
    assignmentId,
    submissionId,
    uploadedBy,
    kind,
    files,
  );
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
  return { ...(await listCourseAssignments(courseId, tenantId)), course_name: course.display_name };
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

export async function listLearnerCourseAssignments(courseId: string, user: AuthUser) {
  if (!user.tenantId) throw new AppError('Thieu tenant', 400);
  const access = await learnerRepository.selectCourseAccess(courseId, user.id, user.tenantId, isLearnerRole(user.role));
  if (!access) throw new AppError('Khong co quyen truy cap course', 403);

  const enrollmentId = access.enrollment_id;
  const contentCompletion = enrollmentId
    ? await getEnrollmentContentCompletion(enrollmentId, courseId)
    : { total: 0, completed: 0, is_complete: false };
  const rows = await learnerRepository.selectLearnerAssignments(courseId, user.tenantId, user.id);

  return rows.map(row => {
    const deadlineExpired = row.is_deadline_expired === true;
    const unlockMode = normalizeSubmissionUnlockMode(row.submission_unlock_mode);
    const unlockedByContent = unlockMode === 'anytime' || contentCompletion.is_complete;
    const canSubmitAssignment = Boolean(enrollmentId) && unlockedByContent && !deadlineExpired;
    return {
    id: row.id,
    tenant_id: row.tenant_id,
    course_id: row.course_id,
    title: row.title,
    question: row.question,
    sort_order: row.sort_order,
    allow_resubmission: row.allow_resubmission,
    deadline_enabled: row.deadline_enabled,
    deadline_mode: normalizeDeadlineMode(row.deadline_mode),
    deadline_at: row.deadline_at,
    deadline_after_days: row.deadline_after_days,
    effective_deadline_at: row.effective_deadline_at,
    attachment_file: normalizeAttachmentFile(row.attachment_file),
    grading_enabled: row.grading_enabled,
    submission_unlock_mode: unlockMode,
    is_deadline_expired: deadlineExpired,
    status: row.status,
    can_submit: canSubmitAssignment,
    locked_reason: deadlineExpired ? 'deadline' : unlockedByContent ? null : 'content',
    submission: row.submission_id ? {
      id: row.submission_id,
      answer_text: row.answer_text,
      files: normalizeFiles(row.files),
      status: row.status,
      submitted_at: row.submitted_at,
      submission_version: row.submission_version,
      score: row.score,
      feedback_text: row.feedback_text,
      feedback_files: normalizeFiles(row.feedback_files),
      feedback_by: row.feedback_by,
      feedback_by_username: row.feedback_by_username,
      feedback_by_name: row.feedback_by_name,
      feedback_by_email: row.feedback_by_email,
      feedback_at: row.feedback_at,
    } : null,
    };
  });
}

export async function getLearnerAssignment(assignmentId: string, user: AuthUser) {
  if (!user.tenantId) throw new AppError('Thieu tenant', 400);
  const courseId = await learnerRepository.selectAssignmentCourseId(assignmentId, user.tenantId);
  if (courseId === null) throw new AppError('Assignment khong ton tai', 404);
  const assignments = await listLearnerCourseAssignments(courseId, user);
  const assignment = assignments.find(item => item.id === assignmentId);
  if (!assignment) throw new AppError('Assignment khong ton tai', 404);
  return assignment;
}

export async function submitAssignment(
  assignmentId: string,
  user: AuthUser,
  input: SubmitAssignmentInput,
  files?: Express.Multer.File[],
) {
  if (!user.tenantId) throw new AppError('Thieu tenant', 400);
  await assertUserNotActiveDemoIframeAccount(user.id, 'Phiên demo iframe không thể nộp assignment');
  if (user.role !== 'learner' && user.role !== 'learner_plus') {
    throw new AppError('Chỉ học viên mới có thể nộp bài tập', 403);
  }

  const ctx = await learnerRepository.selectSubmitAccess(assignmentId, user.tenantId, user.id);
  if (!ctx) throw new AppError('Assignment khong ton tai hoac khong co quyen', 404);

  if (ctx.submission_unlock_mode === 'after_content_complete') {
    const contentCompletion = await getEnrollmentContentCompletion(ctx.enrollment_id, ctx.course_id);
    if (!contentCompletion.is_complete) {
      throw new AppError('Cần hoàn thành nội dung khóa học trước khi nộp bài tập', 403);
    }
  }
  if (isDeadlineExpired(ctx.effective_deadline_at)) {
    throw new AppError('Đã hết thời hạn nộp bài tập', 403);
  }

  const existing = await learnerRepository.selectOwnSubmission(assignmentId, user.id);

  if (existing?.status === 'feedback_given') {
    throw new AppError('Assignment da co feedback, khong the nop lai', 409);
  }
  if (existing?.status === 'submitted' && !ctx.allow_resubmission) {
    throw new AppError('Assignment khong cho phep nop lai', 409);
  }

  const submissionId = existing?.id || uuidv4();
  const uploadedFiles = await uploadAssignmentFiles(
    files,
    ctx.tenant_id,
    ctx.course_id,
    ctx.assignment_id,
    submissionId,
    user.id,
    'submission',
  );

  const client = await getClient();
  const oldStoragePaths: string[] = [];
  try {
    await client.query('BEGIN');

    const tx = createAssignmentLearnerRepository(client);
    if (existing !== undefined) {
      oldStoragePaths.push(...(await tx.deleteSubmissionFiles(submissionId)));

      await tx.resubmit(
        input.answer_text,
        JSON.stringify(uploadedFiles.map(({ storage_path, ...rest }) => rest)),
        submissionId,
      );
    } else {
      await tx.insertSubmission({
        submissionId,
        tenantId: ctx.tenant_id,
        courseId: ctx.course_id,
        assignmentId: ctx.assignment_id,
        learnerId: user.id,
        enrollmentId: ctx.enrollment_id,
        answerText: input.answer_text,
        files: JSON.stringify(uploadedFiles.map(({ storage_path, ...rest }) => rest)),
      });
    }

    await insertAssignmentFileRows(
      client,
      ctx.tenant_id,
      ctx.course_id,
      ctx.assignment_id,
      submissionId,
      user.id,
      'submission',
      uploadedFiles,
    );

    await recalculateEnrollmentProgress(ctx.enrollment_id, ctx.course_id, client);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    await Promise.all(uploadedFiles.map(file => deleteFile(file.storage_path).catch(swallowAndLog('assignments.storage_cleanup'))));
    throw err;
  } finally {
    client.release();
  }

  // The submission can complete the course: badges are evaluated again.
  await invalidateUserBadgeCaches([user.id]);
  await Promise.all(oldStoragePaths.map(path => deleteFile(path).catch(swallowAndLog('assignments.storage_cleanup'))));
  return getLearnerAssignment(assignmentId, user);
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

export interface AssignmentFileDownload {
  body: StorageObjectStream['body'];
  contentLength: number | null;
  contentType: string;
  originalName: string;
}

export interface AssignmentFileDownloadOptions {
  /** Aborts the Storage request (the controller ties it to the client connection). */
  signal?: AbortSignal;
  openObject?: typeof openStorageObjectStream;
}

async function openAssignmentFile(
  storagePath: string,
  mimeType: string | null,
  originalName: string,
  options: AssignmentFileDownloadOptions,
): Promise<AssignmentFileDownload> {
  const opened = await (options.openObject ?? openStorageObjectStream)(storagePath, { signal: options.signal });
  return {
    body: opened.body,
    contentLength: opened.contentLength,
    contentType: mimeType || opened.contentType || 'application/octet-stream',
    originalName,
  };
}

/**
 * An assignment attachment or submission/feedback file, after the access
 * check, as a stream from Storage: a download is never held whole in the
 * heap (many learners download at a deadline).
 */
export async function getAssignmentFileForDownload(
  fileId: string,
  user: AuthUser,
  options: AssignmentFileDownloadOptions = {},
): Promise<AssignmentFileDownload> {
  const attachment = await learnerRepository.selectAttachmentDownload(fileId);

  if (attachment) {
    const file = attachment;
    const sameTenant = user.role === 'superadmin' || user.tenantId === file.tenant_id;
    const isAdmin = sameTenant && await hasCoursePermission(user);
    let learnerAllowed = false;

    if (sameTenant && user.tenantId && isLearnerRole(user.role)) {
      learnerAllowed = await learnerRepository.learnerCanOpenCourse(file.course_id, user.tenantId, user.id);
    }

    if ((!isAdmin && !learnerAllowed) || !sameTenant || !file.storage_path) {
      throw new AppError('Khong co quyen tai file nay', 403);
    }

    return openAssignmentFile(file.storage_path, file.mime_type, file.original_name || 'file', options);
  }

  const file = await learnerRepository.selectAssignmentFileDownload(fileId);
  if (!file) throw new AppError('File khong ton tai', 404);

  const sameTenant = user.role === 'superadmin' || user.tenantId === file.tenant_id;
  const isAdmin = sameTenant && await hasCoursePermission(user);
  const currentFeedbackFileIds = new Set(normalizeFiles(file.feedback_files).map(item => item.id));
  const learnerAllowed = file.learner_id === user.id && (
    (file.kind === 'submission' && file.uploaded_by === user.id)
    || (file.kind === 'feedback' && currentFeedbackFileIds.has(file.id))
  );
  if ((!isAdmin && !learnerAllowed) || !sameTenant) {
    throw new AppError('Khong co quyen tai file nay', 403);
  }

  return openAssignmentFile(file.storage_path, file.mime_type, file.original_name, options);
}
