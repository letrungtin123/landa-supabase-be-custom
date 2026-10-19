import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { freePort, getOnNewConnection, startLoad, tally } from '../test-support/http-probe.js';
import { ROLLING_RESTART_REPLY_TOPIC, ROLLING_RESTART_TOPIC, type RollingRestartReply } from './inapp-cluster.logic.js';

// The real src/index.ts with LANDA_INAPP_CLUSTER_WORKERS=2 in an API process,
// under test-support/process-boot-harness.mjs (no database, RabbitMQ or Redis;
// the workers inherit the preload). This test plays PM2 in fork mode: one
// process, NODE_APP_INSTANCE=0, "ready", a rolling restart request, then
// "shutdown".
// - the primary does no app work: no query, TCP connection, LISTEN or timer;
// - each worker runs the normal API startup;
// - GET /internal/metrics on new connections alternates between the workers,
//   each answering with the `instance` label of its slot;
// - a rolling restart under 20 requests/s fails none of them.
//
// INAPP_CLUSTER_APP_BUILD=1 runs the same tests on the build (dist/index.js,
// after `npm run build`) instead of src/.

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const harness = pathToFileURL(path.join(root, 'src', 'test-support', 'process-boot-harness.mjs')).href;
const onBuild = process.env.INAPP_CLUSTER_APP_BUILD === '1';
const entry = path.join(root, onBuild ? 'dist' : 'src', onBuild ? 'index.js' : 'index.ts');
const DEADLINE_MS = 90_000;
const ROLL_DEADLINE_MS = 150_000;
const REQUESTS = 200;
const LOAD_PER_SECOND = 20;

interface Seen {
  intervals: string[];
  listenChannels: string[];
  connections: string[];
  consumedQueues: string[];
  httpListen: number;
  queries: number;
}

interface App {
  child: ChildProcess;
  port: number;
  tmp: string;
  ready: Promise<void>;
  exited: Promise<number | null>;
  output: () => string;
  /** The first answer to the rolling restart `requestId` with one of `statuses`. */
  reply: (requestId: string, statuses: RollingRestartReply['status'][]) => Promise<RollingRestartReply>;
}

async function startApp(deadlineMs: number): Promise<App> {
  if (onBuild) assert.ok(existsSync(entry), `${entry} is missing: run npm run build first`);
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'landa-inapp-cluster-'));
  const port = await freePort();
  const inherited: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR', 'ComSpec', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
    if (process.env[key] !== undefined) inherited[key] = process.env[key];
  }
  const child = fork(entry, [], {
    cwd: root,
    env: {
      ...inherited,
      NODE_ENV: 'test',
      PORT: String(port),
      BIND_HOST: '127.0.0.1',
      DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/test',
      JWT_SECRET: 'test-placeholder-not-a-secret',
      JWT_ACCESS_EXPIRES_IN: '15m',
      JWT_REFRESH_EXPIRES_IN: '7d',
      BCRYPT_SALT_ROUNDS: '4',
      CORS_ORIGIN: 'http://localhost:5274',
      SUPABASE_URL: 'http://127.0.0.1:1',
      SUPABASE_SERVICE_KEY: 'test-placeholder-not-a-key',
      RABBITMQ_URL: 'amqp://test:test@127.0.0.1:1',
      REDIS_URL: '',
      AI_RAG_SERVICE_URL: 'http://127.0.0.1:1',
      GEMINI_TEMP_DIR: path.join(tmp, 'gemini'),
      LESSON_AUTHOR_TRANSCRIPTION_TEMP_DIR: path.join(tmp, 'transcription'),
      LANDA_PROCESS_ROLE: 'api',
      LANDA_API_INSTANCES: '2',
      LANDA_INAPP_CLUSTER_WORKERS: '2',
      NODE_APP_INSTANCE: '0',
      BOOT_HARNESS_OUT: path.join(tmp, 'seen.json'),
      ...(onBuild ? { BOOT_HARNESS_SRC_ROOT: path.join(root, 'dist') } : {}),
    },
    execArgv: onBuild ? ['--import', harness] : ['--import', 'tsx', '--import', harness],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  child.stdout?.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr?.on('data', (chunk) => {
    output += chunk;
  });
  const kill = setTimeout(() => child.kill(), deadlineMs);
  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => {
      clearTimeout(kill);
      resolve(code);
    });
  });
  const ready = new Promise<void>((resolve, reject) => {
    child.on('message', (message) => {
      if (message === 'ready') resolve();
    });
    void exited.then((code) => reject(new Error(`exited (${code}) before "ready"\n${output}`)));
  });
  const replies: RollingRestartReply[] = [];
  const waiters = new Set<() => void>();
  child.on('message', (message: { type?: string; data?: RollingRestartReply & { topic?: string } }) => {
    if (message?.type !== 'process:msg' || message.data?.topic !== ROLLING_RESTART_REPLY_TOPIC) return;
    replies.push(message.data);
    for (const check of [...waiters]) check();
  });
  const reply = (requestId: string, statuses: RollingRestartReply['status'][]) =>
    new Promise<RollingRestartReply>((resolve, reject) => {
      const check = () => {
        const found = replies.find((candidate) => candidate.request_id === requestId && statuses.includes(candidate.status));
        if (!found) return;
        waiters.delete(check);
        resolve(found);
      };
      waiters.add(check);
      check();
      void exited.then((code) => reject(new Error(`exited (${code}) before answering ${requestId}\n${output}`)));
    });
  return { child, port, tmp, ready, exited, output: () => output, reply };
}

