// ═══════════════════════════════════════════════════════════════
// Client-safe errors — what a controller may tell the browser
//
// Only errors the code raised on purpose (AppError and its subclasses) pass
// their message, status and code through. The tenant quota triggers keep
// their fixed answer. Everything else (database, storage, AI provider,
// network, programming errors) becomes one fixed plain message in the
// request language; the detail is written to the server log only.
// ═══════════════════════════════════════════════════════════════

import type { Request, Response } from 'express';
import { AppError } from '../middleware/error-handler.js';
import {
  TENANT_DATA_LIMIT_REACHED_CODE,
  TENANT_DATA_LIMIT_REACHED_MESSAGE,
  TENANT_DATA_LIMIT_REACHED_SQLSTATE,
  TENANT_DATA_QUOTA_RECONCILING_CODE,
  TENANT_DATA_QUOTA_RECONCILING_MESSAGE,
  TENANT_DATA_QUOTA_RECONCILING_SQLSTATE,
} from '../modules/tenants/tenant-data-quota.constants.js';

/** [HTTP status, Vietnamese, English] for an error that must not be shown as is. */
export const UNEXPECTED_ERROR = [
  500,
  'Chưa thể hoàn tất thao tác. Vui lòng thử lại sau ít phút.',
  'This could not be completed. Please try again in a few minutes.',
] as const;

export const UNEXPECTED_ERROR_CODE = 'REQUEST_FAILED';

export interface ClientErrorBody {
  status: number;
  message: string;
  code?: string;
  /** false when the message is the fixed fallback (the real cause is only logged). */
  known: boolean;
}

export function requestUiLocaleOf(req: Pick<Request, 'get'> | undefined): 'vi' | 'en' {
  return req?.get?.('X-UI-Locale')?.trim().toLowerCase() === 'en' ? 'en' : 'vi';
}

export function describeClientError(err: unknown, locale: 'vi' | 'en'): ClientErrorBody {
  if (err instanceof AppError) {
    return { status: err.statusCode, message: err.message, ...(err.code ? { code: err.code } : {}), known: true };
  }
  const sqlState = (err as { code?: unknown } | null)?.code;
  if (sqlState === TENANT_DATA_LIMIT_REACHED_SQLSTATE) {
    return { status: 409, message: TENANT_DATA_LIMIT_REACHED_MESSAGE, code: TENANT_DATA_LIMIT_REACHED_CODE, known: true };
  }
  if (sqlState === TENANT_DATA_QUOTA_RECONCILING_SQLSTATE) {
    return { status: 503, message: TENANT_DATA_QUOTA_RECONCILING_MESSAGE, code: TENANT_DATA_QUOTA_RECONCILING_CODE, known: true };
  }
  const [status, vi, en] = UNEXPECTED_ERROR;
  return { status, message: locale === 'en' ? en : vi, code: UNEXPECTED_ERROR_CODE, known: false };
}

/** Message for an item inside a successful response (e.g. one file of a batch upload). */
export function clientErrorMessage(err: unknown, locale: 'vi' | 'en', context: string): string {
  const described = describeClientError(err, locale);
  if (!described.known) logUnexpected(context, err);
  return described.message;
}

function logUnexpected(context: string, err: unknown): void {
  console.error(`[${context}] request failed:`, err instanceof Error ? (err.stack || err.message) : err);
}

/** Sends `{ success: false, message, code? }` for any caught error. */
export function sendClientError(req: Request, res: Response, err: unknown, context: string): void {
  const described = describeClientError(err, requestUiLocaleOf(req));
  if (!described.known) logUnexpected(context, err);
  res.status(described.status).json({
    success: false,
    message: described.message,
    ...(described.code ? { code: described.code } : {}),
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/** Strict ISO-8601 timestamp (as produced by Date#toISOString or with an offset). */
export function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 40) return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
  return Number.isFinite(Date.parse(value));
}
