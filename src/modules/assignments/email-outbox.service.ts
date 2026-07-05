import type { PoolClient } from 'pg';
import { getClient, query } from '../../config/database.js';
import { decryptSecret } from '../../utils/secret-crypto.js';
import { sendSmtpMail } from '../../utils/smtp-client.js';
import { getTenantSmtpConfigForSend } from '../tenants/tenant-smtp.service.js';

interface FeedbackEmailContext {
  tenantId: string;
  submissionId: string;
  learnerId: string;
  learnerName: string;
  learnerEmail: string;
  courseName: string;
  assignmentTitle: string;
  feedbackText: string;
}

interface AssignmentCreatedEmailContext {
  tenantId: string;
  notificationId: string;
  courseName: string;
  assignmentTitle: string;
  assignmentQuestion: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function buildFeedbackEmail(ctx: FeedbackEmailContext) {
  const subject = `Feedback bai tap: ${ctx.courseName}`;
  const text = [
    `Xin chao ${ctx.learnerName},`,
    '',
    `Bai tap "${ctx.assignmentTitle}" trong khoa hoc "${ctx.courseName}" da co feedback.`,
    '',
    'Nhan xet:',
    ctx.feedbackText,
    '',
    'Vui long dang nhap he thong de xem chi tiet va file dinh kem neu co.',
  ].join('\n');

  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111827;background:#f9fafb;padding:24px">
      <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:24px">
        <div style="font-size:14px;color:#6b7280;margin-bottom:8px">Landa LMS</div>
        <h1 style="font-size:20px;line-height:1.3;margin:0 0 16px;color:#111827">Bai tap da co feedback</h1>
        <p style="margin:0 0 12px">Xin chao <strong>${escapeHtml(ctx.learnerName)}</strong>,</p>
        <p style="margin:0 0 12px">Bai tap <strong>${escapeHtml(ctx.assignmentTitle)}</strong> trong khoa hoc <strong>${escapeHtml(ctx.courseName)}</strong> da duoc admin nhan xet.</p>
        <div style="border-left:4px solid #2563eb;background:#eff6ff;padding:12px 14px;margin:18px 0;border-radius:8px">
          ${escapeHtml(ctx.feedbackText).replace(/\n/g, '<br>')}
        </div>
        <p style="margin:0;color:#4b5563">Vui long dang nhap he thong de xem chi tiet va file dinh kem neu co.</p>
      </div>
    </div>
  `;

  return { subject, text, html };
}

function buildAssignmentCreatedEmail(ctx: AssignmentCreatedEmailContext) {
  const subject = `Bai tap moi: ${ctx.courseName}`;
  const text = [
    'Xin chao,',
    '',
    `Khoa hoc "${ctx.courseName}" vua co bai tap moi: "${ctx.assignmentTitle}".`,
    '',
    'Cau hoi:',
    ctx.assignmentQuestion,
    '',
    'Vui long dang nhap he thong de xem chi tiet. Ban chi co the nop bai sau khi hoan thanh 100% tien do khoa hoc.',
  ].join('\n');

  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111827;background:#f9fafb;padding:24px">
      <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:24px">
        <div style="font-size:14px;color:#6b7280;margin-bottom:8px">Landa LMS</div>
        <h1 style="font-size:20px;line-height:1.3;margin:0 0 16px;color:#111827">Khoa hoc co bai tap moi</h1>
        <p style="margin:0 0 12px">Khoa hoc <strong>${escapeHtml(ctx.courseName)}</strong> vua co bai tap moi.</p>
        <div style="border:1px solid #dbeafe;background:#eff6ff;padding:14px 16px;margin:18px 0;border-radius:10px">
          <div style="font-size:13px;color:#1d4ed8;margin-bottom:4px">Bai tap</div>
          <div style="font-size:16px;font-weight:700;color:#111827">${escapeHtml(ctx.assignmentTitle)}</div>
        </div>
        <div style="border-left:4px solid #2563eb;background:#f8fafc;padding:12px 14px;margin:18px 0;border-radius:8px">
          ${escapeHtml(ctx.assignmentQuestion).replace(/\n/g, '<br>')}
        </div>
        <p style="margin:0;color:#4b5563">Vui long dang nhap he thong de xem chi tiet. Ban chi co the nop bai sau khi hoan thanh 100% tien do khoa hoc.</p>
      </div>
    </div>
  `;

  return { subject, text, html };
}

export async function enqueueFeedbackEmails(client: PoolClient, ctx: FeedbackEmailContext): Promise<number> {
  const smtp = await client.query<{
    is_enabled: boolean;
    username: string;
    copy_to_sender: boolean;
    copy_to_email: string | null;
  }>(
    `SELECT is_enabled, username, copy_to_sender, copy_to_email
     FROM tenant_smtp_configs
     WHERE tenant_id = $1 AND is_enabled = true`,
    [ctx.tenantId],
  );

  if (smtp.rowCount === 0) return 0;

  const { subject, text, html } = buildFeedbackEmail(ctx);
  const row = smtp.rows[0];
  const recipients = new Map<string, { email: string; name: string | null; userId: string | null }>();
  recipients.set(ctx.learnerEmail.toLowerCase(), {
    email: ctx.learnerEmail,
    name: ctx.learnerName,
    userId: ctx.learnerId,
  });

  if (row.copy_to_sender) {
    const copyEmail = row.copy_to_email || row.username;
    if (copyEmail) {
      recipients.set(copyEmail.toLowerCase(), {
        email: copyEmail,
        name: 'SMTP copy',
        userId: null,
      });
    }
  }

  let count = 0;
  for (const recipient of recipients.values()) {
    await client.query(
      `INSERT INTO email_outbox (
         tenant_id, related_submission_id, recipient_user_id, recipient_email, recipient_name,
         subject, html_body, text_body
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        ctx.tenantId,
        ctx.submissionId,
        recipient.userId,
        recipient.email,
        recipient.name,
        subject,
        html,
        text,
      ],
    );
    count += 1;
  }

  return count;
}

export async function enqueueAssignmentCreatedEmails(
  client: PoolClient,
  ctx: AssignmentCreatedEmailContext,
): Promise<number> {
  const { subject, text, html } = buildAssignmentCreatedEmail(ctx);
  const result = await client.query<{ id: string }>(
    `WITH smtp AS (
       SELECT username, copy_to_sender, copy_to_email
       FROM tenant_smtp_configs
       WHERE tenant_id = $1::uuid AND is_enabled = true
       LIMIT 1
     ),
     learner_recipients AS (
       SELECT nr.user_id,
              u.email::text AS email,
              COALESCE(NULLIF(u.full_name, ''), u.username, u.email)::text AS name
       FROM notification_recipients nr
       JOIN users u ON u.id = nr.user_id
       JOIN smtp ON true
       WHERE nr.notification_id = $2::uuid
         AND u.email IS NOT NULL
         AND BTRIM(u.email) <> ''
     ),
     copy_recipients AS (
       SELECT NULL::uuid AS user_id,
              COALESCE(NULLIF(copy_to_email, ''), username)::text AS email,
              'SMTP copy'::text AS name
       FROM smtp
       WHERE copy_to_sender = true
         AND COALESCE(NULLIF(copy_to_email, ''), username) IS NOT NULL
         AND BTRIM(COALESCE(NULLIF(copy_to_email, ''), username)) <> ''
     ),
     deduped AS (
       SELECT DISTINCT ON (LOWER(email)) user_id, email, name
       FROM (
         SELECT * FROM learner_recipients
         UNION ALL
         SELECT * FROM copy_recipients
       ) recipients
       ORDER BY LOWER(email), user_id NULLS LAST
     )
     INSERT INTO email_outbox (
       tenant_id, related_submission_id, recipient_user_id, recipient_email, recipient_name,
       subject, html_body, text_body
     )
     SELECT $1::uuid, NULL::uuid, user_id, email, name, LEFT($3::text, 255), $4::text, $5::text
     FROM deduped
     RETURNING id`,
    [ctx.tenantId, ctx.notificationId, subject, html, text],
  );

  return result.rowCount ?? 0;
}

export async function enqueueAssignmentCreatedEmailsForNotification(
  ctx: AssignmentCreatedEmailContext,
): Promise<number> {
  const client = await getClient();
  try {
    return await enqueueAssignmentCreatedEmails(client, ctx);
  } finally {
    client.release();
  }
}

export async function processEmailOutboxBatch(tenantId?: string, limit = 10): Promise<number> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const params: unknown[] = [limit];
    let tenantFilter = '';
    if (tenantId) {
      params.push(tenantId);
      tenantFilter = `AND tenant_id = $${params.length}`;
    }

    const jobs = await client.query<{
      id: string;
      tenant_id: string;
      recipient_email: string;
      subject: string;
      html_body: string;
      text_body: string;
      attempts: number;
      max_attempts: number;
    }>(
      `SELECT id, tenant_id, recipient_email, subject, html_body, text_body, attempts, max_attempts
       FROM email_outbox
       WHERE status IN ('pending', 'failed')
         AND next_attempt_at <= now()
         ${tenantFilter}
       ORDER BY next_attempt_at ASC, created_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      params,
    );

    await client.query(
      `UPDATE email_outbox
       SET status = 'sending'
       WHERE id = ANY($1::uuid[])`,
      [jobs.rows.map(job => job.id)],
    );
    await client.query('COMMIT');

    let processed = 0;
    for (const job of jobs.rows) {
      try {
        const smtp = await getTenantSmtpConfigForSend(job.tenant_id);
        if (!smtp || !smtp.password_ciphertext || !smtp.password_iv || !smtp.password_auth_tag) {
          throw new Error('SMTP config is disabled or missing password');
        }

        const password = decryptSecret({
          ciphertext: smtp.password_ciphertext,
          iv: smtp.password_iv,
          authTag: smtp.password_auth_tag,
        });

        await sendSmtpMail(
          {
            host: smtp.host,
            port: smtp.port,
            secure: smtp.secure,
            username: smtp.username,
            password,
            fromEmail: smtp.from_email,
            fromName: smtp.from_name,
            replyToEmail: smtp.reply_to_email,
          },
          {
            to: job.recipient_email,
            subject: job.subject,
            html: job.html_body,
            text: job.text_body,
          },
        );

        await query(
          `UPDATE email_outbox
           SET status = 'sent', sent_at = now(), last_error = NULL
           WHERE id = $1`,
          [job.id],
        );
        processed += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const nextAttempts = job.attempts + 1;
        const nextStatus = nextAttempts >= job.max_attempts ? 'failed' : 'pending';
        await query(
          `UPDATE email_outbox
           SET status = $2,
               attempts = attempts + 1,
               last_error = $3,
               next_attempt_at = now() + (($4 * $4) || ' minutes')::interval
           WHERE id = $1`,
          [job.id, nextStatus, message.slice(0, 2000), nextAttempts],
        );
      }
    }

    return processed;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

let workerStarted = false;
export function startEmailOutboxWorker(): void {
  if (workerStarted) return;
  workerStarted = true;
  setInterval(() => {
    processEmailOutboxBatch().catch(err => {
      console.error('[EmailOutbox] Worker error:', err instanceof Error ? err.message : err);
    });
  }, 60_000).unref();
}
