// ═══════════════════════════════════════════════════════════════
// Authenticate Middleware — Verify JWT access token
// Gắn req.user nếu token hợp lệ
// ═══════════════════════════════════════════════════════════════

import type { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../utils/jwt.js';
import { sendError } from '../utils/response.js';
import type { AuthUser } from '../types/express.js';

/**
 * Middleware xác thực JWT.
 * Đọc token từ header "Authorization: Bearer <token>".
 * Gắn req.user nếu hợp lệ, trả 401 nếu không.
 */
export function authenticate(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    sendError(res, 'Token không được cung cấp', 401);
    return;
  }

  const token = authHeader.slice(7); // Bỏ "Bearer "

  try {
    const payload = verifyAccessToken(token);

    // Gắn user info vào request
    req.user = {
      id: payload.sub,
      tenantId: payload.tid,
      role: payload.role as AuthUser['role'],
      username: payload.username,
    };

    next();
  } catch (err: unknown) {
    const message = err instanceof Error && err.name === 'TokenExpiredError'
      ? 'Token đã hết hạn'
      : 'Token không hợp lệ';
    sendError(res, message, 401);
  }
}

/**
 * Middleware xác thực tùy chọn — không trả lỗi nếu thiếu token.
 * Dùng cho endpoint công khai nhưng muốn biết user nếu có.
 */
export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (authHeader?.startsWith('Bearer ')) {
    try {
      const payload = verifyAccessToken(authHeader.slice(7));
      req.user = {
        id: payload.sub,
        tenantId: payload.tid,
        role: payload.role as AuthUser['role'],
        username: payload.username,
      };
    } catch {
      // Token lỗi → bỏ qua, req.user = undefined
    }
  }

  next();
}
