import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';

// M9: GET /internal/metrics serves Prometheus text (event-loop delay, pool,
// in-flight and per-route-group requests with a latency histogram, AI chat
// admission, Redis breaker) to callers on this host only, optionally with a
// bearer token; the per-request cost is a clock read and a few additions.

const logic = await import('./metrics.logic.js');
const { createMetricsRouter, createRequestMetricsMiddleware, METRICS_PATH } = await import('./metrics.routes.js');
const service = await import('./metrics.service.js');

test('route groups are coarse prefixes', () => {
  const cases: Array<[string, string]> = [
    ['/api/auth/login', 'auth'], ['/api/sso/exchange/google', 'auth'], ['/api/learner/courses/1/blocks', 'learner'],
    ['/api/enrollments/study-session', 'learner'], ['/api/enrollments', 'other'], ['/api/reports/summary', 'reports'],
    ['/api/ai-chatbot/chat/send', 'ai'], ['/api/ai-credits/usage', 'ai'], ['/api/storage/t/a.png', 'storage'],
    ['/api/authx', 'other'], ['/api/health', 'other'], ['/', 'other'],
  ];
  for (const [path, group] of cases) assert.equal(logic.routeGroupOf(path), group, path);
});

test('requests are counted per group and status class with a cumulative latency histogram', () => {
  let clock = 0n;
  const metrics = logic.createRequestMetrics(() => clock);
  const endFast = metrics.start('/api/learner/a');
  const endSlow = metrics.start('/api/reports/b');
  const endGone = metrics.start('/api/storage/c.mp4');
  assert.equal(metrics.inFlight(), 3);
  clock = 3_000_000n; // 3 ms
  endFast(200, true);
  endFast(200, true); // a second call is ignored
  clock = 1_200_000_000n; // 1.2 s
  endSlow(500, true);
  endGone(200, false);
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.inFlight, 0);
  assert.deepEqual(snapshot.counts.sort((a, b) => a.group.localeCompare(b.group)), [
    { group: 'learner', statusClass: '2xx', value: 1 },
    { group: 'reports', statusClass: '5xx', value: 1 },
    { group: 'storage', statusClass: 'aborted', value: 1 },
  ]);
  const learner = snapshot.latency.find((entry) => entry.group === 'learner')!;
  assert.equal(learner.count, 1);
  assert.equal(learner.cumulativeBuckets[0], 1, '3 ms is in the 5 ms bucket');
  const reports = snapshot.latency.find((entry) => entry.group === 'reports')!;
  const le1 = logic.LATENCY_BUCKETS_SECONDS.indexOf(1);
  assert.equal(reports.cumulativeBuckets[le1], 0);
  assert.equal(reports.cumulativeBuckets[le1 + 1], 1, '1.2 s is in the 2.5 s bucket');
});

test('the Prometheus text has HELP, TYPE and escaped labels', () => {
  const text = logic.formatPrometheus([
    { name: 'x_total', help: 'X.', type: 'counter', samples: [{ labels: { a: 'q"u\\o\nte' }, value: 2 }] },
    { name: 'y', help: 'Y.', type: 'gauge', samples: [{ value: 0.5 }] },
  ]);
  assert.equal(text, '# HELP x_total X.\n# TYPE x_total counter\nx_total{a="q\\"u\\\\o\\nte"} 2\n# HELP y Y.\n# TYPE y gauge\ny 0.5\n');
});

test('constant labels come first on every sample; the instance is the PM2 instance number, else the pid', () => {
  const text = logic.formatPrometheus([
    { name: 'x_total', help: 'X.', type: 'counter', samples: [{ labels: { a: 'b' }, value: 2 }] },
    { name: 'h', help: 'H.', type: 'histogram', samples: [{ suffix: '_bucket', labels: { le: '+Inf' }, value: 1 }, { suffix: '_sum', value: 0.5 }] },
    { name: 'y', help: 'Y.', type: 'gauge', samples: [{ value: 0.5 }] },
  ], { instance: '1' });
  assert.equal(text, '# HELP x_total X.\n# TYPE x_total counter\nx_total{instance="1",a="b"} 2\n'
    + '# HELP h H.\n# TYPE h histogram\nh_bucket{instance="1",le="+Inf"} 1\nh_sum{instance="1"} 0.5\n'
    + '# HELP y Y.\n# TYPE y gauge\ny{instance="1"} 0.5\n');
  assert.equal(logic.metricsInstanceLabel('3', 4242), '3');
  assert.equal(logic.metricsInstanceLabel('0', 4242), '0', 'PM2 instance 0 is a real instance number');
  assert.equal(logic.metricsInstanceLabel('', 4242), '4242');
  assert.equal(logic.metricsInstanceLabel(undefined, 4242), '4242');
});

