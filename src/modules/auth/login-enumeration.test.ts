import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { Request, Response } from 'express';
import { hashPassword } from '../../utils/password.js';
import { AUTH_LOGIN_ERRORS } from './auth-login-error.logic.js';

// S2 T15: password sign-in never tells whether an account exists. In-memory
// pg double, no network.

const TENANT = '11111111-1111-4111-8111-111111111111';

interface FakeUser { id: string; username: string; email: string; role: string; is_active: boolean; tenant_id: string; password_hash: string }

async function installUsers(t: TestContext, users: FakeUser[]): Promise<void> {
  const pg = await import('pg');
  t.mock.method(pg.default.Pool.prototype, 'query', async (text: string | { text: string }, params: unknown[] = []) => {
    const sql = typeof text === 'string' ? text : text.text;
    if (sql.includes('FROM users u') && sql.includes('LEFT JOIN tenants t')) {
      const byEmail = sql.includes('lower(btrim(u.email))');
      const user = users.find((u) => (byEmail ? u.email.toLowerCase() === params[0] : u.username === params[0]));
      return user
        ? { rows: [{ ...user, full_name: user.username, tenant_name: 'A', tenant_active: true }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  });
}

async function attempt(username: string, password: string, locale = 'vi') {
  const { loginController } = await import('./auth.controller.js');
  const out: { status?: number; body?: { code?: string; message?: string } } = {};
  const res = {
    status(code: number) { out.status = code; return this; },
    json(body: unknown) { out.body = body as typeof out.body; return this; },
  } as unknown as Response;
  const req = {
    body: { username, password, client_app: 'learner' },
    headers: {},
    get: (name: string) => (name.toLowerCase() === 'x-ui-locale' ? locale : undefined),
  } as unknown as Request;
  let forwarded: unknown;
  await loginController(req, res, (err?: unknown) => { forwarded = err; });
  assert.equal(forwarded, undefined, 'login refusals are answered by the controller');
  return out;
}

test('unknown account, wrong password and disabled account with a wrong password answer the same', async (t) => {
  const hash = await hashPassword('correct-horse');
  await installUsers(t, [
    { id: 'a0000000-0000-4000-8000-000000000001', username: 'active', email: 'active@example.com', role: 'learner', is_active: true, tenant_id: TENANT, password_hash: hash },
    { id: 'a0000000-0000-4000-8000-000000000002', username: 'disabled', email: 'disabled@example.com', role: 'learner', is_active: false, tenant_id: TENANT, password_hash: hash },
  ]);

  const unknown = await attempt('nobody', 'whatever');
  const wrong = await attempt('active', 'whatever');
  const disabledWrong = await attempt('disabled', 'whatever');
  for (const result of [unknown, wrong, disabledWrong]) {
    assert.equal(result.status, 401);
    assert.equal(result.body?.code, 'AUTH_INVALID_CREDENTIALS');
    assert.equal(result.body?.message, AUTH_LOGIN_ERRORS.INVALID_CREDENTIALS[1]);
  }

  const english = await attempt('nobody@example.com', 'whatever', 'en');
  assert.equal(english.body?.message, AUTH_LOGIN_ERRORS.INVALID_CREDENTIALS[2]);
});

test('a disabled account is reported only after the correct password', async (t) => {
  const hash = await hashPassword('correct-horse');
  await installUsers(t, [
    { id: 'a0000000-0000-4000-8000-000000000002', username: 'disabled', email: 'disabled@example.com', role: 'learner', is_active: false, tenant_id: TENANT, password_hash: hash },
  ]);
  const result = await attempt('disabled', 'correct-horse', 'en');
  assert.equal(result.status, 403);
  assert.equal(result.body?.code, 'AUTH_ACCOUNT_DISABLED');
  assert.equal(result.body?.message, AUTH_LOGIN_ERRORS.ACCOUNT_DISABLED[2]);
});

test('an unknown account still runs a full password comparison', async (t) => {
  const bcrypt = (await import('bcrypt')).default;
  await installUsers(t, []);
  const compare = t.mock.method(bcrypt, 'compare');
  await attempt('nobody', 'whatever');
  assert.equal(compare.mock.callCount(), 1);
});
