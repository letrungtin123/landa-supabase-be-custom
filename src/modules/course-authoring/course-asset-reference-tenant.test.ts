import assert from 'node:assert/strict';
import test from 'node:test';
import type { Request, RequestHandler, Response, Router } from 'express';

// S2 T5: "which blocks use this file" is answered only for a course of the
// caller's tenant, and deleting a course file by its path needs can_delete.

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const COURSE_B = 'course-v1:B+1+2026';
const PATH_B = '22222222-2222-4222-8222-222222222222/courses/course-v1:B+1+2026/logo.png';

test('delete-by-path checks the course tenant before looking at course blocks', async (t) => {
  const pg = await import('pg');
  const sqls: string[] = [];
  t.mock.method(pg.default.Pool.prototype, 'query', async (text: string) => {
    sqls.push(text);
    return { rows: [], rowCount: 0 }; // COURSE_B is not a course of TENANT_A
  });
  const svc = await import('./course-authoring.service.js');
  await assert.rejects(
    svc.deleteAssetByStoragePath(COURSE_B, TENANT_A, PATH_B),
    (err: { statusCode?: number }) => err.statusCode === 404,
  );
  assert.equal(sqls.length, 1);
  assert.match(sqls[0], /FROM courses WHERE id = \$1 AND tenant_id = \$2::uuid/);
  assert.equal(sqls.some((sql) => sql.includes('course_blocks')), false);
});

test('the delete-by-path route requires courses.can_delete', async (t) => {
  const pg = await import('pg');
  const asked: string[] = [];
  t.mock.method(pg.default.Pool.prototype, 'query', async (text: string, params: unknown[] = []) => {
    const action = /bool_or\(pgm\.(can_\w+)\)/.exec(text)?.[1];
    if (action) asked.push(`${String(params[1])}.${action}`);
    return { rows: [{ allowed: false }], rowCount: 1 };
  });
  const router = (await import('./course-authoring.routes.js')).default as Router;
  type RouteLayer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: RequestHandler }> } };
  const layer = (router.stack as unknown as RouteLayer[])
    .find((item) => item.route?.path === '/assets/:courseId/delete-by-path' && item.route.methods.post);
  assert.ok(layer?.route);
  let status = 0;
  const res = { status(code: number) { status = code; return this; }, json() { return this; } } as unknown as Response;
  const req = { user: { id: 'b0000000-0000-4000-8000-0000000000e1', role: 'staff', tenantId: TENANT_A, username: 's', sessionMode: 'normal' } } as unknown as Request;
  await layer.route.stack[0].handle(req, res, () => { throw new Error('must not pass'); });
  assert.equal(status, 403);
  assert.deepEqual(asked, ['courses.can_delete']);
});