interface Scrape {
  instance: string;
  pid: string;
}

/** The `instance` label and pid of the worker that answered GET /internal/metrics. */
function parseScrape(body: string): Scrape {
  const info = /^landa_process_info\{instance="([^"]+)",role="api",pid="(\d+)"\} 1$/m.exec(body);
  assert.ok(info, body.slice(0, 300));
  return { instance: info[1]!, pid: info[2]! };
}

async function scrape(port: number, count: number): Promise<Scrape[]> {
  const answers: Scrape[] = [];
  for (let index = 0; index < count; index += 1) {
    const { status, body } = await getOnNewConnection(port, '/internal/metrics');
    assert.equal(status, 200, body);
    answers.push(parseScrape(body));
  }
  return answers;
}

function assertBalanced(answers: readonly Scrape[], label: string): void {
  const perInstance = tally(answers.map((answer) => answer.instance));
  assert.deepEqual(Object.keys(perInstance), ['0', '1'], `${label}: ${JSON.stringify(perInstance)}`);
  for (const count of Object.values(perInstance)) {
    assert.ok(Math.abs(count - answers.length / 2) <= answers.length / 20, `${label}: round-robin ${JSON.stringify(perInstance)}`);
  }
}

function distribution(answers: readonly Scrape[]): Record<string, number> {
  return tally(answers.map((answer) => `instance ${answer.instance} pid ${answer.pid}`));
}

