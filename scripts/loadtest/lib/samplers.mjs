// Server-side signals sampled during a run. Everything here is read-only.
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { LOADTEST_TENANT } from './config.mjs';
import { Recorder, round } from './stats.mjs';
import { sleep } from './session.mjs';

const END = '__LT_END__';

export const ACTIVITY_SQL = `SELECT 'A', extract(epoch FROM clock_timestamp())::bigint,
  count(*), count(*) FILTER (WHERE state = 'active'), count(*) FILTER (WHERE state = 'idle'),
  count(*) FILTER (WHERE state LIKE 'idle in transaction%'),
  count(*) FILTER (WHERE wait_event_type = 'Lock'),
  count(*) FILTER (WHERE wait_event_type = 'Lock' AND wait_event = 'advisory'),
  count(*) FILTER (WHERE wait_event_type = 'Lock' AND wait_event IN ('transactionid', 'tuple')),
  count(*) FILTER (WHERE wait_event_type = 'LWLock'),
  round(coalesce(max(extract(epoch FROM clock_timestamp() - query_start)) FILTER (WHERE state = 'active'), 0)::numeric, 3),
  round(coalesce(max(extract(epoch FROM clock_timestamp() - state_change)) FILTER (WHERE wait_event_type = 'Lock'), 0)::numeric, 3)
FROM pg_stat_activity
WHERE datname = current_database() AND backend_type = 'client backend' AND pid <> pg_backend_pid();
SELECT 'W', wait_event, round(extract(epoch FROM clock_timestamp() - state_change)::numeric, 3),
  left(regexp_replace(regexp_replace(query, '''[^'']*''', '?', 'g'), '\\s+', ' ', 'g'), 140)
FROM pg_stat_activity
WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()
ORDER BY state_change LIMIT 3;`;

export const DB_STATS_SQL = `SELECT 'D', xact_commit, xact_rollback, deadlocks, blks_read, blks_hit, tup_inserted, tup_updated, tup_deleted,
  temp_files, temp_bytes, (SELECT setting FROM pg_settings WHERE name = 'max_connections'),
  coalesce((SELECT database_used_bytes FROM public.tenant_data_quota_usage WHERE tenant_id = '${LOADTEST_TENANT.id}'), -1)
FROM pg_stat_database WHERE datname = current_database();`;

const DB_FIELDS = ['xact_commit', 'xact_rollback', 'deadlocks', 'blks_read', 'blks_hit', 'tup_inserted', 'tup_updated',
  'tup_deleted', 'temp_files', 'temp_bytes', 'max_connections', 'loadtest_quota_bytes'];

/** Parses the tab-separated output of ACTIVITY_SQL into one sample. */
export function parseActivity(lines) {
  const sample = { waits: [] };
  for (const line of lines) {
    const cols = line.split('\t');
    if (cols[0] === 'A') {
      const n = cols.slice(1).map(Number);
      Object.assign(sample, {
        ts: n[0], connections: n[1], active: n[2], idle: n[3], idle_in_tx: n[4], lock_waits: n[5],
        advisory_waits: n[6], row_lock_waits: n[7], lwlock_waits: n[8], longest_active_s: n[9], longest_lock_wait_s: n[10],
      });
    } else if (cols[0] === 'W') {
      sample.waits.push({ wait_event: cols[1], waiting_s: Number(cols[2]), query: cols.slice(3).join('\t') });
    }
  }
  return sample.ts ? sample : null;
}

export function parseDbStats(lines) {
  const cols = (lines.find((l) => l.startsWith('D\t')) || '').split('\t');
  if (cols.length < DB_FIELDS.length + 1) return null;
  return Object.fromEntries(DB_FIELDS.map((f, i) => [f, Number(cols[i + 1])]));
}

/** One long-lived read-only psql session in the database container (docker exec, no port needed). */
export class PgSampler {
  constructor({ container, intervalS, quiet }) {
    Object.assign(this, { container, intervalS, quiet });
    this.samples = [];
    this.waitFingerprints = new Map();
    this.available = false;
    this.error = null;
    this.buffer = '';
    this.pending = [];
    this.lines = [];
  }

