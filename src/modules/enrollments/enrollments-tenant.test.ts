import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

// S2 T4: enrollments accept only learner accounts of the caller's tenant, and
// course enrollment lists never show a user of another tenant.

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const LEARNER_A = 'a0000000-0000-4000-8000-0000000000d1';
const LEARNER_B = 'a0000000-0000-4000-8000-0000000000d2';
const STAFF_A = 'a0000000-0000-4000-8000-0000000000d3';
const COURSE = 'course-v1:A+1+2026';

const users: Record<string, { tenant_id: string; role: string }> = {
  [LEARNER_A]: { tenant_id: TENANT_A, role: 'learner' },
  [LEARNER_B]: { tenant_id: TENANT_B, role: 'learner' },
  [STAFF_A]: { tenant_id: TENANT_A, role: 'staff' },
};

async function installFakeDb(t: TestContext): Promise<Array<{ sql: string; params: unknown[] }>> {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pg = await import('pg');
  t.mock.method(pg.default.Pool.prototype, 'query', async (text: string, params: unknown[] = []) => {
    calls.push({ sql: text, params });
    if (/FROM users u\s+WHERE u\.id = \$1::uuid/.test(text)) {
      const user = users[String(params[0])];
      const ok = user && user.tenant_id === params[1] && ['learner', 'learner_plus'].includes(user.role);
      return { rows: ok ? [{ '?column?': 1 }] : [], rowCount: ok ? 1 : 0 };
    }
    if (text.includes('FROM courses WHERE id = $1')) return { rows: [{ id: params[0] }], rowCount: 1 };
    if (text.includes('INSERT INTO enrollments')) return { rows: [{ id: 'e1', inserted_count: 0, reactivated_count: 0 }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  return calls;
}

test('a learner of another tenant or a staff account cannot be enrolled', async (t) => {
  const calls = await installFakeDb(t);
  const svc = await import('./enrollments.service.js');
  for (const userId of [LEARNER_B, STAFF_A]) {
    await assert.rejects(svc.enrollUser(userId, COURSE, TENANT_A), (err: { statusCode?: number }) => err.statusCode === 404);
  }
  assert.equal(calls.some((call) => call.sql.includes('INSERT INTO enrollments')), false);

  const ok = await svc.enrollUser(LEARNER_A, COURSE, TENANT_A);
  assert.equal(ok.already_enrolled, false);
});

test('bulk enrollment and course lists are limited to learners of the tenant', async (t) => {
  const calls = await installFakeDb(t);
  const svc = await import('./enrollments.service.js');
  await svc.bulkEnroll([LEARNER_A, LEARNER_B], COURSE, TENANT_A);
  const bulk = calls.find((call) => call.sql.includes('WITH requested_users'));
  assert.ok(bulk);
  assert.match(bulk.sql, /JOIN users u ON u\.id = r\.uid\s+WHERE u\.tenant_id = \$3::uuid\s+AND u\.role IN \('learner', 'learner_plus'\)/);

  await svc.getCourseEnrollments(COURSE, TENANT_A);
  const list = calls.filter((call) => call.sql.includes('JOIN users u ON u.id = e.user_id'));
  assert.equal(list.length, 2);
  for (const call of list) assert.match(call.sql, /u\.tenant_id = \$2/);
});
