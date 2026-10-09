import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { NextFunction, Request, Response } from 'express';

// Service and controller wiring of the user authority policy against an
// in-memory pg double. Real database/network access is forbidden: every
// pool query and connection is answered here, and only rejection paths of
// the deletion flow are exercised (its success path talks to Redis/RabbitMQ).

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const SUPERADMIN = 'a0000000-0000-4000-8000-000000000001';
const SUPERADMIN_2 = 'a0000000-0000-4000-8000-000000000002';
const SUPERUSER = 'a0000000-0000-4000-8000-000000000003';
const SUPERUSER_2 = 'a0000000-0000-4000-8000-000000000004';
const STAFF = 'a0000000-0000-4000-8000-000000000005';
const LEARNER = 'a0000000-0000-4000-8000-000000000006';
const OTHER_TENANT_LEARNER = 'a0000000-0000-4000-8000-000000000007';

type Role = 'learner' | 'learner_plus' | 'staff' | 'superuser' | 'superadmin';
type UserRow = {
  id: string; username: string; email: string; full_name: string; role: Role;
  tenant_id: string | null; is_active: boolean; avatar_url: null;
};
type Call = { sql: string; params: unknown[] };

function seedUsers(): Map<string, UserRow> {
  const row = (id: string, role: Role, tenant: string | null, username: string): UserRow => ({
    id, username, email: `${username}@example.test`, full_name: username, role, tenant_id: tenant, is_active: true, avatar_url: null,
  });
  return new Map([
    row(SUPERADMIN, 'superadmin', TENANT_A, 'root'),
    row(SUPERADMIN_2, 'superadmin', TENANT_A, 'root2'),
    row(SUPERUSER, 'superuser', TENANT_A, 'admin'),
    row(SUPERUSER_2, 'superuser', TENANT_A, 'admin2'),
    row(STAFF, 'staff', TENANT_A, 'staff'),
    row(LEARNER, 'learner', TENANT_A, 'learner'),
    row(OTHER_TENANT_LEARNER, 'learner', TENANT_B, 'learner-b'),
  ].map((user) => [user.id, user]));
}

interface FakeDb {
  users: Map<string, UserRow>;
  calls: Call[];
  /** Overrides the computed active superadmin count. */
  activeSuperadmins?: number;
  /** Simulates a concurrent role/status change: the guarded UPDATE matches nothing. */
  updateMatchesNothing?: boolean;
}

async function installFakeDb(t: TestContext, db: FakeDb): Promise<void> {
  const pg = await import('pg');
  const handle = async (text: string | { text: string }, params: unknown[] = []) => {
    const sql = typeof text === 'string' ? text : text.text;
    db.calls.push({ sql, params });
    const empty = { rows: [] as unknown[], rowCount: 0 };
    const one = (row: unknown) => ({ rows: [row], rowCount: 1 });
    const scoped = (id: unknown, tenant: unknown) => {
      const user = db.users.get(String(id));
      return user && (tenant == null || user.tenant_id === tenant) ? user : undefined;
    };

    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) return empty;
    if (sql.includes('pg_advisory_xact_lock')) return one({});
    if (sql.includes('AS quota')) return one({ quota: null, current_count: '0' });
    if (sql.includes("role = 'superadmin'") && sql.includes('COUNT(*)')) {
      const count = db.activeSuperadmins ?? [...db.users.values()].filter((u) => u.role === 'superadmin' && u.is_active).length;
      return one({ count });
    }
    if (/^\s*SELECT id, role, tenant_id, is_active\s+FROM users/.test(sql)) {
      const user = scoped(params[0], params[1]);
      return user ? one({ id: user.id, role: user.role, tenant_id: user.tenant_id, is_active: user.is_active }) : empty;
    }
    if (/^\s*SELECT id\s+FROM users\s+WHERE id = \$1\s+AND deletion_requested_at IS NULL/.test(sql)) {
      const user = scoped(params[0], params[1]);
      return user ? one({ id: user.id }) : empty;
    }
    if (sql.includes('NULLIF(btrim(username)') && sql.includes('FOR UPDATE')) {
      const user = db.users.get(String(params[0]));
      return user ? one({ ...user }) : empty;
    }
    if (sql.includes('FROM users u') && sql.includes('LEFT JOIN tenants t')) {
      const user = scoped(params[0], params[1]);
      return user ? one({ ...user, tenant_name: 'Tenant', last_login_at: null, created_at: '2026-01-01', phone: '' }) : empty;
    }
    if (/^\s*UPDATE users SET/.test(sql)) {
      if (db.updateMatchesNothing) return empty;
      const user = db.users.get(String(params[params.length - 4]));
      return user ? one({ ...user }) : empty;
    }
    if (/^\s*INSERT INTO users/.test(sql)) {
      return one({ id: 'a0000000-0000-4000-8000-0000000000ff', username: params[0], email: params[1], full_name: params[3], role: params[5], tenant_id: params[6] });
    }
    return empty;
  };
  t.mock.method(pg.default.Pool.prototype, 'query', handle);
  t.mock.method(pg.default.Pool.prototype, 'connect', async () => ({ query: handle, release: () => undefined }));
}

