import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { RedisClientType } from '@redis/client';
import type { ReportDateRange } from './reports.service.js';

// H2: report list pages are cached in Redis for 30-60 s per tenant, period,
// org scope and filters; tenants never share an entry; a course change
// (course cache version) shows up at once; a cache hit never waits for a
// report admission slot. A fake client stands in for Redis.
process.env.REDIS_URL = 'redis://127.0.0.1:1';
const pg = await import('pg');
const redis = await import('../../config/redis.js');
const cache = await import('../../config/cache.js');
const { cacheVersions } = await import('../../config/cache-keys.js');
const { pool } = await import('../../config/database.js');
const { endReportsPool } = await import('../../config/reports-database.js');
const svc = await import('./reports.service.js');

test.after(async () => {
  redis.installRedisClient(null);
  await endReportsPool();
  await pool.end();
});

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const GROUP = 'a0000000-0000-4000-8000-000000000001';

function fakeRedis() {
  const values = new Map<string, string>();
  const ttls = new Map<string, number>();
  const fake = {
    isOpen: true,
    isReady: true,
    values,
    ttls,
    async get(key: string) { return values.get(key) ?? null; },
    async set(key: string, value: string, options?: { EX?: number }) { values.set(key, value); if (options?.EX) ttls.set(key, options.EX); return 'OK'; },
    async incr(key: string) { const next = Number(values.get(key) ?? 0) + 1; values.set(key, String(next)); return next; },
  };
  redis.installRedisClient(fake as unknown as RedisClientType);
  return fake;
}

function range(dateFrom: string, dateTo: string): ReportDateRange {
  return { startDate: new Date(`${dateFrom}T00:00:00.000+07:00`), endDate: new Date(`${dateTo}T23:59:59.999+07:00`), dateFrom, dateTo };
}

function installDb(t: TestContext, answer?: (text: string, params: unknown[]) => Promise<unknown> | undefined) {
  const statements: Array<{ text: string; params: unknown[] }> = [];
  t.mock.method(pg.default.Pool.prototype, 'query', async (text: string, params: unknown[] = []) => {
    statements.push({ text, params });
    const custom = answer?.(text, params);
    if (custom) return custom;
    return { rows: [{ username: `u-${params[0]}`, email: 'e', avatar: null, last_completion_at: null, completion_rate: '50.00', completed_courses: '1', enrolled_courses: '2', status: 'learning', full_count: '1' }], rowCount: 1 };
  });
  return statements;
}

const PAST = range('2025-03-01', '2025-03-31');
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
const CURRENT = range(`${today.slice(0, 8)}01`, today);

test('a learner page is read once per tenant, period, scope and filters; tenants never share it', async (t) => {
  const fake = fakeRedis();
  const statements = installDb(t);
  const first = await svc.getReportLearners(TENANT_A, 1, 20, 'an', undefined, undefined, GROUP, undefined, undefined, 'all', PAST);
  const again = await svc.getReportLearners(TENANT_A, 1, 20, ' an ', undefined, undefined, GROUP, undefined, undefined, 'all', PAST);
  assert.deepStrictEqual(again, first);
  assert.equal(statements.length, 1, 'the second read is a cache hit');

  const otherTenant = await svc.getReportLearners(TENANT_B, 1, 20, 'an', undefined, undefined, GROUP, undefined, undefined, 'all', PAST);
  assert.equal(statements.length, 2, 'another tenant never reads tenant A\'s entry');
  assert.equal(otherTenant.results[0].username, `u-${TENANT_B}`);
  await svc.getReportLearners(TENANT_A, 1, 20, 'an', undefined, undefined, undefined, undefined, undefined, 'all', PAST);
  await svc.getReportLearners(TENANT_A, 2, 20, 'an', undefined, undefined, GROUP, undefined, undefined, 'all', PAST);
  await svc.getReportLearners(TENANT_A, 1, 20, 'an', undefined, undefined, GROUP, undefined, undefined, 'completed', PAST);
  assert.equal(statements.length, 5, 'scope, page and status are part of the key');

  const keys = [...fake.values.keys()].filter((key) => key.includes(':reports:learners:'));
  assert.equal(keys.length, 5);
  assert.ok(keys.filter((key) => key.includes(TENANT_B)).length === 1);
  // A past period lives 60 s (plus jitter), one that includes today 30 s.
  for (const key of keys) assert.ok(fake.ttls.get(key)! >= 60 && fake.ttls.get(key)! <= 66);
  await svc.getReportLearners(TENANT_A, 1, 20, undefined, undefined, undefined, undefined, undefined, undefined, 'all', CURRENT);
  const currentKey = [...fake.values.keys()].find((key) => key.includes(':reports:learners:') && !keys.includes(key))!;
  assert.ok(fake.ttls.get(currentKey)! >= 30 && fake.ttls.get(currentKey)! <= 33);
});

