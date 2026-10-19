import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import {
  answers,
  installDb,
  installFetchRecorder,
  noRowsWhen,
  rowsWhen,
  type Answer,
  type Statement,
} from '../test-support/sql-characterization.js';

// The error and rollback path of every service transaction that runs through
// withDatabaseTransaction() (config/database.ts) instead of a hand-written
// getClient() + BEGIN/COMMIT/ROLLBACK block. Each case makes one statement of
// the transaction fail (the first one after BEGIN, or COMMIT) and checks that:
//   - every statement of the transaction ran on one client of the main pool,
//     with no pool statement in between;
//   - the failed statement is followed by exactly ROLLBACK and the release;
//   - the caller receives the error of the failed statement, also when the
//     ROLLBACK itself fails (a broken connection);
//   - nothing that follows a commit ran: no cache bump (Redis INCR), no Storage
//     request, and only the listed pool statements after the release.
// The SQL characterization goldens of each module cover the success paths.
// pg double, a recording Redis double and a fetch double: no database, Redis
// or network.

process.env.TZ = 'Asia/Ho_Chi_Minh';
process.env.REDIS_URL = 'redis://127.0.0.1:1';

const storageRequests: string[] = [];
installFetchRecorder(storageRequests, { Key: 'landa-storage/k', name: 'landa-storage', id: 'landa-storage' });

const redis = await import('../config/redis.js');
const { pool } = await import('../config/database.js');
const branding = await import('./branding/branding.service.js');
const courses = await import('./courses/courses.service.js');
const courseCategories = await import('./course-categories/course-categories.service.js');
const groups = await import('./groups/groups.service.js');
const library = await import('./library/library.service.js');
const promptTemplates = await import('./prompt-templates/prompt-templates.service.js');
const reconciliation = await import('./tenants/tenant-data-quota-reconciliation.service.js');
const userDeletion = await import('./users/user-deletion.service.js');

/** Statements of the running case; the Redis double records its cache bumps here too. */
let recorded: Statement[] = [];
const fakeRedis = {
  isOpen: true,
  isReady: true,
  async get() {
    return null;
  },
  async set() {
    return 'OK';
  },
  async incr(key: string) {
    recorded.push({ via: 'redis', text: `INCR ${key}`, params: [] });
    return 1;
  },
};
redis.installRedisClient(fakeRedis as unknown as Parameters<typeof redis.installRedisClient>[0]);

test.after(async () => {
  redis.installRedisClient(null);
  await pool.end();
});

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = 'a0000000-0000-4000-8000-000000000001';
const MEMBER = 'a0000000-0000-4000-8000-000000000002';
const MENTOR = 'a0000000-0000-4000-8000-000000000003';
const ITEM = 'c0000000-0000-4000-8000-000000000001';
const TEAM = 'e0000000-0000-4000-8000-000000000003';
const JOB = 'd0000000-0000-4000-8000-000000000001';
const COURSE = 'course-v1:Landa+C1+2026';

/** One row with every column the statements below read. */
const ROW = {
  id: ITEM,
  tenant_id: TENANT,
  settings: { branding: { white_logo: `${TENANT}/branding/white_logo_1.png` } },
  name: 'Mục A',
  slug: 'muc-a',
  description: 'Mô tả',
  sort_order: 1,
  is_public: false,
  title: 'Tài liệu',
  is_visible: true,
  category_id: null,
  file_url: `${TENANT}/library/a.pdf`,
  file_size: 10,
  extension: 'pdf',
  display_name: 'Khóa học A',
  visible_to_staff_only: false,
  mentor_id: null,
  mentor_name: null,
  username: 'mentor01',
  full_name: 'Người phụ trách',
  email: 'mentor01@example.test',
  role: 'instructor',
  logo_path: `${TENANT}/courses/${COURSE}/mentor-section/light_a.png`,
  avatar_url: 'system/prompt-mascots/avatars/old.png',
  fullbody_url: 'system/prompt-mascots/fullbody/old.png',
  team_name: 'Team A',
  subgroup_name: 'Phân nhóm A',
  org_group_name: 'Nhóm A',
  user_id: MEMBER,
  course_count: '1',
  claimed: true,
  storage_scan_cursor: null,
  bucket_id: 'landa-storage',
  size_bytes: '30',
  status: 'running',
  is_terminal: false,
};

