import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcrypt';
import {
  answers,
  callHandler,
  failWhen,
  noRowsAt,
  noRowsWhen,
  rowsWhen,
  runCharacterization,
  type Answer,
  type CharacterizationCase,
  type Handler,
} from '../../test-support/staff-sql-characterization.js';

// Characterization of the staff user routes (/api/users): every SQL statement,
// every Storage request and the answer of every users handler, over a matrix
// of roles, queries, bodies and empty results (src/test-support/
// staff-sql-characterization.ts). The golden file was written by the code before
// the users repository existed; moving SQL into repositories must keep every
// entry equal. Rewrite it only for an intended change:
//   USERS_SQL_GOLDEN_WRITE=1 npx tsx --test src/modules/users/users-sql.characterization.test.ts
// USERS_SQL_FULL_OUT=<file> also writes every outcome in full.
//
// The deletion request is exercised on its refusals only: its success path
// publishes to RabbitMQ after the commit.

process.env.TZ = 'Asia/Ho_Chi_Minh';
process.env.REDIS_URL = 'redis://127.0.0.1:1';

const storageRequests: string[] = [];
globalThis.fetch = (async (input: string | URL | globalThis.Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  storageRequests.push(`${init?.method ?? 'GET'} ${url.replace(/^https?:\/\/[^/]+/, '')}`);
  return new globalThis.Response(JSON.stringify({ id: 'landa-storage', name: 'landa-storage', Key: 'k', path: 'p' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;

const redis = await import('../../config/redis.js');
const { pool } = await import('../../config/database.js');
const ctrl = await import('./users.controller.js');

redis.installRedisClient(null);

test.after(async () => {
  await pool.end();
});

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = 'a0000000-0000-4000-8000-000000000001';
const TARGET = 'a0000000-0000-4000-8000-000000000002';
const GROUP = 'b0000000-0000-4000-8000-000000000001';
const TEAM = 'c0000000-0000-4000-8000-000000000001';
const JOB = 'd0000000-0000-4000-8000-000000000001';
const CURRENT_PASSWORD = 'Current#2026';

/** One row with every column a users statement reads: the target, a learner of the tenant. */
const ROW = {
  id: TARGET, username: 'learner01', email: 'learner01@example.test', full_name: 'Học viên', phone: '0900',
  avatar_url: `${TENANT}/avatars/${TARGET}.png`, role: 'learner', is_active: true, tenant_id: TENANT,
  last_login_at: '2026-10-01T00:00:00.000Z', created_at: '2026-01-01T00:00:00.000Z', tenant_name: 'Landa',
  permission_group_id: GROUP, permission_group_name: 'Nhóm A', name: 'Nhóm A', count: '3', user_id: TARGET,
  team_assignments: [{ team_id: TEAM, team_name: 'Team' }], is_current_team_member: true,
  password_hash: bcrypt.hashSync(CURRENT_PASSWORD, '$2b$04$CharacterizationSalt..'), bio: 'bio', gender: 'male', country: 'VN', language: 'vi',
  level_of_education: 'bachelor', year_of_birth: 1990, phone_number: '0900', quota: 100, current_count: '1',
  status: 'queued', is_terminal: false, attempts: 0, requested_at: '2026-10-01T00:00:00.000Z', started_at: null,
  finished_at: null, next_attempt_at: null, last_error: null, stats: {}, permission_group_ids: [GROUP],
  session_version: 1, token_version: 1,
};

/** Every case: the target is not the tenant's demo iframe learner unless the case says so. */
const NOT_DEMO = noRowsWhen(/tenant_demo_iframe_settings/);
/** Username and email are free. */
const AVAILABLE = noRowsWhen(/^\s*SELECT id\s+FROM users\s+WHERE (username = \$1|btrim\(email\))/);
const staffTarget: Answer = text =>
  /FROM users/.test(text) && !/COUNT\(\*\)/.test(text) ? { rows: [{ ...ROW, role: 'staff' }] } : undefined;
const superadminTarget: Answer = text =>
  /FROM users/.test(text) && !/COUNT\(\*\)/.test(text) ? { rows: [{ ...ROW, role: 'superadmin' }] } : undefined;

interface CallOptions {
  role?: string;
  userId?: string;
  tenantId?: string | null;
  sessionMode?: string;
  query?: Record<string, unknown>;
  params?: Record<string, string>;
  body?: unknown;
  file?: unknown;
  locale?: string;
}

function call(handler: Handler, options: CallOptions = {}) {
  return callHandler(handler, {
    user: {
      id: options.userId ?? USER,
      tenantId: options.tenantId === undefined ? TENANT : options.tenantId,
      role: options.role ?? 'superuser',
      username: 'admin01',
      sessionMode: options.sessionMode ?? 'normal',
    },
    query: options.query ?? {},
    params: { id: TARGET, jobId: JOB, username: 'admin01', ...options.params },
    body: 'body' in options ? options.body : {},
    file: options.file,
    originalUrl: `/api/users/${TARGET}`,
    get: (name: string) => (name.toLowerCase() === 'x-ui-locale' ? options.locale : undefined),
    headers: {},
    ip: '127.0.0.1',
  });
}

const cases: CharacterizationCase[] = [];
const add = (name: string, run: () => Promise<unknown>, answer?: Answer) =>
  cases.push({ name, run, answer: answer ? answers(answer, NOT_DEMO) : NOT_DEMO });

const H = ctrl;
const AVATAR = { originalname: 'Ảnh đại diện.png', mimetype: 'image/png', size: 2048, buffer: Buffer.from('png') };

// ── List and read ──
add('list', () => call(H.listController));
add('list superadmin all tenants', () => call(H.listController, { role: 'superadmin', tenantId: null }));
add('list filtered', () =>
  call(H.listController, {
    query: { search: 'an', role: 'staff', is_active: 'true', permission_group_id: GROUP, page: '2', page_size: '5' },
  }),
);
add('list role list inactive', () => call(H.listController, { query: { role: 'learner, learner_plus,', is_active: 'false' } }));
add('list role all', () => call(H.listController, { query: { role: 'all', is_active: 'maybe' } }));
add('list odd query', () => call(H.listController, { query: { search: ['a'], role: ['staff'], page: 'x', page_size: '500' } }));
add('list team assignments', () =>
  call(H.listController, { query: { include_team_assignments: 'true', current_team_id: ` ${TEAM} ` } }),
);
add('list team assignments all tenants', () =>
  call(H.listController, { tenantId: null, role: 'superadmin', query: { include_team_assignments: true, current_team_id: ' ' } }),
);
add('list team assignments none', () =>
  call(H.listController, { query: { include_team_assignments: 'true' } }),
  rowsWhen(/FROM team_members tm/, []),
);
add('list demo iframe user', () => call(H.listController), rowsWhen(/tenant_demo_iframe_settings/, [{ demo_user_id: TARGET }]));
add('list empty', () => call(H.listController, { query: { include_team_assignments: 'true' } }), text =>
  /COUNT\(\*\) AS count/.test(text) ? { rows: [{ count: '0' }] } : { rows: [] },
);
add('get', () => call(H.getByIdController));
add('get all tenants', () => call(H.getByIdController, { role: 'superadmin', tenantId: null }));
add('get missing', () => call(H.getByIdController), noRowsAt(0));
add('get no groups', () => call(H.getByIdController), noRowsWhen(/FROM user_permission_groups upg/));

// ── Create ──
const CREATE = { username: 'newuser', email: 'New.User@Example.test', password: 'secret12', full_name: 'Người mới' };
add('create', () => call(H.createController, { body: CREATE }), AVAILABLE);
add('create staff', () => call(H.createController, { body: { ...CREATE, role: 'staff', phone: '0911' } }), AVAILABLE);
add('create superadmin in tenant', () =>
  call(H.createController, { role: 'superadmin', tenantId: null, body: { ...CREATE, role: 'superuser', tenant_id: TENANT } }),
  AVAILABLE,
);
add('create superadmin no tenant', () =>
  call(H.createController, { role: 'superadmin', tenantId: null, body: { ...CREATE, role: 'superadmin' } }),
  AVAILABLE,
);
add('create invalid', () => call(H.createController, { body: { ...CREATE, email: 'not-an-email' } }));
add('create no body', () => call(H.createController, { body: undefined }));
add('create refused role', () => call(H.createController, { role: 'staff', body: { ...CREATE, role: 'superuser' } }));
add('create refused role en', () =>
  call(H.createController, { role: 'staff', locale: 'en', body: { ...CREATE, role: 'superadmin' } }),
);
add('create duplicate username', () => call(H.createController, { body: CREATE }));
add('create duplicate email', () => call(H.createController, { body: CREATE }), noRowsWhen(/WHERE username = \$1/));
add('create unique violation', () => call(H.createController, { body: CREATE }), answers(AVAILABLE, failWhen(/INSERT INTO users/, '23505')));
add('create quota full', () => call(H.createController, { body: CREATE }), answers(AVAILABLE, rowsWhen(/AS quota/, [{ quota: 1, current_count: '1' }])));
add('create no tenant row', () => call(H.createController, { body: CREATE }), answers(AVAILABLE, noRowsWhen(/AS quota/)));

// ── Update ──
add('update name', () => call(H.updateController, { body: { full_name: 'Tên mới', phone: '0922' } }), AVAILABLE);
add('update username and email', () =>
  call(H.updateController, { body: { username: 'renamed', email: 'Renamed@Example.test' } }),
  AVAILABLE,
);
add('update learner to staff', () => call(H.updateController, { body: { role: 'staff' } }), AVAILABLE);
add('update staff to learner', () => call(H.updateController, { body: { role: 'learner' } }), answers(AVAILABLE, staffTarget));
add('update staff to learner no tenant', () =>
  call(H.updateController, { role: 'superadmin', tenantId: null, body: { role: 'learner_plus' } }),
  answers(AVAILABLE, text =>
    /FROM users/.test(text) && !/COUNT\(\*\)/.test(text) ? { rows: [{ ...ROW, role: 'staff', tenant_id: null }] } : undefined,
  ),
);
add('update same role', () => call(H.updateController, { body: { role: 'learner' } }), AVAILABLE);
add('update deactivate', () => call(H.updateController, { body: { is_active: false } }), AVAILABLE);
add('update password', () => call(H.updateController, { body: { password: 'newsecret' } }), AVAILABLE);
add('update clear avatar', () => call(H.updateController, { body: { avatar_url: null } }), AVAILABLE);
add('update demote superadmin', () =>
  call(H.updateController, { role: 'superadmin', tenantId: null, body: { role: 'superuser' } }),
  answers(AVAILABLE, rowsWhen(/AS count|COUNT\(\*\)/, [{ count: 2 }]), superadminTarget),
);
add('update demote last superadmin', () =>
  call(H.updateController, { role: 'superadmin', tenantId: null, body: { is_active: false } }),
  answers(AVAILABLE, rowsWhen(/AS count|COUNT\(\*\)/, [{ count: 1 }]), superadminTarget),
);
add('update nothing', () => call(H.updateController, { body: {} }), AVAILABLE);
add('update invalid', () => call(H.updateController, { body: { avatar_url: 'x.png' } }));
add('update missing', () => call(H.updateController, { body: { full_name: 'x' } }), noRowsWhen(/FROM users u\s+LEFT JOIN tenants/));
add('update pending deletion', () =>
  call(H.updateController, { body: { full_name: 'x' } }),
  answers(AVAILABLE, (text, index) => (index > 1 && /deletion_requested_at IS NULL/.test(text) ? { rows: [] } : undefined)),
);
add('update target changed', () =>
  call(H.updateController, { body: { full_name: 'x' } }),
  answers(AVAILABLE, noRowsWhen(/^\s*UPDATE users SET/)),
);
add('update unique violation', () =>
  call(H.updateController, { body: { username: 'taken' } }),
  answers(AVAILABLE, failWhen(/^\s*UPDATE users SET/, '23505')),
);
add('update duplicate', () => call(H.updateController, { body: { username: 'taken' } }));
add('update self', () => call(H.updateController, { userId: TARGET, body: { full_name: 'x' } }), AVAILABLE);
add('update by staff', () => call(H.updateController, { role: 'staff', body: { role: 'superuser' } }), AVAILABLE);
add('update demo iframe user', () =>
  call(H.updateController, { body: { full_name: 'x' } }),
  answers(AVAILABLE, rowsWhen(/tenant_demo_iframe_settings/, [{ demo_user_id: TARGET, exists: true }])),
);

// ── Deletion (refusals), jobs ──
add('delete self', () => call(H.deleteController, { userId: TARGET }));
add('delete missing', () => call(H.deleteController), noRowsAt(2));
add('delete by staff', () => call(H.deleteController, { role: 'staff' }), staffTarget);
add('deletion job status', () => call(H.getDeletionJobStatusController));
add('deletion job status all tenants', () => call(H.getDeletionJobStatusController, { tenantId: null, role: 'superadmin' }));
add('deletion job status missing', () => call(H.getDeletionJobStatusController), noRowsAt(0));
add('deletion job retry missing', () => call(H.retryDeletionJobController), noRowsWhen(/UPDATE user_deletion_jobs/));

// ── Permission groups ──
add('assign group', () => call(H.assignGroupsController, { body: { permission_group_ids: [GROUP] } }), staffTarget);
add('assign no group', () => call(H.assignGroupsController, { body: { permission_group_ids: [] } }));
add('assign two groups', () => call(H.assignGroupsController, { body: { permission_group_ids: [GROUP, TEAM] } }));
add('assign invalid', () => call(H.assignGroupsController, { body: { permission_group_ids: ['x'] } }));
add('assign no tenant', () =>
  call(H.assignGroupsController, { role: 'superadmin', tenantId: null, body: { permission_group_ids: [GROUP] } }),
);
add('assign self', () => call(H.assignGroupsController, { userId: TARGET, body: { permission_group_ids: [GROUP] } }));
add('assign missing user', () => call(H.assignGroupsController, { body: { permission_group_ids: [GROUP] } }), noRowsAt(0));

// ── Profile ──
add('profile', () => call(H.getProfileController));
add('profile missing', () => call(H.getProfileController), noRowsAt(0));
const PROFILE = {
  name: 'Tên', bio: 'Giới thiệu', gender: 'female', country: 'VN', level_of_education: 'master', language: 'en',
  year_of_birth: 1995, phone_number: '0933',
};
add('profile update', () => call(H.updateProfileController, { body: PROFILE }));
add('profile update blanks', () =>
  call(H.updateProfileController, { body: { gender: '', level_of_education: '', year_of_birth: null } }),
);
add('profile update bad gender', () => call(H.updateProfileController, { body: { gender: 'x' } }));
add('profile update bad education', () => call(H.updateProfileController, { body: { level_of_education: 'x' } }));
add('profile update nothing', () => call(H.updateProfileController, { body: { avatar_url: 'x' } }));
add('profile update no body', () => call(H.updateProfileController, { body: undefined }));
add('profile update missing', () => call(H.updateProfileController, { body: { bio: 'x' } }), noRowsWhen(/^\s*UPDATE users SET/));
add('profile update pending deletion', () => call(H.updateProfileController, { body: { bio: 'x' } }), noRowsAt(0));
add('profile update demo session', () => call(H.updateProfileController, { sessionMode: 'demo_iframe', body: { bio: 'x' } }));
add('profile update demo account', () =>
  call(H.updateProfileController, { body: { bio: 'x' } }),
  rowsWhen(/tenant_demo_iframe_settings/, [{ demo_user_id: USER, exists: true }]),
);
add('avatar', () => call(H.uploadAvatarController, { file: AVATAR }));
add('avatar no old avatar', () => call(H.uploadAvatarController, { file: AVATAR }), rowsWhen(/FROM users u\s+LEFT JOIN tenants/, [{ ...ROW, avatar_url: null }]));
add('avatar no tenant', () => call(H.uploadAvatarController, { tenantId: null, file: { ...AVATAR, originalname: 'noext' } }));
add('avatar no file', () => call(H.uploadAvatarController));
add('avatar demo session', () => call(H.uploadAvatarController, { sessionMode: 'demo_iframe', file: AVATAR }));
add('avatar fenced', () => call(H.uploadAvatarController, { file: AVATAR }), noRowsWhen(/^\s*UPDATE users\s+SET avatar_url/));
add('avatar missing user', () => call(H.uploadAvatarController, { file: AVATAR }), noRowsAt(0));
add('password missing fields', () => call(H.changePasswordController, { body: { current_password: 'x' } }));
add('password short', () => call(H.changePasswordController, { body: { current_password: 'x', new_password: 'short' } }));
add('password demo session', () =>
  call(H.changePasswordController, { sessionMode: 'demo_iframe', body: { current_password: 'x', new_password: 'longenough' } }),
);
add('password wrong current', () =>
  call(H.changePasswordController, { body: { current_password: 'wrong', new_password: 'longenough' } }),
);
add('password missing user', () =>
  call(H.changePasswordController, { body: { current_password: CURRENT_PASSWORD, new_password: 'longenough' } }),
  noRowsWhen(/SELECT password_hash FROM users/),
);
add('password pending deletion', () =>
  call(H.changePasswordController, { body: { current_password: CURRENT_PASSWORD, new_password: 'longenough' } }),
  noRowsAt(0),
);

runCharacterization({
  label: 'users characterization',
  goldenPath: path.join(path.dirname(fileURLToPath(import.meta.url)), 'users-sql.characterization.golden.json'),
  writeGolden: process.env.USERS_SQL_GOLDEN_WRITE === '1',
  fullOut: process.env.USERS_SQL_FULL_OUT?.trim() || '',
  cases,
  pool,
  defaultRow: ROW,
  now: Date.parse('2026-10-19T03:04:05.000Z'),
  fixedIds: [TENANT, USER, TARGET, GROUP, TEAM, JOB],
  sideRequests: storageRequests,
});
