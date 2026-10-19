// ═══════════════════════════════════════════════════════════════
// Email outbox HTML: the escaping, labels, shell, blocks and token tables the
// outbox emails are built from. Pure; moved unchanged from
// email-outbox-templates.service.ts.
// ═══════════════════════════════════════════════════════════════

import { DEFAULT_GROUP_LABELS } from '../tenants/tenant-group-labels.service.js';
import type { EmailTemplateKey, TemplateTokenMap } from '../email-templates/email-templates.service.js';
import type {
  AssignmentCreatedEmailContext,
  EmailBranding,
  RecipientSummary,
  SubmissionUnlockMode,
} from './email-outbox-templates.service.js';

export const EMAIL_FONT_FAMILY = "'Google Sans'";
export const EMAIL_FONT_STYLE = `font-family:${EMAIL_FONT_FAMILY};`;

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function htmlLines(value: string): string {
  return escapeHtml(value || '').replace(/\n/g, '<br>');
}

export function formatDateTime(value: string | Date): string {
  return new Intl.DateTimeFormat('vi-VN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Ho_Chi_Minh',
  }).format(new Date(value));
}

export function normalizeLearnerUrl(domain?: string | null): string | null {
  const trimmed = domain?.trim();
  if (!trimmed) return null;
  const withoutTrailingSlash = trimmed.replace(/\/+$/, '');
  if (/^https?:\/\//i.test(withoutTrailingSlash)) return withoutTrailingSlash;
  return `https://${withoutTrailingSlash.replace(/^\/+/, '')}`;
}

export function displayDomain(url: string | null): string | null {
  if (!url) return null;
  return url.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

export function buildLearnerCourseFocusUrl(
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


export function hiddenPreheader(intro: string): string {
  const spacer = '&zwnj;&nbsp;'.repeat(90);
  return `
    <div style="${EMAIL_FONT_STYLE}display:none!important;max-height:0;max-width:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#edf2f7;opacity:0">
      ${escapeHtml(intro)}${spacer}
    </div>
  `;
}

export function relativeDeadlinePolicyLabel(ctx: AssignmentCreatedEmailContext): string {
  return `Hạn nộp sau ${ctx.deadlineAfterDays} ngày. Nếu học viên đã ghi danh trước khi bài tập được tạo, hạn nộp được tính từ lúc bài tập được tạo; nếu ghi danh sau, hạn nộp được tính từ lúc ghi danh.`;
}

export function deadlineLabel(ctx: AssignmentCreatedEmailContext): string {
  if (ctx.deadlineMode === 'relative_to_enrollment' && ctx.deadlineAfterDays) {
    return relativeDeadlinePolicyLabel(ctx);
  }
  if ((ctx.deadlineMode === 'absolute' || ctx.deadlineEnabled) && ctx.deadlineAt) {
    return `Hạn nộp: ${formatDateTime(ctx.deadlineAt)}.`;
  }
  return 'Bài tập này không có thời hạn nộp.';
}

export function learnerDeadlineLabel(ctx: AssignmentCreatedEmailContext, enrolledAt?: string | Date | null): string {
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

export function unlockLabel(mode?: SubmissionUnlockMode): string {
  return mode === 'anytime'
    ? 'Học viên có thể nộp bài trước khi học xong toàn bộ nội dung.'
    : 'Học viên cần học xong toàn bộ nội dung khóa học trước khi nộp bài.';
}

export function shellEmail(
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

export function pill(label: string, tone: 'blue' | 'green' | 'amber' | 'slate' = 'blue'): string {
  const palette = {
    blue: { bg: '#eff6ff', fg: '#1d4ed8', bd: '#bfdbfe' },
    green: { bg: '#ecfdf5', fg: '#047857', bd: '#bbf7d0' },
    amber: { bg: '#fffbeb', fg: '#b45309', bd: '#fde68a' },
    slate: { bg: '#f8fafc', fg: '#334155', bd: '#e2e8f0' },
  }[tone];
  return `<span style="${EMAIL_FONT_STYLE}display:inline-block;border-radius:999px;background:${palette.bg};border:1px solid ${palette.bd};color:${palette.fg};font-size:12px;line-height:18px;font-weight:800;padding:6px 11px">${escapeHtml(label)}</span>`;
}

export function infoTable(rows: Array<{ label: string; value: string }>): string {
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

export function sectionTitle(value: string): string {
  return `<div style="${EMAIL_FONT_STYLE}margin-top:24px;color:#0f172a;font-size:14px;line-height:20px;font-weight:800;text-transform:uppercase;letter-spacing:.5px">${escapeHtml(value)}</div>`;
}

export function quoteBlock(value: string): string {
  return `
    <div style="${EMAIL_FONT_STYLE}border:1px solid #dbe3ef;border-left:5px solid #2563eb;background:#f8fafc;border-radius:16px;padding:16px 18px;margin-top:10px;color:#1f2937;font-size:15px;line-height:24px">
      ${htmlLines(value)}
    </div>
  `;
}

export function learnerAccessBlock(branding: EmailBranding, learnerHref?: string | null): string {
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

export function commonTemplateTokens(branding: EmailBranding): TemplateTokenMap {
  return {
    tenant_name: { text: branding.tenantName },
    brand_name: { text: branding.brandName },
    learner_domain: { text: branding.learnerDomainLabel || '' },
    learner_portal_url: { text: branding.learnerUrl || '' },
  };
}

export function templateTokenHtml(tokens: TemplateTokenMap, key: string): string {
  const token = tokens[key];
  if (!token) return '';
  return token.html ?? htmlLines(token.text || '');
}

export function systemDataRowsTable(rows: Array<{ label: string; value: string }>): string {
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

export function systemDataBlock(key: EmailTemplateKey, tokens: TemplateTokenMap, templateBody: string): string {
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

export function recipientList(summary: RecipientSummary): string {
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

export function scoreLabel(score?: number | null): string {
  return score !== undefined && score !== null ? `Điểm: ${score}/100` : 'Đã có phản hồi';
}
