// ═══════════════════════════════════════════════════════════════
// Runtime metrics — pure parts (no I/O)
//
// Request counters and latency histograms per coarse route group, the
// Prometheus text format and the access rules of GET /internal/metrics.
// Everything here is O(1) per request: one clock read, a map lookup and a
// few additions, so the counters cost nothing measurable on the hot path.
// ═══════════════════════════════════════════════════════════════

import { createHash, timingSafeEqual } from 'node:crypto';

export const ROUTE_GROUPS = ['auth', 'learner', 'reports', 'ai', 'storage', 'other'] as const;
export type RouteGroup = typeof ROUTE_GROUPS[number];

/** Longest prefix first is not needed: the prefixes do not overlap. */
const ROUTE_GROUP_PREFIXES: ReadonlyArray<readonly [string, RouteGroup]> = [
  ['/api/auth', 'auth'],
  ['/api/sso', 'auth'],
  ['/api/learner', 'learner'],
  ['/api/enrollments/study-session', 'learner'],
  ['/api/reports', 'reports'],
  ['/api/ai-chatbot', 'ai'],
  ['/api/ai-credits', 'ai'],
  ['/api/storage', 'storage'],
];

function startsWithSegment(path: string, prefix: string): boolean {
  return path === prefix || (path.startsWith(prefix) && path.charCodeAt(prefix.length) === 47 /* '/' */);
}

export function routeGroupOf(path: string): RouteGroup {
  for (const [prefix, group] of ROUTE_GROUP_PREFIXES) {
    if (startsWithSegment(path, prefix)) return group;
  }
  return 'other';
}

/** Seconds. Long streams (SSE, video) land in +Inf. */
export const LATENCY_BUCKETS_SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30] as const;

export type StatusClass = '1xx' | '2xx' | '3xx' | '4xx' | '5xx' | 'aborted';

export function statusClassOf(statusCode: number, finished: boolean): StatusClass {
  if (!finished) return 'aborted';
  if (statusCode >= 500) return '5xx';
  if (statusCode >= 400) return '4xx';
  if (statusCode >= 300) return '3xx';
  if (statusCode >= 200) return '2xx';
  return '1xx';
}

interface LatencyHistogram {
  /** Per-bucket counts (not cumulative); the last slot is +Inf. */
  buckets: number[];
  sum: number;
  count: number;
}

export interface RequestMetrics {
  /** Call when a request starts; call the returned function once when it ends. */
  start(path: string): (statusCode: number, finished: boolean) => void;
  inFlight(): number;
  snapshot(): RequestMetricsSnapshot;
}

export interface RequestMetricsSnapshot {
  inFlight: number;
  counts: Array<{ group: RouteGroup; statusClass: StatusClass; value: number }>;
  latency: Array<{ group: RouteGroup; cumulativeBuckets: number[]; sum: number; count: number }>;
}

export function createRequestMetrics(now: () => bigint = process.hrtime.bigint): RequestMetrics {
  let inFlight = 0;
  const counts = new Map<string, { group: RouteGroup; statusClass: StatusClass; value: number }>();
  const histograms = new Map<RouteGroup, LatencyHistogram>();
  for (const group of ROUTE_GROUPS) {
    histograms.set(group, { buckets: new Array(LATENCY_BUCKETS_SECONDS.length + 1).fill(0), sum: 0, count: 0 });
  }

  function observe(group: RouteGroup, seconds: number, statusClass: StatusClass): void {
    const histogram = histograms.get(group)!;
    let index = 0;
    while (index < LATENCY_BUCKETS_SECONDS.length && seconds > LATENCY_BUCKETS_SECONDS[index]) index += 1;
    histogram.buckets[index] += 1;
    histogram.sum += seconds;
    histogram.count += 1;
    const key = `${group}|${statusClass}`;
    const counter = counts.get(key);
    if (counter) counter.value += 1;
    else counts.set(key, { group, statusClass, value: 1 });
  }

  return {
    start(path) {
      const group = routeGroupOf(path);
      const startedAt = now();
      inFlight += 1;
      let done = false;
      return (statusCode, finished) => {
        if (done) return;
        done = true;
        inFlight -= 1;
        observe(group, Number(now() - startedAt) / 1e9, statusClassOf(statusCode, finished));
      };
    },
    inFlight: () => inFlight,
    snapshot() {
      return {
        inFlight,
        counts: [...counts.values()].map((entry) => ({ ...entry })),
        latency: ROUTE_GROUPS.map((group) => {
          const histogram = histograms.get(group)!;
          let running = 0;
          const cumulativeBuckets = histogram.buckets.map((value) => (running += value));
          return { group, cumulativeBuckets, sum: histogram.sum, count: histogram.count };
        }),
      };
    },
  };
}

