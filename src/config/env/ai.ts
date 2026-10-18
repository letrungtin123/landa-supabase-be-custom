// Env: AI providers, the self-built RAG service, AI chat, Knowledge Base
// workers and Gemini (part of `env`, see ../env.ts).

import './load.js';
import { optionalBoolean, optionalBoundedInt, optionalOrigin } from './helpers.js';

export const aiEnv = {
  // AI provider secrets + self-built RAG service
  AI_SECRET_ENCRYPTION_KEY: process.env.AI_SECRET_ENCRYPTION_KEY?.trim() || '',
  AI_RAG_SERVICE_URL: process.env.AI_RAG_SERVICE_URL?.trim() || '',
  AI_RAG_SERVICE_TOKEN: process.env.AI_RAG_SERVICE_TOKEN?.trim() || '',
  AI_RAG_SERVICE_HMAC_KEY_ID: process.env.AI_RAG_SERVICE_HMAC_KEY_ID?.trim() || '',
  AI_RAG_SERVICE_HMAC_SECRET: process.env.AI_RAG_SERVICE_HMAC_SECRET?.trim() || '',
  AI_RAG_REQUEST_TIMEOUT_MS: optionalBoundedInt('AI_RAG_REQUEST_TIMEOUT_MS', 600_000, 1_000, 900_000),
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
  // Chat answers this API process streams at once, per tenant and in total.
  // A turn over either limit is refused at once with 429 AI_BUSY.
  AI_CHAT_TENANT_CONCURRENCY: optionalBoundedInt('AI_CHAT_TENANT_CONCURRENCY', 8, 1, 1_024),
  AI_CHAT_GLOBAL_CONCURRENCY: optionalBoundedInt('AI_CHAT_GLOBAL_CONCURRENCY', 48, 1, 4_096),
  // A chat answer from the provider (retries included) stops after this long.
  AI_CHAT_ANSWER_DEADLINE_MS: optionalBoundedInt('AI_CHAT_ANSWER_DEADLINE_MS', 180_000, 10_000, 900_000),
  // A source-backed Blueprint may use the provider's full 65,536-token
  // response window and has one validation retry available.
  AI_LESSON_AUTHOR_TOKEN_RESERVE_ESTIMATE: optionalBoundedInt(
    'AI_LESSON_AUTHOR_TOKEN_RESERVE_ESTIMATE',
    250_000,
    1_000,
    2_000_000,
  ),
  AI_INDEX_TOKEN_RESERVE_ESTIMATE: optionalBoundedInt('AI_INDEX_TOKEN_RESERVE_ESTIMATE', 20_000, 500, 2_000_000),
  AI_ENGINE_TRANSITION_WORKER_ENABLED: optionalBoolean('AI_ENGINE_TRANSITION_WORKER_ENABLED', true),
  AI_ENGINE_TRANSITION_WORKER_POLL_INTERVAL_MS: optionalBoundedInt(
    'AI_ENGINE_TRANSITION_WORKER_POLL_INTERVAL_MS',
    15_000,
    1_000,
    300_000,
  ),
  AI_ENGINE_TRANSITION_WORKER_BATCH_SIZE: optionalBoundedInt('AI_ENGINE_TRANSITION_WORKER_BATCH_SIZE', 20, 1, 500),
  AI_ENGINE_TRANSITION_WORKER_LEASE_SECONDS: optionalBoundedInt(
    'AI_ENGINE_TRANSITION_WORKER_LEASE_SECONDS',
    300,
    60,
    3_600,
  ),
  AI_ENGINE_TRANSITION_WORKER_MAX_ATTEMPTS: optionalBoundedInt('AI_ENGINE_TRANSITION_WORKER_MAX_ATTEMPTS', 30, 1, 100),
  AI_ENGINE_TRANSITION_WORKER_RETRY_BASE_SECONDS: optionalBoundedInt(
    'AI_ENGINE_TRANSITION_WORKER_RETRY_BASE_SECONDS',
    30,
    1,
    3_600,
  ),
  AI_ENGINE_TRANSITION_WORKER_RETRY_MAX_SECONDS: optionalBoundedInt(
    'AI_ENGINE_TRANSITION_WORKER_RETRY_MAX_SECONDS',
    3_600,
    30,
    86_400,
  ),

  // Durable Knowledge Base operations. Every API replica may run this worker:
  // PostgreSQL SKIP LOCKED + lease tokens make claims safe across replicas.
  KB_OPERATION_WORKER_ENABLED: optionalBoolean('KB_OPERATION_WORKER_ENABLED', true),
  KB_OPERATION_WORKER_POLL_INTERVAL_MS: optionalBoundedInt(
    'KB_OPERATION_WORKER_POLL_INTERVAL_MS',
    10_000,
    1_000,
    300_000,
  ),
  KB_OPERATION_WORKER_BATCH_SIZE: optionalBoundedInt('KB_OPERATION_WORKER_BATCH_SIZE', 24, 1, 500),
  KB_OPERATION_WORKER_CONCURRENCY: optionalBoundedInt('KB_OPERATION_WORKER_CONCURRENCY', 4, 1, 32),
  KB_OPERATION_WORKER_LEASE_SECONDS: optionalBoundedInt('KB_OPERATION_WORKER_LEASE_SECONDS', 300, 60, 3_600),
  KB_OPERATION_WORKER_MAX_ATTEMPTS: optionalBoundedInt('KB_OPERATION_WORKER_MAX_ATTEMPTS', 12, 1, 100),
  KB_OPERATION_WORKER_RETRY_BASE_SECONDS: optionalBoundedInt('KB_OPERATION_WORKER_RETRY_BASE_SECONDS', 30, 1, 3_600),
  KB_OPERATION_WORKER_RETRY_MAX_SECONDS: optionalBoundedInt('KB_OPERATION_WORKER_RETRY_MAX_SECONDS', 3_600, 30, 86_400),
  KB_RESTORE_RECOVERY_POLL_INTERVAL_MS: optionalBoundedInt(
    'KB_RESTORE_RECOVERY_POLL_INTERVAL_MS',
    30_000,
    5_000,
    300_000,
  ),
  // Uploaded FAQ workbooks are parsed in a worker thread (never on the event
  // loop): its deadline, its heap limit, and how many run at once per process.
  KB_FAQ_SHEET_READ_TIMEOUT_MS: optionalBoundedInt('KB_FAQ_SHEET_READ_TIMEOUT_MS', 60_000, 1_000, 600_000),
  KB_FAQ_SHEET_READ_MAX_MEMORY_MB: optionalBoundedInt('KB_FAQ_SHEET_READ_MAX_MEMORY_MB', 1_024, 64, 8_192),
  KB_FAQ_SHEET_READ_CONCURRENCY: optionalBoundedInt('KB_FAQ_SHEET_READ_CONCURRENCY', 2, 1, 16),

  // Gemini temp directory (optional — default ./tmp/gemini)
  GEMINI_CHAT_MODEL: process.env.GEMINI_CHAT_MODEL?.trim() || 'gemini-3.8-flash',
  GEMINI_LESSON_AUTHOR_MODEL: process.env.GEMINI_LESSON_AUTHOR_MODEL?.trim() || 'gemini-3.8-flash',
  GEMINI_TEMP_DIR: process.env.GEMINI_TEMP_DIR?.trim() || './tmp/gemini',
  // Creating a KB's Gemini File Search store gives up after this long (no
  // database transaction or connection is held while it runs).
  GEMINI_STORE_CREATE_TIMEOUT_MS: optionalBoundedInt('GEMINI_STORE_CREATE_TIMEOUT_MS', 60_000, 5_000, 600_000),
} as const;
