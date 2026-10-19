import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  answers,
  callHandler,
  noRowsWhen,
  rowsWhen,
  runCharacterization,
  type Answer,
  type CharacterizationCase,
  type Handler,
} from '../../test-support/sql-characterization.js';

// Characterization of the permanent user deletion: the request (DELETE
// /api/users/:id, accepted and refused), the operator retry, and the worker
// entry points (run, retry bookkeeping, requeue): every SQL statement, every
// Storage request and the answer (src/test-support/sql-characterization.ts).
// The golden file was written by the code before the user deletion
// repository existed; moving SQL into it must keep every entry equal.
// Rewrite it only for an intended change:
//   USER_DELETION_SQL_GOLDEN_WRITE=1 npx tsx --test src/modules/users/user-deletion-sql.characterization.test.ts
// USER_DELETION_SQL_FULL_OUT=<file> also writes every outcome in full.
//
// RabbitMQ is not connected here: a wake-up publish fails at once and is
// logged, as the code expects when the broker is down.

process.env.TZ = 'Asia/Ho_Chi_Minh';
process.env.REDIS_URL = 'redis://127.0.0.1:1';

const storageRequests: string[] = [];
globalThis.fetch = (async (input: string | URL | globalThis.Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  storageRequests.push(`${init?.method ?? 'GET'} ${url.replace(/^https?:\/\/[^/]+/, '')}`);
  return new globalThis.Response(JSON.stringify([{ name: 'landa-storage' }]), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;

const redis = await import('../../config/redis.js');
const { pool } = await import('../../config/database.js');
const ctrl = await import('./users.controller.js');
const deletion = await import('./user-deletion.service.js');

redis.installRedisClient(null);

test.after(async () => {
  await pool.end();
});

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const USER = 'a0000000-0000-4000-8000-000000000001';
const TARGET = 'a0000000-0000-4000-8000-000000000002';
const JOB = 'd0000000-0000-4000-8000-000000000001';
const ITEM = 'e0000000-0000-4000-8000-000000000001';
const AVATAR = `${TENANT}/avatars/${TARGET}.png`;
const FILE_PATH = `${TENANT}/assignments/course-v1:Landa+C1+2026/a/s/submission/${TARGET}/f_bai.pdf`;

/** One row with every column a deletion statement reads: the target learner and its queued job. */
const ROW = {
  id: JOB, user_id: TARGET, tenant_id: TENANT, status: 'running', attempts: 1, is_terminal: false,
  username: 'learner01', email: 'learner01@example.test', full_name: 'Học viên', role: 'learner', avatar_url: AVATAR,
  is_active: true, manifest_completed_at: null, storage_path: FILE_PATH,
  feedback_files: [{ id: 'f1', storage_path: `${TENANT}/assignments/x/feedback.pdf` }, `${OTHER_TENANT}/assignments/y.pdf`],
  completed_at: null, last_storage_path: null, prefix: `${TENANT}/avatars/${TARGET}`, deleted: 2, count: 1,
  requested_at: '2026-10-01T00:00:00.000Z', started_at: null, finished_at: null, next_attempt_at: null, last_error: null,
  stats: {}, exists: false,
};

/** The first statement matching `pattern` answers `rows`; later ones answer none (ends a drain loop). */
function once(pattern: RegExp, rows: unknown[]): Answer {
  let used = false;
  return text => {
    if (!pattern.test(text)) return undefined;
    if (used) return { rows: [] };
    used = true;
    return { rows };
  };
}

/** The worker's drain loops: one storage page and one claimed manifest item, then none. */
const drains = (): Answer =>
  answers(
    once(/FROM storage\.objects storage_object/, [{ storage_path: `${TENANT}/avatars/${TARGET}.jpg` }]),
    once(/picked AS \(/, [{ id: ITEM, storage_path: AVATAR }]),
  );
const NOT_DEMO = noRowsWhen(/tenant_demo_iframe_settings/);

interface CallOptions {
  role?: string;
  tenantId?: string | null;
}

function call(handler: Handler, options: CallOptions = {}) {
  return callHandler(handler, {
    user: {
      id: USER,
      tenantId: options.tenantId === undefined ? TENANT : options.tenantId,
      role: options.role ?? 'superuser',
      username: 'admin01',
      sessionMode: 'normal',
    },
    query: {},
    params: { id: TARGET, jobId: JOB },
    body: {},
    originalUrl: `/api/users/${TARGET}`,
    get: () => undefined,
    headers: {},
    ip: '127.0.0.1',
  });
}

const cases: CharacterizationCase[] = [];
const add = (name: string, run: () => Promise<unknown>, answer?: () => Answer) =>
  cases.push({ name, run, get answer() { return answers(...(answer ? [answer()] : []), NOT_DEMO); } });

const newJob = noRowsWhen(/FROM user_deletion_jobs\s+WHERE user_id = \$1::uuid\s+AND status IN/);
const superadminTarget: Answer = text =>
  /FROM users/.test(text) && !/COUNT\(\*\)/.test(text) ? { rows: [{ ...ROW, id: TARGET, role: 'superadmin' }] } : undefined;

// ── Request ──
add('request', () => call(ctrl.deleteController), () => newJob);
add('request existing job', () => call(ctrl.deleteController));
add('request terminal job', () =>
  call(ctrl.deleteController),
  () => rowsWhen(/FROM user_deletion_jobs\s+WHERE user_id = \$1::uuid\s+AND status IN/, [{ id: JOB, is_terminal: true }]),
);
add('request superadmin', () =>
  call(ctrl.deleteController, { role: 'superadmin', tenantId: null }),
  () => answers(newJob, rowsWhen(/AS count/, [{ count: 2 }]), superadminTarget),
);
add('request last superadmin', () =>
  call(ctrl.deleteController, { role: 'superadmin', tenantId: null }),
  () => answers(rowsWhen(/AS count/, [{ count: 1 }]), superadminTarget),
);
add('request demo learner', () =>
  call(ctrl.deleteController),
  () => rowsWhen(/tenant_demo_iframe_settings/, [{ exists: true }]),
);
add('request missing preview', () => call(ctrl.deleteController), () => answers(newJob, noRowsWhen(/SELECT id, role, tenant_id, is_active FROM users WHERE id = \$1/)));
add('retry', () => call(ctrl.retryDeletionJobController));
add('retry all tenants', () => call(ctrl.retryDeletionJobController, { role: 'superadmin', tenantId: null }));

// ── Worker ──
add('run', () => deletion.runUserDeletionJob(JOB), drains);
add('run already completed', () => deletion.runUserDeletionJob(JOB), () => rowsWhen(/SET status = 'running'/, [{ ...ROW, user_id: null }]));
add('run not claimable', () => deletion.runUserDeletionJob(JOB), () => noRowsWhen(/SET status = 'running'/));
add('run manifest done', () =>
  deletion.runUserDeletionJob(JOB),
  () => answers(rowsWhen(/SELECT manifest_completed_at/, [{ manifest_completed_at: '2026-10-01T00:00:00.000Z' }]), drains()),
);
add('run user gone', () =>
  deletion.runUserDeletionJob(JOB),
  () => answers(noRowsWhen(/FROM users WHERE id = \$1::uuid/), drains()),
);
add('run no avatar', () =>
  deletion.runUserDeletionJob(JOB),
  () => answers(rowsWhen(/SELECT tenant_id, avatar_url FROM users/, [{ tenant_id: TENANT, avatar_url: null }]), drains()),
);
add('run tenantless with avatar', () =>
  deletion.runUserDeletionJob(JOB),
  () => rowsWhen(/SELECT tenant_id, avatar_url FROM users/, [{ tenant_id: null, avatar_url: AVATAR }]),
);
add('run tenantless without avatar', () =>
  deletion.runUserDeletionJob(JOB),
  () => answers(rowsWhen(/SELECT tenant_id, avatar_url FROM users/, [{ tenant_id: null, avatar_url: null }]), drains()),
);
add('run foreign avatar', () =>
  deletion.runUserDeletionJob(JOB),
  () => rowsWhen(/SELECT tenant_id, avatar_url FROM users/, [{ tenant_id: TENANT, avatar_url: `${OTHER_TENANT}/avatars/x.png` }]),
);
add('run foreign file', () =>
  deletion.runUserDeletionJob(JOB),
  () => rowsWhen(/SELECT af\.storage_path/, [{ storage_path: `${OTHER_TENANT}/assignments/x.pdf` }]),
);
add('run user row kept', () =>
  deletion.runUserDeletionJob(JOB),
  () => answers(text => (/DELETE FROM users WHERE id/.test(text) ? { rows: [], rowCount: 0 } : undefined), drains()),
);
add('run full batches', () => deletion.runUserDeletionJob(JOB), () => {
  let first = true;
  return answers(text => {
    if (/FROM chat_conversations WHERE user_id/.test(text) && first) {
      first = false;
      return { rows: [], rowCount: 500 };
    }
    return undefined;
  }, drains());
});
add('retryable', () => deletion.markUserDeletionJobRetryable(JOB, new Error('Storage timeout')));
add('retryable terminal', () =>
  deletion.markUserDeletionJobRetryable(JOB, 'gave up'),
  () => rowsWhen(/RETURNING user_id, is_terminal/, [{ user_id: TARGET, is_terminal: true }]),
);
add('retryable terminal no user', () =>
  deletion.markUserDeletionJobRetryable(JOB, new Error('x')),
  () => rowsWhen(/RETURNING user_id, is_terminal/, [{ user_id: null, is_terminal: true }]),
);
add('retryable not running', () => deletion.markUserDeletionJobRetryable(JOB, new Error('x')), () => noRowsWhen(/RETURNING user_id, is_terminal/));
add('requeue', () => deletion.requeuePendingUserDeletionJobs(5));
add('requeue default limit', () => deletion.requeuePendingUserDeletionJobs(), () => noRowsWhen(/ORDER BY requested_at ASC/));

runCharacterization({
  label: 'user deletion characterization',
  goldenPath: path.join(path.dirname(fileURLToPath(import.meta.url)), 'user-deletion-sql.characterization.golden.json'),
  writeGolden: process.env.USER_DELETION_SQL_GOLDEN_WRITE === '1',
  fullOut: process.env.USER_DELETION_SQL_FULL_OUT?.trim() || '',
  cases,
  pool,
  defaultRow: ROW,
  now: Date.parse('2026-10-19T03:04:05.000Z'),
  fixedIds: [TENANT, OTHER_TENANT, USER, TARGET, JOB, ITEM],
  sideRequests: storageRequests,
});
