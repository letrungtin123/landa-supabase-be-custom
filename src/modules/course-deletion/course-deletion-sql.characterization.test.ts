import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  answers,
  failWhen,
  noRowsWhen,
  registerCharacterization,
  rowsWhen,
  type Answer,
  type Case,
} from '../../test-support/sql-characterization.js';

// Characterization of course and block deletion (course-deletion.service.ts):
// the requests, the worker job (storage manifest, database purge, Storage
// drain, success and retry marks), the sweeper and the operator retry. Every
// SQL statement (text without whitespace differences, parameters, pool or
// transaction client, client releases), every Storage request (fetch double:
// bucket check, object removals) and the result or error are recorded. The
// golden file was written by the code before the course deletion repository
// existed; moving SQL into repositories must keep every entry equal.
//
// No database, RabbitMQ, Redis or network. A pg double answers every
// statement with one fixed row; a batched statement (one with "LIMIT $n")
// gets that row the first time its text is sent and no row afterwards, so
// every keyset or delete loop runs exactly one batch. RabbitMQ is not
// connected, so a wake-up publish fails and is logged, as when the broker is
// down. Rewrite the golden file only for an intended change:
//   COURSE_DELETION_SQL_GOLDEN_WRITE=1 npx tsx --test src/modules/course-deletion/course-deletion-sql.characterization.test.ts
// COURSE_DELETION_SQL_FULL_OUT=<file> also writes every outcome in full.

process.env.TZ = 'Asia/Ho_Chi_Minh';
process.env.REDIS_URL = 'redis://127.0.0.1:1';
process.env.DELETION_MAX_ATTEMPTS = '12';
process.env.DELETION_RETRY_BASE_MS = '30000';
process.env.DELETION_RETRY_MAX_MS = '3600000';

