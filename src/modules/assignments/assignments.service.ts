import type { PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { getClient, query } from '../../config/database.js';
import {
  buildFileName,
  buildStoragePath,
  deleteFile,
  downloadFileBuffer,
  fixMulterFilename,
  uploadFile,
} from '../../config/storage.js';
import { AppError } from '../../middleware/error-handler.js';
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
  enqueueAssignmentCreatedEmailsForNotification,
  enqueueFeedbackEmails,
  processEmailOutboxBatch,
} from './email-outbox.service.js';
import {
  getEnrollmentContentCompletion,
  recalculateCourseProgressForActiveEnrollments,
  recalculateEnrollmentProgress,
} from '../learner/progress-calculation.service.js';

const MAX_ASSIGNMENT_FILES = 5;
const DEADLINE_MODES = ['none', 'absolute', 'relative_to_enrollment'] as const;
const SUBMISSION_UNLOCK_MODES = ['after_content_complete', 'anytime'] as const;

type AssignmentDeadlineMode = typeof DEADLINE_MODES[number];
type AssignmentSubmissionUnlockMode = typeof SUBMISSION_UNLOCK_MODES[number];

interface CourseRow {
  id: string;
  display_name: string;
  tenant_id: string;
  visible_to_staff_only: boolean;
}

