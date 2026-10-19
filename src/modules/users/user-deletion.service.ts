import type { PoolClient } from 'pg';
import { afterCommit, getClient, query, withDatabaseTransaction } from '../../config/database.js';
import { appendAuditLog, type TransactionalAuditEntry } from '../../middleware/audit-log.js';
import { env } from '../../config/env.js';
import { AppError } from '../../utils/errors.js';
import { parseExpiresIn } from '../../utils/jwt.js';
import { publish, QUEUES } from '../../config/rabbitmq/index.js';
import {
  deleteStorageManifest,
  registerStorageManifestPaths,
  registerUserAvatarStemManifestPaths,
} from '../deletion/storage-manifest.service.js';
import { extractStoragePath } from '../../config/storage.js';
import { cacheUserAccessRevocation } from '../auth/auth-revocation.service.js';
import { assertUserNotActiveDemoIframeAccount } from '../demo-login/demo-iframe.service.js';
import {
  assertCanDeleteUser,
  removesActiveSuperadmin,
  UserAuthorityError,
  type UserAuthorityActor,
  type UserAuthorityTarget,
} from './user-authority.logic.js';
import {
  createUserDeletionRepository,
  type AuthorityRow,
  type PurgeBatch,
  type TargetUserRow,
  type UserDeletionDb,
  type UserDeletionJobRow,
} from './user-deletion.repository.js';

// query() joins the caller's current transaction (runAuditedTransaction) when
// there is one; the getClient() transactions below use the repository over
// their own client.
const poolDb: UserDeletionDb = { query };
const deletionRepository = createUserDeletionRepository(poolDb);

const DELETE_BATCH_SIZE = 500;
const USER_JOB_LEASE_SECONDS = 15 * 60;

/** Narrow snapshot passed to the audit writer while the target row is locked. */
export type UserDeletionAuditTarget = Pick<TargetUserRow, 'username' | 'email' | 'full_name' | 'role'>;

function toAuthorityTarget(row: AuthorityRow): UserAuthorityTarget {
  return { id: row.id, role: row.role, tenantId: row.tenant_id, isActive: row.is_active };
}

/**
 * Locks and returns the target after the shared authority policy accepted the
 * deletion (self, superadmin-only, role level, tenant, last active superadmin
 * — the same rules as create/update/deactivate). Deleting an active superadmin
 * takes the superadmin-set lock BEFORE the row lock (the order updateUser
 * uses) and counts on post-lock state.
 */
async function lockDeletionTarget(client: PoolClient, targetId: string, actor: UserAuthorityActor): Promise<TargetUserRow> {
  const tx = createUserDeletionRepository(client);
  const preview = await tx.selectAuthorityPreview(targetId);
  let superadminSetLocked = false;
  if (preview && removesActiveSuperadmin(toAuthorityTarget(preview), 'delete')) {
    await tx.lockSuperadminSet();
    superadminSetLocked = true;
  }

  const target = await tx.lockTarget(targetId);
  if (!target) throw new AppError('User không tồn tại', 404);

  let activeSuperadminCount: number | undefined;
  if (removesActiveSuperadmin(toAuthorityTarget(target), 'delete')) {
    if (!superadminSetLocked) await tx.lockSuperadminSet();
    const counted = await tx.countActiveSuperadmins();
    activeSuperadminCount = Number(counted?.count ?? 0);
  }
  assertCanDeleteUser(actor, toAuthorityTarget(target), activeSuperadminCount);
  return target;
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
  actor: UserAuthorityActor,
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
    const target = await lockDeletionTarget(client, targetId, actor);
    await assertUserNotActiveDemoIframeAccount(targetId, 'Tài khoản learner demo iframe đang được khóa, không thể xóa');

    const tx = createUserDeletionRepository(client);
    const existing = await tx.lockOpenJob(targetId);
    if (existing) {
      if (existing.is_terminal) {
        throw new AppError('Deletion job trước đó đã dừng sau khi hết retry. Hãy dùng endpoint retry của job đó.', 409);
      }
      response = {
        jobId: existing.id,
        deletedUserName: target.username || target.email || target.id,
      };
      await client.query('COMMIT');
      return response;
    }
    // The worker deletes avatars only under a tenant folder; it could never finish
    // this job, so refuse it before the account is logged out and queued.
    if (!target.tenant_id && target.avatar_url) throw new UserAuthorityError('TENANTLESS_AVATAR_DELETE');

    const expiresAt = new Date(Date.now() + parseExpiresIn(env.JWT_ACCESS_EXPIRES_IN) + 60_000);
    await tx.upsertAuthRevocation(targetId, expiresAt);
    await tx.revokeRefreshTokens(targetId);
    // Cancel both mail addressed to this person and mail whose content belongs
    // to their submission before an outbox worker can pick it up.
    await tx.deleteOutboxMail(targetId);
    const jobId = await tx.insertJob(targetId, target.tenant_id, actor.id);
    await tx.markUserQueued(targetId, jobId);
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
    await client.query('ROLLBACK').catch(() => undefined); // fails only on a broken connection, which pg-pool discards
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
  return deletionRepository.claimJob(jobId, USER_JOB_LEASE_SECONDS);
}

