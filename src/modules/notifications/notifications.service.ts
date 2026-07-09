// Notifications Service - targeted course notifications.
// Recipient rule:
//   course_category_courses -> team_course_categories -> teams -> sub_groups -> org_groups
//   -> team_members -> active learner users.
// Enrollment is intentionally not required for course notification fanout.

import { query, getClient } from '../../config/database.js';
import { AppError } from '../../middleware/error-handler.js';
import { parsePagination, calcOffset, calcTotalPages } from '../../utils/query-helpers.js';
import {
  enqueueCourseNotificationEmailJob,
  processCourseNotificationEmailFanoutBatch,
  processEmailOutboxBatch,
} from '../assignments/email-outbox.service.js';

export interface SmtpStatus {
  configured: boolean;
  is_enabled: boolean;
  has_password: boolean;
  can_send_email: boolean;
  host: string | null;
  from_email: string | null;
  reason: string | null;
}

interface SendCourseNotificationOptions {
  sendEmail?: boolean;
}

export async function getCourseNotificationSmtpStatus(tenantId: string): Promise<SmtpStatus> {
  const result = await query<{
    is_enabled: boolean;
    host: string | null;
    username: string | null;
    from_email: string | null;
    password_ciphertext: string | null;
    password_iv: string | null;
    password_auth_tag: string | null;
  }>(
    `SELECT is_enabled, host, username, from_email,
            password_ciphertext, password_iv, password_auth_tag
     FROM tenant_smtp_configs
     WHERE tenant_id = $1::uuid
     LIMIT 1`,
    [tenantId],
  );

  const row = result.rows[0];
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
  options: SendCourseNotificationOptions = {},
): Promise<{
  success: boolean;
  notification_id: string;
  recipients: number;
  email_requested: boolean;
  email_job_queued: boolean;
}> {
  const sendEmail = Boolean(options.sendEmail);
  if (sendEmail) {
    const smtpStatus = await getCourseNotificationSmtpStatus(tenantId);
    if (!smtpStatus.can_send_email) {
      throw new AppError(smtpStatus.reason || 'Tenant chưa cấu hình SMTP Google.', 400);
    }
  }

  const courseCheck = await query<{ visible_to_staff_only: boolean }>(
    `SELECT visible_to_staff_only
     FROM courses
     WHERE id = $1
       AND tenant_id = $2::uuid
       AND deleted_at IS NULL`,
    [courseId, tenantId],
  );
  if (courseCheck.rowCount === 0) {
    throw new AppError('Khóa học không tồn tại', 404);
  }
  if (courseCheck.rows[0].visible_to_staff_only) {
    throw new AppError('Không thể gửi thông báo cho khóa học đang ẩn.', 400);
  }

  const client = await getClient();
  let notificationId = '';
  let recipientCount = 0;
  let emailJobQueued = false;

  try {
    await client.query('BEGIN');

    const notifResult = await client.query<{ id: string }>(
      `INSERT INTO notifications (tenant_id, course_id, type, metadata, title, message, sent_by, recipient_count)
       VALUES (
         $1::uuid,
         $2::varchar,
         'course_manual_notification',
         jsonb_build_object('send_email', $6::boolean, 'recipient_rule', 'team_course_categories'),
         $3::varchar,
         $4::text,
         $5::uuid,
         0
       )
       RETURNING id`,
      [tenantId, courseId, title, message, sentBy, sendEmail],
    );
    notificationId = notifResult.rows[0].id;

    const insertResult = await client.query(
      `INSERT INTO notification_recipients (notification_id, user_id)
       SELECT DISTINCT $1::uuid, u.id
       FROM courses c
       JOIN course_category_courses ccc
         ON ccc.course_id = c.id
       JOIN team_course_categories tcc
         ON tcc.category_id = ccc.category_id
       JOIN teams t
         ON t.id = tcc.team_id
       JOIN sub_groups sg
         ON sg.id = t.sub_group_id
       JOIN org_groups og
         ON og.id = sg.org_group_id
        AND og.tenant_id = c.tenant_id
       JOIN team_members tm
         ON tm.team_id = t.id
       JOIN users u
         ON u.id = tm.user_id
        AND u.tenant_id = c.tenant_id
       WHERE c.id = $2::varchar
         AND c.tenant_id = $3::uuid
         AND c.deleted_at IS NULL
         AND c.visible_to_staff_only = false
         AND u.role IN ('learner', 'learner_plus')
         AND u.is_active = true
       ON CONFLICT (notification_id, user_id) DO NOTHING`,
      [notificationId, courseId, tenantId],
    );

    recipientCount = insertResult.rowCount || 0;

    await client.query(
      `UPDATE notifications
       SET recipient_count = $1::int
       WHERE id = $2::uuid`,
      [recipientCount, notificationId],
    );

    if (sendEmail && recipientCount > 0) {
      const jobCount = await enqueueCourseNotificationEmailJob(client, {
        tenantId,
        notificationId,
        courseId,
      });
      emailJobQueued = jobCount > 0;
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  if (emailJobQueued) {
    setImmediate(() => {
      processCourseNotificationEmailFanoutBatch(tenantId, 1)
        .then(() => processEmailOutboxBatch(tenantId))
        .catch(err => {
          console.error('[Notifications] Email fanout error:', err instanceof Error ? err.message : err);
        });
    });
  }

  return {
    success: true,
    notification_id: notificationId,
    recipients: recipientCount,
    email_requested: sendEmail,
    email_job_queued: emailJobQueued,
  };
}

export async function getNotifications(
  tenantId: string,
  queryParams: Record<string, unknown>,
) {
  const { page, pageSize, search } = parsePagination(queryParams);
  const offset = calcOffset(page, pageSize);
  const params: unknown[] = [tenantId];
  const conditions = ['n.tenant_id = $1::uuid'];

  const courseId = typeof queryParams.course_id === 'string' ? queryParams.course_id.trim() : '';
  if (courseId) {
    params.push(courseId);
    conditions.push(`n.course_id = $${params.length}::varchar`);
  }

  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(n.title ILIKE $${params.length} OR c.display_name ILIKE $${params.length})`);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;

  const [countR, dataR] = await Promise.all([
    query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM notifications n
       LEFT JOIN courses c ON c.id = n.course_id
       ${where}`,
      params,
    ),
    query(
      `SELECT n.*,
              c.display_name AS course_name,
              COALESCE(NULLIF(u.full_name, ''), u.email) AS sent_by_username,
              COALESCE(NULLIF(u.full_name, ''), u.email) AS sent_by_display_name,
              nej.status AS email_status,
              COALESCE(nej.queued_count, 0) AS email_queued_count,
              nej.last_error AS email_last_error
       FROM notifications n
       LEFT JOIN courses c ON c.id = n.course_id
       LEFT JOIN users u ON u.id = n.sent_by
       LEFT JOIN notification_email_jobs nej ON nej.notification_id = n.id
       ${where}
       ORDER BY n.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset],
    ),
  ]);

  const total = parseInt(countR.rows[0].count, 10);
  return {
    data: dataR.rows,
    total,
    page,
    pageSize,
    totalPages: calcTotalPages(total, pageSize),
  };
}
