import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import pg from 'pg';

// The poll loop of the course outline transfer worker
// (course-outline-transfer.worker.ts) driving the real job service on a
// database double, with a fake setTimeout. A claim that throws, and a failed
// attempt whose retry mark throws (the database is unreachable), are logged
// with the error kind only and the loop polls again after the poll interval
// instead of ending the process; stop() ends the wait at once. An error
// outside the job turn still ends the loop, so the entry point still exits
// on it.

process.env.REDIS_URL = 'redis://127.0.0.1:1';

const { createCourseOutlineTransferWorkerLoop } = await import('./course-outline-transfer.worker.js');
const transfer = await import('./course-outline-transfer.service.js');

const POLL_MS = 10_000;
const TENANT = '11111111-1111-4111-8111-111111111111';
const JOB = 'b0000000-0000-4000-8000-000000000001';
const LEASE = 'b1000000-0000-4000-8000-000000000001';
// A queued legacy move job fails terminally before any other statement.
const MOVE_JOB = {
  id: JOB,
  tenant_id: TENANT,
  operation: 'move',
  status: 'running',
  attempts: 1,
  max_attempts: 5,
  lease_token: LEASE,
};

const SCHEMA = /to_regclass\('public.course_outline_transfer_jobs'\)::text AS jobs/;
const CLAIM = /SET status = 'running', attempts = attempts \+ 1, lease_token = \$1::uuid/;
const MARK = /SET status = CASE WHEN \$4::boolean OR attempts >= max_attempts THEN 'failed' ELSE 'queued' END/;
const SCHEMA_READY = [{ jobs: 'a', assets: 'b', maps: 'c', rewrite: 'd' }];

const CLAIM_LOG = (kind: string) =>
  `[CourseOutlineTransferWorker] Could not claim a transfer job or record its failed attempt (${kind}); trying again in ${POLL_MS} ms.`;

interface Statement {
  sql: string;
  params: unknown[];
}

/** Pool queries answered by `answer` (rows, or an Error to throw); no client checkout is expected. */
function installDatabase(t: TestContext, answer: (sql: string) => unknown[] | Error | undefined): Statement[] {
  const statements: Statement[] = [];
  t.mock.method(pg.Pool.prototype, 'query', async function (this: unknown, text: string, params: unknown[] = []) {
    statements.push({ sql: text, params });
    const answered = answer(text);
    if (answered instanceof Error) throw answered;
    const rows = answered ?? [];
    return { rows, rowCount: rows.length };
  });
  t.mock.method(pg.Pool.prototype, 'connect', async function (this: unknown) {
    throw new Error('unexpected client checkout');
  });
  return statements;
}

function captureConsole(t: TestContext): Record<'log' | 'warn' | 'error', unknown[][]> {
  const logs: Record<'log' | 'warn' | 'error', unknown[][]> = { log: [], warn: [], error: [] };
  for (const level of ['log', 'warn', 'error'] as const) {
    t.mock.method(console, level, (...args: unknown[]) => {
      logs[level].push(args);
    });
  }
  return logs;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 25; i += 1) await new Promise(resolve => setImmediate(resolve));
}

/** Which statement each query was, in order. */
function steps(statements: Statement[]): string[] {
  return statements.map(statement => {
    if (SCHEMA.test(statement.sql)) return 'schema';
    if (CLAIM.test(statement.sql)) return 'claim';
    if (MARK.test(statement.sql)) return `mark ${statement.params[0]}`;
    return statement.sql.slice(0, 40);
  });
}

