import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { createGracefulShutdown, type ShutdownStep } from './graceful-shutdown.js';
import { createProcessLifecycle } from './process-lifecycle.js';
import { planProcessRole } from './process-role.js';
import { shutdownStepsFor, startProcess, type ProcessStarters } from './process-startup.js';

// Which starters run per role, in which order, and the shutdown per role.
// Stand-in steps only: no database, Redis or RabbitMQ.

function recordingStarters(calls: string[], overrides: Partial<ProcessStarters> = {}): ProcessStarters {
  return {
    inMemorySweepers: () => { calls.push('sweepers'); },
    inlineEmailOutbox: ({ run }) => { calls.push(run ? 'inline-email:run' : 'inline-email:log'); },
    rabbitmq: async ({ consumers }) => { calls.push(consumers ? 'rabbitmq+consumers' : 'rabbitmq'); },
    redis: async () => { calls.push('redis'); },
    clusterBus: async () => { calls.push('cluster-bus'); },
    authRevocation: async () => { calls.push('auth-revocation'); },
    lessonAuthor: async ({ loop }) => { calls.push(loop ? 'lesson-author:loop' : 'lesson-author:accept'); },
    backgroundTimers: () => { calls.push('background-timers'); },
    tempDirectories: async () => { calls.push('temp-dirs'); },
    listen: async () => { calls.push('listen'); },
    ready: () => { calls.push('ready'); },
    storageBucket: async () => { calls.push('storage-bucket'); },
    startupCleanups: async () => { calls.push('startup-cleanups'); },
    ...overrides,
  };
}

test('all (the default): one process starts everything, in the previous order', async () => {
  const calls: string[] = [];
  await startProcess(planProcessRole('all', 1), recordingStarters(calls));
  assert.deepEqual(calls, [
    'sweepers', 'inline-email:run', 'rabbitmq+consumers', 'redis', 'auth-revocation', 'lesson-author:loop', 'background-timers',
    'temp-dirs', 'listen', 'ready', 'storage-bucket', 'startup-cleanups',
  ]);
});

test('api: HTTP and publishing only; no consumer, poller, background sweeper or startup cleanup', async () => {
  const calls: string[] = [];
  await startProcess(planProcessRole('api', 4), recordingStarters(calls));
  assert.deepEqual(calls, [
    'sweepers', 'inline-email:log', 'rabbitmq', 'redis', 'cluster-bus', 'auth-revocation', 'lesson-author:accept',
    'temp-dirs', 'listen', 'ready', 'storage-bucket',
  ]);
});

test('background: consumers, loops, timers and the one-off cleanups; never listens', async () => {
  const calls: string[] = [];
  await startProcess(planProcessRole('background', 4), recordingStarters(calls));
  assert.deepEqual(calls, [
    'sweepers', 'inline-email:run', 'rabbitmq+consumers', 'redis', 'cluster-bus', 'lesson-author:loop', 'background-timers',
    'temp-dirs', 'ready', 'startup-cleanups',
  ]);
});

test('api: PM2 hears "ready" only after the server listens', async () => {
  const calls: string[] = [];
  let listening = false;
  await startProcess(planProcessRole('api', 2), recordingStarters(calls, {
    listen: async () => { await new Promise((resolve) => setTimeout(resolve, 20)); listening = true; },
    ready: () => { assert.equal(listening, true, 'ready before listen'); calls.push('ready'); },
  }));
  assert.ok(calls.includes('ready'));
});

test('a failed first RabbitMQ connection stops the startup in every role (the step exits the process)', async () => {
  for (const role of ['all', 'api', 'background'] as const) {
    const calls: string[] = [];
    await assert.rejects(startProcess(planProcessRole(role, role === 'all' ? 1 : 2), recordingStarters(calls, {
      rabbitmq: async () => { throw new Error('ECONNREFUSED'); },
    })), /ECONNREFUSED/);
    // The sweepers and the inline email outbox start first (they used to start on import).
    assert.deepEqual(calls, ['sweepers', role === 'api' ? 'inline-email:log' : 'inline-email:run'], `${role}: nothing else started`);
  }
});

