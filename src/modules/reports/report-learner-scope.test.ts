import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { Request, Response } from 'express';

// S2 T7: a learner_plus sees personal report data (detail, badges, study
// time) only for learners of their own groups; an out-of-scope learner looks
// like an unknown one. Staff/superuser keep tenant-wide access.

const TENANT = '11111111-1111-4111-8111-111111111111';
const LP = 'a0000000-0000-4000-8000-0000000000f1';
const GROUP_OWN = '33333333-3333-4333-8333-333333333333';

const membership: Record<string, string> = { 'in-scope': GROUP_OWN, 'other-group': '44444444-4444-4444-8444-444444444444' };

async function installFakeDb(t: TestContext): Promise<string[]> {
  const sqls: string[] = [];
  const pg = await import('pg');
  t.mock.method(pg.default.Pool.prototype, 'query', async (text: string, params: unknown[] = []) => {
    sqls.push(text);
    if (text.includes('SELECT DISTINCT og.id AS group_id')) return { rows: [{ group_id: GROUP_OWN }], rowCount: 1 };
    if (text.includes('AS visible')) {
      const group = membership[String(params[0])];
      return { rows: [{ visible: Boolean(group && (params[2] as string[]).includes(group)) }], rowCount: 1 };
    }
    if (text.includes('FROM user_badges ub')) return { rows: [{ badge_id: 'b1', earned_at: '2026-10-01' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  return sqls;
}

async function call(handler: (req: Request, res: Response) => Promise<unknown>, role: string, username: string) {
  const out: { body?: { data?: Record<string, unknown> } } = {};
  const res = {
    status() { return this; },
    json(body: unknown) { out.body = body as typeof out.body; return this; },
  } as unknown as Response;
  const req = { user: { id: LP, tenantId: TENANT, role }, query: { username } } as unknown as Request;
  await handler(req, res);
  return out.body?.data;
}

test('learner_plus gets badges only for learners of their own groups', async (t) => {
  await installFakeDb(t);
  const ctrl = await import('./reports.controller.js');
  assert.deepEqual((await call(ctrl.getUserBadges, 'learner_plus', 'in-scope'))?.badges, [{ badge_id: 'b1', earned_at: '2026-10-01' }]);
  assert.deepEqual(await call(ctrl.getUserBadges, 'learner_plus', 'other-group'), { username: 'other-group', badges: [] });
  assert.deepEqual(await call(ctrl.getUserBadges, 'learner_plus', 'nobody'), { username: 'nobody', badges: [] });
  assert.equal(((await call(ctrl.getUserBadges, 'staff', 'other-group'))?.badges as unknown[]).length, 1);
});

test('learner_plus study time and learner detail of another group answer like an unknown learner', async (t) => {
  const sqls = await installFakeDb(t);
  const ctrl = await import('./reports.controller.js');
  const studyTime = await call(ctrl.getUserStudyTime, 'learner_plus', 'other-group');
  assert.deepEqual(studyTime?.entries, []);
  assert.equal(sqls.some((sql) => sql.includes('SELECT id FROM users WHERE username = $1')), false);

  const detail = await call(ctrl.getLearnerDetail, 'learner_plus', 'other-group');
  assert.deepEqual(detail, { username: 'other-group', groups: [], results: [], total_count: 0, total_pages: 0, current_page: 1 });
});
