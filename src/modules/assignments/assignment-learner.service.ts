// The learner side of assignments: a course's assignments with the learner's
// state, one assignment, and submitting. Moved unchanged from
// assignments.service.ts, which re-exports them.

import { v4 as uuidv4 } from 'uuid';
import { getClient } from '../../config/database.js';
import { invalidateUserBadgeCaches } from '../../config/cache-invalidation.js';
import { deleteFile } from '../../config/storage.js';
import { AppError } from '../../utils/errors.js';
import { isLearnerRole } from '../../types/index.js';
import type { AuthUser } from '../../types/express.js';
import type { SubmitAssignmentInput } from './assignments.validator.js';
import {
  getEnrollmentContentCompletion,
  recalculateEnrollmentProgress,
} from '../learner/progress-calculation.service.js';
import { assertUserNotActiveDemoIframeAccount } from '../demo-login/demo-iframe.service.js';
import { swallowAndLog } from '../../utils/best-effort.js';
import { createAssignmentLearnerRepository } from './assignment-learner.repository.js';
import { learnerRepository } from './assignment-access.service.js';
import {
  normalizeFiles,
  normalizeAttachmentFile,
  isDeadlineExpired,
  normalizeDeadlineMode,
  normalizeSubmissionUnlockMode,
} from './assignment-rules.logic.js';
import { uploadAssignmentFiles, insertAssignmentFileRows } from './assignment-files.service.js';

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