test('access: loopback only, no proxied request, bearer token when configured', () => {
  const decide = (remoteAddress: string, headers: Record<string, string> = {}, token = '', enabled = true) =>
    logic.decideMetricsAccess({ enabled, token, remoteAddress, headers });
  assert.equal(decide('127.0.0.1'), 'allowed');
  assert.equal(decide('::1'), 'allowed');
  assert.equal(decide('::ffff:127.0.0.1'), 'allowed');
  assert.equal(decide('10.0.0.5'), 'not_found');
  assert.equal(decide('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' }), 'not_found', 'a local gateway forwarded it');
  assert.equal(decide('127.0.0.1', { 'cf-connecting-ip': '203.0.113.9' }), 'not_found');
  assert.equal(decide('127.0.0.1', {}, 's3cret'), 'unauthorized');
  assert.equal(decide('127.0.0.1', { authorization: 'Bearer wrong' }, 's3cret'), 'unauthorized');
  assert.equal(decide('127.0.0.1', { authorization: 'Bearer s3cret' }, 's3cret'), 'allowed');
  assert.equal(decide('127.0.0.1', {}, '', false), 'not_found');
});

async function serve(options: { token?: string; enabled?: boolean } = {}) {
  const app = express();
  app.use(createRequestMetricsMiddleware(service.requestMetrics));
  app.use(createMetricsRouter({ enabled: options.enabled ?? true, token: options.token ?? '', collect: service.collectMetricsText }));
  app.get('/api/learner/ping', (_req, res) => { res.json({ ok: true }); });
  app.use((_req, res) => { res.status(404).json({ success: false, message: 'Endpoint không tồn tại' }); });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function get(port: number, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; type: string; body: string }>((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), body }));
    }).on('error', reject);
  });
}

test('GET /internal/metrics answers a local scrape with every metric family', async () => {
  service.startEventLoopDelayMonitor();
  service.registerAiChatAdmissionGauge(() => 3);
  service.recordAiChatAdmissionRefused();
  const server = await serve();
  try {
    assert.equal((await get(server.port, '/api/learner/ping')).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const scrape = await get(server.port, METRICS_PATH);
    assert.equal(scrape.status, 200);
    assert.match(scrape.type, /^text\/plain; version=0\.0\.4/);
    for (const name of [
      'landa_event_loop_delay_p50_seconds', 'landa_event_loop_delay_p99_seconds', 'landa_event_loop_delay_max_seconds',
      'landa_db_pool_connections', 'landa_db_pool_idle_connections', 'landa_db_pool_waiting_clients',
      'landa_http_requests_in_flight', 'landa_http_requests_total', 'landa_http_request_duration_seconds',
      'landa_ai_chat_answers_active', 'landa_ai_chat_admission_refused_total',
      'landa_redis_configured', 'landa_redis_ready', 'landa_redis_breaker_open',
    ]) assert.match(scrape.body, new RegExp(`^# TYPE ${name} `, 'm'), name);
    const instance = `instance="${service.METRICS_INSTANCE}"`;
    assert.equal(service.METRICS_INSTANCE, logic.metricsInstanceLabel(process.env.NODE_APP_INSTANCE, process.pid));
    assert.match(scrape.body, new RegExp(`^landa_http_requests_total\\{${instance},group="learner",status_class="2xx"\\} 1$`, 'm'));
    assert.match(scrape.body, new RegExp(`^landa_http_request_duration_seconds_count\\{${instance},group="learner"\\} 1$`, 'm'));
    assert.match(scrape.body, new RegExp(`^landa_http_request_duration_seconds_bucket\\{${instance},group="learner",le="\\+Inf"\\} 1$`, 'm'));
    assert.match(scrape.body, new RegExp(`^landa_ai_chat_answers_active\\{${instance}\\} 3$`, 'm'));
    assert.match(scrape.body, new RegExp(`^landa_ai_chat_admission_refused_total\\{${instance}\\} 1$`, 'm'));
    assert.doesNotMatch(scrape.body, /group="other"[^\n]*status_class/, 'the scrape itself is not counted');
    assert.match(scrape.body, new RegExp(`^landa_redis_breaker_open\\{${instance}\\} 0$`, 'm'));
    const samples = scrape.body.split('\n').filter((line) => line !== '' && !line.startsWith('#'));
    assert.ok(samples.length > 20);
    for (const line of samples) assert.ok(line.includes(`{${instance}`), `every sample has the instance label: ${line}`);

    const proxied = await get(server.port, METRICS_PATH, { 'X-Forwarded-For': '203.0.113.9' });
    assert.equal(proxied.status, 404, 'a request forwarded by a gateway gets the ordinary 404');
  } finally {
    await server.close();
  }
});

test('with METRICS_TOKEN the scrape needs the bearer token; disabled answers 404', async () => {
  const server = await serve({ token: 'scrape-token' });
  const off = await serve({ enabled: false });
  try {
    const refused = await get(server.port, METRICS_PATH);
    assert.equal(refused.status, 401);
    assert.equal(refused.body.includes('landa_'), false);
    assert.equal((await get(server.port, METRICS_PATH, { Authorization: 'Bearer scrape-token' })).status, 200);
    assert.equal((await get(off.port, METRICS_PATH)).status, 404);
  } finally {
    await server.close();
    await off.close();
  }
});

test('counting a request is cheap: one clock read and a few additions', () => {
  const metrics = logic.createRequestMetrics();
  const rounds = 200_000;
  const startedAt = process.hrtime.bigint();
  for (let i = 0; i < rounds; i += 1) metrics.start(i % 2 ? '/api/learner/x' : '/api/reports/y')(200, true);
  const perRequestNs = Number(process.hrtime.bigint() - startedAt) / rounds;
  assert.ok(perRequestNs < 10_000, `${perRequestNs.toFixed(0)} ns per request`);
});
