// ═══════════════════════════════════════════════════════════════
// Entry Point — Start Express server
// ═══════════════════════════════════════════════════════════════

import app from './app.js';
import { env } from './config/env.js';
import { cleanupExpiredTokens } from './modules/auth/auth.service.js';

// Khởi động server
app.listen(env.PORT, async function onListen() {
  console.log(`[Server] LANDA Backend running on port ${env.PORT}`);
  console.log(`[Server] Environment: ${env.NODE_ENV}`);
  console.log(`[Server] CORS origin: ${env.CORS_ORIGIN}`);

  // Dọn tokens ngay khi start
  try {
    const deleted = await cleanupExpiredTokens();
    if (deleted > 0) console.log(`[Cleanup] Startup: removed ${deleted} expired/revoked tokens`);
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

// Graceful shutdown
process.on('SIGTERM', function handleSigterm() {
  console.log('[Server] SIGTERM received, shutting down...');
  process.exit(0);
});

process.on('SIGINT', function handleSigint() {
  console.log('[Server] SIGINT received, shutting down...');
  process.exit(0);
});
