// ═══════════════════════════════════════════════════════════════
// Error Handler — Global error middleware
// Bắt tất cả lỗi, trả JSON response chuẩn
//
// Every answer is `{ success: false, message, code }` (utils/errors.ts): an
// error with its own code keeps it, any other gets the code of its status.
// Status and message are what they always were.
// ═══════════════════════════════════════════════════════════════

import type { Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';
import {
  TENANT_DATA_LIMIT_REACHED_CODE,
  TENANT_DATA_LIMIT_REACHED_MESSAGE,
  TENANT_DATA_LIMIT_REACHED_SQLSTATE,
  TENANT_DATA_QUOTA_RECONCILING_CODE,
  TENANT_DATA_QUOTA_RECONCILING_MESSAGE,
  TENANT_DATA_QUOTA_RECONCILING_SQLSTATE,
} from '../modules/tenants/tenant-data-quota.constants.js';
import { AppError, errorBody, errorCodeForStatus, type ErrorBody } from '../utils/errors.js';

// AppError lives in utils/errors.ts; this re-export keeps the older imports working.
export { AppError };

export const PAYLOAD_TOO_LARGE_CODE = 'PAYLOAD_TOO_LARGE';

/** Code of an unexpected error (a 500 that was not raised on purpose). */
export const INTERNAL_ERROR_CODE = errorCodeForStatus(500);

export const INTERNAL_ERROR_MESSAGE = 'Lỗi hệ thống, vui lòng thử lại sau';
export const PAYLOAD_TOO_LARGE_MESSAGE = 'Dữ liệu gửi lên quá lớn. Vui lòng gửi ít nội dung hơn.';

export interface ErrorResponse {
  status: number;
  body: ErrorBody;
  /** true for an unexpected error: the handler logs it before answering. */
  unexpected: boolean;
}

function propertyOf(err: unknown, key: 'code' | 'type'): unknown {
  if (err === null || (typeof err !== 'object' && typeof err !== 'function')) return undefined;
  return (err as Record<string, unknown>)[key];
}

/** Status and body the global handler answers for an error. No I/O. */
export function describeErrorResponse(err: unknown, options: { production: boolean }): ErrorResponse {
  // AppError — lỗi business logic (mong đợi)
  if (err instanceof AppError) {
    return { status: err.statusCode, body: errorBody(err.statusCode, err.message, err.code), unexpected: false };
  }

  // PostgreSQL quota triggers are the final database enforcement boundary.
  // Map their private SQLSTATE before any raw database detail can reach a UI.
  const code = propertyOf(err, 'code');
  if (code === TENANT_DATA_LIMIT_REACHED_SQLSTATE) {
    return {
      status: 409,
      body: errorBody(409, TENANT_DATA_LIMIT_REACHED_MESSAGE, TENANT_DATA_LIMIT_REACHED_CODE),
      unexpected: false,
    };
  }
  if (code === TENANT_DATA_QUOTA_RECONCILING_SQLSTATE) {
    return {
      status: 503,
      body: errorBody(503, TENANT_DATA_QUOTA_RECONCILING_MESSAGE, TENANT_DATA_QUOTA_RECONCILING_CODE),
      unexpected: false,
    };
  }

  // A JSON body over its route's limit (middleware/body-limits.ts). It used
  // to fall through to the 500 below, with a stack trace in the log.
  if (propertyOf(err, 'type') === 'entity.too.large') {
    return { status: 413, body: errorBody(413, PAYLOAD_TOO_LARGE_MESSAGE, PAYLOAD_TOO_LARGE_CODE), unexpected: false };
  }

  // Anything else is unexpected. Production: ẩn message và stack trace.
  // Its own `code` (a SQLSTATE, a Node error code) is internal and never sent.
  const error = err as { message?: unknown; stack?: unknown } | null | undefined;
  if (options.production) {
    return { status: 500, body: errorBody(500, INTERNAL_ERROR_MESSAGE, INTERNAL_ERROR_CODE), unexpected: true };
  }
  return {
    status: 500,
    body: errorBody(500, error?.message as string, INTERNAL_ERROR_CODE, { stack: error?.stack }),
    unexpected: true,
  };
}

/**
 * Global error handler middleware.
 * Đặt cuối cùng trong middleware chain.
 */
export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  const response = describeErrorResponse(err, { production: env.isProduction });
  // Log lỗi không mong đợi
  if (response.unexpected) console.error('[ERROR]', err?.stack || err?.message);
  res.status(response.status).json(response.body);
}
