// ═══════════════════════════════════════════════════════════════
// `trust proxy` of the HTTP app
//
// Express resolves req.ip (rate-limit keys, audit logs) from this setting
// with proxy-addr: forwarded addresses are read from X-Forwarded-For only
// while every hop between the socket and that address is trusted.
// ═══════════════════════════════════════════════════════════════

import type { Express } from 'express';

export interface TrustProxySettings {
  /** Exact proxy allowlist (TRUSTED_PROXY_CIDRS): IPs, CIDRs or loopback/linklocal/uniquelocal. */
  TRUSTED_PROXY_CIDRS: string[];
  /** Legacy hop count (TRUST_PROXY_HOPS), used only when no allowlist is set. */
  TRUST_PROXY_HOPS: number;
}

export function configureTrustProxy(app: Express, settings: TrustProxySettings): void {
  if (settings.TRUSTED_PROXY_CIDRS.length > 0) {
    // A CIDR allowlist is safe even if the backend port is reachable directly:
    // forwarded addresses are considered only when every proxy hop belongs to
    // this explicitly trusted set. Do not replace this with `true` or a broad
    // hop count in production.
    app.set('trust proxy', settings.TRUSTED_PROXY_CIDRS);
    console.log(`[Server] Trust proxy enabled with ${settings.TRUSTED_PROXY_CIDRS.length} exact trusted CIDR(s)`);
  } else if (settings.TRUST_PROXY_HOPS > 0) {
    app.set('trust proxy', settings.TRUST_PROXY_HOPS);
    console.warn(`[Server] Trust proxy enabled by legacy hop count: ${settings.TRUST_PROXY_HOPS}. Configure TRUSTED_PROXY_CIDRS for production.`);
  }
}
