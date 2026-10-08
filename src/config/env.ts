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

// Local-only overrides make `npm run dev` usable without editing or copying
// production secrets. The file is gitignored and is never loaded by PM2.
if (!isProd) {
  const localEnvPath = path.resolve(rootDir, '.env.development.local');
  const localResult = dotenvConfig({ path: localEnvPath, override: true });
  if (!localResult.error) console.log('[Env] Loaded .env.development.local overrides');
}

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

function optionalCsv(key: string): string[] {
  const raw = process.env[key]?.trim();
  if (!raw) return [];
  return raw.split(',').map((item) => item.trim()).filter(Boolean);
}

function optionalUuidCsv(key: string): string[] {
  const values = optionalCsv(key).map((item) => item.toLowerCase());
  const invalid = values.find((item) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(item));
  if (invalid !== undefined) {
    throw new Error(`[ENV] ${key} must be a comma-separated list of UUIDs, received: "${invalid}"`);
  }
  return [...new Set(values)];
}

function optionalString(key: string, fallback: string): string {
  return process.env[key]?.trim() || fallback;
}

/** Optional `scheme://host[:port]` (http/https, no path, query, fragment or credentials). */
function optionalOrigin(key: string): string {
  const raw = process.env[key]?.trim();
  if (!raw) return '';
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`[ENV] ${key} must be an origin such as https://host:8443`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
    || parsed.search || parsed.hash || (parsed.pathname && parsed.pathname !== '/')) {
    throw new Error(`[ENV] ${key} must be an origin such as https://host:8443 (no path, query or credentials)`);
  }
  return parsed.origin;
}

function optionalOneOf<const T extends readonly string[]>(key: string, fallback: T[number], allowed: T): T[number] {
  const value = optionalString(key, fallback);
  if (!allowed.includes(value as T[number])) {
    throw new Error(`[ENV] ${key} must be one of ${allowed.join(', ')}, received: "${value}"`);
  }
  return value as T[number];
}

