import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// What one process of src/index.ts starts, per LANDA_PROCESS_ROLE: the real
// bootstrap runs in a child process under test-support/process-boot-harness.mjs
// (no database, RabbitMQ or Redis: pg answers no rows, amqplib is in memory,
// REDIS_URL is empty, every other URL is a closed port). The child signals
// PM2 "ready", gets the PM2 "shutdown" message and must exit 0 by itself.
//
// Pinned from the behavior before the start functions moved out of module
// imports (wave 2, BE-S13): the same timers, queue consumers, LISTEN channels
// and log lines per role, whether a step runs at import or from
// config/process-startup.ts.

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const harness = pathToFileURL(path.join(root, 'src', 'test-support', 'process-boot-harness.mjs')).href;
const entry = path.join(root, 'src', 'index.ts');
const SETTLE_AFTER_READY_MS = 1_500;
const BOOT_DEADLINE_MS = 60_000;

type Role = 'all' | 'api' | 'background';
interface Seen {
  exitCode: number;
  forcedExit: boolean;
  intervals: string[];
  timeoutFiles: string[];
  listenChannels: string[];
  assertedQueues: string[];
  consumedQueues: string[];
  connections: string[];
  httpListen: number;
}
interface Boot {
  code: number | null;
  ready: boolean;
  seen: Seen;
  output: string;
}

function childEnv(tmp: string, role: Role, flags: Record<string, string>): NodeJS.ProcessEnv {
  const inherited: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR', 'ComSpec', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
    if (process.env[key] !== undefined) inherited[key] = process.env[key];
  }
  return {
    ...inherited,
    NODE_ENV: 'test',
    PORT: '0',
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
    LANDA_PROCESS_ROLE: role,
    LANDA_API_INSTANCES: role === 'all' ? '1' : '2',
    BOOT_HARNESS_OUT: path.join(tmp, 'seen.json'),
    ...flags,
  };
}

