// ═══════════════════════════════════════════════════════════════
// Database connection headroom, checked once when a process starts
//
// Every PM2 process has its own pools (DB_POOL_MAX, plus REPORTS_DB_POOL_MAX
// in the API processes). The server's max_connections is shared with
// Supabase's own services and every other process, so a deployment can be
// configured to need more connections than the server allows; that shows
// up only under load, as "sorry, too many clients already". At start each
// process reads max_connections and the connections open right now, and
// logs a warning when its own maximum would not fit with DB_CONNECTION_RESERVE
// left over. It never fails the start: the counts change all the time.
//
// With DATABASE_POOLER_URL set (database.ts) the ordinary pools connect
// through the pooler, so only this process's direct (session) connections
// count here; the check also reads the guardrails the pooled connections
// really have, since a pooler may not apply the per-connection settings
// node-postgres sends when it connects.
// ═══════════════════════════════════════════════════════════════

import pg from 'pg';
import { env } from './env.js';
import { isDatabasePoolerEnabled, POOL_STATEMENT_TIMEOUT_MS, pool } from './database.js';

export interface ConnectionHeadroom {
  maxConnections: number;
  /** Connections open now, other than the check's own. */
  openConnections: number;
  ownMax: number;
  reserve: number;
  /** What this process may still open before the reserve is reached (negative: short). */
  room: number;
  fits: boolean;
}

export function evaluateConnectionHeadroom(input: { maxConnections: number; openConnections: number; ownMax: number; reserve: number }): ConnectionHeadroom {
  const room = input.maxConnections - input.reserve - input.openConnections - input.ownMax;
  return { ...input, room, fits: room >= 0 };
}

/** The direct connections this process may open at most (its pools, or only its session pool behind a pooler). */
export function ownDirectConnectionMax(options: { readsReports: boolean }): number {
  if (isDatabasePoolerEnabled()) return env.DB_POOL_MAX;
  return env.DB_POOL_MAX + (options.readsReports ? env.REPORTS_DB_POOL_MAX : 0);
}

/** PostgreSQL's SHOW text of a millisecond setting ('30s', '1min', '0'). */
function showMs(value: string | undefined): number | null {
  const match = /^(\d+)(ms|s|min|h)?$/.exec((value ?? '').trim());
  if (!match) return null;
  const unit = { ms: 1, s: 1_000, min: 60_000, h: 3_600_000 }[match[2] ?? 'ms'] ?? 1;
  return Number(match[1]) * unit;
}

type Log = (level: 'info' | 'warn', event: Record<string, unknown>) => void;
const defaultLog: Log = (level, event) => (level === 'warn' ? console.warn : console.info)('[DB] ' + JSON.stringify(event));

/**
 * Reads the server's connection numbers on one short direct connection and
 * logs them; a warning when `ownMax` does not fit. Never throws.
 */
export async function logDatabaseConnectionHeadroom(
  processName: string,
  ownMax: number,
  options: { log?: Log; connect?: () => Promise<{ query: pg.ClientBase['query']; end(): Promise<void> }> } = {},
): Promise<void> {
  const log = options.log ?? defaultLog;
  const connect = options.connect ?? (async () => {
    const client = new pg.Client({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 5_000, statement_timeout: 5_000 });
    client.on('error', () => undefined);
    await client.connect();
    return client;
  });
  let client: Awaited<ReturnType<typeof connect>> | null = null;
  try {
    client = await connect();
    const max = await client.query<{ max_connections: string }>('SHOW max_connections');
    const open = await client.query<{ open: number }>('SELECT count(*)::int AS open FROM pg_stat_activity WHERE pid <> pg_backend_pid()');
    const headroom = evaluateConnectionHeadroom({
      maxConnections: Number(max.rows[0]?.max_connections),
      openConnections: Number(open.rows[0]?.open),
      ownMax,
      reserve: env.DB_CONNECTION_RESERVE,
    });
    const event = {
      event: headroom.fits ? 'db_connection_headroom' : 'db_connection_headroom_low',
      process: processName,
      max_connections: headroom.maxConnections,
      open_connections: headroom.openConnections,
      own_max: headroom.ownMax,
      reserve: headroom.reserve,
      room: headroom.room,
      pooler: isDatabasePoolerEnabled(),
    };
    log(headroom.fits ? 'info' : 'warn', event);
  } catch (error) {
    log('warn', { event: 'db_connection_headroom_unchecked', process: processName, reason: error instanceof Error ? error.message.slice(0, 200) : 'error' });
  } finally {
    await client?.end().catch(() => undefined);
  }
  if (isDatabasePoolerEnabled()) await logPooledGuardrails(processName, log);
}

/** Behind a pooler, the settings sent at connect may be ignored: compare what the pooled connections have. */
async function logPooledGuardrails(processName: string, log: Log): Promise<void> {
  try {
    const statement = await pool.query<{ statement_timeout: string }>('SHOW statement_timeout');
    const idle = await pool.query<{ idle_in_transaction_session_timeout: string }>('SHOW idle_in_transaction_session_timeout');
    const expected = { statement_timeout: POOL_STATEMENT_TIMEOUT_MS, idle_in_transaction_session_timeout: env.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS };
    const actual = {
      statement_timeout: showMs(statement.rows[0]?.statement_timeout),
      idle_in_transaction_session_timeout: showMs(idle.rows[0]?.idle_in_transaction_session_timeout),
    };
    const matches = actual.statement_timeout === expected.statement_timeout
      && actual.idle_in_transaction_session_timeout === expected.idle_in_transaction_session_timeout;
    log(matches ? 'info' : 'warn', {
      event: matches ? 'db_pooler_guardrails' : 'db_pooler_guardrails_missing',
      process: processName,
      expected_ms: expected,
      actual_ms: actual,
    });
  } catch (error) {
    log('warn', { event: 'db_pooler_guardrails_unchecked', process: processName, reason: error instanceof Error ? error.message.slice(0, 200) : 'error' });
  }
}
