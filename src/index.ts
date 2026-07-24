import app from './app.js';
import { env } from './config/env.js';
import { cleanupExpiredTokens } from './modules/auth/auth.service.js';
import { ensureBucket } from './config/storage.js';
import { query } from './config/database.js';
import { closeRedis, connectRedis } from './config/redis.js';
import { connectRabbitMQ, assertQueue, closeRabbitMQ, QUEUES } from './config/rabbitmq/index.js';
import { startUploadWorker } from './modules/ai-chatbot/upload.worker.js';
import { startDeleteWorker } from './modules/ai-chatbot/delete.worker.js';
import { startRestoreWorker } from './modules/ai-chatbot/restore.worker.js';
import { startCourseDeletionWorker } from './modules/course-deletion/course-deletion.worker.js';
import { startEmailOutboxRabbitConsumer } from './modules/assignments/email-outbox.service.js';
import fs from 'fs/promises';

/**
 * Xóa audit logs cũ hơn 30 ngày — tránh phình DB.
 * Chạy 1 lần khi start + mỗi 24 giờ.
 */
async function cleanupOldAuditLogs(): Promise<number> {
  const result = await query(
    `DELETE FROM audit_logs WHERE created_at < (now() AT TIME ZONE 'Asia/Ho_Chi_Minh' - INTERVAL '30 days')`,
  );
  return result.rowCount || 0;
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
    await assertQueue(QUEUES.EMAIL_OUTBOX);
    console.log(`[RabbitMQ] Queues ready: ${QUEUES.GEMINI_UPLOAD}, ${QUEUES.GEMINI_DELETE}, ${QUEUES.GEMINI_RESTORE}, ${QUEUES.COURSE_DELETE}, ${QUEUES.EMAIL_OUTBOX}`);

    // Start consumers (workers)
    await startUploadWorker();
    await startDeleteWorker();
    await startRestoreWorker();
    await startCourseDeletionWorker();
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

    // Dọn audit logs cũ ngay khi start
    try {
      const deleted = await cleanupOldAuditLogs();
      if (deleted > 0) console.log(`[Cleanup] Startup: removed ${deleted} audit logs older than 30 days`);
    } catch { /* ignore */ }
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

// Dọn audit logs cũ hơn 30 ngày — chạy mỗi 24 giờ
setInterval(async function cleanupAuditLogs() {
  try {
    const deleted = await cleanupOldAuditLogs();
    if (deleted > 0) {
      console.log(`[Cleanup] Removed ${deleted} audit logs older than 30 days`);
    }
  } catch (err) {
    console.error('[Cleanup] Audit cleanup error:', err);
  }
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
