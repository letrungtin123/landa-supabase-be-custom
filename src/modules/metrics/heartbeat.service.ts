// ═══════════════════════════════════════════════════════════════
// Process heartbeat (BE-S14): every HEARTBEAT_INTERVAL_MS one line
//   [Heartbeat] {"event":"process_heartbeat","level":"info","ts":...,"role":"background","pid":...,
//                "uptime_seconds":...,"rss_bytes":...,"heap_used_bytes":...,"event_loop_lag_p99_ms":...}
// in the process that runs the background work (roles all/background) and in
// every worker entry point, plus one `heartbeat_started` line when it starts.
// Started by the process startup or the worker, never on import. The timer
// is unref'd: it never keeps a process alive. Its event-loop delay histogram
// is its own (the /internal/metrics one is reset by each scrape).
// ═══════════════════════════════════════════════════════════════

import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import { env } from '../../config/env.js';
import { createJsonLogger, type JsonLogger } from '../../utils/json-logger.js';
import { eventLoopLagMs, HEARTBEAT_INTERVAL_MS, heartbeatFields, type HeartbeatSample } from './heartbeat.logic.js';
import { metricsInstanceLabel } from './metrics.logic.js';

const EVENT_LOOP_RESOLUTION_MS = 20;

export interface ProcessHeartbeatOptions {
  /** 'all' | 'background' | a worker name such as 'email-outbox-worker'. */
  role: string;
  intervalMs?: number;
  logger?: JsonLogger;
}

let running: { timer: NodeJS.Timeout; histogram: IntervalHistogram } | null = null;

/** One sample of this process now; `histogram` covers the time since its last reset. */
export function sampleProcess(role: string, histogram: IntervalHistogram | null): HeartbeatSample {
  const memory = process.memoryUsage();
  return {
    role,
    pid: process.pid,
    instance: metricsInstanceLabel(env.NODE_APP_INSTANCE, process.pid),
    uptimeSeconds: process.uptime(),
    memory: { rss: memory.rss, heapUsed: memory.heapUsed, heapTotal: memory.heapTotal, external: memory.external },
    lagMs: eventLoopLagMs(histogram),
  };
}

/** Starts the heartbeat of this process (once; a second call returns the running timer). */
export function startProcessHeartbeat(options: ProcessHeartbeatOptions): NodeJS.Timeout {
  if (running) return running.timer;
  const intervalMs = options.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  const logger = options.logger ?? createJsonLogger({ tag: 'Heartbeat' });
  const histogram = monitorEventLoopDelay({ resolution: EVENT_LOOP_RESOLUTION_MS });
  histogram.enable();
  const timer = setInterval(function processHeartbeat() {
    try {
      logger.info('process_heartbeat', heartbeatFields(sampleProcess(options.role, histogram)));
    } finally {
      histogram.reset();
    }
  }, intervalMs);
  timer.unref();
  running = { timer, histogram };
  logger.info('heartbeat_started', { role: options.role, pid: process.pid, interval_ms: intervalMs });
  return timer;
}

export function stopProcessHeartbeat(): void {
  if (!running) return;
  clearInterval(running.timer);
  running.histogram.disable();
  running = null;
}
