// Env: Prometheus metrics endpoint (part of `env`, see ../env.ts).

import './load.js';
import { optionalBoolean } from './helpers.js';

export const metricsEnv = {
  // GET /internal/metrics (Prometheus text): answered only to callers on this
  // host (loopback, no proxy forwarding header). With METRICS_TOKEN set,
  // `Authorization: Bearer <token>` is required too. false = off (404).
  METRICS_ENABLED: optionalBoolean('METRICS_ENABLED', true),
  METRICS_TOKEN: process.env.METRICS_TOKEN?.trim() || '',
  // Set by PM2 (the instance number of the app); the `instance` label of
  // every metric (the pid when unset).
  NODE_APP_INSTANCE: process.env.NODE_APP_INSTANCE?.trim() || '',
} as const;
