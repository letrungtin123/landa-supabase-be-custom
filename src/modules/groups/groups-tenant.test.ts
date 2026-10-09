import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

// S1 C4: subgroup/team reads are scoped to the caller's tenant. The pg double
// answers a row only when the SQL carries the org_groups tenant filter for the
// owning tenant, so an unscoped query "leaks" exactly like the real database.

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const ORG_B = 'b0000000-0000-4000-8000-000000000001';
const SUB_B = 'b0000000-0000-4000-8000-000000000002';
const TEAM_B = 'b0000000-0000-4000-8000-000000000003';

async function installFakeDb(t: TestContext): Promise<string[]> {
  const pg = await import('pg');
  const statements: string[] = [];
  t.mock.method(pg.default.Pool.prototype, 'query', async (sql: string, params: unknown[] = []) => {
    statements.push(sql);
    const scoped = /og\.tenant_id = \$\d+::uuid/.test(sql);
    const visible = !scoped || params.includes(TENANT_B);
    const leakRow = { id: 'row', name: 'B private', email: 'member@b.test', count: '1', member_count: 1 };
    if (/COUNT\(\*\) AS count/.test(sql)) return { rows: [{ count: visible ? '1' : '0' }], rowCount: 1 };
    return visible ? { rows: [leakRow], rowCount: 1 } : { rows: [], rowCount: 0 };
  });
  return statements;
}

test('tenant A cannot list or open tenant B\'s subgroups and teams', async (t) => {
  await installFakeDb(t);
  const svc = await import('./groups.service.js');

  assert.deepEqual((await svc.listSubGroups(ORG_B, TENANT_A, {})).subgroups, []);
  assert.deepEqual((await svc.listTeams(SUB_B, TENANT_A, {})).teams, []);
  await assert.rejects(svc.getSubGroupDetail(SUB_B, TENANT_A), { statusCode: 404 });
  await assert.rejects(svc.getTeamDetail(TEAM_B, TENANT_A), { statusCode: 404 });
  assert.deepEqual((await svc.listTeamMembers(TEAM_B, TENANT_A, {})).data, []);
  assert.deepEqual((await svc.listTeamDocCategories(TEAM_B, TENANT_A, {})).data, []);
  assert.deepEqual((await svc.listTeamCourseCategories(TEAM_B, TENANT_A, {})).data, []);
});

test('the owning tenant still reads its own subgroups and teams', async (t) => {
  const statements = await installFakeDb(t);
  const svc = await import('./groups.service.js');

  assert.equal((await svc.listSubGroups(ORG_B, TENANT_B, { search: 'x' })).subgroups.length, 1);
  assert.equal((await svc.listTeams(SUB_B, TENANT_B, {})).teams.length, 1);
  assert.equal((await svc.getSubGroupDetail(SUB_B, TENANT_B)).name, 'B private');
  assert.equal((await svc.getTeamDetail(TEAM_B, TENANT_B)).name, 'B private');
  // The subgroup detail checks the tenant before reading members/courses.
  const detailAt = statements.findIndex((sql) => sql.includes('org_group_name') && sql.includes('og.tenant_id'));
  assert.ok(detailAt >= 0);
});
