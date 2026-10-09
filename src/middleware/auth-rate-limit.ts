// ═══════════════════════════════════════════════════════════════
// Auth rate limits — sign-in, session refresh and account actions
//
// - Sign-in: the historical per-IP limit plus a per-account limit on failed
//   attempts (keyed by the typed identifier, so it never reveals whether the
//   account exists).
// - Refresh: its own budget per refresh token, so many users behind one
//   office IP never share the sign-in bucket.
// - Password change, one-time sign-in links and profile updates: strict
//   per-user (or per-IP when anonymous) budgets.
// Counters are shared through Redis when it is available (see
// rate-limit-store.ts); refusals answer in the request language.
// ═══════════════════════════════════════════════════════════════

import { createHash } from 'crypto';
import type { Request, Response } from 'express';
import rateLimit, { ipKeyGenerator, type RateLimitRequestHandler } from 'express-rate-limit';
import { env } from '../config/env.js';
import { authenticatedUserOrIpRateLimitKey } from './rate-limit-key.js';
import { SharedRateLimitStore } from './rate-limit-store.js';

export const AUTH_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
export const API_RATE_LIMIT_WINDOW_MS = 60 * 1000;
export const API_RATE_LIMIT_MAX = 200;

/** [HTTP status, Vietnamese, English] — the response picks by X-UI-Locale. */
export const RATE_LIMIT_ERRORS = {
  LOGIN_RATE_LIMITED: [
    429,
    'Bạn đã thử đăng nhập quá nhiều lần. Vui lòng đợi 15 phút rồi thử lại.',
    'Too many sign-in attempts. Please wait 15 minutes and try again.',
  ],
  REFRESH_RATE_LIMITED: [
    429,
    'Có quá nhiều yêu cầu giữ phiên đăng nhập. Vui lòng đợi ít phút rồi thử lại.',
    'Too many attempts to keep you signed in. Please wait a few minutes and try again.',
  ],
  PASSWORD_CHANGE_RATE_LIMITED: [
    429,
    'Bạn đã thử đổi mật khẩu quá nhiều lần. Vui lòng đợi 15 phút rồi thử lại.',
    'Too many password change attempts. Please wait 15 minutes and try again.',
  ],
  ACCOUNT_ACTION_RATE_LIMITED: [
    429,
    'Bạn thao tác quá nhiều lần. Vui lòng đợi ít phút rồi thử lại.',
    'You have done this too many times. Please wait a few minutes and try again.',
  ],
  API_RATE_LIMITED: [
    429,
    'Có quá nhiều yêu cầu. Vui lòng đợi một lát rồi thử lại.',
    'Too many requests. Please wait a moment and try again.',
  ],
} as const satisfies Record<string, readonly [number, string, string]>;

export type RateLimitErrorCode = keyof typeof RATE_LIMIT_ERRORS;

function requestLocale(req: Request): 'vi' | 'en' {
  return req.get('X-UI-Locale')?.trim().toLowerCase() === 'en' ? 'en' : 'vi';
}

/** Sends the localized refusal for a limiter. */
export function sendRateLimited(req: Request, res: Response, code: RateLimitErrorCode): void {
  const [status, vi, en] = RATE_LIMIT_ERRORS[code];
  res.status(status).json({ success: false, code, message: requestLocale(req) === 'en' ? en : vi });
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 40);
}

function ipKey(req: Request): string {
  return `ip:${ipKeyGenerator(req.ip ?? '0.0.0.0')}`;
}

/** Normalized sign-in identifier; email and username are case-insensitive here. */
export function loginAccountRateLimitKey(req: Request): string {
  const identifier = (req.body as { username?: unknown } | undefined)?.username;
  if (typeof identifier === 'string' && identifier.trim()) {
    return `account:${sha256(identifier.trim().toLowerCase())}`;
  }
  return ipKey(req);
}

/** One budget per refresh token (stored only as a hash). */
export function refreshTokenRateLimitKey(req: Request): string {
  const token = (req.body as { refresh_token?: unknown } | undefined)?.refresh_token;
  if (typeof token === 'string' && token.trim()) {
    return `token:${sha256(token.trim())}`;
  }
  return ipKey(req);
}

function limiter(options: {
  prefix: string;
  windowMs: number;
  limit: number;
  code: RateLimitErrorCode;
  keyGenerator?: (req: Request) => string;
  skipSuccessfulRequests?: boolean;
  skip?: (req: Request) => boolean;
  sharedStore?: boolean;
}): RateLimitRequestHandler {
  return rateLimit({
    windowMs: options.windowMs,
    limit: options.limit,
    standardHeaders: true,
    legacyHeaders: false,
    ...(options.keyGenerator ? { keyGenerator: options.keyGenerator } : {}),
    ...(options.skip ? { skip: options.skip } : {}),
    skipSuccessfulRequests: options.skipSuccessfulRequests ?? false,
    ...(options.sharedStore === false ? {} : { store: new SharedRateLimitStore({ prefix: options.prefix }) }),
    handler: (req, res) => sendRateLimited(req, res, options.code),
  });
}

/** Historical sign-in limit per client IP (all attempts). */
export const loginIpLimiter = limiter({
  prefix: 'login-ip',
  windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
  limit: env.AUTH_LOGIN_IP_MAX_ATTEMPTS,
  code: 'LOGIN_RATE_LIMITED',
});

/** Failed sign-ins per typed account identifier; successful sign-ins do not count. */
export const loginAccountLimiter = limiter({
  prefix: 'login-account',
  windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
  limit: env.AUTH_LOGIN_ACCOUNT_MAX_FAILURES,
  code: 'LOGIN_RATE_LIMITED',
  keyGenerator: loginAccountRateLimitKey,
  skipSuccessfulRequests: true,
});

/** Session refresh, per refresh token (a token is valid for one successful use). */
export const refreshTokenLimiter = limiter({
  prefix: 'refresh-token',
  windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
  limit: env.AUTH_REFRESH_TOKEN_MAX_ATTEMPTS,
  code: 'REFRESH_RATE_LIMITED',
  keyGenerator: refreshTokenRateLimitKey,
});

/** Password change attempts per signed-in user. */
export const passwordChangeLimiter = limiter({
  prefix: 'password-change',
  windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
  limit: env.AUTH_PASSWORD_CHANGE_MAX_ATTEMPTS,
  code: 'PASSWORD_CHANGE_RATE_LIMITED',
  keyGenerator: authenticatedUserOrIpRateLimitKey,
});

/** One-time sign-in links (create and use) and profile updates. */
export const accountActionLimiter = limiter({
  prefix: 'account-action',
  windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
  limit: env.AUTH_ACCOUNT_ACTION_MAX_ATTEMPTS,
  code: 'ACCOUNT_ACTION_RATE_LIMITED',
  keyGenerator: authenticatedUserOrIpRateLimitKey,
});

/**
 * General API limit (per verified user, else per client IP). It is mounted
 * on `/api/auth` before the auth routes and again on `/api`; the second mount
 * skips `/auth/*` so an auth request is counted once.
 */
export const apiLimiter = limiter({
  prefix: 'api',
  windowMs: API_RATE_LIMIT_WINDOW_MS,
  limit: API_RATE_LIMIT_MAX,
  code: 'API_RATE_LIMITED',
  keyGenerator: authenticatedUserOrIpRateLimitKey,
  skip: (req) => req.baseUrl === '/api' && (req.path === '/auth' || req.path.startsWith('/auth/')),
  // High-volume limiter: keep today's per-process counters (no Redis round trip per API call).
  sharedStore: false,
});
