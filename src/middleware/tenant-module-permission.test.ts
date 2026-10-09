import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { Request, Response } from 'express';

// S2 T6: a module the superadmin turned off for a tenant is refused by
// hasPermission/checkPermission for everyone but the superadmin.

const TENANT = '11111111-1111-4111-8111-111111111111';
let nextUser = 0;
const userId = () => `c0000000-0000-4000-8000-${String(++nextUser).padStart(12, '0')}`;

async function installFakeDb(t: TestContext, states: Record<string, boolean>, staffGrants: Record<string, boolean>): Promise<void> {
  const pg = await import('pg');
  t.mock.method(pg.default.Pool.prototype, 'query', async (text: string, params: unknown[] = []) => {
    if (text.includes('FROM modules m') && text.includes('LEFT JOIN tenant_modules tm')) {
      assert.equal(params[0], TENANT);
      return { rows: Object.entries(states).map(([code, enabled]) => ({ code, enabled })), rowCount: 1 };
    }
    if (/bool_or\(pgm\.can_\w+\)/.test(text)) {
      return { rows: [{ allowed: staffGrants[String(params[1])] === true }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
}

test('a switched-off module is refused for superuser and staff; superadmin keeps access', async (t) => {
  await installFakeDb(t, { ai_chatbot: false, courses: true, news: false }, { ai_chatbot: true, courses: true });
  const { hasPermission } = await import('./authorize.js');
  const subject = (role: string) => ({ id: userId(), tenantId: TENANT, role: role as 'staff' });

  assert.equal(await hasPermission(subject('superuser'), 'ai_chatbot', 'can_view'), false);
  assert.equal(await hasPermission(subject('staff'), 'ai_chatbot', 'can_view'), false);
  assert.equal(await hasPermission(subject('learner_plus'), 'news', 'can_view'), false);
  assert.equal(await hasPermission(subject('superadmin'), 'ai_chatbot', 'can_edit'), true);

  // Enabled modules keep today's rules (AI course design needs courses.can_edit).
  assert.equal(await hasPermission(subject('superuser'), 'courses', 'can_edit'), true);
  assert.equal(await hasPermission(subject('staff'), 'courses', 'can_edit'), true);
  // Codes that are not modules (no tenant switch exists) are not gated.
  assert.equal(await hasPermission(subject('superuser'), 'enrollments', 'can_edit'), true);
});

test('checkPermission answers a switched-off module with a plain localized refusal', async (t) => {
  await installFakeDb(t, { ai_chatbot: false, courses: true }, { courses: false });
  const { checkPermission, PERMISSION_ERRORS } = await import('./authorize.js');
  const run = async (role: string, moduleCode: string, locale: string) => {
    const out: { status?: number; body?: { code?: string; message?: string }; next: boolean } = { next: false };
    const res = {
      status(code: number) { out.status = code; return this; },
      json(body: unknown) { out.body = body as typeof out.body; return this; },
    } as unknown as Response;
    const req = {
      user: { id: userId(), tenantId: TENANT, role, username: 'u', sessionMode: 'normal' },
      get: (name: string) => (name === 'X-UI-Locale' ? locale : undefined),
    } as unknown as Request;
    await checkPermission(moduleCode, 'can_view')(req, res, () => { out.next = true; });
    return out;
  };

  const off = await run('superuser', 'ai_chatbot', 'en');
  assert.equal(off.status, 403);
  assert.equal(off.body?.code, 'MODULE_DISABLED');
  assert.equal(off.body?.message, PERMISSION_ERRORS.MODULE_DISABLED[2]);

  const denied = await run('staff', 'courses', 'vi');
  assert.equal(denied.body?.code, 'PERMISSION_DENIED');
  assert.equal(denied.body?.message, PERMISSION_ERRORS.PERMISSION_DENIED[1]);

  assert.equal((await run('superadmin', 'ai_chatbot', 'vi')).next, true);
});
