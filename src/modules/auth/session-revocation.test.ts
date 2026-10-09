import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { NextFunction, Request, Response } from 'express';

// S1 C6: a password change/reset, a deactivation or a role change ends every
// session durably (refresh tokens + access tokens issued before it). In-memory
// pg double, no Redis (REDIS_URL is empty in the test env), no network.

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const SUPERUSER = 'a0000000-0000-4000-8000-000000000001';
const LEARNER = 'a0000000-0000-4000-8000-000000000002';

interface Revocation { reason: string; revoked_at: Date; expires_at: Date }
interface RefreshRow { id: string; user_id: string; token_hash: string; revoked: boolean; revoked_at: Date | null }
interface FakeDb {
  calls: Array<{ sql: string; params: unknown[] }>;
  revocations: Map<string, Revocation>;
  refreshTokens: RefreshRow[];
}

function fakeDb(): FakeDb {
  return { calls: [], revocations: new Map(), refreshTokens: [] };
}

const users: Record<string, { id: string; username: string; role: string; tenant_id: string; is_active: boolean; password_hash?: string }> = {
  [SUPERUSER]: { id: SUPERUSER, username: 'admin', role: 'superuser', tenant_id: TENANT_A, is_active: true },
  [LEARNER]: { id: LEARNER, username: 'learner', role: 'learner', tenant_id: TENANT_A, is_active: true },
};

async function installFakeDb(t: TestContext, db: FakeDb): Promise<void> {
  const pg = await import('pg');
  const handle = async (text: string | { text: string }, params: unknown[] = []) => {
    const sql = typeof text === 'string' ? text : text.text;
    db.calls.push({ sql, params });
    const empty = { rows: [] as unknown[], rowCount: 0 };
    const one = (row: unknown) => ({ rows: [row], rowCount: 1 });
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql) || sql.includes('pg_advisory_xact_lock')) return empty;
    if (/^\s*INSERT INTO auth_revocations/.test(sql)) {
      const current = db.revocations.get(String(params[0]));
      if (current?.reason === params[4]) return empty; // permanent deletion is never downgraded
      const revokedAt = params[1] as Date;
      const expiresAt = params[2] as Date;
      db.revocations.set(String(params[0]), {
        reason: String(params[3]),
        revoked_at: current && current.revoked_at > revokedAt ? current.revoked_at : revokedAt,
        expires_at: current && current.expires_at > expiresAt ? current.expires_at : expiresAt,
      });
      return one({});
    }
    if (/^\s*UPDATE refresh_tokens/.test(sql) && sql.includes('revoked = false')) {
      let count = 0;
      for (const row of db.refreshTokens) {
        if (row.user_id === params[0] && !row.revoked) { row.revoked = true; row.revoked_at = (params[1] as Date) ?? new Date(); count += 1; }
      }
      return { rows: [], rowCount: count };
    }
    if (sql.includes('FROM auth_revocations') && sql.includes('expires_at > now()') && !sql.includes('refresh_tokens')) {
      const row = db.revocations.get(String(params[0]));
      return row && row.expires_at.getTime() > Date.now() ? one(row) : empty;
    }
    if (sql.includes('FROM refresh_tokens rt') && sql.includes('FOR UPDATE OF rt')) {
      const token = db.refreshTokens.find((row) => row.token_hash === params[0]);
      if (!token) return empty;
      const owner = users[token.user_id];
      const revocation = db.revocations.get(token.user_id);
      return one({
        rt_id: token.id, user_id: token.user_id, revoked: token.revoked, revoked_at: token.revoked_at,
        expires_at: new Date(Date.now() + 3_600_000), session_id: null, session_mode: 'normal',
        ...owner, email: '', full_name: '', phone: '', avatar_url: null, tenant_name: 'A', tenant_active: true,
        session_revoked_at: revocation?.revoked_at ?? null,
      });
    }
    if (sql.includes('SELECT password_hash FROM users')) return one({ password_hash: users[String(params[0])]?.password_hash });
    if (/^\s*SELECT id, role, tenant_id, is_active\s+FROM users/.test(sql)) {
      const found = users[String(params[0])];
      return found ? one({ id: found.id, role: found.role, tenant_id: found.tenant_id, is_active: found.is_active }) : empty;
    }
    if (/^\s*SELECT id\s+FROM users\s+WHERE id = \$1\s+AND deletion_requested_at IS NULL/.test(sql)) return one({ id: params[0] });
    if (/^\s*UPDATE users SET/.test(sql) && sql.includes('RETURNING')) {
      const found = users[String(params[params.length - 4])];
      return found ? one({ ...found }) : empty;
    }
    if (sql.includes('FROM users u') && sql.includes('LEFT JOIN tenants t') && sql.includes('WHERE u.id = $1')) {
      const found = users[String(params[0])];
      return found ? one({ ...found, email: '', full_name: '', phone: '', avatar_url: null, tenant_name: 'A', tenant_active: true }) : empty;
    }
    return empty;
  };
  t.mock.method(pg.default.Pool.prototype, 'query', handle);
  t.mock.method(pg.default.Pool.prototype, 'connect', async () => ({ query: handle, release: () => undefined }));
}

