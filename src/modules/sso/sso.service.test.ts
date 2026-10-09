import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { NextFunction, Request, Response } from 'express';

// SSO account policy against an in-memory pg double and a fake provider.
// No database, Redis or network: every pool query and `fetch` is answered here.
process.env.SSO_CONFIG_ENCRYPTION_KEY ||= 'sso-service-test-only-key';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const SUPERADMIN_A = 'a0000000-0000-4000-8000-000000000001';
const SUPERUSER_B = 'a0000000-0000-4000-8000-000000000002';
const LEARNER_B = 'a0000000-0000-4000-8000-000000000003';
const LINKED_LEARNER_B = 'a0000000-0000-4000-8000-000000000004';
const NEW_USER_ID = 'a0000000-0000-4000-8000-0000000000ff';

type Role = 'learner' | 'learner_plus' | 'staff' | 'superuser' | 'superadmin';
interface UserRow { id: string; username: string; email: string; role: Role; tenant_id: string | null; is_active: boolean }
interface IdentityRow { tenant_id: string; provider: string; provider_subject: string; user_id: string }
interface Call { sql: string; params: unknown[] }

interface FakeDb {
  users: Map<string, UserRow>;
  identities: IdentityRow[];
  extraConfig: Record<string, unknown>;
  calls: Call[];
}

function user(id: string, role: Role, tenant: string | null, username: string, isActive = true): UserRow {
  return { id, username, email: `${username}@example.test`, role, tenant_id: tenant, is_active: isActive };
}

function fakeDb(overrides: Partial<FakeDb> = {}): FakeDb {
  return {
    users: new Map([
      user(SUPERADMIN_A, 'superadmin', TENANT_A, 'root'),
      user(SUPERUSER_B, 'superuser', TENANT_B, 'boss-b'),
      user(LEARNER_B, 'learner', TENANT_B, 'learner-b'),
      user(LINKED_LEARNER_B, 'learner', TENANT_B, 'linked-b'),
    ].map((row) => [row.id, row])),
    identities: [{ tenant_id: TENANT_B, provider: 'keycloak', provider_subject: 'kc-linked', user_id: LINKED_LEARNER_B }],
    extraConfig: { auto_register_enabled: true },
    calls: [],
    ...overrides,
  };
}

async function installFakeDb(t: TestContext, db: FakeDb): Promise<void> {
  const pg = await import('pg');
  const { encryptSecret } = await import('./sso.crypto.js');
  const secret = encryptSecret('provider-secret');
  const handle = async (text: string | { text: string }, params: unknown[] = []) => {
    const sql = typeof text === 'string' ? text : text.text;
    db.calls.push({ sql, params });
    const empty = { rows: [] as unknown[], rowCount: 0 };
    const one = (row: unknown) => ({ rows: [row], rowCount: 1 });

    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) return empty;
    if (sql.includes('FROM tenant_sso_configs') && sql.includes('is_enabled = true')) {
      return one({
        id: 'cfg', tenant_id: params[0], provider: params[1], is_enabled: true, client_id: 'landa',
        client_secret_enc: secret, issuer_url: 'https://idp.example.test/realms/b', authorization_url: null,
        token_url: null, userinfo_url: null, scopes: null, extra_config: db.extraConfig, created_at: '', updated_at: '',
      });
    }
    if (sql.includes('FROM sso_user_identities i') && sql.includes('JOIN users u')) {
      const identity = db.identities.find((row) => row.tenant_id === params[0] && row.provider === params[1] && row.provider_subject === params[2]);
      const linked = identity && db.users.get(identity.user_id);
      return linked ? one({ user_id: linked.id, role: linked.role, is_active: linked.is_active, tenant_id: linked.tenant_id }) : empty;
    }
    if (sql.includes('SELECT user_id') && sql.includes('FROM sso_user_identities')) {
      const identity = db.identities.find((row) => row.tenant_id === params[0] && row.provider === params[1] && row.provider_subject === params[2]);
      return identity ? one({ user_id: identity.user_id }) : empty;
    }
    if (sql.includes('lower(btrim(email)) = $1') && sql.includes('FROM users')) {
      const match = [...db.users.values()].find((row) => row.email === params[0]);
      return match ? one({ id: match.id, tenant_id: match.tenant_id, role: match.role, is_active: match.is_active }) : empty;
    }
    if (/^\s*INSERT INTO sso_user_identities/.test(sql)) {
      db.identities.push({ tenant_id: String(params[0]), user_id: String(params[1]), provider: String(params[2]), provider_subject: String(params[3]) });
      return one({});
    }
    if (/^\s*INSERT INTO users/.test(sql)) {
      db.users.set(NEW_USER_ID, { id: NEW_USER_ID, username: String(params[0]), email: String(params[1]), role: 'learner', tenant_id: String(params[4]), is_active: params[5] === true });
      return one({ id: NEW_USER_ID });
    }
    if (sql.includes('SELECT id FROM users WHERE username')) return empty;
    if (sql.includes('AS quota') || sql.includes('max_users')) return one({ quota: null, current_count: '0', max_users: null, count: '0' });
    if (sql.includes('SELECT domain_admin, domain_learner FROM tenants')) return one({ domain_admin: null, domain_learner: null });
    if (sql.includes('FROM users u') && sql.includes('LEFT JOIN tenants t') && sql.includes('WHERE u.id = $1')) {
      const found = db.users.get(String(params[0]));
      return found ? one({ ...found, full_name: found.username, phone: '', avatar_url: null, tenant_name: 'Tenant', tenant_active: true }) : empty;
    }
    return empty;
  };
  t.mock.method(pg.default.Pool.prototype, 'query', handle);
  t.mock.method(pg.default.Pool.prototype, 'connect', async () => ({ query: handle, release: () => undefined }));
}

