import app from './app.js';
import { env } from './config/env.js';
import { cleanupExpiredTokens } from './modules/auth/auth.service.js';
import { ensureBucket } from './config/storage.js';
import { getClient, query } from './config/database.js';
import { closeRedis, connectRedis, getRedisClient } from './config/redis.js';
import { connectRabbitMQ, assertQueue, closeRabbitMQ, QUEUES } from './config/rabbitmq/index.js';
import { startUploadWorker } from './modules/ai-chatbot/upload.worker.js';
import { startDeleteWorker } from './modules/ai-chatbot/delete.worker.js';
import { startRestoreWorker } from './modules/ai-chatbot/restore.worker.js';
import { startKbOperationWorker } from './modules/ai-chatbot/kb-operation.worker.js';
import { startCourseDeletionWorker } from './modules/course-deletion/course-deletion.worker.js';
import { startUserDeletionWorker } from './modules/users/user-deletion.worker.js';
import { startEmailOutboxRabbitConsumer } from './modules/assignments/email-outbox.service.js';
import { startCourseProgressRecalculationWorker } from './modules/learner/progress-recalculation.worker.js';
import { cleanupExpiredAuthRevocations } from './modules/auth/auth-revocation.service.js';
import fs from 'fs/promises';

const AUDIT_LOG_RETENTION_DAYS = 30;
const AUDIT_LOG_RETENTION_BATCH_SIZE = 5000;
const AUDIT_LOG_RETENTION_MAX_BATCHES = 5;
const DELETION_JOB_RETENTION_BATCH_SIZE = 1000;

/** Remove only completed deletion metadata; failed jobs remain actionable for retry. */
async function cleanupCompletedDeletionJobs(): Promise<number> {
  const statements = [
    `WITH doomed AS (
       SELECT ctid
       FROM course_deletion_jobs
       WHERE status = 'succeeded'
         AND finished_at < now() - ($1::int * interval '1 day')
       ORDER BY finished_at ASC
       LIMIT $2::int
     ) DELETE FROM course_deletion_jobs job USING doomed WHERE job.ctid = doomed.ctid`,
    `WITH doomed AS (
       SELECT ctid
       FROM user_deletion_jobs
       WHERE status = 'succeeded'
         AND finished_at < now() - ($1::int * interval '1 day')
       ORDER BY finished_at ASC
       LIMIT $2::int
     ) DELETE FROM user_deletion_jobs job USING doomed WHERE job.ctid = doomed.ctid`,
  ];
  let deleted = 0;
  for (const statement of statements) {
    const result = await query(statement, [env.DELETION_JOB_RETENTION_DAYS, DELETION_JOB_RETENTION_BATCH_SIZE]);
    deleted += result.rowCount || 0;
  }
  return deleted;
}

/**
 * Xóa audit logs cũ hơn 30 ngày theo batch nhỏ để tránh lock/bloat khi bảng có hàng triệu dòng.
 * Chạy 1 lần khi start + mỗi 24 giờ.
 */
