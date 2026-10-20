// API processes and the background process run the same dist/index.js with a
// different LANDA_PROCESS_ROLE (src/config/process-role.ts).
//
// LANDA_API_INSTANCES (default 2) and LANDA_API_DB_POOL_MAX (default 10) are
// read from the shell that runs `pm2 start|reload` on this file; the count is
// passed to every process so the API processes share their limits through
// Redis when there is more than one.
//
// Database connections: every process has its own pool (DB_POOL_MAX, it
// includes the process's LISTEN connections); a process that reads reports
// also opens the reports pool (REPORTS_DB_POOL_MAX, default 4, on the first
// report read). Keep the sum of all pools (this file +
// ecosystem.lesson-author-orchestration-v2.config.cjs + the AI service) well
// below max_connections minus what Supabase itself holds.
//   API          LANDA_API_INSTANCES x (LANDA_API_DB_POOL_MAX + REPORTS_DB_POOL_MAX)
//                (2 x (10 + 4) = 28; one worker more, 14, for a few seconds
//                while a rolling restart replaces a worker)
//   background   10 (reads no reports)   email outbox 3   tenant quota 4
//   outline transfer 3   news cleanup 2
//   = 50 here; + orchestration V2 8 (dispatcher 3, worker 5) + AI service 8
//   (AI_RAG_DB_POOL_MAX default) = 66. Local: max_connections 100, of which
//   Supabase itself holds about 25-30.
function positiveInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer, received "${raw}"`);
  return value;
}

const apiInstances = positiveInt("LANDA_API_INSTANCES", 2);
const apiPoolMax = positiveInt("LANDA_API_DB_POOL_MAX", 10);

// Feature flags both roles must agree on (the API accepts the work the
// background process runs).
const sharedEnv = {
  NODE_ENV: "production",
  LANDA_API_INSTANCES: String(apiInstances),
  // libuv threads for bcrypt, dns.lookup, fs and zlib (default 4): a
  // sign-in burst otherwise queues storage DNS lookups behind password
  // checks. Read once when the pool first starts, so it is set here.
  UV_THREADPOOL_SIZE: "16",
  EMAIL_OUTBOX_INLINE_WORKER_ENABLED: "false",
  LESSON_AUTHOR_WORKSPACE_READ_ENABLED: "true",
  LESSON_AUTHOR_WORKSPACE_STREAM_ENABLED: "true",
  LESSON_AUTHOR_WORKSPACE_STREAM_AUTH_LEASE_MS: "300000",
  LESSON_AUTHOR_WORKSPACE_EDIT_ENABLED: "true",
  LESSON_AUTHOR_WORKSPACE_EXECUTION_ENABLED: "true",
  LESSON_AUTHOR_WORKSPACE_APPLY_ENABLED: "true",
  COURSE_PUBLISH_GOVERNANCE_ENABLED: "true",
  LESSON_AUTHOR_ORCHESTRATION_V2_TENANT_CONCURRENCY: "4",
  LESSON_AUTHOR_ORCHESTRATION_V2_WORKSPACE_CONCURRENCY: "4",
  // Author recovery of a V2 design: Dừng / Chạy tiếp / Viết lại (needs SQL 20261020_1500).
  // Empty tenant allowlist = every tenant.
  LESSON_AUTHOR_ORCHESTRATION_V2_STOP_ENABLED: "true",
  LESSON_AUTHOR_ORCHESTRATION_V2_RECOVERY_ENABLED: "true"
};

// The API is one PM2 process in fork mode, the in-app cluster primary
// (src/config/inapp-cluster-primary.ts): it forks LANDA_INAPP_CLUSTER_WORKERS
// API workers and hands them the connections round-robin (in PM2 cluster mode
// on Windows nearly every connection reaches one process). PM2 runs one
// primary, so the workers are all of LANDA_API_INSTANCES.
const apiEnv = {
  ...sharedEnv,
  LANDA_PROCESS_ROLE: "api",
  LANDA_INAPP_CLUSTER_WORKERS: String(apiInstances),
  DB_POOL_MAX: String(apiPoolMax)
};
const backgroundEnv = { ...sharedEnv, LANDA_PROCESS_ROLE: "background", DB_POOL_MAX: "10" };

// Graceful restarts (src/config/graceful-shutdown.ts). PM2 on Windows
// cannot deliver SIGINT/SIGTERM to the app, so it sends a "shutdown"
// message instead (to cluster workers too). A process drains requests for
// up to 10 s and exits within 13.5 s, before PM2 force-kills it at
// kill_timeout.
const restartPolicy = {
  shutdown_with_message: true,
  kill_timeout: 15000,
  // Restart backoff: 1 s, then x1.5 per restart up to 15 s.
  exp_backoff_restart_delay: 1000,
  // An exit within 30 s of a start counts as an unstable restart. PM2
  // stops restarting an app after max_restarts of them; it is kept high so
  // it comes back by itself after a long RabbitMQ or database outage.
  min_uptime: 30000,
  max_restarts: 10000
};

module.exports = {
  apps: [
    {
      // HTTP, SSE streams (each worker owns its LISTEN connections), and
      // publishing to RabbitMQ.
      //
      // One fork-mode process, the in-app cluster primary of
      // LANDA_INAPP_CLUSTER_WORKERS workers (apiEnv). Deploy without downtime:
      //   npm run build
      //   node scripts/pm2-rolling-restart.mjs landa-refactor-backend
      // (each worker is stopped only once its replacement is ready).
      // `pm2 reload|restart` of this app restarts every worker at once (a few
      // seconds without API); it is needed only for a change of the primary
      // itself (src/index.ts, src/config/inapp-cluster-*.ts) or of this env.
      name: "landa-refactor-backend",
      cwd: __dirname,
      script: "./dist/index.js",
      interpreter: "node",
      exec_mode: "fork",
      instances: 1,
      // The primary sends "ready" once every worker has sent it after
      // listen. listen_timeout is also how long a rolling restart waits for
      // a new worker (ROLLING_RESTART_READY_TIMEOUT_MS).
      wait_ready: true,
      listen_timeout: 60000,
      // One log file for the primary and its workers
      // (landa-refactor-backend-out.log).
      merge_logs: true,
      ...restartPolicy,
      env: apiEnv,
      env_production: apiEnv
    },
    {
      // RabbitMQ consumers, pollers, sweepers, maintenance timers and the
      // startup cleanups: exactly one process.
      name: "landa-backend-background",
      cwd: __dirname,
      script: "./dist/index.js",
      interpreter: "node",
      exec_mode: "fork",
      instances: 1,
      ...restartPolicy,
      env: backgroundEnv,
      env_production: backgroundEnv
    },
    {
      name: "landa-email-outbox-worker",
      cwd: __dirname,
      script: "./dist/workers/email-outbox.worker.js",
      interpreter: "node",
      env: {
        NODE_ENV: "production",
        EMAIL_OUTBOX_WORKER_ENABLED: "true",
        DB_POOL_MAX: "3"
      },
      env_production: {
        NODE_ENV: "production",
        EMAIL_OUTBOX_WORKER_ENABLED: "true",
        DB_POOL_MAX: "3"
      }
    },
    {
      name: "landa-tenant-data-quota-worker",
      cwd: __dirname,
      script: "./dist/workers/tenant-data-quota.worker.js",
      interpreter: "node",
      // A database baseline can legitimately run longer than API queries.
      // Keep this above TENANT_DATA_QUOTA_WORKER_DATABASE_SNAPSHOT_TIMEOUT_MS.
      kill_timeout: 660000,
      autorestart: true,
      min_uptime: 60000,
      exp_backoff_restart_delay: 5000,
      env: {
        NODE_ENV: "production",
        TENANT_DATA_QUOTA_WORKER_ENABLED: "true",
        // The session lock connection, one cycle, the heartbeat and the delta
        // fold (each on its own connection).
        DB_POOL_MAX: "4"
      },
      env_production: {
        NODE_ENV: "production",
        TENANT_DATA_QUOTA_WORKER_ENABLED: "true",
        DB_POOL_MAX: "4"
      }
    },
    {
      name: "landa-course-outline-transfer-worker",
      cwd: __dirname,
      script: "./dist/workers/course-outline-transfer.worker.js",
      interpreter: "node",
      kill_timeout: 960000,
      autorestart: true,
      min_uptime: 60000,
      exp_backoff_restart_delay: 5000,
      env: {
        NODE_ENV: "production",
        COURSE_OUTLINE_TRANSFER_WORKER_ENABLED: "true",
        DB_POOL_MAX: "3"
      },
      env_production: {
        NODE_ENV: "production",
        COURSE_OUTLINE_TRANSFER_WORKER_ENABLED: "true",
        DB_POOL_MAX: "3"
      }
    },
    {
      name: "landa-news-assets-cleanup-worker",
      cwd: __dirname,
      script: "./dist/workers/news-assets-cleanup.worker.js",
      interpreter: "node",
      autorestart: true,
      min_uptime: 30000,
      exp_backoff_restart_delay: 5000,
      env: {
        NODE_ENV: "production",
        DB_POOL_MAX: "2"
      },
      env_production: {
        NODE_ENV: "production",
        DB_POOL_MAX: "2"
      }
    }
  ]
}