const revocationWrites = (db: FakeDb) => db.calls.filter((call) => /INSERT INTO auth_revocations/.test(call.sql));

test('isRevokedForIssuedAt: deletion refuses all; a session end refuses tokens issued before its second', async () => {
  const { isRevokedForIssuedAt } = await import('./auth-revocation.service.js');
  const at = Date.UTC(2026, 9, 9, 10, 0, 0, 700);
  const second = Math.floor(at / 1000);
  assert.equal(isRevokedForIssuedAt(null, second), false);
  assert.equal(isRevokedForIssuedAt({ full: true, revokedAtMs: at }, second + 999), true);
  assert.equal(isRevokedForIssuedAt({ full: false, revokedAtMs: at }, second - 1), true);
  assert.equal(isRevokedForIssuedAt({ full: false, revokedAtMs: at }, second), false);
  assert.equal(isRevokedForIssuedAt({ full: false, revokedAtMs: at }, undefined), true);
});

test('authenticate refuses an access token issued before the session end and accepts a newer one', async (t) => {
  const db = fakeDb();
  await installFakeDb(t, db);
  const jwt = (await import('jsonwebtoken')).default;
  const { env } = await import('../../config/env.js');
  const { authenticate } = await import('../../middleware/authenticate.js');

  const now = Math.floor(Date.now() / 1000);
  db.revocations.set(LEARNER, { reason: 'password_changed', revoked_at: new Date(now * 1000), expires_at: new Date(Date.now() + 86_400_000) });
  const sign = (iat: number) => jwt.sign({ sub: LEARNER, tid: TENANT_A, role: 'learner', username: 'learner', iat }, env.JWT_SECRET, { expiresIn: 900 });

  const run = async (token: string) => {
    const out: { status?: number; next?: boolean } = {};
    const res = { status(code: number) { out.status = code; return this; }, json() { return this; } } as unknown as Response;
    await authenticate({ headers: { authorization: `Bearer ${token}` } } as unknown as Request, res, (() => { out.next = true; }) as NextFunction);
    return out;
  };
  assert.equal((await run(sign(now - 60))).status, 401);
  assert.equal((await run(sign(now))).next, true);
  assert.equal((await run(sign(now + 1))).next, true);
});

