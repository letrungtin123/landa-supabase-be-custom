// ═══════════════════════════════════════════════════════════════
// Error Handler — Global error middleware
// Bắt tất cả lỗi, trả JSON response chuẩn
//
// Every answer is `{ success: false, message, code }` (utils/errors.ts): an
// error with its own code keeps it, any other gets the code of its status.
// Status and message are what they always were.
// ═══════════════════════════════════════════════════════════════

import type { Request, Response, NextFunction } from 'express';
import multer from 'multer';
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

export const INVALID_JSON_CODE = 'INVALID_JSON';
export const INVALID_JSON_MESSAGE = 'Dữ liệu gửi lên không đúng định dạng. Vui lòng kiểm tra lại và thử lại.';
export const UNSUPPORTED_ENCODING_CODE = 'UNSUPPORTED_ENCODING';
export const UNSUPPORTED_ENCODING_MESSAGE = 'Dữ liệu gửi lên có định dạng chưa được hỗ trợ. Vui lòng thử lại.';
export const REQUEST_ABORTED_CODE = 'REQUEST_ABORTED';
export const REQUEST_ABORTED_MESSAGE = 'Yêu cầu bị gián đoạn trước khi gửi xong. Vui lòng thử lại.';

/**
 * Request bodies the body parser (express.json, middleware/body-limits.ts)
 * refuses, by the `type` it sets on the error: [status, code, message].
 * The error's message and `body` can quote the request body (a password on
 * the sign-in route), so neither is ever sent or logged.
 */
export const REQUEST_BODY_ERRORS: Readonly<Record<string, readonly [number, string, string]>> = Object.freeze({
  'entity.parse.failed': [400, INVALID_JSON_CODE, INVALID_JSON_MESSAGE],
  'entity.too.large': [413, PAYLOAD_TOO_LARGE_CODE, PAYLOAD_TOO_LARGE_MESSAGE],
  'encoding.unsupported': [415, UNSUPPORTED_ENCODING_CODE, UNSUPPORTED_ENCODING_MESSAGE],
  'charset.unsupported': [415, UNSUPPORTED_ENCODING_CODE, UNSUPPORTED_ENCODING_MESSAGE],
  'request.aborted': [400, REQUEST_ABORTED_CODE, REQUEST_ABORTED_MESSAGE],
});

/**
 * Multipart uploads multer refuses, by the MulterError code: [status, code,
 * message]. They used to fall through to the 500 below. Routes that answer
 * these themselves (bot avatar size, library, course assets, the AI ID video
 * and source uploads) keep their own answers and never get here. The error
 * names the form field (`field`); neither it, a field value nor the file
 * content is ever sent or logged.
 */
export const UPLOAD_ERRORS: Readonly<Record<string, readonly [number, string, string]>> = Object.freeze({
  LIMIT_FILE_SIZE: [413, PAYLOAD_TOO_LARGE_CODE, 'Tệp tải lên quá lớn. Vui lòng chọn tệp nhỏ hơn.'],
  LIMIT_FILE_COUNT: [400, 'UPLOAD_TOO_MANY_FILES', 'Bạn đã chọn quá nhiều tệp. Vui lòng chọn ít tệp hơn và thử lại.'],
  LIMIT_UNEXPECTED_FILE: [
    400,
    'UPLOAD_UNEXPECTED_FILE',
    'Tệp gửi lên không đúng chỗ hoặc nhiều hơn số tệp cho phép. Vui lòng kiểm tra lại và thử lại.',
  ],
  LIMIT_PART_COUNT: [400, 'UPLOAD_TOO_MANY_PARTS', 'Dữ liệu gửi lên có quá nhiều phần. Vui lòng gửi ít nội dung hơn.'],
  LIMIT_FIELD_KEY: [400, 'UPLOAD_FIELD_NAME_TOO_LONG', 'Tên một mục gửi lên quá dài. Vui lòng tải lại trang và thử lại.'],
  LIMIT_FIELD_VALUE: [400, 'UPLOAD_FIELD_VALUE_TOO_LONG', 'Một mục gửi lên quá dài. Vui lòng gửi ít nội dung hơn.'],
  LIMIT_FIELD_COUNT: [400, 'UPLOAD_TOO_MANY_FIELDS', 'Dữ liệu gửi lên có quá nhiều mục. Vui lòng gửi ít nội dung hơn.'],
  MISSING_FIELD_NAME: [400, 'UPLOAD_FIELD_NAME_MISSING', 'Dữ liệu gửi lên thiếu tên mục. Vui lòng tải lại trang và thử lại.'],
});

const MAX_LOGGED_PATH_LENGTH = 200;

export interface ErrorResponse {
  status: number;
  body: ErrorBody;
  /**
   * What the handler logs before answering: an unexpected error with its
   * stack, a refused request body by its type only, a refused upload by its
   * multer code only, or nothing.
   */
  log: 'unexpected' | 'request_body' | 'upload' | 'none';
  /** For log 'request_body': the body parser's error type. */
  requestBodyType?: string;
  /** For log 'upload': the multer error code. */
  uploadErrorCode?: string;
}

function propertyOf(err: unknown, key: 'code' | 'type'): unknown {
  if (err === null || (typeof err !== 'object' && typeof err !== 'function')) return undefined;
  return (err as Record<string, unknown>)[key];
}

