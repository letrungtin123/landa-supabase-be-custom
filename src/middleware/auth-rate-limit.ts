// ═══════════════════════════════════════════════════════════════
// Auth rate limits — sign-in, session refresh and account actions
//
// - Sign-in: failed attempts per typed account identifier (so it never
//   reveals whether the account exists) plus a much larger budget of refused
//   attempts per client IP. Successful sign-ins never count, so thousands of
//   staff behind one office NAT can sign in.
// - Refresh: its own budget per refresh token, plus refused refreshes per IP
//   (a flood of invented tokens), so valid refreshes behind one IP pass.
// - SSO code exchange: refused exchanges per IP, like sign-in.
// - These three never count against the general per-IP API limit.
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

/**
 * For the per-IP budgets only refusals (4xx) count. A server-side failure
 * (5xx, e.g. a database blip) is not the client's fault and must not lock a
 * whole office out once the server recovers.
 */
export function isNotClientRefusal(_req: Request, res: Response): boolean {
  return res.statusCode < 400 || res.statusCode >= 500;
}

function limiter(options: {
  prefix: string;
  windowMs: number;
  limit: number;
  code: RateLimitErrorCode;
  keyGenerator?: (req: Request) => string;
  skipSuccessfulRequests?: boolean;
  requestWasSuccessful?: (req: Request, res: Response) => boolean;
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
    ...(options.requestWasSuccessful ? { requestWasSuccessful: options.requestWasSuccessful } : {}),
    ...(options.sharedStore === false ? {} : { store: new SharedRateLimitStore({ prefix: options.prefix }) }),
    handler: (req, res) => sendRateLimited(req, res, options.code),
  });
}

/**
 * Refused sign-ins per client IP. A request counts while it is in flight and
 * is taken back when it ends without a refusal, so the cap also bounds a
 * burst of parallel guesses from one address.
 */
export const loginIpLimiter = limiter({
  prefix: 'login-ip',
  windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
  limit: env.AUTH_LOGIN_IP_MAX_FAILURES,
  code: 'LOGIN_RATE_LIMITED',
  skipSuccessfulRequests: true,
  requestWasSuccessful: isNotClientRefusal,
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

/** Refused session refreshes per client IP (invented or stale tokens). */
export const refreshIpLimiter = limiter({
  prefix: 'refresh-ip',
  windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
  limit: env.AUTH_REFRESH_IP_MAX_FAILURES,
  code: 'REFRESH_RATE_LIMITED',
  keyGenerator: ipKey,
  skipSuccessfulRequests: true,
  requestWasSuccessful: isNotClientRefusal,
});

/** Refused SSO code exchanges per client IP; shares the sign-in cap. */
export const ssoExchangeIpLimiter = limiter({
  prefix: 'sso-exchange-ip',
  windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
  limit: env.AUTH_LOGIN_IP_MAX_FAILURES,
  code: 'LOGIN_RATE_LIMITED',
  keyGenerator: ipKey,
  skipSuccessfulRequests: true,
  requestWasSuccessful: isNotClientRefusal,
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

// Sign-in, refresh and SSO code exchange carry no bearer token, so the general
// limiter would key them by IP: one office NAT would then share 200 requests a
// minute for every sign-in and refresh. They have their own budgets above.
const OWN_BUDGET_POST_PATHS = new Set(['/api/auth/login', '/api/auth/refresh']);
const SSO_EXCHANGE_PATH = /^\/api\/sso\/exchange\/[^/]+$/;

/** Whether a request is one of the sign-in calls with their own budgets (matched like Express routes: case-insensitive, optional trailing slash). */
export function hasOwnSignInBudget(req: Pick<Request, 'method' | 'baseUrl' | 'path'>): boolean {
  if (req.method !== 'POST') return false;
  const fullPath = `${req.baseUrl}${req.path}`.toLowerCase().replace(/\/+$/, '');
  return OWN_BUDGET_POST_PATHS.has(fullPath) || SSO_EXCHANGE_PATH.test(fullPath);
}

/**
 * General API limit (per verified user, else per client IP). It is mounted
 * on `/api/auth` before the auth routes and again on `/api`; the second mount
 * skips `/auth/*` so an auth request is counted once. Sign-in calls with
 * their own budgets are not counted here.
 */
export const apiLimiter = limiter({
  prefix: 'api',
  windowMs: API_RATE_LIMIT_WINDOW_MS,
  limit: API_RATE_LIMIT_MAX,
  code: 'API_RATE_LIMITED',
  keyGenerator: authenticatedUserOrIpRateLimitKey,
  skip: (req) => (req.baseUrl === '/api' && (req.path === '/auth' || req.path.startsWith('/auth/')))
    || hasOwnSignInBudget(req),
  // High-volume limiter: keep today's per-process counters (no Redis round trip per API call).
  sharedStore: false,
});
