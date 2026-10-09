import assert from 'node:assert/strict';
import test from 'node:test';
import type { Options } from 'express-rate-limit';
import { SharedRateLimitStore, type RateLimitCounterClient } from './rate-limit-store.js';

function fakeRedis(): RateLimitCounterClient & { values: Map<string, number>; ttl: Map<string, number> } {
  const values = new Map<string, number>();
  const ttl = new Map<string, number>();
  return {
    values,
    ttl,
    async incr(key) { const next = (values.get(key) ?? 0) + 1; values.set(key, next); return next; },
    async pExpire(key, ms) { ttl.set(key, ms); return 1; },
    async pTTL(key) { return ttl.get(key) ?? (values.has(key) ? -1 : -2); },
    async decr(key) { const next = (values.get(key) ?? 0) - 1; values.set(key, next); return next; },
    async del(key) { values.delete(key); ttl.delete(key); return 1; },
  };
}

function storeWith(client: RateLimitCounterClient | null, deadlineMs = 500): SharedRateLimitStore {
  const store = new SharedRateLimitStore({ prefix: 'test', getClient: () => client, deadlineMs, log: () => {} });
  store.init({ windowMs: 60_000 } as Options);
  return store;
}

test('counts in Redis under the landa-backend prefix and gives every new counter the window', async () => {
  const redis = fakeRedis();
  const store = storeWith(redis);
  assert.equal((await store.increment('ip:1.2.3.4')).totalHits, 1);
  assert.equal((await store.increment('ip:1.2.3.4')).totalHits, 2);
  const [key] = [...redis.values.keys()];
  assert.match(key, /^landa-backend:.*:rate-limit:test:ip%3A1\.2\.3\.4$/);
  assert.equal(redis.ttl.get(key), 60_000);
  store.shutdown();
});

test('a counter left without expiry gets one on the next hit', async () => {
  const redis = fakeRedis();
  const store = storeWith(redis);
  await store.increment('k');
  const [key] = [...redis.values.keys()];
  redis.ttl.delete(key);
  await store.increment('k');
  assert.equal(redis.ttl.get(key), 60_000);
  store.shutdown();
});

test('decrement never leaves a negative counter without expiry', async () => {
  const redis = fakeRedis();
  const store = storeWith(redis);
  await store.increment('k');
  await store.decrement('k');
  assert.equal(redis.values.size, 0);
  await store.decrement('missing');
  assert.equal(redis.values.size, 0);
  store.shutdown();
});

test('falls back to per-process counters when Redis is missing, failing or slow', async () => {
  const missing = storeWith(null);
  assert.equal((await missing.increment('k')).totalHits, 1);
  assert.equal((await missing.increment('k')).totalHits, 2);
  missing.shutdown();

  const failing = fakeRedis();
  failing.incr = async () => { throw new Error('NOPERM'); };
  const failingStore = storeWith(failing);
  assert.equal((await failingStore.increment('k')).totalHits, 1);
  failingStore.shutdown();

  const slow = fakeRedis();
  slow.incr = () => new Promise<number>(() => {});
  const slowStore = storeWith(slow, 20);
  assert.equal((await slowStore.increment('k')).totalHits, 1);
  slowStore.shutdown();
});
