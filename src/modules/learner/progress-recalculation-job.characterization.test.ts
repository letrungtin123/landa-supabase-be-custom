import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

// Characterization of the course progress recalculation job: scheduling, the
// claim, the batch loop (cursor, finish, rerun, pause and wake-up), the
// retry / failed marks, the stale-job poller and the RabbitMQ worker wiring
// (consumer options, message handling, retries, max retries, poll interval).
// Every event of a case, in order, is digested into a golden file written by
// the code before the job moved onto src/platform/job-runner: each SQL
// statement (exact text, CRLF read as LF, and its parameters),
// each RabbitMQ publish / ack / nack, each Redis cache bump, each log line
// and the result. A pg double answers every statement per case; amqplib and
// Redis are in-memory doubles. Rewrite the golden file only for an intended
// change:
//   PROGRESS_RECALC_GOLDEN_WRITE=1 npx tsx --test src/modules/learner/progress-recalculation-job.characterization.test.ts
// PROGRESS_RECALC_FULL_OUT=<file> also writes every outcome in full.

process.env.REDIS_URL = 'redis://127.0.0.1:1';
process.env.RABBITMQ_RETRY_BASE_DELAY_MS = '0';
process.env.COURSE_PROGRESS_RECALC_BATCH_SIZE = '4';
process.env.COURSE_PROGRESS_RECALC_MAX_BATCHES_PER_TICK = '3';
process.env.COURSE_PROGRESS_RECALC_POLL_INTERVAL_MS = '60000';
process.env.COURSE_PROGRESS_RECALC_RABBIT_PREFETCH = '2';

const pg = await import('pg');
const amqp = (await import('amqplib')).default;
const redis = await import('../../config/redis.js');
const { pool } = await import('../../config/database.js');
const { env } = await import('../../config/env.js');
const rabbit = await import('../../config/rabbitmq/index.js');
const job = await import('./progress-recalculation-job.service.js');
const worker = await import('./progress-recalculation.worker.js');

const GOLDEN_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'progress-recalculation-job.characterization.golden.json',
);
const WRITE_GOLDEN = process.env.PROGRESS_RECALC_GOLDEN_WRITE === '1';
const FULL_OUT = process.env.PROGRESS_RECALC_FULL_OUT?.trim() || '';

const TENANT = '11111111-1111-4111-8111-111111111111';
const COURSE = 'course-v1:Landa+P1+2026';
const JOB = 'c0000000-0000-4000-8000-000000000001';
const JOB_2 = 'c0000000-0000-4000-8000-000000000002';

// ── Doubles: one event log per case ──

type Event = Record<string, unknown>;
let events: Event[] = [];
let publishFails = false;
let deliver: ((msg: unknown) => Promise<void>) | null = null;

function describe(value: unknown): unknown {
  if (value instanceof Error) return { error: value.message, code: (value as { code?: string }).code ?? null };
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  return JSON.parse(JSON.stringify(value ?? null));
}

const channel = {
  sendToQueue(queue: string, content: Buffer, options: unknown, callback: (error: Error | null) => void) {
    events.push({ publish: queue, payload: content.toString(), options: describe(options) });
    callback(publishFails ? new Error('broker refused') : null);
    return true;
  },
  async prefetch(count: number) {
    events.push({ prefetch: count });
  },
  async consume(queue: string, handler: (msg: unknown) => Promise<void>) {
    events.push({ consume: queue });
    deliver = handler;
    return { consumerTag: `tag-${queue}` };
  },
  ack(msg: { content: Buffer }) {
    events.push({ ack: msg.content.toString() });
  },
  nack(msg: { content: Buffer }, allUpTo: boolean, requeue: boolean) {
    events.push({ nack: msg.content.toString(), allUpTo, requeue });
  },
  async cancel() {},
  async close() {},
  async assertQueue() {},
};
const connection = {
  async createConfirmChannel() {
    return channel;
  },
  on() {},
  async close() {},
};
const realConnect = amqp.connect;
(amqp as { connect: unknown }).connect = async () => connection;
for (const method of ['log', 'info', 'warn', 'error'] as const) {
  const original = console[method];
  console[method] = () => undefined;
  test.after(() => {
    console[method] = original;
  });
}
await rabbit.connectRabbitMQ('amqp://double');
(amqp as { connect: unknown }).connect = realConnect;

redis.installRedisClient({
  isOpen: true,
  isReady: true,
  async incr(key: string) {
    events.push({ redisIncr: key });
    return 1;
  },
} as unknown as Parameters<typeof redis.installRedisClient>[0]);

test.after(async () => {
  redis.installRedisClient(null);
  await rabbit.closeRabbitMQ();
  await pool.end();
});

type Answer = (text: string) => { rows: unknown[]; rowCount?: number } | undefined;

