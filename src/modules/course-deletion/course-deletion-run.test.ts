import assert from 'node:assert/strict';
import test, { after, type TestContext } from 'node:test';
import {
  answers,
  callHandler,
  failWhen,
  installDb,
  rowsWhen,
  type Answer,
} from '../../test-support/sql-characterization.js';

// A course deletion run against the pg double (no database, RabbitMQ, Redis
// or network): a failed lease renewal between purge steps does not stop the
// purge, a failed purge statement still does, and the tenant status API
// shows a plain message instead of the operator diagnostic in last_error.

process.env.TZ = 'Asia/Ho_Chi_Minh';
process.env.REDIS_URL = 'redis://127.0.0.1:1';

globalThis.fetch = (async () =>
  new globalThis.Response(JSON.stringify({ id: 'landa-storage', name: 'landa-storage' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as typeof fetch;

const redis = await import('../../config/redis.js');
const { pool } = await import('../../config/database.js');
const service = await import('./course-deletion.service.js');
const controller = await import('../courses/courses.controller.js');
const { DELETION_JOB_PUBLIC_ERRORS } = await import('./course-deletion.logic.js');

redis.installRedisClient(null);
after(async () => {
  await pool.end();
});

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = 'a0000000-0000-4000-8000-000000000001';
const JOB = 'b0000000-0000-4000-8000-000000000001';
const COURSE = 'course-v1:nesso+a01+2026';

/** Every column the statements of a course job read; the manifest is already complete. */
const ROW = {
  id: JOB,
  tenant_id: TENANT,
  course_id: COURSE,
  root_block_id: null,
  target_type: 'course',
  status: 'running',
  attempts: 1,
  is_terminal: false,
  manifest_completed_at: new Date('2026-10-02T00:00:00.000Z'),
  warnings: null,
  exists: false,
  storage_path: `${TENANT}/courses/${COURSE}/a.png`,
  url: null,
  deleted: 0,
  last_id: null,
  requested_at: new Date('2026-10-01T00:00:00.000Z'),
  started_at: null,
  finished_at: null,
  next_attempt_at: null,
  last_error: null,
  stats: {},
  data_limit_bytes: null,
  database_used_bytes: '0',
  storage_used_bytes: '0',
  storage_reserved_bytes: '0',
  state: 'observing',
  size_bytes: '0',
};

const LEASE_RENEWAL = /SET lease_expires_at = now\(\) \+ \(\$2::int \* interval '1 second'\), updated_at = now\(\)/;

/** Batched statements (LIMIT $n) answer one row the first time, then none, so every loop ends. */
function oneBatch(): Answer {
  const seen = new Set<string>();
  return text => {
    if (!/LIMIT \$\d/.test(text)) return undefined;
    if (seen.has(text)) return { rows: [] };
    seen.add(text);
    return undefined;
  };
}

function quiet(t: TestContext) {
  t.mock.method(console, 'log', () => undefined);
  t.mock.method(console, 'error', () => undefined);
  return t.mock.method(console, 'warn', () => undefined);
}

test('a failed lease renewal between purge steps is recorded and the purge still finishes', async t => {
  const warn = quiet(t);
  const statements = installDb(t, pool, ROW, answers(
    failWhen(LEASE_RENEWAL, { code: '08006', message: 'connection failure' }),
    oneBatch(),
  ));

  await service.runDeletionJob(JOB);

  // Raw text: only the renewal statement has this clause on one line (the claim breaks it).
  const renewals = statements.filter(statement => LEASE_RENEWAL.test(statement.text)).length;
  assert.ok(renewals >= 6, `every step renewal was attempted (${renewals})`);
  const texts = statements.map(statement => statement.text.replace(/\s+/g, ' ').trim());
  // Purge steps after the first failed renewal (it follows the assets step) still ran,
  // and the job was marked succeeded.
  const firstRenewal = statements.findIndex(statement => LEASE_RENEWAL.test(statement.text));
  const blocks = texts.findIndex(text => text.startsWith('WITH doomed AS ( SELECT b.id FROM course_blocks b'));
  assert.ok(firstRenewal >= 0 && blocks > firstRenewal, 'the block step ran after a failed renewal');
  assert.ok(texts.some(text => text.startsWith('DELETE FROM courses WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NOT NULL')));
  assert.ok(texts.some(text => text.startsWith("UPDATE course_deletion_jobs SET status = 'succeeded'")));
  const recorded = warn.mock.calls.map(call => String(call.arguments[0]));
  assert.equal(recorded.filter(line => line.includes('"tag":"course_deletion.lease_renewal"')).length, renewals);
  assert.ok(recorded.every(line => !line.includes('connection failure')), 'the best-effort record keeps only the error kind');
});

test('a failed purge statement still ends the run (nothing is retried in place)', async t => {
  quiet(t);
  const statements = installDb(t, pool, ROW, answers(
    failWhen(/^\s*DELETE FROM courses\s+WHERE id = \$1/, { code: '57014', message: 'canceling statement due to statement timeout' }),
    oneBatch(),
  ));

  await assert.rejects(service.runDeletionJob(JOB), /statement timeout/);
  const texts = statements.map(statement => statement.text.replace(/\s+/g, ' ').trim());
  assert.equal(texts.filter(text => text.startsWith('DELETE FROM courses WHERE id = $1')).length, 1);
  assert.ok(!texts.some(text => text.startsWith("UPDATE course_deletion_jobs SET status = 'succeeded'")));
});

test('the retry mark stores the operator diagnostic and logs it for operators', async t => {
  const warn = quiet(t);
  const statements = installDb(t, pool, ROW, rowsWhen(/RETURNING course_id, root_block_id, target_type, is_terminal/, [
    { course_id: COURSE, root_block_id: null, target_type: 'course', is_terminal: false },
  ]));
  const error = Object.assign(new Error('V2 completion receipt is immutable'), {
    code: '23514',
    where: 'PL/pgSQL function guard_lesson_author_workspace_v2_completion() line 5 at RAISE',
  });

  await service.markJobRetryable(JOB, error);

  const mark = statements.find(statement => /RETURNING course_id, root_block_id, target_type, is_terminal/.test(statement.text));
  assert.equal(mark?.params[1],
    'V2 completion receipt is immutable [pg=23514; where=PL/pgSQL function guard_lesson_author_workspace_v2_completion() line 5 at RAISE]');
  const logged = warn.mock.calls.find(call => call.arguments[0] === '[CourseDelete] attempt_failed');
  assert.deepEqual(logged?.arguments[1], {
    event: 'course_deletion.attempt_failed',
    deletion_job_id: JOB,
    terminal: false,
    last_error: mark?.params[1],
  });
});

const DIAGNOSTIC = 'Attempt evidence cannot be deleted individually [step=ai_id_workspaces; pg=23514; '
  + 'table=lesson_author_workspace_v2_attempt_events; constraint=some_fkey; '
  + 'where=PL/pgSQL function guard_lesson_author_workspace_v2_attempt_event() line 13 at RAISE]';

async function statusThroughApi(t: TestContext, row: Record<string, unknown>, headers: Record<string, string> = {}) {
  quiet(t);
  installDb(t, pool, ROW, rowsWhen(/FROM course_deletion_jobs\s+WHERE id = \$1::uuid AND tenant_id = \$2::uuid/, [{ ...ROW, ...row }]));
  return callHandler(controller.getDeletionJobStatusController, { params: { jobId: JOB }, headers }, {
    id: USER,
    tenantId: TENANT,
    role: 'staff',
  }) as Promise<{ status: number; body: { success: boolean; data: Record<string, unknown> } }>;
}

test('GET /api/courses/deletion-jobs/:jobId shows a plain message, never the internal diagnostic', async t => {
  const retrying = await statusThroughApi(t, { status: 'queued', attempts: 3, last_error: DIAGNOSTIC });
  assert.equal(retrying.status, 200);
  assert.equal(retrying.body.data.last_error, DELETION_JOB_PUBLIC_ERRORS.retrying[0]);
  assert.equal(retrying.body.data.status, 'queued');
  assert.equal(retrying.body.data.attempts, 3);
  const shown = JSON.stringify(retrying.body);
  for (const internal of ['lesson_author', 'guard_', 'pg=', 'step=', 'constraint', 'PL/pgSQL', '23514']) {
    assert.ok(!shown.includes(internal), `the tenant API leaks "${internal}"`);
  }
});

test('the plain message follows the request language and the terminal state', async t => {
  const english = await statusThroughApi(t, { status: 'queued', last_error: DIAGNOSTIC }, { 'X-UI-Locale': 'en' });
  assert.equal(english.body.data.last_error, DELETION_JOB_PUBLIC_ERRORS.retrying[1]);
});

test('a terminal job asks for an administrator, in Vietnamese by default', async t => {
  const failed = await statusThroughApi(t, { status: 'failed', is_terminal: true, attempts: 12, last_error: DIAGNOSTIC });
  assert.equal(failed.body.data.last_error, DELETION_JOB_PUBLIC_ERRORS.failed[0]);
  assert.equal(failed.body.data.is_terminal, true);
});

test('a job without an error keeps last_error null', async t => {
  const succeeded = await statusThroughApi(t, { status: 'succeeded', last_error: null });
  assert.equal(succeeded.body.data.last_error, null);
});
