import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test, { mock } from 'node:test';
import type { RedisClientType } from '@redis/client';

// L1 with several processes: a tenant deactivation, a permission change, a
// session blacklist or an access revocation made in ANOTHER API process takes
// effect in this one through the cluster bus. This file is one API process of
// a cluster (role api, 2 instances); the other process is simulated by the
// NOTIFY payloads it would send. pg and Redis are in-memory stand-ins.
process.env.LANDA_PROCESS_ROLE = 'api';
process.env.LANDA_API_INSTANCES = '2';
process.env.REDIS_URL = 'redis://127.0.0.1:1';

const TENANT = 'f0000000-0000-4000-8000-000000000001';
const USER = 'f0000000-0000-4000-8000-0000000000aa';
const REVOKED_USER = 'f0000000-0000-4000-8000-0000000000bb';
const CHANNEL = 'landa_cluster_bus';

const db = {
  tenantActive: true,
  allowed: true,
  revocations: new Map<string, { reason: string; revoked_at: Date; expires_at: Date }>(),
  notifies: [] as Array<{ kind: string; payload: Record<string, unknown>; origin: string }>,
};

class ListenClient extends EventEmitter {
  async query(_text: string) { return { rows: [], rowCount: 0 }; }
  release() {}
}
const listeners: ListenClient[] = [];

