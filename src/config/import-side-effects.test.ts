import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Importing a module starts nothing (BE-S13): no timer, worker, consumer,
// LISTEN or connection. The process startup (config/process-startup.ts) and
// the src/workers entry points start them. A child process imports app.ts
// and every module of src/ except the entry points with a fake environment
// (every service URL on a closed port, real pg/amqplib/redis clients), waits
// a moment, and must then exit by itself without one connection attempt.

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '..');
const root = path.resolve(src, '..');
const harness = pathToFileURL(path.join(src, 'test-support', 'process-boot-harness.mjs')).href;
const probe = path.join(src, 'test-support', 'import-probe.mjs');
const EXIT_DEADLINE_MS = 60_000;

/** Entry points (they start their work on purpose) and test code are not imported. */
const NOT_IMPORTED = new Set([
  'index.ts',
  // A worker_threads entry: it reads workerData at its top level.
  'modules/ai-chatbot/kb/kb-faq-sheet.worker.ts',
]);
const NOT_IMPORTED_DIRECTORIES = ['workers/', 'scripts/', 'test-support/', 'types/'];

/**
 * Timers an import may leave, all unref'd (they never keep a process alive):
 * the in-memory fallback stores of the request rate limiters, created with
 * the limiter at module level.
 */
const ALLOWED_IMPORT_INTERVALS = ['middleware/rate-limit-store.ts every 900000 ms'];

function listModules(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listModules(file));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts')) files.push(file);
  }
  return files;
}

function importedModules(): string[] {
  const relative = (file: string) => path.relative(src, file).split(path.sep).join('/');
  const modules = listModules(src).filter((file) => {
    const name = relative(file);
    return !NOT_IMPORTED.has(name) && !NOT_IMPORTED_DIRECTORIES.some((prefix) => name.startsWith(prefix));
  });
  // app.ts first: the API module graph as the server loads it.
  return [path.join(src, 'app.ts'), ...modules.filter((file) => relative(file) !== 'app.ts')];
}

function childEnv(tmp: string): NodeJS.ProcessEnv {
  const inherited: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'windir', 'ComSpec', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
    if (process.env[key] !== undefined) inherited[key] = process.env[key];
  }
  return {
    ...inherited,
    NODE_ENV: 'test',
    PORT: '0',
    DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/test',
    JWT_SECRET: 'test-placeholder-not-a-secret',
    JWT_ACCESS_EXPIRES_IN: '15m',
    JWT_REFRESH_EXPIRES_IN: '7d',
    BCRYPT_SALT_ROUNDS: '4',
    CORS_ORIGIN: 'http://localhost:5274',
    SUPABASE_URL: 'http://127.0.0.1:1',
    SUPABASE_SERVICE_KEY: 'test-placeholder-not-a-key',
    RABBITMQ_URL: 'amqp://test:test@127.0.0.1:1',
    REDIS_URL: 'redis://127.0.0.1:1',
    AI_RAG_SERVICE_URL: 'http://127.0.0.1:1',
    GEMINI_TEMP_DIR: path.join(tmp, 'gemini'),
    LESSON_AUTHOR_TRANSCRIPTION_TEMP_DIR: path.join(tmp, 'transcription'),
    // The role whose imports used to start the most (the inline email outbox).
    LANDA_PROCESS_ROLE: 'all',
    BOOT_HARNESS_MODE: 'observe',
    BOOT_HARNESS_OUT: path.join(tmp, 'seen.json'),
    IMPORT_PROBE_MODULES: path.join(tmp, 'modules.json'),
    IMPORT_PROBE_OUT: path.join(tmp, 'probe.json'),
  };
}

test('importing app.ts and every service, worker and config module starts nothing', { timeout: EXIT_DEADLINE_MS + 10_000 }, async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'landa-import-'));
  try {
    const modules = importedModules();
    assert.ok(modules.length > 300, `module list looks too short: ${modules.length}`);
    writeFileSync(path.join(tmp, 'modules.json'), JSON.stringify(modules));
    const child = spawn(process.execPath, ['--import', 'tsx', '--import', harness, probe], {
      cwd: root,
      env: childEnv(tmp),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    let killed = false;
    const deadline = setTimeout(() => { killed = true; child.kill(); }, EXIT_DEADLINE_MS);
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    clearTimeout(deadline);
    const context = `\n--- child output ---\n${output}`;
    assert.equal(killed, false, `the process did not exit by itself: an import left something running${context}`);
    assert.equal(code, 0, `exit code${context}`);

    const report = JSON.parse(readFileSync(path.join(tmp, 'probe.json'), 'utf8')) as {
      imported: number; failures: string[]; resourcesAfterImport: string[]; resourcesAfterWait: string[];
    };
    const seen = JSON.parse(readFileSync(path.join(tmp, 'seen.json'), 'utf8')) as {
      intervals: string[]; timeoutFiles: string[]; connections: string[]; listenChannels: string[]; httpListen: number;
    };
    assert.deepEqual(report.failures, [], 'every module imports');
    assert.equal(report.imported, modules.length);
    const keepsAlive = (resources: string[]) => resources.filter((type) => /Timeout|TCP|Pipe|GetAddrInfo|Process|UDP|Signal/.test(type) && type !== 'PipeWrap');
    assert.deepEqual(keepsAlive(report.resourcesAfterWait), [], 'handles still active after the imports');
    assert.deepEqual(seen.intervals.filter((entry) => !ALLOWED_IMPORT_INTERVALS.includes(entry)), [], 'intervals started on import');
    assert.deepEqual(seen.timeoutFiles.filter((file) => !file.startsWith('test-support/')), [], 'timeouts started on import');
    assert.deepEqual(seen.connections, [], 'connection attempts (database, Redis, RabbitMQ, HTTP)');
    assert.deepEqual(seen.listenChannels, [], 'LISTEN');
    assert.equal(seen.httpListen, 0, 'HTTP listen');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
