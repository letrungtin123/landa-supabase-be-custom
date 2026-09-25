/** Explicit operational smoke test: unique, expiring Redis probe keys only.
 * No database, chat/job enqueue, provider call, or real conversation lock.
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
const client = createClient({
  url: env.REDIS_URL,
  disableOfflineQueue: true,
  socket: { connectTimeout: 5_000, reconnectStrategy: false },
});
const peer = client.duplicate();
client.on('error', () => {});
peer.on('error', () => {});
const releaseScript = 'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) end return 0';
const suffix = `__capability_probe__:${randomUUID()}`;
const key = `landa:ai-chat:stream:${suffix}`;
const expiryKey = `${key}:expiry`;
const tokens = [randomUUID(), randomUUID()];
let stage = 'connect';
let checks = 0;
const pass = (name: string) => {
  checks += 1;
  console.log(JSON.stringify({ event: 'generation_lock_capability_check', check: name, status: 'PASS' }));
};
const release = (target: string, token: string) => client.eval(releaseScript, { keys: [target], arguments: [token] });
const isDenied = (error: unknown) => error instanceof Error && error.message.startsWith('NOPERM');
const deadline = setTimeout(() => {
  stage = 'probe_deadline';
  if (client.isOpen) client.destroy();
  if (peer.isOpen) peer.destroy();
}, 30_000);
try {
  await Promise.all([client.connect(), peer.connect()]);
  stage = 'concurrent_acquire';
  const results = await Promise.all([
    client.set(key, tokens[0], { NX: true, PX: 15_000 }),
    peer.set(key, tokens[1], { NX: true, PX: 15_000 }),
  ]);
  assert.equal(results.filter(result => result === 'OK').length, 1);
  assert.equal(results.filter(result => result === null).length, 1);
  pass('two_clients_exactly_one_owner');
  const owner = tokens[results.indexOf('OK')];
  stage = 'wrong_owner_release';
  assert.equal(await release(key, randomUUID()), 0);
  assert.equal(await client.get(key), owner);
  pass('wrong_token_cannot_release');
  stage = 'owner_release';
  assert.equal(await release(key, owner), 1);
  assert.equal(await client.get(key), null);
  assert.equal(await client.set(key, tokens[0], { NX: true, PX: 15_000 }), 'OK');
  pass('owner_release_and_reacquire');
  stage = 'expiry';
  assert.equal(await client.set(expiryKey, tokens[0], { NX: true, PX: 100 }), 'OK');
  await delay(250);
  assert.equal(await client.get(expiryKey), null);
  assert.equal(await peer.set(expiryKey, tokens[1], { NX: true, PX: 15_000 }), 'OK');
  assert.equal(await release(expiryKey, tokens[0]), 0);
  assert.equal(await client.get(expiryKey), tokens[1]);
  pass('ttl_expiry_and_stale_owner_cannot_delete_new_lock');
  stage = 'permission_boundaries';
  await assert.rejects(client.get(`__unauthorized_lock_probe__:${suffix}`), isDenied);
  pass('unrelated_namespace_denied');
  await assert.rejects(client.eval('return 1', { keys: [`auth:revoked:${suffix}`], arguments: [] }), isDenied);
  pass('eval_outside_lock_namespace_denied');
  await assert.rejects(client.sendCommand(['ACL', 'WHOAMI']), isDenied);
  await assert.rejects(client.sendCommand(['CONFIG', 'GET', 'timeout']), isDenied);
  pass('administrative_commands_still_denied');
  assert.equal(await client.get(`auth:revoked:${suffix}`), null);
  assert.equal(await client.get(`landa-backend:${suffix}`), null);
  pass('existing_namespaces_retained');
  stage = 'cleanup';
  assert.equal(await release(key, tokens[0]), 1);
  assert.equal(await release(expiryKey, tokens[1]), 1);
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
