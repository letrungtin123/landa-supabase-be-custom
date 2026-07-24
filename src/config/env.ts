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

  // Gemini temp directory (optional — default ./tmp/gemini)
  GEMINI_CHAT_MODEL: process.env.GEMINI_CHAT_MODEL?.trim() || 'gemini-3.5-flash',
  GEMINI_TEMP_DIR: process.env.GEMINI_TEMP_DIR?.trim() || './tmp/gemini',

  /** Kiểm tra môi trường production */
  get isProduction(): boolean {
    return env.NODE_ENV === 'production';
  },
} as const;
