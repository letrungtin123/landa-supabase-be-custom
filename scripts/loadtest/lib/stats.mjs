// Latency/throughput/error recorder: one HDR histogram per endpoint (perf_hooks), 10-second windows for the timeline.
import { createHistogram, monitorEventLoopDelay } from 'node:perf_hooks';

const WINDOW_MS = 10_000;
const newHistogram = () => createHistogram({ lowest: 1, highest: 600_000_000, figures: 3 }); // microseconds, up to 10 min

export function statusClass(status) {
  if (status === 0) return 'net';
  if (status === 429) return '429';
  if (status >= 500) return '5xx';
  if (status >= 400) return '4xx';
  if (status >= 300) return '3xx';
  return '2xx';
}

function summarizeHistogram(histogram) {
  if (histogram.count === 0) return { p50: null, p90: null, p95: null, p99: null, max: null, mean: null };
  const ms = (us) => Math.round(us / 10) / 100;
  return {
    p50: ms(histogram.percentile(50)),
    p90: ms(histogram.percentile(90)),
    p95: ms(histogram.percentile(95)),
    p99: ms(histogram.percentile(99)),
    max: ms(histogram.max),
    mean: ms(histogram.mean),
  };
}

export class Recorder {
  constructor() {
    this.startedAt = Date.now();
    this.endpoints = new Map();
    this.windows = new Map();
    this.flow = Object.create(null);
    this.activeVus = 0;
    this.peakVus = 0;
    this.loop = monitorEventLoopDelay({ resolution: 20 });
    this.loop.enable();
  }

  count(key, by = 1) {
    this.flow[key] = (this.flow[key] || 0) + by;
  }

  vuStarted() { this.activeVus += 1; this.peakVus = Math.max(this.peakVus, this.activeVus); }

  vuEnded() { this.activeVus -= 1; }

  /** status 0 = network error or timeout (errorCode says which). */
  record(name, status, durationMs, errorCode) {
    let endpoint = this.endpoints.get(name);
    if (!endpoint) {
      endpoint = { histogram: newHistogram(), count: 0, statuses: Object.create(null), classes: Object.create(null), netErrors: Object.create(null) };
      this.endpoints.set(name, endpoint);
    }
    const us = Math.max(1, Math.round(durationMs * 1000));
    endpoint.count += 1;
    endpoint.histogram.record(us);
    endpoint.statuses[status] = (endpoint.statuses[status] || 0) + 1;
    const cls = statusClass(status);
    endpoint.classes[cls] = (endpoint.classes[cls] || 0) + 1;
    if (status === 0) endpoint.netErrors[errorCode || 'error'] = (endpoint.netErrors[errorCode || 'error'] || 0) + 1;

    const windowStart = Math.floor((Date.now() - this.startedAt) / WINDOW_MS) * WINDOW_MS;
    let window = this.windows.get(windowStart);
    if (!window) {
      window = { histogram: newHistogram(), count: 0, classes: Object.create(null), maxVus: 0 };
      this.windows.set(windowStart, window);
    }
    window.count += 1;
    window.histogram.record(us);
    window.classes[cls] = (window.classes[cls] || 0) + 1;
    window.maxVus = Math.max(window.maxVus, this.activeVus);
  }

  /** Cheap running totals for progress lines (does not stop anything). */
  live() {
    let requests = 0;
    const classes = Object.create(null);
    for (const endpoint of this.endpoints.values()) {
      requests += endpoint.count;
      for (const [cls, n] of Object.entries(endpoint.classes)) classes[cls] = (classes[cls] || 0) + n;
    }
    const keys = [...this.windows.keys()];
    const last = keys.length ? this.windows.get(Math.max(...keys)) : null;
    const errors = requests - (classes['2xx'] || 0) - (classes['3xx'] || 0);
    return {
      requests,
      classes: { ...classes },
      error_rate: requests ? errors / requests : 0,
      window_p95_ms: last && last.count ? round(last.histogram.percentile(95) / 1000, 1) : null,
      window_rps: last ? round(last.count / (WINDOW_MS / 1000), 1) : 0,
    };
  }

  summary() {
    const endedAt = Date.now();
    const seconds = Math.max(0.001, (endedAt - this.startedAt) / 1000);
    const endpoints = {};
    let total = 0;
    const totalClasses = Object.create(null);
    const all = newHistogram();
    for (const [name, endpoint] of [...this.endpoints.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      total += endpoint.count;
      for (const [cls, n] of Object.entries(endpoint.classes)) totalClasses[cls] = (totalClasses[cls] || 0) + n;
      all.add(endpoint.histogram);
      const errors = endpoint.count - (endpoint.classes['2xx'] || 0) - (endpoint.classes['3xx'] || 0);
      endpoints[name] = {
        count: endpoint.count,
        rps: round(endpoint.count / seconds, 3),
        ...summarizeHistogram(endpoint.histogram),
        error_rate: round(errors / endpoint.count, 4),
        rate_429: round((endpoint.classes['429'] || 0) / endpoint.count, 4),
        rate_5xx: round((endpoint.classes['5xx'] || 0) / endpoint.count, 4),
        rate_net: round((endpoint.classes.net || 0) / endpoint.count, 4),
        statuses: { ...endpoint.statuses },
        net_errors: { ...endpoint.netErrors },
      };
    }
    const timeline = [...this.windows.entries()].sort(([a], [b]) => a - b).map(([start, w]) => ({
      t_s: start / 1000,
      requests: w.count,
      rps: round(w.count / (WINDOW_MS / 1000), 2),
      ...pick(summarizeHistogram(w.histogram), ['p50', 'p95', 'p99']),
      ok: (w.classes['2xx'] || 0) + (w.classes['3xx'] || 0),
      e4xx: w.classes['4xx'] || 0,
      e429: w.classes['429'] || 0,
      e5xx: w.classes['5xx'] || 0,
      net: w.classes.net || 0,
      vus: w.maxVus,
    }));
    this.loop.disable();
    const ns = (v) => round(v / 1e6, 2);
    return {
      started_at: new Date(this.startedAt).toISOString(),
      ended_at: new Date(endedAt).toISOString(),
      duration_s: round(seconds, 1),
      totals: {
        requests: total,
        rps: round(total / seconds, 2),
        ...summarizeHistogram(all),
        error_rate: total ? round((total - (totalClasses['2xx'] || 0) - (totalClasses['3xx'] || 0)) / total, 4) : 0,
        by_class: { ...totalClasses },
        peak_vus: this.peakVus,
      },
      endpoints,
      timeline,
      flow: { ...this.flow },
      load_generator: {
        event_loop_delay_ms: { p50: ns(this.loop.percentile(50)), p99: ns(this.loop.percentile(99)), max: ns(this.loop.max) },
        note: 'event-loop p99 above ~100 ms means the generator itself was saturated; split the run or lower --learners',
      },
    };
  }
}

export function round(value, digits) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function pick(object, keys) {
  return Object.fromEntries(keys.map((k) => [k, object[k]]));
}
