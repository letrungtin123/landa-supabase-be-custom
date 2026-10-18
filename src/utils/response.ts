// ═══════════════════════════════════════════════════════════════
// Response Utils — Format JSON response chuẩn
// Tất cả API đều trả về { success, data?, message?, error? }
// Errors: { success: false, message, code, error? } (utils/errors.ts).
// ═══════════════════════════════════════════════════════════════

import type { Response } from 'express';
import { errorBody } from './errors.js';

interface SuccessBody<T = unknown> {
  success: true;
  data: T;
  message?: string;
}

/**
 * Trả response thành công.
 * Data trả về NGUYÊN — các field như avatar_url, file_url, image_url
 * là storage path (VD: "tenant/avatars/abc.jpg").
 * FE tự gắn BE domain để tạo proxy URL: BE_DOMAIN/api/storage/{path}
 */
export function sendSuccess<T>(res: Response, data: T, message?: string, statusCode = 200): void {
  const body: SuccessBody<T> = { success: true, data };
  if (message) body.message = message;
  res.status(statusCode).json(body);
}

/**
 * Trả response lỗi: `{ success: false, message, code }`. `error` (a code
 * such as MODULE_DISABLED) is the code; it is also kept in the `error` field
 * where it always was. Without it, the code comes from the status.
 */
export function sendError(res: Response, message: string, statusCode = 400, error?: string): void {
  res.status(statusCode).json(errorBody(statusCode, message, error, error ? { error } : {}));
}

