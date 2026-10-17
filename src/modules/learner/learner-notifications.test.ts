import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { Request, Response } from 'express';

// M1: GET /api/learner/notifications answers { data, total, unread_count } as
// before, with total and unread from one query; the header's
// GET /notifications/unread-count is cached per user (30 s) and invalidated
// when the user reads notifications or the tenant's notifications change.

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = 'a0000000-0000-4000-8000-0000000000n1';

const notifications = [
  { id: 'n3', title: 'C', message: 'm3', course_id: null, type: 'system', metadata: {}, created_at: new Date('2026-10-03T00:00:00Z'), is_read: false, read_at: null, sent_by_name: 'Admin' },
  { id: 'n2', title: 'B', message: 'm2', course_id: 'course-v1:A+1', type: 'course_manual_notification', metadata: {}, created_at: new Date('2026-10-02T00:00:00Z'), is_read: true, read_at: new Date('2026-10-02T01:00:00Z'), sent_by_name: null },
  { id: 'n1', title: 'A', message: 'm1', course_id: null, type: 'system', metadata: {}, created_at: new Date('2026-10-01T00:00:00Z'), is_read: false, read_at: null, sent_by_name: 'Admin' },
];

async function installFakeDb(t: TestContext): Promise<Array<{ sql: string; params: unknown[] }>> {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pg = await import('pg');
  t.mock.method(pg.default.Pool.prototype, 'query', async (text: string, params: unknown[] = []) => {
    calls.push({ sql: text, params });
    if (text.includes('COUNT(*) OVER()')) {
      const [, , limit, offset] = params as [string, string, number, number];
      const unread = notifications.filter((n) => n.is_read === false).length;
      const rows = notifications.slice(offset, offset + limit)
        .map((n) => ({ ...n, full_count: String(notifications.length), unread_full_count: String(unread) }));
      return { rows, rowCount: rows.length };
    }
    if (text.includes('nr.is_read = false') && text.includes('COUNT(*) AS count')) {
      return { rows: [{ count: String(notifications.filter((n) => n.is_read === false).length) }], rowCount: 1 };
    }
    if (text.includes('tenant_demo_iframe_settings')) return { rows: [{ exists: false }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
  return calls;
}

function call(handler: (req: Request, res: Response, next: (err?: unknown) => void) => Promise<void>, query: Record<string, string>) {
  const out: { status?: number; body?: { success: boolean; data: any } } = {};
  const res = {
    status(code: number) { out.status = code; return this; },
    json(value: unknown) { out.body = value as typeof out.body; return this; },
  } as unknown as Response;
  const req = { query, params: {}, user: { id: USER, tenantId: TENANT, role: 'learner', username: 'l', sessionMode: 'normal' } } as unknown as Request;
  return handler(req, res, (err?: unknown) => { throw err; }).then(() => out);
}

test('the list answers the same shape with total and unread from one query', async (t) => {
  const calls = await installFakeDb(t);
  const ctrl = await import('./learner.controller.js');
  const out = await call(ctrl.listNotifications, { page_size: '2' });
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, {
    success: true,
    data: {
      data: notifications.slice(0, 2),
      total: 3,
      unread_count: 2,
    },
  });
  assert.equal(calls.length, 1, 'one query: no separate unread COUNT');
  assert.match(calls[0].sql, /COUNT\(\*\) FILTER \(WHERE nr\.is_read = false\) OVER\(\) AS unread_full_count/);
});

test('a page past the end keeps total 0 and still reports the unread count', async (t) => {
  const calls = await installFakeDb(t);
  const svc = await import('./learner.service.js');
  const result = await svc.getMyNotifications(USER, TENANT, { page: 5, page_size: 20 });
  assert.deepEqual(result, { data: [], total: 0, unread_count: 2 });
  assert.equal(calls.filter((c) => c.sql.includes('COUNT(*) AS count')).length, 1);
});

test('the unread-count endpoint keeps its { count } answer', async (t) => {
  await installFakeDb(t);
  const ctrl = await import('./learner.controller.js');
  const out = await call(ctrl.getUnreadCount, {});
  assert.deepEqual(out.body, { success: true, data: { count: 2 } });
});

test('reading notifications still writes as before', async (t) => {
  const calls = await installFakeDb(t);
  const svc = await import('./learner.service.js');
  await svc.markNotificationRead(USER, 'n3');
  await svc.markAllNotificationsRead(USER, TENANT);
  const updates = calls.filter((c) => c.sql.includes('UPDATE notification_recipients'));
  assert.equal(updates.length, 2);
  assert.deepEqual(updates[0].params, [USER, 'n3']);
  assert.deepEqual(updates[1].params, [USER, TENANT]);
});
