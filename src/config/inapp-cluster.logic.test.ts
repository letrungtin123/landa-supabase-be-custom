import assert from 'node:assert/strict';
import test from 'node:test';
import {
  nextWorkerRestartDelayMs,
  planInAppCluster,
  workerInstanceLabel,
  WORKER_RESTART_INITIAL_DELAY_MS,
  WORKER_RESTART_MAX_DELAY_MS,
  WORKER_STABLE_UPTIME_MS,
  type InAppClusterInput,
} from './inapp-cluster.logic.js';

const base: InAppClusterInput = { role: 'api', workers: 2, apiInstances: 2, isPrimary: true, slot: '' };

test('off by default: 0 workers keeps every role as it is', () => {
  for (const role of ['all', 'api', 'background'] as const) {
    assert.deepEqual(planInAppCluster({ ...base, role, workers: 0, apiInstances: role === 'all' ? 1 : 2 }), { mode: 'off' });
    assert.deepEqual(planInAppCluster({ ...base, role, workers: 0, isPrimary: false, slot: '1' }), { mode: 'off' });
  }
});

test('an API process outside a cluster becomes the primary', () => {
  assert.deepEqual(planInAppCluster(base), { mode: 'primary', workers: 2 });
  assert.deepEqual(planInAppCluster({ ...base, workers: 1, apiInstances: 1 }), { mode: 'primary', workers: 1 });
});

test('a worker forked by the primary runs the API startup in its slot', () => {
  assert.deepEqual(planInAppCluster({ ...base, isPrimary: false, slot: '0' }), { mode: 'worker', slot: 0 });
  assert.deepEqual(planInAppCluster({ ...base, isPrimary: false, slot: '1' }), { mode: 'worker', slot: 1 });
});

test('a worker of another cluster (PM2 cluster mode) ignores the flag', () => {
  for (const slot of ['', '2', 'x', '-1']) {
    assert.equal(planInAppCluster({ ...base, isPrimary: false, slot }).mode, 'ignored');
  }
});

test('the background process and the "all" role are never clustered', () => {
  assert.throws(() => planInAppCluster({ ...base, role: 'background' }), /needs LANDA_PROCESS_ROLE=api/);
  assert.throws(() => planInAppCluster({ ...base, role: 'all', apiInstances: 1, workers: 1 }), /needs LANDA_PROCESS_ROLE=api/);
});

test('LANDA_API_INSTANCES must count every worker (shared limits through Redis)', () => {
  assert.throws(() => planInAppCluster({ ...base, workers: 3, apiInstances: 2 }), /more than LANDA_API_INSTANCES=2/);
  assert.throws(() => planInAppCluster({ ...base, workers: -1 }), /non-negative integer/);
  assert.throws(() => planInAppCluster({ ...base, workers: 1.5 }), /non-negative integer/);
});

test('instance labels: stable per slot, never overlapping between numbered parents', () => {
  assert.deepEqual([0, 1].map((slot) => workerInstanceLabel('', 2, slot)), ['0', '1']);
  assert.deepEqual([0, 1].map((slot) => workerInstanceLabel('0', 2, slot)), ['0', '1']);
  assert.deepEqual([0, 1].map((slot) => workerInstanceLabel('1', 2, slot)), ['2', '3']);
  assert.deepEqual([0, 1].map((slot) => workerInstanceLabel(' 1 ', 2, slot)), ['2', '3']);
  assert.deepEqual([0, 1].map((slot) => workerInstanceLabel('api', 2, slot)), ['0', '1']);
});

test('restart backoff: 1 s, x1.5 up to 15 s, back to 1 s after a stable run', () => {
  const delays: number[] = [];
  let previous: number | null = null;
  for (let restart = 0; restart < 10; restart += 1) {
    previous = nextWorkerRestartDelayMs(previous, 100);
    delays.push(previous);
  }
  assert.deepEqual(delays, [1000, 1500, 2250, 3375, 5063, 7595, 11393, 15000, 15000, 15000]);
  assert.equal(nextWorkerRestartDelayMs(WORKER_RESTART_MAX_DELAY_MS, WORKER_STABLE_UPTIME_MS), WORKER_RESTART_INITIAL_DELAY_MS);
  assert.equal(nextWorkerRestartDelayMs(null, 0), WORKER_RESTART_INITIAL_DELAY_MS);
});