function fakeDb(overrides: Partial<FakeDb> = {}): FakeDb {
  return { users: seedUsers(), calls: [], ...overrides };
}

function wrote(db: FakeDb, pattern: RegExp): boolean {
  return db.calls.some((call) => pattern.test(call.sql));
}

function actorOf(db: FakeDb, id: string) {
  const user = db.users.get(id)!;
  return { id, username: user.username, role: user.role, tenantId: user.tenant_id };
}

async function rejectsWith(promise: Promise<unknown>, code: string, status: number): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    const failure = error as { code?: string; statusCode?: number };
    assert.equal(failure.code, code);
    assert.equal(failure.statusCode, status);
    return true;
  });
}

test('updateUser refuses self role/status changes and escalation before any write', async (t) => {
  const db = fakeDb();
  await installFakeDb(t, db);
  const { updateUser } = await import('./users.service.js');

  await rejectsWith(updateUser(STAFF, { role: 'superadmin' }, actorOf(db, STAFF), TENANT_A), 'USER_AUTHORITY_SELF_ROLE_CHANGE', 403);
  await rejectsWith(updateUser(SUPERUSER, { is_active: false }, actorOf(db, SUPERUSER), TENANT_A), 'USER_AUTHORITY_SELF_STATUS_CHANGE', 403);
  await rejectsWith(updateUser(SUPERUSER, { password: 'new-secret' }, actorOf(db, SUPERUSER), TENANT_A), 'USER_AUTHORITY_SELF_PASSWORD_CHANGE', 403);
  // Staff resetting a superuser's password, or promoting a learner.
  await rejectsWith(updateUser(SUPERUSER, { password: 'takeover' }, actorOf(db, STAFF), TENANT_A), 'USER_AUTHORITY_TARGET_NOT_MANAGEABLE', 403);
  await rejectsWith(updateUser(LEARNER, { role: 'staff' }, actorOf(db, STAFF), TENANT_A), 'USER_AUTHORITY_ROLE_NOT_ASSIGNABLE', 403);
  // Superuser vs superuser and superuser vs superadmin.
  await rejectsWith(updateUser(SUPERUSER_2, { is_active: false }, actorOf(db, SUPERUSER), TENANT_A), 'USER_AUTHORITY_TARGET_NOT_MANAGEABLE', 403);
  await rejectsWith(updateUser(SUPERADMIN, { is_active: false }, actorOf(db, SUPERUSER), TENANT_A), 'USER_AUTHORITY_SUPERADMIN_ONLY', 403);
  assert.equal(wrote(db, /^\s*UPDATE users SET/), false);
  assert.ok(db.calls.filter((call) => /^\s*ROLLBACK/.test(call.sql)).length >= 7);
});

test('updateUser applies an allowed change only while the target keeps the checked role and status', async (t) => {
  const db = fakeDb();
  await installFakeDb(t, db);
  const { updateUser } = await import('./users.service.js');

  // The admin edit form resends the unchanged role/status with a self edit.
  await updateUser(SUPERUSER, { full_name: 'Admin', role: 'superuser', is_active: true }, actorOf(db, SUPERUSER), TENANT_A);
  await updateUser(LEARNER, { role: 'learner_plus', is_active: false }, actorOf(db, STAFF), TENANT_A);
  const updates = db.calls.filter((call) => /^\s*UPDATE users SET/.test(call.sql));
  assert.equal(updates.length, 2);
  for (const update of updates) assert.match(update.sql, /AND role = \$\d+\s+AND is_active = \$\d+\s+AND deletion_requested_at IS NULL/);
  assert.deepEqual(updates[1].params.slice(-4), [LEARNER, TENANT_A, 'learner', true]);

  db.updateMatchesNothing = true;
  await rejectsWith(updateUser(LEARNER, { is_active: false }, actorOf(db, SUPERUSER), TENANT_A), 'USER_AUTHORITY_TARGET_CHANGED', 409);
});