function boot(role: Role, flags: Record<string, string> = {}, script = entry): Promise<Boot> {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'landa-role-matrix-'));
  return new Promise((resolve, reject) => {
    const child = fork(script, [], {
      cwd: root,
      env: childEnv(tmp, role, flags),
      execArgv: ['--import', 'tsx', '--import', harness],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let output = '';
    child.stdout?.on('data', (chunk) => { output += chunk; });
    child.stderr?.on('data', (chunk) => { output += chunk; });
    let ready = false;
    let settle: NodeJS.Timeout | null = null;
    child.on('message', (message) => {
      if (message !== 'ready' || ready) return;
      ready = true;
      settle = setTimeout(() => child.send('shutdown'), SETTLE_AFTER_READY_MS);
    });
    const deadline = setTimeout(() => child.kill(), BOOT_DEADLINE_MS);
    child.once('error', reject);
    child.once('exit', (code) => {
      clearTimeout(deadline);
      if (settle) clearTimeout(settle);
      try {
        const seen = JSON.parse(readFileSync(path.join(tmp, 'seen.json'), 'utf8')) as Seen;
        resolve({ code, ready, seen, output });
      } catch (error) {
        reject(new Error(`${role}: no harness report (exit ${code})\n${output}`, { cause: error }));
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });
}

// ── The start functions, by the timers they leave running ──
/** In-memory cache sweepers (sign-out blacklist, chat rate limit, course outline cache, one-time sign-in tokens). */
const IN_MEMORY_SWEEPERS = [
  'middleware/authenticate.ts every 300000 ms',
  'modules/ai-chatbot/chat.service.ts every 300000 ms',
  'modules/ai-chatbot/chat.service.ts every 600000 ms',
  'modules/auth/auth.service.ts every 60000 ms',
];
/** The cluster bus LISTEN connection health check (more than one process). */
const CLUSTER_BUS = ['config/cluster-bus.ts every 30000 ms'];
/** Queue workers and their database pollers (the RabbitMQ consumers step). */
const QUEUE_WORKERS = [
  'modules/ai-chatbot/ai-engine-transition.worker.ts every 15000 ms',
  'modules/ai-chatbot/kb-operation.worker.ts every 10000 ms',
  'modules/ai-chatbot/lesson-author-session-deletion.worker.ts every 30000 ms',
  'modules/ai-chatbot/lesson-author-transcription.worker.ts every 10000 ms',
  'modules/ai-chatbot/lesson-author-transcription.worker.ts every 21600000 ms',
  'modules/ai-chatbot/restore.worker.ts every 30000 ms',
  'modules/course-deletion/course-deletion.worker.ts every 30000 ms',
  'modules/learner/progress-recalculation.worker.ts every 60000 ms',
  'modules/users/user-deletion.worker.ts every 30000 ms',
];
/** Sweepers and maintenance timers of index.ts (tokens, deletion jobs, revocations, audit logs) and the AI reservation sweeper. */
const MAINTENANCE = [
  'index.ts every 21600000 ms',
  'index.ts every 21600000 ms',
  'index.ts every 86400000 ms',
  'index.ts every 86400000 ms',
  'modules/ai-chatbot/ai-token-quota.service.ts every 30000 ms',
];
/** Course asset temp residue sweep (only when other processes share the temp directory). */
const COURSE_ASSET_TEMP_SWEEP = ['index.ts every 21600000 ms'];
const INLINE_EMAIL_OUTBOX = ['modules/assignments/email-outbox.service.ts every 15000 ms'];
/**
 * Added after the matrix was pinned, the one intended change (wave 2, BE-S14):
 * the [Heartbeat] log line of the processes that run background work and of
 * the running workers. Unref'd: it never keeps a process alive.
 */
const HEARTBEAT = ['modules/metrics/heartbeat.service.ts every 60000 ms'];

const ALL_QUEUES = [
  'LANDA_GEMINI_UPLOAD',
  'LANDA_GEMINI_DELETE',
  'LANDA_GEMINI_RESTORE',
  'LANDA_COURSE_DELETE',
  'LANDA_USER_DELETE',
  'LANDA_LESSON_AUTHOR_SESSION_DELETE',
  'LANDA_EMAIL_OUTBOX',
  'LANDA_COURSE_PROGRESS_RECALC',
];
const CONSUMED_QUEUES = [
  'LANDA_GEMINI_UPLOAD',
  'LANDA_GEMINI_RESTORE',
  'LANDA_COURSE_DELETE',
  'LANDA_USER_DELETE',
  'LANDA_LESSON_AUTHOR_SESSION_DELETE',
  'LANDA_COURSE_PROGRESS_RECALC',
];
const LOG = {
  inlineEmailStarted: '[EmailOutbox] Worker started source=inline',
  inlineEmailElsewhere: '[EmailOutbox] Inline worker runs in the background process (LANDA_PROCESS_ROLE=api here).',
  inlineEmailDisabled: '[EmailOutbox] Inline worker disabled; use the dedicated email worker process.',
  workersStarted: '[RabbitMQ] All workers started',
  publishingOnly: '[RabbitMQ] Publishing only; the consumers run in the background process',
  clusterBus: '[ClusterBus] Listening for invalidations from the other processes',
  listening: '[Server] LANDA Backend listening on 127.0.0.1:0',
  auditStartup: '[Audit] Retention cleanup (startup) completed',
  heartbeat: '[Heartbeat] {"event":"heartbeat_started"',
};

interface Expected {
  intervals: string[];
  listenChannels: string[];
  consumedQueues: string[];
  httpListen: number;
  inlineEmailTimer: boolean;
  logs: string[];
  absentLogs: string[];
}

function expectBoot(name: string, booted: Promise<Boot>, expected: Expected): void {
  test(name, { timeout: BOOT_DEADLINE_MS + 10_000 }, async () => {
    const { code, ready, seen, output } = await booted;
    const context = `\n--- child output ---\n${output}`;
    assert.equal(ready, true, `PM2 "ready" was never signalled${context}`);
    assert.equal(code, 0, `exit code${context}`);
    assert.deepEqual(seen.intervals, [...expected.intervals].sort(), `timers left running${context}`);
    assert.deepEqual(seen.listenChannels, expected.listenChannels, 'LISTEN channels');
    assert.deepEqual(seen.assertedQueues, ALL_QUEUES, 'every role asserts every queue');
    assert.deepEqual(seen.consumedQueues, expected.consumedQueues, 'queue consumers');
    assert.equal(seen.httpListen, expected.httpListen, 'HTTP listen');
    assert.equal(seen.timeoutFiles.includes('modules/assignments/email-outbox.service.ts'), expected.inlineEmailTimer, 'inline email outbox first tick');
    assert.deepEqual(seen.connections, [], 'no TCP connection attempt');
    for (const line of expected.logs) assert.ok(output.includes(line), `missing log line: ${line}${context}`);
    for (const line of expected.absentLogs) assert.ok(!output.includes(line), `unexpected log line: ${line}${context}`);
  });
}

// Boots run two at a time (each compiles the whole app through tsx).
const queue: Array<() => void> = [];
let running = 0;
function limited(start: () => Promise<Boot>): Promise<Boot> {
  return new Promise((resolve, reject) => {
    const run = () => {
      running += 1;
      start().then(resolve, reject).finally(() => {
        running -= 1;
        queue.shift()?.();
      });
    };
    if (running < 2) run();
    else queue.push(run);
  });
}

const INLINE_OFF = { EMAIL_OUTBOX_INLINE_WORKER_ENABLED: 'false' };
const boots = {
  all: limited(() => boot('all')),
  api: limited(() => boot('api')),
  background: limited(() => boot('background')),
  allInlineOff: limited(() => boot('all', INLINE_OFF)),
  apiInlineOff: limited(() => boot('api', INLINE_OFF)),
  backgroundInlineOff: limited(() => boot('background', INLINE_OFF)),
};

expectBoot('all (defaults): HTTP and every background start in one process', boots.all, {
  intervals: [...IN_MEMORY_SWEEPERS, ...QUEUE_WORKERS, ...MAINTENANCE, ...INLINE_EMAIL_OUTBOX, ...HEARTBEAT],
  listenChannels: [],
  consumedQueues: [...CONSUMED_QUEUES, 'LANDA_EMAIL_OUTBOX'],
  httpListen: 1,
  inlineEmailTimer: true,
  logs: [LOG.inlineEmailStarted, LOG.workersStarted, LOG.listening, LOG.auditStartup, LOG.heartbeat, '[Process] role=all api_instances=1'],
  absentLogs: [LOG.publishingOnly, LOG.clusterBus, LOG.inlineEmailElsewhere, LOG.inlineEmailDisabled],
});

expectBoot('api (defaults): HTTP, cluster bus and the in-memory sweepers; no consumer or background timer', boots.api, {
  intervals: [...IN_MEMORY_SWEEPERS, ...CLUSTER_BUS],
  listenChannels: ['landa_cluster_bus'],
  consumedQueues: [],
  httpListen: 1,
  inlineEmailTimer: false,
  logs: [LOG.inlineEmailElsewhere, LOG.publishingOnly, LOG.clusterBus, LOG.listening, '[Process] role=api api_instances=2'],
  absentLogs: [LOG.inlineEmailStarted, LOG.workersStarted, LOG.auditStartup, LOG.inlineEmailDisabled, LOG.heartbeat],
});

expectBoot('background (defaults): consumers, pollers, maintenance and the inline email outbox; never listens', boots.background, {
  intervals: [
    ...IN_MEMORY_SWEEPERS,
    ...CLUSTER_BUS,
    ...QUEUE_WORKERS,
    ...MAINTENANCE,
    ...COURSE_ASSET_TEMP_SWEEP,
    ...INLINE_EMAIL_OUTBOX,
    ...HEARTBEAT,
  ],
  listenChannels: ['landa_cluster_bus'],
  consumedQueues: [...CONSUMED_QUEUES, 'LANDA_EMAIL_OUTBOX'],
  httpListen: 0,
  inlineEmailTimer: true,
  logs: [LOG.inlineEmailStarted, LOG.workersStarted, LOG.clusterBus, LOG.auditStartup, LOG.heartbeat, '[Process] role=background api_instances=2'],
  absentLogs: [LOG.listening, LOG.publishingOnly, LOG.inlineEmailElsewhere, LOG.inlineEmailDisabled],
});

expectBoot('all, inline email outbox off (production flag)', boots.allInlineOff, {
  intervals: [...IN_MEMORY_SWEEPERS, ...QUEUE_WORKERS, ...MAINTENANCE, ...HEARTBEAT],
  listenChannels: [],
  consumedQueues: CONSUMED_QUEUES,
  httpListen: 1,
  inlineEmailTimer: false,
  logs: [LOG.inlineEmailDisabled, LOG.workersStarted, LOG.listening, LOG.auditStartup, LOG.heartbeat],
  absentLogs: [LOG.inlineEmailStarted, LOG.inlineEmailElsewhere, LOG.publishingOnly, LOG.clusterBus],
});

expectBoot('api, inline email outbox off (production flag)', boots.apiInlineOff, {
  intervals: [...IN_MEMORY_SWEEPERS, ...CLUSTER_BUS],
  listenChannels: ['landa_cluster_bus'],
  consumedQueues: [],
  httpListen: 1,
  inlineEmailTimer: false,
  logs: [LOG.inlineEmailDisabled, LOG.publishingOnly, LOG.clusterBus, LOG.listening],
  absentLogs: [LOG.inlineEmailStarted, LOG.inlineEmailElsewhere, LOG.workersStarted, LOG.auditStartup, LOG.heartbeat],
});

expectBoot('background, inline email outbox off (production flag)', boots.backgroundInlineOff, {
  intervals: [...IN_MEMORY_SWEEPERS, ...CLUSTER_BUS, ...QUEUE_WORKERS, ...MAINTENANCE, ...COURSE_ASSET_TEMP_SWEEP, ...HEARTBEAT],
  listenChannels: ['landa_cluster_bus'],
  consumedQueues: CONSUMED_QUEUES,
  httpListen: 0,
  inlineEmailTimer: false,
  logs: [LOG.inlineEmailDisabled, LOG.workersStarted, LOG.clusterBus, LOG.auditStartup, LOG.heartbeat],
  absentLogs: [LOG.listening, LOG.inlineEmailStarted, LOG.inlineEmailElsewhere, LOG.publishingOnly],
});

// ── The dedicated worker entry points (src/workers/*.worker.ts), default flags ──
// They signal no "ready" here (disabled, or still starting): the harness ends
// each one after WORKER_RUN_MS and reports whether it was still running.
const WORKER_RUN_MS = 2_500;

interface ExpectedWorker {
  intervals: string[];
  consumedQueues: string[];
  stillRunning: boolean;
  logs: string[];
}

function expectWorker(worker: string, expected: ExpectedWorker): void {
  const booted = limited(() =>
    boot('background', { BOOT_HARNESS_EXIT_AFTER_MS: String(WORKER_RUN_MS) }, path.join(root, 'src', 'workers', `${worker}.worker.ts`)),
  );
  test(`worker ${worker}`, { timeout: BOOT_DEADLINE_MS + 10_000 }, async () => {
    const { code, seen, output } = await booted;
    const context = `\n--- child output ---\n${output}`;
    assert.equal(code, 0, `exit code${context}`);
    assert.equal(seen.forcedExit, expected.stillRunning, `still running after ${WORKER_RUN_MS} ms${context}`);
    assert.deepEqual(seen.intervals, [...expected.intervals].sort(), `timers left running${context}`);
    assert.deepEqual(seen.consumedQueues, expected.consumedQueues, 'queue consumers');
    assert.deepEqual(seen.listenChannels, [], 'LISTEN channels');
    assert.equal(seen.httpListen, 0, 'HTTP listen');
    assert.deepEqual(seen.connections, [], 'no TCP connection attempt');
    for (const line of expected.logs) assert.ok(output.includes(line), `missing log line: ${line}${context}`);
  });
}

expectWorker('course-outline-transfer', {
  intervals: [],
  consumedQueues: [],
  stillRunning: true,
  logs: ['[CourseOutlineTransferWorker] Disabled by COURSE_OUTLINE_TRANSFER_WORKER_ENABLED=false.'],
});
expectWorker('email-outbox', {
  intervals: [...INLINE_EMAIL_OUTBOX, ...HEARTBEAT],
  consumedQueues: ['LANDA_EMAIL_OUTBOX'],
  stillRunning: true,
  logs: ['[EmailOutbox] Worker started source=dedicated', '[EmailOutboxWorker] Running environment=test', LOG.heartbeat],
});
// Disabled by default; it imports the sign-out blacklist and chat modules, whose sweepers keep it running.
expectWorker('lesson-author-orchestration-v2', {
  intervals: [
    'middleware/authenticate.ts every 300000 ms',
    'modules/ai-chatbot/chat.service.ts every 300000 ms',
    'modules/ai-chatbot/chat.service.ts every 600000 ms',
  ],
  consumedQueues: [],
  stillRunning: true,
  logs: ['[LessonAuthorOrchestrationV2] Disabled; no queue or database runtime was started.'],
});
expectWorker('news-assets-cleanup', {
  intervals: HEARTBEAT,
  consumedQueues: [],
  stillRunning: true,
  logs: [LOG.heartbeat],
});
expectWorker('tenant-data-quota', {
  intervals: [],
  consumedQueues: [],
  stillRunning: true,
  logs: ['[TenantDataQuotaWorker] Disabled by TENANT_DATA_QUOTA_WORKER_ENABLED=false.'],
});