/** Runs the loop on the real job service; `ended` turns true once run() has resolved. */
function startLoop(t: TestContext, answer: (sql: string) => unknown[] | Error | undefined) {
  const statements = installDatabase(t, answer);
  const logs = captureConsole(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const loop = createCourseOutlineTransferWorkerLoop({
    pollIntervalMs: POLL_MS,
    isSchemaReady: transfer.isCourseOutlineTransferSchemaReady,
    processNextJob: transfer.processNextCourseOutlineTransferJob,
  });
  const state = { ended: false };
  const running = loop.run().then(() => {
    state.ended = true;
  });
  return { statements, logs, loop, state, running };
}

/** stop() ends the wait without the clock moving, and no turn follows. */
async function expectPromptStop(started: ReturnType<typeof startLoop>, t: TestContext): Promise<void> {
  assert.equal(started.state.ended, false);
  started.loop.stop();
  await settle();
  assert.equal(started.state.ended, true);
  const statementCount = started.statements.length;
  t.mock.timers.tick(POLL_MS * 3);
  await settle();
  assert.equal(started.statements.length, statementCount);
  await started.running;
}

test('a claim that throws is logged and the loop claims again after the poll interval', async t => {
  let claims = 0;
  const started = startLoop(t, sql => {
    if (SCHEMA.test(sql)) return SCHEMA_READY;
    if (CLAIM.test(sql)) {
      claims += 1;
      if (claims > 1) return [];
      return Object.assign(new Error('connect ECONNREFUSED 10.9.8.7:5432 for user landa-secret-user'), { code: 'ECONNREFUSED' });
    }
    return undefined;
  });

  await settle();
  assert.deepEqual(steps(started.statements), ['schema', 'claim']);
  assert.deepEqual(started.logs.error, [[CLAIM_LOG('Error:ECONNREFUSED')]]);
  t.mock.timers.tick(POLL_MS - 1);
  await settle();
  assert.equal(claims, 1, 'no new claim before the poll interval has passed');
  t.mock.timers.tick(1);
  await settle();
  assert.deepEqual(steps(started.statements), ['schema', 'claim', 'schema', 'claim']);
  assert.equal(started.logs.error.length, 1, 'a turn with nothing due logs nothing');

  await expectPromptStop(started, t);
  assert.deepEqual(started.logs.warn, []);
  assert.deepEqual(started.logs.log, []);
  const logged = JSON.stringify(started.logs);
  for (const detail of ['10.9.8.7', 'landa-secret-user']) assert.ok(!logged.includes(detail), `${detail} is not logged`);
});

test('a failed attempt whose retry mark throws is logged and the loop claims again after the poll interval', async t => {
  let claims = 0;
  const started = startLoop(t, sql => {
    if (SCHEMA.test(sql)) return SCHEMA_READY;
    if (CLAIM.test(sql)) {
      claims += 1;
      return claims === 1 ? [MOVE_JOB] : [];
    }
    if (MARK.test(sql)) return new Error('Connection terminated unexpectedly while saving admin.nesso');
    return undefined;
  });

  await settle();
  // The job is left as claimed (running, with its lease) for a later claim once the lease expires.
  assert.deepEqual(steps(started.statements), ['schema', 'claim', `mark ${JOB}`]);
  assert.deepEqual(started.logs.error, [[CLAIM_LOG('Error')]]);
  t.mock.timers.tick(POLL_MS - 1);
  await settle();
  assert.equal(claims, 1, 'no new claim before the poll interval has passed');
  t.mock.timers.tick(1);
  await settle();
  assert.deepEqual(steps(started.statements), ['schema', 'claim', `mark ${JOB}`, 'schema', 'claim']);
  assert.equal(started.logs.error.length, 1, 'a turn with nothing due logs nothing');

  await expectPromptStop(started, t);
  assert.deepEqual(started.logs.warn, []);
  assert.deepEqual(started.logs.log, []);
  const logged = JSON.stringify(started.logs);
  for (const detail of ['terminated', 'admin.nesso']) assert.ok(!logged.includes(detail), `${detail} is not logged`);
});

test('stop() during the wait after a failed turn ends the loop at once', async t => {
  const started = startLoop(t, sql => {
    if (SCHEMA.test(sql)) return SCHEMA_READY;
    if (CLAIM.test(sql)) return Object.assign(new Error('timeout exceeded when trying to connect'), { code: 'ETIMEDOUT' });
    return undefined;
  });
  await settle();
  assert.deepEqual(steps(started.statements), ['schema', 'claim']);
  assert.deepEqual(started.logs.error, [[CLAIM_LOG('Error:ETIMEDOUT')]]);
  await expectPromptStop(started, t);
});

test('an error outside the job turn still ends the loop', async t => {
  const logs = captureConsole(t);
  let turns = 0;
  const loop = createCourseOutlineTransferWorkerLoop({
    pollIntervalMs: POLL_MS,
    isSchemaReady: async () => {
      throw new Error('schema check broke');
    },
    processNextJob: async () => {
      turns += 1;
      return false;
    },
  });
  await assert.rejects(loop.run(), /schema check broke/);
  assert.equal(turns, 0);
  assert.deepEqual(logs.error, []);
});
