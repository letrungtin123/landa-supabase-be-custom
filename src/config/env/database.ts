// Env: PostgreSQL connection and pools (part of `env`, see ../env.ts).

import './load.js';
import { optionalBoundedInt, optionalString, required } from './helpers.js';

export const databaseEnv = {
  // Database
  DATABASE_URL: required('DATABASE_URL'),
  // Optional (unset = everything on DATABASE_URL): a transaction-mode pooler
  // (Supavisor/PgBouncer) for the ordinary main and reports pools only. LISTEN
  // connections and session advisory locks always use DATABASE_URL.
  DATABASE_POOLER_URL: optionalString('DATABASE_POOLER_URL', ''),
  // Connections of this process's pool. Every PM2 app has its own pool:
  // keep (sum of all pools) below the server's max_connections.
  DB_POOL_MAX: optionalBoundedInt('DB_POOL_MAX', 20, 1, 200),
  // A pooled connection left idle this long is closed (main and reports
  // pools), so a burst does not keep its connections afterwards.
  DB_POOL_IDLE_TIMEOUT_MS: optionalBoundedInt('DB_POOL_IDLE_TIMEOUT_MS', 10_000, 1_000, 600_000),
  // Connections to leave free when a process checks at start whether its
  // pools fit under max_connections (a warning only, never a failure).
  DB_CONNECTION_RESERVE: optionalBoundedInt('DB_CONNECTION_RESERVE', 10, 0, 1_000),
  // PostgreSQL ends a session that stays idle inside an open transaction this
  // long (a leaked client or a stuck await holding locks). 0 turns it off.
  DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: optionalBoundedInt('DB_IDLE_IN_TRANSACTION_TIMEOUT_MS', 60_000, 0, 3_600_000),
  // Optional lock wait limit for every statement. Unset (0) by default: it
  // would turn ordinary lock waits into errors. Code that needs one sets
  // SET LOCAL lock_timeout itself.
  DB_LOCK_TIMEOUT_MS: optionalBoundedInt('DB_LOCK_TIMEOUT_MS', 0, 0, 600_000),
  // Admin reports, report chat and Excel exports use their own small pool of
  // this size (per process), so their aggregates never take the main pool.
  REPORTS_DB_POOL_MAX: optionalBoundedInt('REPORTS_DB_POOL_MAX', 4, 1, 50),
} as const;
