import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Characterization of the lesson-author session deletion worker
// (lesson-author-session-deletion.worker.ts): the schema gate, the RabbitMQ
// { jobId } consumer (job id checks, the run with its lease heartbeat, the
// retry mark, retries and the last-retry handler) and the database recovery:
// the first pass at start and the poller on its interval (fake clock). Every
// SQL statement (exact text, parameters), publish, ack, nack, log line,
// interval and result is digested into a golden file written by the code
// before the worker moved onto src/platform/job-runner. Rewrite it only for
// an intended change:
//   LA_SESSION_DELETION_WORKER_GOLDEN_WRITE=1 npx tsx --test src/modules/ai-chatbot/ai-id/sessions/lesson-author-session-deletion-worker.characterization.test.ts
// LA_SESSION_DELETION_WORKER_FULL_OUT=<file> also writes every outcome in full.

process.env.REDIS_URL = 'redis://127.0.0.1:1';
process.env.RABBITMQ_RETRY_BASE_DELAY_MS = '0';
process.env.DELETION_REQUEUE_INTERVAL_MS = '30000';
process.env.DELETION_MAX_ATTEMPTS = '12';
process.env.DELETION_RETRY_BASE_MS = '30000';
process.env.DELETION_RETRY_MAX_MS = '3600000';

const h = await import('../../../../test-support/job-characterization.js');
const { QUEUES } = await import('../../../../config/rabbitmq/index.js');
const worker = await import('./lesson-author-session-deletion.worker.js');

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = 'a0000000-0000-4000-8000-000000000001';
const CONVERSATION = 'b0000000-0000-4000-8000-000000000001';
const JOB = 'c0000000-0000-4000-8000-000000000001';
const JOB_2 = 'c0000000-0000-4000-8000-000000000002';
const COURSE = 'course-v1:Landa+S1+2026';
const QUEUE = QUEUES.LESSON_AUTHOR_SESSION_DELETE;

const SCHEMA = /AS relation_ready/;
const TABLE = /SELECT to_regclass\('public.lesson_author_session_deletion_jobs'\) IS NOT NULL AS exists/;
const PENDING = /SELECT id FROM lesson_author_session_deletion_jobs\n/;
const CLAIM = /SET status='running',attempts=attempts\+1/;
const LOCKED = /SELECT c.user_id::text AS creator_id FROM chat_conversations c/;
const RETRY = /status=CASE WHEN attempts >= \$2::int THEN 'failed' ELSE 'queued' END/;
const READY = [
  { relation_ready: true, active_index_ready: true, recovery_index_ready: true, retention_index_ready: true, rls_enabled: true },
];
const CLAIMED = {
  id: JOB,
  tenant_id: TENANT,
  course_id: COURSE,
  conversation_id: CONVERSATION,
  requested_by: USER,
  status: 'running',
  attempts: 1,
  is_terminal: false,
};

type Case = import('../../../../test-support/job-characterization.js').JobCase;
type Context = Parameters<Case['run']>[0];
const cases: Case[] = [];
const add = (name: string, sql: Case['sql'], run: Case['run']) => cases.push({ name, sql, run });

/** The schema is ready and the recovery finds `pending` jobs; `extra` answers first. */
function ready(pending: unknown[] = [], extra: Array<Parameters<typeof h.answers>[0][number]> = []) {
  return h.answers([...extra, [SCHEMA, READY], [TABLE, [{ exists: true }]], [PENDING, pending]]);
}

async function start(context: Context): Promise<void> {
  await worker.startLessonAuthorSessionDeletionWorker();
  await context.settle();
  context.mark('started');
}