function install(t: TestContext, answer: Answer): void {
  const handle = async (config: string | { text: string; values?: unknown[] }, values: unknown[] = []) => {
    const text = typeof config === 'string' ? config : config.text;
    const params = typeof config === 'string' ? values : (config.values ?? []);
    // Exact text except line endings: a Windows checkout (core.autocrlf) has CRLF in the source.
    events.push({ sql: text.replace(/\r\n/g, '\n'), params: describe(params) });
    const answered = answer(text) ?? { rows: [] };
    return { rows: answered.rows, rowCount: answered.rowCount ?? answered.rows.length };
  };
  t.mock.method(pg.default.Pool.prototype, 'query', handle);
  t.mock.method(pg.default.Pool.prototype, 'connect', async () => ({ query: handle, release() {} }));
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    t.mock.method(console, level, (...args: unknown[]) => {
      events.push({ [level]: args.map(describe) });
    });
  }
}

// ── Answers ──

const INSERT = /INSERT INTO course_progress_recalculation_jobs/;
const CLAIM = /SET\s+status = 'running',\s+attempts = attempts \+ 1/;
const BATCH = /WITH RECURSIVE target_enrollments/;
const FINISH = /status = CASE WHEN rerun_requested THEN 'queued' ELSE 'succeeded' END/;
const REQUEUE_STALE = /updated_at < now\(\) - interval '10 minutes'/;
const SELECT_QUEUED = /SELECT id\s+FROM course_progress_recalculation_jobs\s+WHERE status = 'queued'/;

const CLAIMED = { id: JOB, tenant_id: TENANT, course_id: COURSE, last_enrollment_id: null, processed_count: 0 };

function sqlError(message: string, code?: string): Error {
  return Object.assign(new Error(message), code ? { code } : {});
}

/** Answers by pattern; a function value runs per call (for sequences); an Error value is thrown. */
function answers(table: Array<[RegExp, unknown[] | Error | (() => unknown[] | Error)]>): Answer {
  return text => {
    for (const [pattern, value] of table) {
      if (!pattern.test(text)) continue;
      const resolved = typeof value === 'function' ? value() : value;
      if (resolved instanceof Error) throw resolved;
      // A fresh copy per statement: the job mutates the row it claimed.
      return { rows: structuredClone(resolved) };
    }
    return undefined;
  };
}

function batches(...rows: Array<[number, string | null]>): () => unknown[] {
  let index = 0;
  return () => {
    const [processed, last] = rows[Math.min(index, rows.length - 1)];
    index += 1;
    return [{ processed, last_enrollment_id: last }];
  };
}

const message = (body: unknown, retries?: number) => ({
  content: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
  properties: { headers: retries === undefined ? {} : { 'x-retries': retries } },
});

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise(resolve => setImmediate(resolve));
}

// ── Cases ──

interface Case {
  name: string;
  answer: Answer;
  run: (t: TestContext) => Promise<unknown>;
}
const cases: Case[] = [];
const add = (name: string, answer: Answer, run: (t: TestContext) => Promise<unknown>) => cases.push({ name, answer, run });

const request = { tenantId: TENANT, courseId: COURSE, reason: 'enrollment_created', assignmentId: null };

add('schedule enqueues and wakes', answers([[INSERT, [{ id: JOB }]]]), () => job.scheduleCourseProgressRecalculation(request));
add('schedule with assignment', answers([[INSERT, [{ id: JOB }]]]), () =>
  job.scheduleCourseProgressRecalculation({ tenantId: TENANT, courseId: COURSE, reason: 'assignment_deleted', assignmentId: 'a-1' }),
);
add('schedule without assignment field', answers([[INSERT, [{ id: JOB }]]]), () =>
  job.scheduleCourseProgressRecalculation({ tenantId: TENANT, courseId: COURSE, reason: 'bulk' }),
);
add('schedule returns no row', answers([[INSERT, []]]), () => job.scheduleCourseProgressRecalculation(request));
add('schedule job table missing', answers([[INSERT, sqlError('relation does not exist', '42P01')]]), () =>
  job.scheduleCourseProgressRecalculation(request),
);
add('schedule job table named in message', answers([[INSERT, sqlError('course_progress_recalculation_jobs is gone')]]), () =>
  job.scheduleCourseProgressRecalculation(request),
);
add('schedule enqueue fails', answers([[INSERT, sqlError('deadlock detected', '40P01')]]), () =>
  job.scheduleCourseProgressRecalculation(request),
);
add('schedule wake-up publish fails', answers([[INSERT, [{ id: JOB }]]]), async () => {
  publishFails = true;
  await job.scheduleCourseProgressRecalculation(request);
});
add('wake publishes the job id', answers([]), () => job.wakeCourseProgressRecalculationJob(JOB));

