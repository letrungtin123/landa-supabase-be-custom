import { getClient, query } from '../../config/database.js';
import { appendAuditLog, type TransactionalAuditEntry } from '../../middleware/audit-log.js';
import { env } from '../../config/env.js';
import { AppError } from '../../middleware/error-handler.js';
import { parseExpiresIn } from '../../utils/jwt.js';
import { publish, QUEUES } from '../../config/rabbitmq/index.js';
import {
  deleteStorageManifest,
  registerStorageManifestPaths,
  registerStoragePrefixManifestPaths,
} from '../deletion/storage-manifest.service.js';
import { extractStoragePath } from '../../config/storage.js';
import { cacheUserAccessRevocation } from '../auth/auth-revocation.service.js';
import { assertUserNotActiveDemoIframeAccount } from '../demo-login/demo-iframe.service.js';

const DELETE_BATCH_SIZE = 500;
const USER_JOB_LEASE_SECONDS = 15 * 60;

type UserDeletionJobRow = {
  id: string;
  user_id: string | null;
  tenant_id: string | null;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  attempts: number;
  is_terminal: boolean;
};

type TargetUserRow = {
  id: string;
  username: string | null;
  email: string | null;
  full_name: string | null;
  role: string;
  tenant_id: string | null;
  avatar_url: string | null;
};

/** Narrow snapshot passed to the audit writer while the target row is locked. */
export type UserDeletionAuditTarget = Pick<TargetUserRow, 'username' | 'email' | 'full_name' | 'role'>;

const ROLE_LEVEL: Record<string, number> = {
  learner: 0,
  learner_plus: 0,
  staff: 1,
  superuser: 2,
  superadmin: 3,
};

function assertDeletionAuthority(target: TargetUserRow, callerId: string, callerRole: string, callerTenantId: string | null): void {
  if (target.id === callerId) throw new AppError('Không thể xóa chính mình', 403);
  if (callerRole !== 'superadmin' && callerTenantId && target.tenant_id !== callerTenantId) {
    throw new AppError('Không có quyền xóa user ngoài tenant', 403);
  }

  const callerLevel = ROLE_LEVEL[callerRole] ?? 0;
  const targetLevel = ROLE_LEVEL[target.role] ?? 0;
  if (callerLevel <= targetLevel && callerRole !== 'superadmin') {
    throw new AppError(`Không có quyền xóa ${target.role}`, 403);
  }
  if (target.role === 'superadmin' && callerRole !== 'superadmin') {
    throw new AppError('Chỉ superadmin mới xóa được superadmin', 403);
  }
}

async function publishUserDeletionJob(jobId: string): Promise<void> {
  try {
    await publish(QUEUES.USER_DELETE, { jobId });
  } catch (error) {
    // The periodic DB sweeper is the durable delivery fallback. Never roll
    // back a committed deletion request merely because RabbitMQ is transiently down.
    console.error(`[UserDelete] Failed to publish job ${jobId}:`, error);
  }
}

