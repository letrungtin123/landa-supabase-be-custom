// scripts/pm2-rolling-restart.mjs against a fake PM2 module (no PM2 daemon is
// started or reached): what it sends, how it reads the primary's answers on
// the bus, and its exit codes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ROLLING_RESTART_REPLY_TOPIC as LOGIC_REPLY_TOPIC,
  ROLLING_RESTART_TOPIC as LOGIC_TOPIC,
} from '../src/config/inapp-cluster.logic.ts';
import {
  EXIT_FAILED,
  EXIT_OK,
  EXIT_UNUSABLE,
  findTarget,
  parseArgs,
  rollingRestart,
  ROLLING_RESTART_REPLY_TOPIC,
  ROLLING_RESTART_TOPIC,
} from './pm2-rolling-restart.mjs';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pm2-rolling-restart.mjs');
const APP = 'landa-refactor-backend';
const PM_ID = 7;
const onlineApp = { name: APP, pm_id: PM_ID, pm2_env: { exec_mode: 'fork_mode', status: 'online' } };

/** A fake of the pm2 API; `answer(packet, reply)` plays the primary once the request is sent. */
function fakePm2({ alive = true, list = [onlineApp], sendError = null, answer = () => {} } = {}) {
  const bus = new EventEmitter();
  const calls = { connect: 0, disconnect: 0, sent: [] };
  const reply = (packet, fields, pmId = PM_ID) =>
    bus.emit('process:msg', {
      process: { pm_id: pmId, name: APP },
      data: { topic: ROLLING_RESTART_REPLY_TOPIC, request_id: packet.data.request_id, ...fields },
    });
  return {
    calls,
    Client: { pingDaemon: done => setImmediate(() => done(alive)) },
    connect: done => {
      calls.connect += 1;
      setImmediate(() => done(null, { new_pm2_instance: false }));
    },
    list: done => setImmediate(() => done(null, list)),
    launchBus: done => setImmediate(() => done(null, bus)),
    sendDataToProcessId: (packet, done) => {
      calls.sent.push(packet);
      setImmediate(() => {
        done(sendError, sendError ? undefined : { success: true });
        if (!sendError) answer(packet, (fields, pmId) => reply(packet, fields, pmId), bus);
      });
    },
    disconnect: done => {
      calls.disconnect += 1;
      setImmediate(() => done(null));
    },
  };
}

const slot = (index, oldPid, newPid) => ({
  status: 'slot_replaced',
  slot: index,
  instance: String(index),
  old_pid: oldPid,
  new_pid: newPid,
  ready_ms: 3000,
  stop_ms: 40,
  forced_stop: false,
});

async function run(pm2, options = {}) {
  const lines = [];
  const result = await rollingRestart({
    pm2,
    appName: APP,
    requestId: 'req-1',
    log: line => lines.push(line),
    ...options,
  });
  return { ...result, lines };
}

test('the topics match the primary (src/config/inapp-cluster.logic.ts)', () => {
  assert.equal(ROLLING_RESTART_TOPIC, LOGIC_TOPIC);
  assert.equal(ROLLING_RESTART_REPLY_TOPIC, LOGIC_REPLY_TOPIC);
});

test('sends the request to the app process and exits 0 when every slot is replaced', async () => {
  const pm2 = fakePm2({
    answer: (_packet, reply) => {
      reply({ status: 'accepted', workers: 2, timeout_ms: 151_000 }, 99); // another process
      reply({ status: 'succeeded', workers: 2, duration_ms: 1, slots: [] }, 99);
      reply({ status: 'accepted', workers: 2, timeout_ms: 151_000 });
      reply(slot(0, 100, 200));
      reply(slot(1, 101, 201));
      reply({ status: 'succeeded', workers: 2, duration_ms: 6_200, slots: [] });
    },
  });
  const result = await run(pm2);
  assert.equal(result.exitCode, EXIT_OK, result.message);
  assert.equal(result.message, 'done: 2 workers replaced in 6.2 s');
  assert.deepEqual(pm2.calls.sent, [
    { id: PM_ID, type: 'process:msg', topic: ROLLING_RESTART_TOPIC, data: { request_id: 'req-1' } },
  ]);
  assert.deepEqual(result.lines.slice(1), [
    '[rolling-restart] accepted: 2 workers, one after the other (at most 151 s)',
    '[rolling-restart] slot 0 (instance 0): pid 100 -> 200, ready in 3000 ms, old worker stopped in 40 ms',
    '[rolling-restart] slot 1 (instance 1): pid 101 -> 201, ready in 3000 ms, old worker stopped in 40 ms',
  ]);
  assert.equal(pm2.calls.disconnect, 1);
});

