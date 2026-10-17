// ═══════════════════════════════════════════════════════════════
// Database — PostgreSQL connection pool (pg)
// Tối ưu cho hàng triệu user: pool size, idle timeout, statement timeout
// ═══════════════════════════════════════════════════════════════

import pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import { env } from './env.js';

const { Pool } = pg;

/**
 * Keeps ordinary `query()` calls on the transaction that owns the current
 * request flow. This lets existing services participate in a caller-owned
 * atomic unit without passing a client through every layer.
 *
 * `getClient()` deliberately remains a raw pool client for legacy services
 * which manage their own BEGIN/COMMIT lifecycle.
 */
const transactionClientStorage = new AsyncLocalStorage<pg.PoolClient>();

/**
 * Connection pool — chia sẻ connections cho toàn bộ app.
 * Pool size 20 phù hợp cho server trung bình, tăng nếu cần (DB_POOL_MAX).
 */
export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.DB_POOL_MAX,           // Mặc định 20 connections đồng thời
  idleTimeoutMillis: 30_000,      // Đóng connection idle sau 30s
  connectionTimeoutMillis: 5_000, // Timeout kết nối 5s
  statement_timeout: 30_000,      // Timeout query 30s — tránh long-running
  // A transaction left open and idle is ended by PostgreSQL instead of
  // holding its row/advisory locks (and a pool slot) forever.
  ...(env.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS > 0
    ? { idle_in_transaction_session_timeout: env.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS }
    : {}),
  ...(env.DB_LOCK_TIMEOUT_MS > 0 ? { lock_timeout: env.DB_LOCK_TIMEOUT_MS } : {}),
});

// Log connection errors (không crash app)
pool.on('error', function handlePoolError(err) {
  console.error('[DB] Pool error:', err.message);
});

/**
 * pg-pool removes its own 'error' listener while a client is checked out. A
 * session ended by the server between two queries (idle-in-transaction
 * timeout, restart, network drop) would then be an unhandled 'error' event and
 * crash the process. Log it instead: the next query on that client fails and
 * the pool discards the client on release because it is no longer queryable.
 */
export function attachClientErrorLogger(client: { on(event: 'error', listener: (err: Error) => void): unknown }): void {
  client.on('error', function handleClientError(err) {
    console.error('[DB] Client connection error (the connection is discarded):', err.message);
  });
}

pool.on('connect', attachClientErrorLogger);

/**
 * Thực thi query với parameterized statements (chống SQL injection).
 * Wrapper gọn cho pool.query().
 */
export async function query<T extends pg.QueryResultRow = any>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  const activeClient = transactionClientStorage.getStore();
  return activeClient
    ? activeClient.query<T>(text, params)
    : pool.query<T>(text, params);
}

/**
 * Executes a unit of work atomically. Nested calls reuse the surrounding
 * transaction; only the outermost owner is allowed to BEGIN/COMMIT/ROLLBACK.
 */
export async function withDatabaseTransaction<T>(
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const existingClient = transactionClientStorage.getStore();
  if (existingClient) return work(existingClient);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await transactionClientStorage.run(client, () => work(client));
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
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
