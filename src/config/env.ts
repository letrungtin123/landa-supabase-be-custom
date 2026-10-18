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
import { optionalBoolean } from './env/helpers.js';

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

  // AI ID default-off rollout gates. They are defined here, not in
  // env/ai-id.ts, because tests of src/modules/ai-chatbot read the text of
  // this file to check that each gate stays off by default. They are read
  // after every env/*.ts file.
  // Read-only durable-job API. Does not enable enqueue or start any worker.
  LESSON_AUTHOR_GENERATION_STATUS_ENABLED: optionalBoolean('LESSON_AUTHOR_GENERATION_STATUS_ENABLED', false),
  // Reads only; does not enable workspace admission, generation, editing or Apply.
  LESSON_AUTHOR_WORKSPACE_READ_ENABLED: optionalBoolean('LESSON_AUTHOR_WORKSPACE_READ_ENABLED', false),
  // Save/Reset only. Requires reads too; never enables admission, workers or Apply.
  LESSON_AUTHOR_WORKSPACE_EDIT_ENABLED: optionalBoolean('LESSON_AUTHOR_WORKSPACE_EDIT_ENABLED', false),
  // Enables durable self-built-RAG Blueprint admission and its bounded worker.
  LESSON_AUTHOR_GENERATION_ENABLED: optionalBoolean('LESSON_AUTHOR_GENERATION_ENABLED', false),

  ...workersEnv,
  ...reportsEnv,

  /** Kiểm tra môi trường production */
  get isProduction(): boolean {
    return env.NODE_ENV === 'production';
  },
} as const;
