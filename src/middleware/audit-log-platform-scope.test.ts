import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { Request } from 'express';
import {
  answers,
  callHandler,
  installDb,
  noRowsWhen,
  rowsWhen,
  type Answer,
  type Handler,
  type Statement,
} from '../test-support/staff-sql-characterization.js';

// A Super Admin manages every tenant. With no tenant selected (or acting on an
// account that belongs to none) its audited writes used to be refused with
// "Audit log thiếu doanh nghiệp sở hữu" and rolled back: retrying a user
// deletion job, updating a user without a tenant, creating or updating a
// module. They now write a platform event (no tenant, superadmin_only). With a
// tenant selected nothing changes, and anyone else without a tenant is still
// refused. pg double; no database, no Redis, no RabbitMQ.

process.env.REDIS_URL = 'redis://127.0.0.1:1';

const redis = await import('../config/redis.js');
const { pool } = await import('../config/database.js');
const audit = await import('./audit-log.js');
const users = await import('../modules/users/users.controller.js');
const modules = await import('../modules/modules/modules.controller.js');

redis.installRedisClient(null);

test.after(async () => {
  await pool.end();
});

const TENANT = '11111111-1111-4111-8111-111111111111';
const ACTOR = 'a0000000-0000-4000-8000-000000000001';
const TARGET = 'a0000000-0000-4000-8000-000000000002';
const JOB = 'd0000000-0000-4000-8000-000000000001';
const MODULE = 'c0000000-0000-4000-8000-000000000001';
const REFUSED = 'Audit log thiếu doanh nghiệp sở hữu';

/** One row with every column these statements read. */
const ROW = {
  id: TARGET,
  user_id: TARGET,
  username: 'staff02',
  email: 'staff02@example.test',
  full_name: 'Nhân viên',
  role: 'staff',
  is_active: true,
  tenant_id: TENANT,
  status: 'queued',
  is_terminal: false,
  attempts: 0,
  code: 'news',
  name: 'Bảng tin',
  description: 'Tin tức',
  icon: 'Newspaper',
  sort_order: 4,
  created_at: '2026-01-01T00:00:00.000Z',
  exists: false,
  count: 2,
  session_version: 1,
  token_version: 1,
};

const NOT_DEMO = noRowsWhen(/tenant_demo_iframe_settings/);
const FREE = noRowsWhen(/^\s*SELECT id\s+FROM (users\s+WHERE (username = \$1|btrim\(email\))|modules WHERE code)/);

type Actor = { role: string; tenantId: string | null };

async function run(t: TestContext, handler: Handler, actor: Actor, body: unknown, params: Record<string, string>, answer?: Answer) {
  t.mock.method(console, 'error', () => undefined);
  t.mock.method(console, 'warn', () => undefined);
  const statements = installDb(t, pool, ROW, answers(NOT_DEMO, FREE, ...(answer ? [answer] : [])));
  const outcome = (await callHandler(handler, {
    user: { id: ACTOR, tenantId: actor.tenantId, role: actor.role, username: 'root', sessionMode: 'normal' },
    params,
    query: {},
    body,
    originalUrl: '/api/test',
    get: () => undefined,
    headers: {},
    ip: '127.0.0.1',
  })) as { status?: number; next?: { message: string } };
  return { outcome, statements };
}

/** The audit row the request wrote: [tenant_id, is_platform_event, viewer_scope], or null. */
function auditRow(statements: Statement[]): [unknown, unknown, unknown] | null {
  const insert = statements.find(statement => /INSERT INTO audit_logs/.test(statement.text));
  return insert ? [insert.params[0], insert.params[1], insert.params[14]] : null;
}

const committed = (statements: Statement[]) => statements.some(statement => /^\s*COMMIT/.test(statement.text));
const rolledBack = (statements: Statement[]) => statements.some(statement => /^\s*ROLLBACK/.test(statement.text));

const SUPERADMIN_NO_TENANT: Actor = { role: 'superadmin', tenantId: null };
const SUPERADMIN_IN_TENANT: Actor = { role: 'superadmin', tenantId: TENANT };

