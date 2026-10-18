import assert from 'node:assert/strict';
import test from 'node:test';
import { createOneTimeTokenStore, type OneTimeTokenRedisClient } from './auth-one-time-token.store.js';

// Cross-app SSO with several API processes: a one-time token issued by one
// process is used on another, exactly once. In-memory Redis stand-in.

class FakeRedis implements OneTimeTokenRedisClient {
  readonly values = new Map<string, { value: string; expiresAt: number }>();
  down = false;
  calls = 0;
  constructor(private readonly clock: { now: number }) {}
  private check() { this.calls += 1; if (this.down) throw new Error('ECONNRESET'); }
  async set(key: string, value: string, options: { PX: number }) { this.check(); this.values.set(key, { value, expiresAt: this.clock.now + options.PX }); return 'OK'; }
  async get(key: string) {
    this.check();
    const entry = this.values.get(key);
    if (!entry || entry.expiresAt <= this.clock.now) return null;
    return entry.value;
  }
  async del(key: string) { this.check(); return Number(this.values.delete(key)); }
}

function apiProcess(redis: FakeRedis, clock: { now: number }, shared = true) {
  return createOneTimeTokenStore({
    ttlMs: 30_000,
    shared,
    getClient: () => redis,
    deadline: (_label, work) => work,
    now: () => clock.now,
  });
}

const USER = 'a0000000-0000-4000-8000-000000000001';

test('issued on one API process, used on another, only once', async () => {
  const clock = { now: 1_000_000 };
  const redis = new FakeRedis(clock);
  const issuer = apiProcess(redis, clock);
  const other = apiProcess(redis, clock);
  const token = await issuer.issue(USER);
  assert.ok(![...redis.values.keys()].some((key) => key.includes(token)), 'the token itself is never a Redis key');
  assert.deepEqual(await other.take(token), { userId: USER, expiresAt: 1_030_000 });
  assert.equal(await issuer.take(token), null, 'a second use is refused');
});

test('two processes using the same token at once: only one gets it', async () => {
  const clock = { now: 2_000_000 };
  const redis = new FakeRedis(clock);
  const token = await apiProcess(redis, clock).issue(USER);
  const results = await Promise.all([apiProcess(redis, clock).take(token), apiProcess(redis, clock).take(token)]);
  assert.equal(results.filter(Boolean).length, 1);
});

test('an expired token is still told apart from an unknown one (the caller refuses it as expired)', async () => {
  const clock = { now: 3_000_000 };
  const redis = new FakeRedis(clock);
  const store = apiProcess(redis, clock);
  const token = await store.issue(USER);
  clock.now += 31_000;
  const entry = await store.take(token);
  assert.ok(entry && clock.now > entry.expiresAt);
});

test('Redis down: the issuing process keeps the token; another process cannot use it', async () => {
  const clock = { now: 4_000_000 };
  const redis = new FakeRedis(clock);
  redis.down = true;
  const issuer = apiProcess(redis, clock);
  const token = await issuer.issue(USER);
  assert.equal(await apiProcess(redis, clock).take(token), null);
  assert.equal((await issuer.take(token))?.userId, USER);
});

test('one API process: in memory, as before (Redis is never called)', async () => {
  const clock = { now: 5_000_000 };
  const redis = new FakeRedis(clock);
  const store = apiProcess(redis, clock, false);
  const token = await store.issue(USER);
  assert.equal((await store.take(token))?.userId, USER);
  assert.equal(await store.take(token), null);
  assert.equal(redis.calls, 0);
  const stale = await store.issue(USER);
  clock.now += 31_000;
  store.sweep();
  assert.equal(await store.take(stale), null, 'swept after expiry');
});
