import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test, { type TestContext } from 'node:test';

// refresh() commits the rotation before it reads the session context. A
// failed read is tried again shortly; when it still fails the answer is a
// 503 (both frontends retry it with the same token) and a refresh handoff
// lets that retry, within the grace period, rotate the successor the client
// never received. Reuse detection is unchanged otherwise. In-memory pg
// double and fake Redis; no database, no Redis, no network.

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

interface TokenRow {
  id: string; user_id: string; token_hash: string; revoked: boolean; revoked_at: Date | null; session_id: string | null;
}

interface Fake {
  log: string[];
  tokens: TokenRow[];
  /** Session context reads (tenant modules) that fail before one succeeds. */
  failContextReads: number;
  contextReads: number;
}

function label(sql: string): string {
  if (sql.includes('FOR UPDATE OF rt')) return 'token-lock';
  if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return sql.trim().split(/\s+/)[0];
  if (sql.includes('UPDATE refresh_tokens')) return sql.includes('WHERE user_id') ? 'revoke-all' : 'revoke-one';
  if (sql.includes('INSERT INTO refresh_tokens')) return 'insert-token';
  if (sql.includes('tenant_demo_iframe_settings')) return 'demo';
  if (sql.includes('FROM user_permission_groups upg')) return 'permissions';
  if (sql.includes('FROM tenant_modules tm')) return 'tenant-modules';
  if (sql.includes('FROM tenant_role_labels')) return 'role-labels';
  if (sql.includes('FROM tenant_group_labels')) return 'group-labels';
  return 'other';
}

async function install(t: TestContext, fake: Fake) {
  const pg = await import('pg');
  const handle = (where: 'pool' | 'tx') => async (text: string | { text: string }, params: unknown[] = []) => {
    const sql = typeof text === 'string' ? text : text.text;
    const name = label(sql);
    fake.log.push(`${where}:${name}`);
    const one = (row: unknown) => ({ rows: [row], rowCount: 1 });
    const empty = { rows: [] as unknown[], rowCount: 0 };
    switch (name) {
      case 'token-lock': {
        const token = fake.tokens.find((row) => row.token_hash === params[0]);
        if (!token) return empty;
        return one({
          rt_id: token.id, user_id: token.user_id, revoked: token.revoked, revoked_at: token.revoked_at,
          expires_at: new Date(Date.now() + 3_600_000), session_id: token.session_id, session_mode: 'normal',
          id: token.user_id, username: 'learner', email: 'a@example.com', full_name: 'A', phone: '', avatar_url: null,
          role: 'learner', is_active: true, tenant_id: TENANT_A, tenant_name: 'Tenant A', tenant_active: true,
          session_revoked_at: null,
        });
      }
      case 'revoke-one': {
        const token = fake.tokens.find((row) => row.id === params[0]);
        if (token) { token.revoked = true; token.revoked_at = new Date(); }
        return { rows: [], rowCount: token ? 1 : 0 };
      }
      case 'revoke-all': {
        let count = 0;
        for (const token of fake.tokens) {
          if (token.user_id === params[0] && !token.revoked) { token.revoked = true; token.revoked_at = new Date(); count += 1; }
        }
        return { rows: [], rowCount: count };
      }
      case 'insert-token':
        fake.tokens.push({
          id: `rt-${fake.tokens.length + 1}`, user_id: String(params[0]), token_hash: String(params[1]),
          revoked: false, revoked_at: null, session_id: (params[4] as string | null) ?? null,
        });
        return { rows: [], rowCount: 1 };
      case 'demo': return one({ exists: false });
      case 'permissions': return { rows: [{ code: 'courses', can_view: true, can_add: false, can_edit: false, can_delete: false }], rowCount: 1 };
      case 'tenant-modules':
        fake.contextReads += 1;
        if (fake.failContextReads > 0) {
          fake.failContextReads -= 1;
          throw new Error('Connection terminated unexpectedly');
        }
        return { rows: [{ code: 'courses' }], rowCount: 1 };
      case 'role-labels': return { rows: [{ role: 'learner', label: 'Học viên' }], rowCount: 1 };
      case 'group-labels': return { rows: [], rowCount: 0 };
      default: return empty;
    }
  };
  t.mock.method(pg.default.Pool.prototype, 'query', handle('pool'));
  t.mock.method(pg.default.Pool.prototype, 'connect', async () => ({ query: handle('tx'), release: () => { fake.log.push('release'); } }));
}