test('answers for another request are ignored', async () => {
  const pm2 = fakePm2({
    answer: (packet, _reply, bus) => {
      bus.emit('process:msg', {
        process: { pm_id: PM_ID },
        data: {
          topic: ROLLING_RESTART_REPLY_TOPIC,
          request_id: 'other',
          status: 'succeeded',
          workers: 2,
          duration_ms: 1,
        },
      });
      bus.emit('process:msg', {
        process: { pm_id: PM_ID },
        data: { topic: 'other', ...packet.data, status: 'succeeded' },
      });
    },
  });
  const result = await run(pm2, { ackTimeoutMs: 50 });
  assert.equal(result.exitCode, EXIT_FAILED);
  assert.match(result.message, /did not answer/);
});

test('rejected and failed rolls exit 1 with the reason', async () => {
  const rejected = await run(
    fakePm2({
      answer: (_packet, reply) =>
        reply({ status: 'rejected', reason: 'in_progress', message: 'A rolling restart is already in progress.' }),
    }),
  );
  assert.equal(rejected.exitCode, EXIT_FAILED);
  assert.equal(rejected.message, 'rejected (in_progress): A rolling restart is already in progress.');

  const failed = await run(
    fakePm2({
      answer: (_packet, reply) => {
        reply({ status: 'accepted', workers: 2, timeout_ms: 151_000 });
        reply(slot(0, 100, 200));
        reply({
          status: 'failed',
          reason: 'ready_timeout',
          slot: 1,
          replaced: 1,
          duration_ms: 64_000,
          message: 'Not ready.',
        });
      },
    }),
  );
  assert.equal(failed.exitCode, EXIT_FAILED);
  assert.equal(failed.message, 'failed at slot 1 (ready_timeout), 1 slot(s) replaced before: Not ready.');
});

test('no answer, no result in time, or the app exiting during the roll exit 1', async () => {
  const silent = await run(fakePm2(), { ackTimeoutMs: 50 });
  assert.equal(silent.exitCode, EXIT_FAILED);
  assert.match(silent.message, /did not answer within 0 s, so nothing was restarted/);

  const stalled = await run(
    fakePm2({ answer: (_packet, reply) => reply({ status: 'accepted', workers: 2, timeout_ms: 30 }) }),
    { ackTimeoutMs: 5_000, resultMarginMs: 20 },
  );
  assert.equal(stalled.exitCode, EXIT_FAILED);
  assert.match(stalled.message, /no result within 0 s of "accepted"/);

  const exited = await run(
    fakePm2({
      answer: (_packet, reply, bus) => {
        reply({ status: 'accepted', workers: 2, timeout_ms: 151_000 });
        bus.emit('process:event', { event: 'exit', process: { pm_id: PM_ID, name: APP } });
      },
    }),
  );
  assert.equal(exited.exitCode, EXIT_FAILED);
  assert.match(exited.message, /exited during the rolling restart/);
});

