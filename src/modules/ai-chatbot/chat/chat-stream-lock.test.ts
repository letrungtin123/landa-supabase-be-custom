import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ErrorReply } from '@redis/client';

// P3: the AI chat conversation lock works under the production Redis ACL
// (+@read +@write +@keyspace on `landa-backend:*`: no EVAL, no MULTI, no
// other prefix). Two lock instances on one fake Redis stand for two API
// processes. No network.

const {
  chatStreamLockKey, createChatStreamLocks, GENERATION_LOCK_UNAVAILABLE_CODE,
} = await import('./chat-stream-lock.js');
const { AppError } = await import('../../../middleware/error-handler.js');

/** In-memory Redis with the production ACL: plain SET/GET/DEL on `landa-backend:*` only. */
function aclRedis() {
  const entries = new Map<string, { value: string; expiresAt: number }>();
  const commands: string[] = [];
  const allow = (command: string, key: string) => {
    commands.push(command);
    if (!key.startsWith('landa-backend:')) {
      throw new ErrorReply(`NOPERM No permissions to access a key used by the '${command.toLowerCase()}' command`);
    }
  };
  const live = (key: string) => {
    const entry = entries.get(key);
    if (entry && entry.expiresAt <= Date.now()) entries.delete(key);
    return entries.get(key);
  };
  return {
    commands,
    peek: (key: string) => live(key)?.value ?? null,
    async set(key: string, value: string, options: { NX?: true; XX?: true; PX: number }) {
      allow('SET', key);
      const exists = Boolean(live(key));
      if ((options.NX && exists) || (options.XX && !exists)) return null;
      entries.set(key, { value, expiresAt: Date.now() + options.PX });
      return 'OK';
    },
    async get(key: string) {
      allow('GET', key);
      return live(key)?.value ?? null;
    },
    async del(key: string) {
      allow('DEL', key);
      return entries.delete(key) ? 1 : 0;
    },
    async eval(): Promise<never> {
      commands.push('EVAL');
      throw new ErrorReply("NOPERM User landa_be has no permissions to run the 'eval' command");
    },
    multi(): never {
      commands.push('MULTI');
      throw new ErrorReply("NOPERM User landa_be has no permissions to run the 'multi' command");
    },
  };
}

const CONVERSATION = '6a1f0b2c-3d4e-4f50-8a61-7b8c9d0e1f2a';
const noDeadline = <T>(_label: string, work: Promise<T>) => work;

function processLocks(redis: ReturnType<typeof aclRedis> | null, options: { ttlMs?: number; renewIntervalMs?: number; log?: (event: Record<string, unknown>) => void } = {}) {
  return createChatStreamLocks({ getClient: () => redis, deadline: noDeadline, log: options.log ?? (() => {}), ...options });
}

test('the lock key is under the backend prefix the ACL allows', () => {
  const key = chatStreamLockKey(CONVERSATION);
  assert.match(key, /^landa-backend:[^:]+:data:v1:ai-chat-stream-lock:/);
  assert.ok(key.endsWith(CONVERSATION));
});

test('one conversation has one holder across processes, with SET/GET/DEL only', async () => {
  const redis = aclRedis();
  const first = processLocks(redis);
  const second = processLocks(redis);
  const held = await first.acquire(CONVERSATION);
  assert.ok(held, 'the first process holds the lock');
  assert.equal(await second.acquire(CONVERSATION), null, 'the second process is refused');
  assert.ok(await second.acquire('7b2f0c3d-4e5f-4061-9b72-8c9d0e1f2a3b'), 'another conversation is free');
  await held!.release();
  assert.equal(redis.peek(chatStreamLockKey(CONVERSATION)), null);
  const next = await second.acquire(CONVERSATION);
  assert.ok(next, 'released: the other process can take it');
  await next!.release();
  assert.deepEqual([...new Set(redis.commands)].sort(), ['DEL', 'GET', 'SET']);
});

test('a holder whose lock expired never removes the next holder\'s lock', async () => {
  const redis = aclRedis();
  const stale = await processLocks(redis, { ttlMs: 40, renewIntervalMs: 60_000 }).acquire(CONVERSATION);
  await delay(80);
  const current = await processLocks(redis).acquire(CONVERSATION);
  assert.ok(current, 'the expired lock is free again');
  const currentToken = redis.peek(chatStreamLockKey(CONVERSATION));
  await stale!.release();
  assert.equal(redis.peek(chatStreamLockKey(CONVERSATION)), currentToken, 'the stale release left the new lock alone');
  await current!.release();
});

test('a held lock is renewed past its TTL and gone after release', async () => {
  const redis = aclRedis();
  const held = await processLocks(redis, { ttlMs: 150, renewIntervalMs: 40 }).acquire(CONVERSATION);
  await delay(450);
  assert.ok(redis.peek(chatStreamLockKey(CONVERSATION)), 'still held three TTLs later');
  assert.equal(await processLocks(redis).acquire(CONVERSATION), null);
  await held!.release();
  assert.equal(redis.peek(chatStreamLockKey(CONVERSATION)), null);
});

test('renewal stops, without overwriting, once another holder has the key', async () => {
  const redis = aclRedis();
  const events: Array<Record<string, unknown>> = [];
  const held = await processLocks(redis, { ttlMs: 10_000, renewIntervalMs: 30, log: (event) => events.push(event) }).acquire(CONVERSATION);
  const key = chatStreamLockKey(CONVERSATION);
  await redis.del(key);
  await redis.set(key, 'other-holder', { NX: true, PX: 10_000 });
  await delay(120);
  assert.equal(redis.peek(key), 'other-holder');
  assert.deepEqual(events, [{ event: 'chat_stream_lock_lost', conversation_id: CONVERSATION }]);
  await held!.release();
  assert.equal(redis.peek(key), 'other-holder', 'release leaves the other holder alone');
});

test('without Redis the chat keeps its per-process lock; a required fence is a 503', async () => {
  for (const redis of [null, { ...aclRedis(), set: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:6379'); } }]) {
    const events: Array<Record<string, unknown>> = [];
    const locks = createChatStreamLocks({ getClient: () => redis, deadline: noDeadline, log: (event) => events.push(event) });
    const lock = await locks.acquire(CONVERSATION);
    assert.ok(lock, 'a no-op lock: Redis never turns a chat request into an outage');
    await lock!.release();
    await assert.rejects(locks.acquire(CONVERSATION, true), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 503);
      assert.equal(error.code, GENERATION_LOCK_UNAVAILABLE_CODE);
      assert.equal(error.message, 'Dịch vụ khóa tác vụ chưa sẵn sàng.');
      return true;
    });
    assert.equal(events.length, 1, 'logged once per interval');
    assert.equal(events[0].event, 'chat_stream_lock_unavailable');
  }
});

test('the former lock is refused by the production ACL (why it was replaced)', async () => {
  const redis = aclRedis();
  await assert.rejects(redis.set('landa:ai-chat:stream:x', 't', { NX: true, PX: 1_000 }), /NOPERM/);
  await assert.rejects(redis.eval(), /NOPERM/);
});