const RECONCILE_OPTIONS = {
  pageSize: 100,
  leaseSeconds: 300,
  databaseSnapshotTimeoutMs: 60_000,
  maxPagesPerClaim: 2,
  maxSliceMs: null,
  retryBaseSeconds: 30,
  retryMaxSeconds: 600,
};

const INJECTED = { message: 'injected failure', code: 'XX000' };
const ROLLBACK_FAILED = { message: 'rollback failed', code: '08006' };

/**
 * Fails statement `position` after the first BEGIN (1 = the first statement
 * after BEGIN), or the first COMMIT. `failed.index` is where it was recorded.
 */
function failInTransaction(position: number | 'COMMIT', failed: { index: number }, rollbackFails: boolean): Answer {
  let afterBegin = -1;
  let done = false;
  return (text, index) => {
    if (rollbackFails && /^\s*ROLLBACK/.test(text)) return { error: ROLLBACK_FAILED };
    if (done) return undefined;
    if (afterBegin < 0) {
      if (/^\s*BEGIN/.test(text)) afterBegin = 0;
      return undefined;
    }
    afterBegin += 1;
    const hit = position === 'COMMIT' ? /^\s*COMMIT/.test(text) : afterBegin === position;
    if (!hit) return undefined;
    done = true;
    failed.index = index;
    return { error: INJECTED };
  };
}

interface Block {
  name: string;
  run: () => Promise<unknown>;
  /** Rows the flow needs to reach the failing statement. */
  answer?: Answer;
  /** Statements that must follow the release ("pool"), e.g. a claim handed back after the failure. */
  after?: string[];
  /** Statements after BEGIN that the cases fail, besides COMMIT. */
  positions?: number[];
}

async function expectRollback(t: TestContext, block: Block, position: number | 'COMMIT', rollbackFails: boolean) {
  t.mock.method(console, 'log', () => undefined);
  t.mock.method(console, 'warn', () => undefined);
  t.mock.method(console, 'error', () => undefined);
  storageRequests.length = 0;
  const failed = { index: -1 };
  const injected = failInTransaction(position, failed, rollbackFails);
  const statements = installDb(t, pool, ROW, block.answer ? answers(injected, block.answer) : injected);
  recorded = statements;

  await assert.rejects(block.run(), (error: { message?: string; code?: string }) => {
    assert.equal(error.message, INJECTED.message);
    assert.equal(error.code, INJECTED.code);
    return true;
  });

  const trace = () => JSON.stringify(statements.map(s => `${s.via} ${s.text.replace(/\s+/g, ' ').slice(0, 60)}`));
  assert.ok(failed.index >= 0, `the failing statement was reached: ${trace()}`);
  const begin = statements.findIndex(s => /^\s*BEGIN/.test(s.text));
  const client = statements[begin].via;
  assert.match(client, /^client:\d+$/, `the transaction ran on a client of the main pool: ${trace()}`);
  const release = statements.findIndex(s => s.via === client && s.text === '<release>');
  assert.ok(release > failed.index, `the client was released: ${trace()}`);
  const transaction = statements.slice(begin, release + 1);
  assert.ok(
    transaction.every(s => s.via === client),
    `every statement of the transaction ran on its client: ${trace()}`,
  );
  assert.deepEqual(
    statements.slice(failed.index + 1, release + 1).map(s => s.text.trim()),
    ['ROLLBACK', '<release>'],
    `ROLLBACK and the release follow the failure: ${trace()}`,
  );
  if (position !== 'COMMIT') {
    assert.ok(!transaction.some(s => /^\s*COMMIT/.test(s.text)), `nothing was committed: ${trace()}`);
  }
  assert.deepEqual(
    statements.slice(release + 1).map(s => s.via),
    block.after ?? [],
    `only the expected statements follow the release: ${trace()}`,
  );
  assert.equal(statements.filter(s => s.via === 'redis').length, 0, `no cache bump: ${trace()}`);
  assert.deepEqual(storageRequests, [], 'no Storage request');
}

