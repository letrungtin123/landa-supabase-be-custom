import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Characterization of the KB restore worker (restore.worker.ts): the
// RabbitMQ consumer (options, payload checks, the restore run, retries, the
// last-retry handler with its lock release) and the database recovery: the
// first pass at start and the poller on its interval (fake clock). Every SQL
// statement (exact text, parameters), publish, ack, nack, Redis command, log
// line, interval and result is digested into a golden file written by the
// code before the poller moved onto src/platform/job-runner. Rewrite it only
// for an intended change:
//   KB_RESTORE_WORKER_GOLDEN_WRITE=1 npx tsx --test src/modules/ai-chatbot/kb/restore-worker.characterization.test.ts
// KB_RESTORE_WORKER_FULL_OUT=<file> also writes every outcome in full.

process.env.REDIS_URL = 'redis://127.0.0.1:1';
process.env.RABBITMQ_RETRY_BASE_DELAY_MS = '0';
process.env.KB_RESTORE_RECOVERY_POLL_INTERVAL_MS = '30000';

const h = await import('../../../test-support/job-characterization.js');
const { QUEUES } = await import('../../../config/rabbitmq/index.js');
const worker = await import('./restore.worker.js');

const TENANT = '11111111-1111-4111-8111-111111111111';
const KB = 'd0000000-0000-4000-8000-000000000001';
const JOB = 'e0000000-0000-4000-8000-000000000001';
const JOB_2 = 'e0000000-0000-4000-8000-000000000002';
const LOCK_TOKEN = 'f0000000-0000-4000-8000-000000000001';
const LOCK_KEY = `landa:kb-restore:${KB}`;

const RECOVERABLE = /SELECT id AS "jobId", kb_id AS "kbId", tenant_id AS "tenantId"/;
const FAIL_JOB = /UPDATE kb_restore_jobs\s+SET status = 'failed'/;
const TARGET = { jobId: JOB, kbId: KB, tenantId: TENANT };
const TARGET_2 = { jobId: JOB_2, kbId: KB, tenantId: TENANT };
const PAYLOAD = { jobId: JOB, kbId: KB, tenantId: TENANT, lockKey: LOCK_KEY, lockToken: LOCK_TOKEN };

type Case = import('../../../test-support/job-characterization.js').JobCase;
type Context = Parameters<Case['run']>[0];
const cases: Case[] = [];
const add = (name: string, sql: Case['sql'], run: Case['run']) => cases.push({ name, sql, run });

async function start(context: Context): Promise<void> {
  await worker.startRestoreWorker();
  await context.settle();
  context.mark('started');
}

add('start recovers lost restores', h.answers([[RECOVERABLE, [TARGET, TARGET_2]]]), start);
add('start with nothing to recover', h.answers([]), start);
add('start recovery fails', h.answers([[RECOVERABLE, h.sqlError('pool exhausted')]]), start);
add('start recovery dispatch is not confirmed', h.answers([[RECOVERABLE, [TARGET]]]), async context => {
  context.setPublishFails(true);
  await start(context);
});
add(
  'poller runs on its interval',
  h.answers([[RECOVERABLE, h.sequence([], [TARGET_2], [])]]),
  async context => {
    await start(context);
    await context.tick(29_999);
    context.mark('29999 ms');
    await context.tick(1);
    context.mark('30000 ms');
    await context.tick(30_000);
    context.mark('60000 ms');
  },
);
add(
  'poller failure is logged and the next tick runs',
  h.answers([[RECOVERABLE, h.sequence([], h.sqlError('connection reset'), [TARGET])]]),
  async context => {
    await start(context);
    await context.tick(30_000);
    context.mark('first tick');
    await context.tick(30_000);
    context.mark('second tick');
  },
);
add('message with an invalid payload', h.answers([]), async context => {
  await start(context);
  await context.deliver(QUEUES.GEMINI_RESTORE, { jobId: JOB, kbId: 42, tenantId: TENANT });
  await context.deliver(QUEUES.GEMINI_RESTORE, { kbId: KB, tenantId: TENANT });
});
add('message that is not json', h.answers([]), async context => {
  await start(context);
  await context.deliver(QUEUES.GEMINI_RESTORE, '{not json');
});
add('message restore fails and is retried', h.answers([]), async context => {
  await start(context);
  await context.deliver(QUEUES.GEMINI_RESTORE, PAYLOAD, 1);
});
add('message restore fails on the last retry', h.answers([]), async context => {
  await start(context);
  context.setRedis(command => (command === 'get' ? LOCK_TOKEN : 1));
  await context.deliver(QUEUES.GEMINI_RESTORE, PAYLOAD, 3);
});
add('last retry without a lock', h.answers([]), async context => {
  await start(context);
  await context.deliver(QUEUES.GEMINI_RESTORE, { jobId: JOB, kbId: KB, tenantId: TENANT }, 3);
});
add('last retry with a lock held by another token', h.answers([]), async context => {
  await start(context);
  context.setRedis(command => (command === 'get' ? 'another-token' : 1));
  await context.deliver(QUEUES.GEMINI_RESTORE, PAYLOAD, 3);
});
add('last retry failed mark fails', h.answers([[FAIL_JOB, h.sqlError('deadlock detected', '40P01')]]), async context => {
  await start(context);
  await context.deliver(QUEUES.GEMINI_RESTORE, PAYLOAD, 3);
});
add('last retry with an invalid payload', h.answers([]), async context => {
  await start(context);
  await context.deliver(QUEUES.GEMINI_RESTORE, { jobId: JOB }, 3);
});

h.registerJobCharacterization({
  title: 'KB restore worker characterization',
  goldenPath: path.join(path.dirname(fileURLToPath(import.meta.url)), 'restore-worker.characterization.golden.json'),
  writeEnv: 'KB_RESTORE_WORKER_GOLDEN_WRITE',
  fullOutEnv: 'KB_RESTORE_WORKER_FULL_OUT',
  cases,
  fixedIds: [TENANT, KB, JOB, JOB_2, LOCK_TOKEN],
  now: Date.UTC(2026, 9, 19, 3, 0, 0),
});
