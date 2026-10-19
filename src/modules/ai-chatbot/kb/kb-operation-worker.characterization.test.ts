import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Characterization of the durable KB operation worker (kb-operation.worker.ts):
// start (first drain, then the poller on its interval, fake clock), the
// single-flight drain, the claim, the concurrency of the run, the
// session-level advisory lock held across the remote calls (shared for
// document work, exclusive for a whole-KB delete) and its release, the
// lease heartbeat and the lease-lost check, completion, and the failure mark
// with its terminal rule and capped exponential backoff. Every SQL
// statement (exact text, parameters, pool or client), client listener and
// release, Redis command, fetch, log line, interval and result is digested
// into a golden file written by the code before the worker moved onto
// src/platform/job-runner. Rewrite it only for an intended change:
//   KB_OPERATION_WORKER_GOLDEN_WRITE=1 npx tsx --test src/modules/ai-chatbot/kb/kb-operation-worker.characterization.test.ts
// KB_OPERATION_WORKER_FULL_OUT=<file> also writes every outcome in full.

process.env.REDIS_URL = 'redis://127.0.0.1:1';
process.env.KB_OPERATION_WORKER_ENABLED = 'true';
process.env.KB_OPERATION_WORKER_POLL_INTERVAL_MS = '10000';
process.env.KB_OPERATION_WORKER_BATCH_SIZE = '24';
process.env.KB_OPERATION_WORKER_CONCURRENCY = '2';
process.env.KB_OPERATION_WORKER_LEASE_SECONDS = '60';
process.env.KB_OPERATION_WORKER_MAX_ATTEMPTS = '3';
process.env.KB_OPERATION_WORKER_RETRY_BASE_SECONDS = '30';
process.env.KB_OPERATION_WORKER_RETRY_MAX_SECONDS = '3600';

const h = await import('../../../test-support/job-characterization.js');
const { env } = await import('../../../config/env.js');
const worker = await import('./kb-operation.worker.js');

const TENANT = '11111111-1111-4111-8111-111111111111';
const KB = 'd0000000-0000-4000-8000-000000000001';
const DOCUMENT = 'd1000000-0000-4000-8000-000000000001';
const JOB = 'e0000000-0000-4000-8000-000000000001';
const JOB_2 = 'e0000000-0000-4000-8000-000000000002';
const JOB_3 = 'e0000000-0000-4000-8000-000000000003';
const LEASE = 'f0000000-0000-4000-8000-000000000001';

const job = (id: string, operation: string, extra: Record<string, unknown> = {}) => ({
  id,
  tenant_id: TENANT,
  kb_id: KB,
  document_id: operation === 'knowledgebase_delete' ? null : DOCUMENT,
  target_document_id: null,
  operation,
  status: 'running',
  attempt_count: 1,
  lease_token: LEASE,
  payload: {},
  ...extra,
});