test('exits 2 without sending anything when PM2 or the app is not in a state to try', async () => {
  const noDaemon = fakePm2({ alive: false });
  const down = await run(noDaemon);
  assert.equal(down.exitCode, EXIT_UNUSABLE);
  assert.equal(noDaemon.calls.connect, 0, 'no new PM2 daemon is started');

  for (const [list, pattern] of [
    [[], /no app named/],
    [
      [
        { ...onlineApp, pm2_env: { exec_mode: 'cluster_mode', status: 'online' } },
        { ...onlineApp, pm_id: 8, pm2_env: { exec_mode: 'cluster_mode', status: 'online' } },
      ],
      /cluster mode \(2 processes\): use `pm2 reload/,
    ],
    [[onlineApp, { ...onlineApp, pm_id: 8 }], /has 2 PM2 processes/],
    [[{ ...onlineApp, pm2_env: { exec_mode: 'fork_mode', status: 'stopped' } }], /is stopped, not online/],
  ]) {
    const pm2 = fakePm2({ list });
    const result = await run(pm2);
    assert.equal(result.exitCode, EXIT_UNUSABLE);
    assert.match(result.message, pattern);
    assert.deepEqual(pm2.calls.sent, []);
    assert.equal(pm2.calls.disconnect, 1);
  }

  const undelivered = await run(fakePm2({ sendError: new Error('Process with ID <7> offline.') }));
  assert.equal(undelivered.exitCode, EXIT_UNUSABLE);
  assert.match(undelivered.message, /could not deliver the request: Process with ID <7> offline/);
});

test('command line: usage, and the result of a fake PM2 module as the exit code', () => {
  assert.equal(parseArgs([]), null);
  assert.equal(parseArgs(['--help']), null);
  assert.equal(parseArgs([APP, 'extra']), null);
  assert.deepEqual(parseArgs([APP]), { appName: APP });
  assert.deepEqual(findTarget([onlineApp], APP), { pmId: PM_ID });

  const usage = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(usage.status, EXIT_UNUSABLE);
  assert.match(usage.stderr, /^Usage: node scripts\/pm2-rolling-restart\.mjs <pm2 app name>/);

  const tmp = mkdtempSync(path.join(os.tmpdir(), 'landa-fake-pm2-'));
  try {
    const fake = path.join(tmp, 'fake-pm2.cjs');
    writeFileSync(
      fake,
      `const { EventEmitter } = require('node:events');
const bus = new EventEmitter();
const later = fn => setImmediate(fn);
module.exports = {
  Client: { pingDaemon: done => later(() => done(true)) },
  connect: done => later(() => done(null, {})),
  list: done => later(() => done(null, [{ name: ${JSON.stringify(APP)}, pm_id: 3, pm2_env: { exec_mode: 'fork_mode', status: 'online' } }])),
  launchBus: done => later(() => done(null, bus)),
  sendDataToProcessId: (packet, done) => later(() => {
    done(null, {});
    const data = { topic: ${JSON.stringify(ROLLING_RESTART_REPLY_TOPIC)}, request_id: packet.data.request_id };
    const status = process.env.FAKE_PM2_RESULT;
    bus.emit('process:msg', { process: { pm_id: 3 }, data: { ...data, status: 'accepted', workers: 2, timeout_ms: 1000 } });
    bus.emit('process:msg', { process: { pm_id: 3 }, data: status === 'succeeded'
      ? { ...data, status, workers: 2, duration_ms: 1500, slots: [] }
      : { ...data, status, reason: 'exited_before_ready', slot: 0, replaced: 0, duration_ms: 10, message: 'New worker exited.' } });
  }),
  disconnect: done => later(() => done(null)),
};
`,
    );
    for (const [status, code, pattern] of [
      ['succeeded', EXIT_OK, /done: 2 workers replaced in 1\.5 s/],
      ['failed', EXIT_FAILED, /failed at slot 0 \(exited_before_ready\)/],
    ]) {
      const run = spawnSync(process.execPath, [script, APP], {
        encoding: 'utf8',
        env: { ...process.env, LANDA_PM2_MODULE: fake, FAKE_PM2_RESULT: status },
      });
      assert.equal(run.status, code, run.stdout + run.stderr);
      assert.match(run.stdout + run.stderr, pattern);
      assert.match(run.stdout, /accepted: 2 workers/);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
