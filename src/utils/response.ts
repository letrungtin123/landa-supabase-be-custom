// ═══════════════════════════════════════════════════════════════
// Response Utils — Format JSON response chuẩn
// Tất cả API đều trả về { success, data?, message?, error? }
// ═══════════════════════════════════════════════════════════════

import type { Response } from 'express';
import { toPublicUrl } from '../config/storage.js';

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

// Fields chứa storage path cần resolve thành full URL
const STORAGE_URL_FIELDS = new Set([
  'avatar_url', 'file_url', 'url', 'download_url', 'thumbnail_url', 'cover_url',
]);

/**
 * Check if value is a plain object (not Date, Buffer, RegExp, etc.)
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Deep-resolve tất cả storage path fields trong data thành full public URLs.
 * Xử lý cả object, array, nested.
 * An toàn cho data cũ (full URL) — toPublicUrl() trả nguyên nếu đã là URL.
 * CHỈ xử lý plain objects — skip Date, Buffer, RegExp, etc.
 */
function resolveStorageUrls<T>(data: T): T {
  if (data === null || data === undefined) return data;

  if (Array.isArray(data)) {
    return data.map(item => resolveStorageUrls(item)) as T;
  }

  if (isPlainObject(data)) {
    const resolved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (STORAGE_URL_FIELDS.has(key) && typeof value === 'string') {
        resolved[key] = toPublicUrl(value);
      } else if (Array.isArray(value)) {
        resolved[key] = value.map(item => resolveStorageUrls(item));
      } else if (isPlainObject(value)) {
        resolved[key] = resolveStorageUrls(value);
      } else {
        resolved[key] = value;
      }
    }
    return resolved as T;
  }

  return data;
}

/**
 * Trả response thành công.
 * Tự động resolve storage paths → full public URLs trong data.
 */
export function sendSuccess<T>(res: Response, data: T, message?: string, statusCode = 200): void {
  const resolvedData = resolveStorageUrls(data);
  const body: SuccessBody<T> = { success: true, data: resolvedData as T };
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