export const env = {
  NODE_ENV: required('NODE_ENV'),
  PORT: requiredInt('PORT'),
  // Runtime fencing allows a localhost working tree and the always-on DEMO
  // snapshot to share one Supabase project without competing for another
  // runtime's tenant jobs. Empty lists preserve historical behaviour.
  RUNTIME_LANE: optionalString('RUNTIME_LANE', 'default'),
  RUNTIME_TENANT_ALLOWLIST: optionalCsv('RUNTIME_TENANT_ALLOWLIST'),
  RUNTIME_TENANT_DENYLIST: optionalCsv('RUNTIME_TENANT_DENYLIST'),
  RUNTIME_GLOBAL_MAINTENANCE_ENABLED: optionalBoolean('RUNTIME_GLOBAL_MAINTENANCE_ENABLED', true),
  // Existing direct deployments retain the default. Behind Nginx, bind to
  // 127.0.0.1 so the API cannot bypass the gateway on a LAN/public interface.
  BIND_HOST: optionalString('BIND_HOST', '0.0.0.0'),
  TRUST_PROXY_HOPS: optionalNonNegativeInt('TRUST_PROXY_HOPS', 0),
  // Exact proxy CIDR allowlist. When configured it takes precedence over the
  // legacy hop count so a direct caller cannot spoof X-Forwarded-For.
  TRUSTED_PROXY_CIDRS: optionalCsv('TRUSTED_PROXY_CIDRS'),

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
  RABBITMQ_QUEUE_PREFIX: optionalString('RABBITMQ_QUEUE_PREFIX', ''),

  // Redis (optional; DB fallback is used if unavailable)
  REDIS_URL: process.env.REDIS_URL?.trim() || '',
  REDIS_DATABASE: optionalNonNegativeInt('REDIS_DATABASE', 0),
  REDIS_CONNECT_TIMEOUT_MS: optionalInt('REDIS_CONNECT_TIMEOUT_MS', 2_000),
  AUTH_REVOCATION_REQUIRE_REDIS_IN_PRODUCTION: optionalBoolean('AUTH_REVOCATION_REQUIRE_REDIS_IN_PRODUCTION', true),

  // SSO config encryption (optional until SSO secrets are configured)
  SSO_CONFIG_ENCRYPTION_KEY: process.env.SSO_CONFIG_ENCRYPTION_KEY?.trim() || '',

  // Demo iframe public origin override (optional; use tenant.domain_learner when empty)
  DEMO_IFRAME_PUBLIC_ORIGIN: process.env.DEMO_IFRAME_PUBLIC_ORIGIN?.trim() || '',

  // SMTP config encryption (optional until tenant SMTP is configured)
  SMTP_CONFIG_ENCRYPTION_KEY: process.env.SMTP_CONFIG_ENCRYPTION_KEY?.trim() || '',
  SMTP_TLS_REJECT_UNAUTHORIZED: optionalBoolean('SMTP_TLS_REJECT_UNAUTHORIZED', true),

  // AI provider secrets + self-built RAG service
  AI_SECRET_ENCRYPTION_KEY: process.env.AI_SECRET_ENCRYPTION_KEY?.trim() || '',
  AI_RAG_SERVICE_URL: process.env.AI_RAG_SERVICE_URL?.trim() || '',
  AI_RAG_SERVICE_TOKEN: process.env.AI_RAG_SERVICE_TOKEN?.trim() || '',
  AI_RAG_SERVICE_HMAC_KEY_ID: process.env.AI_RAG_SERVICE_HMAC_KEY_ID?.trim() || '',
  AI_RAG_SERVICE_HMAC_SECRET: process.env.AI_RAG_SERVICE_HMAC_SECRET?.trim() || '',
  AI_RAG_REQUEST_TIMEOUT_MS: optionalBoundedInt('AI_RAG_REQUEST_TIMEOUT_MS', 600_000, 1_000, 900_000),
  // Read-only durable-job API. Does not enable enqueue or start any worker.
  LESSON_AUTHOR_GENERATION_STATUS_ENABLED: optionalBoolean('LESSON_AUTHOR_GENERATION_STATUS_ENABLED', false),
  // Reads only; does not enable workspace admission, generation, editing or Apply.
  LESSON_AUTHOR_WORKSPACE_READ_ENABLED: optionalBoolean('LESSON_AUTHOR_WORKSPACE_READ_ENABLED', false),
  // Authenticated metadata-only server push. It is separately gated from all
  // generation/edit/Apply behavior and requires the manual SQL notification
  // trigger to have been installed before production enablement.
  LESSON_AUTHOR_WORKSPACE_STREAM_ENABLED: optionalBoolean('LESSON_AUTHOR_WORKSPACE_STREAM_ENABLED', false),
  // Re-authenticate long-lived metadata streams periodically without forcing
  // every open modal to reconnect twice per minute at production scale.
  LESSON_AUTHOR_WORKSPACE_STREAM_AUTH_LEASE_MS: optionalBoundedInt(
    'LESSON_AUTHOR_WORKSPACE_STREAM_AUTH_LEASE_MS', 300_000, 60_000, 900_000,
  ),
  // Save/Reset only. Requires reads too; never enables admission, workers or Apply.
  LESSON_AUTHOR_WORKSPACE_EDIT_ENABLED: optionalBoolean('LESSON_AUTHOR_WORKSPACE_EDIT_ENABLED', false),
  LESSON_AUTHOR_WORKSPACE_EXECUTION_ENABLED: optionalBoolean('LESSON_AUTHOR_WORKSPACE_EXECUTION_ENABLED', false),
  // Draft-only course Apply. Requires READ, EDIT and EXECUTION plus the
  // installed workspace execution schema; this flag is intentionally separate
  // so a worker rollout can never publish course blocks by accident.
  LESSON_AUTHOR_WORKSPACE_APPLY_ENABLED: optionalBoolean('LESSON_AUTHOR_WORKSPACE_APPLY_ENABLED', false),
  // CP5 candidate/approval APIs and application-side publish handshake. The
  // reviewed SQL fence remains authoritative for every enrolled course.
  COURSE_PUBLISH_GOVERNANCE_ENABLED: optionalBoolean('COURSE_PUBLISH_GOVERNANCE_ENABLED', false),
  // Enables durable self-built-RAG Blueprint admission and its bounded worker.
  LESSON_AUTHOR_GENERATION_ENABLED: optionalBoolean('LESSON_AUTHOR_GENERATION_ENABLED', false),
  LESSON_AUTHOR_CHAPTER_CHECKPOINT_ENABLED: optionalBoolean('LESSON_AUTHOR_CHAPTER_CHECKPOINT_ENABLED', false),
  // Server-owned workspace launch switch. It admits durable V2 work in the API
  // transaction only when workspace execution is also enabled. Execution stays
  // isolated in a dedicated process with exactly one dispatcher/worker role.
  LESSON_AUTHOR_ORCHESTRATION_V2_ADMISSION_ENABLED: optionalBoolean(
    'LESSON_AUTHOR_ORCHESTRATION_V2_ADMISSION_ENABLED', false,
  ),
  LESSON_AUTHOR_ORCHESTRATION_V2_TENANT_CONCURRENCY: optionalBoundedInt(
    'LESSON_AUTHOR_ORCHESTRATION_V2_TENANT_CONCURRENCY', 16, 1, 1_024,
  ),
  LESSON_AUTHOR_ORCHESTRATION_V2_WORKSPACE_CONCURRENCY: optionalBoundedInt(
    'LESSON_AUTHOR_ORCHESTRATION_V2_WORKSPACE_CONCURRENCY', 4, 1, 128,
  ),
  LESSON_AUTHOR_ORCHESTRATION_V2_ENABLED: optionalBoolean('LESSON_AUTHOR_ORCHESTRATION_V2_ENABLED', false),
  LESSON_AUTHOR_ORCHESTRATION_V2_ROLE: optionalOneOf(
    'LESSON_AUTHOR_ORCHESTRATION_V2_ROLE', 'disabled', ['disabled', 'dispatcher', 'worker'] as const,
  ),
  LESSON_AUTHOR_ORCHESTRATION_V2_LANE_COUNT: optionalBoundedInt('LESSON_AUTHOR_ORCHESTRATION_V2_LANE_COUNT', 1, 1, 4_096),
  LESSON_AUTHOR_ORCHESTRATION_V2_LANE_INDEX: optionalBoundedInt('LESSON_AUTHOR_ORCHESTRATION_V2_LANE_INDEX', 0, 0, 4_095),
  LESSON_AUTHOR_ORCHESTRATION_V2_OUTBOX_LEASE_SECONDS: optionalBoundedInt('LESSON_AUTHOR_ORCHESTRATION_V2_OUTBOX_LEASE_SECONDS', 30, 5, 300),
  LESSON_AUTHOR_ORCHESTRATION_V2_OUTBOX_MAX_ATTEMPTS: optionalBoundedInt('LESSON_AUTHOR_ORCHESTRATION_V2_OUTBOX_MAX_ATTEMPTS', 8, 1, 100),
  LESSON_AUTHOR_ORCHESTRATION_V2_RETRY_BASE_MS: optionalBoundedInt('LESSON_AUTHOR_ORCHESTRATION_V2_RETRY_BASE_MS', 1_000, 1, 3_600_000),
  LESSON_AUTHOR_ORCHESTRATION_V2_RETRY_MAX_MS: optionalBoundedInt('LESSON_AUTHOR_ORCHESTRATION_V2_RETRY_MAX_MS', 60_000, 1, 86_400_000),
  LESSON_AUTHOR_ORCHESTRATION_V2_PUBLISHED_RECOVERY_SECONDS: optionalBoundedInt('LESSON_AUTHOR_ORCHESTRATION_V2_PUBLISHED_RECOVERY_SECONDS', 120, 5, 3_600),
  LESSON_AUTHOR_ORCHESTRATION_V2_DISPATCH_BATCH_SIZE: optionalBoundedInt('LESSON_AUTHOR_ORCHESTRATION_V2_DISPATCH_BATCH_SIZE', 25, 1, 500),
  LESSON_AUTHOR_ORCHESTRATION_V2_RECOVERY_BATCH_SIZE: optionalBoundedInt('LESSON_AUTHOR_ORCHESTRATION_V2_RECOVERY_BATCH_SIZE', 25, 1, 500),
  LESSON_AUTHOR_ORCHESTRATION_V2_POLL_INTERVAL_MS: optionalBoundedInt('LESSON_AUTHOR_ORCHESTRATION_V2_POLL_INTERVAL_MS', 1_000, 100, 300_000),
  LESSON_AUTHOR_ORCHESTRATION_V2_GLOBAL_CONCURRENCY: optionalBoundedInt('LESSON_AUTHOR_ORCHESTRATION_V2_GLOBAL_CONCURRENCY', 64, 1, 4_096),
  LESSON_AUTHOR_ORCHESTRATION_V2_PROVIDER_CONCURRENCY: optionalBoundedInt('LESSON_AUTHOR_ORCHESTRATION_V2_PROVIDER_CONCURRENCY', 8, 1, 4_096),
  LESSON_AUTHOR_ORCHESTRATION_V2_UNIT_SOFT_DEADLINE_MS: optionalBoundedInt(
    'LESSON_AUTHOR_ORCHESTRATION_V2_UNIT_SOFT_DEADLINE_MS', 45_000, 5_000, 120_000,
  ),
  LESSON_AUTHOR_ORCHESTRATION_V2_WORKER_LEASE_SECONDS: optionalBoundedInt('LESSON_AUTHOR_ORCHESTRATION_V2_WORKER_LEASE_SECONDS', 30, 5, 45),
  LESSON_AUTHOR_ORCHESTRATION_V2_WORKER_RECOVERY_BATCH_SIZE: optionalBoundedInt('LESSON_AUTHOR_ORCHESTRATION_V2_WORKER_RECOVERY_BATCH_SIZE', 25, 1, 500),
  // AI ID IDM pipeline (spec §5.4). Admission-only switch: new V2 runs of allow-listed tenants
  // (empty list = every tenant) record the IDM runtime hash; running runs are never re-routed.
  LESSON_AUTHOR_IDM_PIPELINE_ENABLED: optionalBoolean('LESSON_AUTHOR_IDM_PIPELINE_ENABLED', false),
  LESSON_AUTHOR_IDM_PIPELINE_TENANT_ALLOWLIST: optionalUuidCsv('LESSON_AUTHOR_IDM_PIPELINE_TENANT_ALLOWLIST'),
  LESSON_AUTHOR_IDM_UNIT_SOFT_DEADLINE_MS: optionalBoundedInt(
    'LESSON_AUTHOR_IDM_UNIT_SOFT_DEADLINE_MS', 120_000, 30_000, 300_000,
  ),
  AI_RAG_INDEX_REQUEST_TIMEOUT_MS: optionalBoundedInt('AI_RAG_INDEX_REQUEST_TIMEOUT_MS', 900_000, 10_000, 3_600_000),
  // Idle keep-alive of reused sockets to the AI service. It must stay below the server side
  // (uvicorn AI_RAG_KEEP_ALIVE_TIMEOUT_SECONDS=75, nginx keepalive_timeout 75 s) so a socket is
  // never reused just as the server closes it (ECONNRESET).
  AI_RAG_HTTP_KEEP_ALIVE_IDLE_MS: optionalBoundedInt('AI_RAG_HTTP_KEEP_ALIVE_IDLE_MS', 30_000, 1_000, 60_000),
  // SEP-1: the AI service downloads KB sources through a short-lived signed URL instead of a
  // storage service key. TTL covers the AI's index-slot wait plus the download.
  AI_RAG_STORAGE_SIGNED_URL_TTL_SECONDS: optionalBoundedInt('AI_RAG_STORAGE_SIGNED_URL_TTL_SECONDS', 600, 60, 3_600),
  // Origin the AI server reaches storage on when SUPABASE_URL is local to this host (empty = keep it).
  AI_RAG_STORAGE_SIGNED_URL_ORIGIN: optionalOrigin('AI_RAG_STORAGE_SIGNED_URL_ORIGIN'),
  AI_TOKEN_RESERVATION_SECONDS: optionalBoundedInt('AI_TOKEN_RESERVATION_SECONDS', 600, 60, 3_600),
  AI_CHAT_TOKEN_RESERVE_ESTIMATE: optionalBoundedInt('AI_CHAT_TOKEN_RESERVE_ESTIMATE', 16_000, 500, 1_000_000),
  // A source-backed Blueprint may use the provider's full 65,536-token
  // response window and has one validation retry available.
  AI_LESSON_AUTHOR_TOKEN_RESERVE_ESTIMATE: optionalBoundedInt('AI_LESSON_AUTHOR_TOKEN_RESERVE_ESTIMATE', 250_000, 1_000, 2_000_000),
  AI_INDEX_TOKEN_RESERVE_ESTIMATE: optionalBoundedInt('AI_INDEX_TOKEN_RESERVE_ESTIMATE', 20_000, 500, 2_000_000),
  AI_ENGINE_TRANSITION_WORKER_ENABLED: optionalBoolean('AI_ENGINE_TRANSITION_WORKER_ENABLED', true),
  AI_ENGINE_TRANSITION_WORKER_POLL_INTERVAL_MS: optionalBoundedInt('AI_ENGINE_TRANSITION_WORKER_POLL_INTERVAL_MS', 15_000, 1_000, 300_000),
  AI_ENGINE_TRANSITION_WORKER_BATCH_SIZE: optionalBoundedInt('AI_ENGINE_TRANSITION_WORKER_BATCH_SIZE', 20, 1, 500),
  AI_ENGINE_TRANSITION_WORKER_LEASE_SECONDS: optionalBoundedInt('AI_ENGINE_TRANSITION_WORKER_LEASE_SECONDS', 300, 60, 3_600),
  AI_ENGINE_TRANSITION_WORKER_MAX_ATTEMPTS: optionalBoundedInt('AI_ENGINE_TRANSITION_WORKER_MAX_ATTEMPTS', 30, 1, 100),
  AI_ENGINE_TRANSITION_WORKER_RETRY_BASE_SECONDS: optionalBoundedInt('AI_ENGINE_TRANSITION_WORKER_RETRY_BASE_SECONDS', 30, 1, 3_600),
  AI_ENGINE_TRANSITION_WORKER_RETRY_MAX_SECONDS: optionalBoundedInt('AI_ENGINE_TRANSITION_WORKER_RETRY_MAX_SECONDS', 3_600, 30, 86_400),
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

  // Lesson-author video transcription. The upload route streams to a private
  // bucket; these limits are enforced before expensive media processing.
  LESSON_AUTHOR_VIDEO_MAX_UPLOAD_MB: optionalBoundedInt('LESSON_AUTHOR_VIDEO_MAX_UPLOAD_MB', 500, 10, 2_048),
  LESSON_AUTHOR_VIDEO_MAX_DURATION_SECONDS: optionalBoundedInt('LESSON_AUTHOR_VIDEO_MAX_DURATION_SECONDS', 10_800, 30, 21_600),
  LESSON_AUTHOR_TRANSCRIPT_MAX_CHARS: optionalBoundedInt('LESSON_AUTHOR_TRANSCRIPT_MAX_CHARS', 2_000_000, 1_000, 5_000_000),
  LESSON_AUTHOR_TRANSCRIPT_RETENTION_HOURS: optionalBoundedInt('LESSON_AUTHOR_TRANSCRIPT_RETENTION_HOURS', 168, 1, 720),
  LESSON_AUTHOR_TRANSCRIPTION_WORKER_ENABLED: optionalBoolean('LESSON_AUTHOR_TRANSCRIPTION_WORKER_ENABLED', true),
  LESSON_AUTHOR_TRANSCRIPTION_WORKER_POLL_INTERVAL_MS: optionalBoundedInt('LESSON_AUTHOR_TRANSCRIPTION_WORKER_POLL_INTERVAL_MS', 10_000, 1_000, 300_000),
  LESSON_AUTHOR_TRANSCRIPTION_WORKER_BATCH_SIZE: optionalBoundedInt('LESSON_AUTHOR_TRANSCRIPTION_WORKER_BATCH_SIZE', 2, 1, 8),
  LESSON_AUTHOR_TRANSCRIPTION_WORKER_CONCURRENCY: optionalBoundedInt('LESSON_AUTHOR_TRANSCRIPTION_WORKER_CONCURRENCY', 1, 1, 4),
  LESSON_AUTHOR_TRANSCRIPTION_WORKER_LEASE_SECONDS: optionalBoundedInt('LESSON_AUTHOR_TRANSCRIPTION_WORKER_LEASE_SECONDS', 1_800, 120, 7_200),
  LESSON_AUTHOR_TRANSCRIPTION_WORKER_MAX_ATTEMPTS: optionalBoundedInt('LESSON_AUTHOR_TRANSCRIPTION_WORKER_MAX_ATTEMPTS', 3, 1, 12),
  LESSON_AUTHOR_TRANSCRIPTION_WORKER_RETRY_BASE_SECONDS: optionalBoundedInt('LESSON_AUTHOR_TRANSCRIPTION_WORKER_RETRY_BASE_SECONDS', 60, 5, 3_600),
  LESSON_AUTHOR_TRANSCRIPTION_WORKER_RETRY_MAX_SECONDS: optionalBoundedInt('LESSON_AUTHOR_TRANSCRIPTION_WORKER_RETRY_MAX_SECONDS', 3_600, 30, 86_400),
  LESSON_AUTHOR_TRANSCRIPTION_TEMP_DIR: optionalString('LESSON_AUTHOR_TRANSCRIPTION_TEMP_DIR', './tmp/lesson-author-transcription'),
  FFMPEG_PATH: optionalString('FFMPEG_PATH', 'ffmpeg'),
  FFPROBE_PATH: optionalString('FFPROBE_PATH', 'ffprobe'),
  GEMINI_TRANSCRIPTION_MODEL: optionalString('GEMINI_TRANSCRIPTION_MODEL', 'gemini-3.5-transcribe'),

  // Course outline transfer is a dedicated, resumable worker. It is separate
  // from HTTP so a large media copy never monopolises API request capacity.
  COURSE_OUTLINE_TRANSFER_WORKER_ENABLED: optionalBoolean('COURSE_OUTLINE_TRANSFER_WORKER_ENABLED', false),
  COURSE_OUTLINE_TRANSFER_WORKER_POLL_INTERVAL_MS: optionalBoundedInt('COURSE_OUTLINE_TRANSFER_WORKER_POLL_INTERVAL_MS', 10_000, 1_000, 300_000),

  // Gemini temp directory (optional — default ./tmp/gemini)
  GEMINI_CHAT_MODEL: process.env.GEMINI_CHAT_MODEL?.trim() || 'gemini-3.5-flash',
  GEMINI_LESSON_AUTHOR_MODEL: process.env.GEMINI_LESSON_AUTHOR_MODEL?.trim() || 'gemini-3.8-flash',
  GEMINI_TEMP_DIR: process.env.GEMINI_TEMP_DIR?.trim() || './tmp/gemini',

  /** Kiểm tra môi trường production */
  get isProduction(): boolean {
    return env.NODE_ENV === 'production';
  },
} as const;
