// ═══════════════════════════════════════════════════════════════
// Authenticate Middleware — Verify JWT access token
// Gắn req.user nếu token hợp lệ
// ═══════════════════════════════════════════════════════════════

import type { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../utils/jwt.js';
import { sendError } from '../utils/response.js';
import type { AuthUser } from '../types/express.js';

// ── In-memory blacklist: users cần force re-auth (role đã thay đổi) ──
// Key = userId, Value = timestamp khi blacklist
// Entries tự xóa sau TOKEN_BLACKLIST_TTL_MS (= JWT access token lifetime)
const TOKEN_BLACKLIST_TTL_MS = 16 * 60 * 1000; // 16 phút (> 15m JWT expiry)
const userBlacklist = new Map<string, number>();

/** Thêm user vào blacklist — gọi khi admin thay đổi role */
export function blacklistUser(userId: string): void {
  userBlacklist.set(userId, Date.now());
}

/** Cleanup expired entries (chạy lazy, không cần interval riêng) */
function cleanupBlacklist(): void {
  const now = Date.now();
  for (const [uid, ts] of userBlacklist) {
    if (now - ts > TOKEN_BLACKLIST_TTL_MS) {
      userBlacklist.delete(uid);
    }
  }
}

// Cleanup mỗi 5 phút
setInterval(cleanupBlacklist, 5 * 60 * 1000);

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

    // ── Check blacklist: user bị force re-auth (role thay đổi) ──
    const blacklistedAt = userBlacklist.get(payload.sub);
    if (blacklistedAt) {
      // JWT được sign TRƯỚC khi blacklist → reject
      // JWT được sign SAU blacklist → OK (đã có role mới)
      const tokenIssuedAt = (payload as any).iat ? (payload as any).iat * 1000 : 0;
      if (tokenIssuedAt < blacklistedAt) {
        sendError(res, 'Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại', 401);
        return;
      }
    }

    // Xác định tenant_id:
    // 1. Từ JWT token (tid) — mặc định
    // 2. Từ header X-Tenant-ID — CHỈ cho superadmin chuyển tenant
    let tenantId = payload.tid;
    const headerTenantId = req.headers['x-tenant-id'] as string | undefined;

    // BẢO MẬT: CHỈ superadmin mới được override tenant qua header
    if (headerTenantId && payload.role === 'superadmin') {
      tenantId = headerTenantId;
    }

    // Gắn user info vào request
    req.user = {
      id: payload.sub,
      tenantId,
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

      // Check blacklist
      const blacklistedAt = userBlacklist.get(payload.sub);
      if (blacklistedAt) {
        const tokenIssuedAt = (payload as any).iat ? (payload as any).iat * 1000 : 0;
        if (tokenIssuedAt < blacklistedAt) {
          // Token cũ → bỏ qua, coi như chưa auth
          next();
          return;
        }
      }

      let tenantId = payload.tid;
      const headerTenantId = req.headers['x-tenant-id'] as string | undefined;
      if (headerTenantId && payload.role === 'superadmin') {
        tenantId = headerTenantId;
      }
      req.user = {
        id: payload.sub,
        tenantId,
        role: payload.role as AuthUser['role'],
        username: payload.username,
      };
    } catch {
      // Token lỗi → bỏ qua, req.user = undefined
    }
  }

  next();
}
