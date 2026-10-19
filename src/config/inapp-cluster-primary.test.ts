import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { freePort, getOnNewConnection, startLoad, tally } from '../test-support/http-probe.js';
import { ROLLING_RESTART_REPLY_TOPIC, ROLLING_RESTART_TOPIC, type RollingRestartReply } from './inapp-cluster.logic.js';

// The real in-app cluster primary (inapp-cluster-primary.ts) in a child
// process with tiny HTTP workers (test-support/inapp-cluster-echo-worker.mjs).
// This test plays PM2: it waits for "ready", sends rolling restart requests
// (as sendDataToProcessId does), reads the answers (as PM2's bus does) and
// sends "shutdown". Runs on Windows, where Node's default scheduling would
// hand nearly every connection to one worker.

const here = path.dirname(fileURLToPath(import.meta.url));
const primaryScript = path.resolve(here, '..', 'test-support', 'inapp-cluster-echo-primary.ts');
const DEADLINE_MS = 30_000;
const REQUESTS = 200;
const LOAD_PER_SECOND = 20;

interface Echo {
  instance: string;
  slot: string;
  pid: number;
  build: string;
}

interface Primary {
  child: ChildProcess;
  port: number;
  readyAfterMs: Promise<number>;
  exited: Promise<number | null>;
  output: () => string;
  /** Resolves once the primary's output matches `pattern`. */
  logged: (pattern: RegExp) => Promise<RegExpExecArray>;
  /** Sends a rolling restart request, as PM2's sendDataToProcessId does. */
  requestRollingRestart: (requestId: string) => void;
  /** The first answer to `requestId` with one of `statuses`. */
  reply: (requestId: string, statuses: RollingRestartReply['status'][]) => Promise<RollingRestartReply>;
  replies: RollingRestartReply[];
}

async function startPrimary(env: Record<string, string>): Promise<Primary> {
  const port = await freePort();
  const inherited: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) {
    if (process.env[key] !== undefined) inherited[key] = process.env[key];
  }
  const startedAt = Date.now();
  const child = fork(primaryScript, [], {
    env: { ...inherited, PORT: String(port), ECHO_WORKERS: '2', NODE_APP_INSTANCE: '0', ...env },
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  const changed = new Set<() => void>();
  const append = (chunk: Buffer) => {
    output += chunk;
    for (const check of [...changed]) check();
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  const kill = setTimeout(() => child.kill(), DEADLINE_MS);
  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => {
      clearTimeout(kill);
      resolve(code);
    });
  });
  const readyAfterMs = new Promise<number>((resolve, reject) => {
    child.on('message', (message) => {
      if (message === 'ready') resolve(Date.now() - startedAt);
    });
    void exited.then((code) => reject(new Error(`primary exited (${code}) before "ready"\n${output}`)));
  });
  const replies: RollingRestartReply[] = [];
  child.on('message', (message: { type?: string; data?: RollingRestartReply & { topic?: string } }) => {
    if (message?.type !== 'process:msg' || message.data?.topic !== ROLLING_RESTART_REPLY_TOPIC) return;
    replies.push(message.data);
    for (const check of [...changed]) check();
  });
  /** Resolves with `find()` once it returns a value (checked on every output and answer). */
  const when = <T>(find: () => T | undefined, what: string) =>
    new Promise<T>((resolve, reject) => {
      const check = () => {
        const found = find();
        if (found === undefined) return;
        changed.delete(check);
        resolve(found);
      };
      changed.add(check);
      check();
      void exited.then((code) => reject(new Error(`primary exited (${code}) before ${what}\n${output}`)));
    });
  return {
    child,
    port,
    readyAfterMs,
    exited,
    output: () => output,
    logged: (pattern) => when(() => pattern.exec(output) ?? undefined, `logging ${pattern}`),
    requestRollingRestart: (requestId) => {
      child.send({ id: 0, type: 'process:msg', topic: ROLLING_RESTART_TOPIC, data: { request_id: requestId } });
    },
    reply: (requestId, statuses) =>
      when(
        () => replies.find((reply) => reply.request_id === requestId && statuses.includes(reply.status)),
        `answering ${requestId} with ${statuses.join('|')}`,
      ),
    replies,
  };
}

