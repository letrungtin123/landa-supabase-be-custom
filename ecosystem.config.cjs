module.exports = {
  apps: [
    {
      name: "landa-refactor-backend",
      cwd: __dirname,
      script: "./dist/index.js",
      interpreter: "node",
      env: {
        NODE_ENV: "production",
        EMAIL_OUTBOX_INLINE_WORKER_ENABLED: "false"
      },
      env_production: {
        NODE_ENV: "production",
        EMAIL_OUTBOX_INLINE_WORKER_ENABLED: "false"
      }
    },
    {
      name: "landa-email-outbox-worker",
      cwd: __dirname,
      script: "./dist/workers/email-outbox.worker.js",
      interpreter: "node",
      env: {
        NODE_ENV: "production",
        EMAIL_OUTBOX_WORKER_ENABLED: "true"
      },
      env_production: {
        NODE_ENV: "production",
        EMAIL_OUTBOX_WORKER_ENABLED: "true"
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
        TENANT_DATA_QUOTA_WORKER_ENABLED: "true"
      },
      env_production: {
        NODE_ENV: "production",
        TENANT_DATA_QUOTA_WORKER_ENABLED: "true"
      }
    }
  ]
}
