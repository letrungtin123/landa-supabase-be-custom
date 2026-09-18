import type { Request } from 'express';
import { ipKeyGenerator } from 'express-rate-limit';
import { verifyAccessToken } from '../utils/jwt.js';

/**
 * Authenticated API traffic is limited per verified user, while public traffic
 * remains limited by the proxy-resolved client IP. This prevents one shared
 * CDN/proxy address from exhausting an authenticated user's API allowance.
 */
export function authenticatedUserOrIpRateLimitKey(req: Request): string {
  const authorization = req.headers.authorization;
  if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
    try {
      const payload = verifyAccessToken(authorization.slice('Bearer '.length));
      if (typeof payload.sub === 'string' && payload.sub.trim()) {
        return `user:${payload.sub}`;
      }
    } catch {
      // An invalid or expired token must not choose a user bucket.
    }
  }

  return `ip:${ipKeyGenerator(req.ip ?? '0.0.0.0')}`;
}
