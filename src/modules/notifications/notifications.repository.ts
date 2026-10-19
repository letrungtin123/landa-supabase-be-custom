// ═══════════════════════════════════════════════════════════════
// Notifications repository: the tenant's SMTP status, a course
// notification and its recipients, and the notification list. SQL only;
// moved unchanged from notifications.service.ts, which keeps the rules
// (SMTP readiness, hidden courses, the transaction, the e-mail outbox,
// audit and cache invalidation).
// ═══════════════════════════════════════════════════════════════

import type { QueryResult, QueryResultRow } from 'pg';

/** The pool query() or a transaction client (PoolClient). */
export interface NotificationsDb {
  query<T extends QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface SmtpConfigRow {
  is_enabled: boolean;
  host: string | null;
  username: string | null;
  from_email: string | null;
  password_ciphertext: string | null;
  password_iv: string | null;
  password_auth_tag: string | null;
}

export interface NotificationCourseRow {
  visible_to_staff_only: boolean;
  is_public: boolean;
  display_name: string;
}

export interface CourseNotificationValues {
  tenantId: string;
  courseId: string;
  title: string;
  message: string;
  sentBy: string;
  sendEmail: boolean;
  recipientRule: string;
}

/** A whole notifications row (`n.*`) with its course, sender and e-mail job. */
export interface NotificationListRow {
  id: string;
  tenant_id: string;
  course_id: string | null;
  title: string;
  message: string | null;
  created_at: Date;
  course_name: string | null;
  sent_by_username: string | null;
  sent_by_display_name: string | null;
  email_status: string | null;
  email_queued_count: number;
  email_last_error: string | null;
  [column: string]: unknown;
}

export function createNotificationsRepository(db: NotificationsDb) {
  return {
    /** The tenant's SMTP configuration row, if any. */
    async selectSmtpConfig(tenantId: string): Promise<SmtpConfigRow | undefined> {
      const result = await db.query<SmtpConfigRow>(
        `SELECT is_enabled, host, username, from_email,
            password_ciphertext, password_iv, password_auth_tag
     FROM tenant_smtp_configs
     WHERE tenant_id = $1::uuid
     LIMIT 1`,
        [tenantId],
      );
      return result.rows[0];
    },

    /** The course (not deleted) of the tenant with its hidden and public flags. */
    async selectCourse(courseId: string, tenantId: string): Promise<NotificationCourseRow | null> {
      const courseCheck = await db.query<NotificationCourseRow>(
        `SELECT display_name, visible_to_staff_only,
            EXISTS (
              SELECT 1
              FROM course_category_courses ccc
              JOIN course_categories cc ON cc.id = ccc.category_id
              WHERE ccc.course_id = courses.id
                AND cc.tenant_id = courses.tenant_id
                AND COALESCE(cc.is_public, false) = true
            ) AS is_public
     FROM courses
     WHERE id = $1
       AND tenant_id = $2::uuid
       AND deleted_at IS NULL`,
        [courseId, tenantId],
      );
      return courseCheck.rowCount === 0 ? null : courseCheck.rows[0];
    },

    /** A manual course notification with no recipients yet; its id. */
    async insertCourseNotification(values: CourseNotificationValues): Promise<string> {
      const notifResult = await db.query<{ id: string }>(
        `INSERT INTO notifications (tenant_id, course_id, type, metadata, title, message, sent_by, recipient_count)
       VALUES (
         $1::uuid,
         $2::varchar,
         'course_manual_notification',
         jsonb_build_object('send_email', $6::boolean, 'recipient_rule', $7::varchar),
         $3::varchar,
         $4::text,
         $5::uuid,
         0
       )
       RETURNING id`,
        [
          values.tenantId,
          values.courseId,
          values.title,
          values.message,
          values.sentBy,
          values.sendEmail,
          values.recipientRule,
        ],
      );
      return notifResult.rows[0].id;
    },

    /**
     * Adds the course's eligible active learners (every learner of the tenant
     * when the course is public) as recipients; the number added.
     */
    async addCourseLearnerRecipients(notificationId: string, courseId: string, tenantId: string): Promise<number> {
      const insertResult = await db.query(
        `WITH course_scope AS (
         SELECT c.id,
                c.tenant_id,
                EXISTS (
                  SELECT 1
                  FROM course_category_courses ccc_public
                  JOIN course_categories cc_public ON cc_public.id = ccc_public.category_id
                  WHERE ccc_public.course_id = c.id
                    AND cc_public.tenant_id = c.tenant_id
                    AND COALESCE(cc_public.is_public, false) = true
                ) AS is_public
         FROM courses c
         WHERE c.id = $2::varchar
           AND c.tenant_id = $3::uuid
           AND c.deleted_at IS NULL
           AND c.visible_to_staff_only = false
       ),
       eligible_learners AS (
         SELECT DISTINCT u.id AS user_id
         FROM users u
         LEFT JOIN team_members tm ON tm.user_id = u.id
         CROSS JOIN course_scope cs
         WHERE u.tenant_id = cs.tenant_id
           AND u.role IN ('learner', 'learner_plus')
           AND u.is_active = true
           AND (
             cs.is_public = true
             OR EXISTS (
               SELECT 1
               FROM team_courses tc
               WHERE tc.team_id = tm.team_id
                 AND tc.course_id = cs.id
               UNION ALL
               SELECT 1
               FROM team_course_categories tcc
               JOIN course_category_courses ccc ON ccc.category_id = tcc.category_id
               WHERE tcc.team_id = tm.team_id
                 AND ccc.course_id = cs.id
             )
           )
       )
       INSERT INTO notification_recipients (notification_id, user_id)
       SELECT $1::uuid, user_id
       FROM eligible_learners
       ON CONFLICT (notification_id, user_id) DO NOTHING`,
        [notificationId, courseId, tenantId],
      );
      return insertResult.rowCount || 0;
    },

    async updateRecipientCount(recipientCount: number, notificationId: string): Promise<void> {
      await db.query(
        `UPDATE notifications
       SET recipient_count = $1::int
       WHERE id = $2::uuid`,
        [recipientCount, notificationId],
      );
    },

    /** The tenant's notifications (optionally of one course, matching `search`): count and one page, newest first. */
    async selectNotificationPage(
      tenantId: string,
      courseId: string,
      search: string | undefined,
      pageSize: number,
      offset: number,
    ): Promise<{ countRow: { count: string }; rows: NotificationListRow[] }> {
      const params: unknown[] = [tenantId];
      const conditions = ['n.tenant_id = $1::uuid'];

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
        db.query<{ count: string }>(
          `SELECT COUNT(*) AS count
       FROM notifications n
       LEFT JOIN courses c ON c.id = n.course_id
       ${where}`,
          params,
        ),
        db.query<NotificationListRow>(
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
      return { countRow: countR.rows[0], rows: dataR.rows };
    },
  };
}