const demoAccountsNone = noRowsWhen(/tenant_demo_iframe_settings/);
/** SMTP ready (default templates): addTeamMembers queues the team member emails inside its transaction. */
const smtpReady = answers(noRowsWhen(/FROM tenant_email_templates/), rowsWhen(/FROM tenant_smtp_configs/, [
  {
    ...ROW,
    is_enabled: true,
    host: 'smtp.gmail.com',
    from_email: 'from@example.test',
    password_ciphertext: 'c',
    password_iv: 'i',
    password_auth_tag: 't',
  },
]));
const claimLost = { after: ['pool'] };

const blocks: Block[] = [
  { name: 'branding: deleteBrandingImage', run: () => branding.deleteBrandingImage(TENANT, 'white_logo'), positions: [1, 2] },
  { name: 'courses: updateCourse', run: () => courses.updateCourse(COURSE, TENANT, { description: 'x' }), positions: [1, 2] },
  {
    name: 'courses: updateCourseMentor',
    run: () => courses.updateCourseMentor(COURSE, TENANT, MENTOR, USER),
    positions: [1, 2, 3],
  },
  {
    name: 'courses: deleteCourseMentorSectionLogo',
    run: () => courses.deleteCourseMentorSectionLogo(COURSE, TENANT, USER, 'light'),
    positions: [1, 2],
  },
  {
    name: 'courses: deleteCourseMentorSectionLogo without a logo',
    run: () => courses.deleteCourseMentorSectionLogo(COURSE, TENANT, USER, 'light'),
    answer: noRowsWhen(/AS logo_path/),
    positions: [1],
  },
  {
    name: 'course-categories: updateCourseCategory',
    run: () => courseCategories.updateCourseCategory(ITEM, TENANT, { name: 'Tên Mới' }),
    positions: [1, 2],
  },
  {
    name: 'groups: addTeamMembers',
    run: () => groups.addTeamMembers(TEAM, [MEMBER], { tenantId: TENANT, actorUserId: USER }),
    answer: answers(demoAccountsNone, rowsWhen(/RETURNING user_id/, [{ user_id: MEMBER }])),
    positions: [1, 2, 3],
  },
  {
    name: 'groups: addTeamMembers with team member emails',
    run: () => groups.addTeamMembers(TEAM, [MEMBER], { tenantId: TENANT, actorUserId: USER }),
    answer: answers(demoAccountsNone, smtpReady, rowsWhen(/RETURNING user_id/, [{ user_id: MEMBER }])),
    positions: [1],
  },
  {
    name: 'library: updateDocCategory',
    run: () => library.updateDocCategory(ITEM, TENANT, { name: 'Tên Mới' }),
    positions: [1, 2],
  },
  {
    name: 'library: createDocument',
    run: () => library.createDocument(TENANT, { title: 'Hợp đồng', file_url: `${TENANT}/library/a.pdf` }, USER),
    positions: [1],
  },
  {
    name: 'library: updateDocument',
    run: () => library.updateDocument(ITEM, TENANT, { title: 'Tên mới' }),
    positions: [1, 2],
  },
  {
    name: 'library: bulkDocumentAction',
    run: () => library.bulkDocumentAction([ITEM], TENANT, 'hide'),
    positions: [1],
  },
  { name: 'prompt-templates: deleteTemplate', run: () => promptTemplates.deleteTemplate(ITEM), positions: [1, 2] },
  {
    name: 'prompt-templates: deleteTemplate of a missing template',
    run: () => promptTemplates.deleteTemplate(ITEM),
    answer: noRowsWhen(/FOR UPDATE/),
    positions: [1],
  },
  {
    name: 'tenants: data quota reconciliation storage page',
    run: () => reconciliation.reconcileTenantDataQuota(TENANT, RECONCILE_OPTIONS),
    positions: [1, 2],
    ...claimLost,
  },
  {
    name: 'tenants: data quota reconciliation finish',
    run: () => reconciliation.reconcileTenantDataQuota(TENANT, RECONCILE_OPTIONS),
    answer: noRowsWhen(/FROM storage\.objects/),
    positions: [1, 2],
    ...claimLost,
  },
  {
    name: 'users: deletion job marked succeeded',
    run: () => userDeletion.runUserDeletionJob(JOB),
    answer: rowsWhen(/SET status = 'running'/, [{ ...ROW, id: JOB, user_id: null }]),
    positions: [1, 2, 3],
  },
];

