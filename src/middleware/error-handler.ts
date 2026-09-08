// ═══════════════════════════════════════════════════════════════
// Error Handler — Global error middleware
// Bắt tất cả lỗi, trả JSON response chuẩn
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

/**
 * Custom error class cho business logic errors.
 */
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
      ...(err.code ? { code: err.code } : {}),
    });
    return;
  }

  // PostgreSQL quota triggers are the final database enforcement boundary.
  // Map their private SQLSTATE before any raw database detail can reach a UI.
  if ((err as { code?: string }).code === TENANT_DATA_LIMIT_REACHED_SQLSTATE) {
    res.status(409).json({
      success: false,
      code: TENANT_DATA_LIMIT_REACHED_CODE,
      message: TENANT_DATA_LIMIT_REACHED_MESSAGE,
    });
    return;
  }

  if ((err as { code?: string }).code === TENANT_DATA_QUOTA_RECONCILING_SQLSTATE) {
    res.status(503).json({
      success: false,
      code: TENANT_DATA_QUOTA_RECONCILING_CODE,
      message: TENANT_DATA_QUOTA_RECONCILING_MESSAGE,
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
