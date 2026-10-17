import assert from 'node:assert/strict';
import test from 'node:test';
import { ErrorReply, type RedisClientType } from '@redis/client';

// H1: one Redis error must never disable Redis for the life of the process.
// A fake client stands in for Redis; nothing here opens a network connection.
process.env.REDIS_URL = 'redis://127.0.0.1:1';
const redis = await import('./redis.js');

function fakeRedisClient(): RedisClientType & { hang: boolean; values: Map<string, string> } {
  const values = new Map<string, string>();
  const fake = {
    isOpen: true,
    isReady: true,
    hang: false,
    values,
    async get(key: string) { if (fake.hang) await new Promise(() => {}); return values.get(key) ?? null; },
    async set(key: string, value: string) { if (fake.hang) await new Promise(() => {}); values.set(key, value); return 'OK'; },
  };
  return fake as unknown as RedisClientType & { hang: boolean; values: Map<string, string> };
}

test('reconnect never gives up and backs off with jitter up to 10 s', () => {
  const low = () => 0;
  const high = () => 0.999_999;
  assert.equal(redis.redisReconnectDelayMs(0, low), redis.REDIS_RECONNECT_BASE_MS / 2);
  assert.ok(redis.redisReconnectDelayMs(3, low) > redis.redisReconnectDelayMs(1, low));
  for (const retries of [10, 50, 10_000]) {
    const delay = redis.redisReconnectDelayMs(retries, high);
    assert.equal(typeof delay, 'number');
    assert.ok(delay <= redis.REDIS_RECONNECT_MAX_MS);
    assert.ok(redis.redisReconnectDelayMs(retries, low) >= redis.REDIS_RECONNECT_MAX_MS / 2);
  }
});

test('the breaker is time-boxed, extends while failures continue and logs once per unhealthy period', () => {
  let now = 1_000;
  const logs: string[] = [];
  const breaker = redis.createRedisBreaker({ openMs: 30_000, now: () => now, log: (line) => logs.push(line) });
  assert.equal(breaker.isOpen(), false);
  breaker.trip('timeout');
  assert.equal(breaker.isOpen(), true);
  now += 20_000;
  breaker.trip('timeout again');
  now += 20_000;
  assert.equal(breaker.isOpen(), true, 'a later failure extends the open period');
  now += 10_001;
  assert.equal(breaker.isOpen(), false, 'Redis is used again 30 s after the last failure');
  assert.equal(logs.length, 1);
  breaker.trip('new outage');
  assert.equal(logs.length, 2);
});

test('a hung Redis costs one deadline, then callers skip Redis until the breaker closes', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const client = fakeRedisClient();
  redis.installRedisClient(client);
  assert.equal(redis.getRedisClient(), client);

  client.hang = true;
  const startedAt = performance.now();
  await assert.rejects(redis.withRedisDeadline('cache read', client.get('k'), 50), redis.RedisDeadlineError);
  assert.ok(performance.now() - startedAt < 1_000);
  assert.equal(redis.getRedisClient(), null, 'database fallback while the breaker is open');

  client.hang = false;
  t.mock.timers.tick(redis.REDIS_BREAKER_OPEN_MS + 1);
  assert.equal(redis.getRedisClient(), client, 'one error never disables Redis for the process');
});

test('a reply error (e.g. NOPERM) fails the command but keeps Redis in use', async () => {
  const client = fakeRedisClient();
  redis.installRedisClient(client);
  await assert.rejects(redis.withRedisDeadline('acl', Promise.reject(new ErrorReply('NOPERM no permissions'))), ErrorReply);
  assert.equal(redis.getRedisClient(), client);
});

test('a client that is reconnecting is never handed out', () => {
  const client = fakeRedisClient();
  redis.installRedisClient(client);
  (client as unknown as { isReady: boolean }).isReady = false;
  assert.equal(redis.getRedisClient(), null);
  const epoch = redis.redisConnectionEpoch();
  redis.installRedisClient(fakeRedisClient());
  assert.ok(redis.redisConnectionEpoch() > epoch);
});
