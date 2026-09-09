// ═══════════════════════════════════════════════════════════════
// Env Config — Validate tất cả biến môi trường bắt buộc
// CRASH ngay nếu thiếu biến — KHÔNG fallback
// ═══════════════════════════════════════════════════════════════

import { config as dotenvConfig } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Xác định thư mục gốc project (chứa .env files)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..', '..');

// Load env file theo NODE_ENV — KHÔNG fallback, KHÔNG cross-load
const isProd = process.env.NODE_ENV === 'production';
const envFile = isProd ? '.env.production' : '.env';
const envPath = path.resolve(rootDir, envFile);
const result = dotenvConfig({ path: envPath });

if (result.error) {
  console.error(`[Env] KHÔNG tìm thấy ${envFile} tại ${envPath}`);
  process.exit(1);
}
console.log(`[Env] Loaded ${envFile}`);

/**
 * Đọc biến môi trường bắt buộc — throw nếu thiếu hoặc rỗng.
 */
function required(key: string): string {
  const value = process.env[key];
  if (!value || value.trim() === '') {
    throw new Error(`[ENV] Thiếu biến môi trường bắt buộc: ${key}`);
  }
  return value.trim();
}

/**
 * Đọc biến môi trường kiểu số — throw nếu không hợp lệ.
 */
function requiredInt(key: string): number {
  const raw = required(key);
  const num = parseInt(raw, 10);
  if (isNaN(num)) {
    throw new Error(`[ENV] ${key} phải là số nguyên, nhận: "${raw}"`);
  }
  return num;
}

function optionalInt(key: string, fallback: number): number {
  const raw = process.env[key]?.trim();
  if (!raw) return fallback;
  const num = parseInt(raw, 10);
  if (isNaN(num)) {
    throw new Error(`[ENV] ${key} must be an integer, received: "${raw}"`);
  }
  return num;
}

function optionalNonNegativeInt(key: string, fallback: number): number {
  const num = optionalInt(key, fallback);
  if (num < 0) {
    throw new Error(`[ENV] ${key} must be a non-negative integer, received: "${num}"`);
  }
  return num;
}

function optionalPositiveInt(key: string, fallback: number): number {
  const num = optionalInt(key, fallback);
  if (num <= 0) {
    throw new Error(`[ENV] ${key} must be a positive integer, received: "${num}"`);
  }
  return num;
}

function optionalBoundedInt(key: string, fallback: number, minimum: number, maximum: number): number {
  const num = optionalInt(key, fallback);
  if (num < minimum || num > maximum) {
    throw new Error(`[ENV] ${key} must be between ${minimum} and ${maximum}, received: "${num}"`);
  }
  return num;
}

function optionalBoolean(key: string, fallback: boolean): boolean {
  const raw = process.env[key]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new Error(`[ENV] ${key} must be a boolean, received: "${raw}"`);
}