// Storage requests are recorded; `storageFails` makes the next removals fail.
const storageRequests: string[] = [];
let storageFails = false;
globalThis.fetch = (async (input: string | URL | globalThis.Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = init?.method ?? 'GET';
  const sent = typeof init?.body === 'string' ? ` ${init.body}` : '';
  storageRequests.push(`${method} ${url.replace(/^https?:\/\/[^/]+/, '')}${sent}`);
  if (storageFails && method === 'DELETE') {
    return new globalThis.Response(JSON.stringify({ statusCode: '500', error: 'internal', message: 'storage down' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }
  return new globalThis.Response(JSON.stringify({ id: 'landa-storage', name: 'landa-storage' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;

const redis = await import('../../config/redis.js');
const { pool } = await import('../../config/database.js');
const service = await import('./course-deletion.service.js');

redis.installRedisClient(null);

const { after } = await import('node:test');
after(async () => {
  await pool.end();
});

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = 'a0000000-0000-4000-8000-000000000001';
const JOB = 'b0000000-0000-4000-8000-000000000001';
const BLOCK = 'c0000000-0000-4000-8000-000000000001';
const COURSE = 'course-v1:nesso+a01+2026';
const PREFIX = `${TENANT}/courses/${COURSE}`;
const PUBLIC = 'https://storage.example.test/storage/v1/object/public/landa-storage';

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

/** Batched statements (LIMIT $n) answer one row the first time their text is sent, then none. */
function oneBatch(): Answer {
  const seen = new Set<string>();
  return text => {
    if (!/LIMIT \$\d/.test(text)) return undefined;
    if (seen.has(text)) return { rows: [] };
    seen.add(text);
    return undefined;
  };
}

const cases: Case[] = [];
const add = (name: string, run: () => Promise<unknown>, answer?: Answer, fails = false) =>
  cases.push({
    name,
    run: async () => {
      storageFails = fails;
      try {
        return await run();
      } finally {
        storageFails = false;
      }
    },
    answer: answer ? answers(answer, oneBatch()) : oneBatch(),
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
const BLOCK_JOB = rowsWhen(/^UPDATE course_deletion_jobs\s+SET status = 'running'/, [{ ...ROW, target_type: 'block', root_block_id: BLOCK }]);

// ── Requests ──
add('request course', () => service.requestCourseDeletion(COURSE, TENANT, USER, audit));
add('request course no audit', () => service.requestCourseDeletion(COURSE, TENANT, USER));
add('request course missing', () => service.requestCourseDeletion(COURSE, TENANT, USER), noRowsWhen(/FROM courses\s+WHERE id = \$1 AND tenant_id = \$2 AND deleted_at IS NULL/));
add('request course transfer active', () =>
  service.requestCourseDeletion(COURSE, TENANT, USER),
  answers(rowsWhen(/AS jobs/, [{ jobs: 'course_outline_transfer_jobs' }]), rowsWhen(/AS exists/, [{ exists: true }])),
);
add('request course transfer idle', () =>
  service.requestCourseDeletion(COURSE, TENANT, USER),
  rowsWhen(/AS jobs/, [{ jobs: 'course_outline_transfer_jobs' }]),
);
add('request block', () => service.requestBlockDeletion(BLOCK, TENANT, USER, audit(JOB, 'x')));
add('request block root', () => service.requestBlockDeletion(BLOCK, TENANT, USER), rowsWhen(/FOR UPDATE OF b/, [{ ...ROW, block_type: 'course' }]));
add('request block missing', () => service.requestBlockDeletion(BLOCK, TENANT, USER), noRowsWhen(/FOR UPDATE OF b/));
add('request block insert fails', () => service.requestBlockDeletion(BLOCK, TENANT, USER), failWhen(/INSERT INTO course_deletion_jobs/, { code: '23505', message: 'duplicate' }));

// ── Worker job ──
add('run course job', () => service.runDeletionJob(JOB));
add('run course job manifest done', () =>
  service.runDeletionJob(JOB),
  rowsWhen(/SELECT manifest_completed_at/, [{ manifest_completed_at: new Date('2026-10-02T00:00:00.000Z') }]),
);
add('run course job course gone', () => service.runDeletionJob(JOB), noRowsWhen(/FROM courses WHERE id = \$1 AND tenant_id = \$2$/));
add('run course job lesson author artifacts', () =>
  service.runDeletionJob(JOB),
  rowsWhen(/to_regclass\('public\.lesson_author_transcription_jobs'\)/, [{ exists: true }]),
);
add('run course job optional tables present', () => service.runDeletionJob(JOB), rowsWhen(/SELECT to_regclass\(\$1\) IS NOT NULL AS exists/, [{ exists: true }]));
add('run course job no warnings', () => service.runDeletionJob(JOB), rowsWhen(/AS warnings/, [{ warnings: null }]));
add('run course job prefix scan done', () =>
  service.runDeletionJob(JOB),
  rowsWhen(/SELECT last_storage_path, completed_at/, [{ last_storage_path: `${PREFIX}/z.png`, completed_at: new Date('2026-10-02T00:00:00.000Z') }]),
);
add('run course job storage fails', () => service.runDeletionJob(JOB), undefined, true);
add('run block job', () => service.runDeletionJob(JOB), BLOCK_JOB);
add('run block job storage fails', () => service.runDeletionJob(JOB), BLOCK_JOB, true);
add('run job not claimable', () => service.runDeletionJob(JOB), noRowsWhen(/SET status = 'running'/));

// ── Retry marks, sweeper, operator retry, status ──
add('mark retryable', () => service.markJobRetryable(JOB, new Error('x'.repeat(5000))));
add('mark retryable terminal course', () => service.markJobRetryable(JOB, 'boom'), rowsWhen(/RETURNING course_id, root_block_id, target_type, is_terminal/, [{ ...ROW, is_terminal: true }]));
add('mark retryable terminal block', () =>
  service.markJobRetryable(JOB, 'boom'),
  rowsWhen(/RETURNING course_id, root_block_id, target_type, is_terminal/, [{ ...ROW, is_terminal: true, target_type: 'block', root_block_id: BLOCK }]),
);
add('mark retryable terminal block without root', () =>
  service.markJobRetryable(JOB, 'boom'),
  rowsWhen(/RETURNING course_id, root_block_id, target_type, is_terminal/, [{ ...ROW, is_terminal: true, target_type: 'block' }]),
);
add('mark retryable finished', () => service.markJobRetryable(JOB, 'boom'), rowsWhen(/RETURNING course_id/, [{ ...ROW, is_terminal: true, course_id: null }]));
add('requeue', () => service.requeuePendingDeletionJobs());
add('requeue limit', () => service.requeuePendingDeletionJobs(5), rowsWhen(/ORDER BY requested_at ASC/, [ROW, { ...ROW, id: BLOCK }]));
add('retry terminal course', () => service.retryTerminalCourseDeletionJob(JOB, TENANT));
add('retry terminal block', () =>
  service.retryTerminalCourseDeletionJob(JOB, TENANT),
  rowsWhen(/RETURNING id, course_id, root_block_id, target_type/, [{ ...ROW, target_type: 'block', root_block_id: BLOCK }]),
);
add('retry terminal missing', () => service.retryTerminalCourseDeletionJob(JOB, TENANT), noRowsWhen(/RETURNING id, course_id, root_block_id, target_type/));
add('job status', () => service.getCourseDeletionJobStatus(JOB, TENANT));
add('job status missing', () => service.getCourseDeletionJobStatus(JOB, TENANT), noRowsWhen(/FROM course_deletion_jobs/));

registerCharacterization({
  title: 'course deletion characterization',
  goldenPath: path.join(path.dirname(fileURLToPath(import.meta.url)), 'course-deletion-sql.characterization.golden.json'),
  writeEnv: 'COURSE_DELETION_SQL_GOLDEN_WRITE',
  fullOutEnv: 'COURSE_DELETION_SQL_FULL_OUT',
  pool,
  defaultRow: ROW,
  cases,
  fixedIds: [TENANT, USER, JOB, BLOCK],
  now: Date.parse('2026-10-18T03:04:05.000Z'),
  storage: storageRequests,
});
