import assert from 'node:assert/strict';
import test from 'node:test';
import type { LogFields, JsonLogger } from '../../utils/json-logger.js';
import { eventLoopLagMs, heartbeatFields, HEARTBEAT_INTERVAL_MS, processMetricFamilies } from './heartbeat.logic.js';
import { formatPrometheus } from './metrics.logic.js';

// BE-S14: the process heartbeat (role, pid, uptime, rss, heap, event-loop
// delay) logged every 60 s by the background process and the workers, and
// the same gauges on GET /internal/metrics of an API process.

const { startProcessHeartbeat, stopProcessHeartbeat, sampleProcess } = await import('./heartbeat.service.js');
const { collectMetricsText } = await import('./metrics.service.js');

function recordingLogger(records: Array<{ event: string; fields: LogFields }>): JsonLogger {
  const logger: JsonLogger = {
    info: (event, fields = {}) => { records.push({ event, fields }); },
    warn: (event, fields = {}) => { records.push({ event, fields }); },
    error: (event, fields = {}) => { records.push({ event, fields }); },
    child: () => logger,
  };
  return logger;
}

test('the interval is 60 s', () => {
  assert.equal(HEARTBEAT_INTERVAL_MS, 60_000);
});

test('event-loop delay: nanoseconds to ms with one decimal; 0 while empty or unset', () => {
  assert.deepEqual(eventLoopLagMs(null), { p50: 0, p99: 0, max: 0 });
  assert.deepEqual(eventLoopLagMs({ count: 0, max: 9e18, percentile: () => 9e18 }), { p50: 0, p99: 0, max: 0 });
  const histogram = { count: 10, max: 250_000_000, percentile: (p: number) => (p === 50 ? 20_123_456 : 101_960_000) };
  assert.deepEqual(eventLoopLagMs(histogram), { p50: 20.1, p99: 102, max: 250 });
});

test('a heartbeat record carries role, pid, instance, uptime, memory and the delay', () => {
  const fields = heartbeatFields({
    role: 'background', pid: 42, instance: '0', uptimeSeconds: 61.6,
    memory: { rss: 100, heapUsed: 40, heapTotal: 60, external: 5 },
    lagMs: { p50: 1, p99: 2.5, max: 9 },
  });
  assert.deepEqual(fields, {
    role: 'background', pid: 42, instance: '0', uptime_seconds: 62,
    rss_bytes: 100, heap_used_bytes: 40, heap_total_bytes: 60, external_bytes: 5,
    event_loop_lag_p50_ms: 1, event_loop_lag_p99_ms: 2.5, event_loop_lag_max_ms: 9,
  });
});

test('process gauges in the Prometheus text', () => {
  const text = formatPrometheus(processMetricFamilies({
    role: 'api', pid: 7, uptimeSeconds: 3.4, memory: { rss: 1000, heapUsed: 400, heapTotal: 600, external: 1 },
  }), { instance: '1' });
  for (const line of [
    'landa_process_info{instance="1",role="api",pid="7"} 1',
    'landa_process_uptime_seconds{instance="1"} 3',
    'landa_process_resident_memory_bytes{instance="1"} 1000',
    'landa_process_heap_used_bytes{instance="1"} 400',
    'landa_process_heap_total_bytes{instance="1"} 600',
  ]) assert.ok(text.split('\n').includes(line), line);
});

test('GET /internal/metrics text includes the heartbeat gauges of this process', () => {
  const text = collectMetricsText();
  assert.match(text, /^landa_process_info\{instance="[^"]+",role="(all|api|background)",pid="\d+"\} 1$/m);
  assert.match(text, /^landa_process_uptime_seconds\{instance="[^"]+"\} \d+$/m);
  assert.match(text, /^landa_process_resident_memory_bytes\{instance="[^"]+"\} \d+$/m);
  assert.match(text, /^landa_process_heap_used_bytes\{instance="[^"]+"\} \d+$/m);
});

test('the heartbeat logs once at start, then every interval; unref\'d; started once; stops', async () => {
  const records: Array<{ event: string; fields: LogFields }> = [];
  const timer = startProcessHeartbeat({ role: 'email-outbox-worker', intervalMs: 25, logger: recordingLogger(records) });
  try {
    assert.equal(timer.hasRef(), false, 'never keeps the process alive');
    assert.equal(startProcessHeartbeat({ role: 'other', intervalMs: 25 }), timer, 'a second start returns the running timer');
    assert.deepEqual(records[0], { event: 'heartbeat_started', fields: { role: 'email-outbox-worker', pid: process.pid, interval_ms: 25 } });
    // The timer is unref'd: keep the process up while waiting for two beats.
    const keepAlive = setInterval(() => {}, 10);
    try {
      for (let attempt = 0; attempt < 200 && records.length < 3; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      clearInterval(keepAlive);
    }
    const beats = records.filter((record) => record.event === 'process_heartbeat');
    assert.ok(beats.length >= 2, `beats: ${beats.length}`);
    const beat = beats[0].fields;
    assert.equal(beat.role, 'email-outbox-worker');
    assert.equal(beat.pid, process.pid);
    for (const key of ['uptime_seconds', 'rss_bytes', 'heap_used_bytes', 'heap_total_bytes', 'event_loop_lag_p50_ms', 'event_loop_lag_p99_ms', 'event_loop_lag_max_ms']) {
      assert.equal(typeof beat[key], 'number', key);
      assert.ok((beat[key] as number) >= 0, key);
    }
    assert.ok((beat.rss_bytes as number) > 0);
  } finally {
    stopProcessHeartbeat();
  }
  const count = records.length;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(records.length, count, 'no beat after stop');
});

test('a sample reads this process', () => {
  const sample = sampleProcess('background', null);
  assert.equal(sample.pid, process.pid);
  assert.equal(sample.role, 'background');
  assert.ok(sample.memory.rss > 0 && sample.memory.heapUsed > 0);
  assert.deepEqual(sample.lagMs, { p50: 0, p99: 0, max: 0 });
});