function installProvider(t: TestContext, profile: Record<string, unknown>): void {
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/token')) return new Response(JSON.stringify({ access_token: 'provider-access' }), { status: 200 });
    if (url.endsWith('/userinfo')) return new Response(JSON.stringify(profile), { status: 200 });
    return new Response('not found', { status: 404 });
  });
}

const exchangeInput = (tenantId: string) => ({
  tenant_id: tenantId,
  code: 'authorization-code',
  redirect_uri: 'https://learn.example.test/sso-callback.html',
  code_verifier: 'v'.repeat(43),
  client_app: 'learner' as const,
});

async function rejectsWith(promise: Promise<unknown>, code: string, status: number): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    const failure = error as { code?: string; statusCode?: number };
    assert.equal(failure.code, code);
    assert.equal(failure.statusCode, status);
    return true;
  });
}

const linkWrites = (db: FakeDb) => db.calls.filter((call) => /^\s*INSERT INTO sso_user_identities/.test(call.sql));
const sessionWrites = (db: FakeDb) => db.calls.filter((call) => /^\s*INSERT INTO refresh_tokens/.test(call.sql));

test('logic: email_verified accepts true/"true" only; allowlist parsing fails closed', async () => {
  const logic = await import('./sso-account-link.logic.js');
  assert.equal(logic.isEmailVerifiedClaim(true), true);
  assert.equal(logic.isEmailVerifiedClaim('true'), true);
  for (const value of [undefined, null, false, 'false', 'TRUE', 1]) assert.equal(logic.isEmailVerifiedClaim(value), false);
  assert.equal(logic.isEmailExplicitlyUnverified(false), true);
  assert.equal(logic.isEmailExplicitlyUnverified('false'), true);
  assert.equal(logic.isEmailExplicitlyUnverified(undefined), false);

  assert.equal(logic.readAllowedEmailDomains(null), null);
  assert.equal(logic.readAllowedEmailDomains({ auto_register_enabled: true }), null);
  assert.equal(logic.readAllowedEmailDomains({ allowed_email_domains: [] }), null);
  assert.deepEqual(logic.readAllowedEmailDomains({ allowed_email_domains: ['Skale.Global', '@skale.global', 'b.example.test'] }), ['skale.global', 'b.example.test']);
  assert.throws(() => logic.readAllowedEmailDomains({ allowed_email_domains: 'skale.global' }), { code: 'SSO_LOGIN_ALLOWED_DOMAINS_INVALID' });
  assert.throws(() => logic.readAllowedEmailDomains({ allowed_email_domains: ['not a domain'] }), { code: 'SSO_LOGIN_ALLOWED_DOMAINS_INVALID' });
  assert.throws(() => logic.assertEmailDomainAllowed('a@evil.test', { allowed_email_domains: ['skale.global'] }), { code: 'SSO_LOGIN_EMAIL_DOMAIN_NOT_ALLOWED' });
  assert.throws(() => logic.assertEmailDomainAllowed('a@sub.skale.global', { allowed_email_domains: ['skale.global'] }), { code: 'SSO_LOGIN_EMAIL_DOMAIN_NOT_ALLOWED' });
  logic.assertEmailDomainAllowed('a@skale.global', { allowed_email_domains: ['skale.global'] });

  for (const [status, vi, en] of Object.values(logic.SSO_LOGIN_ERRORS)) {
    assert.ok(status >= 400 && status < 600);
    assert.ok(vi && en && (vi as string) !== en);
    for (const text of [vi, en]) assert.doesNotMatch(text, /SSO|token|tenant|\b40\d\b/i);
  }
});

