import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Characterization of the course deletion job: the worker
// (course-deletion.worker.ts: the RabbitMQ { jobId } consumer, its retry
// mark, retries and last-retry handler, the startup requeue and the requeue
// poller on its interval, fake clock) and the service
// (course-deletion.service.ts: requests, the job run with its lease
// heartbeat, storage manifest, purge and Storage drain, the retry and
// terminal marks, the sweeper, the operator retry and the status). Unlike
// course-deletion-sql.characterization.test.ts it keeps every SQL text
// exactly (CRLF read as LF) and records RabbitMQ, Redis, log lines and
// intervals too. The golden file was written by the code before the worker
// moved onto src/platform/job-runner and before the service was split.
// Rewrite it only for an intended change:
//   COURSE_DELETION_JOB_GOLDEN_WRITE=1 npx tsx --test src/modules/course-deletion/course-deletion-job.characterization.test.ts
// COURSE_DELETION_JOB_FULL_OUT=<file> also writes every outcome in full.

process.env.TZ = 'Asia/Ho_Chi_Minh';
process.env.REDIS_URL = 'redis://127.0.0.1:1';
process.env.RABBITMQ_RETRY_BASE_DELAY_MS = '0';
process.env.DELETION_REQUEUE_INTERVAL_MS = '30000';
process.env.DELETION_MAX_ATTEMPTS = '12';
process.env.DELETION_RETRY_BASE_MS = '30000';
process.env.DELETION_RETRY_MAX_MS = '3600000';

const h = await import('../../test-support/job-characterization.js');
const { QUEUES } = await import('../../config/rabbitmq/index.js');
const service = await import('./course-deletion.service.js');
const worker = await import('./course-deletion.worker.js');

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = 'a0000000-0000-4000-8000-000000000001';
const JOB = 'b0000000-0000-4000-8000-000000000001';
const BLOCK = 'c0000000-0000-4000-8000-000000000001';
const COURSE = 'course-v1:nesso+a01+2026';
const PREFIX = `${TENANT}/courses/${COURSE}`;
const PUBLIC = 'https://storage.example.test/storage/v1/object/public/landa-storage';
const QUEUE = QUEUES.COURSE_DELETE;

/** One row with every column a course deletion statement reads. */
const ROW = {
  id: JOB,
  tenant_id: TENANT,
  course_id: COURSE,
  root_block_id: null,
  target_type: 'course',
  status: 'running',
  attempts: 1,
  is_terminal: false,
  display_name: ' Khóa học A ',
  block_type: 'html',
  warnings: [
    { code: 'course_deletion.storage_reference_retained', source: 'courses.image_url', reason: 'foreign-or-untrusted-tenant-path' },
    { code: 'other', source: 'x', reason: 'y' },
  ],
  manifest_completed_at: null,
  image_url: `${PUBLIC}/${PREFIX}/cover.png`,
  logo_light_path: `${PREFIX}/mentor/light.png`,
  logo_dark_path: 'https://cdn.example.test/dark.png',
  jobs: null,
  exists: false,
  storage_path: `${PREFIX}/assets/a.png`,
  url: `${PUBLIC}/${TENANT}/courses/other-course/moved.png`,
  data: { html: `<p><img src="${PUBLIC}/${PREFIX}/inline.png"></p>`, file: `${TENANT}/courses/other-course/moved.png` },
  metadata: { poster: `${PREFIX}/poster.jpg`, foreign: '22222222-2222-4222-8222-222222222222/courses/x/y.png' },
  published_data: null,
  published_metadata: [`${PREFIX}/published.png`],
  source_storage_path: `${TENANT}/lesson-author/source.mp3`,
  transcript_storage_path: 'https://evil.example.test/t.txt',
  deleted: 2,
  last_storage_path: null,
  completed_at: null,
  requested_at: new Date('2026-10-01T00:00:00.000Z'),
  started_at: null,
  finished_at: null,
  next_attempt_at: null,
  last_error: null,
  stats: { blocksDeleted: 1 },
  full_name: 'Quản Trị',
  email: 'admin@a.test',
  data_limit_bytes: null,
  database_used_bytes: '0',
  storage_used_bytes: '0',
  storage_reserved_bytes: '0',
  state: 'observing',
  size_bytes: '0',
  ready: false,
};

type SqlAnswer = import('../../test-support/job-characterization.js').SqlAnswer;
const NO_ROWS = /^\s*(BEGIN|COMMIT|ROLLBACK|SET|SAVEPOINT|RELEASE)/i;