add('run not claimed', answers([[CLAIM, []]]), () => job.runCourseProgressRecalculationJob(JOB));
add('run claim table missing', answers([[CLAIM, sqlError('relation does not exist', '42P01')]]), () =>
  job.runCourseProgressRecalculationJob(JOB),
);
add('run claim fails', answers([[CLAIM, sqlError('connection reset')]]), () => job.runCourseProgressRecalculationJob(JOB));
add('run empty course finishes', answers([[CLAIM, [CLAIMED]], [BATCH, batches([0, null])], [FINISH, [{ status: 'succeeded' }]]]), () =>
  job.runCourseProgressRecalculationJob(JOB),
);
add('run empty course rerun requested', answers([[CLAIM, [CLAIMED]], [BATCH, batches([0, null])], [FINISH, [{ status: 'queued' }]]]), () =>
  job.runCourseProgressRecalculationJob(JOB),
);
add('run finish matches no row', answers([[CLAIM, [CLAIMED]], [BATCH, batches([0, null])], [FINISH, []]]), () =>
  job.runCourseProgressRecalculationJob(JOB),
);
add('run batch without cursor finishes', answers([[CLAIM, [CLAIMED]], [BATCH, batches([2, null])], [FINISH, [{ status: 'succeeded' }]]]), () =>
  job.runCourseProgressRecalculationJob(JOB),
);
add('run one partial batch', answers([[CLAIM, [CLAIMED]], [BATCH, batches([3, 'e-3'])], [FINISH, [{ status: 'succeeded' }]]]), () =>
  job.runCourseProgressRecalculationJob(JOB),
);
add('run partial batch rerun requested', answers([[CLAIM, [CLAIMED]], [BATCH, batches([3, 'e-3'])], [FINISH, [{ status: 'queued' }]]]), () =>
  job.runCourseProgressRecalculationJob(JOB),
);
add(
  'run resumes from a cursor',
  answers([
    [CLAIM, [{ ...CLAIMED, last_enrollment_id: 'e-8', processed_count: 8 }]],
    [BATCH, batches([4, 'e-12'], [1, 'e-13'])],
    [FINISH, [{ status: 'succeeded' }]],
  ]),
  () => job.runCourseProgressRecalculationJob(JOB),
);
add('run full batch then empty', answers([[CLAIM, [CLAIMED]], [BATCH, batches([4, 'e-4'], [0, null])], [FINISH, [{ status: 'succeeded' }]]]), () =>
  job.runCourseProgressRecalculationJob(JOB),
);
add('run full batches yield the tick', answers([[CLAIM, [CLAIMED]], [BATCH, batches([4, 'e-4'], [4, 'e-8'], [4, 'e-12'], [4, 'e-16'])]]), () =>
  job.runCourseProgressRecalculationJob(JOB),
);
add('run batch query fails', answers([[CLAIM, [CLAIMED]], [BATCH, sqlError('statement timeout', '57014')]]), () =>
  job.runCourseProgressRecalculationJob(JOB),
);
add('run without a tick budget pauses', answers([[CLAIM, [CLAIMED]]]), async () => {
  const saved = env.COURSE_PROGRESS_RECALC_MAX_BATCHES_PER_TICK;
  (env as { COURSE_PROGRESS_RECALC_MAX_BATCHES_PER_TICK: number }).COURSE_PROGRESS_RECALC_MAX_BATCHES_PER_TICK = 0;
  try {
    await job.runCourseProgressRecalculationJob(JOB);
  } finally {
    (env as { COURSE_PROGRESS_RECALC_MAX_BATCHES_PER_TICK: number }).COURSE_PROGRESS_RECALC_MAX_BATCHES_PER_TICK = saved;
  }
});

add('mark retryable truncates the error', answers([]), () =>
  job.markCourseProgressRecalculationJobRetryable(JOB, new Error(`x${'é'.repeat(2100)}`)),
);
add('mark failed with a non-error value', answers([]), () => job.markCourseProgressRecalculationJobFailed(JOB, { reason: 'odd' }));

add('requeue wakes queued jobs', answers([[SELECT_QUEUED, [{ id: JOB }, { id: JOB_2 }]]]), () =>
  job.requeuePendingCourseProgressRecalculationJobs(),
);
add('requeue with a limit', answers([[SELECT_QUEUED, []]]), () => job.requeuePendingCourseProgressRecalculationJobs(5));
add('requeue job table missing', answers([[REQUEUE_STALE, sqlError('relation does not exist', '42P01')]]), () =>
  job.requeuePendingCourseProgressRecalculationJobs(),
);
add('requeue fails', answers([[SELECT_QUEUED, sqlError('connection reset')]]), () => job.requeuePendingCourseProgressRecalculationJobs());

async function startWorker(t: TestContext): Promise<void> {
  t.mock.timers.enable({ apis: ['setInterval'] });
  await worker.startCourseProgressRecalculationWorker();
}