async function touchJobLease(jobId: string): Promise<void> {
  await deletionRepository.extendLease(jobId, USER_JOB_LEASE_SECONDS);
}

export async function markUserDeletionJobRetryable(jobId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const job = await deletionRepository.markRetryable(jobId, message.slice(0, 4000), {
    maxAttempts: env.DELETION_MAX_ATTEMPTS,
    baseMs: env.DELETION_RETRY_BASE_MS,
    maxMs: env.DELETION_RETRY_MAX_MS,
  });
  if (job?.is_terminal && job.user_id) {
    await deletionRepository.markUserDeleteFailed(job.user_id);
    console.error(`[UserDelete] Job ${jobId} reached terminal failure after retry budget was exhausted`);
  }
}

async function markJobSucceeded(jobId: string, stats: Record<string, number>): Promise<void> {
  await withDatabaseTransaction(async (client) => {
    const tx = createUserDeletionRepository(client);
    // Successful user jobs must not retain a user-id-bearing storage path.
    await tx.deleteManifestItems(jobId);
    await tx.deleteScanCursors(jobId);
    await tx.markSucceeded(jobId, JSON.stringify(stats));
  });
}

async function deleteInBatches(batch: PurgeBatch, userId: string): Promise<number> {
  let total = 0;
  while (true) {
    const deleted = await deletionRepository.deleteUserRowsBatch(batch, userId, DELETE_BATCH_SIZE);
    total += deleted;
    if (deleted < DELETE_BATCH_SIZE) return total;
  }
}

async function createUserStorageManifest(job: UserDeletionJobRow): Promise<void> {
  if (!job.user_id) return;
  const alreadyComplete = await deletionRepository.selectManifestCompletedAt(job.id);
  if (alreadyComplete?.manifest_completed_at) return;

  const target = await deletionRepository.selectStorageOwner(job.user_id);
  if (!target) return;
  const tenantId = target.tenant_id;
  if (!tenantId) {
    if (target.avatar_url) {
      throw new Error('Cannot safely delete avatar for a user without tenant ownership');
    }
    return;
  }

  const fileStoragePaths = await deletionRepository.selectAssignmentFilePaths(job.user_id);
  const avatarPath = target.avatar_url ? extractStoragePath(target.avatar_url) : null;
  if (avatarPath && !avatarPath.startsWith(`${tenantId}/avatars/`)) {
    throw new Error('Unsafe or foreign avatar reference blocked user deletion');
  }
  const filePaths = fileStoragePaths.map((storagePath) => extractStoragePath(storagePath));
  if (filePaths.some((path) => !path || !path.startsWith(`${tenantId}/assignments/`))) {
    throw new Error('Unsafe or foreign assignment storage reference blocked user deletion');
  }
  const rawPaths = [avatarPath, ...filePaths].filter((value): value is string => Boolean(value));
  await registerStorageManifestPaths('user', job.id, tenantId, rawPaths);
  // Catches a successfully-uploaded avatar whose DB profile update failed.
  await registerUserAvatarStemManifestPaths(job.id, tenantId, job.user_id);

  const feedbackFiles = await deletionRepository.selectFeedbackFiles(job.user_id);
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
  for (const files of feedbackFiles) collectFeedbackPaths(files);
  await registerStorageManifestPaths('user', job.id, tenantId, [...feedbackPaths]);

  await deletionRepository.markManifestCompleted(job.id);
}

