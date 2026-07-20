import type { PoolClient } from 'pg';
import { getClient, query } from '../../config/database.js';
import { env } from '../../config/env.js';
import { consume, publish, QUEUES } from '../../config/rabbitmq/index.js';
import { decryptSecret } from '../../utils/secret-crypto.js';
import { sendSmtpMailBatch, type SmtpBatchMail, type SmtpConfig } from '../../utils/smtp-client.js';
import { getTenantSmtpConfigForSend } from '../tenants/tenant-smtp.service.js';
import {
  DEFAULT_GROUP_LABELS,
  getGroupLabelSet,
  lowerGroupLabel,
  type GroupLabelMap,
} from '../tenants/tenant-group-labels.service.js';
import {
  getEmailTemplateForRender,
  renderTemplateToHtml,
  renderTemplateToText,
  type EmailTemplateKey,
  type TemplateTokenMap,
} from '../email-templates/email-templates.service.js';

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
  feedbackByName: string;
  feedbackByEmail?: string | null;
  score?: number | null;
}

interface AssignmentCreatedEmailContext {
  tenantId: string;
  notificationId: string;
  courseId: string;
  courseName: string;
  learnerName?: string;
  assignmentTitle: string;
  assignmentQuestion: string;
  deadlineEnabled?: boolean;
  deadlineAt?: string | Date | null;
  deadlineMode?: DeadlineMode;
  deadlineAfterDays?: number | null;
  assignmentCreatedAt?: string | Date | null;
  submissionUnlockMode?: SubmissionUnlockMode;
}

interface CourseNotificationEmailContext {
  tenantId: string;
  notificationId: string;
  courseId: string;
  courseName: string;
  learnerName: string;
  title: string;
  message: string;
}

interface TeamMemberAddedCourseCategory {
  name: string;
  courseCount: number;
}

interface TeamMemberAddedEmailContext {
  tenantId: string;
  notificationId: string;
  learnerName?: string;
  orgGroupName: string;
  subGroupName: string;
  teamName: string;
  groupLabels?: GroupLabelMap;
  courseCategories: TeamMemberAddedCourseCategory[];
}

interface RecipientSummaryItem {
  name: string;
  email: string;
}

interface RecipientSummary {
  totalCount: number;
  recipients: RecipientSummaryItem[];
}

interface AssignmentCreatedEmailRecipient extends RecipientSummaryItem {
  userId: string;
  enrolledAt?: string | Date | null;
}

const OWNER_FEEDBACK_DIGEST_SUBJECT = 'Tổng hợp phản hồi bài tập mới';
const OWNER_FEEDBACK_DIGEST_DELAY_MINUTES = 5;
const OWNER_FEEDBACK_HTML_MARKER = '<!-- LANDA_OWNER_FEEDBACK_ITEMS -->';
const OWNER_FEEDBACK_TEXT_MARKER = '[LANDA_OWNER_FEEDBACK_ITEMS]';
const EMAIL_OUTBOX_STALE_SENDING_MINUTES = 5;
const EMAIL_OUTBOX_INTERVAL_MS = Math.max(5_000, env.EMAIL_OUTBOX_INTERVAL_MS);
const EMAIL_OUTBOX_BATCH_SIZE = Math.max(1, env.EMAIL_OUTBOX_BATCH_SIZE);
const EMAIL_OUTBOX_CLAIM_BATCH_SIZE = Math.max(1, Math.min(env.EMAIL_OUTBOX_CLAIM_BATCH_SIZE, EMAIL_OUTBOX_BATCH_SIZE));
const EMAIL_OUTBOX_CONCURRENCY = Math.max(1, Math.min(env.EMAIL_OUTBOX_CONCURRENCY, EMAIL_OUTBOX_BATCH_SIZE));
const EMAIL_OUTBOX_TENANT_CONCURRENCY = Math.max(1, Math.min(env.EMAIL_OUTBOX_TENANT_CONCURRENCY, EMAIL_OUTBOX_CONCURRENCY));
const EMAIL_OUTBOX_TICK_BUDGET_MS = Math.max(10_000, env.EMAIL_OUTBOX_TICK_BUDGET_MS);
const EMAIL_OUTBOX_SESSION_MAX_MESSAGES = Math.max(1, env.EMAIL_OUTBOX_SESSION_MAX_MESSAGES);
const EMAIL_OUTBOX_SENT_RETENTION_DAYS = Math.max(0, env.EMAIL_OUTBOX_SENT_RETENTION_DAYS);
const EMAIL_OUTBOX_RETENTION_BATCH_SIZE = Math.max(1, env.EMAIL_OUTBOX_RETENTION_BATCH_SIZE);
const EMAIL_OUTBOX_WAKE_DEBOUNCE_MS = Math.max(0, env.EMAIL_OUTBOX_WAKE_DEBOUNCE_MS);
const EMAIL_OUTBOX_RABBIT_PREFETCH = Math.max(1, env.EMAIL_OUTBOX_RABBIT_PREFETCH);
const EMAIL_OUTBOX_TENANT_FAILURE_THRESHOLD = Math.max(1, env.EMAIL_OUTBOX_TENANT_FAILURE_THRESHOLD);
const EMAIL_OUTBOX_TENANT_COOLDOWN_MS = Math.max(1_000, env.EMAIL_OUTBOX_TENANT_COOLDOWN_MS);
const EMAIL_OUTBOX_TENANT_MAX_COOLDOWN_MS = Math.max(EMAIL_OUTBOX_TENANT_COOLDOWN_MS, env.EMAIL_OUTBOX_TENANT_MAX_COOLDOWN_MS);
const EMAIL_OUTBOX_RETENTION_LOCK_KEY = 'landa:email-outbox-retention:v1';
const EMAIL_OUTBOX_RETENTION_INTERVAL_MS = 60 * 60 * 1000;
const EMAIL_FONT_FAMILY = "'Google Sans'";
const EMAIL_FONT_STYLE = `font-family:${EMAIL_FONT_FAMILY};`;

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

function buildLearnerCourseFocusUrl(
  branding: EmailBranding,
  courseId?: string | null,
  source = 'assignment_email',
): string | null {
  if (!branding.learnerUrl) return null;
  if (!courseId) return branding.learnerUrl;
  try {
    const url = new URL('/explore', branding.learnerUrl);
    url.searchParams.set('focus_course', courseId);
    url.searchParams.set('source', source);
    return url.toString();
  } catch {
    const base = branding.learnerUrl.replace(/\/+$/, '');
    return `${base}/explore?focus_course=${encodeURIComponent(courseId)}&source=${encodeURIComponent(source)}`;
  }
}

function cleanEmailBody(value: string): string {
  return value
    .split(OWNER_FEEDBACK_HTML_MARKER).join('')
    .split(OWNER_FEEDBACK_TEXT_MARKER).join('');
}

function hiddenPreheader(intro: string): string {
  const spacer = '&zwnj;&nbsp;'.repeat(90);
  return `
    <div style="${EMAIL_FONT_STYLE}display:none!important;max-height:0;max-width:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#edf2f7;opacity:0">
      ${escapeHtml(intro)}${spacer}
    </div>
  `;
}

function relativeDeadlinePolicyLabel(ctx: AssignmentCreatedEmailContext): string {
  return `Hạn nộp sau ${ctx.deadlineAfterDays} ngày. Nếu học viên đã ghi danh trước khi bài tập được tạo, hạn nộp được tính từ lúc bài tập được tạo; nếu ghi danh sau, hạn nộp được tính từ lúc ghi danh.`;
}

function deadlineLabel(ctx: AssignmentCreatedEmailContext): string {
  if (ctx.deadlineMode === 'relative_to_enrollment' && ctx.deadlineAfterDays) {
    return relativeDeadlinePolicyLabel(ctx);
  }
  if ((ctx.deadlineMode === 'absolute' || ctx.deadlineEnabled) && ctx.deadlineAt) {
    return `Hạn nộp: ${formatDateTime(ctx.deadlineAt)}.`;
  }
  return 'Bài tập này không có thời hạn nộp.';
}