add('start recovers pending jobs', ready([{ id: JOB }, { id: JOB_2 }]), start);
add('start with nothing pending', ready(), start);
add('start schema not ready', h.answers([[SCHEMA, [{ ...READY[0], rls_enabled: false }]]]), start);
add('start schema check returns no row', h.answers([]), start);
add('start without the job table', ready([], [[TABLE, [{ exists: false }]]]), start);
add('start recovery fails', ready([], [[PENDING, h.sqlError('pool exhausted')]]), start);
add('start recovery publish fails', ready([{ id: JOB }]), async context => {
  context.setPublishFails(true);
  await start(context);
});
add(
  'poller runs on its interval',
  ready([], [[PENDING, h.sequence([], [{ id: JOB_2 }], [])]]),
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
  ready([], [[PENDING, h.sequence([], h.sqlError('connection reset'), [{ id: JOB }])]]),
  async context => {
    await start(context);
    await context.tick(30_000);
    context.mark('first tick');
    await context.tick(30_000);
    context.mark('second tick');
  },
);
add('message for a job that is not claimable', ready(), async context => {
  await start(context);
  await context.deliver(QUEUE, { jobId: `  ${JOB}  ` });
});
add('message runs the job to the end', ready([], [[CLAIM, [CLAIMED]], [LOCKED, []]]), async context => {
  await start(context);
  await context.deliver(QUEUE, { jobId: JOB });
});
add('message job deletes the session', ready([], [[CLAIM, [CLAIMED]], [LOCKED, [{ creator_id: USER }]]]), async context => {
  await start(context);
  await context.deliver(QUEUE, { jobId: JOB });
});
let lockedGate: import('../../../../test-support/job-characterization.js').Gate | null = null;
add(
  'lease heartbeat while the job runs',
  ready([], [[CLAIM, [CLAIMED]], [LOCKED, () => lockedGate!.wait([])]]),
  async context => {
    lockedGate = context.gate();
    await start(context);
    context.mark('deliver');
    const delivered = context.deliver(QUEUE, { jobId: JOB });
    await context.settle();
    await context.tick(59_999);
    context.mark('59999 ms');
    await context.tick(1);
    context.mark('60000 ms');
    await context.tick(60_000);
    context.mark('120000 ms');
    lockedGate.open();
    await delivered;
  },
);
add('message without a job id', ready(), async context => {
  await start(context);
  await context.deliver(QUEUE, { jobId: '   ' });
  await context.deliver(QUEUE, { other: JOB });
  await context.deliver(QUEUE, { jobId: 42 });
});
add('message without a job id on the last retry', ready(), async context => {
  await start(context);
  await context.deliver(QUEUE, { jobId: '' }, 3);
});
add('message with a job id that is not a uuid', ready(), async context => {
  await start(context);
  await context.deliver(QUEUE, { jobId: 'not-a-uuid' }, 1);
});
add('message that is not json', ready(), async context => {
  await start(context);
  await context.deliver(QUEUE, '{not json');
});
add('message that is json null', ready(), async context => {
  await start(context);
  await context.deliver(QUEUE, 'null', 2);
  await context.deliver(QUEUE, 'null', 3);
});
add('job fails and is retried', ready([], [[CLAIM, h.sqlError('statement timeout', '57014')]]), async context => {
  await start(context);
  await context.deliver(QUEUE, { jobId: JOB }, 1);
});
add(
  'job fails and its retry mark fails',
  ready([], [[CLAIM, h.sqlError('statement timeout', '57014')], [RETRY, h.sqlError('connection reset')]]),
  async context => {
    await start(context);
    await context.deliver(QUEUE, { jobId: JOB });
  },
);
add('job fails on the last retry', ready([], [[CLAIM, h.sqlError('statement timeout', '57014')]]), async context => {
  await start(context);
  await context.deliver(QUEUE, { jobId: JOB }, 3);
});
add(
  'last retry mark fails',
  ready([], [[CLAIM, h.sqlError('statement timeout', '57014')], [RETRY, h.sqlError('connection reset')]]),
  async context => {
    await start(context);
    await context.deliver(QUEUE, { jobId: JOB }, 3);
  },
);
add('retry publish is not confirmed', ready([], [[CLAIM, h.sqlError('statement timeout', '57014')]]), async context => {
  await start(context);
  context.setPublishFails(true);
  await context.deliver(QUEUE, { jobId: JOB }, 0);
});

h.registerJobCharacterization({
  title: 'lesson author session deletion worker characterization',
  goldenPath: path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'lesson-author-session-deletion-worker.characterization.golden.json',
  ),
  writeEnv: 'LA_SESSION_DELETION_WORKER_GOLDEN_WRITE',
  fullOutEnv: 'LA_SESSION_DELETION_WORKER_FULL_OUT',
  cases,
  fixedIds: [TENANT, USER, CONVERSATION, JOB, JOB_2],
  now: Date.UTC(2026, 9, 19, 3, 0, 0),
});
