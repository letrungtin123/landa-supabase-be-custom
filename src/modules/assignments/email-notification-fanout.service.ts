// ═══════════════════════════════════════════════════════════════
// Course notification email fan-out: claims due notification_email_jobs and,
// per job and in its own transaction, renders one batch of recipients
// (assignment-created or course notice emails, plus the owner copy on the
// first batch) into email_outbox and records the job's progress. SQL lives
// in email-outbox-enqueue.repository.ts; moved from email-outbox.service.ts,
// which still re-exports the batch entry point.
// ═══════════════════════════════════════════════════════════════

import type { PoolClient } from 'pg';
import { getClient, query } from '../../config/database.js';
import { swallowAndLog } from '../../utils/best-effort.js';
import {
  buildAssignmentCreatedOwnerEmail,
  getEmailBranding,
  learnerDeadlineLabel,
  renderAssignmentCreatedEmail,
  renderCourseNotificationEmail,
  type AssignmentCreatedEmailContext,
  type DeadlineMode,
  type EmailBranding,
  type RecipientSummary,
  type SubmissionUnlockMode,
} from './email-outbox-templates.service.js';
import { normalizeRecipients } from './email-outbox-enqueue.service.js';
import { createEmailOutboxEnqueueRepository } from './email-outbox-enqueue.repository.js';

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
  const repository = createEmailOutboxEnqueueRepository(client);
  const smtp = await repository.selectSmtpCopySettings(ctx.tenantId);

  const row = smtp.rows[0];
  if (!row?.copy_to_sender || totalCount <= 0) return;

  const copyEmail = (row.copy_to_email || row.username || '').trim();
  if (!copyEmail) return;

  const summary: RecipientSummary = {
    totalCount,
    recipients: normalizeRecipients(recipients).slice(0, 50),
  };
  const ownerEmail = buildAssignmentCreatedOwnerEmail(ctx, branding, summary);
  await repository.insertNotificationOwnerCopy(ctx.tenantId, ctx.notificationId, copyEmail, 'Owner doanh nghiệp', ownerEmail);
}

async function processCourseNotificationEmailFanoutJob(jobId: string, batchSize: number): Promise<number> {
  const client = await getClient();
  const repository = createEmailOutboxEnqueueRepository(client);
  try {
    await client.query('BEGIN');
    const row = await repository.lockFanoutJob(jobId);
    if (!row) {
      await client.query('COMMIT');
      return 0;
    }

    // Serialize course deletion against fanout. The deletion request takes
    // FOR UPDATE on this row; holding KEY SHARE here means any outbox rows we
    // enqueue are still visible to, and removed by, the course purge.
    if ((await repository.lockActiveCourse(row.course_id, row.tenant_id)) === 0) {
      await repository.deleteFanoutJob(row.id);
      await client.query('COMMIT');
      return 0;
    }

    const notificationRow = await repository.selectFanoutNotification(row.notification_id, row.tenant_id);
    if (!notificationRow) {
      await repository.markFanoutJobNotificationMissing(row.id);
      await client.query('COMMIT');
      return 0;
    }

    const recipients = await repository.selectFanoutRecipients(
      row.notification_id, row.last_recipient_id, row.course_id, row.tenant_id, batchSize,
    );

    if (recipients.rowCount === 0) {
      await repository.markFanoutJobDone(row.id);
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

    if (assignmentBaseContext && !row.last_recipient_id) {
      await enqueueAssignmentCreatedOwnerCopyForFanoutJob(
        client,
        assignmentBaseContext,
        branding,
        notificationRow.recipient_count,
        recipients.rows,
      );
    }

    const insertedCount = await repository.insertNotificationEmails(row.tenant_id, row.notification_id, recipients.rows, renderedEmails);

    const lastRecipientId = recipients.rows[recipients.rows.length - 1].recipient_id;
    const isDone = recipients.rows.length < batchSize;
    await repository.markFanoutJobProgress(row.id, isDone ? 'done' : 'pending', lastRecipientId, insertedCount || 0);

    await client.query('COMMIT');
    return insertedCount || 0;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined); // fails only on a broken connection, which pg-pool discards
    const message = err instanceof Error ? err.message : String(err);
    await createEmailOutboxEnqueueRepository({ query })
      .markFanoutJobFailed(jobId, message.slice(0, 2000))
      .catch(swallowAndLog('email_outbox.job_failed_mark'));
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
  const repository = createEmailOutboxEnqueueRepository(client);
  try {
    const jobs = (await repository.claimDueFanoutJobs(jobsLimit, tenantId)).map(job => job.id);
    const remaining = jobsLimit - jobs.length;
    if (remaining > 0) {
      jobs.push(...(await repository.claimStaleFanoutJobs(remaining, tenantId)).map(job => job.id));
    }

    if (jobs.length === 0) return 0;

    let queued = 0;
    for (const jobId of jobs) {
      queued += await processCourseNotificationEmailFanoutJob(jobId, batchSize);
    }
    return queued;
  } finally {
    client.release();
  }
}
