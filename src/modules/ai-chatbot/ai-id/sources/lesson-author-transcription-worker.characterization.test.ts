import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Characterization of the lesson-author transcription worker
// (lesson-author-transcription.worker.ts): start (temp sweep, first drain,
// then the drain poller and the 6-hour temp sweep on their intervals, fake
// clock), the single-flight drain and its enabled check, expiry, the claim,
// jobs run in batches of the configured concurrency, and the failure path
// (failure mark with its chat card sync, log line). The media steps
// (download, ffmpeg, Gemini) are not reached: every job here fails before
// them. Every SQL statement (exact text, parameters, pool or client), log
// line, interval and result is digested into a golden file written by the
// code before the worker moved onto src/platform/job-runner. Rewrite it only
// for an intended change:
//   LA_TRANSCRIPTION_WORKER_GOLDEN_WRITE=1 npx tsx --test src/modules/ai-chatbot/ai-id/sources/lesson-author-transcription-worker.characterization.test.ts
// LA_TRANSCRIPTION_WORKER_FULL_OUT=<file> also writes every outcome in full.

process.env.REDIS_URL = 'redis://127.0.0.1:1';
process.env.LESSON_AUTHOR_TRANSCRIPTION_WORKER_ENABLED = 'true';
process.env.LESSON_AUTHOR_TRANSCRIPTION_WORKER_POLL_INTERVAL_MS = '10000';
process.env.LESSON_AUTHOR_TRANSCRIPTION_WORKER_BATCH_SIZE = '4';
process.env.LESSON_AUTHOR_TRANSCRIPTION_WORKER_CONCURRENCY = '2';
// A directory that does not exist: the temp sweep finds nothing and no job here creates it.
process.env.LESSON_AUTHOR_TRANSCRIPTION_TEMP_DIR = path.join(os.tmpdir(), 'landa-transcription-golden-missing-dir');

const h = await import('../../../../test-support/job-characterization.js');
const { env } = await import('../../../../config/env.js');
const worker = await import('./lesson-author-transcription.worker.js');

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = 'a0000000-0000-4000-8000-000000000001';
const CONVERSATION = 'b0000000-0000-4000-8000-000000000001';
const JOB = 'c0000000-0000-4000-8000-000000000001';
const JOB_2 = 'c0000000-0000-4000-8000-000000000002';
const JOB_3 = 'c0000000-0000-4000-8000-000000000003';
const LEASE = 'f0000000-0000-4000-8000-000000000001';

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

type Value = Parameters<typeof h.answers>[0][number][1];
type Row = [RegExp, Value];
/** Nothing expires; the claim returns `claimed`; a failure mark returns the job as failed. `first` answers before that. */
function transcriptions(claimed: Value, ...first: Row[]) {
  return h.answers([
    ...first,
    [EXPIRE, []],
    [CLAIM, claimed],
    [FAIL, [job(JOB, { status: 'failed', last_error: 'x' })]],
  ]);
}

type Case = import('../../../../test-support/job-characterization.js').JobCase;
type Context = Parameters<Case['run']>[0];
const cases: Case[] = [];
const add = (name: string, sql: Case['sql'], run: Case['run']) => cases.push({ name, sql, run });
let gate: import('../../../../test-support/job-characterization.js').Gate | null = null;

async function start(context: Context): Promise<void> {
  await worker.startLessonAuthorTranscriptionWorker();
  await context.settle();
  context.mark('started');
}

add('start with nothing due', transcriptions([]), start);
add('start disabled', transcriptions([]), async context => {
  (env as { LESSON_AUTHOR_TRANSCRIPTION_WORKER_ENABLED: boolean }).LESSON_AUTHOR_TRANSCRIPTION_WORKER_ENABLED = false;
  try {
    await start(context);
  } finally {
    (env as { LESSON_AUTHOR_TRANSCRIPTION_WORKER_ENABLED: boolean }).LESSON_AUTHOR_TRANSCRIPTION_WORKER_ENABLED = true;
  }
});
add('start drain fails', transcriptions([], [EXPIRE, h.sqlError('pool exhausted')]), start);
add('claim fails', transcriptions(h.sqlError('statement timeout', '57014')), start);
add('job without a source fails', transcriptions([job(JOB)]), start);
add(
  'failed job syncs its chat card',
  transcriptions([job(JOB, { conversation_id: CONVERSATION })], [FAIL, [job(JOB, { status: 'failed', conversation_id: CONVERSATION })]]),
  start,
);
add('failed mark matches no row', transcriptions([job(JOB)], [FAIL, []]), start);
add('failed mark fails', transcriptions([job(JOB)], [FAIL, h.sqlError('connection reset')]), start);
add('job without a lease token', transcriptions([job(JOB, { lease_token: null })]), start);
add('three jobs run in batches of two', transcriptions([job(JOB), job(JOB_2), job(JOB_3, { lease_token: null })]), start);
add(
  'expired job card is synced',
  transcriptions([], [EXPIRE, [job(JOB_2, { status: 'expired', conversation_id: CONVERSATION, purged_source_storage_path: null, purged_transcript_storage_path: null })]]),
  start,
);
let drains = 0;
add(
  'poller drains on its interval and skips a tick while a drain runs',
  transcriptions([], [EXPIRE, () => (++drains === 2 ? gate!.wait([]) : [])]),
  async context => {
    gate = context.gate();
    drains = 0;
    await start(context);
    await context.tick(9_999);
    context.mark('9999 ms');
    await context.tick(1);
    context.mark('10000 ms: drain running');
    await context.tick(10_000);
    context.mark('20000 ms: tick skipped');
    gate.open();
    await context.settle();
    context.mark('drain done');
    await context.tick(10_000);
    context.mark('30000 ms');
  },
);
add('a tick after the worker was disabled drains nothing', transcriptions([]), async context => {
  await start(context);
  (env as { LESSON_AUTHOR_TRANSCRIPTION_WORKER_ENABLED: boolean }).LESSON_AUTHOR_TRANSCRIPTION_WORKER_ENABLED = false;
  try {
    await context.tick(10_000);
    context.mark('10000 ms');
  } finally {
    (env as { LESSON_AUTHOR_TRANSCRIPTION_WORKER_ENABLED: boolean }).LESSON_AUTHOR_TRANSCRIPTION_WORKER_ENABLED = true;
  }
  await context.tick(10_000);
  context.mark('20000 ms');
});
add('the temp sweep runs every six hours', transcriptions([]), async context => {
  await start(context);
  await context.tick(21_600_000);
  context.mark('6 h');
});

h.registerJobCharacterization({
  title: 'lesson author transcription worker characterization',
  goldenPath: path.join(path.dirname(fileURLToPath(import.meta.url)), 'lesson-author-transcription-worker.characterization.golden.json'),
  writeEnv: 'LA_TRANSCRIPTION_WORKER_GOLDEN_WRITE',
  fullOutEnv: 'LA_TRANSCRIPTION_WORKER_FULL_OUT',
  cases,
  fixedIds: [TENANT, USER, CONVERSATION, JOB, JOB_2, JOB_3, LEASE],
  now: Date.UTC(2026, 9, 19, 3, 0, 0),
});