test('platformScopeForSuperadmin turns only a Super Admin entry without a tenant into a platform event', () => {
  const req = (role: string) => ({ user: { role } }) as unknown as Request;
  const entry = { action: 'UPDATE' as const, entityType: 'module', event: { code: 'system_module.updated' } };
  assert.deepEqual(audit.platformScopeForSuperadmin(req('superadmin'), { ...entry, tenantId: null }), {
    ...entry,
    tenantId: null,
    platformEvent: true,
  });
  assert.deepEqual(audit.platformScopeForSuperadmin(req('superadmin'), { ...entry, tenantId: TENANT }), {
    ...entry,
    tenantId: TENANT,
  });
  for (const role of ['superuser', 'staff', 'learner']) {
    assert.deepEqual(audit.platformScopeForSuperadmin(req(role), { ...entry, tenantId: null }), { ...entry, tenantId: null });
  }
  assert.deepEqual(audit.platformScopeForSuperadmin({} as Request, { ...entry, tenantId: undefined }), {
    ...entry,
    tenantId: undefined,
  });
});

test('a Super Admin retries a deletion job with or without a tenant; anyone else needs a tenant', async t => {
  const params = { jobId: JOB };
  const none = await run(t, users.retryDeletionJobController, SUPERADMIN_NO_TENANT, {}, params);
  assert.equal(none.outcome.status, 202);
  assert.deepEqual(auditRow(none.statements), [null, true, 'superadmin_only']);
  assert.ok(committed(none.statements));
  t.mock.restoreAll();

  const inTenant = await run(t, users.retryDeletionJobController, SUPERADMIN_IN_TENANT, {}, params);
  assert.equal(inTenant.outcome.status, 202);
  assert.equal(auditRow(inTenant.statements)?.[0], TENANT);
  assert.equal(auditRow(inTenant.statements)?.[1], false);
  t.mock.restoreAll();

  const superuser = await run(t, users.retryDeletionJobController, { role: 'superuser', tenantId: null }, {}, params);
  assert.equal(superuser.outcome.next?.message, REFUSED);
  assert.equal(auditRow(superuser.statements), null);
  assert.ok(rolledBack(superuser.statements));
});

test('a Super Admin updates a user without a tenant; anyone else is refused, and a tenant user stays tenant-owned', async t => {
  const params = { id: TARGET };
  const noTenantTarget: Answer = text =>
    /FROM users/.test(text) && !/COUNT\(\*\)/.test(text) ? { rows: [{ ...ROW, tenant_id: null }] } : undefined;

  const none = await run(t, users.updateController, SUPERADMIN_NO_TENANT, { full_name: 'Tên mới' }, params, noTenantTarget);
  assert.equal(none.outcome.status, 200, JSON.stringify(none.outcome).slice(0, 200));
  assert.deepEqual(auditRow(none.statements), [null, true, 'superadmin_only']);
  assert.ok(committed(none.statements));
  t.mock.restoreAll();

  const tenantTarget = await run(t, users.updateController, SUPERADMIN_NO_TENANT, { full_name: 'Tên mới' }, params);
  assert.equal(tenantTarget.outcome.status, 200);
  assert.equal(auditRow(tenantTarget.statements)?.[0], TENANT);
  assert.equal(auditRow(tenantTarget.statements)?.[1], false);
  t.mock.restoreAll();

  // A Super User never reaches the audit: the authority policy refuses an account outside its tenant first.
  const superuser = await run(t, users.updateController, { role: 'superuser', tenantId: TENANT }, { full_name: 'Tên mới' }, params, noTenantTarget);
  assert.equal(superuser.outcome.status, 403);
  assert.equal((superuser.outcome as { body?: { code?: string } }).body?.code, 'USER_AUTHORITY_CROSS_TENANT');
  assert.equal(auditRow(superuser.statements), null);
  assert.ok(!committed(superuser.statements));
  t.mock.restoreAll();

  // The audit rule itself still refuses a non-Super Admin entry without a tenant.
  const entry = audit.platformScopeForSuperadmin({ user: { role: 'superuser' } } as unknown as Request, {
    tenantId: null,
    action: 'UPDATE',
    entityType: 'user',
    event: { code: 'user.updated' },
  });
  installDb(t, pool, ROW);
  const client = await pool.connect();
  await assert.rejects(audit.appendAuditLog(client, entry), { message: REFUSED });
  client.release();
});

