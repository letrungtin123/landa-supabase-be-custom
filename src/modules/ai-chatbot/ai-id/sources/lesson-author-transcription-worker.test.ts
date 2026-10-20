import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import pg from 'pg';

// The lesson-author transcription batch (lesson-author-transcription.worker.ts)
// on a database double: when recording one job's failure throws (the failure
// mark itself, or the chat card sync after it), the error is logged and the
// next claimed job of the batch still runs. Jobs run one at a time
// (concurrency 1, the default); every job fails before the media steps
// (no source video).

process.env.REDIS_URL = 'redis://127.0.0.1:1';
process.env.LESSON_AUTHOR_TRANSCRIPTION_WORKER_ENABLED = 'true';
process.env.LESSON_AUTHOR_TRANSCRIPTION_WORKER_BATCH_SIZE = '3';
process.env.LESSON_AUTHOR_TRANSCRIPTION_WORKER_CONCURRENCY = '1';
// A directory that does not exist: the temp sweep finds nothing and no job here creates it.
process.env.LESSON_AUTHOR_TRANSCRIPTION_TEMP_DIR = path.join(os.tmpdir(), 'landa-transcription-test-missing-dir');

const worker = await import('./lesson-author-transcription.worker.js');

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = 'a0000000-0000-4000-8000-000000000001';
const CONVERSATION = 'b0000000-0000-4000-8000-000000000001';
const JOB = 'c0000000-0000-4000-8000-000000000001';
const JOB_2 = 'c0000000-0000-4000-8000-000000000002';
const LEASE = 'f0000000-0000-4000-8000-000000000001';
const NO_SOURCE = 'Transcript job không còn video nguồn.';

const job = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  tenant_id: TENANT,
  course_id: 'course-v1:Landa+T1+2026',
  conversation_id: null,
  requested_by: USER,
  requested_locale: 'vi',
  status: 'running',
  original_file_name: 'bai-giang.mp4',
  transcript_file_name: 'bai-giang.txt',
  source_storage_path: null,
  transcript_storage_path: null,
  kb_document_id: null,
  kb_document_status: null,
  attempt_count: 1,
  lease_token: LEASE,
  last_error: null,
  expires_at: '2026-10-20 10:00:00+07',
  ...extra,
});

const EXPIRE = /SET status = 'expired'/;
const CLAIM = /WITH candidates AS \(\n\s+SELECT job.id\n\s+FROM lesson_author_transcription_jobs job/;
const FAIL = /SET status = CASE WHEN attempt_count >= \$3::int THEN 'failed' ELSE 'queued' END/;
const CARD_LOCK = /SELECT pg_advisory_xact_lock/;

interface Statement {
  via: string;
  sql: string;
  params: unknown[];
}

/** Every statement (pool or client) answered by `answer`: rows, or an Error to throw. */
function installDatabase(t: TestContext, answer: (sql: string, params: unknown[]) => unknown[] | Error | undefined): Statement[] {
  const statements: Statement[] = [];
  const run = (via: string) => async (config: string | { text: string; values?: unknown[] }, values: unknown[] = []) => {
    const raw = typeof config === 'string' ? config : config.text;
    const params = typeof config === 'string' ? values : (config.values ?? []);
    const sql = raw.replace(/\r\n/g, '\n');
    statements.push({ via, sql, params });
    const answered = answer(sql, params);
    if (answered instanceof Error) throw answered;
    const rows = answered ?? [];
    return { rows, rowCount: rows.length };
  };
  t.mock.method(pg.Pool.prototype, 'query', function (this: unknown, config: string | { text: string }, values?: unknown[]) {
    return run('pool')(config, values);
  });
  t.mock.method(pg.Pool.prototype, 'connect', async function (this: unknown) {
    return { query: run('client'), release() {} };
  });
  return statements;
}

function captureErrors(t: TestContext): unknown[][] {
  const errors: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => {
    errors.push(args);
  });
  for (const level of ['log', 'info', 'warn'] as const) t.mock.method(console, level, () => undefined);
  return errors;
}

/** What the batch did, in order: expiry, claim, then each job's failure mark and card statements. */
function steps(statements: Statement[]): string[] {
  return statements
    .filter(statement => !/^(BEGIN|COMMIT|ROLLBACK)$/.test(statement.sql))
    .map(statement => {
      if (EXPIRE.test(statement.sql)) return 'expire';
      if (CLAIM.test(statement.sql)) return 'claim';
      if (FAIL.test(statement.sql)) return `fail ${statement.params[0]}`;
      if (CARD_LOCK.test(statement.sql)) return `card ${statement.params[0]}`;
      return statement.sql.slice(0, 40);
    });
}

test('a failure mark that throws is logged and the batch runs the next job', async t => {
  const statements = installDatabase(t, (sql, params) => {
    if (EXPIRE.test(sql)) return [];
    if (CLAIM.test(sql)) return [job(JOB), job(JOB_2)];
    if (FAIL.test(sql)) return params[0] === JOB ? new Error('connection reset') : [job(JOB_2, { status: 'queued' })];
    return undefined;
  });
  const errors = captureErrors(t);
  t.mock.timers.enable({ apis: ['setInterval'] });

  await worker.startLessonAuthorTranscriptionWorker();

  assert.deepEqual(steps(statements), ['expire', 'claim', `fail ${JOB}`, `fail ${JOB_2}`]);
  assert.deepEqual(errors, [
    ['[LessonAuthorTranscription] could not record the job failure', { job_id: JOB, error: 'connection reset' }],
    ['[LessonAuthorTranscription] job failed', { job_id: JOB, error: NO_SOURCE }],
    ['[LessonAuthorTranscription] job failed', { job_id: JOB_2, error: NO_SOURCE }],
  ]);
});

test('a chat card sync that throws after the failure mark is logged and the batch runs the next job', async t => {
  const statements = installDatabase(t, (sql, params) => {
    if (EXPIRE.test(sql)) return [];
    if (CLAIM.test(sql)) return [job(JOB), job(JOB_2)];
    if (FAIL.test(sql)) {
      return [job(String(params[0]), { status: 'queued', conversation_id: params[0] === JOB ? CONVERSATION : null })];
    }
    if (CARD_LOCK.test(sql)) return new Error('lock timeout');
    return undefined;
  });
  const errors = captureErrors(t);
  t.mock.timers.enable({ apis: ['setInterval'] });

  await worker.startLessonAuthorTranscriptionWorker();

  assert.deepEqual(steps(statements), ['expire', 'claim', `fail ${JOB}`, `card ${JOB}`, `fail ${JOB_2}`]);
  assert.ok(statements.some(statement => statement.sql === 'ROLLBACK'), 'the card transaction is rolled back');
  assert.deepEqual(errors, [
    ['[LessonAuthorTranscription] could not record the job failure', { job_id: JOB, error: 'lock timeout' }],
    ['[LessonAuthorTranscription] job failed', { job_id: JOB, error: NO_SOURCE }],
    ['[LessonAuthorTranscription] job failed', { job_id: JOB_2, error: NO_SOURCE }],
  ]);
});
