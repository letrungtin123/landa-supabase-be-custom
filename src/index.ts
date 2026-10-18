import type { Server } from 'node:http';
import app from './app.js';
import { env } from './config/env.js';
import { createGracefulShutdown } from './config/graceful-shutdown.js';
import { processLifecycle, stopOnShutdown } from './config/process-lifecycle.js';
import { cleanupExpiredTokens } from './modules/auth/auth.service.js';
import { ensureBucket } from './config/storage.js';
import { endSessionPool, getSessionClient, pool, query } from './config/database.js';
import { endReportsPool } from './config/reports-database.js';
import { logDatabaseConnectionHeadroom, ownDirectConnectionMax } from './config/database-headroom.js';
import { closeRedis, connectRedis, getRedisClient } from './config/redis.js';
import { connectRabbitMQ, assertQueue, cancelConsumers, closeRabbitMQ, QUEUES } from './config/rabbitmq/index.js';
import { processRolePlan, signalProcessReady } from './config/process-role.js';
import { shutdownStepsFor, startProcess } from './config/process-startup.js';
import { clusterBus } from './config/cluster-bus.js';
import { COURSE_ASSET_TEMP_MAX_AGE_MS, cleanupStaleCourseAssetTempFiles } from './modules/course-authoring/course-asset-temp.js';
import { cleanupStaleReportExportSpools } from './modules/reports/report-export-flow.js';
import { startUploadWorker } from './modules/ai-chatbot/upload.worker.js';
import { startRestoreWorker } from './modules/ai-chatbot/restore.worker.js';
import { startKbOperationWorker } from './modules/ai-chatbot/kb-operation.worker.js';
import { startLessonAuthorTranscriptionWorker } from './modules/ai-chatbot/lesson-author-transcription.worker.js';
import { startDurableBlueprintWorker, stopDurableBlueprintWorker } from './modules/ai-chatbot/lesson-author-durable-blueprint.service.js';
import { startLessonAuthorWorkspaceWorker, stopLessonAuthorWorkspaceWorker } from './modules/ai-chatbot/lesson-author-workspace-runtime.service.js';
import { startChapterCheckpointMaintenance, stopChapterCheckpointMaintenance } from './modules/ai-chatbot/lesson-author-chapter-runtime.service.js';
import { shutdownReportPdfRenderer } from './modules/ai-chatbot/report-pdf-renderer.service.js';
import { startAiEngineTransitionWorker } from './modules/ai-chatbot/ai-engine-transition.worker.js';
import { startCourseDeletionWorker } from './modules/course-deletion/course-deletion.worker.js';
import { startUserDeletionWorker } from './modules/users/user-deletion.worker.js';
import { startLessonAuthorSessionDeletionWorker } from './modules/ai-chatbot/lesson-author-session-deletion.worker.js';
import { startEmailOutboxRabbitConsumer, stopEmailOutboxWorker } from './modules/assignments/email-outbox.service.js';
import { workspaceCommitHub } from './modules/ai-chatbot/lesson-author-workspace-stream.service.js';
import { sourceDocumentHub } from './modules/ai-chatbot/lesson-author-source-stream.service.js';
import { startCourseProgressRecalculationWorker } from './modules/learner/progress-recalculation.worker.js';
import {
  assertAuthRevocationRedisReady,
  cleanupExpiredAuthRevocations,
  resyncAccessRevocationMirror,
} from './modules/auth/auth-revocation.service.js';
import { runtimeTenantDiagnostics } from './config/runtime-tenant-fence.js';
import fs from 'fs/promises';
import { startAiTokenReservationSweeper } from './modules/ai-chatbot/ai-token-quota.service.js';
import { logSwallowedError } from './utils/best-effort.js';

const AUDIT_LOG_RETENTION_DAYS = 30;
const AUDIT_LOG_RETENTION_BATCH_SIZE = 5000;
const AUDIT_LOG_RETENTION_MAX_BATCHES = 5;
const DELETION_JOB_RETENTION_BATCH_SIZE = 1000;
// The API streams course assets from a temporary file to Storage after the
// multipart body has arrived. Keep the HTTP ceiling long enough for the
// documented large-upload gateway, while the gateway still enforces short
// header/body-idle timeouts and the API enforces auth, RBAC, and rate limits.
const LARGE_ASSET_REQUEST_TIMEOUT_MS = 20 * 60 * 1000;
// Idle keep-alive sockets stay open longer than the gateways in front of the
// API keep theirs (nginx/Kong 60 s), so the API never closes a socket a proxy
// is about to reuse (that race shows up as 502/520). Headers must arrive
// slightly later than that.
const KEEP_ALIVE_TIMEOUT_MS = 65 * 1000;
const REQUEST_HEADERS_TIMEOUT_MS = 66 * 1000;
// Course asset temp residue (background process only; see course-asset-temp.ts).
const COURSE_ASSET_TEMP_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