for (const block of blocks) {
  for (const position of [...(block.positions ?? [1]), 'COMMIT' as const]) {
    const at = position === 'COMMIT' ? 'COMMIT' : `statement ${position} after BEGIN`;
    test(`${block.name}: a failing ${at} rolls back and reaches the caller`, t =>
      expectRollback(t, block, position, false));
  }
  test(`${block.name}: a failing ROLLBACK still reports the original error`, t => expectRollback(t, block, 1, true));
}

// The team member emails are rendered and queued inside the transaction, on
// its client (no golden case has SMTP ready). A zero insert count keeps the
// outbox wake (RabbitMQ) out of the test.
test('groups: addTeamMembers queues the team member emails on the transaction client', async t => {
  t.mock.method(console, 'warn', () => undefined);
  const statements = installDb(
    t,
    pool,
    ROW,
    answers(
      demoAccountsNone,
      smtpReady,
      noRowsWhen(/INSERT INTO email_outbox/),
      rowsWhen(/RETURNING user_id/, [{ user_id: MEMBER }]),
    ),
  );
  recorded = statements;
  const result = (await groups.addTeamMembers(TEAM, [MEMBER], { tenantId: TENANT, actorUserId: USER })) as {
    added: number;
    email_requested: boolean;
  };
  assert.equal(result.added, 1);
  assert.equal(result.email_requested, true);
  const begin = statements.findIndex(s => /^\s*BEGIN/.test(s.text));
  const release = statements.findIndex(s => s.text === '<release>');
  const transaction = statements.slice(begin, release + 1);
  assert.ok(transaction.some(s => /INSERT INTO email_outbox/.test(s.text)));
  assert.ok(transaction.every(s => s.via === 'client:1'));
  assert.match(transaction[transaction.length - 2].text, /^\s*COMMIT/);
});

// The two updates whose cache bump used to sit inside the transaction block:
// it still runs only after COMMIT, once per namespace, and the client is
// released.
for (const [name, run, bumps] of [
  ['course-categories: updateCourseCategory', () => courseCategories.updateCourseCategory(ITEM, TENANT, { name: 'x' }), 2],
  ['library: updateDocCategory', () => library.updateDocCategory(ITEM, TENANT, { name: 'x' }), 1],
] as const) {
  test(`${name}: the cache bump follows the COMMIT`, async t => {
    const statements = installDb(t, pool, ROW);
    recorded = statements;
    const result = (await run()) as { removed_assignments?: unknown };
    assert.equal(result.removed_assignments, 0);
    const commit = statements.findIndex(s => /^\s*COMMIT/.test(s.text));
    const incr = statements.flatMap((s, index) => (s.via === 'redis' ? [index] : []));
    assert.ok(commit > 0);
    assert.equal(incr.length, bumps);
    assert.ok(incr.every(index => index > commit));
    assert.deepEqual(
      statements.filter(s => s.text === '<release>').map(s => s.via),
      ['client:1'],
    );
    assert.ok(statements.every(s => s.via === 'client:1' || s.via === 'redis'));
  });
}