async function cleanupOldAuditLogs(): Promise<number> {
  const client = await getClient();
  const lockKey = 'audit_logs:retention-cleanup';
  let lockHeld = false;
  let totalDeleted = 0;
  try {
    const lock = await client.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_lock(hashtext($1)) AS acquired`,
      [lockKey],
    );
    lockHeld = lock.rows[0]?.acquired === true;
    if (!lockHeld) return 0;

    for (let batch = 0; batch < AUDIT_LOG_RETENTION_MAX_BATCHES; batch += 1) {
      const result = await client.query(
        `DELETE FROM audit_logs
         WHERE ctid IN (
           SELECT ctid
           FROM audit_logs
           WHERE created_at < now() - ($1::int * interval '1 day')
           ORDER BY created_at ASC, id ASC
           LIMIT $2::int
         )`,
        [AUDIT_LOG_RETENTION_DAYS, AUDIT_LOG_RETENTION_BATCH_SIZE],
      );
      const deleted = result.rowCount || 0;
      totalDeleted += deleted;
      if (deleted < AUDIT_LOG_RETENTION_BATCH_SIZE) break;
    }
    return totalDeleted;
  } finally {
    if (lockHeld) await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [lockKey]).catch(() => undefined);
    client.release();
  }
}

async function runAuditLogRetentionCleanup(trigger: 'startup' | 'daily'): Promise<void> {
  const startedAt = Date.now();
  try {
    const deleted = await cleanupOldAuditLogs();
    console.log(`[Audit] Retention cleanup (${trigger}) completed: deleted=${deleted}, duration_ms=${Date.now() - startedAt}`);
  } catch (err) {
    console.error(`[Audit] Retention cleanup (${trigger}) failed:`, err);
  }
}

/**
 * Init RabbitMQ — MANDATORY. Crash if cannot connect.
 */
async function initRabbitMQ(): Promise<void> {
  try {
    await connectRabbitMQ(env.RABBITMQ_URL);
    // Assert queues (creates if not exists)
    await assertQueue(QUEUES.GEMINI_UPLOAD);
    await assertQueue(QUEUES.GEMINI_DELETE);
    await assertQueue(QUEUES.GEMINI_RESTORE);
    await assertQueue(QUEUES.COURSE_DELETE);
    await assertQueue(QUEUES.USER_DELETE);
    await assertQueue(QUEUES.EMAIL_OUTBOX);
    await assertQueue(QUEUES.COURSE_PROGRESS_RECALC);
    console.log(`[RabbitMQ] Queues ready: ${QUEUES.GEMINI_UPLOAD}, ${QUEUES.GEMINI_DELETE}, ${QUEUES.GEMINI_RESTORE}, ${QUEUES.COURSE_DELETE}, ${QUEUES.USER_DELETE}, ${QUEUES.EMAIL_OUTBOX}, ${QUEUES.COURSE_PROGRESS_RECALC}`);

    // Start consumers (workers)
    await startUploadWorker();
    await startDeleteWorker();
    await startRestoreWorker();
    await startKbOperationWorker();
    await startCourseDeletionWorker();
    await startUserDeletionWorker();
    await startCourseProgressRecalculationWorker();
    if (env.EMAIL_OUTBOX_INLINE_WORKER_ENABLED) {
      await startEmailOutboxRabbitConsumer();
    }
    console.log('[RabbitMQ] All workers started');
  } catch (err: any) {
    console.error(`[RabbitMQ] FATAL: ${err.message}`);
    console.error('[RabbitMQ] Server cannot start without RabbitMQ. Exiting.');
    process.exit(1);
  }
}

// ── Bootstrap ──
async function bootstrap() {
  // 1. Init RabbitMQ (MUST succeed — crash otherwise)
  await initRabbitMQ();
  await connectRedis();
  if (env.isProduction && env.AUTH_REVOCATION_REQUIRE_REDIS_IN_PRODUCTION && !getRedisClient()) {
    throw new Error('Redis is required in production for constant-time durable access-token revocation. Configure REDIS_URL or explicitly set AUTH_REVOCATION_REQUIRE_REDIS_IN_PRODUCTION=false after accepting the database fallback load.');
  }

  // 2. Ensure temp dir for Gemini worker
  try {
    await fs.mkdir(env.GEMINI_TEMP_DIR, { recursive: true });
  } catch { /* ignore */ }

  // 3. Start Express server
  app.listen(env.PORT, async function onListen() {
    console.log(`[Server] LANDA Backend running on port ${env.PORT}`);
    console.log(`[Server] Environment: ${env.NODE_ENV}`);
    console.log(`[Server] CORS origin: ${env.CORS_ORIGIN}`);

    // Ensure storage bucket exists
    try {
      await ensureBucket();
      console.log(`[Storage] Bucket ready`);
    } catch (err) {
      console.error('[Storage] Bucket init failed:', err);
    }

    // Dọn tokens ngay khi start
    try {
      const deleted = await cleanupExpiredTokens();
      if (deleted > 0) console.log(`[Cleanup] Startup: removed ${deleted} expired/revoked tokens`);
    } catch { /* ignore */ }

    try {
      const deleted = await cleanupExpiredAuthRevocations();
      if (deleted > 0) console.log(`[Cleanup] Startup: removed ${deleted} expired access revocations`);
    } catch { /* ignore */ }

    try {
      const deleted = await cleanupCompletedDeletionJobs();
      if (deleted > 0) console.log(`[Cleanup] Startup: removed ${deleted} completed deletion job records`);
    } catch { /* ignore */ }

    // Dọn audit logs cũ ngay khi start và ghi kết quả, kể cả khi không có bản ghi bị xóa.
    await runAuditLogRetentionCleanup('startup');
  });
}

bootstrap().catch(err => {
  console.error('[Bootstrap] Fatal error:', err);
  process.exit(1);
});

// Dọn refresh tokens hết hạn mỗi 6 giờ
setInterval(async function cleanupTokens() {
  try {
    const deleted = await cleanupExpiredTokens();
    if (deleted > 0) {
      console.log(`[Cleanup] Removed ${deleted} expired/revoked refresh tokens`);
    }
  } catch (err) {
    console.error('[Cleanup] Error:', err);
  }
}, 6 * 60 * 60 * 1000);

// Keep deletion metadata only for a finite operational support window.
setInterval(async function cleanupDeletionJobs() {
  try {
    const deleted = await cleanupCompletedDeletionJobs();
    if (deleted > 0) console.log(`[Cleanup] Removed ${deleted} completed deletion job records`);
  } catch (err) {
    console.error('[Cleanup] Deletion job cleanup error:', err);
  }
}, 24 * 60 * 60 * 1000);

// Access-token revocations only need to live through the maximum access-token TTL.
setInterval(async function cleanupAccessRevocations() {
  try {
    const deleted = await cleanupExpiredAuthRevocations();
    if (deleted > 0) console.log(`[Cleanup] Removed ${deleted} expired access revocations`);
  } catch (err) {
    console.error('[Cleanup] Access revocation cleanup error:', err);
  }
}, 6 * 60 * 60 * 1000);

// Dọn audit logs cũ hơn 30 ngày — chạy mỗi 24 giờ
setInterval(async function cleanupAuditLogs() {
  await runAuditLogRetentionCleanup('daily');
}, 24 * 60 * 60 * 1000);

// Graceful shutdown
async function gracefulShutdown(signal: string) {
  console.log(`[Server] ${signal} received, shutting down...`);
  await closeRedis();
  await closeRabbitMQ();
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