test('in-app cluster of the API: round-robin between 2 workers; the primary does no app work', { timeout: DEADLINE_MS + 10_000 }, async (t) => {
  const app = await startApp(DEADLINE_MS);
  try {
    await app.ready;
    const answers = await scrape(app.port, REQUESTS);
    const perInstance = tally(answers.map((answer) => answer.instance));
    t.diagnostic(`${REQUESTS} GET /internal/metrics per worker instance: ${JSON.stringify(perInstance)}`);
    console.log(`[inapp-cluster app] ${REQUESTS} GET /internal/metrics per worker instance (${process.platform}): ${JSON.stringify(perInstance)}`);
    assertBalanced(answers, 'round-robin');

    app.child.send('shutdown');
    const output = app.output;
    assert.equal(await app.exited, 0, output());
    assert.match(output(), /\[InAppCluster\] \{"event":"all_workers_ready"/);
    assert.equal(output().split(`[Server] LANDA Backend listening on 127.0.0.1:${app.port}`).length - 1, 2, output());
    assert.equal(output().split('[Process] role=api api_instances=2').length - 1, 2, 'each worker runs the API startup');

    const read = (file: string) => JSON.parse(readFileSync(path.join(app.tmp, file), 'utf8')) as Seen;
    const primary = read('seen.json');
    assert.equal(primary.queries, 0, 'the primary runs no query');
    assert.deepEqual(primary.connections, [], 'the primary opens no TCP connection');
    assert.deepEqual(primary.listenChannels, [], 'the primary holds no LISTEN connection');
    assert.deepEqual(primary.intervals, [], 'the primary starts no timer of the app');
    for (const slot of [0, 1]) {
      const worker = read(`seen.json.worker-${slot}`);
      assert.equal(worker.httpListen, 1, `worker ${slot} listens`);
      assert.deepEqual(worker.listenChannels, ['landa_cluster_bus'], `worker ${slot}: the API startup`);
      assert.deepEqual(worker.consumedQueues, [], `worker ${slot}: no queue consumer`);
      assert.deepEqual(worker.connections, [], `worker ${slot}: no TCP connection attempt`);
    }
  } finally {
    app.child.kill();
    rmSync(app.tmp, { recursive: true, force: true });
  }
});

test(
  `rolling restart of the API workers under ${LOAD_PER_SECOND} requests/s: no failed request, a new process in each slot`,
  { timeout: ROLL_DEADLINE_MS + 10_000 },
  async (t) => {
    const app = await startApp(ROLL_DEADLINE_MS);
    try {
      await app.ready;
      const before = await scrape(app.port, 40);
      assertBalanced(before, 'before');

      const load = startLoad(app.port, LOAD_PER_SECOND, '/internal/metrics');
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const rollStartedAt = Date.now();
      app.child.send({ id: 0, type: 'process:msg', topic: ROLLING_RESTART_TOPIC, data: { request_id: 'app-roll' } });
      const done = await app.reply('app-roll', ['succeeded', 'failed', 'rejected']);
      const rollMs = Date.now() - rollStartedAt;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const during = await load.stop();
      const after = await scrape(app.port, 40);

      const report = [
        `[inapp-cluster app roll] ${onBuild ? 'dist/index.js' : 'src/index.ts'} on ${process.platform}: roll took ${rollMs} ms`,
        `  before (40 sequential): ${JSON.stringify(distribution(before))}`,
        `  load ${LOAD_PER_SECOND}/s from 1 s before to 1 s after the roll: sent ${during.sent}, ok ${during.bodies.length}, failed ${during.failures.length}`,
        `  answers under load: ${JSON.stringify(distribution(during.bodies.map(parseScrape)))}`,
        `  after (40 sequential): ${JSON.stringify(distribution(after))}`,
        `  slots: ${JSON.stringify(done.status === 'succeeded' ? done.slots : done)}`,
      ].join('\n');
      t.diagnostic(report);
      console.log(report);

      assert.equal(done.status, 'succeeded', `${JSON.stringify(done)}\n${app.output()}`);
      assert.deepEqual(during.failures, [], 'no request fails during the roll');
      assert.equal(during.bodies.length, during.sent);
      assertBalanced(after, 'after');
      for (const instance of ['0', '1']) {
        const oldPids = new Set(before.filter((answer) => answer.instance === instance).map((answer) => answer.pid));
        const newPids = new Set(after.filter((answer) => answer.instance === instance).map((answer) => answer.pid));
        assert.equal(oldPids.size, 1);
        assert.equal(newPids.size, 1);
        assert.notDeepEqual([...newPids], [...oldPids], `instance ${instance} runs in a new process`);
      }

      app.child.send('shutdown');
      assert.equal(await app.exited, 0, app.output());
    } finally {
      app.child.kill();
      rmSync(app.tmp, { recursive: true, force: true });
    }
  },
);