export const env = {
  NODE_ENV: required('NODE_ENV'),
  PORT: requiredInt('PORT'),
  TRUST_PROXY_HOPS: optionalNonNegativeInt('TRUST_PROXY_HOPS', 0),

  // Database
  DATABASE_URL: required('DATABASE_URL'),

  // JWT
  JWT_SECRET: required('JWT_SECRET'),
  JWT_ACCESS_EXPIRES_IN: required('JWT_ACCESS_EXPIRES_IN'),
  JWT_REFRESH_EXPIRES_IN: required('JWT_REFRESH_EXPIRES_IN'),

  // Bcrypt
  BCRYPT_SALT_ROUNDS: requiredInt('BCRYPT_SALT_ROUNDS'),

  // CORS
  CORS_ORIGIN: required('CORS_ORIGIN'),

  // Supabase Storage
  SUPABASE_URL: required('SUPABASE_URL'),
  SUPABASE_SERVICE_KEY: required('SUPABASE_SERVICE_KEY'),

  // RabbitMQ (mandatory — crash if missing)
  RABBITMQ_URL: required('RABBITMQ_URL'),

  // Redis (optional; DB fallback is used if unavailable)
  REDIS_URL: process.env.REDIS_URL?.trim() || '',
  REDIS_CONNECT_TIMEOUT_MS: optionalInt('REDIS_CONNECT_TIMEOUT_MS', 2_000),
  AUTH_REVOCATION_REQUIRE_REDIS_IN_PRODUCTION: optionalBoolean('AUTH_REVOCATION_REQUIRE_REDIS_IN_PRODUCTION', true),

  // SSO config encryption (optional until SSO secrets are configured)
  SSO_CONFIG_ENCRYPTION_KEY: process.env.SSO_CONFIG_ENCRYPTION_KEY?.trim() || '',

  // Demo iframe public origin override (optional; use tenant.domain_learner when empty)
  DEMO_IFRAME_PUBLIC_ORIGIN: process.env.DEMO_IFRAME_PUBLIC_ORIGIN?.trim() || '',

  // SMTP config encryption (optional until tenant SMTP is configured)
  SMTP_CONFIG_ENCRYPTION_KEY: process.env.SMTP_CONFIG_ENCRYPTION_KEY?.trim() || '',
  SMTP_TLS_REJECT_UNAUTHORIZED: optionalBoolean('SMTP_TLS_REJECT_UNAUTHORIZED', true),
  EMAIL_OUTBOX_WORKER_ENABLED: optionalBoolean('EMAIL_OUTBOX_WORKER_ENABLED', true),
  EMAIL_OUTBOX_INLINE_WORKER_ENABLED: optionalBoolean('EMAIL_OUTBOX_INLINE_WORKER_ENABLED', true),
  EMAIL_OUTBOX_INTERVAL_MS: optionalInt('EMAIL_OUTBOX_INTERVAL_MS', 15_000),
  EMAIL_OUTBOX_BATCH_SIZE: optionalInt('EMAIL_OUTBOX_BATCH_SIZE', 25),
  EMAIL_OUTBOX_CLAIM_BATCH_SIZE: optionalInt('EMAIL_OUTBOX_CLAIM_BATCH_SIZE', 25),
  EMAIL_OUTBOX_CONCURRENCY: optionalInt('EMAIL_OUTBOX_CONCURRENCY', 3),
  EMAIL_OUTBOX_TENANT_CONCURRENCY: optionalInt('EMAIL_OUTBOX_TENANT_CONCURRENCY', 2),
  EMAIL_OUTBOX_TICK_BUDGET_MS: optionalInt('EMAIL_OUTBOX_TICK_BUDGET_MS', 45_000),
  EMAIL_OUTBOX_SESSION_MAX_MESSAGES: optionalInt('EMAIL_OUTBOX_SESSION_MAX_MESSAGES', 20),
  EMAIL_OUTBOX_SENT_RETENTION_DAYS: optionalInt('EMAIL_OUTBOX_SENT_RETENTION_DAYS', 30),
  EMAIL_OUTBOX_RETENTION_BATCH_SIZE: optionalInt('EMAIL_OUTBOX_RETENTION_BATCH_SIZE', 1000),
  EMAIL_OUTBOX_WAKE_DEBOUNCE_MS: optionalInt('EMAIL_OUTBOX_WAKE_DEBOUNCE_MS', 500),
  EMAIL_OUTBOX_RABBIT_PREFETCH: optionalInt('EMAIL_OUTBOX_RABBIT_PREFETCH', 50),
  EMAIL_OUTBOX_TENANT_FAILURE_THRESHOLD: optionalInt('EMAIL_OUTBOX_TENANT_FAILURE_THRESHOLD', 3),
  EMAIL_OUTBOX_TENANT_COOLDOWN_MS: optionalInt('EMAIL_OUTBOX_TENANT_COOLDOWN_MS', 300_000),
  EMAIL_OUTBOX_TENANT_MAX_COOLDOWN_MS: optionalInt('EMAIL_OUTBOX_TENANT_MAX_COOLDOWN_MS', 1_800_000),

  // Durable user/course deletion workers. Polling is mandatory delivery recovery
  // when a RabbitMQ publish succeeds only partially or a worker crashes. Jobs
  // are due-based; do not reduce the retry delays to a hot polling loop.
  DELETION_REQUEUE_INTERVAL_MS: optionalPositiveInt('DELETION_REQUEUE_INTERVAL_MS', 30_000),
  DELETION_MAX_ATTEMPTS: optionalPositiveInt('DELETION_MAX_ATTEMPTS', 12),
  DELETION_RETRY_BASE_MS: optionalPositiveInt('DELETION_RETRY_BASE_MS', 30_000),
  DELETION_RETRY_MAX_MS: optionalPositiveInt('DELETION_RETRY_MAX_MS', 3_600_000),
  DELETION_JOB_RETENTION_DAYS: optionalPositiveInt('DELETION_JOB_RETENTION_DAYS', 30),

  // Course progress recalculation worker
  COURSE_PROGRESS_RECALC_WORKER_ENABLED: optionalBoolean('COURSE_PROGRESS_RECALC_WORKER_ENABLED', true),
  COURSE_PROGRESS_RECALC_BATCH_SIZE: optionalInt('COURSE_PROGRESS_RECALC_BATCH_SIZE', 1000),
  COURSE_PROGRESS_RECALC_MAX_BATCHES_PER_TICK: optionalInt('COURSE_PROGRESS_RECALC_MAX_BATCHES_PER_TICK', 5),
  COURSE_PROGRESS_RECALC_RABBIT_PREFETCH: optionalInt('COURSE_PROGRESS_RECALC_RABBIT_PREFETCH', 1),
  COURSE_PROGRESS_RECALC_POLL_INTERVAL_MS: optionalNonNegativeInt('COURSE_PROGRESS_RECALC_POLL_INTERVAL_MS', 60000),

  // Tenant data quota reconciliation is deliberately a dedicated PM2 worker.
  // It must never run inside every HTTP API replica on startup.
  TENANT_DATA_QUOTA_WORKER_ENABLED: optionalBoolean('TENANT_DATA_QUOTA_WORKER_ENABLED', false),
  TENANT_DATA_QUOTA_WORKER_HEARTBEAT_INTERVAL_MS: optionalBoundedInt('TENANT_DATA_QUOTA_WORKER_HEARTBEAT_INTERVAL_MS', 30_000, 5_000, 60_000),
  TENANT_DATA_QUOTA_WORKER_POLL_INTERVAL_MS: optionalBoundedInt('TENANT_DATA_QUOTA_WORKER_POLL_INTERVAL_MS', 15_000, 1_000, 300_000),
  TENANT_DATA_QUOTA_WORKER_STANDBY_RETRY_MS: optionalBoundedInt('TENANT_DATA_QUOTA_WORKER_STANDBY_RETRY_MS', 30_000, 1_000, 300_000),
  TENANT_DATA_QUOTA_WORKER_PAGE_SIZE: optionalBoundedInt('TENANT_DATA_QUOTA_WORKER_PAGE_SIZE', 500, 1, 1_000),
  TENANT_DATA_QUOTA_WORKER_MAX_TENANTS_PER_CYCLE: optionalBoundedInt('TENANT_DATA_QUOTA_WORKER_MAX_TENANTS_PER_CYCLE', 1, 1, 10),
  TENANT_DATA_QUOTA_WORKER_MAX_PAGES_PER_CLAIM: optionalBoundedInt('TENANT_DATA_QUOTA_WORKER_MAX_PAGES_PER_CLAIM', 100, 1, 10_000),
  // At least 90 seconds leaves room for a bounded Storage read, ledger write,
  // and a 30-second lease guard before a resumable slice yields.
  TENANT_DATA_QUOTA_WORKER_LEASE_SECONDS: optionalBoundedInt('TENANT_DATA_QUOTA_WORKER_LEASE_SECONDS', 120, 90, 900),
  TENANT_DATA_QUOTA_WORKER_MAX_SLICE_MS: optionalBoundedInt('TENANT_DATA_QUOTA_WORKER_MAX_SLICE_MS', 60_000, 5_000, 870_000),
  TENANT_DATA_QUOTA_WORKER_DATABASE_SNAPSHOT_TIMEOUT_MS: optionalBoundedInt('TENANT_DATA_QUOTA_WORKER_DATABASE_SNAPSHOT_TIMEOUT_MS', 600_000, 30_000, 600_000),
  TENANT_DATA_QUOTA_WORKER_RETRY_BASE_SECONDS: optionalBoundedInt('TENANT_DATA_QUOTA_WORKER_RETRY_BASE_SECONDS', 30, 1, 3_600),
  TENANT_DATA_QUOTA_WORKER_RETRY_MAX_SECONDS: optionalBoundedInt('TENANT_DATA_QUOTA_WORKER_RETRY_MAX_SECONDS', 3_600, 30, 86_400),

  // Durable Knowledge Base operations. Every API replica may run this worker:
  // PostgreSQL SKIP LOCKED + lease tokens make claims safe across replicas.
  KB_OPERATION_WORKER_ENABLED: optionalBoolean('KB_OPERATION_WORKER_ENABLED', true),
  KB_OPERATION_WORKER_POLL_INTERVAL_MS: optionalBoundedInt('KB_OPERATION_WORKER_POLL_INTERVAL_MS', 10_000, 1_000, 300_000),
  KB_OPERATION_WORKER_BATCH_SIZE: optionalBoundedInt('KB_OPERATION_WORKER_BATCH_SIZE', 24, 1, 500),
  KB_OPERATION_WORKER_CONCURRENCY: optionalBoundedInt('KB_OPERATION_WORKER_CONCURRENCY', 4, 1, 32),
  KB_OPERATION_WORKER_LEASE_SECONDS: optionalBoundedInt('KB_OPERATION_WORKER_LEASE_SECONDS', 300, 60, 3_600),
  KB_OPERATION_WORKER_MAX_ATTEMPTS: optionalBoundedInt('KB_OPERATION_WORKER_MAX_ATTEMPTS', 12, 1, 100),
  KB_OPERATION_WORKER_RETRY_BASE_SECONDS: optionalBoundedInt('KB_OPERATION_WORKER_RETRY_BASE_SECONDS', 30, 1, 3_600),
  KB_OPERATION_WORKER_RETRY_MAX_SECONDS: optionalBoundedInt('KB_OPERATION_WORKER_RETRY_MAX_SECONDS', 3_600, 30, 86_400),
  KB_RESTORE_RECOVERY_POLL_INTERVAL_MS: optionalBoundedInt('KB_RESTORE_RECOVERY_POLL_INTERVAL_MS', 30_000, 5_000, 300_000),

  // Gemini temp directory (optional — default ./tmp/gemini)
  GEMINI_CHAT_MODEL: process.env.GEMINI_CHAT_MODEL?.trim() || 'gemini-3.5-flash',
  GEMINI_TEMP_DIR: process.env.GEMINI_TEMP_DIR?.trim() || './tmp/gemini',

  /** Kiểm tra môi trường production */
  get isProduction(): boolean {
    return env.NODE_ENV === 'production';
  },
} as const;
