// ═══════════════════════════════════════════════════════════════
// Email outbox enqueue repository: the tenant SMTP switches and branding an
// email needs, the recipients of a notification, the outbox rows written
// (one email, a batch, the owner feedback digest), the course-notification
// job and its fan-out claim, course check and progress. SQL only; moved
// unchanged from email-outbox.service.ts. Every method runs on the db it is
// created with: the caller's transaction client, or the pool query().
// ═══════════════════════════════════════════════════════════════

import type { QueryResult, QueryResultRow } from 'pg';

export interface EmailOutboxEnqueueDb {
  query<T extends QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface FeedbackSmtpRow {
  is_enabled: boolean;
  username: string;
  copy_to_sender: boolean;
  copy_to_email: string | null;
}

export interface SmtpCopySettingsRow {
  username: string;
  copy_to_sender: boolean;
  copy_to_email: string | null;
}

export interface AssignmentRecipientRow {
  user_id: string;
  email: string;
  name: string;
  enrolled_at: string | Date | null;
}

export interface NotificationRecipientRow {
  user_id: string;
  email: string;
  name: string;
}

export interface FanoutJobRow {
  id: string;
  tenant_id: string;
  notification_id: string;
  course_id: string;
  last_recipient_id: string | null;
  attempts: number;
}

export interface FanoutNotificationRow {
  type: string;
  title: string;
  message: string | null;
  metadata: Record<string, unknown> | null;
  course_name: string;
  recipient_count: number;
}

export interface FanoutRecipientRow {
  recipient_id: string;
  user_id: string;
  email: string;
  name: string;
  enrolled_at: string | Date | null;
}

export interface OutboxEmailInput {
  tenantId: string;
  relatedSubmissionId?: string | null;
  relatedNotificationId?: string | null;
  recipientUserId?: string | null;
  recipientEmail: string;
  recipientName?: string | null;
  subject: string;
  html: string;
  text: string;
  delayMinutes?: number;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export function createEmailOutboxEnqueueRepository(db: EmailOutboxEnqueueDb) {
  return {
    async selectTenantBranding(tenantId: string): Promise<{ name: string; domain_learner: string | null } | undefined> {
      const sql = `SELECT name, domain_learner
     FROM tenants
     WHERE id = $1::uuid`;
      const result = await db.query<{ name: string; domain_learner: string | null }>(sql, [tenantId]);
      return result.rows[0];
    },

    async insertOutboxEmail(input: OutboxEmailInput): Promise<void> {
      await db.query(
        `INSERT INTO email_outbox (
       tenant_id, related_submission_id, related_notification_id, recipient_user_id, recipient_email, recipient_name,
       subject, html_body, text_body, next_attempt_at
     )
     VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::varchar, $6::varchar,
       LEFT($7::text, 255), $8::text, $9::text,
       now() + (($10::int || ' minutes')::interval)
     )`,
        [
          input.tenantId,
          input.relatedSubmissionId ?? null,
          input.relatedNotificationId ?? null,
          input.recipientUserId ?? null,
          input.recipientEmail,
          input.recipientName ?? null,
          input.subject,
          input.html,
          input.text,
          input.delayMinutes ?? 0,
        ],
      );
    },

    /** One row per recipient (no related submission or notification). */
    async insertRecipientEmails(
      tenantId: string,
      recipients: Array<{ userId: string; email: string; name: string }>,
      emails: RenderedEmail[],
    ): Promise<void> {
      await db.query(
        `INSERT INTO email_outbox (
       tenant_id, related_submission_id, recipient_user_id, recipient_email, recipient_name,
       subject, html_body, text_body
     )
     SELECT $1::uuid, NULL::uuid, x.user_id, x.email, x.name, LEFT(x.subject, 255), x.html_body, x.text_body
     FROM unnest($2::uuid[], $3::varchar[], $4::varchar[], $5::text[], $6::text[], $7::text[]) AS x(user_id, email, name, subject, html_body, text_body)`,
        [
          tenantId,
          recipients.map(recipient => recipient.userId),
          recipients.map(recipient => recipient.email),
          recipients.map(recipient => recipient.name),
          emails.map(email => email.subject),
          emails.map(email => email.html),
          emails.map(email => email.text),
        ],
      );
    },

    /** The owner's pending feedback digest that still has its insertion marker. */
    async selectPendingOwnerDigest(tenantId: string, recipientEmail: string, subject: string, htmlMarker: string): Promise<{ rowCount: number | null; id?: string }> {
      const existing = await db.query<{ id: string }>(
        `SELECT id
     FROM email_outbox
     WHERE tenant_id = $1::uuid
       AND recipient_email = $2::varchar
       AND recipient_user_id IS NULL
       AND related_submission_id IS NULL
       AND subject = $3::varchar
       AND status = 'pending'::email_outbox_status
       AND next_attempt_at > now()
       AND html_body LIKE '%' || $4::text || '%'
     ORDER BY created_at DESC
     LIMIT 1
     FOR UPDATE`,
        [tenantId, recipientEmail, subject, htmlMarker],
      );
      return { rowCount: existing.rowCount, id: existing.rows[0]?.id };
    },

    /** Adds one item before the digest's markers and pushes its send time back. */
    async appendToOwnerDigest(
      digestId: string,
      htmlMarker: string,
      htmlItem: string,
      textMarker: string,
      textItem: string,
      delayMinutes: number,
    ): Promise<void> {
      await db.query(
        `UPDATE email_outbox
       SET html_body = REPLACE(html_body, $2::text, $3::text || $2::text),
           text_body = REPLACE(text_body, $4::text, $5::text || E'\n' || $4::text),
           next_attempt_at = now() + (($6::int || ' minutes')::interval),
           updated_at = now()
       WHERE id = $1::uuid`,
        [digestId, htmlMarker, htmlItem, textMarker, textItem, delayMinutes],
      );
    },

    async selectFeedbackSmtp(tenantId: string): Promise<QueryResult<FeedbackSmtpRow>> {
      return db.query<FeedbackSmtpRow>(
        `SELECT is_enabled, username, copy_to_sender, copy_to_email
     FROM tenant_smtp_configs
     WHERE tenant_id = $1 AND is_enabled = true`,
        [tenantId],
      );
    },

    async selectSmtpCopySettings(tenantId: string): Promise<QueryResult<SmtpCopySettingsRow>> {
      return db.query<SmtpCopySettingsRow>(
        `SELECT username, copy_to_sender, copy_to_email
     FROM tenant_smtp_configs
     WHERE tenant_id = $1::uuid AND is_enabled = true
     LIMIT 1`,
        [tenantId],
      );
    },

    /** Whether the tenant has an enabled SMTP config (rowCount 0 or 1). */
    async selectSmtpEnabled(tenantId: string): Promise<number | null> {
      const smtp = await db.query(
        `SELECT 1
     FROM tenant_smtp_configs
     WHERE tenant_id = $1::uuid
       AND is_enabled = true
     LIMIT 1`,
        [tenantId],
      );
      return smtp.rowCount;
    },

    /** One recipient per email address, with their latest active enrollment in the course. */
    async selectAssignmentRecipients(notificationId: string, courseId: string, tenantId: string): Promise<AssignmentRecipientRow[]> {
      const recipientResult = await db.query<AssignmentRecipientRow>(
        `SELECT DISTINCT ON (LOWER(u.email))
            nr.user_id,
            u.email::text AS email,
            COALESCE(NULLIF(u.full_name, ''), u.username, u.email)::text AS name,
            e.enrolled_at
     FROM notification_recipients nr
     JOIN users u ON u.id = nr.user_id
     LEFT JOIN enrollments e
       ON e.user_id = nr.user_id
      AND e.course_id = $2::varchar
      AND e.tenant_id = $3::uuid
      AND e.is_active = true
     WHERE nr.notification_id = $1::uuid
       AND u.email IS NOT NULL
       AND BTRIM(u.email) <> ''
     ORDER BY LOWER(u.email), e.enrolled_at DESC NULLS LAST, nr.user_id`,
        [notificationId, courseId, tenantId],
      );
      return recipientResult.rows;
    },

    /** Active learners of the tenant among the notification's recipients, one per email address. */
    async selectTeamRecipients(notificationId: string, tenantId: string): Promise<QueryResult<NotificationRecipientRow>> {
      return db.query<NotificationRecipientRow>(
        `SELECT DISTINCT ON (LOWER(u.email))
            nr.user_id,
            BTRIM(u.email)::text AS email,
            COALESCE(NULLIF(u.full_name, ''), u.username, u.email)::text AS name
     FROM notification_recipients nr
     JOIN users u
       ON u.id = nr.user_id
      AND u.tenant_id = $2::uuid
     WHERE nr.notification_id = $1::uuid
       AND u.email IS NOT NULL
       AND BTRIM(u.email) <> ''
       AND u.role IN ('learner', 'learner_plus')
       AND u.is_active = true
     ORDER BY LOWER(u.email), nr.user_id`,
        [notificationId, tenantId],
      );
    },

    /** One row per recipient of the notification (a row already there is kept); the count inserted. */
    async insertNotificationEmails(
      tenantId: string,
      notificationId: string,
      recipients: Array<{ user_id: string; email: string; name: string }>,
      emails: RenderedEmail[],
    ): Promise<number | null> {
      const insertResult = await db.query(
        `INSERT INTO email_outbox (
       tenant_id, related_submission_id, related_notification_id, recipient_user_id,
       recipient_email, recipient_name, subject, html_body, text_body
     )
     SELECT $1::uuid,
            NULL::uuid,
            $2::uuid,
            x.user_id,
            x.email,
            x.name,
            LEFT(x.subject, 255),
            x.html_body,
            x.text_body
     FROM unnest($3::uuid[], $4::varchar[], $5::varchar[], $6::text[], $7::text[], $8::text[]) AS x(user_id, email, name, subject, html_body, text_body)
     ON CONFLICT DO NOTHING`,
        [
          tenantId,
          notificationId,
          recipients.map(recipient => recipient.user_id),
          recipients.map(recipient => recipient.email),
          recipients.map(recipient => recipient.name),
          emails.map(email => email.subject),
          emails.map(email => email.html),
          emails.map(email => email.text),
        ],
      );
      return insertResult.rowCount;
    },

    /** The owner's copy of a notification email (kept when it exists). */
    async insertNotificationOwnerCopy(
      tenantId: string,
      notificationId: string,
      recipientEmail: string,
      recipientName: string,
      email: RenderedEmail,
    ): Promise<void> {
      await db.query(
        `INSERT INTO email_outbox (
       tenant_id, related_submission_id, related_notification_id, recipient_user_id,
       recipient_email, recipient_name, subject, html_body, text_body
     )
     VALUES (
       $1::uuid, NULL::uuid, $2::uuid, NULL::uuid,
       $3::varchar, $4::varchar, LEFT($5::text, 255), $6::text, $7::text
     )
     ON CONFLICT DO NOTHING`,
        [tenantId, notificationId, recipientEmail, recipientName, email.subject, email.html, email.text],
      );
    },

    /** A pending fan-out job for the notification (one per notification); the count inserted. */
    async insertNotificationEmailJob(tenantId: string, notificationId: string, courseId: string): Promise<number> {
      const result = await db.query(
        `INSERT INTO notification_email_jobs (tenant_id, notification_id, course_id, status, next_attempt_at)
     VALUES ($1::uuid, $2::uuid, $3::varchar, 'pending', now())
     ON CONFLICT (notification_id) DO NOTHING`,
        [tenantId, notificationId, courseId],
      );
      return result.rowCount || 0;
    },

    /** Due pending or failed fan-out jobs, set to 'running'. */
    async claimDueFanoutJobs(limit: number, tenantId: string | undefined): Promise<Array<{ id: string }>> {
      const params: unknown[] = [limit];
      let tenantFilter = '';
      if (tenantId) {
        params.push(tenantId);
        tenantFilter = `AND tenant_id = $${params.length}::uuid`;
      }

      const dueJobs = await db.query<{ id: string }>(
        `WITH picked AS (
         SELECT id
         FROM notification_email_jobs
         WHERE status IN ('pending', 'failed')
           AND next_attempt_at <= now()
           ${tenantFilter}
         ORDER BY next_attempt_at ASC, created_at ASC
         LIMIT $1::int
         FOR UPDATE SKIP LOCKED
       )
       UPDATE notification_email_jobs nej
       SET status = 'running',
           updated_at = now()
       FROM picked
       WHERE nej.id = picked.id
       RETURNING nej.id`,
        params,
      );
      return dueJobs.rows;
    },

    /** 'running' fan-out jobs not updated for 5 minutes, claimed again. */
    async claimStaleFanoutJobs(limit: number, tenantId: string | undefined): Promise<Array<{ id: string }>> {
      const staleParams: unknown[] = [limit];
      let staleTenantFilter = '';
      if (tenantId) {
        staleParams.push(tenantId);
        staleTenantFilter = `AND tenant_id = $${staleParams.length}::uuid`;
      }
      const staleJobs = await db.query<{ id: string }>(
        `WITH picked AS (
           SELECT id
           FROM notification_email_jobs
           WHERE status = 'running'
             AND updated_at < now() - interval '5 minutes'
             ${staleTenantFilter}
           ORDER BY updated_at ASC, created_at ASC
           LIMIT $1::int
           FOR UPDATE SKIP LOCKED
         )
         UPDATE notification_email_jobs nej
         SET updated_at = now()
         FROM picked
         WHERE nej.id = picked.id
         RETURNING nej.id`,
        staleParams,
      );
      return staleJobs.rows;
    },

    async lockFanoutJob(jobId: string): Promise<FanoutJobRow | undefined> {
      const job = await db.query<FanoutJobRow>(
        `SELECT id, tenant_id, notification_id, course_id, last_recipient_id, attempts
       FROM notification_email_jobs
       WHERE id = $1::uuid
       FOR UPDATE`,
        [jobId],
      );
      return job.rows[0];
    },

    /** KEY SHARE on the active course: a course deletion waits for this fan-out (rowCount 0 when gone). */
    async lockActiveCourse(courseId: string, tenantId: string): Promise<number | null> {
      const activeCourse = await db.query<{ id: string }>(
        `SELECT id
       FROM courses
       WHERE id = $1::varchar AND tenant_id = $2::uuid AND deleted_at IS NULL
       FOR KEY SHARE`,
        [courseId, tenantId],
      );
      return activeCourse.rowCount;
    },

    async deleteFanoutJob(jobId: string): Promise<void> {
      await db.query('DELETE FROM notification_email_jobs WHERE id = $1::uuid', [jobId]);
    },

    async selectFanoutNotification(notificationId: string, tenantId: string): Promise<FanoutNotificationRow | undefined> {
      const notification = await db.query<FanoutNotificationRow>(
        `SELECT n.type,
              n.title,
              n.message,
              n.metadata,
              COALESCE(NULLIF(c.display_name, ''), n.course_id)::text AS course_name,
              n.recipient_count::int AS recipient_count
       FROM notifications n
       LEFT JOIN courses c ON c.id = n.course_id AND c.tenant_id = n.tenant_id
       WHERE n.id = $1::uuid
         AND n.tenant_id = $2::uuid`,
        [notificationId, tenantId],
      );
      return notification.rows[0];
    },

    async markFanoutJobNotificationMissing(jobId: string): Promise<void> {
      await db.query(
        `UPDATE notification_email_jobs
         SET status = 'failed',
             attempts = attempts + 1,
             last_error = 'Notification not found',
             next_attempt_at = now() + interval '15 minutes',
             updated_at = now()
         WHERE id = $1::uuid`,
        [jobId],
      );
    },

    /** The next batch of mailable recipients after lastRecipientId, with their active enrollment in the course. */
    async selectFanoutRecipients(
      notificationId: string,
      lastRecipientId: string | null,
      courseId: string,
      tenantId: string,
      batchSize: number,
    ): Promise<QueryResult<FanoutRecipientRow>> {
      return db.query<FanoutRecipientRow>(
        `SELECT nr.id AS recipient_id,
              nr.user_id,
              BTRIM(u.email)::text AS email,
              COALESCE(NULLIF(u.full_name, ''), u.username, u.email)::text AS name,
              e.enrolled_at
       FROM notification_recipients nr
       JOIN users u ON u.id = nr.user_id
       LEFT JOIN enrollments e
         ON e.user_id = nr.user_id
        AND e.course_id = $3::varchar
        AND e.tenant_id = $4::uuid
        AND e.is_active = true
       WHERE nr.notification_id = $1::uuid
          AND ($2::uuid IS NULL OR nr.id > $2::uuid)
          AND u.is_active = true
          AND u.deletion_requested_at IS NULL
          AND u.email IS NOT NULL
         AND BTRIM(u.email) <> ''
       ORDER BY nr.id ASC
       LIMIT $5::int`,
        [notificationId, lastRecipientId, courseId, tenantId, batchSize],
      );
    },

    async markFanoutJobDone(jobId: string): Promise<void> {
      await db.query(
        `UPDATE notification_email_jobs
         SET status = 'done',
             last_user_id = NULL,
             last_error = NULL,
             updated_at = now()
         WHERE id = $1::uuid`,
        [jobId],
      );
    },

    async markFanoutJobProgress(jobId: string, status: string, lastRecipientId: string, queuedCount: number): Promise<void> {
      await db.query(
        `UPDATE notification_email_jobs
       SET status = $2,
           last_recipient_id = $3::uuid,
           last_user_id = NULL,
           queued_count = queued_count + $4::int,
           last_error = NULL,
           next_attempt_at = now(),
           updated_at = now()
       WHERE id = $1::uuid`,
        [jobId, status, lastRecipientId, queuedCount],
      );
    },

    /** attempts + 1, retried in 5 minutes. */
    async markFanoutJobFailed(jobId: string, message: string): Promise<void> {
      await db.query(
        `UPDATE notification_email_jobs
       SET status = 'failed',
           attempts = attempts + 1,
           last_error = $2::text,
           next_attempt_at = now() + interval '5 minutes',
           updated_at = now()
       WHERE id = $1::uuid`,
        [jobId, message],
      );
    },
  };
}

export type EmailOutboxEnqueueRepository = ReturnType<typeof createEmailOutboxEnqueueRepository>;