let httpServer: Server | null = null;

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
    `WITH doomed AS (
       SELECT ctid
       FROM lesson_author_session_deletion_jobs
       WHERE status = 'succeeded'
         AND is_terminal = TRUE
         AND finished_at < now() - ($1::int * interval '1 day')
       ORDER BY finished_at ASC
       LIMIT $2::int
     ) DELETE FROM lesson_author_session_deletion_jobs job USING doomed WHERE job.ctid = doomed.ctid`,
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
  // Session advisory lock: a direct session (getSessionClient), never a pooled one.
  const client = await getSessionClient();
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
    // Fails only with a broken connection, whose session (and so the lock) ends with it.
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
 * Init RabbitMQ — MANDATORY. Crash if cannot connect (every role).
 * `consumers`: also start the queue consumers (processes that run the
 * background work); an API process only publishes.
 */
async function initRabbitMQ(consumers: boolean): Promise<void> {
  try {
    await connectRabbitMQ(env.RABBITMQ_URL);
    // Assert queues (creates if not exists)
    await assertQueue(QUEUES.GEMINI_UPLOAD);
    // Still declared so existing brokers keep it; no code publishes to or consumes this queue.
    await assertQueue(QUEUES.GEMINI_DELETE);
    await assertQueue(QUEUES.GEMINI_RESTORE);
    await assertQueue(QUEUES.COURSE_DELETE);
    await assertQueue(QUEUES.USER_DELETE);
    await assertQueue(QUEUES.LESSON_AUTHOR_SESSION_DELETE);
    await assertQueue(QUEUES.EMAIL_OUTBOX);
    await assertQueue(QUEUES.COURSE_PROGRESS_RECALC);
    console.log(`[RabbitMQ] Queues ready: ${QUEUES.GEMINI_UPLOAD}, ${QUEUES.GEMINI_DELETE}, ${QUEUES.GEMINI_RESTORE}, ${QUEUES.COURSE_DELETE}, ${QUEUES.USER_DELETE}, ${QUEUES.LESSON_AUTHOR_SESSION_DELETE}, ${QUEUES.EMAIL_OUTBOX}, ${QUEUES.COURSE_PROGRESS_RECALC}`);
    if (!consumers) {
      console.log('[RabbitMQ] Publishing only; the consumers run in the background process');
      return;
    }

    // Start consumers (workers)
    await startUploadWorker();
    await startRestoreWorker();
    await startKbOperationWorker();
    await startLessonAuthorTranscriptionWorker();
    await startAiEngineTransitionWorker();
    await startCourseDeletionWorker();
    await startUserDeletionWorker();
    await startLessonAuthorSessionDeletionWorker();
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

/** Startup-only cleanups; they run once per deployment (the process that runs the background work). */
async function runStartupCleanups(): Promise<void> {
  // With several processes, an API process may be receiving an upload right now.
  if (processRolePlan.sharesStateAcrossProcesses) cleanupStaleCourseAssetTempFiles({ minAgeMs: COURSE_ASSET_TEMP_MAX_AGE_MS });
  if (!env.RUNTIME_GLOBAL_MAINTENANCE_ENABLED) return;
  // Dọn tokens ngay khi start
  try {
    const deleted = await cleanupExpiredTokens();
    if (deleted > 0) console.log(`[Cleanup] Startup: removed ${deleted} expired/revoked tokens`);
  } catch (error) { logSwallowedError('startup.expired_token_cleanup', error); }

  try {
    const deleted = await cleanupExpiredAuthRevocations();
    if (deleted > 0) console.log(`[Cleanup] Startup: removed ${deleted} expired access revocations`);
  } catch (error) { logSwallowedError('startup.auth_revocation_cleanup', error); }

  try {
    const deleted = await cleanupCompletedDeletionJobs();
    if (deleted > 0) console.log(`[Cleanup] Startup: removed ${deleted} completed deletion job records`);
  } catch (error) { logSwallowedError('startup.deletion_job_cleanup', error); }

  // Dọn audit logs cũ ngay khi start và ghi kết quả, kể cả khi không có bản ghi bị xóa.
  await runAuditLogRetentionCleanup('startup');
}

/** Sweepers and maintenance timers: only in the process that runs the background work. */
function startBackgroundTimers(): void {
  // Expired AI token/point reservations are returned in the background (never in the AI call path).
  stopOnShutdown(startAiTokenReservationSweeper());
  // (The inline email outbox worker, when enabled, is started by app.ts in this role.)

  if (processRolePlan.sharesStateAcrossProcesses) {
    stopOnShutdown(setInterval(() => {
      cleanupStaleCourseAssetTempFiles({ minAgeMs: COURSE_ASSET_TEMP_MAX_AGE_MS });
    }, COURSE_ASSET_TEMP_CLEANUP_INTERVAL_MS));
  }

  // Dọn refresh tokens hết hạn mỗi 6 giờ
  stopOnShutdown(setInterval(async function cleanupTokens() {
    if (!env.RUNTIME_GLOBAL_MAINTENANCE_ENABLED) return;
    try {
      const deleted = await cleanupExpiredTokens();
      if (deleted > 0) {
        console.log(`[Cleanup] Removed ${deleted} expired/revoked refresh tokens`);
      }
    } catch (err) {
      console.error('[Cleanup] Error:', err);
    }
  }, 6 * 60 * 60 * 1000));

  // Keep deletion metadata only for a finite operational support window.
  stopOnShutdown(setInterval(async function cleanupDeletionJobs() {
    if (!env.RUNTIME_GLOBAL_MAINTENANCE_ENABLED) return;
    try {
      const deleted = await cleanupCompletedDeletionJobs();
      if (deleted > 0) console.log(`[Cleanup] Removed ${deleted} completed deletion job records`);
    } catch (err) {
      console.error('[Cleanup] Deletion job cleanup error:', err);
    }
  }, 24 * 60 * 60 * 1000));

  // Access-token revocations only need to live through the maximum access-token TTL.
  stopOnShutdown(setInterval(async function cleanupAccessRevocations() {
    if (!env.RUNTIME_GLOBAL_MAINTENANCE_ENABLED) return;
    try {
      const deleted = await cleanupExpiredAuthRevocations();
      if (deleted > 0) console.log(`[Cleanup] Removed ${deleted} expired access revocations`);
    } catch (err) {
      console.error('[Cleanup] Access revocation cleanup error:', err);
    }
  }, 6 * 60 * 60 * 1000));

  // Dọn audit logs cũ hơn 30 ngày — chạy mỗi 24 giờ
  stopOnShutdown(setInterval(async function cleanupAuditLogs() {
    if (!env.RUNTIME_GLOBAL_MAINTENANCE_ENABLED) return;
    await runAuditLogRetentionCleanup('daily');
  }, 24 * 60 * 60 * 1000));
}

async function prepareAuthRevocation(): Promise<void> {
  if (env.isProduction && env.AUTH_REVOCATION_REQUIRE_REDIS_IN_PRODUCTION && !getRedisClient()) {
    throw new Error('Redis is required in production for constant-time durable access-token revocation. Configure REDIS_URL or explicitly set AUTH_REVOCATION_REQUIRE_REDIS_IN_PRODUCTION=false after accepting the database fallback load.');
  }
  if (env.isProduction && env.AUTH_REVOCATION_REQUIRE_REDIS_IN_PRODUCTION) {
    await assertAuthRevocationRedisReady();
  }
  // Authentication answers from Redis only once the revocations that can
  // still refuse a token are copied there; until then it reads the database.
  if (getRedisClient()) {
    const ready = await resyncAccessRevocationMirror();
    console.log(`[Auth] Access revocations in Redis: ${ready ? 'ready' : 'not ready yet, the database answers'}`);
  }
}

/** `loop: false` (API process): the runtimes accept work; the background process runs it. */
async function startLessonAuthorRuntimes(loop: boolean): Promise<void> {
  await startDurableBlueprintWorker({ loop });
  await startLessonAuthorWorkspaceWorker({ loop });
  await startChapterCheckpointMaintenance({ loop });
}

function listen(): Promise<void> {
  return new Promise((resolve) => {
    const server = app.listen(env.PORT, env.BIND_HOST, function onListen() {
      console.log(`[Server] LANDA Backend listening on ${env.BIND_HOST}:${env.PORT}`);
      console.log(`[Server] Environment: ${env.NODE_ENV}`);
      console.log(`[Server] CORS origin: ${env.CORS_ORIGIN}`);
      resolve();
    });

    // Node defaults to a five-minute request budget. That can cut off a valid
    // 300MB course asset on slower enterprise connections before Multer finishes
    // receiving it. The public upload gateway is required to apply matching body
    // limits and idle-time protections; do not expose this process directly.
    server.requestTimeout = LARGE_ASSET_REQUEST_TIMEOUT_MS;
    server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
    server.headersTimeout = REQUEST_HEADERS_TIMEOUT_MS;
    httpServer = server;
  });
}

// ── Bootstrap ── (order per role: config/process-startup.ts)
async function bootstrap() {
  console.log('[RuntimeTenantFence]', JSON.stringify(runtimeTenantDiagnostics()));
  console.log(`[Process] role=${processRolePlan.role} api_instances=${processRolePlan.apiInstances}`);
  // Once per process, in the background: a warning when its pools may not fit under max_connections.
  void logDatabaseConnectionHeadroom(`${processRolePlan.role}:${process.pid}`, ownDirectConnectionMax({ readsReports: processRolePlan.servesHttp }));
  await startProcess(processRolePlan, {
    // MUST succeed — the process exits otherwise.
    rabbitmq: ({ consumers }) => initRabbitMQ(consumers),
    redis: connectRedis,
    clusterBus: () => clusterBus.start(),
    authRevocation: prepareAuthRevocation,
    lessonAuthor: ({ loop }) => startLessonAuthorRuntimes(loop),
    backgroundTimers: startBackgroundTimers,
    // Ensure temp dir for Gemini worker
    tempDirectories: async () => {
      try {
        await fs.mkdir(env.GEMINI_TEMP_DIR, { recursive: true });
      } catch (error) { logSwallowedError('startup.gemini_temp_dir', error); }
      // Report export temp files a crashed process left (only files older than any export).
      await cleanupStaleReportExportSpools();
    },
    listen,
    // PM2 wait_ready (cluster reloads wait for this before stopping the old process).
    ready: () => { signalProcessReady(); },
    // Ensure storage bucket exists
    storageBucket: async () => {
      try {
        await ensureBucket();
        console.log(`[Storage] Bucket ready`);
      } catch (err) {
        console.error('[Storage] Bucket init failed:', err);
      }
    },
    startupCleanups: runStartupCleanups,
  });
}

bootstrap().catch(err => {
  console.error('[Bootstrap] Fatal error:', err);
  process.exit(1);
});

// Graceful shutdown (see config/graceful-shutdown.ts): stop intake, drain
// in-flight requests (bounded), then close RabbitMQ, Redis and the pools.
// The steps per role: config/process-startup.ts.
const gracefulShutdown = createGracefulShutdown({
  getServer: () => httpServer,
  lifecycle: processLifecycle,
  ...shutdownStepsFor(processRolePlan, {
    workers: [
      { name: 'lesson-author workspace worker', run: stopLessonAuthorWorkspaceWorker },
      { name: 'durable Blueprint worker', run: stopDurableBlueprintWorker },
      { name: 'chapter checkpoint maintenance', run: stopChapterCheckpointMaintenance },
      { name: 'inline email outbox worker', run: stopEmailOutboxWorker },
    ],
    consumers: { name: 'RabbitMQ consumers', run: cancelConsumers },
    // LISTEN connections first: the pool cannot end while they are checked out.
    listenConnections: {
      name: 'LISTEN connections',
      run: () => Promise.all([clusterBus.stop(), workspaceCommitHub.stop(), sourceDocumentHub.stop()]),
    },
    pdfRenderer: { name: 'report PDF renderer', run: shutdownReportPdfRenderer },
    rabbitmq: { name: 'RabbitMQ', run: closeRabbitMQ },
    redis: { name: 'Redis', run: closeRedis },
    // Created on first report read; a no-op in a process that never made it.
    reportsPool: { name: 'reports database pool', run: endReportsPool },
    pool: { name: 'database pool', run: async () => { await endSessionPool(); await pool.end(); } },
  }),
  exit: (code) => process.exit(code),
});

process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM'); });
process.on('SIGINT', () => { void gracefulShutdown('SIGINT'); });
// PM2 on Windows cannot deliver signals; with shutdown_with_message it sends this instead.
process.on('message', (message) => {
  if (message === 'shutdown') void gracefulShutdown('PM2 shutdown message');
});