  start() {
    if (!this.container || this.container === 'none') { this.error = 'disabled (--pg-container none)'; return Promise.resolve(false); }
    return new Promise((resolve) => {
      try {
        this.child = spawn('docker', ['exec', '-i',
          '-e', 'PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=1500 -c lock_timeout=500',
          '-e', 'PGAPPNAME=landa-loadtest-sampler', '-e', 'PGCLIENTENCODING=UTF8',
          this.container, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-At', '-F', '\t'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      } catch (err) {
        this.error = `spawn failed: ${err.message}`;
        resolve(false);
        return;
      }
      this.child.on('error', (err) => { this.error = `docker: ${err.message}`; this.available = false; this.flushPending(); resolve(false); });
      this.child.on('exit', (code) => { if (this.available) this.error = `psql exited (${code})`; this.available = false; this.flushPending(); });
      this.child.stderr.on('data', (d) => { this.lastStderr = String(d).slice(0, 500); });
      this.child.stdout.on('data', (chunk) => this.onData(chunk));
      this.query(DB_STATS_SQL, 5000).then((lines) => {
        this.dbStart = lines ? parseDbStats(lines) : null;
        this.available = Boolean(this.dbStart);
        if (!this.available) this.error = this.error || `no answer from psql in ${this.container}: ${this.lastStderr || 'timeout'}`;
        resolve(this.available);
      });
    });
  }

  onData(chunk) {
    this.buffer += chunk.toString('utf8');
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, '');
      this.buffer = this.buffer.slice(idx + 1);
      if (line === END) {
        const waiter = this.pending.shift();
        const lines = this.lines;
        this.lines = [];
        if (waiter) { clearTimeout(waiter.timer); waiter.resolve(lines); }
      } else {
        this.lines.push(line);
      }
    }
  }

  flushPending() {
    for (const waiter of this.pending.splice(0)) { clearTimeout(waiter.timer); waiter.resolve(null); }
  }

  query(sql, timeoutMs = 4000) {
    if (!this.child || this.child.exitCode !== null) return Promise.resolve(null);
    return new Promise((resolve) => {
      const waiter = { resolve, timer: setTimeout(() => { const i = this.pending.indexOf(waiter); if (i >= 0) this.pending.splice(i, 1); resolve(null); }, timeoutMs) };
      this.pending.push(waiter);
      this.child.stdin.write(`${sql}\n\\echo ${END}\n`);
    });
  }

  async loop(signal, t0) {
    while (this.available && (await sleep(this.intervalS * 1000, signal))) {
      if (this.pending.length) continue; // previous sample still running: skip a tick
      const started = performance.now();
      const lines = await this.query(ACTIVITY_SQL);
      const sample = lines ? parseActivity(lines) : null;
      if (!sample) { this.missed = (this.missed || 0) + 1; continue; }
      sample.t_s = round((Date.now() - t0) / 1000, 1);
      sample.sample_ms = round(performance.now() - started, 1);
      for (const wait of sample.waits) {
        const key = `${wait.wait_event} | ${wait.query}`;
        this.waitFingerprints.set(key, (this.waitFingerprints.get(key) || 0) + 1);
      }
      this.samples.push(sample);
    }
  }

  async stop() {
    if (this.available) {
      const lines = await this.query(DB_STATS_SQL, 5000);
      this.dbEnd = lines ? parseDbStats(lines) : null;
    }
    if (this.child && this.child.exitCode === null) {
      this.child.stdin.end('\\q\n');
      const exited = new Promise((r) => this.child.once('exit', r));
      if (!(await Promise.race([exited.then(() => true), sleep(2000)]))) this.child.kill();
    }
  }

