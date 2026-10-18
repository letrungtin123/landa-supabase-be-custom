import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test, { type TestContext } from 'node:test';

// H9: refresh() holds the token row lock only for the rotation (the session
// context is read after COMMIT) with reuse detection and its grace period
// unchanged; sign-in lookups run together with the same answers and the
// same refusals in the same order; last_login_at is written at most once a
// minute. In-memory pg double (it records which connection ran what and
// which queries overlapped); no database, no Redis, no network.

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

interface UserRow {
  id: string; username: string; role: string; tenant_id: string | null; is_active: boolean;
  tenant_active: boolean; password_hash?: string;
}

interface Fake {
  log: string[];
  /** Labels of the queries that were running when each query started. */
  overlaps: Array<{ label: string; running: string[] }>;
  users: Map<string, UserRow>;
  token?: { id: string; user_id: string; token_hash: string; revoked: boolean; revoked_at: Date | null; session_id: string | null };
  originTenant: Record<string, string>;
  permissionGroupCount: number;
  failPermissionGroupCount?: boolean;
  demoLocked: boolean;
  queryDelayMs: number;
}

function label(sql: string): string {
  if (sql.includes('FOR UPDATE OF rt')) return 'token-lock';
  if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return sql.trim().split(/\s+/)[0];
  if (sql.includes('UPDATE refresh_tokens')) return sql.includes('WHERE user_id') ? 'revoke-all' : 'revoke-one';
  if (sql.includes('INSERT INTO refresh_tokens')) return 'insert-token';
  if (sql.includes('UPDATE users SET last_login_at')) return 'last-login';
  if (sql.includes('REPLACE(REPLACE(domain_learner')) return 'origin';
  if (sql.includes('FROM user_permission_groups WHERE user_id')) return 'admin-group-count';
  if (sql.includes('FROM user_tenants ut')) return 'managed-count';
  if (sql.includes('tenant_demo_iframe_settings')) return 'demo';
  if (sql.includes('SELECT code FROM modules')) return 'all-modules';
  if (sql.includes('FROM user_permission_groups upg')) return 'permissions';
  if (sql.includes('FROM tenant_modules tm')) return 'tenant-modules';
  if (sql.includes('FROM tenants WHERE is_active = true ORDER BY name')) return 'managed-all';
  if (sql.includes('FROM tenants WHERE id = $1 AND is_active = true')) return 'managed-primary';
  if (sql.includes('FROM tenant_role_labels')) return 'role-labels';
  if (sql.includes('FROM tenant_group_labels')) return 'group-labels';
  if (sql.includes('FROM team_members tm')) return 'member-groups';
  if (sql.includes('FROM users u') && sql.includes('LEFT JOIN tenants t')) return 'user';
  return 'other';
}

