import assert from 'node:assert/strict';
import test from 'node:test';
import type { NextFunction, Request, Response } from 'express';

// S1 C3: GET /api/users/profile/:username returns only the caller's own
// profile, whatever username is requested. In-memory pg double.

const ROOT = { id: 'a0000000-0000-4000-8000-000000000001', username: 'root', email: 'root@example.test', role: 'superadmin', tenant_id: null };
const LEARNER = { id: 'a0000000-0000-4000-8000-000000000002', username: 'learner-b', email: 'learner@example.test', role: 'learner', tenant_id: '22222222-2222-4222-8222-222222222222' };

test('a learner asking for another username still receives only their own profile', async (t) => {
  const pg = await import('pg');
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  t.mock.method(pg.default.Pool.prototype, 'query', async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    const byId = /WHERE u\.id = \$1/.test(sql);
    const match = [ROOT, LEARNER].find((user) => (byId ? user.id : user.username) === params[0]);
    return match ? { rows: [match], rowCount: 1 } : { rows: [], rowCount: 0 };
  });
  const { getProfileController } = await import('./users.controller.js');

  let body: { data?: { id?: string; email?: string } } | undefined;
  const res = { status() { return this; }, json(value: typeof body) { body = value; return this; } } as unknown as Response;
  let forwarded: unknown;
  await getProfileController(
    { params: { username: 'root' }, user: { id: LEARNER.id, username: LEARNER.username, role: 'learner', tenantId: LEARNER.tenant_id } } as unknown as Request,
    res,
    ((err: unknown) => { forwarded = err; }) as NextFunction,
  );

  assert.equal(forwarded, undefined);
  assert.equal(body?.data?.id, LEARNER.id);
  assert.notEqual(body?.data?.email, ROOT.email);
  assert.deepEqual(calls.map((call) => call.params), [[LEARNER.id]]);
});