const pg = await import('pg');
mock.method(pg.default.Pool.prototype, 'connect', async () => {
  const client = new ListenClient();
  listeners.push(client);
  return client;
});
mock.method(pg.default.Pool.prototype, 'query', async (text: string, params: unknown[] = []) => {
  if (text.startsWith('SELECT pg_notify')) {
    const message = JSON.parse(String(params[1])) as { o: string; k: string; p: Record<string, unknown> };
    db.notifies.push({ kind: message.k, payload: message.p, origin: message.o });
    return { rows: [], rowCount: 1 };
  }
  if (text.includes('SELECT is_active FROM tenants')) return { rows: [{ is_active: db.tenantActive }], rowCount: 1 };
  if (text.includes('FROM modules m')) return { rows: [], rowCount: 0 };
  if (text.includes('bool_or(pgm.')) return { rows: [{ allowed: db.allowed }], rowCount: 1 };
  if (text.includes('FROM auth_revocations')) {
    if (text.includes('revoked_at > now() -')) {
      const rows = [...db.revocations].map(([user_id, row]) => ({ user_id, ...row }));
      return { rows, rowCount: rows.length };
    }
    const row = db.revocations.get(String(params[0]));
    return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  return { rows: [], rowCount: 0 };
});

const { clusterBus } = await import('./cluster-bus.js');
const { tenantContext, invalidateTenantCache } = await import('../middleware/tenant-context.js');
const { hasPermission, invalidatePermissionCache } = await import('../middleware/authorize.js');
const { authenticate } = await import('../middleware/authenticate.js');
const { signAccessToken } = await import('../utils/jwt.js');
const redis = await import('./redis.js');
const revocation = await import('../modules/auth/auth-revocation.service.js');
const cache = await import('./cache.js');

/** What the other API process would NOTIFY. */
function fromOtherProcess(kind: string, payload: Record<string, unknown>): void {
  for (const client of listeners) client.emit('notification', { channel: CHANNEL, payload: JSON.stringify({ o: 'process-a', k: kind, p: payload }) });
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

function response() {
  const out: { status: number | null } = { status: null };
  const res = { status(code: number) { out.status = code; return this; }, json() { return this; }, setHeader() {} };
  return { res: res as never, out };
}

async function tenantStatusSeen(): Promise<number> {
  const { res, out } = response();
  let passed = false;
  await tenantContext({ user: { id: USER, tenantId: TENANT, role: 'staff' }, headers: {} } as never, res, () => { passed = true; });
  return passed ? 200 : out.status ?? 0;
}

async function authenticateStatus(token: string): Promise<number> {
  const { res, out } = response();
  let passed = false;
  await authenticate({ headers: { authorization: `Bearer ${token}` } } as never, res, () => { passed = true; });
  return passed ? 200 : out.status ?? 0;
}

test('setup: this API process listens on the bus', async () => {
  assert.equal(clusterBus.enabled, true);
  await clusterBus.start();
  assert.equal(clusterBus.isHealthy(), true);
  assert.equal(listeners.length, 1);
});

test('a tenant deactivated in another API process is refused here at once', async () => {
  assert.equal(await tenantStatusSeen(), 200);
  db.tenantActive = false;
  assert.equal(await tenantStatusSeen(), 200, 'cached for up to 60 s in this process');
  fromOtherProcess('tenant.status', { tenant_id: TENANT });
  await settle();
  assert.equal(await tenantStatusSeen(), 403);
  db.tenantActive = true;
});

test('a permission removed in another API process applies here at once', async () => {
  const subject = { id: USER, tenantId: TENANT, role: 'staff' as const };
  assert.equal(await hasPermission(subject, 'courses', 'can_view'), true);
  db.allowed = false;
  assert.equal(await hasPermission(subject, 'courses', 'can_view'), true, 'cached for up to 5 min in this process');
  fromOtherProcess('permissions', { user_id: USER });
  await settle();
  assert.equal(await hasPermission(subject, 'courses', 'can_view'), false);
  db.allowed = true;
});

test('a session blacklisted in another API process (role change, demo iframe) is refused here', async () => {
  const token = signAccessToken({ sub: USER, tid: TENANT, role: 'staff', username: 'staff-1' });
  assert.equal(await authenticateStatus(token), 200);
  fromOtherProcess('auth.blacklist', { user_id: USER, scope: 'all', at: Date.now() + 2_000 });
  await settle();
  assert.equal(await authenticateStatus(token), 401);
  fromOtherProcess('auth.blacklist', { user_id: USER, scope: 'nonsense', at: 'later' });
  await settle();
});

test('this process announces its own invalidations (after its local change)', async () => {
  db.notifies = [];
  invalidateTenantCache(TENANT);
  invalidatePermissionCache(USER);
  await settle();
  assert.deepEqual(db.notifies.map((entry) => [entry.kind, entry.payload]), [
    ['tenant.status', { tenant_id: TENANT }],
    ['permissions', { user_id: USER }],
  ]);
  assert.ok(db.notifies.every((entry) => entry.origin !== 'process-a'));
});

test('a cache version bump that missed Redis here is relayed for the other processes to apply', async () => {
  db.notifies = [];
  await cache.bumpCacheVersion('tenant', TENANT, 'labels');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(db.notifies.map((entry) => [entry.kind, entry.payload]), [
    ['cache.bump', { segments: [['tenant', TENANT, 'labels']] }],
  ]);
});

type FakeRedis = RedisClientType & { values: Map<string, string>; incrs: string[] };
function fakeRedis(): FakeRedis {
  const values = new Map<string, string>();
  const incrs: string[] = [];
  return {
    isOpen: true, isReady: true, values, incrs,
    async get(key: string) { return values.get(key) ?? null; },
    async set(key: string, value: string) { values.set(key, value); return 'OK'; },
    async incr(key: string) { incrs.push(key); return incrs.length; },
  } as unknown as FakeRedis;
}

test('relayed from another process: the version bump and the revocation copy are applied through this process\'s Redis', async () => {
  const fake = fakeRedis();
  redis.installRedisClient(fake);
  fromOtherProcess('cache.bump', { segments: [['tenant', TENANT, 'labels']] });
  await settle();
  assert.deepEqual(fake.incrs, [cache.cacheVersionKey('tenant', TENANT, 'labels')]);

  const revokedAt = new Date(Date.now() - 1_000);
  db.revocations.set(REVOKED_USER, { reason: 'password_changed', revoked_at: revokedAt, expires_at: new Date(Date.now() + 3_600_000) });
  fromOtherProcess('auth.revocation', { user_id: REVOKED_USER });
  await settle();
  assert.equal(fake.values.get(`auth:revoked:${REVOKED_USER}`), String(revokedAt.getTime()));
});

test('while this process\'s listener is down, Redis is not trusted for revocations and cached tenants are dropped', async () => {
  assert.equal(await revocation.resyncAccessRevocationMirror(), true);
  assert.equal(revocation.isAccessRevocationMirrorTrusted(), true);
  assert.equal(await tenantStatusSeen(), 200);
  db.tenantActive = false;

  listeners[0].emit('error', new Error('terminating connection'));
  assert.equal(clusterBus.isHealthy(), false);
  assert.equal(revocation.isAccessRevocationMirrorTrusted(), false, 'an announcement could be missed: the database decides');
  assert.equal(await tenantStatusSeen(), 403, 'the cached status was dropped');

  // The listener comes back by itself; the revocation copy is redone before Redis is trusted again.
  for (let attempt = 0; attempt < 60 && !clusterBus.isHealthy(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(clusterBus.isHealthy(), true);
  assert.equal(revocation.isAccessRevocationMirrorTrusted(), false);
  // Resyncs are throttled (one per 2 s); the next request after that redoes it.
  let resynced = false;
  for (let attempt = 0; attempt < 40 && !resynced; attempt += 1) {
    resynced = await revocation.resyncAccessRevocationMirror();
    if (!resynced) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(resynced, true);
  assert.equal(revocation.isAccessRevocationMirrorTrusted(), true);
  await clusterBus.stop();
  mock.restoreAll();
});
