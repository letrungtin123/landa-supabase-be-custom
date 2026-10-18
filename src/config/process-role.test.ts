import assert from 'node:assert/strict';
import test from 'node:test';
import { perInstanceShare, planProcessRole, signalProcessReady } from './process-role.js';

// Cluster mode: which role does what, and the PM2 ready signal.

test('each role runs its part; several API processes share their limits', () => {
  assert.deepEqual(planProcessRole('all', 1), {
    role: 'all', apiInstances: 1, servesHttp: true, runsBackgroundWork: true,
    sharesStateAcrossProcesses: false, severalApiInstances: false,
  });
  assert.deepEqual(planProcessRole('api', 1), {
    role: 'api', apiInstances: 1, servesHttp: true, runsBackgroundWork: false,
    sharesStateAcrossProcesses: true, severalApiInstances: false,
  });
  assert.deepEqual(planProcessRole('api', 4), {
    role: 'api', apiInstances: 4, servesHttp: true, runsBackgroundWork: false,
    sharesStateAcrossProcesses: true, severalApiInstances: true,
  });
  assert.deepEqual(planProcessRole('background', 4), {
    role: 'background', apiInstances: 4, servesHttp: false, runsBackgroundWork: true,
    sharesStateAcrossProcesses: true, severalApiInstances: false,
  });
});

test('several "all" processes are refused: the background work would run once per process', () => {
  assert.throws(() => planProcessRole('all', 2), /LANDA_PROCESS_ROLE=api/);
  assert.throws(() => planProcessRole('api', 0), /positive integer/);
});

test('the default (no LANDA_PROCESS_ROLE) is one process doing everything, as before', async () => {
  const { processRolePlan } = await import('./process-role.js');
  assert.equal(processRolePlan.role, process.env.LANDA_PROCESS_ROLE?.trim() || 'all');
  if (!process.env.LANDA_PROCESS_ROLE) {
    assert.equal(processRolePlan.servesHttp && processRolePlan.runsBackgroundWork, true);
    assert.equal(processRolePlan.sharesStateAcrossProcesses, false);
  }
});

test('the ready signal goes to PM2 when there is an IPC channel', () => {
  const sent: unknown[] = [];
  assert.equal(signalProcessReady((message) => sent.push(message)), true);
  assert.deepEqual(sent, ['ready']);
  assert.equal(signalProcessReady(undefined), false, 'started without PM2: nobody to tell');
});

test('a fallback share keeps the cluster total within limit + instances - 1', () => {
  assert.equal(perInstanceShare(8, 1), 8);
  assert.equal(perInstanceShare(8, 4), 2);
  assert.equal(perInstanceShare(8, 3), 3);
  assert.equal(perInstanceShare(1, 4), 1, 'never zero');
  for (const [limit, instances] of [[48, 4], [5, 4], [7, 3]] as const) {
    assert.ok(perInstanceShare(limit, instances) * instances <= limit + instances - 1);
  }
});