test('(a) an identity already linked in the same tenant signs in unchanged, without email lookup or relinking', async (t) => {
  const db = fakeDb();
  await installFakeDb(t, db);
  installProvider(t, { sub: 'kc-linked', email: 'renamed@example.test' });
  const { exchangeSsoCode } = await import('./sso.service.js');

  const { session, outcome } = await exchangeSsoCode('keycloak', exchangeInput(TENANT_B));
  assert.equal(session.user.id, LINKED_LEARNER_B);
  assert.equal(typeof session.access_token, 'string');
  assert.equal(outcome.linkedExistingAccount, false);
  assert.equal(linkWrites(db).length, 0);
  assert.equal(db.calls.some((call) => call.sql.includes('lower(btrim(email)) = $1')), false);
  assert.equal(sessionWrites(db).length, 1);
});

test('(b) an existing same-tenant account is linked only when the provider verified the email', async (t) => {
  for (const verified of [true, 'true']) {
    const db = fakeDb();
    await installFakeDb(t, db);
    installProvider(t, { sub: `kc-new-${verified}`, email: 'Learner-B@example.test', email_verified: verified });
    const { exchangeSsoCode } = await import('./sso.service.js');
    const { session, outcome } = await exchangeSsoCode('keycloak', exchangeInput(TENANT_B));
    assert.equal(session.user.id, LEARNER_B);
    assert.equal(outcome.linkedExistingAccount, true);
    assert.deepEqual(linkWrites(db).map((call) => [call.params[0], call.params[1]]), [[TENANT_B, LEARNER_B]]);
    t.mock.restoreAll();
  }

  for (const verified of [undefined, false, 'false', 'yes']) {
    const db = fakeDb();
    await installFakeDb(t, db);
    installProvider(t, { sub: 'kc-unverified', email: 'boss-b@example.test', ...(verified === undefined ? {} : { email_verified: verified }) });
    const { exchangeSsoCode } = await import('./sso.service.js');
    // Explicit false keeps the historical refusal; missing/other values now refuse linking.
    const expected = verified === false || verified === 'false' ? 'Email SSO chưa được xác minh' : null;
    await assert.rejects(exchangeSsoCode('keycloak', exchangeInput(TENANT_B)), (error: unknown) => {
      const failure = error as { code?: string; message?: string; statusCode?: number };
      if (expected) assert.equal(failure.message, expected);
      else assert.equal(failure.code, 'SSO_LOGIN_EMAIL_NOT_VERIFIED');
      assert.equal(failure.statusCode, 403);
      return true;
    });
    assert.equal(linkWrites(db).length, 0);
    assert.equal(sessionWrites(db).length, 0);
    t.mock.restoreAll();
  }
});

test('a superadmin of tenant A can never be reached through tenant B\'s provider, even with a verified email', async (t) => {
  const db = fakeDb();
  await installFakeDb(t, db);
  installProvider(t, { sub: 'kc-attacker', email: 'root@example.test', email_verified: true });
  const { exchangeSsoCode } = await import('./sso.service.js');

  await rejectsWith(exchangeSsoCode('keycloak', exchangeInput(TENANT_B)), 'SSO_LOGIN_OTHER_ORGANIZATION', 403);
  assert.equal(linkWrites(db).length, 0);
  assert.equal(sessionWrites(db).length, 0);
});

test('a link created earlier for an account of another tenant stops working', async (t) => {
  const db = fakeDb({
    identities: [{ tenant_id: TENANT_B, provider: 'keycloak', provider_subject: 'kc-old-root', user_id: SUPERADMIN_A }],
  });
  await installFakeDb(t, db);
  installProvider(t, { sub: 'kc-old-root', email: 'root@example.test', email_verified: true });
  const { exchangeSsoCode } = await import('./sso.service.js');

  await rejectsWith(exchangeSsoCode('keycloak', exchangeInput(TENANT_B)), 'SSO_LOGIN_OTHER_ORGANIZATION', 403);
  assert.equal(sessionWrites(db).length, 0);
});

test('(c) new learners follow the tenant auto-registration setting; a missing email_verified still creates', async (t) => {
  {
    const db = fakeDb();
    await installFakeDb(t, db);
    installProvider(t, { sub: 'kc-brand-new', email: 'newcomer@example.test', name: 'New Comer' });
    const { exchangeSsoCode } = await import('./sso.service.js');
    const { session, outcome } = await exchangeSsoCode('keycloak', exchangeInput(TENANT_B));
    assert.equal(session.user.id, NEW_USER_ID);
    assert.equal(outcome.linkedExistingAccount, false);
    const insert = db.calls.find((call) => /^\s*INSERT INTO users/.test(call.sql))!;
    assert.deepEqual([insert.params[4], insert.params[5]], [TENANT_B, true]);
    t.mock.restoreAll();
  }
  {
    const db = fakeDb({ extraConfig: {} });
    await installFakeDb(t, db);
    installProvider(t, { sub: 'kc-pending', email: 'pending@example.test', email_verified: true });
    const { exchangeSsoCode } = await import('./sso.service.js');
    await assert.rejects(exchangeSsoCode('keycloak', exchangeInput(TENANT_B)), { statusCode: 403 });
    const insert = db.calls.find((call) => /^\s*INSERT INTO users/.test(call.sql))!;
    assert.deepEqual([insert.params[4], insert.params[5]], [TENANT_B, false]);
    assert.equal(sessionWrites(db).length, 0);
  }
});