function fake(tokens: TokenRow[]): Fake {
  return { log: [], tokens, failContextReads: 0, contextReads: 0 };
}

function activeToken(id: string, token: string): TokenRow {
  return { id, user_id: 'u1', token_hash: hash(token), revoked: false, revoked_at: null, session_id: null };
}

// ── The store ──

class FakeRedis {
  readonly values = new Map<string, string>();
  down = false;
  private check() { if (this.down) throw new Error('ECONNRESET'); }
  async set(key: string, value: string) { this.check(); this.values.set(key, value); return 'OK'; }
  async get(key: string) { this.check(); return this.values.get(key) ?? null; }
  async del(key: string) { this.check(); return Number(this.values.delete(key)); }
}

test('handoff store: one use, gone after the grace period, never keyed by the token hash itself', async () => {
  const { createRefreshHandoffStore } = await import('./auth-refresh-handoff.store.js');
  const clock = { now: 1_000_000 };
  const local = createRefreshHandoffStore({ ttlMs: 10_000, shared: false, now: () => clock.now });
  await local.offer(hash('old'), hash('new'));
  assert.equal(await local.take(hash('old')), hash('new'));
  assert.equal(await local.take(hash('old')), null, 'used once');
  await local.offer(hash('old'), hash('new'));
  clock.now += 10_000;
  assert.equal(await local.take(hash('old')), null, 'expired with the grace period');

  const redis = new FakeRedis();
  const options = { ttlMs: 10_000, shared: true, getClient: () => redis, deadline: <T>(_label: string, work: Promise<T>) => work };
  const processA = createRefreshHandoffStore(options);
  const processB = createRefreshHandoffStore(options);
  await processA.offer(hash('old'), hash('new'));
  const [key] = [...redis.values.keys()];
  assert.equal(key.includes(hash('old')), false, 'the key is not the token hash');
  assert.equal(redis.values.get(key), hash('new'), 'the value is only the successor hash');
  const raced = await Promise.all([processB.take(hash('old')), processA.take(hash('old'))]);
  assert.deepEqual(raced.filter(Boolean), [hash('new')], 'a handoff written by one API process is used once by another');

  redis.down = true;
  await processA.offer(hash('old-2'), hash('new-2'));
  assert.equal(await processB.take(hash('old-2')), null, 'Redis down: another process cannot see it');
  assert.equal(await processA.take(hash('old-2')), hash('new-2'), 'the offering process kept it');
});

// ── refresh() ──

test('a failed session context read is tried again and the rotation is not repeated', async (t) => {
  const f = fake([activeToken('rt-1', 'device-1')]);
  f.failContextReads = 1;
  await install(t, f);
  const { refresh } = await import('./auth.service.js');

  const session = await refresh('device-1');
  assert.equal(f.contextReads, 2, 'read again after the failure');
  assert.equal(f.log.filter((entry) => entry.endsWith(':insert-token')).length, 1, 'one rotation');
  assert.deepEqual(session.tenant_modules, ['courses']);
  assert.equal(hash(session.refresh_token), f.tokens[1].token_hash);
  assert.equal(f.tokens[0].revoked, true);
});

