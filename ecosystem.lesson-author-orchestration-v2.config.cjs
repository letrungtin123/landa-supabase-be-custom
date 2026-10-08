// AI ID orchestration V2 is intentionally isolated from ecosystem.config.cjs.
// Nothing starts these processes unless an operator targets this file by name
// after completing the SQL/catalog/staging rollout gates.
const shared = {
  cwd: __dirname,
  script: './dist/workers/lesson-author-orchestration-v2.worker.js',
  interpreter: 'node',
  exec_mode: 'fork',
  instances: 1,
  wait_ready: true,
  listen_timeout: 60_000,
  kill_timeout: 660_000,
  autorestart: true,
  min_uptime: 60_000,
  max_restarts: 10,
  exp_backoff_restart_delay: 5_000,
  max_memory_restart: '1G',
  time: true,
  merge_logs: true,
};

const role = value => ({
  NODE_ENV: 'production',
  LESSON_AUTHOR_ORCHESTRATION_V2_ENABLED: 'true',
  LESSON_AUTHOR_ORCHESTRATION_V2_ROLE: value,
  LESSON_AUTHOR_ORCHESTRATION_V2_LANE_COUNT: '1',
  LESSON_AUTHOR_ORCHESTRATION_V2_LANE_INDEX: '0',
  // Raised 2 -> 4 provider tasks on 2026-10-08 after a log review: every
  // historical Gemini 503/504 happened at concurrency 2 on heavy legacy
  // chapter-shard requests and no 429 was ever seen. Watch the AI service
  // metric ai_rag_provider_calls_total{outcome} and return to 2 if
  // quota_exhausted/unavailable/timeout outcomes rise.
  LESSON_AUTHOR_ORCHESTRATION_V2_GLOBAL_CONCURRENCY: '6',
  LESSON_AUTHOR_ORCHESTRATION_V2_PROVIDER_CONCURRENCY: '4',
  // Provider work gets one bounded chance; Python returns a validated
  // source-backed baseline at this soft deadline instead of timing out blank.
  LESSON_AUTHOR_ORCHESTRATION_V2_UNIT_SOFT_DEADLINE_MS: '45000',
});

module.exports = {
  apps: [
    {
      ...shared,
      name: 'landa-lesson-author-v2-dispatcher',
      env: role('dispatcher'),
      env_production: role('dispatcher'),
    },
    {
      ...shared,
      name: 'landa-lesson-author-v2-worker',
      env: role('worker'),
      env_production: role('worker'),
    },
  ],
};