test('the last active superadmin cannot be deactivated or demoted; the check runs under the superadmin-set lock', async (t) => {
  const db = fakeDb({ activeSuperadmins: 1 });
  await installFakeDb(t, db);
  const { updateUser } = await import('./users.service.js');

  await rejectsWith(updateUser(SUPERADMIN_2, { is_active: false }, actorOf(db, SUPERADMIN), TENANT_A), 'USER_AUTHORITY_LAST_SUPERADMIN', 409);
  await rejectsWith(updateUser(SUPERADMIN_2, { role: 'superuser' }, actorOf(db, SUPERADMIN), TENANT_A), 'USER_AUTHORITY_LAST_SUPERADMIN', 409);
  const lockAt = db.calls.findIndex((call) => call.sql.includes("'landa:users:active-superadmins'"));
  const countAt = db.calls.findIndex((call) => call.sql.includes("role = 'superadmin'") && call.sql.includes('COUNT(*)'));
  assert.ok(lockAt >= 0 && countAt > lockAt);
  assert.equal(wrote(db, /^\s*UPDATE users SET/), false);

  db.activeSuperadmins = 2;
  await updateUser(SUPERADMIN_2, { is_active: false }, actorOf(db, SUPERADMIN), TENANT_A);
  assert.equal(wrote(db, /^\s*UPDATE users SET/), true);
});

test('createUser: role must be assignable and non-superadmin tenant_id cannot leave the own tenant', async (t) => {
  const db = fakeDb();
  await installFakeDb(t, db);
  const { createUser } = await import('./users.service.js');
  const base = { username: 'newbie', email: 'newbie@example.test', password: 'secret1' };

  await rejectsWith(createUser({ ...base, role: 'superadmin' }, actorOf(db, STAFF)), 'USER_AUTHORITY_SUPERADMIN_ONLY', 403);
  await rejectsWith(createUser({ ...base, role: 'staff' }, actorOf(db, STAFF)), 'USER_AUTHORITY_ROLE_NOT_ASSIGNABLE', 403);
  await rejectsWith(createUser({ ...base, role: 'superuser' }, actorOf(db, SUPERUSER)), 'USER_AUTHORITY_ROLE_NOT_ASSIGNABLE', 403);
  await rejectsWith(createUser({ ...base, role: 'learner', tenant_id: TENANT_B }, actorOf(db, SUPERUSER)), 'USER_AUTHORITY_CROSS_TENANT', 403);
  assert.equal(wrote(db, /^\s*INSERT INTO users/), false);

  await createUser({ ...base, role: 'staff' }, actorOf(db, SUPERUSER));
  await createUser({ ...base, username: 'other', role: 'superuser', tenant_id: TENANT_B }, actorOf(db, SUPERADMIN));
  const inserts = db.calls.filter((call) => /^\s*INSERT INTO users/.test(call.sql));
  assert.deepEqual(inserts.map((call) => [call.params[5], call.params[6]]), [['staff', TENANT_A], ['superuser', TENANT_B]]);
});

test('requestUserDeletion applies the same policy, including the last superadmin', async (t) => {
  const db = fakeDb({ activeSuperadmins: 1 });
  await installFakeDb(t, db);
  const { requestUserDeletion } = await import('./user-deletion.service.js');

  await rejectsWith(requestUserDeletion(SUPERUSER, actorOf(db, SUPERUSER)), 'USER_AUTHORITY_SELF_DELETE', 403);
  await rejectsWith(requestUserDeletion(SUPERUSER_2, actorOf(db, SUPERUSER)), 'USER_AUTHORITY_TARGET_NOT_MANAGEABLE', 403);
  await rejectsWith(requestUserDeletion(OTHER_TENANT_LEARNER, actorOf(db, STAFF)), 'USER_AUTHORITY_CROSS_TENANT', 403);
  await rejectsWith(requestUserDeletion(SUPERADMIN_2, actorOf(db, SUPERUSER)), 'USER_AUTHORITY_SUPERADMIN_ONLY', 403);
  await rejectsWith(requestUserDeletion(SUPERADMIN_2, actorOf(db, SUPERADMIN)), 'USER_AUTHORITY_LAST_SUPERADMIN', 409);
  const lockAt = db.calls.findIndex((call) => call.sql.includes("'landa:users:active-superadmins'"));
  const rowLockAt = db.calls.findIndex((call, index) => index > lockAt && call.sql.includes('FOR UPDATE'));
  assert.ok(lockAt >= 0 && rowLockAt > lockAt, 'superadmin-set lock precedes the row lock');
  assert.equal(wrote(db, /INSERT INTO user_deletion_jobs|INSERT INTO auth_revocations|^\s*UPDATE users/), false);
});

function request(user: { id: string; role: Role; tenantId: string | null; username: string }, input: { params?: Record<string, string>; body?: unknown; locale?: string }): Request {
  return {
    params: input.params ?? {},
    body: input.body ?? {},
    query: {},
    headers: {},
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
    user: { ...user, sessionMode: 'normal' },
    get: (name: string) => (name.toLowerCase() === 'x-ui-locale' ? input.locale : undefined),
  } as unknown as Request;
}

function response() {
  const state: { status: number; json: any } = { status: 200, json: null };
  const res = {
    status: (code: number) => { state.status = code; return res; },
    json: (payload: unknown) => { state.json = payload; return res; },
    setHeader: () => res,
  };
  return { res: res as unknown as Response, state };
}

