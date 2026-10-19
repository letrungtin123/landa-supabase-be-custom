import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { freePort, getOnNewConnection, tally } from '../test-support/http-probe.js';

// The real in-app cluster primary (inapp-cluster-primary.ts) in a child
// process with tiny HTTP workers (test-support/inapp-cluster-echo-worker.mjs).
// This test plays PM2: it waits for "ready", then sends "shutdown". Runs on
// Windows, where Node's default scheduling would hand nearly every connection
// to one worker.

const here = path.dirname(fileURLToPath(import.meta.url));
const primaryScript = path.resolve(here, '..', 'test-support', 'inapp-cluster-echo-primary.ts');
const DEADLINE_MS = 30_000;
const REQUESTS = 200;

interface Echo {
  instance: string;
  slot: string;
  pid: number;
}

interface Primary {
  child: ChildProcess;
  port: number;
  readyAfterMs: Promise<number>;
  exited: Promise<number | null>;
  output: () => string;
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
  child.stdout?.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr?.on('data', (chunk) => {
    output += chunk;
  });
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
  return { child, port, readyAfterMs, exited, output: () => output };
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
