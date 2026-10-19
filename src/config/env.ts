// ═══════════════════════════════════════════════════════════════
// Env Config — Validate tất cả biến môi trường bắt buộc
// CRASH ngay nếu thiếu biến — KHÔNG fallback
// ═══════════════════════════════════════════════════════════════
//
// The settings are read in env/*.ts, one file per domain; this file joins
// them into the one `env` object the code imports.
//
// Keep the imports in this order: it is the order the files run in (an ES
// module runs its imports first, in order). env/load.ts loads the .env file
// before any setting is read; then each domain file reads and checks its
// settings, and the first invalid one stops the start. The required settings
// keep the order they always had, so with several missing the first one in
// this list is reported: NODE_ENV, PORT (core) → DATABASE_URL (database) →
// JWT_*, BCRYPT_SALT_ROUNDS (auth) → CORS_ORIGIN (origins) → SUPABASE_URL,
// SUPABASE_SERVICE_KEY (storage) → RABBITMQ_URL (messaging).
// env.split.test.ts pins this (and every default and error message).

import './env/load.js';
import { coreEnv } from './env/core.js';
import { databaseEnv } from './env/database.js';
import { authEnv } from './env/auth.js';
import { originsEnv } from './env/origins.js';
import { storageEnv } from './env/storage.js';
import { messagingEnv } from './env/messaging.js';
import { metricsEnv } from './env/metrics.js';
import { emailEnv } from './env/email.js';
import { aiEnv } from './env/ai.js';
import { aiIdEnv } from './env/ai-id.js';
import { workersEnv } from './env/workers.js';
import { reportsEnv } from './env/reports.js';

export const env = {
  ...coreEnv,
  ...databaseEnv,
  ...authEnv,
  ...originsEnv,
  ...storageEnv,
  ...messagingEnv,
  ...metricsEnv,
  ...emailEnv,
  ...aiEnv,
  ...aiIdEnv,
  ...workersEnv,
  ...reportsEnv,

  /** Kiểm tra môi trường production */
  get isProduction(): boolean {
    return env.NODE_ENV === 'production';
  },
} as const;
