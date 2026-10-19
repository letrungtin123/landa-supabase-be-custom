// ═══════════════════════════════════════════════════════════════
// Email outbox enqueue: writes the feedback (and owner feedback digest),
// assignment-created, team member and course-notification job rows inside
// the caller's transaction. The worker delivers them later. SQL lives in
// email-outbox-enqueue.repository.ts; moved from email-outbox.service.ts,
// which still re-exports every entry point.
// ═══════════════════════════════════════════════════════════════

import type { PoolClient } from 'pg';
import { OWNER_FEEDBACK_HTML_MARKER, OWNER_FEEDBACK_TEXT_MARKER } from './email-outbox-body.logic.js';
import {
  OWNER_FEEDBACK_DIGEST_DELAY_MINUTES,
  OWNER_FEEDBACK_DIGEST_SUBJECT,
  buildAssignmentCreatedOwnerEmail,
  buildOwnerFeedbackDigestEmail,
  getEmailBranding,
  learnerDeadlineLabel,
  ownerFeedbackItemHtml,
  ownerFeedbackItemText,
  renderAssignmentCreatedEmail,
  renderFeedbackEmail,
  renderTeamMemberAddedEmail,
  type AssignmentCreatedEmailContext,
  type AssignmentCreatedEmailRecipient,
  type CourseNotificationEmailContext,
  type EmailBranding,
  type FeedbackEmailContext,
  type RecipientSummary,
  type RecipientSummaryItem,
  type TeamMemberAddedEmailContext,
} from './email-outbox-templates.service.js';
import { createEmailOutboxEnqueueRepository, type OutboxEmailInput } from './email-outbox-enqueue.repository.js';

async function insertOutboxEmail(client: PoolClient, input: OutboxEmailInput): Promise<void> {
  await createEmailOutboxEnqueueRepository(client).insertOutboxEmail(input);
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
  await createEmailOutboxEnqueueRepository(client).insertRecipientEmails(input.tenantId, input.recipients, input.emails);
  return input.recipients.length;
}

async function enqueueOwnerFeedbackDigestEmail(
  client: PoolClient,
  ctx: FeedbackEmailContext,
  branding: EmailBranding,
  recipientEmail: string,
): Promise<number> {
  const repository = createEmailOutboxEnqueueRepository(client);
  const existing = await repository.selectPendingOwnerDigest(
    ctx.tenantId, recipientEmail, OWNER_FEEDBACK_DIGEST_SUBJECT, OWNER_FEEDBACK_HTML_MARKER,
  );

  const nextHtmlItem = ownerFeedbackItemHtml(ctx);
  const nextTextItem = `\n\n${ownerFeedbackItemText(ctx)}`;

  if (existing.rowCount && existing.id) {
    await repository.appendToOwnerDigest(
      existing.id,
      OWNER_FEEDBACK_HTML_MARKER,
      nextHtmlItem,
      OWNER_FEEDBACK_TEXT_MARKER,
      nextTextItem,
      OWNER_FEEDBACK_DIGEST_DELAY_MINUTES,
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

export function normalizeRecipients(rows: RecipientSummaryItem[] | null | undefined): RecipientSummaryItem[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter(row => row && typeof row.email === 'string' && row.email.trim())
    .map(row => ({
      name: (typeof row.name === 'string' && row.name.trim()) ? row.name.trim() : row.email,
      email: row.email.trim(),
    }));
}

export async function enqueueFeedbackEmails(client: PoolClient, ctx: FeedbackEmailContext): Promise<number> {
  const smtp = await createEmailOutboxEnqueueRepository(client).selectFeedbackSmtp(ctx.tenantId);

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
  const repository = createEmailOutboxEnqueueRepository(client);
  const smtp = await repository.selectSmtpCopySettings(ctx.tenantId);

  if (smtp.rowCount === 0) return 0;

  const branding = await getEmailBranding(ctx.tenantId, client);
  const recipientRows = await repository.selectAssignmentRecipients(ctx.notificationId, ctx.courseId, ctx.tenantId);

  const recipients: AssignmentCreatedEmailRecipient[] = recipientRows.map(row => ({
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
  const repository = createEmailOutboxEnqueueRepository(client);
  if ((await repository.selectSmtpEnabled(ctx.tenantId)) === 0) return 0;

  const recipients = await repository.selectTeamRecipients(ctx.notificationId, ctx.tenantId);

  if (recipients.rowCount === 0) return 0;

  const branding = await getEmailBranding(ctx.tenantId, client);
  const renderedEmails: Array<{ subject: string; html: string; text: string }> = [];
  for (const recipient of recipients.rows) {
    renderedEmails.push(await renderTeamMemberAddedEmail(client, {
      ...ctx,
      learnerName: recipient.name,
    }, branding));
  }
  const insertedCount = await repository.insertNotificationEmails(ctx.tenantId, ctx.notificationId, recipients.rows, renderedEmails);

  return insertedCount || 0;
}

export async function enqueueCourseNotificationEmailJob(
  client: PoolClient,
  ctx: Pick<CourseNotificationEmailContext, 'tenantId' | 'notificationId' | 'courseId'>,
): Promise<number> {
  return createEmailOutboxEnqueueRepository(client).insertNotificationEmailJob(ctx.tenantId, ctx.notificationId, ctx.courseId);
}