test('admin reset, deactivation and role change end sessions; a plain edit does not', async (t) => {
  const db = fakeDb();
  await installFakeDb(t, db);
  db.refreshTokens.push({ id: 'rt1', user_id: LEARNER, token_hash: 'h1', revoked: false, revoked_at: null });
  const { updateUser, adminUpdateEndsSessions } = await import('../users/users.service.js');
  const actor = { id: SUPERUSER, username: 'admin', role: 'superuser' as const, tenantId: TENANT_A };

  await updateUser(LEARNER, { full_name: 'Renamed' }, actor, TENANT_A);
  assert.equal(revocationWrites(db).length, 0);

  for (const [input, reason] of [
    [{ password: 'new-secret-1' }, 'password_reset_by_admin'],
    [{ is_active: false }, 'account_deactivated'],
    [{ role: 'learner_plus' as const }, 'role_changed'],
  ] as const) {
    db.calls.length = 0;
    await updateUser(LEARNER, input, actor, TENANT_A);
    assert.deepEqual(revocationWrites(db).map((call) => call.params[3]), [reason]);
    const tokenUpdate = db.calls.find((call) => /UPDATE refresh_tokens/.test(call.sql))!;
    assert.match(tokenUpdate.sql, /revoked_at = \$2::timestamptz/);
    assert.equal(adminUpdateEndsSessions(input, 'learner'), true);
  }
  assert.equal(db.refreshTokens[0].revoked, true);
  assert.ok(db.refreshTokens[0].revoked_at instanceof Date);
  assert.equal(adminUpdateEndsSessions({ full_name: 'x' }, 'learner'), false);
  assert.equal(adminUpdateEndsSessions({ role: 'learner' }, 'learner'), false);
});

test('self-service password change ends other sessions and returns a fresh one that keeps working', async (t) => {
  const db = fakeDb();
  await installFakeDb(t, db);
  const { hashPassword } = await import('../../utils/password.js');
  users[LEARNER].password_hash = await hashPassword('old-password');
  db.refreshTokens.push({ id: 'rt-other-device', user_id: LEARNER, token_hash: 'other', revoked: false, revoked_at: null });
  const auth = await import('./auth.service.js');

  const session = await auth.changePassword(LEARNER, 'old-password', 'new-password');
  assert.equal(typeof session.access_token, 'string');
  assert.equal(typeof session.refresh_token, 'string');
  assert.deepEqual(revocationWrites(db).map((call) => call.params[3]), ['password_changed']);
  assert.equal(db.refreshTokens[0].revoked, true);
  // The fresh refresh token is written after the revocation, so it is not revoked.
  const revokeAt = db.calls.findIndex((call) => /UPDATE refresh_tokens/.test(call.sql));
  const freshAt = db.calls.findIndex((call) => /INSERT INTO refresh_tokens/.test(call.sql));
  assert.ok(revokeAt >= 0 && freshAt > revokeAt);

  const jwt = (await import('jsonwebtoken')).default;
  const { isAccessTokenRevoked } = await import('./auth-revocation.service.js');
  const iat = (jwt.decode(session.access_token) as { iat: number }).iat;
  assert.equal(await isAccessTokenRevoked(LEARNER, iat), false);
  assert.equal(await isAccessTokenRevoked(LEARNER, iat - 5), true);
});

test('reusing a refresh token ended by a session revocation is refused without revoking newer sessions', async (t) => {
  const db = fakeDb();
  await installFakeDb(t, db);
  const { createHash } = await import('node:crypto');
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const endedAt = new Date(Date.now() - 60_000);
  db.revocations.set(LEARNER, { reason: 'password_changed', revoked_at: endedAt, expires_at: new Date(Date.now() + 86_400_000) });
  db.refreshTokens.push(
    { id: 'old', user_id: LEARNER, token_hash: hash('old-device'), revoked: true, revoked_at: endedAt },
    { id: 'fresh', user_id: LEARNER, token_hash: hash('fresh'), revoked: false, revoked_at: null },
  );
  const { refresh } = await import('./auth.service.js');

  await assert.rejects(refresh('old-device'), { statusCode: 401 });
  assert.equal(db.refreshTokens[1].revoked, false);
  assert.equal(db.calls.some((call) => /UPDATE refresh_tokens SET revoked = true, revoked_at = COALESCE/.test(call.sql)), false);
});
