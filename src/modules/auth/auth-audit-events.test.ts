import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { Request, Response } from 'express';

// S2 T17: one-time-link sign-ins, admin password resets and email changes are
// written to the audit log (S1 already audits SSO sign-ins). In-memory pg
// double, no network.

const TENANT = '11111111-1111-4111-8111-111111111111';
const STAFF = 'a0000000-0000-4000-8000-0000000000b1';
const TARGET = 'a0000000-0000-4000-8000-0000000000b2';

interface AuditRow { action: string; code: string; changes: Array<{ field: string; before: unknown; after: unknown }> }

async function installFakeDb(t: TestContext, audits: AuditRow[]): Promise<void> {
  const pg = await import('pg');
  const target = { id: TARGET, username: 'learner1', email: 'old@example.com', full_name: 'L', phone: '', avatar_url: null, role: 'learner', is_active: true, tenant_id: TENANT };
  const handle = async (text: string | { text: string }, params: unknown[] = []) => {
    const sql = typeof text === 'string' ? text : text.text;
    const empty = { rows: [] as unknown[], rowCount: 0 };
    const one = (row: unknown) => ({ rows: [row], rowCount: 1 });
    if (/^\s*INSERT INTO audit_logs/.test(sql)) {
      audits.push({ action: String(params[6]), code: String(params[11]), changes: JSON.parse(String(params[13])) });
      return one({});
    }
    if (sql.includes('FROM users u') && sql.includes('LEFT JOIN tenants t') && sql.includes('WHERE u.id = $1')) {
      return one({ ...target, id: params[0], role: params[0] === STAFF ? 'staff' : 'learner', tenant_name: 'A', tenant_active: true });
    }
    if (sql.includes('bool_or(')) return one({ allowed: true });
    return empty;
  };
  t.mock.method(pg.default.Pool.prototype, 'query', handle);
  t.mock.method(pg.default.Pool.prototype, 'connect', async () => ({ query: handle, release: () => undefined }));
}

function response(): { res: Response; out: { status?: number; body?: unknown } } {
  const out: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) { out.status = code; return this; },
    json(body: unknown) { out.body = body; return this; },
  } as unknown as Response;
  return { res, out };
}

test('a one-time-link sign-in is audited as a LOGIN', async (t) => {
  const audits: AuditRow[] = [];
  await installFakeDb(t, audits);
  const authService = await import('./auth.service.js');
  const { exchangeOTTController } = await import('./auth.controller.js');
  const ott = authService.generateOTT(STAFF);
  const { res, out } = response();
  const req = { body: { ott }, headers: {}, ip: '203.0.113.5', socket: {}, get: () => undefined } as unknown as Request;
  await exchangeOTTController(req, res, (err?: unknown) => { throw err; });
  assert.equal((out.body as { success: boolean }).success, true);
  assert.deepEqual(audits.map((row) => [row.action, row.code]), [['LOGIN', 'auth.ott_login.succeeded']]);
});

test('the audit contract accepts email and password-reset changes on user.updated', async () => {
  const { normalizeStructuredAuditEvent } = await import('../audit-logs/audit-event.contract.js');
  const normalized = normalizeStructuredAuditEvent({
    code: 'user.updated',
    changes: [
      { field: 'email', before: 'old@example.com', after: 'new@example.com' },
      { field: 'password_reset', before: false, after: true },
    ],
  });
  assert.deepEqual(normalized.changes.map((change) => change.field), ['email', 'password_reset']);
  assert.equal(normalized.viewerScope, 'tenant');
  assert.equal(normalizeStructuredAuditEvent({ code: 'auth.ott_login.succeeded' }).viewerScope, 'tenant');
});