async function echo(port: number, pathName = '/'): Promise<Echo> {
  const { status, body } = await getOnNewConnection(port, pathName);
  assert.equal(status, 200, body);
  return JSON.parse(body) as Echo;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('ready after every worker listens; new connections alternate between the workers; graceful shutdown', { timeout: DEADLINE_MS }, async (t) => {
  const primary = await startPrimary({ ECHO_LISTEN_DELAY_INSTANCE: '1', ECHO_LISTEN_DELAY_MS: '1500' });
  const readyAfterMs = await primary.readyAfterMs;
  assert.ok(readyAfterMs >= 1_500, `"ready" came ${readyAfterMs} ms after start, before the late worker listened`);

  const answers: Echo[] = [];
  for (let index = 0; index < REQUESTS; index += 1) answers.push(await echo(primary.port));
  const perInstance = tally(answers.map((answer) => answer.instance));
  t.diagnostic(`${REQUESTS} requests per worker instance: ${JSON.stringify(perInstance)}`);
  console.log(`[inapp-cluster] ${REQUESTS} requests per worker instance (${process.platform}): ${JSON.stringify(perInstance)}`);
  assert.deepEqual(Object.keys(perInstance), ['0', '1'], 'both workers answer, with the instance label of their slot');
  for (const count of Object.values(perInstance)) {
    assert.ok(Math.abs(count - REQUESTS / 2) <= REQUESTS / 20, `round-robin: ${JSON.stringify(perInstance)}`);
  }
  for (const answer of answers) assert.equal(answer.slot, answer.instance, 'slot env matches the instance label');

  const pids = [...new Set(answers.map((answer) => answer.pid))];
  assert.equal(pids.length, 2);
  primary.child.send('shutdown');
  assert.equal(await primary.exited, 0, primary.output());
  for (const pid of pids) assert.equal(isAlive(pid), false, `worker ${pid} stopped`);
  assert.match(primary.output(), /"event":"shutdown_finished".*"forced":false/);
});

test('a crashed worker restarts in its slot with the same instance label', { timeout: DEADLINE_MS }, async () => {
  const primary = await startPrimary({});
  await primary.readyAfterMs;
  const crashed = await echo(primary.port, '/crash');

  let replacement: Echo | null = null;
  const until = Date.now() + 15_000;
  while (!replacement && Date.now() < until) {
    const answer = await echo(primary.port).catch(() => null);
    if (!replacement) await new Promise((resolve) => setTimeout(resolve, 100));
    if (answer && answer.instance === crashed.instance && answer.pid !== crashed.pid) replacement = answer;
  }
  assert.ok(replacement, `slot ${crashed.slot} came back${primary.output()}`);
  assert.equal(replacement.slot, crashed.slot);
  assert.match(primary.output(), /"event":"worker_exited".*"code":3.*"restart_in_ms":1000/);

  primary.child.send('shutdown');
  assert.equal(await primary.exited, 0, primary.output());
});

test('a worker that ignores the shutdown message is killed at the deadline', { timeout: DEADLINE_MS }, async () => {
  const primary = await startPrimary({ ECHO_IGNORE_SHUTDOWN_INSTANCE: '1', ECHO_SHUTDOWN_DEADLINE_MS: '1000' });
  await primary.readyAfterMs;
  const startedAt = Date.now();
  primary.child.send('shutdown');
  assert.equal(await primary.exited, 1, primary.output());
  assert.ok(Date.now() - startedAt < 10_000);
  assert.match(primary.output(), /"event":"worker_killed_at_deadline".*"instance":"1"/);
  assert.match(primary.output(), /"event":"shutdown_finished".*"forced":true/);
});

// ── Rolling restart ──────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `count` answers on new connections, one after the other. */
async function sample(port: number, count: number): Promise<Echo[]> {
  const answers: Echo[] = [];
  for (let index = 0; index < count; index += 1) answers.push(await echo(port));
  return answers;
}

/** instance/pid/build -> answers. */
function distribution(answers: readonly Echo[]): Record<string, number> {
  return tally(answers.map((answer) => `instance ${answer.instance} pid ${answer.pid} ${answer.build}`));
}

function pidsByInstance(answers: readonly Echo[]): Record<string, number[]> {
  const pids: Record<string, number[]> = {};
  for (const answer of answers) {
    const list = (pids[answer.instance] ??= []);
    if (!list.includes(answer.pid)) list.push(answer.pid);
  }
  return pids;
}

function assertBalanced(answers: readonly Echo[], label: string): void {
  const perInstance = tally(answers.map((answer) => answer.instance));
  assert.deepEqual(Object.keys(perInstance), ['0', '1'], `${label}: ${JSON.stringify(perInstance)}`);
  for (const count of Object.values(perInstance)) {
    assert.ok(Math.abs(count - answers.length / 2) <= answers.length / 20, `${label}: round-robin ${JSON.stringify(perInstance)}`);
  }
}

test(
  `rolling restart under ${LOAD_PER_SECOND} requests/s: slot by slot to the new build, no failed request, a second request is rejected`,
  { timeout: DEADLINE_MS },
  async (t) => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'landa-inapp-roll-'));
    const buildFile = path.join(tmp, 'build');
    writeFileSync(buildFile, 'v1');
    const primary = await startPrimary({ ECHO_BUILD_FILE: buildFile, ECHO_RESPONSE_DELAY_MS: '100' });
    try {
      await primary.readyAfterMs;
      const before = await sample(primary.port, 40);
      assertBalanced(before, 'before');
      assert.ok(before.every((answer) => answer.build === 'v1'));
      const oldPids = pidsByInstance(before);

      writeFileSync(buildFile, 'v2');
      const load = startLoad(primary.port, LOAD_PER_SECOND);
      await sleep(1_000);
      const rollStartedAt = Date.now();
      primary.requestRollingRestart('roll-1');
      primary.requestRollingRestart('roll-2');
      const second = await primary.reply('roll-2', ['rejected', 'accepted']);
      assert.ok(second.status === 'rejected' && second.reason === 'in_progress', JSON.stringify(second));
      const done = await primary.reply('roll-1', ['succeeded', 'failed']);
      const rollMs = Date.now() - rollStartedAt;
      await sleep(1_000);
      const during = await load.stop();
      const after = await sample(primary.port, 40);

      const report = [
        `[inapp-cluster roll] ${process.platform}: roll took ${rollMs} ms`,
        `  before (40 sequential): ${JSON.stringify(distribution(before))}`,
        `  load ${LOAD_PER_SECOND}/s from 1 s before to 1 s after the roll: sent ${during.sent}, ok ${during.bodies.length}, failed ${during.failures.length}`,
        `  answers under load: ${JSON.stringify(distribution(during.bodies.map((body) => JSON.parse(body) as Echo)))}`,
        `  after (40 sequential): ${JSON.stringify(distribution(after))}`,
      ].join('\n');
      t.diagnostic(report);
      console.log(report);

      assert.equal(done.status, 'succeeded', `${JSON.stringify(done)}\n${primary.output()}`);
      assert.deepEqual(during.failures, [], 'no request fails during the roll');
      assert.equal(during.bodies.length, during.sent);
      assert.ok(during.sent >= LOAD_PER_SECOND * 2, `load ran: ${during.sent} requests`);

      const accepted = await primary.reply('roll-1', ['accepted']);
      assert.ok(accepted.status === 'accepted' && accepted.workers === 2 && accepted.timeout_ms > 0);
      const slots = primary.replies.filter((reply) => reply.request_id === 'roll-1' && reply.status === 'slot_replaced');
      assert.deepEqual(
        slots.map((reply) => reply.status === 'slot_replaced' && [reply.slot, reply.instance, reply.forced_stop]),
        [
          [0, '0', false],
          [1, '1', false],
        ],
      );

      assertBalanced(after, 'after');
      assert.ok(
        after.every((answer) => answer.build === 'v2'),
        'every worker runs the new build',
      );
      const newPids = pidsByInstance(after);
      for (const instance of ['0', '1']) {
        assert.equal(newPids[instance]!.length, 1);
        assert.ok(!oldPids[instance]!.includes(newPids[instance]![0]!), `instance ${instance} has a new process`);
        const slot = slots.find((reply) => reply.status === 'slot_replaced' && reply.instance === instance);
        assert.ok(slot?.status === 'slot_replaced');
        assert.equal(slot.old_pid, oldPids[instance]![0]);
        assert.equal(slot.new_pid, newPids[instance]![0]);
      }

      primary.child.send('shutdown');
      assert.equal(await primary.exited, 0, primary.output());
      for (const pid of [...Object.values(oldPids), ...Object.values(newPids)].flat()) assert.equal(isAlive(pid), false);
    } finally {
      primary.child.kill();
      rmSync(tmp, { recursive: true, force: true });
    }
  },
);

