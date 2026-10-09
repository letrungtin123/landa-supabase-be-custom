import assert from 'node:assert/strict';
import test from 'node:test';
import type { Request, RequestHandler, Response, Router } from 'express';

// S2 T3: branding images and the dashboard home content are changed only with
// the 'branding' module permission (learner_plus passes the staff role gate).

const TENANT = '11111111-1111-4111-8111-111111111111';

type RouteLayer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: RequestHandler }> } };

function routeHandlers(router: Router, method: string, path: string): RequestHandler[] {
  const layer = (router.stack as unknown as RouteLayer[]).find((item) => item.route?.path === path && item.route.methods[method]);
  assert.ok(layer?.route, `${method.toUpperCase()} ${path} exists`);
  return layer.route.stack.map((item) => item.handle);
}

let nextUser = 0;
// A fresh user id per call: hasPermission caches answers per user.
const freshUserId = () => `b0000000-0000-4000-8000-${String(++nextUser).padStart(12, '0')}`;

async function runFirst(handler: RequestHandler, role: string): Promise<{ status?: number; nextCalled: boolean }> {
  const out: { status?: number; nextCalled: boolean } = { nextCalled: false };
  const res = {
    status(code: number) { out.status = code; return this; },
    json() { return this; },
  } as unknown as Response;
  const req = { user: { id: freshUserId(), role, tenantId: TENANT, username: 'u', sessionMode: 'normal' } } as unknown as Request;
  await handler(req, res, () => { out.nextCalled = true; });
  return out;
}

test('branding and dashboard-content routes check the branding permission before the controller', async (t) => {
  const pg = await import('pg');
  const asked: Array<[string, string]> = [];
  t.mock.method(pg.default.Pool.prototype, 'query', async (text: string, params: unknown[] = []) => {
    const action = /bool_or\(pgm\.(can_\w+)\)/.exec(text)?.[1];
    if (action) asked.push([String(params[1]), action]);
    return { rows: [{ allowed: false }], rowCount: 1 };
  });
  const branding = (await import('./branding.routes.js')).default;
  const content = (await import('./dashboard-content.routes.js')).default;
  const cases: Array<[Router, string, string, string]> = [
    [branding, 'get', '/', 'can_view'],
    [branding, 'post', '/upload', 'can_edit'],
    [branding, 'delete', '/:imageKey', 'can_edit'],
    [content, 'get', '/', 'can_view'],
    [content, 'put', '/', 'can_edit'],
  ];
  for (const [router, method, path, action] of cases) {
    for (const role of ['staff', 'learner_plus']) {
      asked.length = 0;
      const result = await runFirst(routeHandlers(router, method, path)[0], role);
      assert.equal(result.status, 403, `${role} ${method} ${path}`);
      assert.equal(result.nextCalled, false);
      assert.deepEqual(asked, [['branding', action]]);
    }
    // A superuser keeps full access inside the tenant.
    assert.equal((await runFirst(routeHandlers(router, method, path)[0], 'superuser')).nextCalled, true);
  }
});
