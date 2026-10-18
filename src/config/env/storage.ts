// Env: Supabase Storage (part of `env`, see ../env.ts).

import './load.js';
import { optionalBoundedInt, required } from './helpers.js';

export const storageEnv = {
  // Supabase Storage
  SUPABASE_URL: required('SUPABASE_URL'),
  SUPABASE_SERVICE_KEY: required('SUPABASE_SERVICE_KEY'),
  // Storage proxy (/api/storage): how long it waits for Storage to start
  // answering. A long video body is never cut by it.
  STORAGE_PROXY_HEADERS_TIMEOUT_MS: optionalBoundedInt('STORAGE_PROXY_HEADERS_TIMEOUT_MS', 15_000, 1_000, 120_000),
  // Worker downloads to a temp file (KB documents for Gemini): the body is
  // abandoned when no byte arrives for this long (not a total deadline).
  STORAGE_DOWNLOAD_IDLE_TIMEOUT_MS: optionalBoundedInt('STORAGE_DOWNLOAD_IDLE_TIMEOUT_MS', 60_000, 5_000, 600_000),
} as const;