// ── Prometheus text exposition format (version 0.0.4) ──

export type MetricType = 'gauge' | 'counter' | 'histogram';

export interface MetricFamily {
  name: string;
  help: string;
  type: MetricType;
  samples: Array<{ suffix?: string; labels?: Record<string, string>; value: number }>;
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function formatValue(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return '+Inf';
  if (value === -Infinity) return '-Inf';
  return String(value);
}

/**
 * The `instance` label of this process: the PM2 instance number
 * (NODE_APP_INSTANCE) when PM2 set one, else the pid. Several API processes
 * behind one port answer scrapes in turn; the label keeps their numbers apart.
 */
export function metricsInstanceLabel(pm2Instance: string | undefined, pid: number): string {
  return pm2Instance?.trim() || String(pid);
}

/** `constantLabels` come first on every sample (e.g. the process instance). */
export function formatPrometheus(families: readonly MetricFamily[], constantLabels: Readonly<Record<string, string>> = {}): string {
  const lines: string[] = [];
  for (const family of families) {
    lines.push(`# HELP ${family.name} ${family.help}`);
    lines.push(`# TYPE ${family.name} ${family.type}`);
    for (const sample of family.samples) {
      const merged = { ...constantLabels, ...sample.labels };
      const labels = Object.keys(merged).length > 0
        ? `{${Object.entries(merged).map(([key, value]) => `${key}="${escapeLabelValue(value)}"`).join(',')}}`
        : '';
      lines.push(`${family.name}${sample.suffix ?? ''}${labels} ${formatValue(sample.value)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** Request counters and latency histograms as metric families. */
export function requestMetricFamilies(snapshot: RequestMetricsSnapshot): MetricFamily[] {
  const histogramSamples: MetricFamily['samples'] = [];
  for (const entry of snapshot.latency) {
    LATENCY_BUCKETS_SECONDS.forEach((bound, index) => {
      histogramSamples.push({ suffix: '_bucket', labels: { group: entry.group, le: String(bound) }, value: entry.cumulativeBuckets[index] });
    });
    histogramSamples.push({ suffix: '_bucket', labels: { group: entry.group, le: '+Inf' }, value: entry.count });
    histogramSamples.push({ suffix: '_sum', labels: { group: entry.group }, value: entry.sum });
    histogramSamples.push({ suffix: '_count', labels: { group: entry.group }, value: entry.count });
  }
  return [
    {
      name: 'landa_http_requests_in_flight',
      help: 'HTTP requests being handled by this process.',
      type: 'gauge',
      samples: [{ value: snapshot.inFlight }],
    },
    {
      name: 'landa_http_requests_total',
      help: 'HTTP requests handled since the process started, by route group and status class.',
      type: 'counter',
      samples: snapshot.counts.map((entry) => ({ labels: { group: entry.group, status_class: entry.statusClass }, value: entry.value })),
    },
    {
      name: 'landa_http_request_duration_seconds',
      help: 'HTTP request duration by route group (a stream counts until it ends).',
      type: 'histogram',
      samples: histogramSamples,
    },
  ];
}

// ── Access rules ──

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function isLoopbackAddress(address: string | undefined | null): boolean {
  return typeof address === 'string' && LOOPBACK_ADDRESSES.has(address);
}

/**
 * A gateway on the same host connects from loopback too. A request it
 * forwards carries one of these headers, so it is not treated as local.
 */
const FORWARDING_HEADERS = ['x-forwarded-for', 'forwarded', 'x-real-ip', 'cf-connecting-ip', 'true-client-ip'] as const;

export function hasForwardingHeaders(headers: Record<string, string | string[] | undefined>): boolean {
  return FORWARDING_HEADERS.some((name) => headers[name] !== undefined);
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Constant-time check of `Authorization: Bearer <token>`. */
export function bearerTokenMatches(authorization: string | undefined, token: string): boolean {
  if (!authorization) return false;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (!match) return false;
  return timingSafeEqual(digest(match[1].trim()), digest(token));
}

export type MetricsAccess = 'allowed' | 'not_found' | 'unauthorized';

export function decideMetricsAccess(input: {
  enabled: boolean;
  token: string;
  remoteAddress: string | undefined;
  headers: Record<string, string | string[] | undefined>;
}): MetricsAccess {
  if (!input.enabled) return 'not_found';
  if (!isLoopbackAddress(input.remoteAddress) || hasForwardingHeaders(input.headers)) return 'not_found';
  if (input.token) {
    const authorization = input.headers.authorization;
    if (typeof authorization !== 'string' || !bearerTokenMatches(authorization, input.token)) return 'unauthorized';
  }
  return 'allowed';
}
