import type { PoolClient } from 'pg';
import { getClient, query } from '../../config/database.js';
import { decryptSecret } from '../../utils/secret-crypto.js';
import { sendSmtpMail } from '../../utils/smtp-client.js';
import { getTenantSmtpConfigForSend } from '../tenants/tenant-smtp.service.js';

type DeadlineMode = 'none' | 'absolute' | 'relative_to_enrollment';
type SubmissionUnlockMode = 'after_content_complete' | 'anytime';

interface EmailBranding {
  tenantName: string;
  brandName: string;
  learnerUrl: string | null;
  learnerDomainLabel: string | null;
}

interface FeedbackEmailContext {
  tenantId: string;
  submissionId: string;
  learnerId: string;
  learnerName: string;
  learnerEmail: string;
  courseName: string;
  assignmentTitle: string;
  feedbackText: string;
  score?: number | null;
}

interface AssignmentCreatedEmailContext {
  tenantId: string;
  notificationId: string;
  courseName: string;
  assignmentTitle: string;
  assignmentQuestion: string;
  deadlineEnabled?: boolean;
  deadlineAt?: string | Date | null;
  deadlineMode?: DeadlineMode;
  deadlineAfterDays?: number | null;
  submissionUnlockMode?: SubmissionUnlockMode;
}

interface RecipientSummaryItem {
  name: string;
  email: string;
}

interface RecipientSummary {
  totalCount: number;
  recipients: RecipientSummaryItem[];
}

const OWNER_FEEDBACK_DIGEST_SUBJECT = 'Tổng hợp phản hồi bài tập mới';
const OWNER_FEEDBACK_DIGEST_DELAY_MINUTES = 5;
const OWNER_FEEDBACK_HTML_MARKER = '<!-- LANDA_OWNER_FEEDBACK_ITEMS -->';
const OWNER_FEEDBACK_TEXT_MARKER = '[LANDA_OWNER_FEEDBACK_ITEMS]';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function htmlLines(value: string): string {
  return escapeHtml(value || '').replace(/\n/g, '<br>');
}

function formatDateTime(value: string | Date): string {
  return new Intl.DateTimeFormat('vi-VN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Ho_Chi_Minh',
  }).format(new Date(value));
}