async function install(t: TestContext, fake: Fake) {
  const pg = await import('pg');
  const running = new Set<string>();
  const handle = (where: 'pool' | 'tx') => async (text: string | { text: string }, params: unknown[] = []) => {
    const sql = typeof text === 'string' ? text : text.text;
    const name = label(sql);
    fake.log.push(`${where}:${name}`);
    fake.overlaps.push({ label: name, running: [...running] });
    running.add(name);
    try {
      if (fake.queryDelayMs > 0 && where === 'pool') await new Promise((resolve) => setTimeout(resolve, fake.queryDelayMs));
      const one = (row: unknown) => ({ rows: [row], rowCount: 1 });
      const empty = { rows: [] as unknown[], rowCount: 0 };
      switch (name) {
        case 'token-lock': {
          const token = fake.token;
          if (!token || token.token_hash !== params[0]) return empty;
          const user = fake.users.get(token.user_id)!;
          return one({
            rt_id: token.id, user_id: token.user_id, revoked: token.revoked, revoked_at: token.revoked_at,
            expires_at: new Date(Date.now() + 3_600_000), session_id: token.session_id, session_mode: 'normal',
            ...user, email: 'a@example.com', full_name: 'A', phone: '', avatar_url: null, tenant_name: 'Tenant A',
            session_revoked_at: null,
          });
        }
        case 'revoke-one': if (fake.token) { fake.token.revoked = true; fake.token.revoked_at = new Date(); } return { rows: [], rowCount: 1 };
        case 'user': {
          const user = [...fake.users.values()].find((item) => item.username === params[0] || item.id === params[0]);
          return user ? one({ ...user, email: 'a@example.com', full_name: 'A', phone: '', avatar_url: null, tenant_name: 'Tenant A' }) : empty;
        }
        case 'origin': {
          const id = fake.originTenant[String(params[0])];
          return id ? one({ id }) : empty;
        }
        case 'admin-group-count':
          if (fake.failPermissionGroupCount) throw new Error('database unavailable');
          return one({ count: String(fake.permissionGroupCount) });
        case 'managed-count': return one({ count: '1' });
        case 'demo': return one({ exists: fake.demoLocked });
        case 'all-modules': return { rows: [{ code: 'courses' }, { code: 'reports' }], rowCount: 2 };
        case 'permissions': return { rows: [{ code: 'courses', can_view: true, can_add: false, can_edit: true, can_delete: false }], rowCount: 1 };
        case 'tenant-modules': return { rows: [{ code: params[0] === TENANT_B ? 'reports' : 'courses' }], rowCount: 1 };
        case 'managed-all': return { rows: [{ id: TENANT_A, name: 'A' }, { id: TENANT_B, name: 'B' }], rowCount: 2 };
        case 'managed-primary': return { rows: [{ id: params[0], name: 'A' }], rowCount: 1 };
        case 'role-labels': return { rows: [{ role: 'learner', label: `Học viên ${params[0] === TENANT_B ? 'B' : 'A'}` }], rowCount: 1 };
        case 'group-labels': return { rows: [{ label_key: 'team', label: 'Nhóm' }], rowCount: 1 };
        case 'member-groups': return { rows: [{ id: 'og1', name: 'Phòng 1' }], rowCount: 1 };
        default: return empty;
      }
    } finally {
      running.delete(name);
    }
  };
  t.mock.method(pg.default.Pool.prototype, 'query', handle('pool'));
  t.mock.method(pg.default.Pool.prototype, 'connect', async () => ({ query: handle('tx'), release: () => { fake.log.push('release'); } }));
}

function fake(users: UserRow[]): Fake {
  return {
    log: [], overlaps: [], users: new Map(users.map((user) => [user.id, user])), originTenant: {},
    permissionGroupCount: 1, demoLocked: false, queryDelayMs: 0,
  };
}

const SESSION_READS = ['all-modules', 'permissions', 'tenant-modules', 'managed-all', 'managed-primary', 'role-labels', 'group-labels', 'member-groups'];

test('refresh commits the rotation first and reads the session context after the lock is released', async (t) => {
  const f = fake([{ id: 'u-super', username: 'boss', role: 'superuser', tenant_id: TENANT_A, is_active: true, tenant_active: true }]);
  f.token = { id: 'rt1', user_id: 'u-super', token_hash: hash('device-1'), revoked: false, revoked_at: null, session_id: null };
  await install(t, f);
  const { refresh } = await import('./auth.service.js');

  const session = await refresh('device-1');
  const commit = f.log.indexOf('tx:COMMIT');
  assert.deepEqual(f.log.slice(0, 2), ['tx:BEGIN', 'tx:token-lock']);
  assert.equal(f.log[commit + 1], 'release', 'the connection (and the token row lock) is released at COMMIT');
  for (const read of SESSION_READS) {
    assert.equal(f.log.includes(`tx:${read}`), false, `${read} is not read inside the rotation transaction`);
    const at = f.log.indexOf(`pool:${read}`);
    if (at >= 0) assert.ok(at > commit, `${read} after COMMIT`);
  }
  assert.ok(f.log.indexOf('tx:revoke-one') < commit && f.log.indexOf('tx:insert-token') < commit);
  assert.deepEqual({ ...session, access_token: 'x', refresh_token: 'y' }, {
    access_token: 'x', refresh_token: 'y', expires_in: session.expires_in, session_mode: 'normal',
    user: { id: 'u-super', username: 'boss', email: 'a@example.com', full_name: 'A', phone: '', avatar_url: null,
      role: 'superuser', tenant_id: TENANT_A, tenant_name: 'Tenant A' },
    permissions: {
      courses: { can_view: true, can_add: true, can_edit: true, can_delete: true },
      reports: { can_view: true, can_add: true, can_edit: true, can_delete: true },
    },
    tenant_modules: ['courses'],
    managed_tenants: [{ id: TENANT_A, name: 'A' }],
    role_labels: { learner: 'Học viên A' },
    group_labels: { team: 'Nhóm' },
    member_groups: [],
  });
  assert.notEqual(session.refresh_token, 'device-1');
});

