import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { AuthUser } from '../../types/express.js';

// GET /api/courses/:id/modal-config and /section-modal-config read a course's
// popup texts only for a course of the caller's tenant, with the same answers
// as the matching PUTs: 404 for a course of another tenant, 400 for a
// superadmin without a selected tenant.

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const COURSE_A = 'course-v1:A+POPUP+2026';
const SECTION = 'block-v1:A+POPUP+2026+type@chapter+block@one';
const courses = new Map([[COURSE_A, TENANT_A]]);

const staffOf = (tenantId: string): AuthUser =>
  ({ id: 'a0000000-0000-4000-8000-000000000001', tenantId, role: 'staff', username: 'staff', sessionMode: 'normal' });
const superadmin = (tenantId: string | null): AuthUser =>
  ({ id: 'a0000000-0000-4000-8000-000000000009', tenantId, role: 'superadmin', username: 'root', sessionMode: 'normal' }) as AuthUser;

async function popupApp(t: TestContext) {
  const pg = await import('pg');
  const sqls: string[] = [];
  t.mock.method(pg.default.Pool.prototype, 'query', async (text: string, values: unknown[] = []) => {
    sqls.push(text);
    let rows: Record<string, unknown>[] = [];
    if (/FROM courses WHERE id = \$1 AND tenant_id = \$2/.test(text)) {
      rows = courses.get(String(values[0])) === values[1] ? [{ id: values[0], display_name: 'Popup course' }] : [];
    } else if (text.includes('FROM course_modal_configs')) {
      rows = [{ course_id: values[0], welcome_enabled: true, welcome_title: 'Private welcome text' }];
    } else if (text.includes('FROM section_modal_configs')) {
      rows = [{ course_id: values[0], section_id: values[1], enabled: true, title: 'Private section text' }];
    } else {
      throw new Error(`Unexpected query: ${text}`);
    }
    return { rows, rowCount: rows.length };
  });
  const ctrl = await import('./courses.controller.js');
  const { errorHandler } = await import('../../middleware/error-handler.js');
  let actor: AuthUser = staffOf(TENANT_A);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = actor; next(); });
  const route = (handler: (req: Request, res: Response, next: NextFunction) => Promise<void>) =>
    (req: Request, res: Response, next: NextFunction) => { void handler(req, res, next); };
  app.get('/courses/:id/modal-config', route(ctrl.getModalConfigController));
  app.put('/courses/:id/modal-config', route(ctrl.updateModalConfigController));
  app.get('/courses/:id/section-modal-config', route(ctrl.getSectionModalController));
  app.put('/courses/:id/section-modal-config', route(ctrl.updateSectionModalController));
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/courses/${encodeURIComponent(COURSE_A)}`;
  async function call(method: 'GET' | 'PUT', path: 'modal-config' | 'section-modal-config') {
    const url = `${base}/${path}${method === 'GET' && path === 'section-modal-config' ? `?section_id=${encodeURIComponent(SECTION)}` : ''}`;
    const response = await fetch(url, method === 'GET' ? {} : {
      method, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(path === 'modal-config' ? { welcome_title: 'x' } : { section_id: SECTION, title: 'x' }),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }
  return { sqls, call, as(user: AuthUser) { actor = user; } };
}

const PATHS = ['modal-config', 'section-modal-config'] as const;

test('own tenant: staff and a superadmin who selected the tenant read the popup texts', async (t) => {
  const app = await popupApp(t);
  for (const user of [staffOf(TENANT_A), superadmin(TENANT_A)]) {
    app.as(user);
    const course = await app.call('GET', 'modal-config');
    assert.equal(course.status, 200);
    assert.equal((course.body.data as Record<string, unknown>).welcome_title, 'Private welcome text');
    const section = await app.call('GET', 'section-modal-config');
    assert.equal(section.status, 200);
    assert.equal((section.body.data as Record<string, unknown>).title, 'Private section text');
  }
});

test('another tenant: the reads answer the same 404 as the writes and never touch the popup tables', async (t) => {
  const app = await popupApp(t);
  for (const user of [staffOf(TENANT_B), superadmin(TENANT_B)]) {
    app.as(user);
    for (const path of PATHS) {
      app.sqls.length = 0;
      const read = await app.call('GET', path);
      assert.equal(app.sqls.some((sql) => /modal_configs/.test(sql)), false, `${path}: no popup table read`);
      const write = await app.call('PUT', path);
      assert.equal(write.status, 404, `${path}: the write refuses`);
      assert.equal(read.status, 404, path);
      assert.deepEqual(read.body, write.body, `${path}: same answer as the write`);
      assert.doesNotMatch(JSON.stringify(read.body), /Private/);
    }
  }
});

test('superadmin without a selected tenant: the reads answer the same 400 as the writes', async (t) => {
  const app = await popupApp(t);
  app.as(superadmin(null));
  for (const path of PATHS) {
    app.sqls.length = 0;
    const read = await app.call('GET', path);
    const write = await app.call('PUT', path);
    assert.equal(write.status, 400);
    assert.equal(read.status, 400, path);
    assert.deepEqual(read.body, write.body, `${path}: same answer as the write`);
    assert.equal(app.sqls.length, 0, `${path}: no query at all`);
  }
});
