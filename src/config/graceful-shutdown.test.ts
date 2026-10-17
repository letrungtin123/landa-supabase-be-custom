import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import { createGracefulShutdown } from './graceful-shutdown.js';
import { createProcessLifecycle } from './process-lifecycle.js';

// H11: a restart drains in-flight requests instead of dropping them.
// Real HTTP server on 127.0.0.1, injected exit; no database or broker.

async function listen(app: express.Express): Promise<{ server: http.Server; url: string }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

function get(url: string, agent: http.Agent): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(url, { agent }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      res.on('error', reject);
    }).on('error', reject);
  });
}

test('in-flight requests finish, intake stops, resources close in order, then exit 0', async () => {
  const lifecycle = createProcessLifecycle();
  const app = express();
  app.get('/slow', (_req, res) => { setTimeout(() => res.send('done'), 300); });
  app.get('/fast', (_req, res) => { res.send('ok'); });
  const { server, url } = await listen(app);
  const agent = new http.Agent({ keepAlive: true });

  let pollerRuns = 0;
  lifecycle.stopOnShutdown(setInterval(() => { pollerRuns += 1; }, 20));
  let streamEnded = false;
  lifecycle.onShutdownStart(() => { streamEnded = true; });

  const order: string[] = [];
  const exits: number[] = [];
  const shutdown = createGracefulShutdown({
    getServer: () => server,
    lifecycle,
    stopIntake: [{ name: 'worker', run: async () => { order.push('worker stopped'); } }],
    closeResources: [
      { name: 'rabbit', run: () => { order.push('rabbit'); } },
      { name: 'redis', run: () => { order.push('redis'); } },
      { name: 'pool', run: async () => { order.push('pool'); } },
    ],
    exit: (code) => exits.push(code),
    log: () => {},
    drainTimeoutMs: 5_000,
    forceExitMs: 8_000,
  });

  // A kept-alive connection already used once, then a slow request in flight.
  assert.equal((await get(`${url}/fast`, agent)).status, 200);
  const inFlight = get(`${url}/slow`, agent);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const startedAt = performance.now();
  const done = shutdown('SIGTERM');

  assert.deepEqual(await inFlight, { status: 200, body: 'done' }, 'the in-flight request is answered');
  assert.equal(streamEnded, true);
  const runsAtShutdown = pollerRuns;
  await done;
  assert.ok(performance.now() - startedAt < 3_000, 'the drain ended when the last request finished');
  assert.deepEqual(order, ['worker stopped', 'rabbit', 'redis', 'pool']);
  assert.deepEqual(exits, [0]);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(pollerRuns, runsAtShutdown, 'pollers stopped when shutdown began');
  await assert.rejects(get(`${url}/fast`, new http.Agent()), 'no new connection is accepted');
  agent.destroy();
});

test('a request that outlives the drain is cut, tracked work settles, and shutdown still completes', async () => {
  const lifecycle = createProcessLifecycle();
  const app = express();
  let metered = false;
  app.get('/stream', (req, res) => {
    res.write('partial');
    // Like an AI answer: when the connection is cut, the usage is still settled.
    lifecycle.trackShutdownWork(new Promise<void>((resolve) => {
      res.on('close', () => setTimeout(() => { metered = true; resolve(); }, 50));
    }));
  });
  const { server, url } = await listen(app);
  const exits: number[] = [];
  let poolClosedAfterMetering = false;
  const shutdown = createGracefulShutdown({
    getServer: () => server,
    lifecycle,
    stopIntake: [],
    closeResources: [{ name: 'pool', run: () => { poolClosedAfterMetering = metered; } }],
    exit: (code) => exits.push(code),
    log: () => {},
    drainTimeoutMs: 200,
    workGraceMs: 1_000,
    forceExitMs: 5_000,
  });
  const response = new Promise<string>((resolve) => {
    http.get(`${url}/stream`, (res) => {
      res.on('data', () => {});
      res.on('error', () => resolve('cut'));
      res.on('close', () => resolve('cut'));
    }).on('error', () => resolve('cut'));
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  await shutdown('PM2 shutdown message');
  assert.equal(await response, 'cut');
  assert.equal(poolClosedAfterMetering, true, 'the pool closes only after the cut request settled');
  assert.deepEqual(exits, [0]);
});

test('a second signal exits at once with code 1', async () => {
  const exits: number[] = [];
  const shutdown = createGracefulShutdown({
    getServer: () => null,
    lifecycle: createProcessLifecycle(),
    stopIntake: [{ name: 'stuck worker', run: () => new Promise(() => {}) }],
    closeResources: [],
    exit: (code) => exits.push(code),
    log: () => {},
  });
  void shutdown('SIGTERM');
  await shutdown('SIGINT');
  assert.deepEqual(exits, [1]);
});

test('the hard deadline exits with code 1 when a resource never closes', async () => {
  const exits: number[] = [];
  const shutdown = createGracefulShutdown({
    getServer: () => null,
    lifecycle: createProcessLifecycle(),
    stopIntake: [],
    closeResources: [{ name: 'stuck pool', run: () => new Promise(() => {}) }],
    exit: (code) => exits.push(code),
    log: () => {},
    forceExitMs: 150,
  });
  void shutdown('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(exits, [1]);
});

test('lifecycle: registrations after shutdown began are handled at once', async () => {
  const lifecycle = createProcessLifecycle();
  lifecycle.begin();
  assert.equal(lifecycle.isShuttingDown(), true);
  let runs = 0;
  lifecycle.stopOnShutdown(setInterval(() => { runs += 1; }, 10));
  let notified = false;
  lifecycle.onShutdownStart(() => { notified = true; });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(runs, 0);
  assert.equal(notified, true);
  assert.equal(await lifecycle.settleWork(10), true);
});
