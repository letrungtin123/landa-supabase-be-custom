import app from './app.js';
import { env } from './config/env.js';
import { cleanupExpiredTokens } from './modules/auth/auth.service.js';
import { ensureBucket } from './config/storage.js';
import { query } from './config/database.js';

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

// Khởi động server
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
process.on('SIGTERM', function handleSigterm() {
  console.log('[Server] SIGTERM received, shutting down...');
  process.exit(0);
});

process.on('SIGINT', function handleSigint() {
  console.log('[Server] SIGINT received, shutting down...');
  process.exit(0);
});