add('worker start', answers([[SELECT_QUEUED, [{ id: JOB }]]]), async t => {
  await startWorker(t);
});
add('worker disabled', answers([]), async t => {
  (env as { COURSE_PROGRESS_RECALC_WORKER_ENABLED: boolean }).COURSE_PROGRESS_RECALC_WORKER_ENABLED = false;
  try {
    await startWorker(t);
  } finally {
    (env as { COURSE_PROGRESS_RECALC_WORKER_ENABLED: boolean }).COURSE_PROGRESS_RECALC_WORKER_ENABLED = true;
  }
});
add('worker poller ticks on its interval', answers([[SELECT_QUEUED, [{ id: JOB_2 }]]]), async t => {
  await startWorker(t);
  events.push({ mark: 'started' });
  t.mock.timers.tick(59_999);
  await settle();
  events.push({ mark: 'tick 59999' });
  t.mock.timers.tick(1);
  await settle();
  events.push({ mark: 'tick 60000' });
});
add('worker poller failure is logged', answers([[SELECT_QUEUED, [{ id: JOB }]]]), async t => {
  await startWorker(t);
  events.push({ mark: 'started' });
  t.mock.method(pg.default.Pool.prototype, 'query', async () => {
    events.push({ sql: 'poller query' });
    throw sqlError('pool exhausted');
  });
  t.mock.timers.tick(60_000);
  await settle();
});
add(
  'worker message runs the job',
  answers([[CLAIM, [CLAIMED]], [BATCH, batches([1, 'e-1'])], [FINISH, [{ status: 'succeeded' }]]]),
  async t => {
    await startWorker(t);
    events.push({ mark: 'deliver' });
    await deliver!(message({ jobId: `  ${JOB}  ` }));
  },
);
add('worker message without job id', answers([]), async t => {
  await startWorker(t);
  events.push({ mark: 'deliver' });
  await deliver!(message({ jobId: '   ' }));
  await deliver!(message({ other: JOB }));
  await deliver!(message({ jobId: 42 }));
});
add('worker message invalid json', answers([]), async t => {
  await startWorker(t);
  events.push({ mark: 'deliver' });
  await deliver!(message('{not json'));
});
add('worker job fails and is retried', answers([[CLAIM, [CLAIMED]], [BATCH, sqlError('statement timeout', '57014')]]), async t => {
  await startWorker(t);
  events.push({ mark: 'deliver' });
  await deliver!(message({ jobId: JOB }, 1));
});
add('worker job fails on the last retry', answers([[CLAIM, [CLAIMED]], [BATCH, sqlError('statement timeout', '57014')]]), async t => {
  await startWorker(t);
  events.push({ mark: 'deliver' });
  await deliver!(message({ jobId: JOB }, 3));
});
add('worker last retry without job id', answers([]), async t => {
  await startWorker(t);
  events.push({ mark: 'deliver' });
  await deliver!(message({ jobId: '' }, 3));
});

// ── Runner ──

function digest(outcome: unknown): string {
  return createHash('sha256').update(JSON.stringify(outcome)).digest('hex');
}

const golden: Record<string, string> = existsSync(GOLDEN_PATH)
  ? (JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as Record<string, string>)
  : {};
const written: Record<string, string> = {};
const full: Record<string, unknown> = {};

test('the case names are unique', () => {
  assert.equal(new Set(cases.map(item => item.name)).size, cases.length);
});

for (const item of cases) {
  test(`progress recalculation job characterization: ${item.name}`, async t => {
    events = [];
    publishFails = false;
    deliver = null;
    install(t, item.answer);
    let result: unknown;
    try {
      result = describe((await item.run(t)) ?? null);
    } catch (error) {
      result = { thrown: describe(error) };
    }
    const outcome = { events, result };
    const value = digest(outcome);
    if (FULL_OUT) full[item.name] = outcome;
    if (WRITE_GOLDEN) {
      written[item.name] = value;
      return;
    }
    assert.ok(golden[item.name], `no golden entry for "${item.name}"`);
    assert.equal(value, golden[item.name], `outcome changed:\n${JSON.stringify(outcome).slice(0, 4000)}`);
  });
}

test('every golden entry still has its case', () => {
  if (FULL_OUT) writeFileSync(FULL_OUT, `${JSON.stringify(full, null, 1)}\n`);
  if (WRITE_GOLDEN) {
    const sorted = Object.fromEntries(
      Object.keys(written)
        .sort()
        .map(name => [name, written[name]]),
    );
    writeFileSync(GOLDEN_PATH, `${JSON.stringify(sorted, null, 1)}\n`);
    return;
  }
  assert.deepStrictEqual(Object.keys(golden).sort(), cases.map(item => item.name).sort());
});
