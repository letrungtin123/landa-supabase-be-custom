// ═══════════════════════════════════════════════════════════════
// Process heartbeat — pure parts (no I/O, no timers)
//
// One sample of a process: role, pid, PM2 instance, uptime, memory and the
// event-loop delay since the previous sample. heartbeat.service.ts logs it
// every HEARTBEAT_INTERVAL_MS in the background process and the workers;
// GET /internal/metrics (metrics.service.ts) serves the same numbers of an
// API process as gauges.
// ═══════════════════════════════════════════════════════════════

import type { MetricFamily } from './metrics.logic.js';

export const HEARTBEAT_INTERVAL_MS = 60_000;

export interface EventLoopLagMs {
  p50: number;
  p99: number;
  max: number;
}

export interface HeartbeatSample {
  role: string;
  pid: number;
  /** PM2 instance number, else the pid (metricsInstanceLabel). */
  instance: string;
  uptimeSeconds: number;
  memory: Pick<NodeJS.MemoryUsage, 'rss' | 'heapUsed' | 'heapTotal' | 'external'>;
  lagMs: EventLoopLagMs;
}

/** What perf_hooks' IntervalHistogram offers (nanoseconds). */
export interface DelayHistogramReading {
  count: number;
  max: number;
  percentile(percentile: number): number;
}

const NS_PER_MS = 1e6;

/** Delay percentiles in ms (one decimal); 0 while the histogram has no samples. */
export function eventLoopLagMs(histogram: DelayHistogramReading | null): EventLoopLagMs {
  const read = (nanoseconds: number) =>
    histogram && histogram.count > 0 && Number.isFinite(nanoseconds) ? Math.round(nanoseconds / NS_PER_MS * 10) / 10 : 0;
  return {
    p50: read(histogram?.percentile(50) ?? 0),
    p99: read(histogram?.percentile(99) ?? 0),
    max: read(histogram?.max ?? 0),
  };
}

/** The fields of a `process_heartbeat` log record. */
export function heartbeatFields(sample: HeartbeatSample): Record<string, string | number> {
  return {
    role: sample.role,
    pid: sample.pid,
    instance: sample.instance,
    uptime_seconds: Math.round(sample.uptimeSeconds),
    rss_bytes: sample.memory.rss,
    heap_used_bytes: sample.memory.heapUsed,
    heap_total_bytes: sample.memory.heapTotal,
    external_bytes: sample.memory.external,
    event_loop_lag_p50_ms: sample.lagMs.p50,
    event_loop_lag_p99_ms: sample.lagMs.p99,
    event_loop_lag_max_ms: sample.lagMs.max,
  };
}

/** Process gauges for GET /internal/metrics (the event-loop delay has its own families). */
export function processMetricFamilies(sample: Omit<HeartbeatSample, 'lagMs' | 'instance'>): MetricFamily[] {
  return [
    {
      name: 'landa_process_info',
      help: 'Always 1; the labels say the process role and pid.',
      type: 'gauge',
      samples: [{ labels: { role: sample.role, pid: String(sample.pid) }, value: 1 }],
    },
    {
      name: 'landa_process_uptime_seconds',
      help: 'Seconds since the process started.',
      type: 'gauge',
      samples: [{ value: Math.round(sample.uptimeSeconds) }],
    },
    {
      name: 'landa_process_resident_memory_bytes',
      help: 'Resident set size of the process.',
      type: 'gauge',
      samples: [{ value: sample.memory.rss }],
    },
    {
      name: 'landa_process_heap_used_bytes',
      help: 'V8 heap in use.',
      type: 'gauge',
      samples: [{ value: sample.memory.heapUsed }],
    },
    {
      name: 'landa_process_heap_total_bytes',
      help: 'V8 heap reserved.',
      type: 'gauge',
      samples: [{ value: sample.memory.heapTotal }],
    },
  ];
}
