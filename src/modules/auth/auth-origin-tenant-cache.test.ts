import assert from 'node:assert/strict';
import test, { mock, type TestContext } from 'node:test';
import { CHARACTERIZATION_NOW as NOW, installDb } from '../../test-support/auth-sql-characterization.js';

// The tenant of a sign-in origin: login looks it up (tenants by domain) and
// caches the answer per process. The origin is chosen by the client, so the
// cache is bounded, forgets "no tenant" after a short time and never keeps an
// origin that is too long or not a URL origin. The answer is always the
// lookup's. No database: a pg double answers every statement.

process.env.REDIS_URL = 'redis://127.0.0.1:1';

const bcrypt = (await import('bcrypt')).default;
const redis = await import('../../config/redis.js');
const { pool } = await import('../../config/database.js');
const authService = await import('./auth.service.js');

redis.installRedisClient(null);
mock.method(bcrypt, 'compare', (async () => true) as never);

const TENANT = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const USER_ROW = {
  id: 'a0000000-0000-4000-8000-000000000001',
  username: 'staff01',
  email: 'staff01@example.test',
  full_name: 'Nhân viên A',
  phone: null,
  avatar_url: null,
  role: 'staff',
  is_active: true,
  tenant_id: TENANT,
  password_hash: 'stored:Right#2026',
  tenant_name: 'Công ty A',
  tenant_active: true,
};
const TENANT_LOOKUP = /SELECT id FROM tenants/;

/** A login with `origin`; the tenants lookup answers `tenantOf()` at the time of the call. */
function setup(t: TestContext, tenantOf: () => string | null) {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  t.mock.method(console, 'log', () => undefined);
  const statements = installDb(
    t,
    pool,
    text => (/FROM users u/.test(text) ? [USER_ROW] : []),
    text => {
      if (!TENANT_LOOKUP.test(text)) return undefined;
      const id = tenantOf();
      return { rows: id ? [{ id }] : [] };
    },
  );
  return {
    lookups: () => statements.filter(statement => TENANT_LOOKUP.test(statement.text)).length,
    login: async (origin: string) => {
      try {
        await authService.login('staff01', 'Right#2026', 'admin', origin);
        return 'signed in';
      } catch (error) {
        return (error as { code?: string }).code ?? String(error);
      }
    },
  };
}

test('an origin of no tenant is looked up again after the miss TTL, so a domain set later applies', async t => {
  let tenant: string | null = null;
  const run = setup(t, () => tenant);
  const origin = 'https://later.example.test';
  assert.equal(await run.login(origin), 'signed in');
  t.mock.timers.tick(59_000);
  assert.equal(await run.login(origin), 'signed in');
  assert.equal(run.lookups(), 1);

  tenant = TENANT_B;
  t.mock.timers.tick(2_000);
  assert.equal(await run.login(origin), 'AUTH_INVALID_CREDENTIALS');
  assert.equal(run.lookups(), 2);
});

test('a tenant found for an origin is kept for 60 s', async t => {
  const run = setup(t, () => TENANT);
  const origin = 'https://a.example.test/';
  assert.equal(await run.login(origin), 'signed in');
  t.mock.timers.tick(59_000);
  assert.equal(await run.login('https://a.example.test'), 'signed in');
  assert.equal(run.lookups(), 1);
  t.mock.timers.tick(2_000);
  assert.equal(await run.login(origin), 'signed in');
  assert.equal(run.lookups(), 2);
});

test('an origin longer than 255 characters or not a URL origin is looked up each time, with the same answer', async t => {
  const run = setup(t, () => TENANT_B);
  const long = `https://${'a'.repeat(250)}.example.test`;
  for (const origin of [long, 'https://b.example.test/login', 'not an origin']) {
    const before = run.lookups();
    assert.equal(await run.login(origin), 'AUTH_INVALID_CREDENTIALS');
    assert.equal(await run.login(origin), 'AUTH_INVALID_CREDENTIALS');
    assert.equal(run.lookups(), before + 2, origin.slice(0, 40));
  }
});

test('the cache keeps at most 1,000 origins: the least recently used one is dropped first', async t => {
  const run = setup(t, () => null);
  const first = 'https://first.example.test';
  await run.login(first);
  for (let i = 0; i < 1_000; i += 1) await run.login(`https://o${i}.example.test`);
  assert.equal(run.lookups(), 1_001);
  await run.login(first);
  assert.equal(run.lookups(), 1_002);
});

// ── The cache itself ──
const { createOriginTenantCache, isCacheableOrigin, MAX_CACHED_ORIGIN_LENGTH } = await import(
  './auth-origin-tenant-cache.js'
);

test('cache: hits and misses expire after their own TTL', () => {
  let at = 0;
  const cache = createOriginTenantCache({ maxEntries: 10, hitTtlMs: 300, missTtlMs: 100, now: () => at });
  cache.set('https://hit.example.test', { id: TENANT });
  cache.set('https://miss.example.test', null);
  assert.deepEqual(cache.get('https://hit.example.test'), { id: TENANT });
  assert.equal(cache.get('https://miss.example.test'), null);
  assert.equal(cache.get('https://other.example.test'), undefined);
  at = 100;
  assert.equal(cache.get('https://miss.example.test'), undefined);
  assert.deepEqual(cache.get('https://hit.example.test'), { id: TENANT });
  at = 300;
  assert.equal(cache.get('https://hit.example.test'), undefined);
  assert.equal(cache.size, 0);
});

test('cache: bounded, the least recently used origin is dropped first', () => {
  const cache = createOriginTenantCache({ maxEntries: 3, hitTtlMs: 1_000, missTtlMs: 1_000, now: () => 0 });
  for (const name of ['a', 'b', 'c']) cache.set(`https://${name}.example.test`, null);
  assert.equal(cache.get('https://a.example.test'), null); // a is now the most recently used
  cache.set('https://d.example.test', { id: TENANT });
  assert.equal(cache.size, 3);
  assert.equal(cache.get('https://b.example.test'), undefined);
  for (const name of ['a', 'c', 'd']) assert.notEqual(cache.get(`https://${name}.example.test`), undefined, name);
});

test('cache: only short URL origins are kept', () => {
  const longest = `https://${'a'.repeat(MAX_CACHED_ORIGIN_LENGTH - 'https://'.length - '.test'.length)}.test`;
  assert.equal(longest.length, MAX_CACHED_ORIGIN_LENGTH);
  for (const origin of ['https://a.example.test', 'http://localhost:5274', 'http://127.0.0.1:5173', longest]) {
    assert.equal(isCacheableOrigin(origin), true, origin);
  }
  for (const origin of [
    '',
    `${longest}x`,
    'https://a.example.test/login',
    'https://A.example.test',
    'https://a.example.test:443',
    'https://a.example.test?x=1',
    'null',
    'not an origin',
    'javascript:alert(1)',
  ]) {
    assert.equal(isCacheableOrigin(origin), false, origin);
  }
  const cache = createOriginTenantCache({ maxEntries: 10, hitTtlMs: 1_000, missTtlMs: 1_000, now: () => 0 });
  cache.set(`${longest}x`, null);
  cache.set('https://a.example.test/login', { id: TENANT });
  assert.equal(cache.size, 0);
});