  result() {
    const s = this.samples;
    const max = (k) => (s.length ? Math.max(...s.map((x) => x[k] ?? 0)) : null);
    const avg = (k) => (s.length ? round(s.reduce((a, x) => a + (x[k] ?? 0), 0) / s.length, 2) : null);
    const delta = this.dbStart && this.dbEnd
      ? Object.fromEntries(DB_FIELDS.filter((f) => f !== 'max_connections' && f !== 'loadtest_quota_bytes').map((f) => [f, this.dbEnd[f] - this.dbStart[f]]))
      : null;
    return {
      available: this.available || s.length > 0,
      error: this.error,
      container: this.container,
      interval_s: this.intervalS,
      samples_taken: s.length,
      samples_missed: this.missed || 0,
      summary: s.length ? {
        max_connections_setting: this.dbStart?.max_connections ?? null,
        connections_max: max('connections'), connections_avg: avg('connections'),
        active_max: max('active'), active_avg: avg('active'),
        idle_in_tx_max: max('idle_in_tx'),
        lock_waits_max: max('lock_waits'), lock_waits_avg: avg('lock_waits'),
        advisory_waits_max: max('advisory_waits'), row_lock_waits_max: max('row_lock_waits'),
        lwlock_waits_max: max('lwlock_waits'),
        samples_with_lock_waits: s.filter((x) => x.lock_waits > 0).length,
        longest_lock_wait_s: max('longest_lock_wait_s'), longest_active_s: max('longest_active_s'),
      } : null,
      db_delta: delta,
      loadtest_quota_bytes: { start: this.dbStart?.loadtest_quota_bytes ?? null, end: this.dbEnd?.loadtest_quota_bytes ?? null },
      top_lock_waits: [...this.waitFingerprints.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, n]) => ({ seen: n, wait: k })),
      samples: s,
    };
  }
}

/** Probes the API's metrics endpoint once; samples it only if it exists. Optional header from LOADTEST_METRICS_HEADER. */
export class MetricsSampler {
  constructor({ transport, path, intervalS }) {
    Object.assign(this, { transport, path, intervalS });
    this.snapshots = [];
    const header = process.env.LOADTEST_METRICS_HEADER;
    this.headers = { Accept: 'application/json, text/plain, */*' };
    if (header && header.includes(':')) {
      const [name, ...rest] = header.split(':');
      this.headers[name.trim()] = rest.join(':').trim();
    }
  }

  async fetchOnce(t0) {
    this.requests = (this.requests || 0) + 1;
    const started = performance.now();
    const res = await this.transport.request({ method: 'GET', path: this.path, headers: this.headers, timeout: 5000 });
    const text = res.body?.toString('utf8') ?? '';
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    return { t_s: round((Date.now() - t0) / 1000, 1), status: res.status, ms: round(performance.now() - started, 1), body: parsed ?? text.slice(0, 32_768) };
  }

  async start(t0) {
    if (!this.path || this.path === 'none') { this.status = 'disabled'; return false; }
    const first = await this.fetchOnce(t0);
    this.probeStatus = first.status;
    if (first.status !== 200) { this.status = 'absent'; return false; }
    this.status = 'present';
    this.snapshots.push(first);
    return true;
  }

  async loop(signal, t0) {
    if (this.status !== 'present') return;
    while (await sleep(this.intervalS * 1000, signal)) {
      const snap = await this.fetchOnce(t0);
      this.snapshots.push(snap);
      if (this.snapshots.length > 400) this.snapshots.splice(1, 1); // keep the first and the latest
    }
  }

  result() {
    return {
      path: this.path,
      status: this.status,
      probe_status: this.probeStatus ?? null,
      requests: this.requests || 0,
      note: this.status === 'absent' ? 'endpoint not present on this API build (404/401/403/no answer); nothing sampled' : undefined,
      snapshots: this.snapshots,
    };
  }
}

/** GET /api/health every few seconds: API liveness and baseline latency, kept out of the endpoint totals. */
export async function healthLoop({ transport, intervalS, signal, recorder }) {
  if (!intervalS) return;
  while (await sleep(intervalS * 1000, signal)) {
    const started = performance.now();
    const res = await transport.request({ method: 'GET', path: '/api/health', headers: { Accept: 'application/json' }, timeout: 5000 });
    recorder.record('probe GET /api/health', res.status, performance.now() - started, res.errorCode);
  }
}

export function newProbeRecorder() {
  return new Recorder();
}