test('a course\'s learner page and top courses follow the tenant course cache version', async (t) => {
  fakeRedis();
  const statements = installDb(t, () => Promise.resolve({ rows: [], rowCount: 0 }));
  await svc.getReportCourseCompletionLearners(TENANT_A, 'course-1', 1, 20, undefined, undefined, undefined, undefined, undefined, undefined, 'all', PAST);
  await svc.getReportCourseCompletionLearners(TENANT_A, 'course-1', 1, 20, undefined, undefined, undefined, undefined, undefined, undefined, 'all', PAST);
  await svc.getReportTopCourses(TENANT_A, 1, 10, undefined, undefined, undefined, undefined, undefined, PAST);
  await svc.getReportTopCourses(TENANT_A, 1, 10, undefined, undefined, undefined, undefined, undefined, PAST);
  assert.equal(statements.length, 2);

  // A course write of the tenant bumps its course version: the next read is fresh.
  await cache.bumpCacheVersion(...cacheVersions.tenantCourses(TENANT_A));
  await svc.getReportCourseCompletionLearners(TENANT_A, 'course-1', 1, 20, undefined, undefined, undefined, undefined, undefined, undefined, 'all', PAST);
  await svc.getReportTopCourses(TENANT_A, 1, 10, undefined, undefined, undefined, undefined, undefined, PAST);
  assert.equal(statements.length, 4);
  // Another tenant's course write changes nothing for tenant A.
  await cache.bumpCacheVersion(...cacheVersions.tenantCourses(TENANT_B));
  await svc.getReportTopCourses(TENANT_A, 1, 10, undefined, undefined, undefined, undefined, undefined, PAST);
  assert.equal(statements.length, 4);
});

test('the report page and the report chat share one cached chart when it is the same series', async (t) => {
  fakeRedis();
  const statements = installDb(t, () => Promise.resolve({ rows: [{ bucket: '2025-03-01', bucket_label: '01/03/2025', value: '3' }], rowCount: 1 }));
  // The page asks grouped=true with no unit selected; the chat asks grouped=false: same numbers.
  const page = await svc.getReportChart(TENANT_A, 2025, 'active_learners', undefined, undefined, undefined, false, true, PAST, 'day', { mode: 'window', limitBuckets: 72 });
  const chat = await svc.getReportChart(TENANT_A, 2025, 'active_learners', undefined, undefined, undefined, false, false, PAST, 'day', { limitBuckets: 62 });
  assert.equal(statements.length, 1);
  assert.deepStrictEqual(chat.data, page.data);
  // A grouped enrollment series is still its own entry.
  await svc.getReportChart(TENANT_A, 2025, 'total_enrollments', GROUP, undefined, undefined, false, true, PAST, 'day', {});
  await svc.getReportChart(TENANT_A, 2025, 'total_enrollments', GROUP, undefined, undefined, false, false, PAST, 'day', {});
  assert.equal(statements.length, 3);
});

test('a cache hit answers while every report slot of the tenant is busy', async (t) => {
  fakeRedis();
  const pending: Array<() => void> = [];
  const statements = installDb(t, (_text, params) => (params[0] === TENANT_A && pending.length < 99 && statements.length > 1
    ? new Promise((resolve) => pending.push(() => resolve({ rows: [], rowCount: 0 })))
    : undefined));
  const cached = await svc.getReportLearners(TENANT_A, 1, 20, undefined, undefined, undefined, undefined, undefined, undefined, 'all', PAST);
  // Two slow pages take the tenant's two slots.
  const slow = [2, 3].map((page) => svc.getReportLearners(TENANT_A, page, 20, undefined, undefined, undefined, undefined, undefined, undefined, 'all', PAST));
  while (pending.length < 2) await new Promise((resolve) => setImmediate(resolve));
  const started = Date.now();
  assert.deepStrictEqual(await svc.getReportLearners(TENANT_A, 1, 20, undefined, undefined, undefined, undefined, undefined, undefined, 'all', PAST), cached);
  assert.ok(Date.now() - started < 500);
  for (const resolve of pending) resolve();
  await Promise.all(slow);
});