/** Queue a durable, idempotent permanent deletion. It does not delete inline. */
export async function requestUserDeletion(
  targetId: string,
  callerId: string,
  callerRole: string,
  callerTenantId: string | null,
  auditEntry?: (
    jobId: string,
    targetTenantId: string | null,
    target: UserDeletionAuditTarget,
  ) => TransactionalAuditEntry,
): Promise<{ jobId: string; deletedUserName: string }> {
  const client = await getClient();
  let response: { jobId: string; deletedUserName: string } | null = null;
  let revocationExpiresAt: Date | null = null;

  try {
    await client.query('BEGIN');
    const targetResult = await client.query<TargetUserRow>(
      `SELECT id,
              NULLIF(btrim(username), '') AS username,
              NULLIF(lower(btrim(email)), '') AS email,
              NULLIF(btrim(full_name), '') AS full_name,
              role, tenant_id, avatar_url
       FROM users
       WHERE id = $1
       FOR UPDATE`,
      [targetId],
    );
    if (targetResult.rowCount === 0) throw new AppError('User không tồn tại', 404);
    const target = targetResult.rows[0];
    assertDeletionAuthority(target, callerId, callerRole, callerTenantId);
    await assertUserNotActiveDemoIframeAccount(targetId, 'Tài khoản learner demo iframe đang được khóa, không thể xóa');

    const existing = await client.query<{ id: string; is_terminal: boolean }>(
      `SELECT id, is_terminal
       FROM user_deletion_jobs
       WHERE user_id = $1::uuid
         AND status IN ('queued', 'running', 'failed')
       ORDER BY requested_at DESC
       LIMIT 1
       FOR UPDATE`,
      [targetId],
    );
    if (existing.rowCount && existing.rows[0]) {
      if (existing.rows[0].is_terminal) {
        throw new AppError('Deletion job trước đó đã dừng sau khi hết retry. Hãy dùng endpoint retry của job đó.', 409);
      }
      response = {
        jobId: existing.rows[0].id,
        deletedUserName: target.username || target.email || target.id,
      };
      await client.query('COMMIT');
      return response;
    }

    const expiresAt = new Date(Date.now() + parseExpiresIn(env.JWT_ACCESS_EXPIRES_IN) + 60_000);
    await client.query(
      `INSERT INTO auth_revocations (user_id, revoked_at, expires_at, reason)
       VALUES ($1::uuid, now(), $2::timestamptz, 'permanent_user_deletion')
       ON CONFLICT (user_id)
       DO UPDATE SET revoked_at = EXCLUDED.revoked_at, expires_at = EXCLUDED.expires_at, reason = EXCLUDED.reason`,
      [targetId, expiresAt],
    );
    await client.query(
      `UPDATE refresh_tokens
       SET revoked = true, revoked_at = COALESCE(revoked_at, now())
       WHERE user_id = $1::uuid AND revoked = false`,
      [targetId],
    );
    // Cancel both mail addressed to this person and mail whose content belongs
    // to their submission before an outbox worker can pick it up.
    await client.query(
      `DELETE FROM email_outbox
       WHERE recipient_user_id = $1::uuid
          OR related_submission_id IN (
            SELECT id FROM assignment_submissions WHERE learner_id = $1::uuid
          )`,
      [targetId],
    );
    const jobResult = await client.query<{ id: string }>(
      `INSERT INTO user_deletion_jobs (user_id, tenant_id, requested_by)
       VALUES ($1::uuid, $2::uuid, $3::uuid)
       RETURNING id`,
      [targetId, target.tenant_id, callerId],
    );
    const jobId = jobResult.rows[0].id;
    await client.query(
      `UPDATE users
       SET is_active = false,
           deletion_requested_at = now(),
           delete_status = 'queued',
           delete_job_id = $2::uuid
       WHERE id = $1::uuid`,
      [targetId, jobId],
    );
    if (auditEntry) {
      await appendAuditLog(client, auditEntry(jobId, target.tenant_id, {
        username: target.username,
        email: target.email,
        full_name: target.full_name,
        role: target.role,
      }));
    }
    await client.query('COMMIT');
    response = { jobId, deletedUserName: target.username || target.email || target.id };
    revocationExpiresAt = expiresAt;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  if (!response || !revocationExpiresAt) throw new Error('User deletion request did not commit');
  await cacheUserAccessRevocation(targetId, revocationExpiresAt);
  await publishUserDeletionJob(response.jobId);
  return response;
}

async function markJobRunning(jobId: string): Promise<UserDeletionJobRow | null> {
  const result = await query<UserDeletionJobRow>(
    `UPDATE user_deletion_jobs
     SET status = 'running',
         attempts = attempts + 1,
         started_at = COALESCE(started_at, now()),
         lease_expires_at = now() + ($2::int * interval '1 second'),
         updated_at = now()
     WHERE id = $1::uuid
       AND is_terminal = false
       AND (next_attempt_at IS NULL OR next_attempt_at <= now())
       AND (
         status IN ('queued', 'failed')
         OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at < now()))
       )
     RETURNING id, user_id, tenant_id, status, attempts`,
    [jobId, USER_JOB_LEASE_SECONDS],
  );
  return result.rows[0] ?? null;
}

async function touchJobLease(jobId: string): Promise<void> {
  await query(
    `UPDATE user_deletion_jobs
     SET lease_expires_at = now() + ($2::int * interval '1 second'), updated_at = now()
     WHERE id = $1::uuid AND status = 'running'`,
    [jobId, USER_JOB_LEASE_SECONDS],
  );
}

export async function markUserDeletionJobRetryable(jobId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const result = await query<{ user_id: string | null; is_terminal: boolean }>(
    `UPDATE user_deletion_jobs
     SET status = CASE WHEN attempts >= $3::int THEN 'failed' ELSE 'queued' END,
         is_terminal = attempts >= $3::int,
         lease_expires_at = NULL,
         next_attempt_at = CASE
           WHEN attempts >= $3::int THEN NULL
           ELSE now() + (
             LEAST(
               $4::numeric * power(2::numeric, GREATEST(attempts - 1, 0)),
               $5::numeric
             ) * (0.75 + random() * 0.5)
           ) * interval '1 millisecond'
         END,
         last_error = $2,
         updated_at = now()
     WHERE id = $1::uuid AND status = 'running'
     RETURNING user_id, is_terminal`,
    [
      jobId,
      message.slice(0, 4000),
      env.DELETION_MAX_ATTEMPTS,
      env.DELETION_RETRY_BASE_MS,
      env.DELETION_RETRY_MAX_MS,
    ],
  );

  const job = result.rows[0];
  if (job?.is_terminal && job.user_id) {
    await query(
      `UPDATE users
       SET delete_status = 'failed'
       WHERE id = $1::uuid AND deletion_requested_at IS NOT NULL`,
      [job.user_id],
    );
    console.error(`[UserDelete] Job ${jobId} reached terminal failure after retry budget was exhausted`);
  }
}

async function markJobSucceeded(jobId: string, stats: Record<string, number>): Promise<void> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    // Successful user jobs must not retain a user-id-bearing storage path.
    await client.query(
      `DELETE FROM deletion_storage_items
       WHERE job_kind = 'user' AND job_id = $1::uuid`,
      [jobId],
    );
    await client.query(
      `DELETE FROM deletion_storage_scan_cursors
       WHERE job_kind = 'user' AND job_id = $1::uuid`,
      [jobId],
    );
    await client.query(
      `UPDATE user_deletion_jobs
       SET status = 'succeeded',
           user_id = NULL,
           is_terminal = false,
           lease_expires_at = NULL,
           finished_at = now(),
           next_attempt_at = NULL,
           stats = $2::jsonb,
           last_error = NULL,
           updated_at = now()
       WHERE id = $1::uuid`,
      [jobId, JSON.stringify(stats)],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function deleteInBatches(sql: string, params: unknown[]): Promise<number> {
  let total = 0;
  while (true) {
    const result = await query(sql, [...params, DELETE_BATCH_SIZE]);
    const deleted = result.rowCount || 0;
    total += deleted;
    if (deleted < DELETE_BATCH_SIZE) return total;
  }
}

async function createUserStorageManifest(job: UserDeletionJobRow): Promise<void> {
  if (!job.user_id) return;
  const alreadyComplete = await query<{ manifest_completed_at: Date | null }>(
    `SELECT manifest_completed_at
     FROM user_deletion_jobs
     WHERE id = $1::uuid`,
    [job.id],
  );
  if (alreadyComplete.rows[0]?.manifest_completed_at) return;

  const target = await query<{ tenant_id: string | null; avatar_url: string | null }>(
    `SELECT tenant_id, avatar_url FROM users WHERE id = $1::uuid`,
    [job.user_id],
  );
  if (target.rowCount === 0) return;
  const tenantId = target.rows[0].tenant_id;
  if (!tenantId) {
    if (target.rows[0].avatar_url) {
      throw new Error('Cannot safely delete avatar for a user without tenant ownership');
    }
    return;
  }

  const fileRows = await query<{ storage_path: string }>(
    `SELECT af.storage_path
     FROM assignment_files af
     JOIN assignment_submissions submission ON submission.id = af.submission_id
     WHERE submission.learner_id = $1::uuid OR af.uploaded_by = $1::uuid`,
    [job.user_id],
  );
  const avatarPath = target.rows[0].avatar_url ? extractStoragePath(target.rows[0].avatar_url) : null;
  if (avatarPath && !avatarPath.startsWith(`${tenantId}/avatars/`)) {
    throw new Error('Unsafe or foreign avatar reference blocked user deletion');
  }
  const filePaths = fileRows.rows.map((row) => extractStoragePath(row.storage_path));
  if (filePaths.some((path) => !path || !path.startsWith(`${tenantId}/assignments/`))) {
    throw new Error('Unsafe or foreign assignment storage reference blocked user deletion');
  }
  const rawPaths = [avatarPath, ...filePaths].filter((value): value is string => Boolean(value));
  await registerStorageManifestPaths('user', job.id, tenantId, rawPaths);
  // Catches a successfully-uploaded avatar whose DB profile update failed.
  await registerStoragePrefixManifestPaths('user', job.id, tenantId, `${tenantId}/avatars/${job.user_id}.`);

  const feedbackRows = await query<{ feedback_files: unknown }>(
    `SELECT feedback_files
     FROM assignment_feedback_history
     WHERE learner_id = $1::uuid OR feedback_by = $1::uuid`,
    [job.user_id],
  );
  const feedbackPaths = new Set<string>();
  const collectFeedbackPaths = (value: unknown): void => {
    if (typeof value === 'string') {
      const path = extractStoragePath(value);
      if (path?.startsWith(`${tenantId}/assignments/`)) feedbackPaths.add(path);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) collectFeedbackPaths(item);
      return;
    }
    if (value && typeof value === 'object') {
      for (const item of Object.values(value as Record<string, unknown>)) collectFeedbackPaths(item);
    }
  };
  for (const row of feedbackRows.rows) collectFeedbackPaths(row.feedback_files);
  await registerStorageManifestPaths('user', job.id, tenantId, [...feedbackPaths]);

  await query(
    `UPDATE user_deletion_jobs
     SET manifest_completed_at = now(), updated_at = now()
     WHERE id = $1::uuid AND status = 'running'`,
    [job.id],
  );
}

async function purgeUserDatabase(userId: string): Promise<Record<string, number>> {
  const stats: Record<string, number> = {};
  const user = await query<{ id: string }>('SELECT id FROM users WHERE id = $1::uuid', [userId]);
  if (user.rowCount === 0) return { alreadyDeleted: 1 };
  stats.emailOutbox = await deleteInBatches(
    `WITH doomed AS (
       SELECT ctid
       FROM email_outbox
       WHERE recipient_user_id = $1::uuid
          OR related_submission_id IN (
            SELECT id FROM assignment_submissions WHERE learner_id = $1::uuid
          )
       LIMIT $2::int
     ) DELETE FROM email_outbox e USING doomed WHERE e.ctid = doomed.ctid`,
    [userId],
  );
  // Audit rows are retained for the agreed 30-day window. The FK on actor_id
  // sets it to NULL when the user is purged; immutable actor snapshots keep
  // the operational history intelligible until the retention cleanup runs.
  stats.auditActorLogsRetained = 0;
  stats.auditUserEntityLogsRetained = 0;
  stats.chatConversations = await deleteInBatches(
    `WITH doomed AS (
       SELECT ctid FROM chat_conversations WHERE user_id = $1::uuid LIMIT $2::int
     ) DELETE FROM chat_conversations c USING doomed WHERE c.ctid = doomed.ctid`,
    [userId],
  );
  stats.assignmentSubmissions = await deleteInBatches(
    `WITH doomed AS (
       SELECT ctid FROM assignment_submissions WHERE learner_id = $1::uuid LIMIT $2::int
     ) DELETE FROM assignment_submissions s USING doomed WHERE s.ctid = doomed.ctid`,
    [userId],
  );
  stats.assignmentFeedbackHistory = await deleteInBatches(
    `WITH doomed AS (
       SELECT ctid
       FROM assignment_feedback_history
       WHERE learner_id = $1::uuid OR feedback_by = $1::uuid
       LIMIT $2::int
     ) DELETE FROM assignment_feedback_history history
       USING doomed
       WHERE history.ctid = doomed.ctid`,
    [userId],
  );
  // A staff member may have uploaded feedback files without being the
  // submission learner. Their storage paths were captured in the manifest;
  // remove the database records explicitly instead of relying on a learner
  // submission cascade that does not cover this ownership case.
  stats.assignmentFiles = await deleteInBatches(
    `WITH doomed AS (
       SELECT ctid
       FROM assignment_files
       WHERE uploaded_by = $1::uuid
       LIMIT $2::int
     ) DELETE FROM assignment_files files
       USING doomed
       WHERE files.ctid = doomed.ctid`,
    [userId],
  );
  stats.enrollments = await deleteInBatches(
    `WITH doomed AS (
       SELECT ctid FROM enrollments WHERE user_id = $1::uuid LIMIT $2::int
     ) DELETE FROM enrollments enrollment USING doomed WHERE enrollment.ctid = doomed.ctid`,
    [userId],
  );
  stats.studySessions = await deleteInBatches(
    `WITH doomed AS (
       SELECT ctid FROM study_sessions WHERE user_id = $1::uuid LIMIT $2::int
     ) DELETE FROM study_sessions session USING doomed WHERE session.ctid = doomed.ctid`,
    [userId],
  );
  stats.notificationRecipients = await deleteInBatches(
    `WITH doomed AS (
       SELECT ctid FROM notification_recipients WHERE user_id = $1::uuid LIMIT $2::int
     ) DELETE FROM notification_recipients recipient USING doomed WHERE recipient.ctid = doomed.ctid`,
    [userId],
  );
  stats.teamMembers = await deleteInBatches(
    `WITH doomed AS (
       SELECT ctid FROM team_members WHERE user_id = $1::uuid LIMIT $2::int
     ) DELETE FROM team_members member USING doomed WHERE member.ctid = doomed.ctid`,
    [userId],
  );
  stats.permissionGroups = await deleteInBatches(
    `WITH doomed AS (
       SELECT ctid FROM user_permission_groups WHERE user_id = $1::uuid LIMIT $2::int
     ) DELETE FROM user_permission_groups membership USING doomed WHERE membership.ctid = doomed.ctid`,
    [userId],
  );
  stats.refreshTokens = await deleteInBatches(
    `WITH doomed AS (
       SELECT ctid FROM refresh_tokens WHERE user_id = $1::uuid LIMIT $2::int
     ) DELETE FROM refresh_tokens token USING doomed WHERE token.ctid = doomed.ctid`,
    [userId],
  );
  const ownershipReferences = await Promise.all([
    query(
      `UPDATE courses
       SET created_by = CASE WHEN created_by = $1::uuid THEN NULL ELSE created_by END,
           mentor_id = CASE WHEN mentor_id = $1::uuid THEN NULL ELSE mentor_id END
       WHERE created_by = $1::uuid OR mentor_id = $1::uuid`,
      [userId],
    ),
    query(`UPDATE course_assignments SET created_by = NULL WHERE created_by = $1::uuid`, [userId]),
    query(`UPDATE course_assets SET uploaded_by = NULL WHERE uploaded_by = $1::uuid`, [userId]),
    query(`UPDATE course_mentor_sections SET updated_by = NULL WHERE updated_by = $1::uuid`, [userId]),
    query(`UPDATE notifications SET sent_by = NULL WHERE sent_by = $1::uuid`, [userId]),
    query(
      `UPDATE assignment_submissions
       SET feedback_by = NULL,
           feedback_text = NULL,
           feedback_files = '[]'::jsonb,
           feedback_at = NULL
       WHERE feedback_by = $1::uuid`,
      [userId],
    ),
    query(`UPDATE chatbots SET created_by = NULL WHERE created_by = $1::uuid`, [userId]),
    query(`UPDATE knowledgebases SET created_by = NULL WHERE created_by = $1::uuid`, [userId]),
    query(`UPDATE kb_documents SET created_by = NULL WHERE created_by = $1::uuid`, [userId]),
    query(`UPDATE kb_restore_jobs SET requested_by = NULL WHERE requested_by = $1::uuid`, [userId]),
  ]);
  stats.nonFkOwnershipAnonymized = ownershipReferences.reduce((total, result) => total + (result.rowCount || 0), 0);
  const backupCleanup = await query<{ deleted: number }>(
    `SELECT public.purge_user_backup_pii($1::uuid) AS deleted`,
    [userId],
  );
  stats.reportBackups = Number(backupCleanup.rows[0]?.deleted || 0);
  const mentorHistory = await query(
    `UPDATE course_mentor_assignment_history
     SET assigned_by = CASE WHEN assigned_by = $1::uuid THEN NULL ELSE assigned_by END,
         assigned_to = CASE WHEN assigned_to = $1::uuid THEN NULL ELSE assigned_to END,
         assigned_by_display_name = CASE WHEN assigned_by = $1::uuid THEN '[deleted user]' ELSE assigned_by_display_name END,
         assigned_to_display_name = CASE WHEN assigned_to = $1::uuid THEN '[deleted user]' ELSE assigned_to_display_name END
     WHERE assigned_by = $1::uuid OR assigned_to = $1::uuid`,
    [userId],
  );
  stats.mentorHistoryAnonymized = mentorHistory.rowCount || 0;
  const result = await query(
    `DELETE FROM users WHERE id = $1::uuid AND deletion_requested_at IS NOT NULL`,
    [userId],
  );
  stats.user = result.rowCount || 0;
  if (stats.user !== 1) throw new Error('User row was not permanently deleted');
  return stats;
}

export async function runUserDeletionJob(jobId: string): Promise<void> {
  const job = await markJobRunning(jobId);
  if (!job) return;
  if (!job.user_id) {
    await markJobSucceeded(job.id, { alreadyCompleted: 1 });
    return;
  }

  const heartbeat = setInterval(() => {
    touchJobLease(job.id).catch((error) => console.error('[UserDelete] Lease heartbeat failed:', error));
  }, 60_000);
  heartbeat.unref();
  try {
    await createUserStorageManifest(job);
    const storageDeleted = await deleteStorageManifest('user', job.id);
    await touchJobLease(job.id);
    const stats = await purgeUserDatabase(job.user_id);
    stats.storageObjects = storageDeleted;
    await markJobSucceeded(job.id, stats);
  } finally {
    clearInterval(heartbeat);
  }
}

export async function requeuePendingUserDeletionJobs(limit = 100): Promise<void> {
  const result = await query<{ id: string }>(
    `SELECT id
     FROM user_deletion_jobs
     WHERE is_terminal = false
       AND (
         (status IN ('queued', 'failed') AND (next_attempt_at IS NULL OR next_attempt_at <= now()))
         OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at < now()))
       )
     ORDER BY requested_at ASC
     LIMIT $1::int`,
    [limit],
  );
  for (const row of result.rows) await publishUserDeletionJob(row.id);
}

/** Explicit operator retry for a job that exhausted the automatic retry budget. */
export async function retryTerminalUserDeletionJob(jobId: string, tenantId: string | null): Promise<void> {
  const result = await query<{ id: string; user_id: string }>(
    `UPDATE user_deletion_jobs
     SET status = 'queued',
         is_terminal = false,
         attempts = 0,
         started_at = NULL,
         finished_at = NULL,
         next_attempt_at = now(),
         lease_expires_at = NULL,
         last_error = NULL,
         updated_at = now()
     WHERE id = $1::uuid
       AND is_terminal = true
       AND user_id IS NOT NULL
       AND ($2::uuid IS NULL OR tenant_id = $2::uuid)
     RETURNING id, user_id`,
    [jobId, tenantId],
  );
  const job = result.rows[0];
  if (!job) throw new AppError('Không tìm thấy deletion job terminal để retry', 404);
  await query(
    `UPDATE users
     SET delete_status = 'queued'
     WHERE id = $1::uuid AND deletion_requested_at IS NOT NULL`,
    [job.user_id],
  );
  await publishUserDeletionJob(job.id);
}

export async function getUserDeletionJobStatus(jobId: string, tenantId: string | null) {
  const result = await query<{
    id: string;
    status: string;
    requested_at: Date;
    started_at: Date | null;
    finished_at: Date | null;
    attempts: number;
    is_terminal: boolean;
    next_attempt_at: Date | null;
    last_error: string | null;
    stats: Record<string, number>;
  }>(
    `SELECT id, status, requested_at, started_at, finished_at, attempts, is_terminal, next_attempt_at, last_error, stats
     FROM user_deletion_jobs
     WHERE id = $1::uuid AND ($2::uuid IS NULL OR tenant_id = $2::uuid)`,
    [jobId, tenantId],
  );
  if (result.rowCount === 0) throw new AppError('Không tìm thấy deletion job', 404);
  return result.rows[0];
}
