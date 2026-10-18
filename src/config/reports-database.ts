// ═══════════════════════════════════════════════════════════════
// Reports database pool: admin reports, report chat aggregates, Excel exports
//
// A small pool of its own (REPORTS_DB_POOL_MAX per process), so a few admins
// on reports can never take the connections learners need. It keeps the main
// pool's guardrails (config/database.ts): 30 s statement timeout, the
// idle-in-transaction timeout, the optional lock timeout and a permanent
// error listener on every client.
//
// An Excel export runs inside withReportsSnapshot(): one READ ONLY REPEATABLE
// READ transaction on one connection, so every sheet reads the same data, and
// long sheets stream through a server-side cursor instead of re-running their
// period query for every batch.
// ═══════════════════════════════════════════════════════════════

import pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import { env } from './env.js';
import { attachClientErrorLogger, pool as mainPool, pooledDatabaseUrl } from './database.js';
import { swallowAndLog } from '../utils/best-effort.js';

const { Pool } = pg;

/** Same per-statement limit as the main pool. */
export const REPORTS_STATEMENT_TIMEOUT_MS = 30_000;

export function reportsPoolOptions(): pg.PoolConfig {
  return {
    // The pooler when DATABASE_POOLER_URL is set: a snapshot is one transaction.
    connectionString: pooledDatabaseUrl(),
    max: env.REPORTS_DB_POOL_MAX,
    min: 0,
    idleTimeoutMillis: env.DB_POOL_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: 5_000,
    statement_timeout: REPORTS_STATEMENT_TIMEOUT_MS,
    ...(env.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS > 0
      ? { idle_in_transaction_session_timeout: env.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS }
      : {}),
    ...(env.DB_LOCK_TIMEOUT_MS > 0 ? { lock_timeout: env.DB_LOCK_TIMEOUT_MS } : {}),
  };
}

let reportsPool: pg.Pool | null = null;

/** Created on first use, so processes that never read reports open no second pool. */
export function getReportsPool(): pg.Pool {
  if (reportsPool) return reportsPool;
  const created = new Pool(reportsPoolOptions());
  created.on('error', function handleReportsPoolError(err) {
    console.error('[DB] Reports pool error:', err.message);
  });
  created.on('connect', attachClientErrorLogger);
  reportsPool = created;
  return created;
}

/** Graceful shutdown. */
export async function endReportsPool(): Promise<void> {
  const current = reportsPool;
  reportsPool = null;
  if (current) await current.end();
}

interface ReportsSnapshot {
  client: pg.PoolClient;
  open: boolean;
}

const snapshotStorage = new AsyncLocalStorage<ReportsSnapshot>();

/**
 * A report query: on the open export snapshot of the current flow, else on
 * the reports pool. Never on the main pool or its transactions.
 */
export async function reportsQuery<T extends pg.QueryResultRow = any>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  const snapshot = snapshotStorage.getStore();
  return snapshot?.open
    ? snapshot.client.query<T>(text, params)
    : getReportsPool().query<T>(text, params);
}

/** The client went away during an export; nothing more is read or written. */
export class ReportsSnapshotAbortedError extends Error {
  constructor() {
    super('Report export stopped: the client went away');
    this.name = 'ReportsSnapshotAbortedError';
  }
}

export function isReportsSnapshotAbortedError(error: unknown): error is ReportsSnapshotAbortedError {
  return error instanceof ReportsSnapshotAbortedError;
}

export function throwIfReportsAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ReportsSnapshotAbortedError();
}

/**
 * Runs `work` in one READ ONLY REPEATABLE READ transaction on one reports-pool
 * connection; every reportsQuery() of the flow joins it. statement_timeout is
 * raised for this transaction only (SET LOCAL). When `signal` aborts, a
 * statement still running is cancelled and the transaction rolls back; the
 * connection goes back to the pool only once that cancel has finished, so it
 * can never stop a statement of the connection's next user.
 */
export async function withReportsSnapshot<T>(
  options: { statementTimeoutMs: number; signal?: AbortSignal },
  work: () => Promise<T>,
): Promise<T> {
  throwIfReportsAborted(options.signal);
  const client = await getReportsPool().connect();
  const snapshot: ReportsSnapshot = { client, open: true };
  let backendPid: number | null = null;
  let cancelling: Promise<unknown> | null = null;
  const cancelRunningStatement = () => {
    if (backendPid === null || cancelling) return;
    // The main pool always has room for this one-row call; the reports pool may be full.
    cancelling = mainPool.query('SELECT pg_cancel_backend($1)', [backendPid]).catch(swallowAndLog('reports_db.cancel_statement'));
  };
  options.signal?.addEventListener('abort', cancelRunningStatement, { once: true });
  let brokenConnection: Error | undefined;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    // set_config(..., true) is SET LOCAL. cursor_tuple_fraction = 1: a cursor
    // is always read to the end, so plan it like the plain query.
    const setup = await client.query<{ pid: number }>(
      `SELECT set_config('statement_timeout', $1, true),
              set_config('cursor_tuple_fraction', '1', true),
              pg_backend_pid() AS pid`,
      [`${Math.floor(options.statementTimeoutMs)}ms`],
    );
    backendPid = setup.rows[0]?.pid ?? null;
    throwIfReportsAborted(options.signal);
    const result = await snapshotStorage.run(snapshot, work);
    snapshot.open = false;
    await client.query('COMMIT');
    return result;
  } catch (error) {
    snapshot.open = false;
    if (cancelling) await cancelling;
    await client.query('ROLLBACK').catch((rollbackError: unknown) => {
      brokenConnection = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
    });
    throw options.signal?.aborted ? new ReportsSnapshotAbortedError() : error;
  } finally {
    options.signal?.removeEventListener('abort', cancelRunningStatement);
    if (cancelling) await cancelling;
    client.release(brokenConnection);
  }
}

let cursorSequence = 0;

/**
 * Streams one query of the open snapshot through a server-side cursor:
 * `onBatch` gets the rows `batchSize` at a time, in the query's order. The
 * query is planned and run once, whatever the number of batches.
 */
export async function forEachReportsCursorBatch<T extends pg.QueryResultRow>(
  input: { text: string; params: unknown[]; batchSize: number; signal?: AbortSignal },
  onBatch: (rows: T[]) => void | Promise<void>,
): Promise<void> {
  const snapshot = snapshotStorage.getStore();
  if (!snapshot?.open) throw new Error('forEachReportsCursorBatch() runs inside withReportsSnapshot()');
  if (!Number.isInteger(input.batchSize) || input.batchSize < 1) {
    throw new Error(`Invalid cursor batch size: ${input.batchSize}`);
  }
  cursorSequence = (cursorSequence % 1_000_000) + 1;
  // Generated identifier (fixed prefix + counter), never user input.
  const cursorName = `reports_cursor_${cursorSequence}`;
  throwIfReportsAborted(input.signal);
  await snapshot.client.query(`DECLARE ${cursorName} NO SCROLL CURSOR FOR ${input.text}`, input.params);
  for (;;) {
    throwIfReportsAborted(input.signal);
    const batch = await snapshot.client.query<T>(`FETCH FORWARD ${input.batchSize} FROM ${cursorName}`);
    if (batch.rows.length > 0) await onBatch(batch.rows);
    if (batch.rows.length < input.batchSize) break;
  }
  await snapshot.client.query(`CLOSE ${cursorName}`);
}
