// Env: admin reports — admission, Excel exports, PDF export, report chat and
// the AI Report model (part of `env`, see ../env.ts). REPORTS_DB_POOL_MAX is in ./database.ts.

import './load.js';
import { optionalBoolean, optionalBoundedInt, optionalOneOf, optionalString } from './helpers.js';

export const reportsEnv = {
  // Report aggregates (a report page read that misses the cache, one report
  // chat turn) running at once on this process, per tenant and in total. Past
  // a limit a request waits up to REPORTS_ADMISSION_WAIT_MS for a slot, then
  // gets 429 REPORTS_BUSY (0 = refuse at once).
  REPORTS_TENANT_CONCURRENCY: optionalBoundedInt('REPORTS_TENANT_CONCURRENCY', 2, 1, 64),
  REPORTS_GLOBAL_CONCURRENCY: optionalBoundedInt('REPORTS_GLOBAL_CONCURRENCY', 8, 1, 512),
  REPORTS_ADMISSION_WAIT_MS: optionalBoundedInt('REPORTS_ADMISSION_WAIT_MS', 2_000, 0, 30_000),
  // Excel exports in progress at once on this process, per user, per tenant
  // and in total; one more is refused at once with 429. Each export holds one
  // reports-pool connection for its whole read-only snapshot.
  REPORTS_EXPORT_USER_CONCURRENCY: optionalBoundedInt('REPORTS_EXPORT_USER_CONCURRENCY', 1, 1, 8),
  REPORTS_EXPORT_TENANT_CONCURRENCY: optionalBoundedInt('REPORTS_EXPORT_TENANT_CONCURRENCY', 2, 1, 32),
  REPORTS_EXPORT_GLOBAL_CONCURRENCY: optionalBoundedInt('REPORTS_EXPORT_GLOBAL_CONCURRENCY', 2, 1, 64),
  // statement_timeout inside an export's snapshot transaction only; every
  // other report statement keeps the pool's 30 s.
  REPORTS_EXPORT_STATEMENT_TIMEOUT_MS: optionalBoundedInt(
    'REPORTS_EXPORT_STATEMENT_TIMEOUT_MS',
    120_000,
    30_000,
    900_000,
  ),

  // Report PDF export: HTML/CSS rendered to PDF by a locally installed
  // Chromium-based browser (no browser download). PATH wins over CHANNEL.
  REPORT_PDF_BROWSER_PATH: optionalString('REPORT_PDF_BROWSER_PATH', ''),
  REPORT_PDF_BROWSER_CHANNEL: optionalOneOf('REPORT_PDF_BROWSER_CHANNEL', 'msedge', [
    'msedge',
    'chrome',
    'chromium',
  ] as const),
  REPORT_PDF_RENDER_CONCURRENCY: optionalBoundedInt('REPORT_PDF_RENDER_CONCURRENCY', 2, 1, 8),
  REPORT_PDF_RENDER_QUEUE_LIMIT: optionalBoundedInt('REPORT_PDF_RENDER_QUEUE_LIMIT', 20, 0, 200),
  REPORT_PDF_RENDER_TIMEOUT_MS: optionalBoundedInt('REPORT_PDF_RENDER_TIMEOUT_MS', 30_000, 5_000, 120_000),
  REPORT_PDF_BROWSER_IDLE_CLOSE_MS: optionalBoundedInt('REPORT_PDF_BROWSER_IDLE_CLOSE_MS', 600_000, 0, 86_400_000),
  REPORT_PDF_STORAGE_ENABLED: optionalBoolean('REPORT_PDF_STORAGE_ENABLED', false),
  REPORT_PDF_AI_NARRATIVE_ENABLED: optionalBoolean('REPORT_PDF_AI_NARRATIVE_ENABLED', false),
  REPORT_PDF_AI_NARRATIVE_TIMEOUT_MS: optionalBoundedInt('REPORT_PDF_AI_NARRATIVE_TIMEOUT_MS', 20_000, 3_000, 60_000),
  REPORT_PDF_RATE_LIMIT_WINDOW_SECONDS: optionalBoundedInt('REPORT_PDF_RATE_LIMIT_WINDOW_SECONDS', 600, 60, 86_400),
  REPORT_PDF_USER_EXPORTS_PER_WINDOW: optionalBoundedInt('REPORT_PDF_USER_EXPORTS_PER_WINDOW', 10, 1, 1_000),
  REPORT_PDF_TENANT_EXPORTS_PER_WINDOW: optionalBoundedInt('REPORT_PDF_TENANT_EXPORTS_PER_WINDOW', 60, 1, 10_000),
  // Exports of one tenant that may be in progress at once on an API process.
  REPORT_PDF_TENANT_ACTIVE_JOBS: optionalBoundedInt('REPORT_PDF_TENANT_ACTIVE_JOBS', 5, 1, 50),
  // Chat report Gemini calls: past the deadline the router continues with the
  // deterministic parser only and the narrative uses its rule-based fallback.
  REPORT_CHAT_ROUTER_TIMEOUT_MS: optionalBoundedInt('REPORT_CHAT_ROUTER_TIMEOUT_MS', 8_000, 1_000, 30_000),
  REPORT_CHAT_NARRATIVE_TIMEOUT_MS: optionalBoundedInt('REPORT_CHAT_NARRATIVE_TIMEOUT_MS', 15_000, 1_000, 60_000),
  /** Model for the AI Report calls (router, chat and PDF narratives). Empty = the tenant chat model. */
  REPORT_AI_MODEL: optionalString('REPORT_AI_MODEL', 'gemini-3.8-flash'),
} as const;