function step(order: string[], name: string): ShutdownStep {
  return { name, run: async () => { order.push(name); } };
}

function resources(order: string[]) {
  return {
    workers: [step(order, 'workers')],
    consumers: step(order, 'consumers'),
    listenConnections: step(order, 'listen-connections'),
    pdfRenderer: step(order, 'pdf-renderer'),
    rabbitmq: step(order, 'rabbitmq'),
    redis: step(order, 'redis'),
    reportsPool: step(order, 'reports-pool'),
    pool: step(order, 'pool'),
  };
}

test('shutdown steps per role', () => {
  const names = (steps: ShutdownStep[]) => steps.map((entry) => entry.name);
  const all = shutdownStepsFor(planProcessRole('all', 1), resources([]));
  assert.deepEqual(names(all.stopIntake), ['workers', 'consumers']);
  assert.deepEqual(names(all.closeResources), ['listen-connections', 'pdf-renderer', 'rabbitmq', 'redis', 'reports-pool', 'pool']);
  const api = shutdownStepsFor(planProcessRole('api', 4), resources([]));
  assert.deepEqual(names(api.stopIntake), ['workers'], 'an API process has no consumers');
  assert.deepEqual(names(api.closeResources), ['listen-connections', 'pdf-renderer', 'rabbitmq', 'redis', 'reports-pool', 'pool']);
  const background = shutdownStepsFor(planProcessRole('background', 4), resources([]));
  assert.deepEqual(names(background.stopIntake), ['workers', 'consumers']);
  assert.deepEqual(names(background.closeResources), ['listen-connections', 'rabbitmq', 'redis', 'reports-pool', 'pool']);
});

test('api shutdown (PM2 "shutdown" message): the request in flight finishes, then resources close, exit 0', async () => {
  const lifecycle = createProcessLifecycle();
  const server = http.createServer((_req, res) => { setTimeout(() => res.end('done'), 200); });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const order: string[] = [];
  const exits: number[] = [];
  const shutdown = createGracefulShutdown({
    getServer: () => server,
    lifecycle,
    ...shutdownStepsFor(planProcessRole('api', 2), resources(order)),
    exit: (code) => exits.push(code),
    log: () => {},
    drainTimeoutMs: 3_000,
    forceExitMs: 6_000,
  });
  const answer = new Promise<string>((resolve, reject) => {
    http.get(url, (res) => { let body = ''; res.on('data', (chunk) => { body += chunk; }); res.on('end', () => resolve(body)); }).on('error', reject);
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const onMessage = (message: unknown) => { if (message === 'shutdown') void shutdown('PM2 shutdown message'); };
  onMessage('shutdown');
  assert.equal(await answer, 'done');
  for (let attempt = 0; attempt < 100 && exits.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(exits, [0]);
  assert.deepEqual(order, ['workers', 'listen-connections', 'pdf-renderer', 'rabbitmq', 'redis', 'reports-pool', 'pool']);
});

test('background shutdown: no server; timers stop, consumers are cancelled, resources close, exit 0', async () => {
  const lifecycle = createProcessLifecycle();
  let pollerRuns = 0;
  lifecycle.stopOnShutdown(setInterval(() => { pollerRuns += 1; }, 10));
  const order: string[] = [];
  const exits: number[] = [];
  const shutdown = createGracefulShutdown({
    getServer: () => null,
    lifecycle,
    ...shutdownStepsFor(planProcessRole('background', 2), resources(order)),
    exit: (code) => exits.push(code),
    log: () => {},
    forceExitMs: 6_000,
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  await shutdown('PM2 shutdown message');
  const runsAtShutdown = pollerRuns;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(pollerRuns, runsAtShutdown, 'pollers stopped');
  assert.deepEqual(exits, [0]);
  assert.deepEqual(order, ['workers', 'consumers', 'listen-connections', 'rabbitmq', 'redis', 'reports-pool', 'pool']);
});