test('refresh keeps the superadmin tenant selection', async (t) => {
  const f = fake([{ id: 'u-root', username: 'root', role: 'superadmin', tenant_id: null, is_active: true, tenant_active: true }]);
  f.token = { id: 'rt2', user_id: 'u-root', token_hash: hash('root-device'), revoked: false, revoked_at: null, session_id: 'family-1' };
  await install(t, f);
  const { refresh } = await import('./auth.service.js');
  const session = await refresh('root-device', TENANT_B);
  assert.deepEqual(session.tenant_modules, ['reports']);
  assert.deepEqual(session.role_labels, { learner: 'Học viên B' });
  assert.deepEqual(session.managed_tenants, [{ id: TENANT_A, name: 'A' }, { id: TENANT_B, name: 'B' }]);
});

test('a token reused within the grace period is refused alone; the rotation is not repeated', async (t) => {
  const f = fake([{ id: 'u1', username: 'learner', role: 'learner', tenant_id: TENANT_A, is_active: true, tenant_active: true }]);
  f.token = { id: 'rt3', user_id: 'u1', token_hash: hash('raced'), revoked: true, revoked_at: new Date(Date.now() - 2_000), session_id: null };
  await install(t, f);
  const { refresh } = await import('./auth.service.js');
  await assert.rejects(refresh('raced'), { statusCode: 401, message: 'Refresh token đã được sử dụng' });
  assert.ok(f.log.includes('tx:ROLLBACK'));
  assert.equal(f.log.some((entry) => /revoke-all|insert-token/.test(entry)), false);
  assert.equal(f.log.some((entry) => SESSION_READS.some((read) => entry.endsWith(`:${read}`))), false);
});

test('a token reused after the grace period ends every session of the user, committed', async (t) => {
  const f = fake([{ id: 'u1', username: 'learner', role: 'learner', tenant_id: TENANT_A, is_active: true, tenant_active: true }]);
  f.token = { id: 'rt4', user_id: 'u1', token_hash: hash('stolen'), revoked: true, revoked_at: new Date(Date.now() - 60_000), session_id: null };
  await install(t, f);
  const { refresh } = await import('./auth.service.js');
  await assert.rejects(refresh('stolen'), { statusCode: 401, message: 'Phiên đăng nhập đã bị thu hồi — vui lòng đăng nhập lại' });
  assert.ok(f.log.indexOf('tx:revoke-all') < f.log.indexOf('tx:COMMIT'), 'the revocation is committed');
  assert.equal(f.log.some((entry) => SESSION_READS.some((read) => entry.endsWith(`:${read}`))), false);
});

test('sign-in lookups run together, and the answer is the same', async (t) => {
  const { hashPassword } = await import('../../utils/password.js');
  const f = fake([{ id: 'u2', username: 'plus', role: 'learner_plus', tenant_id: TENANT_A, is_active: true, tenant_active: true,
    password_hash: await hashPassword('secret-1') }]);
  f.originTenant['https://a.example.com'] = TENANT_A;
  f.queryDelayMs = 10;
  await install(t, f);
  const { login } = await import('./auth.service.js');

  const session = await login('plus', 'secret-1', 'admin', 'https://a.example.com');
  const groupCount = f.overlaps.find((entry) => entry.label === 'admin-group-count')!;
  assert.ok(groupCount.running.includes('origin'), 'the permission-group check starts while the domain lookup runs');
  const memberGroups = f.overlaps.find((entry) => entry.label === 'member-groups')!;
  assert.ok(memberGroups.running.length > 0, 'session reads run together');
  assert.deepEqual({ ...session, access_token: 'x', refresh_token: 'y' }, {
    access_token: 'x', refresh_token: 'y', expires_in: session.expires_in, session_mode: 'normal',
    user: { id: 'u2', username: 'plus', email: 'a@example.com', full_name: 'A', phone: '', avatar_url: null,
      role: 'learner_plus', tenant_id: TENANT_A, tenant_name: 'Tenant A' },
    permissions: { courses: { can_view: true, can_add: false, can_edit: true, can_delete: false } },
    tenant_modules: ['courses'],
    managed_tenants: [],
    role_labels: { learner: 'Học viên A' },
    group_labels: { team: 'Nhóm' },
    member_groups: [{ id: 'og1', name: 'Phòng 1' }],
  });
  assert.ok(f.log.indexOf('pool:insert-token') < f.log.indexOf('pool:last-login'));
});

