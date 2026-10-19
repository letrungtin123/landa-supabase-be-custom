// ═══════════════════════════════════════════════════════════════
// Authenticate Middleware — Verify JWT access token
// Gắn req.user nếu token hợp lệ
// ═══════════════════════════════════════════════════════════════

import type { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../utils/jwt.js';
import { sendError } from '../utils/response.js';
import type { AuthUser } from '../types/express.js';
import { isAccessTokenRevoked } from '../modules/auth/auth-revocation.service.js';
import { isRuntimeTenantAllowed } from '../config/runtime-tenant-fence.js';
import { clusterBus } from '../config/cluster-bus.js';

// ── In-memory blacklist: users cần force re-auth (role đã thay đổi) ──
// Key = userId, Value = timestamp khi blacklist
// Entries tự xóa sau TOKEN_BLACKLIST_TTL_MS (= JWT access token lifetime)
const TOKEN_BLACKLIST_TTL_MS = 16 * 60 * 1000; // 16 phút (> 15m JWT expiry)
type SessionMode = 'normal' | 'demo_iframe';
type BlacklistScope = SessionMode | 'all';
type BlacklistEntry = Partial<Record<BlacklistScope, number>>;
const userBlacklist = new Map<string, BlacklistEntry>();
const BLACKLIST_SCOPES: readonly BlacklistScope[] = ['all', 'normal', 'demo_iframe'];
// Every process keeps the list: an entry made in one process reaches the
// others through the cluster bus with its original instant. The sessions it
// cuts also have their refresh tokens revoked in the database, so a process
// that missed the message (bus down) refuses them by the access-token expiry.
const BLACKLIST_EVENT = 'auth.blacklist';

function recordBlacklist(userId: string, scope: BlacklistScope, at: number): void {
  const entry = userBlacklist.get(userId) ?? {};
  entry[scope] = Math.max(entry[scope] ?? 0, at);
  userBlacklist.set(userId, entry);
}

clusterBus.on(BLACKLIST_EVENT, (payload) => {
  const { user_id: userId, scope, at } = payload;
  if (typeof userId !== 'string' || !BLACKLIST_SCOPES.includes(scope as BlacklistScope)
    || typeof at !== 'number' || !Number.isFinite(at)) return;
  recordBlacklist(userId, scope as BlacklistScope, at);
});

/** Thêm user vào blacklist — gọi khi admin thay đổi role (every process). */
export function blacklistUser(userId: string, scope: BlacklistScope = 'all'): void {
  const at = Date.now();
  recordBlacklist(userId, scope, at);
  void clusterBus.publish(BLACKLIST_EVENT, { user_id: userId, scope, at });
}

/** Cleanup expired entries (chạy lazy, không cần interval riêng) */
function cleanupBlacklist(): void {
  const now = Date.now();
  for (const [uid, entry] of userBlacklist) {
    for (const scope of Object.keys(entry) as BlacklistScope[]) {
      const ts = entry[scope];
      if (ts && now - ts > TOKEN_BLACKLIST_TTL_MS) {
        delete entry[scope];
      }
    }
    if (!entry.all && !entry.normal && !entry.demo_iframe) {
      userBlacklist.delete(uid);
    }
  }
}

let blacklistSweeper: NodeJS.Timeout | null = null;

/**
 * Cleanup mỗi 5 phút. Started once per process by the process startup
 * (config/process-startup.ts, every role) or a worker entry point, never at
 * import. Returns the running timer (the same one when already started).
 */
export function startBlacklistSweeper(): NodeJS.Timeout {
  blacklistSweeper ??= setInterval(cleanupBlacklist, 5 * 60 * 1000);
  return blacklistSweeper;
}

function normalizeSessionMode(value: unknown): SessionMode {
  return value === 'demo_iframe' ? 'demo_iframe' : 'normal';
}

function getBlacklistedAt(userId: string, sessionMode: SessionMode): number {
  const entry = userBlacklist.get(userId);
  if (!entry) return 0;
  return Math.max(entry.all ?? 0, entry[sessionMode] ?? 0);
}

/**
 * Middleware xác thực JWT.
 * Đọc token từ header "Authorization: Bearer <token>".
 * Gắn req.user nếu hợp lệ, trả 401 nếu không.
 */
export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    sendError(res, 'Token không được cung cấp', 401);
    return;
  }

  const token = authHeader.slice(7); // Bỏ "Bearer "

  try {
    const payload = verifyAccessToken(token);

    // Durable revocation: a permanent deletion refuses every token; a password
    // change/reset, deactivation or role change refuses tokens issued before it.
    if (await isAccessTokenRevoked(payload.sub, payload.iat)) {
      sendError(res, 'Phiên đăng nhập đã bị thu hồi', 401);
      return;
    }

    // ── Check blacklist: user bị force re-auth (role thay đổi) ──
    const blacklistedAt = getBlacklistedAt(payload.sub, normalizeSessionMode(payload.session_mode));
    if (blacklistedAt) {
      // JWT được sign TRƯỚC khi blacklist → reject
      // JWT được sign SAU blacklist → OK (đã có role mới)
      const tokenIssuedAt = payload.iat ? payload.iat * 1000 : 0;
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

    if (tenantId && !isRuntimeTenantAllowed(tenantId)) {
      sendError(res, 'Tenant không được phục vụ bởi runtime này', 403);
      return;
    }

    // Gắn user info vào request
    req.user = {
      id: payload.sub,
      tenantId,
      role: payload.role as AuthUser['role'],
      username: payload.username,
      sessionMode: payload.session_mode === 'demo_iframe' ? 'demo_iframe' : 'normal',
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
export async function optionalAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;

  if (authHeader?.startsWith('Bearer ')) {
    try {
      const payload = verifyAccessToken(authHeader.slice(7));

      if (await isAccessTokenRevoked(payload.sub, payload.iat)) {
        next();
        return;
      }

      // Check blacklist
      const blacklistedAt = getBlacklistedAt(payload.sub, normalizeSessionMode(payload.session_mode));
      if (blacklistedAt) {
        const tokenIssuedAt = payload.iat ? payload.iat * 1000 : 0;
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
      if (tenantId && !isRuntimeTenantAllowed(tenantId)) {
        next();
        return;
      }
      req.user = {
        id: payload.sub,
        tenantId,
        role: payload.role as AuthUser['role'],
        username: payload.username,
        sessionMode: payload.session_mode === 'demo_iframe' ? 'demo_iframe' : 'normal',
      };
    } catch {
      // Token lỗi → bỏ qua, req.user = undefined
    }
  }

  next();
}