test('a Super Admin deletes an account without a tenant; anyone else is refused, and a tenant account stays tenant-owned', async t => {
  const params = { id: TARGET };
  const newJob = noRowsWhen(/FROM user_deletion_jobs\s+WHERE user_id = \$1::uuid\s+AND status IN/);
  const tenantless = (role: string): Answer => text =>
    /FROM users/.test(text) && !/COUNT\(\*\)/.test(text) ? { rows: [{ ...ROW, role, tenant_id: null }] } : undefined;

  // Another Super Admin (not the last active one) and an account of another role, both without a tenant.
  for (const role of ['superadmin', 'staff']) {
    for (const actor of [SUPERADMIN_NO_TENANT, SUPERADMIN_IN_TENANT]) {
      const deleted = await run(t, users.deleteController, actor, {}, params, answers(newJob, tenantless(role)));
      assert.equal(deleted.outcome.status, 202, `${role} ${actor.tenantId}: ${JSON.stringify(deleted.outcome).slice(0, 200)}`);
      assert.deepEqual(auditRow(deleted.statements), [null, true, 'superadmin_only']);
      assert.ok(committed(deleted.statements));
      t.mock.restoreAll();
    }
  }

  const tenantTarget = await run(t, users.deleteController, SUPERADMIN_NO_TENANT, {}, params, newJob);
  assert.equal(tenantTarget.outcome.status, 202);
  assert.equal(auditRow(tenantTarget.statements)?.[0], TENANT);
  assert.equal(auditRow(tenantTarget.statements)?.[1], false);
  t.mock.restoreAll();

  // A Super User never reaches the audit: the authority policy refuses an account outside its tenant first.
  for (const [actor, code] of [
    [{ role: 'superuser', tenantId: TENANT }, 'USER_AUTHORITY_CROSS_TENANT'],
    [{ role: 'superuser', tenantId: null }, 'USER_AUTHORITY_TENANT_REQUIRED'],
  ] as Array<[Actor, string]>) {
    const refused = await run(t, users.deleteController, actor, {}, params, answers(newJob, tenantless('staff')));
    assert.equal(refused.outcome.status, 403);
    assert.equal((refused.outcome as { body?: { code?: string } }).body?.code, code);
    assert.equal(auditRow(refused.statements), null);
    assert.ok(!committed(refused.statements));
    assert.ok(rolledBack(refused.statements));
    t.mock.restoreAll();
  }
});

test('a Super Admin creates and updates modules with or without a tenant selected', async t => {
  const body = { code: 'faq', name: 'FAQ' };
  const created = await run(t, modules.createController, SUPERADMIN_NO_TENANT, body, {});
  assert.equal(created.outcome.status, 201);
  assert.deepEqual(auditRow(created.statements), [null, true, 'superadmin_only']);
  t.mock.restoreAll();

  const updated = await run(t, modules.updateController, SUPERADMIN_NO_TENANT, { name: 'Tin tức' }, { id: MODULE }, rowsWhen(/FOR UPDATE/, [ROW]));
  assert.equal(updated.outcome.status, 200);
  assert.deepEqual(auditRow(updated.statements), [null, true, 'superadmin_only']);
  t.mock.restoreAll();

  const inTenant = await run(t, modules.createController, SUPERADMIN_IN_TENANT, body, {});
  assert.equal(inTenant.outcome.status, 201);
  assert.equal(auditRow(inTenant.statements)?.[0], TENANT);
  assert.equal(auditRow(inTenant.statements)?.[1], false);
});