test('controllers answer authority refusals with a stable code in the request locale', async (t) => {
  const db = fakeDb();
  await installFakeDb(t, db);
  const controller = await import('./users.controller.js');
  const forwarded: unknown[] = [];
  const next: NextFunction = (error?: unknown) => { forwarded.push(error); };

  const staff = actorOf(db, STAFF);
  let out = response();
  await controller.updateController(request(staff, { params: { id: STAFF }, body: { role: 'superadmin' }, locale: 'en' }), out.res, next);
  assert.equal(out.state.status, 403);
  assert.deepEqual(out.state.json, { success: false, code: 'USER_AUTHORITY_SELF_ROLE_CHANGE', message: 'You cannot change the role of your own account.' });

  out = response();
  await controller.createController(request(staff, { body: { username: 'x-user', email: 'x@example.test', password: 'secret1', role: 'learner', tenant_id: TENANT_B } }), out.res, next);
  assert.equal(out.state.status, 403);
  assert.equal(out.state.json.code, 'USER_AUTHORITY_CROSS_TENANT');
  assert.equal(out.state.json.message, 'Bạn chỉ được quản lý tài khoản trong doanh nghiệp của mình.');

  const superuser = actorOf(db, SUPERUSER);
  out = response();
  await controller.deleteController(request(superuser, { params: { id: SUPERUSER }, locale: 'en' }), out.res, next);
  assert.equal(out.state.status, 403);
  assert.equal(out.state.json.code, 'USER_AUTHORITY_SELF_DELETE');

  out = response();
  await controller.assignGroupsController(request(superuser, { params: { id: SUPERUSER }, body: { permission_group_ids: [] }, locale: 'en' }), out.res, next);
  assert.equal(out.state.status, 403);
  assert.equal(out.state.json.code, 'USER_AUTHORITY_SELF_PERMISSION_GROUP_CHANGE');

  out = response();
  await controller.assignGroupsController(request(superuser, { params: { id: SUPERUSER_2 }, body: { permission_group_ids: [] } }), out.res, next);
  assert.equal(out.state.status, 403);
  assert.equal(out.state.json.code, 'USER_AUTHORITY_TARGET_NOT_MANAGEABLE');

  // An allowed deactivation still goes through the audited transaction.
  out = response();
  await controller.updateController(request(superuser, { params: { id: STAFF }, body: { is_active: false } }), out.res, next);
  assert.equal(out.state.status, 200);
  assert.ok(db.calls.some((call) => /INSERT INTO audit_logs/.test(call.sql)));
  assert.deepEqual(forwarded, []);
});

test('every admin user write passes the route permission matrix AND the authority policy', async () => {
  const { readFileSync } = await import('node:fs');
  const routes = readFileSync(new URL('./users.routes.ts', import.meta.url), 'utf8');
  const controller = readFileSync(new URL('./users.controller.ts', import.meta.url), 'utf8');
  const service = readFileSync(new URL('./users.service.ts', import.meta.url), 'utf8');
  const deletion = readFileSync(new URL('./user-deletion.service.ts', import.meta.url), 'utf8');
  // Permission matrix (permission groups) per action; deactivate/activate is PUT → can_edit.
  assert.match(routes, /router\.post\('\/', checkPermission\('account', 'can_add'\), createController\)/);
  assert.match(routes, /router\.put\('\/:id', checkPermission\('account', 'can_edit'\), updateController\)/);
  assert.match(routes, /router\.delete\('\/:id', checkPermission\('account', 'can_delete'\), deleteController\)/);
  assert.match(routes, /router\.put\('\/:id\/permission-groups', authorize\('superuser', 'superadmin'\), assignGroupsController\)/);
  // Authority policy on top, with the caller as subject.
  assert.match(controller, /usersService\.createUser\(parsed\.data, actor\)/);
  assert.match(controller, /usersService\.updateUser\(req\.params\.id, parsed\.data, adminActor\(req\), req\.user!\.tenantId\)/);
  assert.match(controller, /requestUserDeletion\(\s*req\.params\.id,\s*adminActor\(req\),/);
  assert.match(controller, /assertCanAssignUserPermissionGroups\(req\.params\.id, adminActor\(req\), tenantId\)/);
  assert.match(service, /assertCanCreateUser\(actor,/);
  assert.match(service, /assertCanUpdateUser\(actor,/);
  assert.match(deletion, /assertCanDeleteUser\(actor,/);
  // The old ad-hoc deletion ladder and the trusted body tenant are gone.
  assert.doesNotMatch(deletion, /ROLE_LEVEL/);
  assert.doesNotMatch(service, /input\.tenant_id \|\| callerTenantId/);
});
