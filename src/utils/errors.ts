// ═══════════════════════════════════════════════════════════════
// Errors — AppError and the error body every refusal sends
//
// Every error response is `{ success: false, message, code, ...extra }`:
// - `message` is the text the UI shows, unchanged;
// - `code` is a stable UPPER_SNAKE code. An error raised with its own code
//   keeps it exactly; one without a code gets the code of its HTTP status
//   (BAD_REQUEST, NOT_FOUND, ...), so the frontends can always branch on it;
// - extra fields a response already had (`error`, `field`, `request_id`,
//   `stack` outside production, ...) stay as they were.
// The list of codes is docs/error-codes.md.
//
// No imports: services, middleware and utils can all use this file without
// pulling in env.ts or each other.
// ═══════════════════════════════════════════════════════════════

/** An error raised on purpose: its message, status and code may be shown to the client. */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code?: string;

  constructor(message: string, statusCode = 400, code?: string) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

/** The code an error response gets from its HTTP status when it has no code of its own. */
export const HTTP_STATUS_ERROR_CODES: Readonly<Record<number, string>> = Object.freeze({
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT',
  410: 'GONE',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  416: 'RANGE_NOT_SATISFIABLE',
  422: 'UNPROCESSABLE_ENTITY',
  429: 'TOO_MANY_REQUESTS',
  500: 'INTERNAL_ERROR',
  502: 'BAD_GATEWAY',
  503: 'SERVICE_UNAVAILABLE',
  504: 'GATEWAY_TIMEOUT',
});

/** Any other 4xx status. */
export const CLIENT_ERROR_FALLBACK_CODE = 'BAD_REQUEST';
/** Any other status (5xx, or a status that is not an error status at all). */
export const SERVER_ERROR_FALLBACK_CODE = 'INTERNAL_ERROR';

/** The code of an HTTP status, for an error response without a code of its own. */
export function errorCodeForStatus(status: number): string {
  const known = HTTP_STATUS_ERROR_CODES[status];
  if (known) return known;
  return Number.isInteger(status) && status >= 400 && status < 500
    ? CLIENT_ERROR_FALLBACK_CODE
    : SERVER_ERROR_FALLBACK_CODE;
}

/**
 * The code an error response carries: its own code, unchanged, when it has a
 * non-empty one; otherwise the code of its status.
 */
export function resolveErrorCode(status: number, code?: unknown): string {
  return typeof code === 'string' && code.trim() !== '' ? code : errorCodeForStatus(status);
}

export type ErrorBody = {
  success: false;
  message: string;
  code: string;
} & Record<string, unknown>;

/**
 * `{ success: false, message, code, ...extra }` for an error response. `extra`
 * keeps the fields a response already sent besides these three; it never
 * replaces `success`, `message` or `code`.
 */
export function errorBody(
  status: number,
  message: string,
  code?: unknown,
  extra: Record<string, unknown> = {},
): ErrorBody {
  const body: ErrorBody = { success: false, message, code: resolveErrorCode(status, code) };
  for (const [key, value] of Object.entries(extra)) {
    if (key !== 'success' && key !== 'message' && key !== 'code') body[key] = value;
  }
  return body;
}
