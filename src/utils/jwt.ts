// ═══════════════════════════════════════════════════════════════
// JWT Utils — Sign & verify access/refresh tokens
// ═══════════════════════════════════════════════════════════════

import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

/** Payload lưu trong access token */
export interface JwtPayload {
  sub: string;        // user.id
  tid: string | null; // tenant_id (null cho superadmin)
  role: string;       // user.role
  username: string;
  session_mode?: 'normal' | 'demo_iframe';
}

/**
 * Tạo JWT access token.
 * Thời hạn lấy từ env JWT_ACCESS_EXPIRES_IN.
 */
export function signAccessToken(payload: JwtPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, {
    expiresIn: Math.floor(parseExpiresIn(env.JWT_ACCESS_EXPIRES_IN) / 1000),
  });
}

/**
 * Verify và decode JWT access token.
 * Throw nếu token hết hạn hoặc không hợp lệ.
 */
export function verifyAccessToken(token: string): JwtPayload {
  return jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] }) as JwtPayload;
}

/**
 * Parse thời gian expire từ string (ví dụ: "7d" → ms).
 * Hỗ trợ: s (seconds), m (minutes), h (hours), d (days).
 */
export function parseExpiresIn(value: string): number {
  const match = value.match(/^(\d+)([smhd])$/);
  if (!match) throw new Error(`[JWT] Invalid expires format: "${value}"`);

  const num = parseInt(match[1], 10);
  const unit = match[2];

  const multipliers: Record<string, number> = {
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };

  return num * multipliers[unit];
}
