import assert from 'node:assert/strict';
import test from 'node:test';
import type { RedisClientType } from '@redis/client';

// Chat "1 message per 3 s per user". With several API processes (the in-app
// cluster's workers) a message accepted by one worker must also hold back the
// next one on another worker: the mark is kept in Redis (SET key 1 NX PX 3000
// under the backend prefix), with this process's Map as the fallback. No
// Redis server: fakes only.

// This file runs as one API process of two (process-role.ts reads these at import).
process.env.LANDA_PROCESS_ROLE = 'api';
process.env.LANDA_API_INSTANCES = '2';
process.env.REDIS_URL = 'redis://127.0.0.1:1';

const redis = await import('../../../config/redis.js');
const runtime = await import('./chat-turn-runtime.service.js');
const { createChatRateLimiter, chatRateLimitKey } = await import('./chat-rate-limit.js');
const { RATE_LIMIT_MS } = await import('./chat.constants.js');

const USER = 'a0000000-0000-4000-8000-000000000001';
const TOO_FAST = { statusCode: 429, message: 'Bạn gửi tin nhắn quá nhanh. Vui lòng đợi vài giây.' };
// Limiter clocks start here: a mark at time 0 reads as "no mark" (as the Map check always did).
const T0 = 10_000;

type Command = [string, ...unknown[]];

/** A Redis double with PX expiry on the given clock; `fail` makes every command reject. */
function fakeRedis(now: () => number) {
  const keys = new Map<string, number>();
  const commands: Command[] = [];
  const state = { fail: false };
  const live = (key: string) => (keys.get(key) ?? -Infinity) > now();
  return {
    keys,
    commands,
    state,
    client: {
      isOpen: true,
      isReady: true,
      async set(key: string, value: string, options: { NX?: true; PX: number }) {
        commands.push(['set', key, value, options]);
        if (state.fail) throw new Error('ECONNRESET');
        if (options.NX && live(key)) return null;
        keys.set(key, now() + options.PX);
        return 'OK';
      },
      async exists(key: string) {
        commands.push(['exists', key]);
        if (state.fail) throw new Error('ECONNRESET');
        return live(key) ? 1 : 0;
      },
    },
  };
}

test('two API workers share the limit through Redis: a message accepted on one holds the next on the other', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const shared = fakeRedis(() => Date.now());
  redis.installRedisClient(shared.client as unknown as RedisClientType);
  t.after(() => redis.installRedisClient(null));

  runtime.markRateLimit(USER); // accepted on worker A
  runtime.rateLimitMap.clear(); // worker B has its own, empty Map
  await assert.rejects(async () => runtime.checkRateLimit(USER), TOO_FAST);

  t.mock.timers.tick(RATE_LIMIT_MS);
  await runtime.checkRateLimit(USER);
  assert.deepEqual(shared.commands[0], ['set', chatRateLimitKey(USER), '1', { NX: true, PX: RATE_LIMIT_MS }]);
  assert.match(chatRateLimitKey(USER), /^landa-backend:/);
});

test('limiter: Redis present, the mark is one SET NX PX and the check reads it', async () => {
  let at = T0;
  const redisDouble = fakeRedis(() => at);
  const limiter = createChatRateLimiter({
    windowMs: RATE_LIMIT_MS,
    shared: true,
    local: new Map(),
    getClient: () => redisDouble.client,
    now: () => at,
  });
  await limiter.check(USER);
  await limiter.mark(USER);
  await assert.rejects(limiter.check(USER), TOO_FAST);
  at = T0 + RATE_LIMIT_MS;
  await limiter.check(USER);
  assert.deepEqual(redisDouble.commands, [
    ['exists', chatRateLimitKey(USER)],
    ['set', chatRateLimitKey(USER), '1', { NX: true, PX: RATE_LIMIT_MS }],
    ['exists', chatRateLimitKey(USER)],
  ]);
});

test('limiter: two workers with their own Map share one Redis', async () => {
  let at = T0;
  const shared = fakeRedis(() => at);
  const worker = () =>
    createChatRateLimiter({ windowMs: RATE_LIMIT_MS, shared: true, local: new Map(), getClient: () => shared.client, now: () => at });
  const [a, b] = [worker(), worker()];
  await a.check(USER);
  await a.mark(USER);
  at = T0 + 1_000;
  await assert.rejects(b.check(USER), TOO_FAST);
  await assert.rejects(a.check(USER), TOO_FAST);
  at = T0 + RATE_LIMIT_MS;
  await b.check(USER);
  await b.mark(USER);
  at = T0 + RATE_LIMIT_MS + 1;
  await assert.rejects(a.check(USER), TOO_FAST);
  await b.check('a0000000-0000-4000-8000-000000000002'); // per user
});

test('limiter: Redis absent or failing, the local Map decides, as with one process', async () => {
  let at = T0;
  const failing = fakeRedis(() => at);
  failing.state.fail = true;
  for (const getClient of [() => null, () => failing.client]) {
    const limiter = createChatRateLimiter({ windowMs: RATE_LIMIT_MS, shared: true, local: new Map(), getClient, now: () => at });
    at = T0;
    await limiter.check(USER);
    await limiter.mark(USER); // never rejects
    at = T0 + RATE_LIMIT_MS - 1;
    await assert.rejects(limiter.check(USER), TOO_FAST);
    at = T0 + RATE_LIMIT_MS;
    await limiter.check(USER);
  }
});

test('limiter: one API process keeps the Map only and sends no Redis command', async () => {
  let at = T0;
  const unused = fakeRedis(() => at);
  const local = new Map<string, number>();
  const limiter = createChatRateLimiter({ windowMs: RATE_LIMIT_MS, shared: false, local, getClient: () => unused.client, now: () => at });
  await limiter.mark(USER);
  assert.equal(local.get(USER), T0);
  await assert.rejects(limiter.check(USER), TOO_FAST);
  at = T0 + RATE_LIMIT_MS;
  await limiter.check(USER);
  assert.deepEqual(unused.commands, []);
});