/** The body parser's error type, when it is one the handler answers itself. */
function requestBodyErrorType(err: unknown): string | undefined {
  const type = propertyOf(err, 'type');
  return typeof type === 'string' && Object.hasOwn(REQUEST_BODY_ERRORS, type) ? type : undefined;
}

/** The multer code of a refused upload, when it is one the handler answers itself. */
function uploadErrorCode(err: unknown): string | undefined {
  if (!(err instanceof multer.MulterError)) return undefined;
  return typeof err.code === 'string' && Object.hasOwn(UPLOAD_ERRORS, err.code) ? err.code : undefined;
}

/** Status and body the global handler answers for an error. No I/O. */
export function describeErrorResponse(err: unknown, options: { production: boolean }): ErrorResponse {
  // AppError — lỗi business logic (mong đợi)
  if (err instanceof AppError) {
    return { status: err.statusCode, body: errorBody(err.statusCode, err.message, err.code), log: 'none' };
  }

  // PostgreSQL quota triggers are the final database enforcement boundary.
  // Map their private SQLSTATE before any raw database detail can reach a UI.
  const code = propertyOf(err, 'code');
  if (code === TENANT_DATA_LIMIT_REACHED_SQLSTATE) {
    return {
      status: 409,
      body: errorBody(409, TENANT_DATA_LIMIT_REACHED_MESSAGE, TENANT_DATA_LIMIT_REACHED_CODE),
      log: 'none',
    };
  }
  if (code === TENANT_DATA_QUOTA_RECONCILING_SQLSTATE) {
    return {
      status: 503,
      body: errorBody(503, TENANT_DATA_QUOTA_RECONCILING_MESSAGE, TENANT_DATA_QUOTA_RECONCILING_CODE),
      log: 'none',
    };
  }

  // A request body the JSON parser refused: over its route's limit
  // (middleware/body-limits.ts), malformed, in an unsupported encoding or
  // charset, or cut off. These used to fall through to the 500 below, with
  // the parse message (which quotes the body) in the log and, outside
  // production, in the answer.
  const requestBodyType = requestBodyErrorType(err);
  if (requestBodyType) {
    const [status, bodyCode, message] = REQUEST_BODY_ERRORS[requestBodyType];
    return { status, body: errorBody(status, message, bodyCode), log: 'request_body', requestBodyType };
  }

  // A multipart upload multer refused (file too large, too many files or
  // fields, an unexpected file field) on a route that does not answer it.
  const uploadCode = uploadErrorCode(err);
  if (uploadCode) {
    const [status, bodyCode, message] = UPLOAD_ERRORS[uploadCode];
    return { status, body: errorBody(status, message, bodyCode), log: 'upload', uploadErrorCode: uploadCode };
  }

  // Anything else is unexpected. Production: ẩn message và stack trace.
  // Its own `code` (a SQLSTATE, a Node error code) is internal and never sent.
  const error = err as { message?: unknown; stack?: unknown } | null | undefined;
  if (options.production) {
    return { status: 500, body: errorBody(500, INTERNAL_ERROR_MESSAGE, INTERNAL_ERROR_CODE), log: 'unexpected' };
  }
  return {
    status: 500,
    body: errorBody(500, error?.message as string, INTERNAL_ERROR_CODE, { stack: error?.stack }),
    log: 'unexpected',
  };
}

/**
 * Global error handler middleware.
 * Đặt cuối cùng trong middleware chain.
 */
export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  const response = describeErrorResponse(err, { production: env.isProduction });
  // Log lỗi không mong đợi
  if (response.log === 'unexpected') console.error('[ERROR]', err?.stack || err?.message);
  else if (response.log === 'request_body') logRequestBodyRefusal(req, response);
  else if (response.log === 'upload') logUploadRefusal(req, response);
  res.status(response.status).json(response.body);
}

/** Path of the request without its query string (which can carry a token), bounded. */
function loggedPathOf(req: Pick<Request, 'originalUrl' | 'url'>): string {
  const url = typeof req.originalUrl === 'string' ? req.originalUrl : String(req.url ?? '');
  return url.split('?')[0].replace(/[^\x20-\x7e]/g, '_').slice(0, MAX_LOGGED_PATH_LENGTH);
}

/** One line per refused body: its type, status, method and path. Never its message, body or stack. */
function logRequestBodyRefusal(req: Pick<Request, 'method' | 'originalUrl' | 'url'>, response: ErrorResponse): void {
  console.warn(
    `[RequestBody] ${JSON.stringify({
      event: 'request_body_refused',
      type: response.requestBodyType,
      status: response.status,
      method: String(req.method ?? '').slice(0, 16),
      path: loggedPathOf(req),
    })}`,
  );
}

/** One line per refused upload: its multer code, status, method and path. Never a field name, value or file. */
function logUploadRefusal(req: Pick<Request, 'method' | 'originalUrl' | 'url'>, response: ErrorResponse): void {
  console.warn(
    `[Upload] ${JSON.stringify({
      event: 'upload_refused',
      multer_code: response.uploadErrorCode,
      status: response.status,
      method: String(req.method ?? '').slice(0, 16),
      path: loggedPathOf(req),
    })}`,
  );
}