function learnerDeadlineLabel(ctx: AssignmentCreatedEmailContext, enrolledAt?: string | Date | null): string {
  if (ctx.deadlineMode !== 'relative_to_enrollment' || !ctx.deadlineAfterDays) {
    return deadlineLabel(ctx);
  }

  const enrolledDate = enrolledAt ? new Date(enrolledAt) : null;
  if (!enrolledDate || Number.isNaN(enrolledDate.getTime())) {
    return `Hạn nộp sẽ được tính sau ${ctx.deadlineAfterDays} ngày kể từ khi bạn ghi danh khóa học.`;
  }

  const createdDate = ctx.assignmentCreatedAt ? new Date(ctx.assignmentCreatedAt) : null;
  const hasCreatedDate = Boolean(createdDate && !Number.isNaN(createdDate.getTime()));
  const baseDate = hasCreatedDate && createdDate && createdDate.getTime() > enrolledDate.getTime()
    ? createdDate
    : enrolledDate;
  const deadlineAt = new Date(baseDate.getTime() + ctx.deadlineAfterDays * 24 * 60 * 60 * 1000);
  const reason = hasCreatedDate && createdDate && baseDate.getTime() === createdDate.getTime()
    ? 'Bạn đã ghi danh trước khi bài tập được tạo, nên hạn nộp được tính từ thời điểm bài tập được tạo.'
    : `Hạn nộp được tính sau ${ctx.deadlineAfterDays} ngày kể từ lúc bạn ghi danh khóa học.`;
  return `Hạn nộp: ${formatDateTime(deadlineAt)}. ${reason}`;
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

function shellEmail(
  branding: EmailBranding,
  eyebrow: string,
  title: string,
  intro: string,
  body: string,
  learnerHref?: string | null,
): string {
  return `<!doctype html>
<html lang="vi">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="color-scheme" content="light">
    <meta name="x-apple-disable-message-reformatting">
    <style>
      html, body, table, tbody, tr, td, div, p, a, span, strong, h1, h2, h3 {
        font-family: ${EMAIL_FONT_FAMILY} !important;
      }
    </style>
    <title>${escapeHtml(title)}</title>
  </head>
  <body style="${EMAIL_FONT_STYLE}margin:0;padding:0;background:#edf2f7;color:#111827">
    ${hiddenPreheader(intro)}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="${EMAIL_FONT_STYLE}width:100%;background:#edf2f7;margin:0;padding:28px 12px">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="${EMAIL_FONT_STYLE}width:100%;max-width:680px;border-collapse:separate;border-spacing:0">
            <tr>
              <td style="${EMAIL_FONT_STYLE}padding:0 0 14px 0">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="${EMAIL_FONT_STYLE}font-size:18px;line-height:26px;font-weight:800;color:#0f172a">
                      ${escapeHtml(branding.brandName)}
                    </td>
                    <td align="right" style="${EMAIL_FONT_STYLE}font-size:12px;line-height:18px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.5px">
                      ${escapeHtml(eyebrow)}
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="${EMAIL_FONT_STYLE}background:#ffffff;border:1px solid #dbe3ef;border-radius:24px;box-shadow:0 18px 42px rgba(15,23,42,.12)">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="${EMAIL_FONT_STYLE}background:#111827;padding:26px 28px 28px;border-bottom:5px solid #10b981">
                      <div style="${EMAIL_FONT_STYLE}font-size:13px;line-height:20px;color:#a7f3d0;font-weight:800;text-transform:uppercase;letter-spacing:.6px">
                        ${escapeHtml(branding.tenantName)}
                      </div>
                      <h1 style="${EMAIL_FONT_STYLE}margin:10px 0 0;color:#ffffff;font-size:28px;line-height:36px;font-weight:800">
                        ${escapeHtml(title)}
                      </h1>
                      <p style="${EMAIL_FONT_STYLE}margin:12px 0 0;color:#dbeafe;font-size:15px;line-height:24px;font-weight:500">
                        ${escapeHtml(intro)}
                      </p>
                    </td>
                  </tr>
                  <tr>
                    <td style="${EMAIL_FONT_STYLE}padding:28px">
                      ${body}
                      ${learnerAccessBlock(branding, learnerHref)}
                      <div style="${EMAIL_FONT_STYLE}height:1px;background:#e5e7eb;margin:28px 0 16px"></div>
                      <p style="${EMAIL_FONT_STYLE}margin:0;color:#64748b;font-size:12px;line-height:20px">
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
  return `<span style="${EMAIL_FONT_STYLE}display:inline-block;border-radius:999px;background:${palette.bg};border:1px solid ${palette.bd};color:${palette.fg};font-size:12px;line-height:18px;font-weight:800;padding:6px 11px">${escapeHtml(label)}</span>`;
}

function infoTable(rows: Array<{ label: string; value: string }>): string {
  const renderedRows = rows.map(row => `
    <tr>
      <td style="${EMAIL_FONT_STYLE}padding:12px 0;border-bottom:1px solid #e5e7eb;width:36%;vertical-align:top;color:#64748b;font-size:13px;line-height:20px;font-weight:700">
        ${escapeHtml(row.label)}
      </td>
      <td style="${EMAIL_FONT_STYLE}padding:12px 0;border-bottom:1px solid #e5e7eb;vertical-align:top;color:#0f172a;font-size:14px;line-height:22px;font-weight:700">
        ${escapeHtml(row.value)}
      </td>
    </tr>
  `).join('');
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="${EMAIL_FONT_STYLE}margin-top:18px;border-collapse:collapse">
      ${renderedRows}
    </table>
  `;
}

function sectionTitle(value: string): string {
  return `<div style="${EMAIL_FONT_STYLE}margin-top:24px;color:#0f172a;font-size:14px;line-height:20px;font-weight:800;text-transform:uppercase;letter-spacing:.5px">${escapeHtml(value)}</div>`;
}

function quoteBlock(value: string): string {
  return `
    <div style="${EMAIL_FONT_STYLE}border:1px solid #dbe3ef;border-left:5px solid #2563eb;background:#f8fafc;border-radius:16px;padding:16px 18px;margin-top:10px;color:#1f2937;font-size:15px;line-height:24px">
      ${htmlLines(value)}
    </div>
  `;
}

function learnerAccessBlock(branding: EmailBranding, learnerHref?: string | null): string {
  if (!branding.learnerUrl || !branding.learnerDomainLabel) {
    return '';
  }
  const href = learnerHref || branding.learnerUrl;
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="${EMAIL_FONT_STYLE}margin-top:24px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:18px">
      <tr>
        <td style="${EMAIL_FONT_STYLE}padding:18px 20px">
          <div style="${EMAIL_FONT_STYLE}font-size:12px;line-height:18px;color:#047857;font-weight:800;text-transform:uppercase;letter-spacing:.5px">Cổng học viên</div>
          <div style="${EMAIL_FONT_STYLE}margin-top:6px;font-size:16px;line-height:24px;color:#064e3b;font-weight:800">${escapeHtml(branding.learnerDomainLabel)}</div>
          <div style="${EMAIL_FONT_STYLE}margin-top:14px">
            <a href="${escapeHtml(href)}" style="${EMAIL_FONT_STYLE}display:inline-block;background:#059669;color:#ffffff;text-decoration:none;border-radius:12px;padding:11px 16px;font-size:14px;line-height:18px;font-weight:800">
              Mở cổng học viên
            </a>
          </div>
        </td>
      </tr>
    </table>
  `;
}

function commonTemplateTokens(branding: EmailBranding): TemplateTokenMap {
  return {
    tenant_name: { text: branding.tenantName },
    brand_name: { text: branding.brandName },
    learner_domain: { text: branding.learnerDomainLabel || '' },
    learner_portal_url: { text: branding.learnerUrl || '' },
  };
}

function templateTokenHtml(tokens: TemplateTokenMap, key: string): string {
  const token = tokens[key];
  if (!token) return '';
  return token.html ?? htmlLines(token.text || '');
}

function systemDataRowsTable(rows: Array<{ label: string; value: string }>): string {
  if (rows.length === 0) return '';
  const renderedRows = rows.map(row => `
    <tr>
      <td style="${EMAIL_FONT_STYLE}padding:12px 0;border-bottom:1px solid #e5e7eb;width:38%;vertical-align:top;color:#64748b;font-size:13px;line-height:20px;font-weight:800">
        ${escapeHtml(row.label)}
      </td>
      <td style="${EMAIL_FONT_STYLE}padding:12px 0;border-bottom:1px solid #e5e7eb;vertical-align:top;color:#0f172a;font-size:14px;line-height:22px;font-weight:800">
        ${row.value}
      </td>
    </tr>
  `).join('');
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="${EMAIL_FONT_STYLE}margin-top:20px;border-collapse:collapse">
      ${renderedRows}
    </table>
  `;
}

function systemDataBlock(key: EmailTemplateKey, tokens: TemplateTokenMap, templateBody: string): string {
  if (key === 'course_notification') {
    return systemDataRowsTable([
      { label: 'Học viên', value: templateTokenHtml(tokens, 'learner_name') },
      { label: 'Khóa học', value: templateTokenHtml(tokens, 'course_name') },
      { label: 'Tiêu đề', value: templateTokenHtml(tokens, 'notification_title') },
      { label: 'Cổng học viên', value: templateTokenHtml(tokens, 'learner_domain') },
    ]);
  }

  if (key === 'assignment_created') {
    return systemDataRowsTable([
      { label: 'Học viên', value: templateTokenHtml(tokens, 'learner_name') },
      { label: 'Khóa học', value: templateTokenHtml(tokens, 'course_name') },
      { label: 'Bài tập', value: templateTokenHtml(tokens, 'assignment_title') },
      { label: 'Thời hạn', value: templateTokenHtml(tokens, 'deadline_text') },
      { label: 'Điều kiện nộp', value: templateTokenHtml(tokens, 'submission_unlock_text') },
      { label: 'Cổng học viên', value: templateTokenHtml(tokens, 'learner_domain') },
    ]);
  }

  if (key === 'assignment_feedback') {
    return systemDataRowsTable([
      { label: 'Học viên', value: `${templateTokenHtml(tokens, 'learner_name')} (${templateTokenHtml(tokens, 'learner_email')})` },
      { label: 'Khóa học', value: templateTokenHtml(tokens, 'course_name') },
      { label: 'Bài tập', value: templateTokenHtml(tokens, 'assignment_title') },
      { label: 'Người feedback', value: templateTokenHtml(tokens, 'feedback_by_name') },
      { label: 'Điểm/Trạng thái', value: templateTokenHtml(tokens, 'score_text') },
      { label: 'Cổng học viên', value: templateTokenHtml(tokens, 'learner_domain') },
    ]);
  }

  if (key === 'team_member_added') {
    const hasInlineCategoriesTable = /\{\{\s*course_categories_table\s*\}\}/.test(templateBody);
    return `
      ${systemDataRowsTable([
        { label: 'Học viên', value: templateTokenHtml(tokens, 'learner_name') },
        { label: tokens.group_label?.text || DEFAULT_GROUP_LABELS.group, value: templateTokenHtml(tokens, 'group_name') },
        { label: tokens.subgroup_label?.text || DEFAULT_GROUP_LABELS.subgroup, value: templateTokenHtml(tokens, 'subgroup_name') },
        { label: tokens.team_label?.text || DEFAULT_GROUP_LABELS.team, value: templateTokenHtml(tokens, 'team_name') },
        { label: 'Cổng học viên', value: templateTokenHtml(tokens, 'learner_domain') },
      ])}
      ${hasInlineCategoriesTable ? '' : templateTokenHtml(tokens, 'course_categories_table')}
    `;
  }

  return '';
}

async function buildCustomTemplateEmail(
  client: PoolClient,
  key: EmailTemplateKey,
  tenantId: string,
  branding: EmailBranding,
  meta: { eyebrow: string; fallbackTitle: string; fallbackIntro: string; learnerHref?: string | null },
  tokens: TemplateTokenMap,
): Promise<{ subject: string; text: string; html: string } | null> {
  const template = await getEmailTemplateForRender(tenantId, key, client);
  if (!template) return null;

  const mergedTokens = {
    ...commonTemplateTokens(branding),
    ...tokens,
  };
  const subject = renderTemplateToText(template.subject_template, mergedTokens).trim() || meta.fallbackTitle;
  const intro = renderTemplateToText(template.preheader_template, mergedTokens).trim() || meta.fallbackIntro;
  const bodyHtml = renderTemplateToHtml(template.body_template, mergedTokens);
  const systemHtml = systemDataBlock(key, mergedTokens, template.body_template);
  const bodyText = renderTemplateToText(template.body_template, mergedTokens).trim();
  const ctaText = meta.learnerHref ? `\n\nCổng học viên: ${meta.learnerHref}` : '';
  const text = [intro, bodyText].filter(Boolean).join('\n\n') + ctaText;
  const html = shellEmail(
    branding,
    meta.eyebrow,
    subject,
    intro,
    `<div style="${EMAIL_FONT_STYLE}margin:0;color:#334155;font-size:15px;line-height:24px">${bodyHtml}</div>${systemHtml}`,
    meta.learnerHref,
  );

  return {
    subject,
    text,
    html,
  };
}

function recipientList(summary: RecipientSummary): string {
  if (summary.totalCount <= 0) return '';
  const rows = summary.recipients.map((recipient, index) => `
    <tr>
      <td style="${EMAIL_FONT_STYLE}padding:10px 12px;border-bottom:1px solid #e5e7eb;color:#64748b;font-size:13px;line-height:20px;font-weight:800;width:44px">${index + 1}</td>
      <td style="${EMAIL_FONT_STYLE}padding:10px 12px;border-bottom:1px solid #e5e7eb;color:#0f172a;font-size:14px;line-height:21px;font-weight:700">${escapeHtml(recipient.name)}</td>
      <td style="${EMAIL_FONT_STYLE}padding:10px 12px;border-bottom:1px solid #e5e7eb;color:#475569;font-size:13px;line-height:21px">${escapeHtml(recipient.email)}</td>
    </tr>
  `).join('');
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="${EMAIL_FONT_STYLE}margin-top:12px;border:1px solid #e2e8f0;border-radius:16px;border-collapse:separate;border-spacing:0;background:#ffffff">
      <tr>
        <td style="${EMAIL_FONT_STYLE}padding:14px 16px;background:#f8fafc;border-bottom:1px solid #e5e7eb;border-radius:16px 16px 0 0;color:#0f172a;font-size:14px;line-height:22px;font-weight:800">
          Danh sách học viên nhận thông báo (${summary.totalCount})
        </td>
      </tr>
      <tr>
        <td style="${EMAIL_FONT_STYLE}padding:0">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="${EMAIL_FONT_STYLE}border-collapse:collapse">
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
  const reviewer = ctx.feedbackByEmail
    ? `${ctx.feedbackByName} (${ctx.feedbackByEmail})`
    : ctx.feedbackByName;
  const learnerAccess = branding.learnerDomainLabel
    ? `Cổng học viên: ${branding.learnerDomainLabel}`
    : '';
  const text = [
    `Xin chào ${ctx.learnerName},`,
    '',
    `Bài tập "${ctx.assignmentTitle}" trong khóa học "${ctx.courseName}" đã có phản hồi mới.`,
    `Người phản hồi: ${reviewer}`,
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
      <p style="${EMAIL_FONT_STYLE}margin:0;color:#334155;font-size:15px;line-height:24px">
        Bài tập <strong>${escapeHtml(ctx.assignmentTitle)}</strong> trong khóa học <strong>${escapeHtml(ctx.courseName)}</strong> đã được phản hồi.
      </p>
      <div style="${EMAIL_FONT_STYLE}margin-top:16px">${pill(score, ctx.score !== undefined && ctx.score !== null ? 'green' : 'blue')}</div>
      <div style="${EMAIL_FONT_STYLE}margin-top:12px;color:#334155;font-size:14px;line-height:22px">
        Người phản hồi: <strong>${escapeHtml(reviewer)}</strong>
      </div>
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

async function renderFeedbackEmail(client: PoolClient, ctx: FeedbackEmailContext, branding: EmailBranding) {
  const score = scoreLabel(ctx.score);
  const reviewer = ctx.feedbackByEmail
    ? `${ctx.feedbackByName} (${ctx.feedbackByEmail})`
    : ctx.feedbackByName;
  const custom = await buildCustomTemplateEmail(
    client,
    'assignment_feedback',
    ctx.tenantId,
    branding,
    {
      eyebrow: 'Phản hồi bài tập',
      fallbackTitle: 'Bài tập của bạn đã có phản hồi',
      fallbackIntro: `Xin chào ${ctx.learnerName}, quản trị viên đã gửi nhận xét mới cho bài tập của bạn.`,
      learnerHref: branding.learnerUrl,
    },
    {
      learner_name: { text: ctx.learnerName },
      learner_email: { text: ctx.learnerEmail },
      course_name: { text: ctx.courseName },
      assignment_title: { text: ctx.assignmentTitle },
      feedback_text: { text: ctx.feedbackText },
      feedback_by_name: { text: ctx.feedbackByName },
      feedback_by_email: { text: ctx.feedbackByEmail || '' },
      reviewer: { text: reviewer },
      score_text: { text: score },
    },
  );
  return custom || buildFeedbackEmail(ctx, branding);
}

function buildAssignmentCreatedEmail(ctx: AssignmentCreatedEmailContext, branding: EmailBranding, deadline = deadlineLabel(ctx)) {
  const subject = `Bài tập mới: ${ctx.assignmentTitle} - ${ctx.courseName}`;
  const unlock = unlockLabel(ctx.submissionUnlockMode);
  const learnerName = ctx.learnerName?.trim() || 'bạn';
  const learnerHref = buildLearnerCourseFocusUrl(branding, ctx.courseId);
  const learnerAccess = learnerHref
    ? `Cổng học viên: ${learnerHref}`
    : '';
  const text = [
    `Xin chào ${learnerName},`,
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
      <p style="${EMAIL_FONT_STYLE}margin:0 0 14px;color:#334155;font-size:15px;line-height:24px">
        Xin chào <strong>${escapeHtml(learnerName)}</strong>,
      </p>
      <p style="${EMAIL_FONT_STYLE}margin:0;color:#334155;font-size:15px;line-height:24px">
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
    learnerHref,
  );

  return { subject, text, html };
}

async function renderAssignmentCreatedEmail(
  client: PoolClient,
  ctx: AssignmentCreatedEmailContext,
  branding: EmailBranding,
  deadline = deadlineLabel(ctx),
) {
  const learnerHref = buildLearnerCourseFocusUrl(branding, ctx.courseId);
  const unlock = unlockLabel(ctx.submissionUnlockMode);
  const custom = await buildCustomTemplateEmail(
    client,
    'assignment_created',
    ctx.tenantId,
    branding,
    {
      eyebrow: 'Bài tập mới',
      fallbackTitle: 'Khóa học vừa có bài tập mới',
      fallbackIntro: `Một bài tập mới đã được thêm vào khóa học ${ctx.courseName}.`,
      learnerHref,
    },
    {
      learner_name: { text: ctx.learnerName?.trim() || 'bạn' },
      course_name: { text: ctx.courseName },
      assignment_title: { text: ctx.assignmentTitle },
      assignment_question: { text: ctx.assignmentQuestion },
      deadline_text: { text: deadline },
      submission_unlock_text: { text: unlock },
    },
  );
  return custom || buildAssignmentCreatedEmail(ctx, branding, deadline);
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
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="${EMAIL_FONT_STYLE}background:#f8fafc;border:1px solid #e2e8f0;border-radius:18px">
        <tr>
          <td style="${EMAIL_FONT_STYLE}padding:20px">
            <div style="${EMAIL_FONT_STYLE}font-size:36px;line-height:42px;color:#0f172a;font-weight:800">${summary.totalCount}</div>
            <div style="${EMAIL_FONT_STYLE}margin-top:4px;color:#475569;font-size:14px;line-height:22px;font-weight:700">học viên nhận thông báo bài tập mới</div>
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

function buildCourseNotificationEmail(ctx: CourseNotificationEmailContext, branding: EmailBranding) {
  const subject = `${ctx.title} - ${ctx.courseName}`;
  const learnerHref = buildLearnerCourseFocusUrl(branding, ctx.courseId, 'course_notification_email');
  const learnerAccess = learnerHref
    ? `Cổng học viên: ${learnerHref}`
    : '';
  const text = [
    `Xin chào ${ctx.learnerName},`,
    '',
    `Khóa học "${ctx.courseName}" vừa có thông báo mới.`,
    '',
    `Tiêu đề: ${ctx.title}`,
    '',
    'Nội dung thông báo:',
    ctx.message,
    '',
    learnerAccess,
    '',
    'Vui lòng đăng nhập hệ thống để xem chi tiết.',
  ].filter(Boolean).join('\n');

  const html = shellEmail(
    branding,
    'Thông báo khóa học',
    ctx.title,
    `Khóa học ${ctx.courseName} vừa có thông báo mới dành cho bạn.`,
    `
      <p style="${EMAIL_FONT_STYLE}margin:0 0 14px;color:#334155;font-size:15px;line-height:24px">
        Xin chào <strong>${escapeHtml(ctx.learnerName)}</strong>,
      </p>
      <p style="${EMAIL_FONT_STYLE}margin:0;color:#334155;font-size:15px;line-height:24px">
        Khóa học <strong>${escapeHtml(ctx.courseName)}</strong> vừa có thông báo mới.
      </p>
      ${infoTable([
        { label: 'Khóa học', value: ctx.courseName },
        { label: 'Tiêu đề', value: ctx.title },
      ])}
      ${sectionTitle('Nội dung thông báo')}
      ${quoteBlock(ctx.message)}
    `,
    learnerHref,
  );

  return { subject, text, html };
}

async function renderCourseNotificationEmail(
  client: PoolClient,
  ctx: CourseNotificationEmailContext,
  branding: EmailBranding,
) {
  const learnerHref = buildLearnerCourseFocusUrl(branding, ctx.courseId, 'course_notification_email');
  const custom = await buildCustomTemplateEmail(
    client,
    'course_notification',
    ctx.tenantId,
    branding,
    {
      eyebrow: 'Thông báo khóa học',
      fallbackTitle: ctx.title,
      fallbackIntro: `Khóa học ${ctx.courseName} vừa có thông báo mới dành cho bạn.`,
      learnerHref,
    },
    {
      course_name: { text: ctx.courseName },
      learner_name: { text: ctx.learnerName },
      notification_title: { text: ctx.title },
      notification_message: { text: ctx.message },
    },
  );
  return custom || buildCourseNotificationEmail(ctx, branding);
}

function courseCategorySummaryText(categories: TeamMemberAddedCourseCategory[], teamLabel: string): string {
  if (categories.length === 0) {
    return `${teamLabel} này chưa được phân danh mục khóa học.`;
  }
  return categories
    .map(category => `- ${category.name}: ${category.courseCount} khóa học`)
    .join('\n');
}

function courseCategorySummaryTable(categories: TeamMemberAddedCourseCategory[]): string {
  if (categories.length === 0) {
    return quoteBlock('Nhóm này chưa được phân danh mục khóa học.');
  }

  const rows = categories.map((category, index) => `
    <tr>
      <td style="${EMAIL_FONT_STYLE}padding:12px 14px;border-bottom:1px solid #e5e7eb;color:#64748b;font-size:13px;line-height:20px;font-weight:800;width:44px">
        ${index + 1}
      </td>
      <td style="${EMAIL_FONT_STYLE}padding:12px 14px;border-bottom:1px solid #e5e7eb;color:#0f172a;font-size:14px;line-height:22px;font-weight:800">
        ${escapeHtml(category.name)}
      </td>
      <td align="right" style="${EMAIL_FONT_STYLE}padding:12px 14px;border-bottom:1px solid #e5e7eb;color:#047857;font-size:14px;line-height:22px;font-weight:800;white-space:nowrap">
        ${category.courseCount} khóa học
      </td>
    </tr>
  `).join('');

  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="${EMAIL_FONT_STYLE}margin-top:12px;border:1px solid #dbe3ef;border-radius:16px;border-collapse:separate;border-spacing:0;background:#ffffff;overflow:hidden">
      <tr>
        <td colspan="3" style="${EMAIL_FONT_STYLE}padding:14px 16px;background:#f8fafc;border-bottom:1px solid #e5e7eb;color:#0f172a;font-size:14px;line-height:22px;font-weight:900">
          Danh mục khóa học được phân
        </td>
      </tr>
      ${rows}
    </table>
  `;
}

function buildTeamMemberAddedEmail(ctx: TeamMemberAddedEmailContext, branding: EmailBranding) {
  const labels = getGroupLabelSet(ctx.groupLabels);
  const groupLabel = labels.group;
  const subgroupLabel = labels.subgroup;
  const teamLabel = labels.team;
  const teamLabelLower = lowerGroupLabel(teamLabel);
  const subgroupLabelLower = lowerGroupLabel(subgroupLabel);
  const groupLabelLower = lowerGroupLabel(groupLabel);
  const learnerName = ctx.learnerName?.trim() || 'bạn';
  const subject = `Bạn đã được thêm vào ${teamLabelLower} ${ctx.teamName}`;
  const learnerAccess = branding.learnerDomainLabel
    ? `Cổng học viên: ${branding.learnerDomainLabel}`
    : '';
  const text = [
    `Xin chào ${learnerName},`,
    '',
    `Bạn vừa được thêm vào ${teamLabelLower} "${ctx.teamName}" thuộc ${subgroupLabelLower} "${ctx.subGroupName}" - ${groupLabelLower} "${ctx.orgGroupName}".`,
    '',
    'Danh mục khóa học được phân:',
    courseCategorySummaryText(ctx.courseCategories, teamLabel),
    '',
    learnerAccess,
    '',
    'Vui lòng đăng nhập hệ thống để xem các khóa học được phân cho bạn.',
  ].filter(Boolean).join('\n');

  const html = shellEmail(
    branding,
    teamLabel,
    `Bạn đã được thêm vào ${teamLabelLower}`,
    `Bạn vừa được thêm vào ${teamLabelLower} ${ctx.teamName}. Các khóa học sẽ hiển thị theo danh mục được phân cho ${teamLabelLower} này.`,
    `
      <p style="${EMAIL_FONT_STYLE}margin:0 0 14px;color:#334155;font-size:15px;line-height:24px">
        Xin chào <strong>${escapeHtml(learnerName)}</strong>,
      </p>
      <p style="${EMAIL_FONT_STYLE}margin:0;color:#334155;font-size:15px;line-height:24px">
        Bạn vừa được thêm vào ${escapeHtml(teamLabelLower)} <strong>${escapeHtml(ctx.teamName)}</strong>. Hãy đăng nhập cổng học viên để xem các khóa học được phân cho ${escapeHtml(teamLabelLower)} của bạn.
      </p>
      <div style="${EMAIL_FONT_STYLE}margin-top:16px">
        ${pill(`${ctx.courseCategories.length} danh mục khóa học`, ctx.courseCategories.length > 0 ? 'green' : 'slate')}
      </div>
      ${infoTable([
        { label: groupLabel, value: ctx.orgGroupName },
        { label: subgroupLabel, value: ctx.subGroupName },
        { label: teamLabel, value: ctx.teamName },
      ])}
      ${sectionTitle('Danh mục khóa học')}
      ${courseCategorySummaryTable(ctx.courseCategories)}
    `,
    branding.learnerUrl,
  );

  return { subject, text, html };
}

async function renderTeamMemberAddedEmail(
  client: PoolClient,
  ctx: TeamMemberAddedEmailContext,
  branding: EmailBranding,
) {
  const labels = getGroupLabelSet(ctx.groupLabels);
  const groupLabel = labels.group;
  const subgroupLabel = labels.subgroup;
  const teamLabel = labels.team;
  const teamLabelLower = lowerGroupLabel(teamLabel);
  const subgroupLabelLower = lowerGroupLabel(subgroupLabel);
  const groupLabelLower = lowerGroupLabel(groupLabel);
  const custom = await buildCustomTemplateEmail(
    client,
    'team_member_added',
    ctx.tenantId,
    branding,
    {
      eyebrow: teamLabel,
      fallbackTitle: `Bạn đã được thêm vào ${teamLabelLower}`,
      fallbackIntro: `Bạn vừa được thêm vào ${teamLabelLower} ${ctx.teamName}.`,
      learnerHref: branding.learnerUrl,
    },
    {
      learner_name: { text: ctx.learnerName?.trim() || 'bạn' },
      group_label: { text: groupLabel },
      subgroup_label: { text: subgroupLabel },
      team_label: { text: teamLabel },
      group_label_lower: { text: groupLabelLower },
      subgroup_label_lower: { text: subgroupLabelLower },
      team_label_lower: { text: teamLabelLower },
      group_name: { text: ctx.orgGroupName },
      subgroup_name: { text: ctx.subGroupName },
      team_name: { text: ctx.teamName },
      course_categories_text: { text: courseCategorySummaryText(ctx.courseCategories, teamLabel) },
      course_categories_table: {
        text: courseCategorySummaryText(ctx.courseCategories, teamLabel),
        html: courseCategorySummaryTable(ctx.courseCategories),
      },
    },
  );
  return custom || buildTeamMemberAddedEmail(ctx, branding);
}

function ownerFeedbackItemHtml(ctx: FeedbackEmailContext): string {
  const learner = `${ctx.learnerName} (${ctx.learnerEmail})`;
  const reviewer = ctx.feedbackByEmail
    ? `${ctx.feedbackByName} (${ctx.feedbackByEmail})`
    : ctx.feedbackByName;
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="${EMAIL_FONT_STYLE}margin-top:14px;border:1px solid #e2e8f0;border-radius:16px;background:#ffffff">
      <tr>
        <td style="${EMAIL_FONT_STYLE}padding:16px 18px">
          <div style="${EMAIL_FONT_STYLE}color:#0f172a;font-size:15px;line-height:22px;font-weight:800">${escapeHtml(ctx.assignmentTitle)}</div>
          <div style="${EMAIL_FONT_STYLE}margin-top:4px;color:#64748b;font-size:13px;line-height:20px">${escapeHtml(ctx.courseName)}</div>
          <div style="${EMAIL_FONT_STYLE}margin-top:10px">${pill(scoreLabel(ctx.score), ctx.score !== undefined && ctx.score !== null ? 'green' : 'blue')}</div>
          <div style="${EMAIL_FONT_STYLE}margin-top:10px;color:#334155;font-size:13px;line-height:20px">Người phản hồi: <strong>${escapeHtml(reviewer)}</strong></div>
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
  const reviewer = ctx.feedbackByEmail
    ? `${ctx.feedbackByName} <${ctx.feedbackByEmail}>`
    : ctx.feedbackByName;
  return [
    `Người phản hồi: ${reviewer}`,
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
      <p style="${EMAIL_FONT_STYLE}margin:0;color:#334155;font-size:15px;line-height:24px">
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
    relatedNotificationId?: string | null;
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
}

async function insertAssignmentCreatedOutboxBatch(
  client: PoolClient,
  input: {
    tenantId: string;
    recipients: AssignmentCreatedEmailRecipient[];
    emails: Array<{ subject: string; html: string; text: string }>;
  },
): Promise<number> {
  if (input.recipients.length === 0) return 0;
  await client.query(
    `INSERT INTO email_outbox (
       tenant_id, related_submission_id, recipient_user_id, recipient_email, recipient_name,
       subject, html_body, text_body
     )
     SELECT $1::uuid, NULL::uuid, x.user_id, x.email, x.name, LEFT(x.subject, 255), x.html_body, x.text_body
     FROM unnest($2::uuid[], $3::varchar[], $4::varchar[], $5::text[], $6::text[], $7::text[]) AS x(user_id, email, name, subject, html_body, text_body)`,
    [
      input.tenantId,
      input.recipients.map(recipient => recipient.userId),
      input.recipients.map(recipient => recipient.email),
      input.recipients.map(recipient => recipient.name),
      input.emails.map(email => email.subject),
      input.emails.map(email => email.html),
      input.emails.map(email => email.text),
    ],
  );
  return input.recipients.length;
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
  const { subject, text, html } = await renderFeedbackEmail(client, ctx, branding);
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
  const recipientResult = await client.query<{
    user_id: string;
    email: string;
    name: string;
    enrolled_at: string | Date | null;
  }>(
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
    [ctx.notificationId, ctx.courseId, ctx.tenantId],
  );

  const recipients: AssignmentCreatedEmailRecipient[] = recipientResult.rows.map(row => ({
    userId: row.user_id,
    email: row.email,
    name: row.name,
    enrolledAt: row.enrolled_at,
  }));

  const renderedEmails: Array<{ subject: string; text: string; html: string }> = [];
  for (const recipient of recipients) {
    const deadline = learnerDeadlineLabel(ctx, recipient.enrolledAt);
    renderedEmails.push(await renderAssignmentCreatedEmail(client, {
      ...ctx,
      learnerName: recipient.name,
    }, branding, deadline));
  }

  const insertedCount = await insertAssignmentCreatedOutboxBatch(client, {
    tenantId: ctx.tenantId,
    recipients,
    emails: renderedEmails,
  });

  const totalCount = insertedCount;
  const summary: RecipientSummary = {
    totalCount,
    recipients: normalizeRecipients(recipients),
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

export async function enqueueTeamMemberAddedEmails(
  client: PoolClient,
  ctx: TeamMemberAddedEmailContext,
): Promise<number> {
  const smtp = await client.query(
    `SELECT 1
     FROM tenant_smtp_configs
     WHERE tenant_id = $1::uuid
       AND is_enabled = true
     LIMIT 1`,
    [ctx.tenantId],
  );

  if (smtp.rowCount === 0) return 0;

  const recipients = await client.query<{
    user_id: string;
    email: string;
    name: string;
  }>(
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
    [ctx.notificationId, ctx.tenantId],
  );

  if (recipients.rowCount === 0) return 0;

  const branding = await getEmailBranding(ctx.tenantId, client);
  const renderedEmails: Array<{ subject: string; html: string; text: string }> = [];
  for (const recipient of recipients.rows) {
    renderedEmails.push(await renderTeamMemberAddedEmail(client, {
      ...ctx,
      learnerName: recipient.name,
    }, branding));
  }
  const insertResult = await client.query(
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
      ctx.tenantId,
      ctx.notificationId,
      recipients.rows.map(recipient => recipient.user_id),
      recipients.rows.map(recipient => recipient.email),
      recipients.rows.map(recipient => recipient.name),
      renderedEmails.map(email => email.subject),
      renderedEmails.map(email => email.html),
      renderedEmails.map(email => email.text),
    ],
  );

  return insertResult.rowCount || 0;
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

export async function enqueueCourseNotificationEmailJob(
  client: PoolClient,
  ctx: Pick<CourseNotificationEmailContext, 'tenantId' | 'notificationId' | 'courseId'>,
): Promise<number> {
  const result = await client.query(
    `INSERT INTO notification_email_jobs (tenant_id, notification_id, course_id, status, next_attempt_at)
     VALUES ($1::uuid, $2::uuid, $3::varchar, 'pending', now())
     ON CONFLICT (notification_id) DO NOTHING`,
    [ctx.tenantId, ctx.notificationId, ctx.courseId],
  );
  return result.rowCount || 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readText(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function readBoolean(value: unknown): boolean {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readDeadlineMode(value: unknown): DeadlineMode | undefined {
  return value === 'absolute' || value === 'relative_to_enrollment' || value === 'none'
    ? value
    : undefined;
}

function readSubmissionUnlockMode(value: unknown): SubmissionUnlockMode | undefined {
  return value === 'after_content_complete' || value === 'anytime'
    ? value
    : undefined;
}

function buildAssignmentContextFromNotification(
  tenantId: string,
  notificationId: string,
  courseId: string,
  courseName: string,
  metadata: Record<string, unknown>,
  learnerName?: string,
): AssignmentCreatedEmailContext {
  return {
    tenantId,
    notificationId,
    courseId,
    courseName,
    learnerName,
    assignmentTitle: readText(metadata.assignment_title, 'Bài tập mới'),
    assignmentQuestion: readText(metadata.assignment_question, ''),
    deadlineEnabled: readBoolean(metadata.deadline_enabled),
    deadlineAt: metadata.deadline_at as string | Date | null | undefined,
    deadlineMode: readDeadlineMode(metadata.deadline_mode),
    deadlineAfterDays: readNumber(metadata.deadline_after_days),
    assignmentCreatedAt: metadata.created_at as string | Date | null | undefined,
    submissionUnlockMode: readSubmissionUnlockMode(metadata.submission_unlock_mode),
  };
}

async function enqueueAssignmentCreatedOwnerCopyForFanoutJob(
  client: PoolClient,
  ctx: AssignmentCreatedEmailContext,
  branding: EmailBranding,
  totalCount: number,
  recipients: Array<{ name: string; email: string }>,
): Promise<void> {
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

  const row = smtp.rows[0];
  if (!row?.copy_to_sender || totalCount <= 0) return;

  const copyEmail = (row.copy_to_email || row.username || '').trim();
  if (!copyEmail) return;

  const summary: RecipientSummary = {
    totalCount,
    recipients: normalizeRecipients(recipients).slice(0, 50),
  };
  const ownerEmail = buildAssignmentCreatedOwnerEmail(ctx, branding, summary);
  await client.query(
    `INSERT INTO email_outbox (
       tenant_id, related_submission_id, related_notification_id, recipient_user_id,
       recipient_email, recipient_name, subject, html_body, text_body
     )
     VALUES (
       $1::uuid, NULL::uuid, $2::uuid, NULL::uuid,
       $3::varchar, $4::varchar, LEFT($5::text, 255), $6::text, $7::text
     )
     ON CONFLICT DO NOTHING`,
    [
      ctx.tenantId,
      ctx.notificationId,
      copyEmail,
      'Owner doanh nghiệp',
      ownerEmail.subject,
      ownerEmail.html,
      ownerEmail.text,
    ],
  );
}

async function processCourseNotificationEmailFanoutJob(jobId: string, batchSize: number): Promise<number> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const job = await client.query<{
      id: string;
      tenant_id: string;
      notification_id: string;
      course_id: string;
      last_user_id: string | null;
      attempts: number;
    }>(
      `SELECT id, tenant_id, notification_id, course_id, last_user_id, attempts
       FROM notification_email_jobs
       WHERE id = $1::uuid
       FOR UPDATE`,
      [jobId],
    );

    const row = job.rows[0];
    if (!row) {
      await client.query('COMMIT');
      return 0;
    }

    const notification = await client.query<{
      type: string;
      title: string;
      message: string | null;
      metadata: Record<string, unknown> | null;
      course_name: string;
      recipient_count: number;
    }>(
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
      [row.notification_id, row.tenant_id],
    );

    const notificationRow = notification.rows[0];
    if (!notificationRow) {
      await client.query(
        `UPDATE notification_email_jobs
         SET status = 'failed',
             attempts = attempts + 1,
             last_error = 'Notification not found',
             next_attempt_at = now() + interval '15 minutes',
             updated_at = now()
         WHERE id = $1::uuid`,
        [row.id],
      );
      await client.query('COMMIT');
      return 0;
    }

    const recipients = await client.query<{
      user_id: string;
      email: string;
      name: string;
      enrolled_at: string | Date | null;
    }>(
      `SELECT nr.user_id,
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
          AND ($2::uuid IS NULL OR nr.user_id > $2::uuid)
          AND u.email IS NOT NULL
         AND BTRIM(u.email) <> ''
       ORDER BY nr.user_id ASC
       LIMIT $5::int`,
      [row.notification_id, row.last_user_id, row.course_id, row.tenant_id, batchSize],
    );

    if (recipients.rowCount === 0) {
      await client.query(
        `UPDATE notification_email_jobs
         SET status = 'done',
             last_error = NULL,
             updated_at = now()
         WHERE id = $1::uuid`,
        [row.id],
      );
      await client.query('COMMIT');
      return 0;
    }

    const branding = await getEmailBranding(row.tenant_id, client);
    const notificationMetadata = asRecord(notificationRow.metadata);
    const isAssignmentCreated = notificationRow.type === 'assignment_created';
    const assignmentBaseContext = isAssignmentCreated
      ? buildAssignmentContextFromNotification(
          row.tenant_id,
          row.notification_id,
          row.course_id,
          notificationRow.course_name,
          notificationMetadata,
        )
      : null;
    const renderedEmails: Array<{ subject: string; html: string; text: string }> = [];
    for (const recipient of recipients.rows) {
      if (assignmentBaseContext) {
        const ctx = {
          ...assignmentBaseContext,
          learnerName: recipient.name,
        };
        renderedEmails.push(await renderAssignmentCreatedEmail(
          client,
          ctx,
          branding,
          learnerDeadlineLabel(ctx, recipient.enrolled_at),
        ));
      } else {
        renderedEmails.push(await renderCourseNotificationEmail(client, {
          tenantId: row.tenant_id,
          notificationId: row.notification_id,
          courseId: row.course_id,
          courseName: notificationRow.course_name,
          learnerName: recipient.name,
          title: notificationRow.title,
          message: notificationRow.message || '',
        }, branding));
      }
    }

    if (assignmentBaseContext && !row.last_user_id) {
      await enqueueAssignmentCreatedOwnerCopyForFanoutJob(
        client,
        assignmentBaseContext,
        branding,
        notificationRow.recipient_count,
        recipients.rows,
      );
    }

    const insertResult = await client.query(
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
        row.tenant_id,
        row.notification_id,
        recipients.rows.map(recipient => recipient.user_id),
        recipients.rows.map(recipient => recipient.email),
        recipients.rows.map(recipient => recipient.name),
        renderedEmails.map(email => email.subject),
        renderedEmails.map(email => email.html),
        renderedEmails.map(email => email.text),
      ],
    );

    const lastUserId = recipients.rows[recipients.rows.length - 1].user_id;
    const isDone = recipients.rows.length < batchSize;
    await client.query(
      `UPDATE notification_email_jobs
       SET status = $2,
           last_user_id = $3::uuid,
           queued_count = queued_count + $4::int,
           last_error = NULL,
           next_attempt_at = now(),
           updated_at = now()
       WHERE id = $1::uuid`,
      [row.id, isDone ? 'done' : 'pending', lastUserId, insertResult.rowCount || 0],
    );

    await client.query('COMMIT');
    return insertResult.rowCount || 0;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    const message = err instanceof Error ? err.message : String(err);
    await query(
      `UPDATE notification_email_jobs
       SET status = 'failed',
           attempts = attempts + 1,
           last_error = $2::text,
           next_attempt_at = now() + interval '5 minutes',
           updated_at = now()
       WHERE id = $1::uuid`,
      [jobId, message.slice(0, 2000)],
    ).catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function processCourseNotificationEmailFanoutBatch(
  tenantId?: string,
  jobsLimit = 2,
  batchSize = 1000,
): Promise<number> {
  const client = await getClient();
  try {
    const params: unknown[] = [jobsLimit];
    let tenantFilter = '';
    if (tenantId) {
      params.push(tenantId);
      tenantFilter = `AND tenant_id = $${params.length}::uuid`;
    }

    const dueJobs = await client.query<{ id: string }>(
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

    const jobs = dueJobs.rows.map(job => job.id);
    const remaining = jobsLimit - jobs.length;
    if (remaining > 0) {
      const staleParams: unknown[] = [remaining];
      let staleTenantFilter = '';
      if (tenantId) {
        staleParams.push(tenantId);
        staleTenantFilter = `AND tenant_id = $${staleParams.length}::uuid`;
      }
      const staleJobs = await client.query<{ id: string }>(
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
      jobs.push(...staleJobs.rows.map(job => job.id));
    }

    if (jobs.length === 0) return 0;

    let queued = 0;
    for (const jobId of jobs) {
      queued += await processCourseNotificationEmailFanoutJob(jobId, batchSize);
    }
    return queued;
  } catch (err) {
    throw err;
  } finally {
    client.release();
  }
}

interface ClaimedEmailOutboxJob {
  id: string;
  tenant_id: string;
  status: string;
  previous_status: string;
  recipient_email: string;
  subject: string;
  html_body: string;
  text_body: string;
  attempts: number;
  max_attempts: number;
}

async function claimEmailOutboxJobs(tenantId: string | undefined, limit: number): Promise<ClaimedEmailOutboxJob[]> {
  const client = await getClient();
  try {
    const params: unknown[] = [limit];
    let tenantFilter = '';
    if (tenantId) {
      params.push(tenantId);
      tenantFilter = `AND tenant_id = $${params.length}::uuid`;
    }

    const runnable = await client.query<ClaimedEmailOutboxJob>(
      `WITH picked AS (
         SELECT id, status AS previous_status
         FROM email_outbox
         WHERE status IN ('pending', 'failed')
           AND next_attempt_at <= now()
           AND (status = 'pending' OR attempts < max_attempts)
           ${tenantFilter}
         ORDER BY next_attempt_at ASC, created_at ASC
         LIMIT $1::int
         FOR UPDATE SKIP LOCKED
       )
       UPDATE email_outbox eo
       SET status = 'sending',
           updated_at = now()
       FROM picked
       WHERE eo.id = picked.id
       RETURNING eo.id, eo.tenant_id, eo.status, picked.previous_status,
                 eo.recipient_email, eo.subject, eo.html_body, eo.text_body,
                 eo.attempts, eo.max_attempts`,
      params,
    );

    const jobs = [...runnable.rows];
    const remaining = limit - jobs.length;
    if (remaining <= 0) return jobs;

    const staleParams: unknown[] = [remaining, EMAIL_OUTBOX_STALE_SENDING_MINUTES];
    let staleTenantFilter = '';
    if (tenantId) {
      staleParams.push(tenantId);
      staleTenantFilter = `AND tenant_id = $${staleParams.length}::uuid`;
    }

    const stale = await client.query<ClaimedEmailOutboxJob>(
      `WITH picked AS (
         SELECT id, status AS previous_status
         FROM email_outbox
         WHERE status = 'sending'
           AND updated_at < now() - (($2::int || ' minutes')::interval)
           ${staleTenantFilter}
         ORDER BY updated_at ASC, created_at ASC
         LIMIT $1::int
         FOR UPDATE SKIP LOCKED
       )
       UPDATE email_outbox eo
       SET status = 'sending',
           updated_at = now()
       FROM picked
       WHERE eo.id = picked.id
       RETURNING eo.id, eo.tenant_id, eo.status, picked.previous_status,
                 eo.recipient_email, eo.subject, eo.html_body, eo.text_body,
                 eo.attempts, eo.max_attempts`,
      staleParams,
    );
    if (stale.rowCount) {
      console.warn(`[EmailOutbox] Reclaiming ${stale.rowCount} stale sending job(s)`);
      jobs.push(...stale.rows);
    }
    return jobs;
  } catch (err) {
    throw err;
  } finally {
    client.release();
  }
}

interface EmailOutboxBatchStats {
  claimed: number;
  reclaimed: number;
  sent: number;
  retried: number;
  failed: number;
  errors: number;
  cooldownSkipped: number;
  circuitOpened: number;
}

function createEmailOutboxBatchStats(): EmailOutboxBatchStats {
  return {
    claimed: 0,
    reclaimed: 0,
    sent: 0,
    retried: 0,
    failed: 0,
    errors: 0,
    cooldownSkipped: 0,
    circuitOpened: 0,
  };
}

function mergeEmailOutboxBatchStats(target: EmailOutboxBatchStats, source: EmailOutboxBatchStats): void {
  target.claimed += source.claimed;
  target.reclaimed += source.reclaimed;
  target.sent += source.sent;
  target.retried += source.retried;
  target.failed += source.failed;
  target.errors += source.errors;
  target.cooldownSkipped += source.cooldownSkipped;
  target.circuitOpened += source.circuitOpened;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

interface TenantSmtpCircuitState {
  failures: number;
  cooldownUntil: number;
  cooldownMs: number;
  lastError: string;
}

const tenantSmtpCircuits = new Map<string, TenantSmtpCircuitState>();

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTenantSmtpInfrastructureError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return [
    'timeout',
    'connection',
    'socket',
    'auth',
    'starttls',
    'certificate',
    'econnrefused',
    'econnreset',
    'enotfound',
    'etimedout',
    'smtp config',
  ].some(token => message.includes(token));
}

function getTenantCircuitCooldownUntil(tenantId: string): number {
  const state = tenantSmtpCircuits.get(tenantId);
  if (!state) return 0;
  if (state.cooldownUntil <= Date.now()) return 0;
  return state.cooldownUntil;
}

function markTenantSmtpSuccess(tenantId: string): void {
  const state = tenantSmtpCircuits.get(tenantId);
  if (!state) return;
  tenantSmtpCircuits.delete(tenantId);
  console.log(`[EmailOutbox] SMTP circuit recovered tenant=${tenantId}`);
}

function markTenantSmtpFailure(tenantId: string, error: unknown, stats: EmailOutboxBatchStats): void {
  if (!isTenantSmtpInfrastructureError(error)) return;

  const now = Date.now();
  const current = tenantSmtpCircuits.get(tenantId);
  const failures = (current?.failures || 0) + 1;
  const previousCooldownMs = current?.cooldownMs || EMAIL_OUTBOX_TENANT_COOLDOWN_MS;
  const shouldOpen = failures >= EMAIL_OUTBOX_TENANT_FAILURE_THRESHOLD;
  const cooldownMs = shouldOpen
    ? Math.min(
        current?.cooldownUntil && current.cooldownUntil > now
          ? previousCooldownMs * 2
          : previousCooldownMs,
        EMAIL_OUTBOX_TENANT_MAX_COOLDOWN_MS,
      )
    : previousCooldownMs;
  const cooldownUntil = shouldOpen ? now + cooldownMs : 0;

  tenantSmtpCircuits.set(tenantId, {
    failures,
    cooldownUntil,
    cooldownMs,
    lastError: getErrorMessage(error).slice(0, 300),
  });

  if (shouldOpen) {
    stats.circuitOpened += 1;
    console.warn(
      `[EmailOutbox] SMTP circuit open tenant=${tenantId} failures=${failures} cooldown_ms=${cooldownMs} error=${getErrorMessage(error).slice(0, 200)}`,
    );
  }
}

async function queryOutboxStatusWithRetry(sql: string, params: unknown[], label: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await query(sql, params);
      return;
    } catch (err) {
      lastError = err;
      if (attempt < 3) await sleep(200 * attempt);
    }
  }

  throw new Error(`${label} failed after retries: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function markEmailOutboxJobSent(job: ClaimedEmailOutboxJob, stats: EmailOutboxBatchStats): Promise<void> {
  await queryOutboxStatusWithRetry(
    `UPDATE email_outbox
     SET status = 'sent',
         sent_at = now(),
         last_error = NULL,
         updated_at = now()
     WHERE id = $1`,
    [job.id],
    'mark email outbox sent',
  );
  stats.sent += 1;
}

async function markEmailOutboxJobRetry(
  job: ClaimedEmailOutboxJob,
  error: unknown,
  stats: EmailOutboxBatchStats,
): Promise<void> {
  const message = getErrorMessage(error);
  const nextAttempts = job.attempts + 1;
  const nextStatus = nextAttempts >= job.max_attempts ? 'failed' : 'pending';
  await queryOutboxStatusWithRetry(
    `UPDATE email_outbox
     SET status = $2,
         attempts = attempts + 1,
         last_error = $3,
         next_attempt_at = now() + ((($4::int * $4::int) || ' minutes')::interval),
         updated_at = now()
     WHERE id = $1`,
    [job.id, nextStatus, message.slice(0, 2000), nextAttempts],
    'mark email outbox retry',
  );
  if (nextStatus === 'failed') {
    stats.failed += 1;
  } else {
    stats.retried += 1;
  }
}

async function releaseEmailOutboxJobForCooldown(
  job: ClaimedEmailOutboxJob,
  cooldownUntil: number,
  reason: string,
  stats: EmailOutboxBatchStats,
): Promise<void> {
  await queryOutboxStatusWithRetry(
    `UPDATE email_outbox
     SET status = 'pending',
         last_error = $2,
         next_attempt_at = to_timestamp($3::double precision / 1000.0),
         updated_at = now()
     WHERE id = $1`,
    [job.id, reason.slice(0, 2000), cooldownUntil],
    'release email outbox cooldown',
  );
  stats.cooldownSkipped += 1;
}

function toSmtpBatchMail(job: ClaimedEmailOutboxJob): SmtpBatchMail {
  return {
    id: job.id,
    to: job.recipient_email,
    subject: job.subject,
    html: cleanEmailBody(job.html_body),
    text: cleanEmailBody(job.text_body),
  };
}

async function getTenantSmtpConfigOrThrow(tenantId: string): Promise<SmtpConfig> {
  const smtp = await getTenantSmtpConfigForSend(tenantId);
  if (!smtp || !smtp.password_ciphertext || !smtp.password_iv || !smtp.password_auth_tag) {
    throw new Error('SMTP config is disabled or missing password');
  }

  const password = decryptSecret({
    ciphertext: smtp.password_ciphertext,
    iv: smtp.password_iv,
    authTag: smtp.password_auth_tag,
  });

  return {
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    username: smtp.username,
    password,
    fromEmail: smtp.from_email,
    fromName: smtp.from_name,
    replyToEmail: smtp.reply_to_email,
  };
}

async function sendClaimedEmailOutboxTenantGroup(
  jobs: ClaimedEmailOutboxJob[],
  stats: EmailOutboxBatchStats,
): Promise<void> {
  if (jobs.length === 0) return;
  const tenantId = jobs[0].tenant_id;
  const cooldownUntil = getTenantCircuitCooldownUntil(tenantId);
  if (cooldownUntil > Date.now()) {
    const waitMs = cooldownUntil - Date.now();
    const reason = `SMTP tenant is cooling down; retry in ${Math.ceil(waitMs / 1000)}s`;
    await Promise.all(jobs.map(job => releaseEmailOutboxJobForCooldown(job, cooldownUntil, reason, stats)));
    return;
  }

  let smtpConfig: SmtpConfig;
  try {
    smtpConfig = await getTenantSmtpConfigOrThrow(tenantId);
  } catch (err) {
    markTenantSmtpFailure(tenantId, err, stats);
    for (const job of jobs) await markEmailOutboxJobRetry(job, err, stats);
    return;
  }

  const jobMap = new Map(jobs.map(job => [job.id, job]));
  for (let start = 0; start < jobs.length; start += EMAIL_OUTBOX_SESSION_MAX_MESSAGES) {
    const slice = jobs.slice(start, start + EMAIL_OUTBOX_SESSION_MAX_MESSAGES);
    const seen = new Set<string>();
    let sliceSuccessCount = 0;
    let sliceInfrastructureError: unknown = null;
    const markResult = async (result: { id: string; ok: boolean; error?: string }): Promise<void> => {
      if (seen.has(result.id)) return;
      const job = jobMap.get(result.id);
      if (!job) return;
      if (result.ok) {
        await markEmailOutboxJobSent(job, stats);
        sliceSuccessCount += 1;
      } else {
        if (isTenantSmtpInfrastructureError(result.error || 'SMTP send failed')) {
          sliceInfrastructureError = result.error || 'SMTP send failed';
        }
        await markEmailOutboxJobRetry(job, result.error || 'SMTP send failed', stats);
      }
      seen.add(result.id);
    };
    const markUnseenRetry = async (error: unknown): Promise<void> => {
      for (const job of slice) {
        if (!seen.has(job.id)) await markEmailOutboxJobRetry(job, error, stats);
      }
    };

    try {
      await sendSmtpMailBatch(
        smtpConfig,
        slice.map(toSmtpBatchMail),
        EMAIL_OUTBOX_SESSION_MAX_MESSAGES,
        markResult,
      );
      await markUnseenRetry('SMTP send did not return a result');
    } catch (err) {
      sliceInfrastructureError = err;
      await markUnseenRetry(err);
    }

    if (sliceSuccessCount > 0) {
      markTenantSmtpSuccess(tenantId);
    } else if (sliceInfrastructureError) {
      markTenantSmtpFailure(tenantId, sliceInfrastructureError, stats);
    }
  }
}

async function processEmailOutboxBatchStats(
  tenantId: string | undefined,
  limit: number,
  concurrency: number,
  deadlineMs: number,
): Promise<EmailOutboxBatchStats> {
  const stats = createEmailOutboxBatchStats();
  if (Date.now() >= deadlineMs) return stats;

  let jobs: ClaimedEmailOutboxJob[] = [];
  try {
    jobs = await claimEmailOutboxJobs(
      tenantId,
      Math.min(Math.max(1, limit), EMAIL_OUTBOX_CLAIM_BATCH_SIZE),
    );
  } catch (err) {
    stats.errors += 1;
    console.error('[EmailOutbox] Claim error:', err instanceof Error ? err.message : err);
    return stats;
  }

  stats.claimed += jobs.length;
  stats.reclaimed += jobs.filter(job => job.previous_status === 'sending').length;
  if (jobs.length === 0) return stats;

  const groups = new Map<string, ClaimedEmailOutboxJob[]>();
  for (const job of jobs) {
    const group = groups.get(job.tenant_id) || [];
    group.push(job);
    groups.set(job.tenant_id, group);
  }

  const groupQueue = Array.from(groups.values());
  let cursor = 0;
  const groupConcurrency = Math.max(1, Math.min(concurrency, EMAIL_OUTBOX_TENANT_CONCURRENCY, groupQueue.length));
  const worker = async () => {
    while (cursor < groupQueue.length && Date.now() < deadlineMs) {
      const group = groupQueue[cursor];
      cursor += 1;
      try {
        await sendClaimedEmailOutboxTenantGroup(group, stats);
      } catch (err) {
        stats.errors += 1;
        console.error('[EmailOutbox] Group error:', err instanceof Error ? err.message : err);
      }
    }
  };

  await Promise.all(Array.from({ length: groupConcurrency }, () => worker()));

  return stats;
}

export async function processEmailOutboxBatch(tenantId?: string, limit = EMAIL_OUTBOX_BATCH_SIZE): Promise<number> {
  const stats = await processEmailOutboxBatchStats(
    tenantId,
    limit,
    EMAIL_OUTBOX_CONCURRENCY,
    Date.now() + EMAIL_OUTBOX_TICK_BUDGET_MS,
  );
  return stats.sent;
}

async function cleanupSentEmailOutboxBatch(): Promise<number> {
  if (EMAIL_OUTBOX_SENT_RETENTION_DAYS <= 0) return 0;
  const result = await query(
    `WITH doomed AS (
       SELECT id
       FROM email_outbox
       WHERE status = 'sent'
         AND sent_at < now() - (($1::int || ' days')::interval)
       ORDER BY sent_at ASC, id ASC
       LIMIT $2::int
     )
     DELETE FROM email_outbox eo
     USING doomed
     WHERE eo.id = doomed.id`,
    [EMAIL_OUTBOX_SENT_RETENTION_DAYS, EMAIL_OUTBOX_RETENTION_BATCH_SIZE],
  );
  return result.rowCount || 0;
}

async function withEmailOutboxRetentionLock(fn: () => Promise<void>): Promise<boolean> {
  const client = await getClient();
  try {
    const lock = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock(hashtext($1)::bigint) AS locked',
      [EMAIL_OUTBOX_RETENTION_LOCK_KEY],
    );
    if (!lock.rows[0]?.locked) return false;

    try {
      await fn();
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1)::bigint)', [EMAIL_OUTBOX_RETENTION_LOCK_KEY])
        .catch(() => undefined);
    }
    return true;
  } finally {
    client.release();
  }
}

let workerStarted = false;
let workerRunning = false;
let workerWakePending = false;
let workerWakeTimer: NodeJS.Timeout | null = null;
let workerImmediateScheduled = false;
let pendingWakeReason = 'manual';
let workerInterval: NodeJS.Timeout | null = null;
let nextRetentionCleanupAt = 0;
let emailOutboxRabbitConsumerStarted = false;

async function drainEmailOutboxWorker(reason: string): Promise<void> {
  const startedAt = Date.now();
  const deadlineMs = startedAt + EMAIL_OUTBOX_TICK_BUDGET_MS;
  const totalStats = createEmailOutboxBatchStats();
  let fanoutQueued = 0;
  let retentionDeleted = 0;
  let loops = 0;

  while (Date.now() < deadlineMs) {
    loops += 1;
    let queued = 0;
    try {
      queued = await processCourseNotificationEmailFanoutBatch();
      fanoutQueued += queued;
    } catch (err) {
      totalStats.errors += 1;
      console.error('[EmailOutbox] Fanout error:', err instanceof Error ? err.message : err);
    }

    const batchStats = await processEmailOutboxBatchStats(
      undefined,
      EMAIL_OUTBOX_BATCH_SIZE,
      EMAIL_OUTBOX_CONCURRENCY,
      deadlineMs,
    );
    mergeEmailOutboxBatchStats(totalStats, batchStats);

    if (queued === 0 && batchStats.claimed === 0) {
      break;
    }
  }

  if (Date.now() >= nextRetentionCleanupAt) {
    nextRetentionCleanupAt = Date.now() + EMAIL_OUTBOX_RETENTION_INTERVAL_MS;
    try {
      await withEmailOutboxRetentionLock(async () => {
        retentionDeleted = await cleanupSentEmailOutboxBatch();
      });
    } catch (err) {
      totalStats.errors += 1;
      console.error('[EmailOutbox] Retention cleanup error:', err instanceof Error ? err.message : err);
    }
  }

  const elapsedMs = Date.now() - startedAt;
  const hasActivity = fanoutQueued > 0
    || totalStats.claimed > 0
    || totalStats.reclaimed > 0
    || totalStats.sent > 0
    || totalStats.retried > 0
    || totalStats.failed > 0
    || totalStats.cooldownSkipped > 0
    || totalStats.circuitOpened > 0
    || retentionDeleted > 0
    || totalStats.errors > 0;
  const shouldLogIdleTick = reason === 'startup'
    || reason.startsWith('rabbitmq')
    || reason.startsWith('pending-wake');

  if (hasActivity || shouldLogIdleTick) {
    console.log(
      `[EmailOutbox] tick done reason=${reason} loops=${loops} fanout_queued=${fanoutQueued} claimed=${totalStats.claimed} reclaimed=${totalStats.reclaimed} sent=${totalStats.sent} retried=${totalStats.retried} failed=${totalStats.failed} cooldown_skipped=${totalStats.cooldownSkipped} circuit_opened=${totalStats.circuitOpened} retention_deleted=${retentionDeleted} errors=${totalStats.errors} elapsed_ms=${elapsedMs}`,
    );
  }
}

async function runEmailOutboxWorkerTick(reason: string): Promise<void> {
  if (!workerStarted || !env.EMAIL_OUTBOX_WORKER_ENABLED) return;
  if (workerRunning) {
    workerWakePending = true;
    return;
  }

  workerRunning = true;
  try {
    do {
      workerWakePending = false;
      await drainEmailOutboxWorker(reason);
      reason = pendingWakeReason === 'manual' ? 'pending-wake' : `pending-wake:${pendingWakeReason}`;
      pendingWakeReason = 'manual';
    } while (workerWakePending);
  } finally {
    workerRunning = false;
  }
}

async function publishEmailOutboxWake(reason: string): Promise<void> {
  try {
    await publish(QUEUES.EMAIL_OUTBOX, {
      type: 'email_outbox_wake',
      reason,
      emittedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.warn('[EmailOutbox] RabbitMQ wake publish failed; DB polling fallback remains active:', err instanceof Error ? err.message : err);
  }
}

export function wakeEmailOutboxWorker(reason = 'manual'): void {
  triggerEmailOutboxWorker(reason);
  publishEmailOutboxWake(reason).catch(err => {
    console.warn('[EmailOutbox] RabbitMQ wake publish failed; DB polling fallback remains active:', err instanceof Error ? err.message : err);
  });
}

export function triggerEmailOutboxWorker(reason = 'manual'): void {
  if (!workerStarted || !env.EMAIL_OUTBOX_WORKER_ENABLED) return;
  pendingWakeReason = reason;
  if (workerRunning) {
    workerWakePending = true;
    return;
  }
  if (workerWakeTimer) return;
  if (workerImmediateScheduled) return;

  const run = () => {
    workerWakeTimer = null;
    workerImmediateScheduled = false;
    const runReason = pendingWakeReason;
    pendingWakeReason = 'manual';
    runEmailOutboxWorkerTick(runReason).catch(err => {
      console.error('[EmailOutbox] Worker error:', err instanceof Error ? err.message : err);
    });
  };

  if (EMAIL_OUTBOX_WAKE_DEBOUNCE_MS > 0) {
    workerWakeTimer = setTimeout(run, EMAIL_OUTBOX_WAKE_DEBOUNCE_MS);
    workerWakeTimer.unref();
  } else {
    workerImmediateScheduled = true;
    setImmediate(run);
  }
}

export async function startEmailOutboxRabbitConsumer(): Promise<void> {
  if (emailOutboxRabbitConsumerStarted) return;
  emailOutboxRabbitConsumerStarted = true;
  await consume(
    QUEUES.EMAIL_OUTBOX,
    async function processEmailWake(data: Record<string, any>) {
      const reason = typeof data.reason === 'string' && data.reason.trim()
        ? `rabbitmq:${data.reason.trim()}`
        : 'rabbitmq';
      triggerEmailOutboxWorker(reason);
    },
    async function onMaxRetry(_queue: string, rawMessage: string) {
      console.error('[EmailOutbox] RabbitMQ wake max retries reached; DB polling fallback remains active:', rawMessage.substring(0, 200));
    },
    { prefetch: EMAIL_OUTBOX_RABBIT_PREFETCH, isolatedChannel: true },
  );
}

export function startEmailOutboxWorker(options: { keepAlive?: boolean; source?: string } = {}): void {
  if (workerStarted) return;
  if (!env.EMAIL_OUTBOX_WORKER_ENABLED) {
    console.log('[EmailOutbox] Worker disabled by EMAIL_OUTBOX_WORKER_ENABLED=false');
    return;
  }
  workerStarted = true;
  console.log(
    `[EmailOutbox] Worker started source=${options.source || 'default'} interval_ms=${EMAIL_OUTBOX_INTERVAL_MS} batch_size=${EMAIL_OUTBOX_BATCH_SIZE} claim_batch_size=${EMAIL_OUTBOX_CLAIM_BATCH_SIZE} concurrency=${EMAIL_OUTBOX_CONCURRENCY} tenant_concurrency=${EMAIL_OUTBOX_TENANT_CONCURRENCY} session_max_messages=${EMAIL_OUTBOX_SESSION_MAX_MESSAGES} retention_days=${EMAIL_OUTBOX_SENT_RETENTION_DAYS} tick_budget_ms=${EMAIL_OUTBOX_TICK_BUDGET_MS} wake_debounce_ms=${EMAIL_OUTBOX_WAKE_DEBOUNCE_MS} rabbit_prefetch=${EMAIL_OUTBOX_RABBIT_PREFETCH} tenant_failure_threshold=${EMAIL_OUTBOX_TENANT_FAILURE_THRESHOLD} tenant_cooldown_ms=${EMAIL_OUTBOX_TENANT_COOLDOWN_MS}`,
  );
  triggerEmailOutboxWorker('startup');
  workerInterval = setInterval(() => {
    triggerEmailOutboxWorker('interval');
  }, EMAIL_OUTBOX_INTERVAL_MS);
  if (!options.keepAlive) workerInterval.unref();
}

export function stopEmailOutboxWorker(): void {
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
  }
  if (workerWakeTimer) {
    clearTimeout(workerWakeTimer);
    workerWakeTimer = null;
  }
  workerImmediateScheduled = false;
  workerStarted = false;
}
