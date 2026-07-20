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
    }
  ]
}