test('sign-in refusals keep their order and never surface a lookup an earlier check made unnecessary', async (t) => {
  const { hashPassword } = await import('../../utils/password.js');
  const passwordHash = await hashPassword('secret-2');
  const { login } = await import('./auth.service.js');
  const { AuthLoginError } = await import('./auth-login-error.logic.js');
  const refusal = (code: string) => (error: unknown) => error instanceof AuthLoginError && error.loginCode === code;

  // Wrong domain is told before a disabled account.
  let f = fake([{ id: 'u3', username: 'off', role: 'learner', tenant_id: TENANT_A, is_active: false, tenant_active: true, password_hash: passwordHash }]);
  f.originTenant['https://b.example.com'] = TENANT_B;
  await install(t, f);
  await assert.rejects(login('off', 'secret-2', 'learner', 'https://b.example.com'), refusal('INVALID_CREDENTIALS'));
  t.mock.restoreAll();

  // A disabled account is told even when a later lookup fails.
  f = fake([{ id: 'u4', username: 'offplus', role: 'learner_plus', tenant_id: TENANT_A, is_active: false, tenant_active: true, password_hash: passwordHash }]);
  f.failPermissionGroupCount = true;
  await install(t, f);
  await assert.rejects(login('offplus', 'secret-2', 'admin'), refusal('ACCOUNT_DISABLED'));
  t.mock.restoreAll();

  f = fake([{ id: 'u5', username: 'nogroup', role: 'learner_plus', tenant_id: TENANT_A, is_active: true, tenant_active: true, password_hash: passwordHash }]);
  f.permissionGroupCount = 0;
  await install(t, f);
  await assert.rejects(login('nogroup', 'secret-2', 'admin'), refusal('NO_ADMIN_ACCESS'));
  t.mock.restoreAll();

  f = fake([{ id: 'u6', username: 'demo', role: 'learner', tenant_id: TENANT_A, is_active: true, tenant_active: true, password_hash: passwordHash }]);
  f.demoLocked = true;
  await install(t, f);
  await assert.rejects(login('demo', 'secret-2', 'learner'), refusal('DEMO_ACCOUNT_LOCKED'));
  assert.equal(f.log.includes('pool:insert-token'), false, 'no session is issued');
});

test('last_login_at is written at most once a minute, at sign-in and for issued sessions', async (t) => {
  const f = fake([{ id: 'u7', username: 'sso', role: 'learner', tenant_id: TENANT_A, is_active: true, tenant_active: true }]);
  const statements: string[] = [];
  await install(t, f);
  const pg = await import('pg');
  const original = pg.default.Pool.prototype.query as unknown as (...args: unknown[]) => Promise<unknown>;
  t.mock.method(pg.default.Pool.prototype, 'query', function record(this: unknown, text: string, params?: unknown[]) {
    if (text.includes('last_login_at')) statements.push(text.replace(/\s+/g, ' ').trim());
    return original.call(this, text, params);
  });
  const { issueSessionForUserId } = await import('./auth.service.js');
  await issueSessionForUserId('u7');
  await issueSessionForUserId('u7', { updateLastLogin: false });
  assert.deepEqual(statements, [
    "UPDATE users SET last_login_at = now() WHERE id = $1 AND (last_login_at IS NULL OR last_login_at < now() - interval '1 minute')",
  ]);
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('./auth.service.ts', import.meta.url), 'utf8');
  assert.equal((source.match(/UPDATE users SET last_login_at/g) ?? []).length, 1, 'one throttled statement serves both call sites');
  assert.equal((source.match(/touchLastLogin\(user\.id\)/g) ?? []).length, 2);
});
