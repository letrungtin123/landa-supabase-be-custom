import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { RedisClientType } from '@redis/client';

// H1: while Redis is down, or until it holds every revocation that can still
// refuse a token, access-token revocation is decided by the database. A
// revoked session must never be accepted because Redis missed its revocation.
// Fake Redis client and in-memory pg double; no network.
process.env.REDIS_URL = 'redis://127.0.0.1:1';
const redis = await import('../../config/redis.js');
const revocation = await import('./auth-revocation.service.js');

const USER_A = 'b0000000-0000-4000-8000-00000000000a';
const USER_B = 'b0000000-0000-4000-8000-00000000000b';

type FakeRedis = RedisClientType & { down: boolean; values: Map<string, string>; reads: number };

function fakeRedis(): FakeRedis {
  const values = new Map<string, string>();
  const fake = {
    isOpen: true,
    isReady: true,
    down: false,
    reads: 0,
    values,
    async get(key: string) { if (fake.down) throw new Error('ECONNRESET'); fake.reads += 1; return values.get(key) ?? null; },
    async set(key: string, value: string) { if (fake.down) throw new Error('ECONNRESET'); values.set(key, value); return 'OK'; },
  };
  return fake as unknown as FakeRedis;
}

interface Row { reason: string; revoked_at: Date; expires_at: Date }

async function installFakeDb(t: TestContext, rows: Map<string, Row>): Promise<void> {
  const pg = await import('pg');
  t.mock.method(pg.default.Pool.prototype, 'query', async (text: string, params: unknown[] = []) => {
    if (text.includes('revoked_at > now() -')) {
      const windowMs = Number(params[0]);
      const recent = [...rows].filter(([, row]) => row.expires_at.getTime() > Date.now() && row.revoked_at.getTime() > Date.now() - windowMs);
      return { rows: recent.map(([user_id, row]) => ({ user_id, ...row })), rowCount: recent.length };
    }
    if (text.includes('FROM auth_revocations') && text.includes('WHERE user_id = $1::uuid')) {
      const row = rows.get(String(params[0]));
      return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  });
}

const nowSeconds = () => Math.floor(Date.now() / 1000);
const ended = (secondsAgo: number): Row => ({
  reason: 'password_changed',
  revoked_at: new Date(Date.now() - secondsAgo * 1000),
  expires_at: new Date(Date.now() + 86_400_000),
});

test('a fresh Redis answers only after the recent revocations were copied into it', async (t) => {
  const rows = new Map([[USER_A, ended(10)]]);
  await installFakeDb(t, rows);
  const client = fakeRedis();
  redis.installRedisClient(client);

  // Not trusted yet: the database refuses the token issued before the session end.
  assert.equal(revocation.isAccessRevocationMirrorTrusted(), false);
  assert.equal(await revocation.isAccessTokenRevoked(USER_A, nowSeconds() - 60), true);
  assert.equal(client.reads, 0);

  assert.equal(await revocation.resyncAccessRevocationMirror(), true);
  assert.ok(client.values.has(`auth:revoked:${USER_A}`));
  assert.equal(await revocation.isAccessTokenRevoked(USER_A, nowSeconds() - 60), true);
  assert.equal(await revocation.isAccessTokenRevoked(USER_A, nowSeconds() + 1), false);
  assert.equal(client.reads, 2, 'answered from Redis once trusted');
});

test('a revocation that could not reach Redis is still enforced after Redis is back', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const rows = new Map([[USER_A, ended(10)]]);
  await installFakeDb(t, rows);
  const client = fakeRedis();
  redis.installRedisClient(client);
  t.mock.timers.tick(3_000); // past the resync throttle of the previous test
  assert.equal(await revocation.resyncAccessRevocationMirror(), true);

  // User B's password changes while Redis fails: the copy to Redis is lost.
  client.down = true;
  rows.set(USER_B, ended(0));
  await revocation.syncUserAccessRevocationCache(USER_B);
  assert.equal(revocation.isAccessRevocationMirrorTrusted(), false);

  // Redis is healthy again but has no key for B. The old token must stay refused.
  client.down = false;
  t.mock.timers.tick(redis.REDIS_BREAKER_OPEN_MS + 1);
  assert.equal(client.values.has(`auth:revoked:${USER_B}`), false);
  assert.equal(await revocation.isAccessTokenRevoked(USER_B, nowSeconds() - 60), true);

  t.mock.timers.tick(5_000);
  assert.equal(await revocation.resyncAccessRevocationMirror(), true);
  assert.ok(client.values.has(`auth:revoked:${USER_B}`));
  assert.equal(await revocation.isAccessTokenRevoked(USER_B, nowSeconds() - 60), true);
});

test('a new Redis connection (a restart may lose keys) is not trusted until the copy is redone', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const rows = new Map([[USER_A, ended(10)]]);
  await installFakeDb(t, rows);
  redis.installRedisClient(fakeRedis());
  t.mock.timers.tick(3_000);
  assert.equal(await revocation.resyncAccessRevocationMirror(), true);

  const restarted = fakeRedis();
  redis.installRedisClient(restarted);
  assert.equal(revocation.isAccessRevocationMirrorTrusted(), false);
  assert.equal(await revocation.isAccessTokenRevoked(USER_A, nowSeconds() - 60), true);
  assert.equal(restarted.reads, 0);
});

test('a revocation older than the access-token lifetime is not copied (no token it refuses is still valid)', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const { env } = await import('../../config/env.js');
  const { parseExpiresIn } = await import('../../utils/jwt.js');
  const lifetimeSeconds = parseExpiresIn(env.JWT_ACCESS_EXPIRES_IN) / 1000;
  const rows = new Map([[USER_A, ended(lifetimeSeconds + 600)], [USER_B, ended(5)]]);
  await installFakeDb(t, rows);
  const client = fakeRedis();
  redis.installRedisClient(client);
  t.mock.timers.tick(5_000);
  assert.equal(await revocation.resyncAccessRevocationMirror(), true);
  assert.deepEqual([...client.values.keys()], [`auth:revoked:${USER_B}`]);
});
