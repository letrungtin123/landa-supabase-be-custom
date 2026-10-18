// ═══════════════════════════════════════════════════════════════
// GET /internal/metrics — Prometheus text for this API process
//
// Answered only to a caller on this host: the socket must come from
// loopback and the request must not carry a proxy's forwarding header (a
// gateway on the same host also connects from loopback). With METRICS_TOKEN
// set, `Authorization: Bearer <token>` is required as well. Anything else
// gets the ordinary 404, so the endpoint is not advertised.
// METRICS_ENABLED=false turns it off.
// ═══════════════════════════════════════════════════════════════

import { Router, type Express, type NextFunction, type Request, type Response } from 'express';
import { env } from '../../config/env.js';
import { decideMetricsAccess, type RequestMetrics } from './metrics.logic.js';
import { collectMetricsText, requestMetrics } from './metrics.service.js';

export const METRICS_PATH = '/internal/metrics';

export interface MetricsRouterOptions {
  enabled: boolean;
  token: string;
  collect: () => string;
}

export function createMetricsRouter(options: MetricsRouterOptions): Router {
  const router = Router();
  router.get(METRICS_PATH, function metricsEndpoint(req: Request, res: Response, next: NextFunction) {
    const access = decideMetricsAccess({
      enabled: options.enabled,
      token: options.token,
      remoteAddress: req.socket.remoteAddress,
      headers: req.headers,
    });
    if (access === 'not_found') { next(); return; }
    if (access === 'unauthorized') {
      res.setHeader('WWW-Authenticate', 'Bearer');
      res.status(401).type('text/plain').send('Unauthorized\n');
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.end(options.collect());
  });
  return router;
}

/** Counts every request except the scrape itself. */
export function createRequestMetricsMiddleware(metrics: RequestMetrics) {
  return function requestMetricsMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (req.path === METRICS_PATH) { next(); return; }
    const end = metrics.start(req.path);
    // 'close' fires once the response finished or the connection went away.
    res.once('close', () => end(res.statusCode, res.writableFinished));
    next();
  };
}

/**
 * Mounted first in app.ts so every request is counted. The event-loop delay
 * sampler is started by the process startup (index.ts, before listening),
 * not on import.
 */
export function mountMetrics(app: Express): void {
  if (!env.METRICS_ENABLED) return;
  app.use(createRequestMetricsMiddleware(requestMetrics));
  app.use(createMetricsRouter({ enabled: true, token: env.METRICS_TOKEN, collect: collectMetricsText }));
}
