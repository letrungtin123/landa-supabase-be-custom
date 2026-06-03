// ═══════════════════════════════════════════════════════════════
// Response Utils — Format JSON response chuẩn
// Tất cả API đều trả về { success, data?, message?, error? }
// ═══════════════════════════════════════════════════════════════

import type { Response } from 'express';

interface SuccessBody<T = unknown> {
  success: true;
  data: T;
  message?: string;
}

interface ErrorBody {
  success: false;
  message: string;
  error?: string;
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
 * Trả response lỗi.
 */
export function sendError(res: Response, message: string, statusCode = 400, error?: string): void {
  const body: ErrorBody = { success: false, message };
  if (error) body.error = error;
  res.status(statusCode).json(body);
}

