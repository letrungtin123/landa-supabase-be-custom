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

/** statement_timeout of every pooled connection (main, session and reports pools). */
export const POOL_STATEMENT_TIMEOUT_MS = 30_000;

/** Whether the ordinary pools connect through DATABASE_POOLER_URL (opt-in). */
export function isDatabasePoolerEnabled(): boolean {
  return env.DATABASE_POOLER_URL !== '';
}

/**
 * Connection string of the ordinary pools (main and reports): the pooler
 * when DATABASE_POOLER_URL is set, else DATABASE_URL. Session-bound clients
 * (getSessionClient) always use DATABASE_URL.
 */
export function pooledDatabaseUrl(): string {
  return isDatabasePoolerEnabled() ? env.DATABASE_POOLER_URL : env.DATABASE_URL;
}

function poolOptions(connectionString: string): pg.PoolConfig {
  return {
    connectionString,
    max: env.DB_POOL_MAX,           // Mặc định 20 connections đồng thời
    // No idle connection is kept: one left idle DB_POOL_IDLE_TIMEOUT_MS (10 s) is closed.
    min: 0,
    idleTimeoutMillis: env.DB_POOL_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: 5_000, // Timeout kết nối 5s
    statement_timeout: POOL_STATEMENT_TIMEOUT_MS, // Timeout query 30s — tránh long-running
    // A transaction left open and idle is ended by PostgreSQL instead of
    // holding its row/advisory locks (and a pool slot) forever.
    ...(env.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS > 0
      ? { idle_in_transaction_session_timeout: env.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS }
      : {}),
    ...(env.DB_LOCK_TIMEOUT_MS > 0 ? { lock_timeout: env.DB_LOCK_TIMEOUT_MS } : {}),
  };
}

/**
 * Connection pool — chia sẻ connections cho toàn bộ app.
 * Pool size 20 phù hợp cho server trung bình, tăng nếu cần (DB_POOL_MAX).
 */
export const pool = new Pool(poolOptions(pooledDatabaseUrl()));

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

/** Work registered by afterCommit() for the transaction that owns the client. */
const afterCommitWork = new WeakMap<pg.PoolClient, Array<() => Promise<void>>>();

/**
 * Runs one post-commit job. The data is already committed, so a failure is
 * logged (tag and error kind only) and never fails the request: a client
 * retry would otherwise repeat committed work.
 */
async function runCommittedWork(work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (err) {
    const kind = err instanceof Error ? err.name : typeof err;
    const code = (err as { code?: unknown } | null)?.code;
    console.error(`[DB] after-commit work failed (${kind}${typeof code === 'string' ? ` ${code}` : ''})`);
  }
}

/**
 * Runs `work` once the surrounding withDatabaseTransaction() has committed,
 * or right away when there is none (autocommit). Dropped on rollback. Meant
 * for cache invalidation and queue wake-ups, which must not run before other
 * requests (or workers) can see the new data, and must not keep the
 * transaction open. Failures are logged, never thrown. Legacy getClient() + BEGIN
 * transactions are not tracked: their callers invalidate after their own
 * COMMIT.
 */
export async function afterCommit(work: () => Promise<void>): Promise<void> {
  const activeClient = transactionClientStorage.getStore();
  if (!activeClient) {
    await runCommittedWork(work);
    return;
  }
  const pending = afterCommitWork.get(activeClient);
  if (pending) pending.push(work);
  else afterCommitWork.set(activeClient, [work]);
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
  let result: T;
  let committedWork: Array<() => Promise<void>> = [];
  try {
    await client.query('BEGIN');
    result = await transactionClientStorage.run(client, () => work(client));
    await client.query('COMMIT');
    committedWork = afterCommitWork.get(client) ?? [];
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined); // fails only on a broken connection, which pg-pool discards
    throw error;
  } finally {
    afterCommitWork.delete(client);
    client.release();
  }
  // Every job runs even when an earlier one failed; none can fail the request now.
  for (const job of committedWork) await runCommittedWork(job);
  return result;
}

/**
 * Lấy client từ pool — dùng cho transactions.
 * PHẢI gọi client.release() sau khi xong.
 */
export async function getClient(): Promise<pg.PoolClient> {
  return pool.connect();
}

// Session-bound clients: LISTEN (cluster bus, SSE hubs) and session advisory
// locks need one server session for as long as they hold the client, which a
// transaction-mode pooler does not give. Without DATABASE_POOLER_URL they are
// ordinary main-pool clients, as before; with it they come from a pool of the
// same size on DATABASE_URL, created on first use.
let sessionPool: pg.Pool | null = null;

function getSessionPool(): pg.Pool {
  if (!isDatabasePoolerEnabled()) return pool;
  if (sessionPool) return sessionPool;
  const created = new Pool(poolOptions(env.DATABASE_URL));
  created.on('error', function handleSessionPoolError(err) {
    console.error('[DB] Session pool error:', err.message);
  });
  created.on('connect', attachClientErrorLogger);
  sessionPool = created;
  return created;
}

/**
 * A client on its own server session (LISTEN, session advisory locks),
 * always on DATABASE_URL. PHẢI gọi client.release() sau khi xong.
 */
export async function getSessionClient(): Promise<pg.PoolClient> {
  return getSessionPool().connect();
}

/** Graceful shutdown of the session pool (a no-op when it is the main pool or was never opened). */
export async function endSessionPool(): Promise<void> {
  const current = sessionPool;
  sessionPool = null;
  if (current) await current.end();
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