function normalizeLearnerUrl(domain?: string | null): string | null {
  const trimmed = domain?.trim();
  if (!trimmed) return null;
  const withoutTrailingSlash = trimmed.replace(/\/+$/, '');
  if (/^https?:\/\//i.test(withoutTrailingSlash)) return withoutTrailingSlash;
  return `https://${withoutTrailingSlash.replace(/^\/+/, '')}`;
}

function displayDomain(url: string | null): string | null {
  if (!url) return null;
  return url.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

function cleanEmailBody(value: string): string {
  return value
    .split(OWNER_FEEDBACK_HTML_MARKER).join('')
    .split(OWNER_FEEDBACK_TEXT_MARKER).join('');
}

function deadlineLabel(ctx: AssignmentCreatedEmailContext): string {
  if (ctx.deadlineMode === 'relative_to_enrollment' && ctx.deadlineAfterDays) {
    return `Hạn nộp sau ${ctx.deadlineAfterDays} ngày kể từ lúc học viên ghi danh.`;
  }
  if ((ctx.deadlineMode === 'absolute' || ctx.deadlineEnabled) && ctx.deadlineAt) {
    return `Hạn nộp: ${formatDateTime(ctx.deadlineAt)}.`;
  }
  return 'Bài tập này chưa đặt hạn nộp.';
}

function unlockLabel(mode?: SubmissionUnlockMode): string {
  return mode === 'anytime'
    ? 'Học viên có thể nộp bài trước khi học xong toàn bộ nội dung.'
    : 'Học viên cần học xong toàn bộ nội dung khóa học trước khi nộp bài.';
}

async function getEmailBranding(tenantId: string, client?: PoolClient): Promise<EmailBranding> {
  const sql = `SELECT name, domain_learner
     FROM tenants
     WHERE id = $1::uuid`;
  const params = [tenantId];
  const result = client
    ? await client.query<{
        name: string;
        domain_learner: string | null;
      }>(sql, params)
    : await query<{
        name: string;
        domain_learner: string | null;
      }>(sql, params);
  const tenant = result.rows[0];
  const tenantName = tenant?.name || 'Tenant';
  const learnerUrl = normalizeLearnerUrl(tenant?.domain_learner);
  return {
    tenantName,
    brandName: `${tenantName} E-Learning`,
    learnerUrl,
    learnerDomainLabel: displayDomain(learnerUrl),
  };
}

function shellEmail(branding: EmailBranding, eyebrow: string, title: string, intro: string, body: string): string {
  return `<!doctype html>
<html lang="vi">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="color-scheme" content="light">
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
    <style>
      body, table, td, div, p, a, span, strong, h1 {
        font-family: 'Inter', sans-serif !important;
      }
    </style>
    <title>${escapeHtml(title)}</title>
  </head>
  <body style="margin:0;padding:0;background:#edf2f7;font-family:'Inter',sans-serif;color:#111827">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;background:#edf2f7;margin:0;padding:28px 12px">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;max-width:680px;border-collapse:separate;border-spacing:0">
            <tr>
              <td style="padding:0 0 14px 0">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="font-size:18px;line-height:26px;font-weight:800;color:#0f172a">
                      ${escapeHtml(branding.brandName)}
                    </td>
                    <td align="right" style="font-size:12px;line-height:18px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.5px">
                      ${escapeHtml(eyebrow)}
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="background:#ffffff;border:1px solid #dbe3ef;border-radius:24px;box-shadow:0 18px 42px rgba(15,23,42,.12)">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="background:#111827;padding:26px 28px 28px;border-bottom:5px solid #10b981">
                      <div style="font-size:13px;line-height:20px;color:#a7f3d0;font-weight:800;text-transform:uppercase;letter-spacing:.6px">
                        ${escapeHtml(branding.tenantName)}
                      </div>
                      <h1 style="margin:10px 0 0;color:#ffffff;font-size:28px;line-height:36px;font-weight:800">
                        ${escapeHtml(title)}
                      </h1>
                      <p style="margin:12px 0 0;color:#dbeafe;font-size:15px;line-height:24px;font-weight:500">
                        ${escapeHtml(intro)}
                      </p>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:28px">
                      ${body}
                      ${learnerAccessBlock(branding)}
                      <div style="height:1px;background:#e5e7eb;margin:28px 0 16px"></div>
                      <p style="margin:0;color:#64748b;font-size:12px;line-height:20px">
                        Email này được gửi tự động từ ${escapeHtml(branding.brandName)}. Vui lòng đăng nhập hệ thống để xem đầy đủ nội dung và tệp đính kèm nếu có.
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function pill(label: string, tone: 'blue' | 'green' | 'amber' | 'slate' = 'blue'): string {
  const palette = {
    blue: { bg: '#eff6ff', fg: '#1d4ed8', bd: '#bfdbfe' },
    green: { bg: '#ecfdf5', fg: '#047857', bd: '#bbf7d0' },
    amber: { bg: '#fffbeb', fg: '#b45309', bd: '#fde68a' },
    slate: { bg: '#f8fafc', fg: '#334155', bd: '#e2e8f0' },
  }[tone];
  return `<span style="display:inline-block;border-radius:999px;background:${palette.bg};border:1px solid ${palette.bd};color:${palette.fg};font-size:12px;line-height:18px;font-weight:800;padding:6px 11px">${escapeHtml(label)}</span>`;
}

function infoTable(rows: Array<{ label: string; value: string }>): string {
  const renderedRows = rows.map(row => `
    <tr>
      <td style="padding:12px 0;border-bottom:1px solid #e5e7eb;width:36%;vertical-align:top;color:#64748b;font-size:13px;line-height:20px;font-weight:700">
        ${escapeHtml(row.label)}
      </td>
      <td style="padding:12px 0;border-bottom:1px solid #e5e7eb;vertical-align:top;color:#0f172a;font-size:14px;line-height:22px;font-weight:700">
        ${escapeHtml(row.value)}
      </td>
    </tr>
  `).join('');
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:18px;border-collapse:collapse">
      ${renderedRows}
    </table>
  `;
}

function sectionTitle(value: string): string {
  return `<div style="margin-top:24px;color:#0f172a;font-size:14px;line-height:20px;font-weight:800;text-transform:uppercase;letter-spacing:.5px">${escapeHtml(value)}</div>`;
}

function quoteBlock(value: string): string {
  return `
    <div style="border:1px solid #dbe3ef;border-left:5px solid #2563eb;background:#f8fafc;border-radius:16px;padding:16px 18px;margin-top:10px;color:#1f2937;font-size:15px;line-height:24px">
      ${htmlLines(value)}
    </div>
  `;
}

function learnerAccessBlock(branding: EmailBranding): string {
  if (!branding.learnerUrl || !branding.learnerDomainLabel) {
    return '';
  }
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:24px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:18px">
      <tr>
        <td style="padding:18px 20px">
          <div style="font-size:12px;line-height:18px;color:#047857;font-weight:800;text-transform:uppercase;letter-spacing:.5px">Cổng học viên</div>
          <div style="margin-top:6px;font-size:16px;line-height:24px;color:#064e3b;font-weight:800">${escapeHtml(branding.learnerDomainLabel)}</div>
          <div style="margin-top:14px">
            <a href="${escapeHtml(branding.learnerUrl)}" style="display:inline-block;background:#059669;color:#ffffff;text-decoration:none;border-radius:12px;padding:11px 16px;font-size:14px;line-height:18px;font-weight:800">
              Mở cổng học viên
            </a>
          </div>
        </td>
      </tr>
    </table>
  `;
}

function recipientList(summary: RecipientSummary): string {
  if (summary.totalCount <= 0) return '';
  const rows = summary.recipients.map((recipient, index) => `
    <tr>
      <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;color:#64748b;font-size:13px;line-height:20px;font-weight:800;width:44px">${index + 1}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;color:#0f172a;font-size:14px;line-height:21px;font-weight:700">${escapeHtml(recipient.name)}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;color:#475569;font-size:13px;line-height:21px">${escapeHtml(recipient.email)}</td>
    </tr>
  `).join('');
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;border:1px solid #e2e8f0;border-radius:16px;border-collapse:separate;border-spacing:0;background:#ffffff">
      <tr>
        <td style="padding:14px 16px;background:#f8fafc;border-bottom:1px solid #e5e7eb;border-radius:16px 16px 0 0;color:#0f172a;font-size:14px;line-height:22px;font-weight:800">
          Danh sách học viên nhận thông báo (${summary.totalCount})
        </td>
      </tr>
      <tr>
        <td style="padding:0">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
            ${rows}
          </table>
        </td>
      </tr>
    </table>
  `;
}

function scoreLabel(score?: number | null): string {
  return score !== undefined && score !== null ? `Điểm: ${score}/100` : 'Đã có phản hồi';
}

function buildFeedbackEmail(ctx: FeedbackEmailContext, branding: EmailBranding) {
  const subject = `Phản hồi bài tập: ${ctx.assignmentTitle} - ${ctx.courseName}`;
  const score = scoreLabel(ctx.score);
  const learnerAccess = branding.learnerDomainLabel
    ? `Cổng học viên: ${branding.learnerDomainLabel}`
    : '';
  const text = [
    `Xin chào ${ctx.learnerName},`,
    '',
    `Bài tập "${ctx.assignmentTitle}" trong khóa học "${ctx.courseName}" đã có phản hồi mới.`,
    score,
    learnerAccess,
    '',
    'Nhận xét:',
    ctx.feedbackText,
    '',
    'Vui lòng đăng nhập hệ thống để xem chi tiết và tệp đính kèm nếu có.',
  ].filter(Boolean).join('\n');

  const html = shellEmail(
    branding,
    'Phản hồi bài tập',
    'Bài tập của bạn đã có phản hồi',
    `Xin chào ${ctx.learnerName}, quản trị viên đã gửi nhận xét mới cho bài tập của bạn.`,
    `
      <p style="margin:0;color:#334155;font-size:15px;line-height:24px">
        Bài tập <strong>${escapeHtml(ctx.assignmentTitle)}</strong> trong khóa học <strong>${escapeHtml(ctx.courseName)}</strong> đã được phản hồi.
      </p>
      <div style="margin-top:16px">${pill(score, ctx.score !== undefined && ctx.score !== null ? 'green' : 'blue')}</div>
      ${infoTable([
        { label: 'Khóa học', value: ctx.courseName },
        { label: 'Bài tập', value: ctx.assignmentTitle },
        { label: 'Người học', value: `${ctx.learnerName} (${ctx.learnerEmail})` },
      ])}
      ${sectionTitle('Nhận xét từ quản trị viên')}
      ${quoteBlock(ctx.feedbackText)}
    `,
  );

  return { subject, text, html };
}

function buildAssignmentCreatedEmail(ctx: AssignmentCreatedEmailContext, branding: EmailBranding) {
  const subject = `Bài tập mới: ${ctx.assignmentTitle} - ${ctx.courseName}`;
  const deadline = deadlineLabel(ctx);
  const unlock = unlockLabel(ctx.submissionUnlockMode);
  const learnerAccess = branding.learnerDomainLabel
    ? `Cổng học viên: ${branding.learnerDomainLabel}`
    : '';
  const text = [
    'Xin chào,',
    '',
    `Khóa học "${ctx.courseName}" vừa có bài tập mới: "${ctx.assignmentTitle}".`,
    deadline,
    unlock,
    learnerAccess,
    '',
    'Yêu cầu bài tập:',
    ctx.assignmentQuestion,
    '',
    'Vui lòng đăng nhập hệ thống để xem chi tiết.',
  ].filter(Boolean).join('\n');

  const html = shellEmail(
    branding,
    'Bài tập mới',
    'Khóa học vừa có bài tập mới',
    `Một bài tập mới đã được thêm vào khóa học ${ctx.courseName}.`,
    `
      <p style="margin:0;color:#334155;font-size:15px;line-height:24px">
        Khóa học <strong>${escapeHtml(ctx.courseName)}</strong> vừa có bài tập mới. Hãy đăng nhập để xem đầy đủ yêu cầu và chuẩn bị bài nộp đúng hạn.
      </p>
      ${infoTable([
        { label: 'Khóa học', value: ctx.courseName },
        { label: 'Bài tập', value: ctx.assignmentTitle },
        { label: 'Thời hạn', value: deadline },
        { label: 'Điều kiện nộp', value: unlock },
      ])}
      ${sectionTitle('Yêu cầu bài tập')}
      ${quoteBlock(ctx.assignmentQuestion)}
    `,
  );

  return { subject, text, html };
}

function buildAssignmentCreatedOwnerEmail(
  ctx: AssignmentCreatedEmailContext,
  branding: EmailBranding,
  summary: RecipientSummary,
) {
  const subject = `Đã gửi bài tập mới: ${ctx.assignmentTitle} - ${ctx.courseName}`;
  const deadline = deadlineLabel(ctx);
  const unlock = unlockLabel(ctx.submissionUnlockMode);
  const learnerAccess = branding.learnerDomainLabel
    ? `Cổng học viên: ${branding.learnerDomainLabel}`
    : '';
  const textRecipients = summary.recipients
    .map((recipient, index) => `${index + 1}. ${recipient.name} <${recipient.email}>`)
    .join('\n');
  const text = [
    `Thông báo bài tập mới đã được gửi đến ${summary.totalCount} học viên.`,
    '',
    `Khóa học: ${ctx.courseName}`,
    `Bài tập: ${ctx.assignmentTitle}`,
    deadline,
    unlock,
    learnerAccess,
    '',
    'Danh sách học viên:',
    textRecipients,
    '',
    'Yêu cầu bài tập:',
    ctx.assignmentQuestion,
  ].filter(Boolean).join('\n');

  const html = shellEmail(
    branding,
    'Tổng hợp gửi thông báo',
    'Đã gửi thông báo bài tập mới',
    `Thông báo bài tập mới đã được gửi đến ${summary.totalCount} học viên.`,
    `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:18px">
        <tr>
          <td style="padding:20px">
            <div style="font-size:36px;line-height:42px;color:#0f172a;font-weight:800">${summary.totalCount}</div>
            <div style="margin-top:4px;color:#475569;font-size:14px;line-height:22px;font-weight:700">học viên nhận thông báo bài tập mới</div>
          </td>
        </tr>
      </table>
      ${infoTable([
        { label: 'Khóa học', value: ctx.courseName },
        { label: 'Bài tập', value: ctx.assignmentTitle },
        { label: 'Thời hạn', value: deadline },
        { label: 'Điều kiện nộp', value: unlock },
      ])}
      ${recipientList(summary)}
      ${sectionTitle('Yêu cầu bài tập')}
      ${quoteBlock(ctx.assignmentQuestion)}
    `,
  );

  return { subject, text, html };
}

function ownerFeedbackItemHtml(ctx: FeedbackEmailContext): string {
  const learner = `${ctx.learnerName} (${ctx.learnerEmail})`;
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px;border:1px solid #e2e8f0;border-radius:16px;background:#ffffff">
      <tr>
        <td style="padding:16px 18px">
          <div style="color:#0f172a;font-size:15px;line-height:22px;font-weight:800">${escapeHtml(ctx.assignmentTitle)}</div>
          <div style="margin-top:4px;color:#64748b;font-size:13px;line-height:20px">${escapeHtml(ctx.courseName)}</div>
          <div style="margin-top:10px">${pill(scoreLabel(ctx.score), ctx.score !== undefined && ctx.score !== null ? 'green' : 'blue')}</div>
          ${infoTable([
            { label: 'Học viên', value: learner },
            { label: 'Khóa học', value: ctx.courseName },
          ])}
          ${sectionTitle('Nhận xét')}
          ${quoteBlock(ctx.feedbackText)}
        </td>
      </tr>
    </table>
  `;
}

function ownerFeedbackItemText(ctx: FeedbackEmailContext): string {
  return [
    `Học viên: ${ctx.learnerName} <${ctx.learnerEmail}>`,
    `Khóa học: ${ctx.courseName}`,
    `Bài tập: ${ctx.assignmentTitle}`,
    scoreLabel(ctx.score),
    'Nhận xét:',
    ctx.feedbackText,
  ].join('\n');
}

function buildOwnerFeedbackDigestEmail(ctx: FeedbackEmailContext, branding: EmailBranding) {
  const learnerAccess = branding.learnerDomainLabel
    ? `Cổng học viên: ${branding.learnerDomainLabel}`
    : '';
  const text = [
    'Có phản hồi bài tập mới cần theo dõi.',
    learnerAccess,
    '',
    ownerFeedbackItemText(ctx),
    '',
    OWNER_FEEDBACK_TEXT_MARKER,
  ].filter(Boolean).join('\n');

  const html = shellEmail(
    branding,
    'Tổng hợp phản hồi',
    'Tổng hợp phản hồi bài tập mới',
    'Các phản hồi bài tập mới đang được tổng hợp trong email này.',
    `
      <p style="margin:0;color:#334155;font-size:15px;line-height:24px">
        Các phản hồi bài tập mới đang được tổng hợp tại đây để owner doanh nghiệp theo dõi một lần, không bị tách thành nhiều email rời.
      </p>
      ${ownerFeedbackItemHtml(ctx)}
      ${OWNER_FEEDBACK_HTML_MARKER}
    `,
  );

  return { subject: OWNER_FEEDBACK_DIGEST_SUBJECT, text, html };
}

async function insertOutboxEmail(
  client: PoolClient,
  input: {
    tenantId: string;
    relatedSubmissionId?: string | null;
    recipientUserId?: string | null;
    recipientEmail: string;
    recipientName?: string | null;
    subject: string;
    html: string;
    text: string;
    delayMinutes?: number;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO email_outbox (
       tenant_id, related_submission_id, recipient_user_id, recipient_email, recipient_name,
       subject, html_body, text_body, next_attempt_at
     )
     VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::varchar, $5::varchar,
       LEFT($6::text, 255), $7::text, $8::text,
       now() + (($9::int || ' minutes')::interval)
     )`,
    [
      input.tenantId,
      input.relatedSubmissionId ?? null,
      input.recipientUserId ?? null,
      input.recipientEmail,
      input.recipientName ?? null,
      input.subject,
      input.html,
      input.text,
      input.delayMinutes ?? 0,
    ],
  );
}

async function enqueueOwnerFeedbackDigestEmail(
  client: PoolClient,
  ctx: FeedbackEmailContext,
  branding: EmailBranding,
  recipientEmail: string,
): Promise<number> {
  const existing = await client.query<{ id: string }>(
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
    [ctx.tenantId, recipientEmail, OWNER_FEEDBACK_DIGEST_SUBJECT, OWNER_FEEDBACK_HTML_MARKER],
  );

  const nextHtmlItem = ownerFeedbackItemHtml(ctx);
  const nextTextItem = `\n\n${ownerFeedbackItemText(ctx)}`;

  if (existing.rowCount && existing.rows[0]) {
    await client.query(
      `UPDATE email_outbox
       SET html_body = REPLACE(html_body, $2::text, $3::text || $2::text),
           text_body = REPLACE(text_body, $4::text, $5::text || E'\n' || $4::text),
           next_attempt_at = now() + (($6::int || ' minutes')::interval),
           updated_at = now()
       WHERE id = $1::uuid`,
      [
        existing.rows[0].id,
        OWNER_FEEDBACK_HTML_MARKER,
        nextHtmlItem,
        OWNER_FEEDBACK_TEXT_MARKER,
        nextTextItem,
        OWNER_FEEDBACK_DIGEST_DELAY_MINUTES,
      ],
    );
    return 1;
  }

  const { subject, text, html } = buildOwnerFeedbackDigestEmail(ctx, branding);
  await insertOutboxEmail(client, {
    tenantId: ctx.tenantId,
    recipientEmail,
    recipientName: 'Owner doanh nghiệp',
    subject,
    html,
    text,
    delayMinutes: OWNER_FEEDBACK_DIGEST_DELAY_MINUTES,
  });
  return 1;
}

function normalizeRecipients(rows: RecipientSummaryItem[] | null | undefined): RecipientSummaryItem[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter(row => row && typeof row.email === 'string' && row.email.trim())
    .map(row => ({
      name: (typeof row.name === 'string' && row.name.trim()) ? row.name.trim() : row.email,
      email: row.email.trim(),
    }));
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

  const branding = await getEmailBranding(ctx.tenantId, client);
  const { subject, text, html } = buildFeedbackEmail(ctx, branding);
  const row = smtp.rows[0];
  let count = 0;

  if (ctx.learnerEmail?.trim()) {
    await insertOutboxEmail(client, {
      tenantId: ctx.tenantId,
      relatedSubmissionId: ctx.submissionId,
      recipientUserId: ctx.learnerId,
      recipientEmail: ctx.learnerEmail,
      recipientName: ctx.learnerName,
      subject,
      html,
      text,
    });
    count += 1;
  }

  if (row.copy_to_sender) {
    const copyEmail = (row.copy_to_email || row.username || '').trim();
    if (copyEmail) {
      count += await enqueueOwnerFeedbackDigestEmail(client, ctx, branding, copyEmail);
    }
  }

  return count;
}

export async function enqueueAssignmentCreatedEmails(
  client: PoolClient,
  ctx: AssignmentCreatedEmailContext,
): Promise<number> {
  const smtp = await client.query<{
    username: string;
    copy_to_sender: boolean;
    copy_to_email: string | null;
  }>(
    `SELECT username, copy_to_sender, copy_to_email
     FROM tenant_smtp_configs
     WHERE tenant_id = $1::uuid AND is_enabled = true
     LIMIT 1`,
    [ctx.tenantId],
  );

  if (smtp.rowCount === 0) return 0;

  const branding = await getEmailBranding(ctx.tenantId, client);
  const learnerEmail = buildAssignmentCreatedEmail(ctx, branding);
  const inserted = await client.query<{
    total_count: number;
    recipients: RecipientSummaryItem[] | null;
  }>(
    `WITH learner_recipients AS (
       SELECT DISTINCT ON (LOWER(u.email))
              nr.user_id,
              u.email::text AS email,
              COALESCE(NULLIF(u.full_name, ''), u.username, u.email)::text AS name
       FROM notification_recipients nr
       JOIN users u ON u.id = nr.user_id
       WHERE nr.notification_id = $1::uuid
         AND u.email IS NOT NULL
         AND BTRIM(u.email) <> ''
       ORDER BY LOWER(u.email), nr.user_id
     ),
     inserted AS (
       INSERT INTO email_outbox (
         tenant_id, related_submission_id, recipient_user_id, recipient_email, recipient_name,
         subject, html_body, text_body
       )
       SELECT $2::uuid, NULL::uuid, user_id, email, name, LEFT($3::text, 255), $4::text, $5::text
       FROM learner_recipients
       RETURNING recipient_email AS email, COALESCE(recipient_name, recipient_email)::text AS name
     ),
     numbered AS (
       SELECT email,
              name,
              COUNT(*) OVER ()::int AS total_count
       FROM inserted
     )
     SELECT COALESCE(MAX(total_count), 0)::int AS total_count,
            COALESCE(
              jsonb_agg(jsonb_build_object('name', name, 'email', email) ORDER BY name, email),
              '[]'::jsonb
            ) AS recipients
     FROM numbered`,
    [
      ctx.notificationId,
      ctx.tenantId,
      learnerEmail.subject,
      learnerEmail.html,
      learnerEmail.text,
    ],
  );

  const totalCount = Number(inserted.rows[0]?.total_count || 0);
  const summary: RecipientSummary = {
    totalCount,
    recipients: normalizeRecipients(inserted.rows[0]?.recipients),
  };
  let count = totalCount;

  const row = smtp.rows[0];
  if (row.copy_to_sender && totalCount > 0) {
    const copyEmail = (row.copy_to_email || row.username || '').trim();
    if (copyEmail) {
      const ownerEmail = buildAssignmentCreatedOwnerEmail(ctx, branding, summary);
      await insertOutboxEmail(client, {
        tenantId: ctx.tenantId,
        recipientEmail: copyEmail,
        recipientName: 'Owner doanh nghiệp',
        subject: ownerEmail.subject,
        html: ownerEmail.html,
        text: ownerEmail.text,
      });
      count += 1;
    }
  }

  return count;
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
            html: cleanEmailBody(job.html_body),
            text: cleanEmailBody(job.text_body),
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
