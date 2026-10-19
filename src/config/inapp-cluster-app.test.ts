import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { freePort, getOnNewConnection, tally } from '../test-support/http-probe.js';

// The real src/index.ts with LANDA_INAPP_CLUSTER_WORKERS=2 in an API process,
// under test-support/process-boot-harness.mjs (no database, RabbitMQ or Redis;
// the workers inherit the preload). This test plays PM2 in fork mode: one
// process, NODE_APP_INSTANCE=0, "ready", then "shutdown".
// - the primary does no app work: no query, TCP connection, LISTEN or timer;
// - each worker runs the normal API startup;
// - GET /internal/metrics on new connections alternates between the workers,
//   each answering with the `instance` label of its slot.

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const harness = pathToFileURL(path.join(root, 'src', 'test-support', 'process-boot-harness.mjs')).href;
const entry = path.join(root, 'src', 'index.ts');
const DEADLINE_MS = 90_000;
const REQUESTS = 200;

interface Seen {
  intervals: string[];
  listenChannels: string[];
  connections: string[];
  consumedQueues: string[];
  httpListen: number;
  queries: number;
}

test('in-app cluster of the API: round-robin between 2 workers; the primary does no app work', { timeout: DEADLINE_MS + 10_000 }, async (t) => {
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
    },
    execArgv: ['--import', 'tsx', '--import', harness],
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
  try {
    await new Promise<void>((resolve, reject) => {
      child.on('message', (message) => {
        if (message === 'ready') resolve();
      });
      void exited.then((code) => reject(new Error(`exited (${code}) before "ready"\n${output}`)));
    });

    const instances: string[] = [];
    for (let index = 0; index < REQUESTS; index += 1) {
      const { status, body } = await getOnNewConnection(port, '/internal/metrics');
      assert.equal(status, 200, body);
      const label = /^landa_event_loop_delay_p50_seconds\{instance="([^"]+)"\}/m.exec(body);
      assert.ok(label, body.slice(0, 300));
      instances.push(label[1]);
    }
    const perInstance = tally(instances);
    t.diagnostic(`${REQUESTS} GET /internal/metrics per worker instance: ${JSON.stringify(perInstance)}`);
    console.log(`[inapp-cluster app] ${REQUESTS} GET /internal/metrics per worker instance (${process.platform}): ${JSON.stringify(perInstance)}`);
    assert.deepEqual(Object.keys(perInstance), ['0', '1']);
    for (const count of Object.values(perInstance)) {
      assert.ok(Math.abs(count - REQUESTS / 2) <= REQUESTS / 20, `round-robin: ${JSON.stringify(perInstance)}`);
    }

    child.send('shutdown');
    assert.equal(await exited, 0, output);
    assert.match(output, /\[InAppCluster\] \{"event":"all_workers_ready"/);
    assert.equal(output.split(`[Server] LANDA Backend listening on 127.0.0.1:${port}`).length - 1, 2, output);
    assert.equal(output.split('[Process] role=api api_instances=2').length - 1, 2, 'each worker runs the API startup');

    const read = (file: string) => JSON.parse(readFileSync(path.join(tmp, file), 'utf8')) as Seen;
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
    child.kill();
    rmSync(tmp, { recursive: true, force: true });
  }
});
