// ═══════════════════════════════════════════════════════════════
// Runtime metrics — collectors of this API process
//
// Read on scrape only: event-loop delay (perf_hooks histogram, reset after
// each scrape, so p50/p99/max cover the time since the previous scrape),
// database pool, HTTP requests, AI chat admission, the Redis breaker and the
// process gauges of the heartbeat (role, pid, uptime, memory; heartbeat.logic.ts).
// Every sample carries an `instance` label (PM2 instance number, else pid).
// ═══════════════════════════════════════════════════════════════

import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import { env } from '../../config/env.js';
import { pool } from '../../config/database.js';
import { redisMetricsState } from '../../config/redis.js';
import { processMetricFamilies } from './heartbeat.logic.js';
import { sampleProcess } from './heartbeat.service.js';
import {
  createRequestMetrics,
  formatPrometheus,
  metricsInstanceLabel,
  requestMetricFamilies,
  type MetricFamily,
  type RequestMetrics,
} from './metrics.logic.js';

/** Sampling resolution of the event-loop delay histogram (ms). */
const EVENT_LOOP_RESOLUTION_MS = 20;

export const requestMetrics: RequestMetrics = createRequestMetrics();

let eventLoopDelay: IntervalHistogram | null = null;

/** Starts the event-loop delay sampler (one timer per process). Idempotent. */
export function startEventLoopDelayMonitor(): void {
  if (eventLoopDelay) return;
  eventLoopDelay = monitorEventLoopDelay({ resolution: EVENT_LOOP_RESOLUTION_MS });
  eventLoopDelay.enable();
}

export function stopEventLoopDelayMonitor(): void {
  eventLoopDelay?.disable();
  eventLoopDelay = null;
}

// ── AI chat admission (chat.controller.ts registers its gate) ──

let aiChatActive: () => number = () => 0;
let aiChatRefused = 0;

export function registerAiChatAdmissionGauge(active: () => number): void {
  aiChatActive = active;
}

export function recordAiChatAdmissionRefused(): void {
  aiChatRefused += 1;
}

const NS_PER_SECOND = 1e9;

function eventLoopFamilies(): MetricFamily[] {
  const histogram = eventLoopDelay;
  // An empty histogram reports NaN/huge sentinels; report 0 until it has samples.
  const read = (value: number) => (histogram && histogram.count > 0 && Number.isFinite(value) ? value / NS_PER_SECOND : 0);
  const families: MetricFamily[] = [
    { name: 'landa_event_loop_delay_p50_seconds', help: 'Event-loop delay, median since the previous scrape.', type: 'gauge',
      samples: [{ value: read(histogram?.percentile(50) ?? 0) }] },
    { name: 'landa_event_loop_delay_p99_seconds', help: 'Event-loop delay, 99th percentile since the previous scrape.', type: 'gauge',
      samples: [{ value: read(histogram?.percentile(99) ?? 0) }] },
    { name: 'landa_event_loop_delay_max_seconds', help: 'Event-loop delay, maximum since the previous scrape.', type: 'gauge',
      samples: [{ value: read(histogram?.max ?? 0) }] },
  ];
  histogram?.reset();
  return families;
}

function poolFamilies(): MetricFamily[] {
  return [
    { name: 'landa_db_pool_connections', help: 'Open database connections of this process pool.', type: 'gauge',
      samples: [{ value: pool.totalCount }] },
    { name: 'landa_db_pool_idle_connections', help: 'Idle database connections of this process pool.', type: 'gauge',
      samples: [{ value: pool.idleCount }] },
    { name: 'landa_db_pool_waiting_clients', help: 'Callers waiting for a database connection.', type: 'gauge',
      samples: [{ value: pool.waitingCount }] },
  ];
}

function aiChatFamilies(): MetricFamily[] {
  return [
    { name: 'landa_ai_chat_answers_active', help: 'AI chat answers this process is streaming.', type: 'gauge',
      samples: [{ value: aiChatActive() }] },
    { name: 'landa_ai_chat_admission_refused_total', help: 'AI chat turns refused as busy since the process started.', type: 'counter',
      samples: [{ value: aiChatRefused }] },
  ];
}

function redisFamilies(): MetricFamily[] {
  const state = redisMetricsState();
  return [
    { name: 'landa_redis_configured', help: '1 when REDIS_URL is set.', type: 'gauge', samples: [{ value: state.configured ? 1 : 0 }] },
    { name: 'landa_redis_ready', help: '1 when the Redis connection is ready.', type: 'gauge', samples: [{ value: state.ready ? 1 : 0 }] },
    { name: 'landa_redis_breaker_open', help: '1 while the Redis breaker is open (callers use the database).', type: 'gauge',
      samples: [{ value: state.breakerOpen ? 1 : 0 }] },
  ];
}

/** The heartbeat numbers of this process (the event-loop delay is in eventLoopFamilies). */
function processFamilies(): MetricFamily[] {
  return processMetricFamilies(sampleProcess(env.LANDA_PROCESS_ROLE, null));
}

/** The `instance` label of every sample of this process (metricsInstanceLabel). */
export const METRICS_INSTANCE = metricsInstanceLabel(env.NODE_APP_INSTANCE, process.pid);

export function collectMetricsText(): string {
  return formatPrometheus([
    ...eventLoopFamilies(),
    ...poolFamilies(),
    ...requestMetricFamilies(requestMetrics.snapshot()),
    ...aiChatFamilies(),
    ...redisFamilies(),
    ...processFamilies(),
  ], { instance: METRICS_INSTANCE });
}
