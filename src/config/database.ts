// ═══════════════════════════════════════════════════════════════
// Database — PostgreSQL connection pool (pg)
// Tối ưu cho hàng triệu user: pool size, idle timeout, statement timeout
// ═══════════════════════════════════════════════════════════════

import pg from 'pg';
import { env } from './env.js';

const { Pool } = pg;

/**
 * Connection pool — chia sẻ connections cho toàn bộ app.
 * Pool size 20 phù hợp cho server trung bình, tăng nếu cần.
 */
export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 20,                        // Tối đa 20 connections đồng thời
  idleTimeoutMillis: 30_000,      // Đóng connection idle sau 30s
  connectionTimeoutMillis: 5_000, // Timeout kết nối 5s
  statement_timeout: 30_000,      // Timeout query 30s — tránh long-running
});

// Log connection errors (không crash app)
pool.on('error', function handlePoolError(err) {
  console.error('[DB] Pool error:', err.message);
});

/**
 * Thực thi query với parameterized statements (chống SQL injection).
 * Wrapper gọn cho pool.query().
 */
export async function query<T extends pg.QueryResultRow = any>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params);
}

/**
 * Lấy client từ pool — dùng cho transactions.
 * PHẢI gọi client.release() sau khi xong.
 */
export async function getClient(): Promise<pg.PoolClient> {
  return pool.connect();
}

/**
 * Health check — kiểm tra kết nối database.
 */
export async function checkDatabaseHealth(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