async function purgeUserDatabase(userId: string): Promise<Record<string, number>> {
  const stats: Record<string, number> = {};
  if (!(await deletionRepository.userExists(userId))) return { alreadyDeleted: 1 };
  stats.emailOutbox = await deleteInBatches('emailOutbox', userId);
  // Audit rows are retained for the agreed 30-day window. The FK on actor_id
  // sets it to NULL when the user is purged; immutable actor snapshots keep
  // the operational history intelligible until the retention cleanup runs.
  stats.auditActorLogsRetained = 0;
  stats.auditUserEntityLogsRetained = 0;
  stats.chatConversations = await deleteInBatches('chatConversations', userId);
  stats.assignmentSubmissions = await deleteInBatches('assignmentSubmissions', userId);
  stats.assignmentFeedbackHistory = await deleteInBatches('assignmentFeedbackHistory', userId);
  // A staff member may have uploaded feedback files without being the
  // submission learner (see the batch statement).
  stats.assignmentFiles = await deleteInBatches('assignmentFiles', userId);
  stats.enrollments = await deleteInBatches('enrollments', userId);
  stats.studySessions = await deleteInBatches('studySessions', userId);
  stats.notificationRecipients = await deleteInBatches('notificationRecipients', userId);
  stats.teamMembers = await deleteInBatches('teamMembers', userId);
  stats.permissionGroups = await deleteInBatches('permissionGroups', userId);
  stats.refreshTokens = await deleteInBatches('refreshTokens', userId);
  stats.nonFkOwnershipAnonymized = await deletionRepository.anonymizeOwnershipReferences(userId);
  const backupCleanup = await deletionRepository.purgeBackupPii(userId);
  stats.reportBackups = Number(backupCleanup?.deleted || 0);
  stats.mentorHistoryAnonymized = await deletionRepository.anonymizeMentorHistory(userId);
  stats.user = await deletionRepository.deleteUser(userId);
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
  const jobIds = await deletionRepository.selectRequeueJobIds(limit);
  for (const jobId of jobIds) await publishUserDeletionJob(jobId);
}

/** Explicit operator retry for a job that exhausted the automatic retry budget. */
export async function retryTerminalUserDeletionJob(jobId: string, tenantId: string | null): Promise<void> {
  const job = await deletionRepository.requeueTerminalJob(jobId, tenantId);
  if (!job) throw new AppError('Không tìm thấy deletion job terminal để retry', 404);
  await deletionRepository.markUserRequeued(job.user_id);
  // The retry endpoint runs this inside its audited transaction: the wake-up
  // is sent once that commits (a worker would otherwise find the job still
  // terminal) and never holds the transaction open. A message lost after the
  // commit is recovered by requeuePendingUserDeletionJobs().
  await afterCommit(() => publishUserDeletionJob(job.id));
}

export async function getUserDeletionJobStatus(jobId: string, tenantId: string | null) {
  const job = await deletionRepository.selectJobStatus(jobId, tenantId);
  if (!job) throw new AppError('Không tìm thấy deletion job', 404);
  return job;
}
