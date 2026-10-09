import assert from 'node:assert/strict';
import test from 'node:test';
import type { Request, Response } from 'express';

// S2: course/section popup configs and the learner's popup states are read and
// written only for a course the caller can open (same refusal as the other
// learner course endpoints: 403 for learners).

const TENANT = '11111111-1111-4111-8111-111111111111';
const SECTION = '0b7f6a7e-6a0b-4c2e-9d53-7d6c4d1f0a11';

function call(handler: (req: Request, res: Response, next: (err?: unknown) => void) => Promise<void>, body: unknown = {}) {
  const out: { error?: { statusCode?: number }; body?: unknown } = {};
  const res = { status() { return this; }, json(value: unknown) { out.body = value; return this; } } as unknown as Response;
  const req = {
    params: { courseId: 'course-v1:B+1+2026' }, body,
    user: { id: 'a0000000-0000-4000-8000-000000000001', tenantId: TENANT, role: 'learner', username: 'l', sessionMode: 'normal' },
  } as unknown as Request;
  return handler(req, res, (err?: unknown) => { out.error = err as { statusCode?: number }; }).then(() => out);
}

test('popup configs and states of a course outside the caller\'s reach are refused', async (t) => {
  const pg = await import('pg');
  const sqls: string[] = [];
  t.mock.method(pg.default.Pool.prototype, 'query', async (text: string) => {
    sqls.push(text);
    return { rows: [], rowCount: 0 }; // no such course in the tenant
  });
  const ctrl = await import('./learner.controller.js');
  for (const handler of [ctrl.getCourseModalConfig, ctrl.getCourseModalState, ctrl.updateCourseModalState, ctrl.getSectionModalConfigs, ctrl.getSectionModalShown]) {
    const out = await call(handler, { welcome_shown: true });
    assert.equal(out.error?.statusCode, 403);
  }
  const marked = await call(ctrl.markSectionModalShown, { section_id: SECTION });
  assert.equal(marked.error?.statusCode, 403);
  assert.equal(sqls.some((sql) => /course_modal|section_modal/.test(sql)), false, 'no popup table touched');
});

test('a section popup is marked only for a section of the course', async (t) => {
  const pg = await import('pg');
  t.mock.method(pg.default.Pool.prototype, 'query', async (text: string) => {
    if (text.includes('FROM courses c')) return { rows: [{ id: 'course-v1:B+1+2026' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  const ctrl = await import('./learner.controller.js');
  assert.equal((await call(ctrl.markSectionModalShown, { section_id: 'not-a-uuid' })).error?.statusCode, 404);
  assert.equal((await call(ctrl.markSectionModalShown, { section_id: SECTION })).error?.statusCode, 404);
});
