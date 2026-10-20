// Prod 226 (no AI service): API in PM2 cluster mode + one background process + 3 workers.
// Derived from the repo's ecosystem.config.cjs (release 7ba4fba) with every AI/workspace flag off,
// as in the previous 226 no-AI file. Never use the repo's ecosystem.config.cjs on 226.
// Connection budget (max_connections 100): API 4 x (8 main + 2 reports) = 40, background 8,
// email 3, quota 4, transfer 3 => 58 at most; pools close idle connections after 10 s.
const noAiFlags = {
  NODE_ENV: "production",
  UV_THREADPOOL_SIZE: "16",
  EMAIL_OUTBOX_INLINE_WORKER_ENABLED: "false",
  LESSON_AUTHOR_WORKSPACE_READ_ENABLED: "false",
  LESSON_AUTHOR_WORKSPACE_STREAM_ENABLED: "false",
  LESSON_AUTHOR_WORKSPACE_EDIT_ENABLED: "false",
  LESSON_AUTHOR_WORKSPACE_EXECUTION_ENABLED: "false",
  LESSON_AUTHOR_WORKSPACE_APPLY_ENABLED: "false",
  LESSON_AUTHOR_ORG_CONTEXT_ENABLED: "false",
  // No AI features on 226 yet (owner, 2026-10-20): the background process starts none of the
  // AI workers. These values win over 226's .env.production (dotenv does not override).
  KB_OPERATION_WORKER_ENABLED: "false",
  AI_ENGINE_TRANSITION_WORKER_ENABLED: "false",
  LESSON_AUTHOR_TRANSCRIPTION_WORKER_ENABLED: "false",
  LANDA_API_INSTANCES: "4",
};

const restartPolicy = {
  shutdown_with_message: true,
  kill_timeout: 15000,
  exp_backoff_restart_delay: 1000,
  min_uptime: 30000,
  max_restarts: 10000,
};

const apiEnv = { ...noAiFlags, LANDA_PROCESS_ROLE: "api", DB_POOL_MAX: "8", REPORTS_DB_POOL_MAX: "2" };
const backgroundEnv = { ...noAiFlags, LANDA_PROCESS_ROLE: "background", DB_POOL_MAX: "8" };

module.exports = {
  apps: [
    {
      name: "landa-refactor-backend",
      cwd: __dirname,
      script: "./dist/index.js",
      interpreter: "node",
      exec_mode: "cluster",
      instances: 4,
      wait_ready: true,
      listen_timeout: 60000,
      merge_logs: true,
      ...restartPolicy,
      env: apiEnv,
      env_production: apiEnv,
    },
    {
      name: "landa-backend-background",
      cwd: __dirname,
      script: "./dist/index.js",
      interpreter: "node",
      exec_mode: "fork",
      instances: 1,
      ...restartPolicy,
      env: backgroundEnv,
      env_production: backgroundEnv,
    },
    {
      name: "landa-email-outbox-worker",
      cwd: __dirname,
      script: "./dist/workers/email-outbox.worker.js",
      interpreter: "node",
      env: { NODE_ENV: "production", EMAIL_OUTBOX_WORKER_ENABLED: "true", DB_POOL_MAX: "3" },
      env_production: { NODE_ENV: "production", EMAIL_OUTBOX_WORKER_ENABLED: "true", DB_POOL_MAX: "3" },
    },
    {
      name: "landa-tenant-data-quota-worker",
      cwd: __dirname,
      script: "./dist/workers/tenant-data-quota.worker.js",
      interpreter: "node",
      // A database baseline can legitimately run longer than API queries.
      kill_timeout: 660000,
      autorestart: true,
      min_uptime: 60000,
      exp_backoff_restart_delay: 5000,
      env: { NODE_ENV: "production", TENANT_DATA_QUOTA_WORKER_ENABLED: "true", DB_POOL_MAX: "4" },
      env_production: { NODE_ENV: "production", TENANT_DATA_QUOTA_WORKER_ENABLED: "true", DB_POOL_MAX: "4" },
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
      env: { NODE_ENV: "production", COURSE_OUTLINE_TRANSFER_WORKER_ENABLED: "true", DB_POOL_MAX: "3" },
      env_production: { NODE_ENV: "production", COURSE_OUTLINE_TRANSFER_WORKER_ENABLED: "true", DB_POOL_MAX: "3" },
    },
  ],
};
