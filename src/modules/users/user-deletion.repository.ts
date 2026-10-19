// ═══════════════════════════════════════════════════════════════
// User deletion repository: the permanent deletion request (target lock,
// session revocation, queued job), the deletion job lifecycle, the storage
// manifest reads and the database purge of one user. SQL only; moved
// unchanged from user-deletion.service.ts, which keeps the rules (authority
// policy, demo lock, transactions, audit entry, storage manifest, retries,
// RabbitMQ wake-ups).
// ═══════════════════════════════════════════════════════════════

import type { QueryResult, QueryResultRow } from 'pg';
import { ACTIVE_SUPERADMIN_COUNT_SQL, SUPERADMIN_SET_LOCK_SQL } from './user-authority.logic.js';

/** The pool query() or a transaction client (PoolClient). */
export interface UserDeletionDb {
  query<T extends QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export type UserDeletionJobRow = {
  id: string;
  user_id: string | null;
  tenant_id: string | null;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  attempts: number;
  is_terminal: boolean;
};

export type TargetUserRow = {
  id: string;
  username: string | null;
  email: string | null;
  full_name: string | null;
  role: string;
  tenant_id: string | null;
  avatar_url: string | null;
  is_active: boolean;
};

export type AuthorityRow = Pick<TargetUserRow, 'id' | 'role' | 'tenant_id' | 'is_active'>;

export interface UserDeletionJobStatusRow {
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
}

export interface RetryBudget {
  maxAttempts: number;
  baseMs: number;
  maxMs: number;
}

/** The rows of one user the purge deletes in batches (`$1` user, `$2` batch size). */
const PURGE_BATCH_SQL = {
  emailOutbox: `WITH doomed AS (
       SELECT ctid
       FROM email_outbox
       WHERE recipient_user_id = $1::uuid
          OR related_submission_id IN (
            SELECT id FROM assignment_submissions WHERE learner_id = $1::uuid
          )
       LIMIT $2::int
     ) DELETE FROM email_outbox e USING doomed WHERE e.ctid = doomed.ctid`,
  chatConversations: `WITH doomed AS (
       SELECT ctid FROM chat_conversations WHERE user_id = $1::uuid LIMIT $2::int
     ) DELETE FROM chat_conversations c USING doomed WHERE c.ctid = doomed.ctid`,
  assignmentSubmissions: `WITH doomed AS (
       SELECT ctid FROM assignment_submissions WHERE learner_id = $1::uuid LIMIT $2::int
     ) DELETE FROM assignment_submissions s USING doomed WHERE s.ctid = doomed.ctid`,
  assignmentFeedbackHistory: `WITH doomed AS (
       SELECT ctid
       FROM assignment_feedback_history
       WHERE learner_id = $1::uuid OR feedback_by = $1::uuid
       LIMIT $2::int
     ) DELETE FROM assignment_feedback_history history
       USING doomed
       WHERE history.ctid = doomed.ctid`,
  // A staff member may have uploaded feedback files without being the
  // submission learner. Their storage paths were captured in the manifest;
  // remove the database records explicitly instead of relying on a learner
  // submission cascade that does not cover this ownership case.
  assignmentFiles: `WITH doomed AS (
       SELECT ctid
       FROM assignment_files
       WHERE uploaded_by = $1::uuid
       LIMIT $2::int
     ) DELETE FROM assignment_files files
       USING doomed
       WHERE files.ctid = doomed.ctid`,
  enrollments: `WITH doomed AS (
       SELECT ctid FROM enrollments WHERE user_id = $1::uuid LIMIT $2::int
     ) DELETE FROM enrollments enrollment USING doomed WHERE enrollment.ctid = doomed.ctid`,
  studySessions: `WITH doomed AS (
       SELECT ctid FROM study_sessions WHERE user_id = $1::uuid LIMIT $2::int
     ) DELETE FROM study_sessions session USING doomed WHERE session.ctid = doomed.ctid`,
  notificationRecipients: `WITH doomed AS (
       SELECT ctid FROM notification_recipients WHERE user_id = $1::uuid LIMIT $2::int
     ) DELETE FROM notification_recipients recipient USING doomed WHERE recipient.ctid = doomed.ctid`,
  teamMembers: `WITH doomed AS (
       SELECT ctid FROM team_members WHERE user_id = $1::uuid LIMIT $2::int
     ) DELETE FROM team_members member USING doomed WHERE member.ctid = doomed.ctid`,
  permissionGroups: `WITH doomed AS (
       SELECT ctid FROM user_permission_groups WHERE user_id = $1::uuid LIMIT $2::int
     ) DELETE FROM user_permission_groups membership USING doomed WHERE membership.ctid = doomed.ctid`,
  refreshTokens: `WITH doomed AS (
       SELECT ctid FROM refresh_tokens WHERE user_id = $1::uuid LIMIT $2::int
     ) DELETE FROM refresh_tokens token USING doomed WHERE token.ctid = doomed.ctid`,
} as const;

export type PurgeBatch = keyof typeof PURGE_BATCH_SQL;

export function createUserDeletionRepository(db: UserDeletionDb) {
  return {
    // ── Request ──

    /** Role, tenant and status of the target, unlocked (decides whether the superadmin set lock comes first). */
    async selectAuthorityPreview(targetId: string): Promise<AuthorityRow | undefined> {
      const preview = await db.query<AuthorityRow>(
        'SELECT id, role, tenant_id, is_active FROM users WHERE id = $1',
        [targetId],
      );
      return preview.rows[0];
    },

    /** Serializes every write that can shrink the active superadmin set (until commit). */
    async lockSuperadminSet(): Promise<void> {
      await db.query(SUPERADMIN_SET_LOCK_SQL);
    },

    /** The target with trimmed names, row-locked (FOR UPDATE) until commit. */
    async lockTarget(targetId: string): Promise<TargetUserRow | null> {
      const targetResult = await db.query<TargetUserRow>(
        `SELECT id,
            NULLIF(btrim(username), '') AS username,
            NULLIF(lower(btrim(email)), '') AS email,
            NULLIF(btrim(full_name), '') AS full_name,
            role, tenant_id, avatar_url, is_active
     FROM users
     WHERE id = $1
     FOR UPDATE`,
        [targetId],
      );
      return targetResult.rowCount === 0 ? null : targetResult.rows[0];
    },

    async countActiveSuperadmins(): Promise<{ count: number | string } | undefined> {
      const counted = await db.query<{ count: number | string }>(ACTIVE_SUPERADMIN_COUNT_SQL);
      return counted.rows[0];
    },

    /** The target's newest unfinished job, row-locked (FOR UPDATE) until commit. */
    async lockOpenJob(targetId: string): Promise<{ id: string; is_terminal: boolean } | undefined> {
      const existing = await db.query<{ id: string; is_terminal: boolean }>(
        `SELECT id, is_terminal
       FROM user_deletion_jobs
       WHERE user_id = $1::uuid
         AND status IN ('queued', 'running', 'failed')
       ORDER BY requested_at DESC
       LIMIT 1
       FOR UPDATE`,
        [targetId],
      );
      return existing.rowCount && existing.rows[0] ? existing.rows[0] : undefined;
    },

    /** Refuses every access token of the user issued before now, until `expiresAt`. */
    async upsertAuthRevocation(targetId: string, expiresAt: Date): Promise<void> {
      await db.query(
        `INSERT INTO auth_revocations (user_id, revoked_at, expires_at, reason)
       VALUES ($1::uuid, now(), $2::timestamptz, 'permanent_user_deletion')
       ON CONFLICT (user_id)
       DO UPDATE SET revoked_at = EXCLUDED.revoked_at, expires_at = EXCLUDED.expires_at, reason = EXCLUDED.reason`,
        [targetId, expiresAt],
      );
    },

    async revokeRefreshTokens(targetId: string): Promise<void> {
      await db.query(
        `UPDATE refresh_tokens
       SET revoked = true, revoked_at = COALESCE(revoked_at, now())
       WHERE user_id = $1::uuid AND revoked = false`,
        [targetId],
      );
    },

    /** Cancels mail addressed to the user and mail whose content belongs to their submissions. */
    async deleteOutboxMail(targetId: string): Promise<void> {
      await db.query(
        `DELETE FROM email_outbox
       WHERE recipient_user_id = $1::uuid
          OR related_submission_id IN (
            SELECT id FROM assignment_submissions WHERE learner_id = $1::uuid
          )`,
        [targetId],
      );
    },

    /** A queued deletion job; its id. */
    async insertJob(targetId: string, tenantId: string | null, requestedBy: string): Promise<string> {
      const jobResult = await db.query<{ id: string }>(
        `INSERT INTO user_deletion_jobs (user_id, tenant_id, requested_by)
       VALUES ($1::uuid, $2::uuid, $3::uuid)
       RETURNING id`,
        [targetId, tenantId, requestedBy],
      );
      return jobResult.rows[0].id;
    },

    /** Deactivates the user and marks the deletion as queued under `jobId`. */
    async markUserQueued(targetId: string, jobId: string): Promise<void> {
      await db.query(
        `UPDATE users
       SET is_active = false,
           deletion_requested_at = now(),
           delete_status = 'queued',
           delete_job_id = $2::uuid
       WHERE id = $1::uuid`,
        [targetId, jobId],
      );
    },

    // ── Job lifecycle ──

    /** Claims a due, non-terminal job (or one whose lease expired) for `leaseSeconds`. */
    async claimJob(jobId: string, leaseSeconds: number): Promise<UserDeletionJobRow | null> {
      const result = await db.query<UserDeletionJobRow>(
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
        [jobId, leaseSeconds],
      );
      return result.rows[0] ?? null;
    },

    async extendLease(jobId: string, leaseSeconds: number): Promise<void> {
      await db.query(
        `UPDATE user_deletion_jobs
     SET lease_expires_at = now() + ($2::int * interval '1 second'), updated_at = now()
     WHERE id = $1::uuid AND status = 'running'`,
        [jobId, leaseSeconds],
      );
    },

    /**
     * Puts a running job back in the queue with capped exponential backoff
     * and jitter, or makes it terminal once the attempts are spent.
     */
    async markRetryable(
      jobId: string,
      message: string,
      budget: RetryBudget,
    ): Promise<{ user_id: string | null; is_terminal: boolean } | undefined> {
      const result = await db.query<{ user_id: string | null; is_terminal: boolean }>(
        `UPDATE user_deletion_jobs
     SET status = CASE WHEN attempts >= $3::int THEN 'failed' ELSE 'queued' END,
         is_terminal = attempts >= $3::int,
         lease_expires_at = NULL,
         next_attempt_at = CASE
           -- The schema deliberately keeps this non-null. Terminal jobs are
           -- excluded by is_terminal, so a timestamp here cannot requeue one.
           WHEN attempts >= $3::int THEN now()
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
        [jobId, message, budget.maxAttempts, budget.baseMs, budget.maxMs],
      );
      return result.rows[0];
    },

    async markUserDeleteFailed(userId: string): Promise<void> {
      await db.query(
        `UPDATE users
       SET delete_status = 'failed'
       WHERE id = $1::uuid AND deletion_requested_at IS NOT NULL`,
        [userId],
      );
    },

    /** Successful user jobs must not retain a user-id-bearing storage path. */
    async deleteManifestItems(jobId: string): Promise<void> {
      await db.query(
        `DELETE FROM deletion_storage_items
       WHERE job_kind = 'user' AND job_id = $1::uuid`,
        [jobId],
      );
    },

    async deleteScanCursors(jobId: string): Promise<void> {
      await db.query(
        `DELETE FROM deletion_storage_scan_cursors
       WHERE job_kind = 'user' AND job_id = $1::uuid`,
        [jobId],
      );
    },

    /** Marks the job succeeded and forgets the user id. */
    async markSucceeded(jobId: string, stats: string): Promise<void> {
      await db.query(
        `UPDATE user_deletion_jobs
       SET status = 'succeeded',
           user_id = NULL,
           is_terminal = false,
           lease_expires_at = NULL,
           finished_at = now(),
           next_attempt_at = now(),
           stats = $2::jsonb,
           last_error = NULL,
           updated_at = now()
       WHERE id = $1::uuid`,
        [jobId, stats],
      );
    },

    /** Unfinished jobs that are due (or whose lease expired), oldest first. */
    async selectRequeueJobIds(limit: number): Promise<string[]> {
      const result = await db.query<{ id: string }>(
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
      return result.rows.map((row) => row.id);
    },

    /** Requeues a terminal job of the tenant scope (null = every tenant); its user, or undefined. */
    async requeueTerminalJob(jobId: string, tenantId: string | null): Promise<{ id: string; user_id: string } | undefined> {
      const result = await db.query<{ id: string; user_id: string }>(
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
      return result.rows[0];
    },

    async markUserRequeued(userId: string): Promise<void> {
      await db.query(
        `UPDATE users
     SET delete_status = 'queued'
     WHERE id = $1::uuid AND deletion_requested_at IS NOT NULL`,
        [userId],
      );
    },

    /** The job of the tenant scope (null = every tenant). */
    async selectJobStatus(jobId: string, tenantId: string | null): Promise<UserDeletionJobStatusRow | null> {
      const result = await db.query<UserDeletionJobStatusRow>(
        `SELECT id, status, requested_at, started_at, finished_at, attempts, is_terminal, next_attempt_at, last_error, stats
     FROM user_deletion_jobs
     WHERE id = $1::uuid AND ($2::uuid IS NULL OR tenant_id = $2::uuid)`,
        [jobId, tenantId],
      );
      return result.rowCount === 0 ? null : result.rows[0];
    },

    // ── Storage manifest reads ──

    async selectManifestCompletedAt(jobId: string): Promise<{ manifest_completed_at: Date | null } | undefined> {
      const alreadyComplete = await db.query<{ manifest_completed_at: Date | null }>(
        `SELECT manifest_completed_at
     FROM user_deletion_jobs
     WHERE id = $1::uuid`,
        [jobId],
      );
      return alreadyComplete.rows[0];
    },

    async selectStorageOwner(userId: string): Promise<{ tenant_id: string | null; avatar_url: string | null } | null> {
      const target = await db.query<{ tenant_id: string | null; avatar_url: string | null }>(
        `SELECT tenant_id, avatar_url FROM users WHERE id = $1::uuid`,
        [userId],
      );
      return target.rowCount === 0 ? null : target.rows[0];
    },

    /** Storage paths of the user's submission files and of files the user uploaded. */
    async selectAssignmentFilePaths(userId: string): Promise<string[]> {
      const fileRows = await db.query<{ storage_path: string }>(
        `SELECT af.storage_path
     FROM assignment_files af
     JOIN assignment_submissions submission ON submission.id = af.submission_id
     WHERE submission.learner_id = $1::uuid OR af.uploaded_by = $1::uuid`,
        [userId],
      );
      return fileRows.rows.map((row) => row.storage_path);
    },

    /** Feedback files (JSON values) of feedback the user received or gave. */
    async selectFeedbackFiles(userId: string): Promise<unknown[]> {
      const feedbackRows = await db.query<{ feedback_files: unknown }>(
        `SELECT feedback_files
     FROM assignment_feedback_history
     WHERE learner_id = $1::uuid OR feedback_by = $1::uuid`,
        [userId],
      );
      return feedbackRows.rows.map((row) => row.feedback_files);
    },

    async markManifestCompleted(jobId: string): Promise<void> {
      await db.query(
        `UPDATE user_deletion_jobs
     SET manifest_completed_at = now(), updated_at = now()
     WHERE id = $1::uuid AND status = 'running'`,
        [jobId],
      );
    },

    // ── Purge ──

    async userExists(userId: string): Promise<boolean> {
      const user = await db.query<{ id: string }>('SELECT id FROM users WHERE id = $1::uuid', [userId]);
      return user.rowCount !== 0;
    },

    /** Deletes at most `batchSize` rows of one kind; the number deleted. */
    async deleteUserRowsBatch(batch: PurgeBatch, userId: string, batchSize: number): Promise<number> {
      const result = await db.query(PURGE_BATCH_SQL[batch], [userId, batchSize]);
      return result.rowCount || 0;
    },

    /** Clears the user from ownership columns without a foreign key; the number of rows changed. */
    async anonymizeOwnershipReferences(userId: string): Promise<number> {
      const ownershipReferences = await Promise.all([
        db.query(
          `UPDATE courses
       SET created_by = CASE WHEN created_by = $1::uuid THEN NULL ELSE created_by END,
           mentor_id = CASE WHEN mentor_id = $1::uuid THEN NULL ELSE mentor_id END
       WHERE created_by = $1::uuid OR mentor_id = $1::uuid`,
          [userId],
        ),
        db.query(`UPDATE course_assignments SET created_by = NULL WHERE created_by = $1::uuid`, [userId]),
        db.query(`UPDATE course_assets SET uploaded_by = NULL WHERE uploaded_by = $1::uuid`, [userId]),
        db.query(`UPDATE course_mentor_sections SET updated_by = NULL WHERE updated_by = $1::uuid`, [userId]),
        db.query(`UPDATE notifications SET sent_by = NULL WHERE sent_by = $1::uuid`, [userId]),
        db.query(
          `UPDATE assignment_submissions
       SET feedback_by = NULL,
           feedback_text = NULL,
           feedback_files = '[]'::jsonb,
           feedback_at = NULL
       WHERE feedback_by = $1::uuid`,
          [userId],
        ),
        db.query(`UPDATE chatbots SET created_by = NULL WHERE created_by = $1::uuid`, [userId]),
        db.query(`UPDATE knowledgebases SET created_by = NULL WHERE created_by = $1::uuid`, [userId]),
        db.query(`UPDATE kb_documents SET created_by = NULL WHERE created_by = $1::uuid`, [userId]),
        db.query(`UPDATE kb_restore_jobs SET requested_by = NULL WHERE requested_by = $1::uuid`, [userId]),
      ]);
      return ownershipReferences.reduce((total, result) => total + (result.rowCount || 0), 0);
    },

    /** Removes the user's personal data from report backups; the number removed (undefined without a row). */
    async purgeBackupPii(userId: string): Promise<{ deleted: number } | undefined> {
      const backupCleanup = await db.query<{ deleted: number }>(
        `SELECT public.purge_user_backup_pii($1::uuid) AS deleted`,
        [userId],
      );
      return backupCleanup.rows[0];
    },

    /** Replaces the user in mentor assignment history by '[deleted user]'; the number of rows changed. */
    async anonymizeMentorHistory(userId: string): Promise<number> {
      const mentorHistory = await db.query(
        `UPDATE course_mentor_assignment_history
     SET assigned_by = CASE WHEN assigned_by = $1::uuid THEN NULL ELSE assigned_by END,
         assigned_to = CASE WHEN assigned_to = $1::uuid THEN NULL ELSE assigned_to END,
         assigned_by_display_name = CASE WHEN assigned_by = $1::uuid THEN '[deleted user]' ELSE assigned_by_display_name END,
         assigned_to_display_name = CASE WHEN assigned_to = $1::uuid THEN '[deleted user]' ELSE assigned_to_display_name END
     WHERE assigned_by = $1::uuid OR assigned_to = $1::uuid`,
        [userId],
      );
      return mentorHistory.rowCount || 0;
    },

    /** Deletes the user row of a requested deletion; the number deleted. */
    async deleteUser(userId: string): Promise<number> {
      const result = await db.query(
        `DELETE FROM users WHERE id = $1::uuid AND deletion_requested_at IS NOT NULL`,
        [userId],
      );
      return result.rowCount || 0;
    },
  };
}
