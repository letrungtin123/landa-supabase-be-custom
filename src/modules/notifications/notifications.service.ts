// Notifications Service - targeted course notifications.
// Recipient rule:
//   course_category_courses -> team_course_categories -> teams -> sub_groups -> org_groups
//   -> team_members -> active learner users.
// Enrollment is intentionally not required for course notification fanout.

import { query, getClient } from '../../config/database.js';
import { invalidateTenantNotificationCaches } from '../../config/cache-invalidation.js';
import { AppError } from '../../utils/errors.js';
import { appendAuditLog, type TransactionalAuditEntry } from '../../middleware/audit-log.js';
import { parsePagination, calcOffset, calcTotalPages } from '../../utils/query-helpers.js';
import {
  enqueueCourseNotificationEmailJob,
  wakeEmailOutboxWorker,
} from '../assignments/email-outbox.service.js';
import { createNotificationsRepository, type NotificationsDb } from './notifications.repository.js';

// query() joins the caller's current transaction when there is one; the
// transaction block below uses the repository over its own client.
const poolDb: NotificationsDb = { query };
const notificationsRepository = createNotificationsRepository(poolDb);

export interface SmtpStatus {
  configured: boolean;
  is_enabled: boolean;
  has_password: boolean;
  can_send_email: boolean;
  host: string | null;
  from_email: string | null;
  reason: string | null;
}

export async function getCourseNotificationSmtpStatus(tenantId: string): Promise<SmtpStatus> {
  const row = await notificationsRepository.selectSmtpConfig(tenantId);
  const configured = Boolean(row);
  const hasPassword = Boolean(row?.password_ciphertext && row?.password_iv && row?.password_auth_tag);
  const hasSender = Boolean(row?.username?.trim() && row?.from_email?.trim());
  const canSend = Boolean(row?.is_enabled && hasPassword && hasSender);

  let reason: string | null = null;
  if (!configured) {
    reason = 'Tenant chưa cấu hình SMTP Google.';
  } else if (!row?.is_enabled) {
    reason = 'SMTP Google của tenant chưa được bật.';
  } else if (!hasPassword) {
    reason = 'SMTP Google chưa có app password hợp lệ.';
  } else if (!hasSender) {
    reason = 'SMTP Google chưa có email gửi hợp lệ.';
  }

  return {
    configured,
    is_enabled: Boolean(row?.is_enabled),
    has_password: hasPassword,
    can_send_email: canSend,
    host: row?.host || null,
    from_email: row?.from_email || null,
    reason,
  };
}

export async function sendCourseNotification(
  courseId: string,
  tenantId: string,
  title: string,
  message: string,
  sentBy: string,
  auditEntry?: (result: { notificationId: string; recipientCount: number; courseId: string; courseName: string }) => TransactionalAuditEntry,
): Promise<{
  success: boolean;
  notification_id: string;
  recipients: number;
  email_requested: boolean;
  email_job_queued: boolean;
  email_skipped_reason: string | null;
}> {
  const smtpStatus = await getCourseNotificationSmtpStatus(tenantId);
  const sendEmail = smtpStatus.can_send_email;
  const emailSkippedReason = sendEmail ? null : smtpStatus.reason;

  const course = await notificationsRepository.selectCourse(courseId, tenantId);
  if (!course) {
    throw new AppError('Khóa học không tồn tại', 404);
  }
  if (course.visible_to_staff_only) {
    throw new AppError('Không thể gửi thông báo cho khóa học đang ẩn.', 400);
  }

  const client = await getClient();
  let notificationId = '';
  let recipientCount = 0;
  let emailJobQueued = false;

  try {
    await client.query('BEGIN');
    const tx = createNotificationsRepository(client);

    notificationId = await tx.insertCourseNotification({
      tenantId,
      courseId,
      title,
      message,
      sentBy,
      sendEmail,
      recipientRule: course.is_public ? 'all_active_learners' : 'course_assignments',
    });

    recipientCount = await tx.addCourseLearnerRecipients(notificationId, courseId, tenantId);

    await tx.updateRecipientCount(recipientCount, notificationId);

    if (sendEmail && recipientCount > 0) {
      const jobCount = await enqueueCourseNotificationEmailJob(client, {
        tenantId,
        notificationId,
        courseId,
      });
      emailJobQueued = jobCount > 0;
    }

    if (auditEntry) {
      await appendAuditLog(client, auditEntry({
        notificationId,
        recipientCount,
        courseId,
        courseName: course.display_name,
      }));
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  if (recipientCount > 0) await invalidateTenantNotificationCaches(tenantId);
  if (emailJobQueued) {
    wakeEmailOutboxWorker('course-notification');
  }

  return {
    success: true,
    notification_id: notificationId,
    recipients: recipientCount,
    email_requested: sendEmail,
    email_job_queued: emailJobQueued,
    email_skipped_reason: emailSkippedReason,
  };
}

export async function getNotifications(
  tenantId: string,
  queryParams: Record<string, unknown>,
) {
  const { page, pageSize, search } = parsePagination(queryParams);
  const offset = calcOffset(page, pageSize);
  const courseId = typeof queryParams.course_id === 'string' ? queryParams.course_id.trim() : '';
  const { countRow, rows } = await notificationsRepository.selectNotificationPage(tenantId, courseId, search, pageSize, offset);

  const total = parseInt(countRow.count, 10);
  return {
    data: rows,
    total,
    page,
    pageSize,
    totalPages: calcTotalPages(total, pageSize),
  };
}