const CLAIM = /UPDATE kb_operation_jobs job\n\s+SET status = 'running'/;
const RENEW = /UPDATE kb_operation_jobs\n\s+SET lease_expires_at = now\(\)/;
const COMPLETE = /DELETE FROM kb_operation_jobs\n/;
const FAIL = /UPDATE kb_operation_jobs\n\s+SET status = CASE WHEN \$3 THEN 'failed' ELSE 'queued' END/;
const LOCK = /SELECT pg_advisory_lock(_shared)?\(hashtextextended/;
const UNLOCK = /SELECT pg_advisory_unlock(_shared)?\(hashtextextended/;
const KB_DELETE = /DELETE FROM knowledgebases kb/;
const ONE = { rows: [], rowCount: 1 };
const NONE = { rows: [], rowCount: 0 };

type Value = Parameters<typeof h.answers>[0][number][1];
type Row = [RegExp, Value];
/** The lease is held and every lease write matches its row; `first` answers before that. */
function operations(claimed: unknown[] | Error | (() => unknown[] | Error), ...first: Row[]) {
  return h.answers([...first, [CLAIM, claimed], [RENEW, ONE], [COMPLETE, ONE], [FAIL, ONE], [KB_DELETE, ONE]]);
}

type Case = import('../../../test-support/job-characterization.js').JobCase;
type Context = Parameters<Case['run']>[0];
const cases: Case[] = [];
const add = (name: string, sql: Case['sql'], run: Case['run']) => cases.push({ name, sql, run });
let gate: import('../../../test-support/job-characterization.js').Gate | null = null;

async function start(context: Context): Promise<void> {
  await worker.startKbOperationWorker();
  await context.settle();
  context.mark('started');
}

add('start with nothing due', operations([]), start);
add('start disabled', operations([]), async context => {
  (env as { KB_OPERATION_WORKER_ENABLED: boolean }).KB_OPERATION_WORKER_ENABLED = false;
  try {
    await start(context);
  } finally {
    (env as { KB_OPERATION_WORKER_ENABLED: boolean }).KB_OPERATION_WORKER_ENABLED = true;
  }
});
add('start claim fails', operations(h.sqlError('pool exhausted')), start);
add('document delete completes', operations([job(JOB, 'document_delete')]), start);
add(
  'document delete with remote cleanup',
  operations([job(JOB, 'document_delete', { payload: { gemini_paths: [], file_path: null }, target_document_id: DOCUMENT })]),
  start,
);
add('knowledge base delete holds the exclusive lock', operations([job(JOB, 'knowledgebase_delete')]), start);
add('knowledge base delete lease lost', operations([job(JOB, 'knowledgebase_delete')], [KB_DELETE, NONE]), start);
add('document upload fails and is retried', operations([job(JOB, 'document_upload')]), start);
add('document reupload fails on the last attempt', operations([job(JOB, 'document_reupload', { attempt_count: 3 })]), start);
add('document reindex fails with the backoff cap', operations([job(JOB, 'document_reindex', { attempt_count: 2 })]), start);
add('document delete keeps retrying after the last attempt', operations([job(JOB, 'document_delete', { attempt_count: 14 })], [COMPLETE, NONE]), start);
add('failed mark matches no row', operations([job(JOB, 'document_upload', { attempt_count: 3 })], [FAIL, NONE]), start);
add('failed mark fails', operations([job(JOB, 'document_upload', { attempt_count: 3 })], [FAIL, h.sqlError('connection reset')]), start);
add('lease lost before the work', operations([job(JOB, 'document_delete')], [RENEW, NONE]), start);
add('job without a lease token is skipped', operations([job(JOB, 'document_delete', { lease_token: null })]), start);
add('lock fails', operations([job(JOB, 'document_delete')], [LOCK, h.sqlError('too many connections', '53300')]), start);
add('unlock fails and the connection is discarded', operations([job(JOB, 'document_delete')], [UNLOCK, h.sqlError('connection terminated')]), start);
add(
  'three jobs run two at a time',
  operations([job(JOB, 'document_delete'), job(JOB_2, 'document_upload'), job(JOB_3, 'document_delete')]),
  start,
);
add(
  'heartbeat renews the lease while the job runs',
  operations([job(JOB, 'document_delete')], [LOCK, () => gate!.wait([])]),
  async context => {
    gate = context.gate();
    const started = worker.startKbOperationWorker();
    await context.settle();
    context.mark('lock pending');
    await context.tick(19_999);
    context.mark('19999 ms');
    await context.tick(1);
    context.mark('20000 ms');
    await context.tick(20_000);
    context.mark('40000 ms');
    gate.open();
    await started;
  },
);
let renewals = 0;
add(
  'heartbeat loses the lease',
  operations([job(JOB, 'document_delete')], [LOCK, () => gate!.wait([])], [RENEW, () => (++renewals === 1 ? NONE : ONE)]),
  async context => {
    gate = context.gate();
    renewals = 0;
    const started = worker.startKbOperationWorker();
    await context.settle();
    await context.tick(20_000);
    context.mark('20000 ms');
    gate.open();
    await started;
  },
);
add(
  'heartbeat renewal fails',
  operations([job(JOB, 'document_delete')], [LOCK, () => gate!.wait([])], [RENEW, () => (++renewals === 1 ? h.sqlError('connection reset') : ONE)]),
  async context => {
    gate = context.gate();
    renewals = 0;
    const started = worker.startKbOperationWorker();
    await context.settle();
    await context.tick(20_000);
    context.mark('20000 ms');
    gate.open();
    await started;
  },
);
let claims = 0;
add(
  'poller drains on its interval and skips a tick while a drain runs',
  operations(
    () => {
      claims += 1;
      return claims === 2 ? [job(JOB, 'document_delete')] : [];
    },
    [LOCK, () => (claims === 2 ? gate!.wait([]) : [])],
  ),
  async context => {
    gate = context.gate();
    claims = 0;
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

h.registerJobCharacterization({
  title: 'KB operation worker characterization',
  goldenPath: path.join(path.dirname(fileURLToPath(import.meta.url)), 'kb-operation-worker.characterization.golden.json'),
  writeEnv: 'KB_OPERATION_WORKER_GOLDEN_WRITE',
  fullOutEnv: 'KB_OPERATION_WORKER_FULL_OUT',
  cases,
  fixedIds: [TENANT, KB, DOCUMENT, JOB, JOB_2, JOB_3, LEASE],
  now: Date.UTC(2026, 9, 19, 3, 0, 0),
});
