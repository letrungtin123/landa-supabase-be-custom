/** Explicit operational smoke test: unique, expiring Redis probe keys only.
 * No database, chat/job enqueue, provider call, or real conversation lock.
 * It drives the real conversation lock (chat-stream-lock.ts: SET NX PX,
 * GET + SET XX PX renewal, GET + DEL release under the backend key prefix,
 * no Lua and no MULTI) with two Redis connections standing for two API
 * processes, and checks the ACL boundaries it relies on.
 * Run from backend: NODE_ENV=production npx tsx src/scripts/verify-lesson-author-redis-lock.ts --live
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createClient } from '@redis/client';

if (!process.argv.includes('--live')) {
  throw new Error('Explicit --live is required for expiring Redis capability probes');
}
const { env } = await import('../config/env.js');
const { chatStreamLockKey, createChatStreamLocks } = await import('../modules/ai-chatbot/chat-stream-lock.js');
type LockRedis = import('../modules/ai-chatbot/chat-stream-lock.js').ChatStreamLockRedis;

const client = createClient({
  url: env.REDIS_URL,
  disableOfflineQueue: true,
  socket: { connectTimeout: 5_000, reconnectStrategy: false },
});
const peer = client.duplicate();
client.on('error', () => {});
peer.on('error', () => {});
const direct = <T>(_label: string, work: Promise<T>) => work;
const locksOf = (redis: typeof client, options: { ttlMs?: number; renewIntervalMs?: number } = {}) => createChatStreamLocks({
  getClient: () => redis as unknown as LockRedis,
  deadline: direct,
  ttlMs: options.ttlMs ?? 15_000,
  renewIntervalMs: options.renewIntervalMs ?? 5_000,
  log: () => {},
});
const suffix = `__capability_probe__:${randomUUID()}`;
const conversation = `${suffix}:lock`;
const expiring = `${suffix}:expiry`;
const renewed = `${suffix}:renewal`;
let stage = 'connect';
let checks = 0;
const pass = (name: string) => {
  checks += 1;
  console.log(JSON.stringify({ event: 'generation_lock_capability_check', check: name, status: 'PASS' }));
};
const isDenied = (error: unknown) => error instanceof Error && error.message.startsWith('NOPERM');
const deadline = setTimeout(() => {
  stage = 'probe_deadline';
  if (client.isOpen) client.destroy();
  if (peer.isOpen) peer.destroy();
}, 30_000);
try {
  await Promise.all([client.connect(), peer.connect()]);
  const [mine, theirs] = [locksOf(client), locksOf(peer)];
  stage = 'concurrent_acquire';
  const results = await Promise.all([mine.acquire(conversation, true), theirs.acquire(conversation, true)]);
  assert.equal(results.filter(Boolean).length, 1);
  pass('two_clients_exactly_one_owner');
  const ownerIndex = results.findIndex(Boolean);
  const owner = results[ownerIndex]!;
  const other = ownerIndex === 0 ? theirs : mine;
  assert.ok((await client.get(chatStreamLockKey(conversation)))?.length, 'the key is under the backend prefix');
  stage = 'owner_release';
  await owner.release();
  assert.equal(await client.get(chatStreamLockKey(conversation)), null);
  const second = await other.acquire(conversation, true);
  assert.ok(second);
  pass('owner_release_and_reacquire');
  stage = 'expiry';
  const stale = await locksOf(client, { ttlMs: 100, renewIntervalMs: 60_000 }).acquire(expiring, true);
  assert.ok(stale);
  await delay(250);
  assert.equal(await client.get(chatStreamLockKey(expiring)), null);
  const fresh = await locksOf(peer).acquire(expiring, true);
  assert.ok(fresh);
  const freshToken = await peer.get(chatStreamLockKey(expiring));
  await stale.release();
  assert.equal(await client.get(chatStreamLockKey(expiring)), freshToken);
  pass('ttl_expiry_and_stale_owner_cannot_delete_new_lock');
  stage = 'renewal';
  const kept = await locksOf(client, { ttlMs: 300, renewIntervalMs: 100 }).acquire(renewed, true);
  assert.ok(kept);
  await delay(700);
  assert.ok(await peer.get(chatStreamLockKey(renewed)), 'renewed with GET + SET XX past its TTL');
  pass('renewal_without_lua');
  stage = 'permission_boundaries';
  await assert.rejects(client.get(`__unauthorized_lock_probe__:${suffix}`), isDenied);
  pass('unrelated_namespace_denied');
  await assert.rejects(client.sendCommand(['ACL', 'WHOAMI']), isDenied);
  await assert.rejects(client.sendCommand(['CONFIG', 'GET', 'timeout']), isDenied);
  pass('administrative_commands_still_denied');
  assert.equal(await client.get(`auth:revoked:${suffix}`), null);
  assert.equal(await client.get(`landa-backend:${suffix}`), null);
  pass('existing_namespaces_retained');
  stage = 'cleanup';
  await Promise.all([second.release(), fresh.release(), kept.release()]);
  for (const name of [conversation, expiring, renewed]) assert.equal(await client.get(chatStreamLockKey(name)), null);
  pass('probe_keys_removed');
  console.log(JSON.stringify({ event: 'generation_lock_capability_complete', status: 'PASS', checks }));
} catch (error) {
  console.error(JSON.stringify({
    event: 'generation_lock_capability_complete', status: 'FAIL', stage,
    reason: isDenied(error) ? 'REDIS_ACL_DENIED' : error instanceof assert.AssertionError ? 'ASSERTION_FAILED' : 'REDIS_PROBE_FAILED',
  }));
  process.exitCode = 1;
} finally {
  // On an unsuccessful probe, remaining unique keys expire within 15 seconds.
  if (client.isOpen) client.destroy();
  if (peer.isOpen) peer.destroy();
  clearTimeout(deadline);
}