test('allowed_email_domains refuses other domains only when configured', async (t) => {
  const db = fakeDb({ extraConfig: { auto_register_enabled: true, allowed_email_domains: ['skale.global'] } });
  await installFakeDb(t, db);
  installProvider(t, { sub: 'kc-linked', email: 'linked-b@example.test' });
  const { exchangeSsoCode } = await import('./sso.service.js');
  await rejectsWith(exchangeSsoCode('keycloak', exchangeInput(TENANT_B)), 'SSO_LOGIN_EMAIL_DOMAIN_NOT_ALLOWED', 403);
  assert.equal(sessionWrites(db).length, 0);
});

test('provider calls are aborted after the timeout with a plain retry message', async (t) => {
  const db = fakeDb();
  await installFakeDb(t, db);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(globalThis, 'fetch', (_input: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  }));
  const { exchangeSsoCode, SSO_PROVIDER_TIMEOUT_MS } = await import('./sso.service.js');
  assert.equal(SSO_PROVIDER_TIMEOUT_MS, 15_000);

  const pending = exchangeSsoCode('keycloak', exchangeInput(TENANT_B));
  for (let i = 0; i < 20 && !(globalThis.fetch as unknown as { mock: { callCount(): number } }).mock.callCount(); i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  t.mock.timers.tick(SSO_PROVIDER_TIMEOUT_MS);
  await rejectsWith(pending, 'SSO_LOGIN_PROVIDER_TIMEOUT', 504);
});

test('controller: refusals answer a stable code in the request locale; success keeps the plain session body', async (t) => {
  const db = fakeDb();
  await installFakeDb(t, db);
  installProvider(t, { sub: 'kc-attacker', email: 'root@example.test', email_verified: true });
  const { exchangeController } = await import('./sso.controller.js');

  const respond = () => {
    const out: { status?: number; body?: Record<string, unknown> } = {};
    const res = {
      status(code: number) { out.status = code; return this; },
      json(body: Record<string, unknown>) { out.body = body; return this; },
    } as unknown as Response;
    return { out, res };
  };
  const request = (locale: string) => ({
    params: { provider: 'keycloak' },
    body: exchangeInput(TENANT_B),
    get: (name: string) => (name.toLowerCase() === 'x-ui-locale' ? locale : undefined),
  }) as unknown as Request;

  const en = respond();
  let forwarded: unknown;
  await exchangeController(request('en'), en.res, ((err: unknown) => { forwarded = err; }) as NextFunction);
  assert.equal(forwarded, undefined);
  assert.equal(en.out.status, 403);
  assert.equal(en.out.body?.code, 'SSO_LOGIN_OTHER_ORGANIZATION');
  assert.match(String(en.out.body?.message), /sign in with your password/);

  t.mock.restoreAll();
  const okDb = fakeDb();
  await installFakeDb(t, okDb);
  installProvider(t, { sub: 'kc-linked', email: 'linked-b@example.test' });
  const ok = respond();
  await exchangeController({ ...request('vi'), ip: '127.0.0.1', socket: {} } as unknown as Request, ok.res, (() => undefined) as NextFunction);
  assert.equal(ok.out.status, 200);
  const data = ok.out.body?.data as Record<string, unknown>;
  for (const key of ['access_token', 'refresh_token', 'expires_in', 'user', 'permissions']) assert.ok(key in data, key);
  assert.equal('outcome' in data || 'session' in data, false);
  // A routine learner sign-in through an existing link is not audited.
  assert.equal(okDb.calls.some((call) => /INSERT INTO audit_logs/.test(call.sql)), false);

  t.mock.restoreAll();
  const linkDb = fakeDb();
  await installFakeDb(t, linkDb);
  installProvider(t, { sub: 'kc-first-link', email: 'learner-b@example.test', email_verified: true });
  const linked = respond();
  await exchangeController({ ...request('vi'), ip: '127.0.0.1', socket: {} } as unknown as Request, linked.res, (() => undefined) as NextFunction);
  assert.equal(linked.out.status, 200);
  const audits = linkDb.calls.filter((call) => /INSERT INTO audit_logs/.test(call.sql));
  assert.deepEqual(audits.map((call) => [call.params[0], call.params[11]]), [[TENANT_B, 'auth.sso_identity.linked']]);
});