interface UploadedAssignmentFile extends AssignmentFileMeta {
  storage_path: string;
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

function inferDeadlineMode(input: {
  deadline_mode?: string;
  deadline_enabled?: boolean;
  deadline_at?: string | null;
  deadline_after_days?: number | null;
}): AssignmentDeadlineMode {
  if (input.deadline_mode) return normalizeDeadlineMode(input.deadline_mode);
  if (input.deadline_enabled === true) return input.deadline_after_days ? 'relative_to_enrollment' : 'absolute';
  if (input.deadline_at) return 'absolute';
  if (input.deadline_after_days) return 'relative_to_enrollment';
  return 'none';
}

function normalizeDeadlineForWrite(input: {
  deadline_mode?: string;
  deadline_enabled?: boolean;
  deadline_at?: string | null;
  deadline_after_days?: number | null;
}) {
  const mode = inferDeadlineMode(input);
  if (mode === 'absolute' && !input.deadline_at) {
    throw new AppError('Vui lòng chọn thời hạn nộp bài', 400);
  }
  if (mode === 'relative_to_enrollment' && !input.deadline_after_days) {
    throw new AppError('Vui lòng nhập số ngày tính từ lúc học viên ghi danh', 400);
  }
  return {
    deadlineEnabled: mode !== 'none',
    deadlineMode: mode,
    deadlineAt: mode === 'absolute' ? input.deadline_at : null,
    deadlineAfterDays: mode === 'relative_to_enrollment' ? input.deadline_after_days : null,
  };
}

function effectiveDeadlineExpression(alias = 'ca', enrollmentAlias = 'e'): string {
  return `CASE
    WHEN COALESCE(${alias}.deadline_mode, CASE WHEN ${alias}.deadline_enabled THEN 'absolute' ELSE 'none' END) = 'absolute'
      THEN ${alias}.deadline_at
    WHEN COALESCE(${alias}.deadline_mode, CASE WHEN ${alias}.deadline_enabled THEN 'absolute' ELSE 'none' END) = 'relative_to_enrollment'
      AND ${alias}.deadline_after_days IS NOT NULL
      THEN ${enrollmentAlias}.enrolled_at + (${alias}.deadline_after_days * INTERVAL '1 day')
    ELSE NULL
  END`;
}

async function ensureCourseForAdmin(courseId: string, tenantId: string): Promise<CourseRow> {
  const result = await query<CourseRow>(
    `SELECT id, display_name, tenant_id, COALESCE(visible_to_staff_only, false) AS visible_to_staff_only
     FROM courses
     WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
    [courseId, tenantId],
  );
  if (result.rowCount === 0) throw new AppError('Course khong ton tai', 404);
  return result.rows[0];
}

async function hasCoursePermission(user: AuthUser): Promise<boolean> {
  if (user.role === 'superadmin' || user.role === 'superuser') return true;
  if (user.role !== 'staff' || !user.tenantId) return false;
  const result = await query<{ allowed: boolean }>(
    `SELECT bool_or(pgm.can_view OR pgm.can_edit) AS allowed
     FROM user_permission_groups upg
     JOIN permission_group_modules pgm ON pgm.permission_group_id = upg.permission_group_id
     JOIN modules m ON m.id = pgm.module_id
     JOIN permission_groups pg ON pg.id = upg.permission_group_id
     WHERE upg.user_id = $1
       AND m.code = 'courses'
       AND pg.tenant_id = $2`,
    [user.id, user.tenantId],
  );
  return result.rows[0]?.allowed === true;
}

async function getAssignmentForAdmin(assignmentId: string, tenantId: string) {
  const result = await query(
    `SELECT ca.*, c.display_name AS course_name
     FROM course_assignments ca
     JOIN courses c ON c.id = ca.course_id
     WHERE ca.id = $1 AND ca.tenant_id = $2 AND ca.deleted_at IS NULL`,
    [assignmentId, tenantId],
  );
  if (result.rowCount === 0) throw new AppError('Assignment khong ton tai', 404);
  return result.rows[0];
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
      await uploadFile(storagePath, file.buffer, file.mimetype || 'application/octet-stream');
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
    await Promise.all(uploaded.map(file => deleteFile(file.storage_path).catch(() => undefined)));
    throw err;
  }
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
  for (const file of files) {
    await client.query(
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
}

export async function listCourseAssignments(courseId: string, tenantId: string) {
  await ensureCourseForAdmin(courseId, tenantId);
  const result = await query(
    `SELECT ca.id, ca.tenant_id, ca.course_id, ca.title, ca.question, ca.sort_order,
            ca.is_published, ca.allow_resubmission, ca.deadline_enabled, ca.deadline_at,
            COALESCE(ca.deadline_mode, CASE WHEN ca.deadline_enabled THEN 'absolute' ELSE 'none' END) AS deadline_mode,
            ca.deadline_after_days,
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
}

export async function createAssignment(
  courseId: string,
  tenantId: string,
  userId: string,
  input: CreateAssignmentInput,
) {
  const course = await ensureCourseForAdmin(courseId, tenantId);
  const client = await getClient();
  let assignmentCreatedEmailContext: {
    tenantId: string;
    notificationId: string;
    courseName: string;
    assignmentTitle: string;
    assignmentQuestion: string;
    deadlineEnabled: boolean;
    deadlineAt: string | Date | null;
    deadlineMode: AssignmentDeadlineMode;
    deadlineAfterDays: number | null;
    submissionUnlockMode: AssignmentSubmissionUnlockMode;
  } | null = null;
  const deadline = normalizeDeadlineForWrite(input);
  const submissionUnlockMode = normalizeSubmissionUnlockMode(input.submission_unlock_mode);

  try {
    await client.query('BEGIN');

    const result = await client.query(
      `INSERT INTO course_assignments (
         tenant_id, course_id, title, question, is_published, allow_resubmission,
         deadline_enabled, deadline_mode, deadline_at, deadline_after_days,
         submission_unlock_mode, grading_enabled, sort_order, created_by
       )
       VALUES (
         $1::uuid, $2::varchar, $3::varchar, $4::text, $5::boolean, $6::boolean,
         $7::boolean, $8::varchar, $9::timestamptz, $10::integer,
         $11::varchar, $12::boolean,
         COALESCE((SELECT MAX(sort_order) + 1 FROM course_assignments WHERE tenant_id = $1::uuid AND course_id = $2::varchar AND deleted_at IS NULL), 0),
         $13::uuid
       )
       RETURNING *`,
      [
        tenantId,
        courseId,
        input.title,
        input.question,
        input.is_published,
        input.allow_resubmission,
        deadline.deadlineEnabled,
        deadline.deadlineMode,
        deadline.deadlineAt,
        deadline.deadlineAfterDays,
        submissionUnlockMode,
        input.grading_enabled,
        userId,
      ],
    );
    const assignment = result.rows[0];

    if (assignment.is_published) {
      await recalculateCourseProgressForActiveEnrollments(courseId, client);
    }

    if (assignment.is_published && !course.visible_to_staff_only) {
      const notification = await client.query<{ id: string }>(
        `INSERT INTO notifications (tenant_id, course_id, type, metadata, title, message, sent_by, recipient_count)
         VALUES ($1::uuid, $2::varchar, $3::varchar, $4::jsonb, $5::varchar, $6::text, $7::uuid, 0)
         RETURNING id`,
        [
          tenantId,
          courseId,
          'assignment_created',
          JSON.stringify({
            assignment_id: assignment.id,
            course_id: course.id,
            course_name: course.display_name,
            assignment_title: assignment.title,
            assignment_question: assignment.question,
            deadline_enabled: assignment.deadline_enabled,
            deadline_mode: assignment.deadline_mode,
            deadline_at: assignment.deadline_at,
            deadline_after_days: assignment.deadline_after_days,
            grading_enabled: assignment.grading_enabled,
            submission_unlock_mode: assignment.submission_unlock_mode,
            created_at: assignment.created_at,
          }),
          'Bài tập mới',
          assignment.deadline_enabled && assignment.deadline_at
            ? `Khóa học "${course.display_name}" vừa có bài tập mới: "${assignment.title}". Hạn nộp: ${new Date(assignment.deadline_at).toLocaleString('vi-VN')}.`
            : `Khóa học "${course.display_name}" vừa có bài tập mới: "${assignment.title}".`,
          userId,
        ],
      );
      const notificationId = notification.rows[0].id;

      const recipientResult = await client.query<{ recipient_count: number }>(
        `WITH assigned_learners AS (
           SELECT DISTINCT u.id AS user_id
           FROM users u
           JOIN team_members tm ON tm.user_id = u.id
           WHERE u.tenant_id = $1::uuid
             AND u.is_active = true
             AND u.role IN ('learner'::user_role, 'learner_plus'::user_role)
             AND EXISTS (
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
         ),
         inserted AS (
           INSERT INTO notification_recipients (notification_id, user_id)
           SELECT $3::uuid, user_id
           FROM assigned_learners
           ON CONFLICT DO NOTHING
           RETURNING user_id
         )
         UPDATE notifications
         SET recipient_count = (SELECT COUNT(*)::int FROM inserted)
         WHERE id = $3::uuid
         RETURNING recipient_count`,
        [tenantId, courseId, notificationId],
      );

      const recipientCount = Number(recipientResult.rows[0]?.recipient_count || 0);
      if (recipientCount > 0) {
        assignmentCreatedEmailContext = {
          tenantId,
          notificationId,
          courseName: course.display_name,
          assignmentTitle: assignment.title,
          assignmentQuestion: assignment.question,
          deadlineEnabled: assignment.deadline_enabled,
          deadlineAt: assignment.deadline_at,
          deadlineMode: assignment.deadline_mode,
          deadlineAfterDays: assignment.deadline_after_days,
          submissionUnlockMode: assignment.submission_unlock_mode,
        };
      } else {
        await client.query('DELETE FROM notifications WHERE id = $1::uuid', [notificationId]);
      }
    }

    await client.query('COMMIT');

    if (assignmentCreatedEmailContext) {
      enqueueAssignmentCreatedEmailsForNotification(assignmentCreatedEmailContext).then(emailCount => {
        if (emailCount > 0) return processEmailOutboxBatch(tenantId);
        return 0;
      }).catch(err => {
        console.error('[AssignmentCreated] Email enqueue error:', err instanceof Error ? err.message : err);
      });
    }

    return assignment;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function updateAssignment(assignmentId: string, tenantId: string, input: UpdateAssignmentInput) {
  const current = await getAssignmentForAdmin(assignmentId, tenantId);
  const currentDeadlineMode = normalizeDeadlineMode(
    current.deadline_mode,
    current.deadline_enabled ? 'absolute' : 'none',
  );

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

  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (input.title !== undefined) { sets.push(`title = $${idx++}::varchar`); params.push(input.title); }
  if (input.question !== undefined) { sets.push(`question = $${idx++}::text`); params.push(input.question); }
  if (input.is_published !== undefined) { sets.push(`is_published = $${idx++}::boolean`); params.push(input.is_published); }
  if (input.allow_resubmission !== undefined) { sets.push(`allow_resubmission = $${idx++}::boolean`); params.push(input.allow_resubmission); }
  if (input.deadline_at !== undefined) {
    sets.push(`deadline_at = $${idx++}::timestamptz`);
    params.push(input.deadline_at);
  }
  if (input.submission_unlock_mode !== undefined) { sets.push(`submission_unlock_mode = $${idx++}::varchar`); params.push(input.submission_unlock_mode); }
  if (sets.length === 0) throw new AppError('Không có dữ liệu cần cập nhật', 400);

  const shouldRecalculateCourse = input.is_published !== undefined && input.is_published !== current.is_published;
  const client = await getClient();
  try {
    await client.query('BEGIN');

    params.push(assignmentId, tenantId);
    const result = await client.query(
      `UPDATE course_assignments
       SET ${sets.join(', ')}
       WHERE id = $${idx++}::uuid AND tenant_id = $${idx}::uuid AND deleted_at IS NULL
       RETURNING *`,
      params,
    );
    if (shouldRecalculateCourse) {
      await recalculateCourseProgressForActiveEnrollments(current.course_id, client);
    }

    await client.query('COMMIT');
    return result.rows[0];
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteAssignment(assignmentId: string, tenantId: string) {
  const current = await getAssignmentForAdmin(assignmentId, tenantId);
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE course_assignments
       SET deleted_at = now(), is_published = false
       WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
       RETURNING id`,
      [assignmentId, tenantId],
    );
    if (result.rowCount === 0) throw new AppError('Assignment khong ton tai', 404);
    if (current.is_published) {
      await recalculateCourseProgressForActiveEnrollments(current.course_id, client);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function reorderAssignments(courseId: string, tenantId: string, assignmentIds: string[]) {
  await ensureCourseForAdmin(courseId, tenantId);
  const existing = await query<{ id: string }>(
    `SELECT id
     FROM course_assignments
     WHERE tenant_id = $1 AND course_id = $2 AND deleted_at IS NULL`,
    [tenantId, courseId],
  );
  const existingIds = new Set(existing.rows.map(row => row.id));
  if (assignmentIds.some(id => !existingIds.has(id))) {
    throw new AppError('Danh sach assignment reorder khong hop le', 400);
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < assignmentIds.length; i += 1) {
      await client.query(
        `UPDATE course_assignments
         SET sort_order = $1
         WHERE id = $2 AND tenant_id = $3 AND course_id = $4`,
        [i, assignmentIds[i], tenantId, courseId],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return listCourseAssignments(courseId, tenantId);
}

export async function listCourseSubmissions(courseId: string, tenantId: string, queryParams: Record<string, unknown>) {
  const course = await ensureCourseForAdmin(courseId, tenantId);
  const { page, pageSize, search } = parsePagination(queryParams);
  const offset = calcOffset(page, pageSize);
  const status = typeof queryParams.status === 'string'
    && ['not_submitted', 'submitted', 'feedback_given'].includes(queryParams.status)
    ? queryParams.status
    : undefined;

  if (!status || status === 'not_submitted') {
    const params: unknown[] = [tenantId, courseId, course.visible_to_staff_only];
    const assignmentConditions = [
      'ca.tenant_id = $1::uuid',
      'ca.course_id = $2::varchar',
      'ca.deleted_at IS NULL',
      'ca.is_published = true',
    ];
    const stateConditions: string[] = [];

    if (typeof queryParams.assignment_id === 'string' && queryParams.assignment_id) {
      params.push(queryParams.assignment_id);
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
    const baseSql = `
      WITH eligible_learners AS (
        SELECT DISTINCT u.id, u.username, u.full_name, u.email, u.role::text AS learner_role
        FROM users u
        JOIN team_members tm ON tm.user_id = u.id
        WHERE $3::boolean = false
          AND u.tenant_id = $1::uuid
          AND u.is_active = true
          AND u.role IN ('learner'::user_role, 'learner_plus'::user_role)
          AND EXISTS (
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
      query<{ count: string }>(
        `${baseSql}
         SELECT COUNT(*) AS count
         FROM state
         ${stateWhere}`,
        params,
      ),
      query(
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
        [...params, course.display_name, pageSize, offset],
      ),
    ]);

    const total = parseInt(countResult.rows[0]?.count || '0', 10);
    return {
      data: dataResult.rows.map((row: any) => ({
        ...row,
        files: normalizeFiles(row.files),
        feedback_files: normalizeFiles(row.feedback_files),
      })),
      total,
      page,
      pageSize,
      totalPages: calcTotalPages(total, pageSize),
    };
  }

  const params: unknown[] = [tenantId, courseId];
  const conditions = ['s.tenant_id = $1', 's.course_id = $2'];

  if (typeof queryParams.assignment_id === 'string' && queryParams.assignment_id) {
    params.push(queryParams.assignment_id);
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
  const [countResult, dataResult] = await Promise.all([
    query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM assignment_submissions s
       JOIN users u ON u.id = s.learner_id
       JOIN course_assignments ca ON ca.id = s.assignment_id
       ${where}`,
      params,
    ),
    query(
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
       JOIN course_assignments ca ON ca.id = s.assignment_id
       LEFT JOIN users fb ON fb.id = s.feedback_by
       ${where}
       ORDER BY s.submitted_at DESC, s.id DESC
       LIMIT $${params.length + 2} OFFSET $${params.length + 3}`,
      [...params, course.display_name, pageSize, offset],
    ),
  ]);

  const total = parseInt(countResult.rows[0]?.count || '0', 10);
  return {
    data: dataResult.rows.map((row: any) => ({
      ...row,
      files: normalizeFiles(row.files),
      feedback_files: normalizeFiles(row.feedback_files),
    })),
    total,
    page,
    pageSize,
    totalPages: calcTotalPages(total, pageSize),
  };
}

export async function listLearnerCourseAssignments(courseId: string, user: AuthUser) {
  if (!user.tenantId) throw new AppError('Thieu tenant', 400);
  const learnerVisibilityFilter = isLearnerRole(user.role)
    ? `AND c.visible_to_staff_only = false
       AND EXISTS (
         SELECT 1 FROM (
           SELECT 1
           FROM team_course_categories tcc
           JOIN course_category_courses ccc ON ccc.category_id = tcc.category_id
           JOIN team_members tm ON tm.team_id = tcc.team_id
           WHERE ccc.course_id = c.id AND tm.user_id = $2
           UNION ALL
           SELECT 1
           FROM team_courses tc
           JOIN team_members tm ON tm.team_id = tc.team_id
           WHERE tc.course_id = c.id AND tm.user_id = $2
         ) AS access_check
       )`
    : '';

  const access = await query<{ enrollment_id: string | null }>(
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
    [courseId, user.id, user.tenantId],
  );
  if (access.rowCount === 0) throw new AppError('Khong co quyen truy cap course', 403);

  const enrollmentId = access.rows[0].enrollment_id;
  const contentCompletion = enrollmentId
    ? await getEnrollmentContentCompletion(enrollmentId, courseId)
    : { total: 0, completed: 0, is_complete: false };
  const effectiveDeadlineSql = effectiveDeadlineExpression('ca', 'e');
  const result = await query(
    `SELECT ca.id, ca.tenant_id, ca.course_id, ca.title, ca.question, ca.sort_order,
            ca.is_published, ca.allow_resubmission, ca.deadline_enabled, ca.deadline_at,
            COALESCE(ca.deadline_mode, CASE WHEN ca.deadline_enabled THEN 'absolute' ELSE 'none' END) AS deadline_mode,
            ca.deadline_after_days,
            ${effectiveDeadlineSql} AS effective_deadline_at,
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
       AND ca.is_published = true
     ORDER BY ca.sort_order ASC, ca.created_at ASC`,
    [courseId, user.tenantId, user.id],
  );

  return result.rows.map((row: any) => {
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
    is_published: row.is_published,
    allow_resubmission: row.allow_resubmission,
    deadline_enabled: row.deadline_enabled,
    deadline_mode: normalizeDeadlineMode(row.deadline_mode),
    deadline_at: row.deadline_at,
    deadline_after_days: row.deadline_after_days,
    effective_deadline_at: row.effective_deadline_at,
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
  const result = await query<{ course_id: string }>(
    `SELECT course_id
     FROM course_assignments
     WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL AND is_published = true`,
    [assignmentId, user.tenantId],
  );
  if (result.rowCount === 0) throw new AppError('Assignment khong ton tai', 404);
  const assignments = await listLearnerCourseAssignments(result.rows[0].course_id, user);
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
  if (user.role !== 'learner' && user.role !== 'learner_plus') {
    throw new AppError('Chỉ học viên mới có thể nộp bài tập', 403);
  }

  const access = await query<{
    assignment_id: string;
    tenant_id: string;
    course_id: string;
    title: string;
    allow_resubmission: boolean;
    deadline_enabled: boolean;
    deadline_at: string | Date | null;
    deadline_mode: AssignmentDeadlineMode;
    deadline_after_days: number | null;
    effective_deadline_at: string | Date | null;
    submission_unlock_mode: AssignmentSubmissionUnlockMode;
    enrollment_id: string;
  }>(
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
       AND ca.is_published = true
       AND c.deleted_at IS NULL
       AND c.visible_to_staff_only = false
       AND EXISTS (
         SELECT 1 FROM (
           SELECT 1
           FROM team_course_categories tcc
           JOIN course_category_courses ccc ON ccc.category_id = tcc.category_id
           JOIN team_members tm ON tm.team_id = tcc.team_id
           WHERE ccc.course_id = ca.course_id AND tm.user_id = e.user_id
           UNION ALL
           SELECT 1
           FROM team_courses tc
           JOIN team_members tm ON tm.team_id = tc.team_id
           WHERE tc.course_id = ca.course_id AND tm.user_id = e.user_id
         ) AS access_check
       )`,
    [assignmentId, user.tenantId, user.id],
  );
  if (access.rowCount === 0) throw new AppError('Assignment khong ton tai hoac khong co quyen', 404);

  const ctx = access.rows[0];
  if (ctx.submission_unlock_mode === 'after_content_complete') {
    const contentCompletion = await getEnrollmentContentCompletion(ctx.enrollment_id, ctx.course_id);
    if (!contentCompletion.is_complete) {
      throw new AppError('Cần hoàn thành nội dung khóa học trước khi nộp bài tập', 403);
    }
  }
  if (isDeadlineExpired(ctx.effective_deadline_at)) {
    throw new AppError('Đã hết thời hạn nộp bài tập', 403);
  }

  const existing = await query<{
    id: string;
    status: 'submitted' | 'feedback_given';
  }>(
    `SELECT id, status
     FROM assignment_submissions
     WHERE assignment_id = $1 AND learner_id = $2`,
    [assignmentId, user.id],
  );

  if (existing.rows[0]?.status === 'feedback_given') {
    throw new AppError('Assignment da co feedback, khong the nop lai', 409);
  }
  if (existing.rows[0]?.status === 'submitted' && !ctx.allow_resubmission) {
    throw new AppError('Assignment khong cho phep nop lai', 409);
  }

  const submissionId = existing.rows[0]?.id || uuidv4();
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

    if (existing.rows.length > 0) {
      const oldFiles = await client.query<{ storage_path: string }>(
        `DELETE FROM assignment_files
         WHERE submission_id = $1 AND kind = 'submission'
         RETURNING storage_path`,
        [submissionId],
      );
      oldStoragePaths.push(...oldFiles.rows.map(row => row.storage_path));

      await client.query(
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
        [input.answer_text, JSON.stringify(uploadedFiles.map(({ storage_path, ...rest }) => rest)), submissionId],
      );
    } else {
      await client.query(
        `INSERT INTO assignment_submissions (
           id, tenant_id, course_id, assignment_id, learner_id, enrollment_id,
           answer_text, files, status, submitted_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'submitted', now())`,
        [
          submissionId,
          ctx.tenant_id,
          ctx.course_id,
          ctx.assignment_id,
          user.id,
          ctx.enrollment_id,
          input.answer_text,
          JSON.stringify(uploadedFiles.map(({ storage_path, ...rest }) => rest)),
        ],
      );
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
    await Promise.all(uploadedFiles.map(file => deleteFile(file.storage_path).catch(() => undefined)));
    throw err;
  } finally {
    client.release();
  }

  await Promise.all(oldStoragePaths.map(path => deleteFile(path).catch(() => undefined)));
  return getLearnerAssignment(assignmentId, user);
}

export async function feedbackSubmission(
  submissionId: string,
  tenantId: string,
  adminId: string,
  input: FeedbackAssignmentInput,
  files?: Express.Multer.File[],
) {
  const submission = await query<{
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
  }>(
    `SELECT s.id, s.tenant_id, s.course_id, s.assignment_id, s.learner_id,
            s.status::text AS status, s.feedback_at,
            c.display_name AS course_name, ca.title AS assignment_title, ca.question AS assignment_question,
            ca.grading_enabled,
            COALESCE(NULLIF(u.full_name, ''), u.username) AS learner_name,
            u.email AS learner_email
     FROM assignment_submissions s
     JOIN course_assignments ca ON ca.id = s.assignment_id
     JOIN courses c ON c.id = s.course_id
     JOIN users u ON u.id = s.learner_id
     WHERE s.id = $1 AND s.tenant_id = $2`,
    [submissionId, tenantId],
  );
  if (submission.rowCount === 0) throw new AppError('Submission khong ton tai', 404);
  const ctx = submission.rows[0];
  if (ctx.grading_enabled && input.score === undefined) {
    throw new AppError('Vui long nhap diem tu 0 den 100', 400);
  }
  if (!ctx.grading_enabled && input.score !== undefined) {
    throw new AppError('Bai tap nay khong bat cham diem', 400);
  }

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

    const current = await client.query<{
      status: 'submitted' | 'feedback_given';
      feedback_at: string | null;
      feedback_files: unknown;
    }>(
      `SELECT status::text AS status, feedback_at, feedback_files
       FROM assignment_submissions
       WHERE id = $1 AND tenant_id = $2
       FOR UPDATE`,
      [submissionId, tenantId],
    );
    if (current.rowCount === 0) throw new AppError('Submission khong ton tai', 404);
    if (current.rows[0].status !== 'submitted' && current.rows[0].status !== 'feedback_given') {
      throw new AppError('Submission chua san sang de feedback', 409);
    }

    const uploadedFeedbackFiles = uploadedFiles.map(({ storage_path, ...rest }) => rest);
    const nextFeedbackFiles = uploadedFeedbackFiles.length > 0
      ? uploadedFeedbackFiles
      : normalizeFiles(current.rows[0].feedback_files);
    const score = ctx.grading_enabled ? input.score! : null;

    const feedbackUpdate = await client.query<{ feedback_at: string }>(
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
      [input.feedback_text, JSON.stringify(nextFeedbackFiles), score, adminId, submissionId, tenantId],
    );
    if (feedbackUpdate.rowCount === 0) {
      throw new AppError('Khong the cap nhat feedback cho submission nay', 409);
    }
    const feedbackAt = feedbackUpdate.rows[0].feedback_at;

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

    await client.query(
      `INSERT INTO assignment_feedback_history (
         tenant_id, course_id, assignment_id, submission_id, learner_id,
         feedback_text, feedback_files, score, feedback_by, feedback_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        ctx.tenant_id,
        ctx.course_id,
        ctx.assignment_id,
        ctx.id,
        ctx.learner_id,
        input.feedback_text,
        JSON.stringify(nextFeedbackFiles),
        score,
        adminId,
        feedbackAt,
      ],
    );

    const notification = await client.query<{ id: string }>(
      `INSERT INTO notifications (tenant_id, course_id, type, metadata, title, message, sent_by, recipient_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 1)
       RETURNING id`,
      [
        ctx.tenant_id,
        ctx.course_id,
        'assignment_feedback',
        JSON.stringify({
          assignment_id: ctx.assignment_id,
          submission_id: ctx.id,
          course_id: ctx.course_id,
          course_name: ctx.course_name,
          assignment_title: ctx.assignment_title,
          assignment_question: ctx.assignment_question,
          grading_enabled: ctx.grading_enabled,
          feedback_at: feedbackAt,
        }),
        'Bài tập đã có feedback',
        `Bài tập "${ctx.assignment_title}" trong khóa học "${ctx.course_name}" đã có feedback mới.`,
        adminId,
      ],
    );
    await client.query(
      `INSERT INTO notification_recipients (notification_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [notification.rows[0].id, ctx.learner_id],
    );

    await enqueueFeedbackEmails(client, {
      tenantId: ctx.tenant_id,
      submissionId: ctx.id,
      learnerId: ctx.learner_id,
      learnerName: ctx.learner_name,
      learnerEmail: ctx.learner_email,
      courseName: ctx.course_name,
      assignmentTitle: ctx.assignment_title,
      feedbackText: input.feedback_text,
      score,
    });

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    await Promise.all(uploadedFiles.map(file => deleteFile(file.storage_path).catch(() => undefined)));
    throw err;
  } finally {
    client.release();
  }

  processEmailOutboxBatch(ctx.tenant_id).catch(err => {
    console.error('[AssignmentFeedback] Email outbox error:', err instanceof Error ? err.message : err);
  });

  return listCourseSubmissions(ctx.course_id, tenantId, { page: '1', page_size: '1', assignment_id: ctx.assignment_id });
}

export async function listSubmissionFeedbackHistory(submissionId: string, tenantId: string) {
  const submission = await query<{ id: string }>(
    `SELECT id
     FROM assignment_submissions
     WHERE id = $1::uuid AND tenant_id = $2::uuid`,
    [submissionId, tenantId],
  );
  if (submission.rowCount === 0) throw new AppError('Submission khong ton tai', 404);

  const result = await query(
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

  return result.rows.map((row: any) => ({
    ...row,
    feedback_files: normalizeFiles(row.feedback_files),
  }));
}

export async function getAssignmentFileForDownload(fileId: string, user: AuthUser) {
  const result = await query<{
    id: string;
    tenant_id: string;
    learner_id: string;
    uploaded_by: string | null;
    kind: 'submission' | 'feedback';
    feedback_files: unknown;
    storage_path: string;
    original_name: string;
    mime_type: string;
  }>(
    `SELECT af.id, af.tenant_id, af.uploaded_by, af.kind, af.storage_path,
            af.original_name, af.mime_type, s.learner_id, s.feedback_files
     FROM assignment_files af
     JOIN assignment_submissions s ON s.id = af.submission_id
     WHERE af.id = $1`,
    [fileId],
  );
  if (result.rowCount === 0) throw new AppError('File khong ton tai', 404);
  const file = result.rows[0];

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

  const downloaded = await downloadFileBuffer(file.storage_path);
  return {
    buffer: downloaded.buffer,
    contentType: file.mime_type || downloaded.contentType || 'application/octet-stream',
    originalName: file.original_name,
  };
}