test(
  'rolling restart: rejected before every worker is ready; a new worker that crashes or is never ready is stopped and the old ones keep serving',
  { timeout: DEADLINE_MS },
  async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'landa-inapp-roll-'));
    const buildFile = path.join(tmp, 'build');
    writeFileSync(buildFile, 'v1');
    const primary = await startPrimary({
      ECHO_BUILD_FILE: buildFile,
      ECHO_READY_TIMEOUT_MS: '3000',
      ECHO_LISTEN_DELAY_INSTANCE: '1',
      ECHO_LISTEN_DELAY_MS: '1000',
    });
    try {
      await primary.logged(/"event":"inapp_cluster_started"/);
      primary.requestRollingRestart('early');
      const early = await primary.reply('early', ['rejected', 'accepted']);
      assert.ok(early.status === 'rejected' && early.reason === 'not_ready', JSON.stringify(early));
      await primary.readyAfterMs;
      const oldPids = pidsByInstance(await sample(primary.port, 20));

      for (const [build, reason] of [
        ['crash', 'exited_before_ready'],
        ['hang', 'ready_timeout'],
      ] as const) {
        writeFileSync(buildFile, build);
        primary.requestRollingRestart(build);
        const failed = await primary.reply(build, ['succeeded', 'failed']);
        assert.ok(failed.status === 'failed', JSON.stringify(failed));
        assert.deepEqual([failed.reason, failed.slot, failed.replaced], [reason, 0, 0]);
        const still = await sample(primary.port, 20);
        assert.deepEqual(pidsByInstance(still), oldPids, `${build}: the old workers keep serving`);
        assert.ok(still.every((answer) => answer.build === 'v1'));
      }
      assert.match(primary.output(), /"event":"worker_stopped".*"code":4/, 'the crashed replacement exited');

      writeFileSync(buildFile, 'v2');
      primary.requestRollingRestart('fixed');
      const fixed = await primary.reply('fixed', ['succeeded', 'failed']);
      assert.equal(fixed.status, 'succeeded', JSON.stringify(fixed));
      const after = await sample(primary.port, 20);
      assert.ok(after.every((answer) => answer.build === 'v2'));
      assert.doesNotMatch(primary.output(), /"event":"worker_exited"/, 'no slot restarted as after a crash');

      primary.child.send('shutdown');
      assert.equal(await primary.exited, 0, primary.output());
    } finally {
      primary.child.kill();
      rmSync(tmp, { recursive: true, force: true });
    }
  },
);

test('shutdown during a rolling restart stops the old and the new workers', { timeout: DEADLINE_MS }, async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'landa-inapp-roll-'));
  const buildFile = path.join(tmp, 'build');
  writeFileSync(buildFile, 'v1');
  const primary = await startPrimary({ ECHO_BUILD_FILE: buildFile, ECHO_READY_TIMEOUT_MS: '20000' });
  try {
    await primary.readyAfterMs;
    const oldPids = Object.values(pidsByInstance(await sample(primary.port, 10))).flat();
    writeFileSync(buildFile, 'hang');
    primary.requestRollingRestart('interrupted');
    const started = await primary.logged(/"event":"replacement_started"[^\n]*"pid":(\d+)/);
    primary.child.send('shutdown');
    const failed = await primary.reply('interrupted', ['succeeded', 'failed']);
    assert.ok(failed.status === 'failed' && failed.reason === 'shutting_down', JSON.stringify(failed));
    assert.equal(await primary.exited, 0, primary.output());
    for (const pid of [...oldPids, Number(started[1])]) assert.equal(isAlive(pid), false, `${pid} stopped`);
  } finally {
    primary.child.kill();
    rmSync(tmp, { recursive: true, force: true });
  }
});