/**
 * Every statement answers ROW (transaction control none); a batched statement
 * ("LIMIT $n") answers it the first time its text is sent and no row
 * afterwards, so every keyset or delete loop runs one batch. `first` answers
 * before that.
 */
function rows(...first: Array<[RegExp, unknown[] | Error]>): SqlAnswer {
  const seen = new Set<string>();
  return text => {
    for (const [pattern, value] of first) {
      if (pattern.test(text)) return value instanceof Error ? value : { rows: value };
    }
    if (NO_ROWS.test(text)) return { rows: [] };
    if (/LIMIT \$\d/.test(text)) {
      if (seen.has(text)) return { rows: [] };
      seen.add(text);
    }
    return { rows: [ROW] };
  };
}

type Case = import('../../test-support/job-characterization.js').JobCase;
type Context = Parameters<Case['run']>[0];
const cases: Case[] = [];

/** Storage double: the bucket check and object removals answer 200, or removals 500 when `fails`. */
function storage(context: Context, fails = false): void {
  context.setFetch(method =>
    fails && method === 'DELETE'
      ? new globalThis.Response(JSON.stringify({ statusCode: '500', error: 'internal', message: 'storage down' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        })
      : new globalThis.Response(JSON.stringify({ id: 'landa-storage', name: 'landa-storage' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
  );
}

const add = (name: string, sql: SqlAnswer, run: (context: Context) => Promise<unknown>, storageFails = false) =>
  cases.push({
    name,
    sql,
    run: async context => {
      storage(context, storageFails);
      return run(context);
    },
  });

const audit = (jobId: string, courseName: string) => ({
  tenantId: TENANT,
  actorId: USER,
  actorUsername: 'admin01',
  action: 'DELETE' as const,
  entityType: 'course',
  entityId: COURSE,
  entityName: `${courseName} (${jobId})`,
  event: { code: 'course.deleted' },
});
const CLAIM = /^UPDATE course_deletion_jobs\s+SET status = 'running'/;
const BLOCK_JOB: [RegExp, unknown[]] = [CLAIM, [{ ...ROW, target_type: 'block', root_block_id: BLOCK }]];
const RETRY_MARK = /RETURNING course_id, root_block_id, target_type, is_terminal/;
const RUNNABLE = /ORDER BY requested_at ASC/;

// ── Requests ──
add('request course', rows(), () => service.requestCourseDeletion(COURSE, TENANT, USER, audit));
add('request course no audit', rows(), () => service.requestCourseDeletion(COURSE, TENANT, USER));
add('request course missing', rows([/FROM courses\s+WHERE id = \$1 AND tenant_id = \$2 AND deleted_at IS NULL/, []]), () =>
  service.requestCourseDeletion(COURSE, TENANT, USER),
);
add('request course transfer active', rows([/AS jobs/, [{ jobs: 'course_outline_transfer_jobs' }]], [/AS exists/, [{ exists: true }]]), () =>
  service.requestCourseDeletion(COURSE, TENANT, USER),
);
add('request course transfer idle', rows([/AS jobs/, [{ jobs: 'course_outline_transfer_jobs' }]]), () =>
  service.requestCourseDeletion(COURSE, TENANT, USER),
);
add('request course publish fails', rows(), async context => {
  context.setPublishFails(true);
  return service.requestCourseDeletion(COURSE, TENANT, USER);
});
add('request block', rows(), () => service.requestBlockDeletion(BLOCK, TENANT, USER, audit(JOB, 'x')));
add('request block root', rows([/FOR UPDATE OF b/, [{ ...ROW, block_type: 'course' }]]), () =>
  service.requestBlockDeletion(BLOCK, TENANT, USER),
);
add('request block missing', rows([/FOR UPDATE OF b/, []]), () => service.requestBlockDeletion(BLOCK, TENANT, USER));
add('request block insert fails', rows([/INSERT INTO course_deletion_jobs/, h.sqlError('duplicate', '23505')]), () =>
  service.requestBlockDeletion(BLOCK, TENANT, USER),
);

// ── Job run ──
add('run course job', rows(), () => service.runDeletionJob(JOB));
add('run course job manifest done', rows([/SELECT manifest_completed_at/, [{ manifest_completed_at: new Date('2026-10-02T00:00:00.000Z') }]]), () =>
  service.runDeletionJob(JOB),
);
add('run course job course gone', rows([/FROM courses WHERE id = \$1 AND tenant_id = \$2$/, []]), () => service.runDeletionJob(JOB));
add('run course job lesson author artifacts', rows([/to_regclass\('public\.lesson_author_transcription_jobs'\)/, [{ exists: true }]]), () =>
  service.runDeletionJob(JOB),
);
add('run course job optional tables present', rows([/SELECT to_regclass\(\$1\) IS NOT NULL AS exists/, [{ exists: true }]]), () =>
  service.runDeletionJob(JOB),
);
add('run course job no warnings', rows([/AS warnings/, [{ warnings: null }]]), () => service.runDeletionJob(JOB));
add(
  'run course job prefix scan done',
  rows([/SELECT last_storage_path, completed_at/, [{ last_storage_path: `${PREFIX}/z.png`, completed_at: new Date('2026-10-02T00:00:00.000Z') }]]),
  () => service.runDeletionJob(JOB),
);
add('run course job storage fails', rows(), () => service.runDeletionJob(JOB), true);
add('run block job', rows(BLOCK_JOB), () => service.runDeletionJob(JOB));
add('run block job storage fails', rows(BLOCK_JOB), () => service.runDeletionJob(JOB), true);
add('run job not claimable', rows([/SET status = 'running'/, []]), () => service.runDeletionJob(JOB));
let heartbeatGate: import('../../test-support/job-characterization.js').Gate | null = null;
add(
  'run job lease heartbeat',
  (() => {
    const base = rows();
    return (text: string, params: unknown[]) =>
      /SELECT manifest_completed_at/.test(text) ? heartbeatGate!.wait({ rows: [{ manifest_completed_at: new Date('2026-10-02T00:00:00.000Z') }] }) : base(text, params);
  })(),
  async context => {
    heartbeatGate = context.gate();
    const running = service.runDeletionJob(JOB);
    await context.settle();
    context.mark('waiting');
    await context.tick(59_999);
    context.mark('59999 ms');
    await context.tick(1);
    context.mark('60000 ms');
    await context.tick(60_000);
    context.mark('120000 ms');
    heartbeatGate.open();
    await running;
  },
);
add(
  'run job heartbeat failure is logged',
  (() => {
    const base = rows();
    return (text: string, params: unknown[]) =>
      /SELECT manifest_completed_at/.test(text)
        ? heartbeatGate!.wait({ rows: [{ manifest_completed_at: new Date('2026-10-02T00:00:00.000Z') }] })
        : /SET lease_expires_at/.test(text)
          ? h.sqlError('connection reset')
          : base(text, params);
  })(),
  async context => {
    heartbeatGate = context.gate();
    const running = service.runDeletionJob(JOB);
    await context.settle();
    await context.tick(60_000);
    context.mark('60000 ms');
    heartbeatGate.open();
    await running.catch(error => context.mark(`run failed: ${(error as Error).message}`));
  },
);

// ── Retry marks, sweeper, operator retry, status ──
add('mark retryable', rows(), () => service.markJobRetryable(JOB, new Error('x'.repeat(5000))));
add('mark retryable terminal course', rows([RETRY_MARK, [{ ...ROW, is_terminal: true }]]), () => service.markJobRetryable(JOB, 'boom'));
add('mark retryable terminal block', rows([RETRY_MARK, [{ ...ROW, is_terminal: true, target_type: 'block', root_block_id: BLOCK }]]), () =>
  service.markJobRetryable(JOB, 'boom'),
);
add('mark retryable terminal block without root', rows([RETRY_MARK, [{ ...ROW, is_terminal: true, target_type: 'block' }]]), () =>
  service.markJobRetryable(JOB, 'boom'),
);
add('mark retryable finished', rows([/RETURNING course_id/, [{ ...ROW, is_terminal: true, course_id: null }]]), () =>
  service.markJobRetryable(JOB, 'boom'),
);
add('requeue', rows(), () => service.requeuePendingDeletionJobs());
add('requeue limit', rows([RUNNABLE, [ROW, { ...ROW, id: BLOCK }]]), () => service.requeuePendingDeletionJobs(5));
add('retry terminal course', rows(), () => service.retryTerminalCourseDeletionJob(JOB, TENANT));
add('retry terminal block', rows([/RETURNING id, course_id, root_block_id, target_type/, [{ ...ROW, target_type: 'block', root_block_id: BLOCK }]]), () =>
  service.retryTerminalCourseDeletionJob(JOB, TENANT),
);
add('retry terminal missing', rows([/RETURNING id, course_id, root_block_id, target_type/, []]), () =>
  service.retryTerminalCourseDeletionJob(JOB, TENANT),
);
add('job status', rows(), () => service.getCourseDeletionJobStatus(JOB, TENANT));
add('job status missing', rows([/FROM course_deletion_jobs/, []]), () => service.getCourseDeletionJobStatus(JOB, TENANT));

// ── Worker ──
async function start(context: Context): Promise<void> {
  await worker.startCourseDeletionWorker();
  await context.settle();
  context.mark('started');
}
const notClaimable: [RegExp, unknown[]] = [CLAIM, []];
const claimFails: [RegExp, Error] = [CLAIM, h.sqlError('statement timeout', '57014')];

add('worker start requeues runnable jobs', rows([RUNNABLE, [ROW, { ...ROW, id: BLOCK }]]), start);
add('worker start with nothing runnable', rows([RUNNABLE, []]), start);
add('worker start requeue fails', rows([RUNNABLE, h.sqlError('pool exhausted')]), start);
add(
  'worker poller runs on its interval',
  (() => {
    let calls = 0;
    const base = rows();
    return (text: string, params: unknown[]) => {
      if (RUNNABLE.test(text)) {
        calls += 1;
        return { rows: calls === 2 ? [{ ...ROW, id: BLOCK }] : [] };
      }
      return base(text, params);
    };
  })(),
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
  'worker poller failure is logged and the next tick runs',
  (() => {
    let calls = 0;
    const base = rows();
    return (text: string, params: unknown[]) => {
      if (RUNNABLE.test(text)) {
        calls += 1;
        return calls === 2 ? h.sqlError('connection reset') : { rows: calls === 3 ? [ROW] : [] };
      }
      return base(text, params);
    };
  })(),
  async context => {
    await start(context);
    await context.tick(30_000);
    context.mark('first tick');
    await context.tick(30_000);
    context.mark('second tick');
  },
);
add('worker message for a job that is not claimable', rows([RUNNABLE, []], notClaimable), async context => {
  await start(context);
  await context.deliver(QUEUE, { jobId: `  ${JOB}  ` });
});
add('worker message runs a block job', rows([RUNNABLE, []], BLOCK_JOB), async context => {
  await start(context);
  await context.deliver(QUEUE, { jobId: JOB });
});
add('worker message without a job id', rows([RUNNABLE, []]), async context => {
  await start(context);
  await context.deliver(QUEUE, { jobId: '   ' });
  await context.deliver(QUEUE, { other: JOB });
  await context.deliver(QUEUE, { jobId: 42 });
});
add('worker message without a job id on the last retry', rows([RUNNABLE, []]), async context => {
  await start(context);
  await context.deliver(QUEUE, { jobId: '' }, 3);
});
add('worker message that is not json', rows([RUNNABLE, []]), async context => {
  await start(context);
  await context.deliver(QUEUE, '{not json');
});
add('worker message that is json null', rows([RUNNABLE, []]), async context => {
  await start(context);
  await context.deliver(QUEUE, 'null', 2);
  await context.deliver(QUEUE, 'null', 3);
});
add('worker job fails and is retried', rows([RUNNABLE, []], claimFails), async context => {
  await start(context);
  await context.deliver(QUEUE, { jobId: JOB }, 1);
});
add('worker job fails and its retry mark fails', rows([RUNNABLE, []], claimFails, [RETRY_MARK, h.sqlError('connection reset')]), async context => {
  await start(context);
  await context.deliver(QUEUE, { jobId: JOB });
});
add('worker job fails on the last retry', rows([RUNNABLE, []], claimFails), async context => {
  await start(context);
  await context.deliver(QUEUE, { jobId: JOB }, 3);
});
add('worker last retry mark fails', rows([RUNNABLE, []], claimFails, [RETRY_MARK, h.sqlError('connection reset')]), async context => {
  await start(context);
  await context.deliver(QUEUE, { jobId: JOB }, 3);
});
add('worker retry publish is not confirmed', rows([RUNNABLE, []], claimFails), async context => {
  await start(context);
  context.setPublishFails(true);
  await context.deliver(QUEUE, { jobId: JOB }, 0);
});

h.registerJobCharacterization({
  title: 'course deletion job characterization',
  goldenPath: path.join(path.dirname(fileURLToPath(import.meta.url)), 'course-deletion-job.characterization.golden.json'),
  writeEnv: 'COURSE_DELETION_JOB_GOLDEN_WRITE',
  fullOutEnv: 'COURSE_DELETION_JOB_FULL_OUT',
  cases,
  fixedIds: [TENANT, USER, JOB, BLOCK, '22222222-2222-4222-8222-222222222222'],
  now: Date.parse('2026-10-18T03:04:05.000Z'),
});