test('context unavailable: a transient 503, and the retry with the same token gets a working session', async (t) => {
  const f = fake([activeToken('rt-1', 'device-2')]);
  f.failContextReads = 3;
  await install(t, f);
  const { refresh, AUTH_REFRESH_CONTEXT_UNAVAILABLE_CODE } = await import('./auth.service.js');

  await assert.rejects(refresh('device-2'), { statusCode: 503, code: AUTH_REFRESH_CONTEXT_UNAVAILABLE_CODE });
  assert.equal(f.contextReads, 3, 'the read was tried three times');
  const [old, undelivered] = f.tokens;
  assert.equal(old.revoked, true, 'the rotation stays committed');
  assert.equal(undelivered.revoked, false);

  // The frontend retries (5xx is transient) with the token it still holds.
  const session = await refresh('device-2');
  const delivered = f.tokens[2];
  assert.ok(delivered, 'the undelivered successor was rotated');
  assert.equal(hash(session.refresh_token), delivered.token_hash);
  assert.equal(undelivered.revoked, true, 'the successor nobody received is revoked');
  assert.equal(delivered.revoked, false);
  assert.equal(f.log.includes('tx:revoke-all') || f.log.includes('pool:revoke-all'), false, 'no session family was revoked');
  assert.deepEqual(session.permissions, { courses: { can_view: true, can_add: false, can_edit: false, can_delete: false } });

  // The handoff is used once: a later reuse within the grace period is refused as before.
  await assert.rejects(refresh('device-2'), { statusCode: 401, message: 'Refresh token đã được sử dụng' });
  assert.equal(delivered.revoked, false, 'the delivered session keeps working');
  assert.equal(f.tokens.length, 3);
});

test('a retry that fails again keeps a handoff for the next retry', async (t) => {
  const f = fake([activeToken('rt-1', 'device-3')]);
  f.failContextReads = 6;
  await install(t, f);
  const { refresh } = await import('./auth.service.js');

  await assert.rejects(refresh('device-3'), { statusCode: 503 });
  await assert.rejects(refresh('device-3'), { statusCode: 503 });
  assert.equal(f.tokens.length, 3);
  assert.equal(f.tokens[1].revoked, true, 'the first undelivered successor was rotated');
  const session = await refresh('device-3');
  assert.equal(hash(session.refresh_token), f.tokens[3].token_hash);
  assert.equal(f.tokens[2].revoked, true);
  assert.equal(f.tokens[3].revoked, false);
});

test('a handoff never bypasses reuse detection after the grace period', async (t) => {
  const f = fake([activeToken('rt-1', 'device-4')]);
  f.failContextReads = 3;
  await install(t, f);
  const { refresh } = await import('./auth.service.js');

  await assert.rejects(refresh('device-4'), { statusCode: 503 });
  f.tokens[0].revoked_at = new Date(Date.now() - 60_000);
  await assert.rejects(refresh('device-4'), { statusCode: 401, message: 'Phiên đăng nhập đã bị thu hồi — vui lòng đăng nhập lại' });
  assert.ok(f.log.indexOf('tx:revoke-all') >= 0, 'every session of the user ends, as before');
  assert.equal(f.tokens.length, 2, 'nothing was rotated');
});

test('a handoff whose successor was revoked meanwhile is refused as a reused token', async (t) => {
  const f = fake([activeToken('rt-1', 'device-5')]);
  f.failContextReads = 3;
  await install(t, f);
  const { refresh } = await import('./auth.service.js');

  await assert.rejects(refresh('device-5'), { statusCode: 503 });
  f.tokens[1].revoked = true;
  f.tokens[1].revoked_at = new Date();
  await assert.rejects(refresh('device-5'), { statusCode: 401, message: 'Refresh token đã được sử dụng' });
  assert.equal(f.tokens.length, 2, 'nothing was rotated');
});

test('without a handoff a reuse within the grace period is refused alone, as before', async (t) => {
  const f = fake([{ ...activeToken('rt-1', 'raced-tab'), revoked: true, revoked_at: new Date(Date.now() - 2_000) }]);
  await install(t, f);
  const { refresh } = await import('./auth.service.js');
  await assert.rejects(refresh('raced-tab'), { statusCode: 401, message: 'Refresh token đã được sử dụng' });
  assert.equal(f.log.some((entry) => /revoke-all|insert-token/.test(entry)), false);
  assert.equal(f.contextReads, 0);
});
