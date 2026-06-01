// ═══════════════════════════════════════════════════════════════
// Error Handler — Global error middleware
// Bắt tất cả lỗi, trả JSON response chuẩn
// ═══════════════════════════════════════════════════════════════

import type { Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';

/**
 * Custom error class cho business logic errors.
 */
export class AppError extends Error {
  public readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
  }
}

/**
 * Global error handler middleware.
 * Đặt cuối cùng trong middleware chain.
 */
export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  // AppError — lỗi business logic (mong đợi)
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      success: false,
      message: err.message,
    });
    return;
  }

  // Log lỗi không mong đợi
  console.error('[ERROR]', err.stack || err.message);

  // Production: ẩn stack trace
  const message = env.isProduction
    ? 'Lỗi hệ thống, vui lòng thử lại sau'
    : err.message;

  res.status(500).json({
    success: false,
    message,
    ...(env.isProduction ? {} : { stack: err.stack }),
  });
}
