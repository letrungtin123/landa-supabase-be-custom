import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { type TestContext } from 'node:test';
import type { NextFunction, Request, Response } from 'express';

// GET /api/ai-credits/usage follows the AI Chatbot module rule and never
// lets learners in. The real guards run; only the database answers are faked.

const TENANT_ON = '21111111-1111-4111-8111-111111111111';
const TENANT_OFF = '22222222-2222-4222-8222-222222222222';
let nextUser = 0;
const userId = () => `d0000000-0000-4000-8000-${String(++nextUser).padStart(12, '0')}`;

/** ai_chatbot is on for TENANT_ON and off for TENANT_OFF; `grants` = users whose group can view ai_chatbot. */
async function installFakeDb(t: TestContext, grants: Set<string>): Promise<void> {
  const pg = await import('pg');
  t.mock.method(pg.default.Pool.prototype, 'query', async (text: string, params: unknown[] = []) => {
    if (text.includes('FROM modules m') && text.includes('LEFT JOIN tenant_modules tm')) {
      return { rows: [{ code: 'ai_chatbot', enabled: params[0] === TENANT_ON }, { code: 'courses', enabled: true }], rowCount: 2 };
    }
    if (/bool_or\(pgm\.can_view\)/.test(text)) {
      return { rows: [{ allowed: params[1] === 'ai_chatbot' && grants.has(String(params[0])) }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
}

interface Outcome { status?: number; body?: { code?: string; message?: string }; next: boolean }

async function runChain(role: string, tenantId: string, id = userId(), locale = 'vi'): Promise<Outcome> {
  const { aiUsageAccess } = await import('./ai-credit.access.js');
  const out: Outcome = { next: false };
  const res = {
    status(code: number) { out.status = code; return this; },
    json(body: unknown) { out.body = body as Outcome['body']; return this; },
  } as unknown as Response;
  const req = {
    user: { id, tenantId, role, username: 'u', sessionMode: 'normal' },
    get: (name: string) => (name === 'X-UI-Locale' ? locale : undefined),
  } as unknown as Request;
  for (const guard of aiUsageAccess) {
    let passed = false;
    await (guard as (req: Request, res: Response, next: NextFunction) => unknown)(req, res, () => { passed = true; });
    if (!passed) return out;
  }
  out.next = true;
  return out;
}

test('superadmin always reads AI usage, even for a tenant without the AI Chatbot module', async (t) => {
  await installFakeDb(t, new Set());
  assert.equal((await runChain('superadmin', TENANT_OFF)).next, true);
  assert.equal((await runChain('superadmin', TENANT_ON)).next, true);
});

test('superuser: allowed with the module, refused without it (plain message, code)', async (t) => {
  await installFakeDb(t, new Set());
  assert.equal((await runChain('superuser', TENANT_ON)).next, true);
  const off = await runChain('superuser', TENANT_OFF);
  assert.equal(off.next, false);
  assert.equal(off.status, 403);
  assert.equal(off.body?.code, 'MODULE_DISABLED');
  assert.equal(off.body?.message, 'Tính năng này chưa được bật cho doanh nghiệp của bạn.');
});

test('staff: needs the module and can_view on ai_chatbot', async (t) => {
  const viewer = userId();
  const viewerOff = userId();
  await installFakeDb(t, new Set([viewer, viewerOff]));
  assert.equal((await runChain('staff', TENANT_ON, viewer)).next, true);
  const noView = await runChain('staff', TENANT_ON);
  assert.equal(noView.status, 403);
  assert.equal(noView.body?.code, 'PERMISSION_DENIED');
  assert.equal(noView.body?.message, 'Bạn không có quyền thực hiện thao tác này.');
  const moduleOff = await runChain('staff', TENANT_OFF, viewerOff);
  assert.equal(moduleOff.body?.code, 'MODULE_DISABLED', 'a permission does not open a module that is off');
});

test('learner_plus and learner never read AI usage, even with an ai_chatbot permission', async (t) => {
  const plus = userId();
  const learner = userId();
  await installFakeDb(t, new Set([plus, learner]));
  for (const [role, id] of [['learner_plus', plus], ['learner', learner]] as const) {
    const out = await runChain(role, TENANT_ON, id);
    assert.equal(out.next, false, role);
    assert.equal(out.status, 403);
    assert.equal(out.body?.code, 'AI_USAGE_FORBIDDEN');
    assert.equal(out.body?.message, 'Bạn không có quyền xem mức dùng AI.');
  }
  assert.equal((await runChain('learner_plus', TENANT_ON, plus, 'en')).body?.message, 'You do not have permission to see AI usage.');
});

test('the usage route uses this chain after authentication and the tenant context', () => {
  const routes = readFileSync(new URL('./ai-credit.routes.ts', import.meta.url), 'utf8');
  assert.match(routes, /router\.get\('\/usage', authenticate, tenantContext, \.\.\.aiUsageAccess, controller\.getUsage\);/);
});
