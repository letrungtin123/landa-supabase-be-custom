// ═══════════════════════════════════════════════════════════════
// Email outbox templates: the contexts, branding and HTML / text of the
// feedback, owner feedback digest, assignment-created, course notification
// and team member emails, with the tenant's custom templates when set. Moved
// unchanged from email-outbox.service.ts (the tenant branding read is in
// email-outbox-enqueue.repository.ts).
// ═══════════════════════════════════════════════════════════════

import type { PoolClient } from 'pg';
import { query } from '../../config/database.js';
import { OWNER_FEEDBACK_HTML_MARKER, OWNER_FEEDBACK_TEXT_MARKER } from './email-outbox-body.logic.js';
import {
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
import { createEmailOutboxEnqueueRepository } from './email-outbox-enqueue.repository.js';
import {
  EMAIL_FONT_STYLE,
  escapeHtml,
  normalizeLearnerUrl,
  displayDomain,
  buildLearnerCourseFocusUrl,
  deadlineLabel,
  unlockLabel,
  shellEmail,
  pill,
  infoTable,
  sectionTitle,
  quoteBlock,
  commonTemplateTokens,
  systemDataBlock,
  recipientList,
  scoreLabel,
} from './email-outbox-html.logic.js';

export type DeadlineMode = 'none' | 'absolute' | 'relative_to_enrollment';
export type SubmissionUnlockMode = 'after_content_complete' | 'anytime';

export interface EmailBranding {
  tenantName: string;
  brandName: string;
  learnerUrl: string | null;
  learnerDomainLabel: string | null;
}

export interface FeedbackEmailContext {
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

export interface AssignmentCreatedEmailContext {
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

export interface CourseNotificationEmailContext {
  tenantId: string;
  notificationId: string;
  courseId: string;
  courseName: string;
  learnerName: string;
  title: string;
  message: string;
}

export interface TeamMemberAddedCourseCategory {
  name: string;
  courseCount: number;
}

export interface TeamMemberAddedEmailContext {
  tenantId: string;
  notificationId: string;
  learnerName?: string;
  orgGroupName: string;
  subGroupName: string;
  teamName: string;
  groupLabels?: GroupLabelMap;
  courseCategories: TeamMemberAddedCourseCategory[];
}

export interface RecipientSummaryItem {
  name: string;
  email: string;
}

export interface RecipientSummary {
  totalCount: number;
  recipients: RecipientSummaryItem[];
}

export interface AssignmentCreatedEmailRecipient extends RecipientSummaryItem {
  userId: string;
  enrolledAt?: string | Date | null;
}

export const OWNER_FEEDBACK_DIGEST_SUBJECT = 'Tổng hợp phản hồi bài tập mới';
export const OWNER_FEEDBACK_DIGEST_DELAY_MINUTES = 5;
export async function getEmailBranding(tenantId: string, client?: PoolClient): Promise<EmailBranding> {
  const tenant = await createEmailOutboxEnqueueRepository(client ?? { query }).selectTenantBranding(tenantId);
  const tenantName = tenant?.name || 'Tenant';
  const learnerUrl = normalizeLearnerUrl(tenant?.domain_learner);
  return {
    tenantName,
    brandName: `${tenantName} E-Learning`,
    learnerUrl,
    learnerDomainLabel: displayDomain(learnerUrl),
  };
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

export async function renderFeedbackEmail(client: PoolClient, ctx: FeedbackEmailContext, branding: EmailBranding) {
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

export async function renderAssignmentCreatedEmail(
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

export function buildAssignmentCreatedOwnerEmail(
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

export async function renderCourseNotificationEmail(
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

export async function renderTeamMemberAddedEmail(
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

export function ownerFeedbackItemHtml(ctx: FeedbackEmailContext): string {
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

export function ownerFeedbackItemText(ctx: FeedbackEmailContext): string {
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

export function buildOwnerFeedbackDigestEmail(ctx: FeedbackEmailContext, branding: EmailBranding) {
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
