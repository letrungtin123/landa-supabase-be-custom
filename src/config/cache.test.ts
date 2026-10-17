import assert from 'node:assert/strict';
import test from 'node:test';
import type { RedisClientType } from '@redis/client';

// H1: the cache survives Redis failures without serving stale values and
// without stalling requests. A fake client stands in for Redis.
process.env.REDIS_URL = 'redis://127.0.0.1:1';
const redis = await import('./redis.js');
const cache = await import('./cache.js');

type FakeRedis = RedisClientType & { down: boolean; hang: boolean; values: Map<string, string> };

function fakeRedis(): FakeRedis {
  const values = new Map<string, string>();
  const fake = {
    isOpen: true,
    isReady: true,
    down: false,
    hang: false,
    values,
    async gate() {
      if (fake.hang) await new Promise(() => {});
      if (fake.down) throw new Error('connect ECONNREFUSED');
    },
    async get(key: string) { await fake.gate(); return values.get(key) ?? null; },
    async set(key: string, value: string) { await fake.gate(); values.set(key, value); return 'OK'; },
    async incr(key: string) { await fake.gate(); const next = Number(values.get(key) ?? 0) + 1; values.set(key, String(next)); return next; },
  };
  return fake as unknown as FakeRedis;
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(condition(), 'condition reached');
}

test('an invalidation that missed Redis is replayed before any cached value is read again', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const client = fakeRedis();
  redis.installRedisClient(client);
  const namespace = ['tenant', 'tenant-a', 'news'];

  const staleKey = cache.cacheKey('news', await cache.getCacheVersion(...namespace));
  await cache.setCacheJson(staleKey, 'before the write', 60);
  assert.deepEqual(await cache.getCacheJson(staleKey), { hit: true, value: 'before the write' });

  // A write happens while Redis is failing: its invalidation cannot be sent.
  client.down = true;
  await cache.bumpCacheVersion(...namespace);
  assert.equal(cache.pendingCacheInvalidationCount(), 1);
  assert.equal(redis.getRedisClient(), null);

  // Redis is back after the breaker: the value from before the write is not served.
  client.down = false;
  t.mock.timers.tick(redis.REDIS_BREAKER_OPEN_MS + 1);
  assert.deepEqual(await cache.getCacheJson(staleKey), { hit: false });
  await waitFor(() => cache.pendingCacheInvalidationCount() === 0);
  assert.equal(await cache.getCacheVersion(...namespace), '1');

  const freshKey = cache.cacheKey('news', await cache.getCacheVersion(...namespace));
  assert.equal(await cache.cacheJson(freshKey, 60, async () => 'after the write'), 'after the write');
  assert.deepEqual(await cache.getCacheJson(freshKey), { hit: true, value: 'after the write' });
});

test('a hung Redis never stalls a cached read: the database answers within the command deadline', async () => {
  const client = fakeRedis();
  redis.installRedisClient(client);
  client.hang = true;

  const startedAt = performance.now();
  assert.equal(await cache.cacheJson('hung-key', 60, async () => 'from the database'), 'from the database');
  assert.ok(performance.now() - startedAt < redis.REDIS_COMMAND_TIMEOUT_MS + 700);

  // The breaker is open now: the next read does not wait for Redis at all.
  const secondAt = performance.now();
  assert.equal(await cache.cacheJson('hung-key-2', 60, async () => 'again from the database'), 'again from the database');
  assert.ok(performance.now() - secondAt < 100);
});

test('when too many invalidations missed Redis, cached reads stay off for the longest cache lifetime', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const client = fakeRedis();
  redis.installRedisClient(client);
  await cache.setCacheJson('long-lived', 'cached', 60);

  client.down = true;
  for (let i = 0; i <= 10_000; i += 1) await cache.bumpCacheVersion('user', `user-${i}`, 'membership');
  assert.equal(cache.pendingCacheInvalidationCount(), 0, 'the list was dropped past its limit');

  client.down = false;
  t.mock.timers.tick(redis.REDIS_BREAKER_OPEN_MS + 1);
  assert.deepEqual(await cache.getCacheJson('long-lived'), { hit: false });
  t.mock.timers.tick(59_000);
  assert.deepEqual(await cache.getCacheJson('long-lived'), { hit: false });
  t.mock.timers.tick(10_000);
  assert.deepEqual(await cache.getCacheJson('long-lived'), { hit: true, value: 'cached' });
});
