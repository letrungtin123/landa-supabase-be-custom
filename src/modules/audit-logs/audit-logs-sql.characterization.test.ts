import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  callHandler,
  noRowsWhen,
  registerCharacterization,
  rowsWhen,
  type Answer,
  type Case,
  type CallOptions,
  type Handler,
} from '../../test-support/sql-characterization.js';

// Characterization of the audit log routes (/api/audit-logs): every SQL
// statement (text without whitespace differences, parameters, pool or
// transaction client) and the answer of the list (legacy pages and cursor
// pages) and detail handlers, for every viewer role and filter. The golden
// file was written by the code before the audit log repository existed;
// moving SQL into repositories must keep every entry equal.
//
// No database, Redis or network: a pg double answers every statement with one
// fixed row (or none, per case). Rewrite the golden file only for an intended
// change:
//   AUDIT_LOGS_SQL_GOLDEN_WRITE=1 npx tsx --test src/modules/audit-logs/audit-logs-sql.characterization.test.ts
// AUDIT_LOGS_SQL_FULL_OUT=<file> also writes every outcome in full.

process.env.TZ = 'Asia/Ho_Chi_Minh';
process.env.REDIS_URL = 'redis://127.0.0.1:1';
// Audit log cursors are signed with JWT_SECRET: the CI value, whatever .env says.
process.env.JWT_SECRET = 'ci-placeholder-not-a-secret';

const redis = await import('../../config/redis.js');
const { pool } = await import('../../config/database.js');
const ctrl = await import('./audit-logs.controller.js');

redis.installRedisClient(null);

const { after } = await import('node:test');
after(async () => {
  await pool.end();
});

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = 'a0000000-0000-4000-8000-000000000001';
const LOG = 'e0000000-0000-4000-8000-000000000001';
const LOG_2 = 'e0000000-0000-4000-8000-000000000002';

/** One row with every column an audit log statement reads. */
const ROW = {
  id: LOG,
  actor_username: 'admin01',
  actor_display_name: 'Quản Trị',
  actor_email: 'admin@a.test',
  subject_display_name: null,
  subject_username: null,
  subject_email: null,
  subject_role: null,
  action: 'UPDATE',
  entity_type: 'course',
  entity_id: 'x',
  entity_name: 'Khóa học',
  details: null,
  ip_address: '127.0.0.1',
  created_at: '2026-10-10T00:00:00.000Z',
  event_code: 'course.updated',
  event_metadata: {},
  changes: [],
  count: '42',
};

const STAFF = { id: USER, tenantId: TENANT, role: 'staff', username: 'admin01', sessionMode: 'normal' };

const cases: Case[] = [];
const add = (name: string, run: () => Promise<unknown>, answer?: Answer) => cases.push({ name, run, answer });
const call = (handler: Handler, options: CallOptions = {}) =>
  callHandler(handler, { originalUrl: '/api/audit-logs', params: { id: LOG }, ...options }, STAFF);
const H = ctrl;
const PAGE = /ORDER BY a.created_at DESC, a.id DESC/;
const cursorFor = async () => {
  const listed = (await call(H.listController, { query: { pagination: 'cursor', page_size: '5' } })) as {
    body?: { data?: { next_cursor?: string } };
  };
  return listed.body?.data?.next_cursor ?? '';
};
const SIX = rowsWhen(PAGE, Array.from({ length: 6 }, (_v, i) => ({ ...ROW, id: i === 5 ? LOG_2 : LOG })));

for (const role of ['staff', 'superuser', 'superadmin', 'learner']) {
  add(`list ${role}`, () => call(H.listController, { user: { role } }));
  add(`detail ${role}`, () => call(H.detailController, { user: { role } }));
}
add('list filtered', () =>
  call(H.listController, { query: { search: ' khóa ', action: 'DELETE', date_from: '2026-10-01', date_to: '2026-10-15', page: '2', page_size: '20' } }),
);
add('list short search all actions', () => call(H.listController, { query: { search: 'k', action: 'all' } }));
add('list bad action', () => call(H.listController, { query: { action: 'DROP' } }));
add('list bad page size', () => call(H.listController, { query: { page_size: '7' } }));
add('list deep page', () => call(H.listController, { query: { page: '2001', page_size: '5' } }));
add('list platform', () => call(H.listController, { user: { role: 'superadmin', tenantId: null }, query: { scope: 'platform' } }));
add('list platform not superadmin', () => call(H.listController, { query: { scope: 'platform' } }));
add('list bad scope', () => call(H.listController, { query: { scope: 'all' } }));
add('list no tenant', () => call(H.listController, { user: { tenantId: null } }));
add('list empty', () => call(H.listController), text => (/COUNT\(\*\)/.test(text) ? { rows: [{ count: '0' }] } : { rows: [] }));
add('cursor first page', () => call(H.listController, { query: { pagination: 'cursor', page_size: '5' } }), SIX);
add('cursor last page', () => call(H.listController, { query: { pagination: 'cursor' } }));
add('cursor next page', async () => {
  const cursor = await cursorFor();
  return call(H.listController, { query: { pagination: 'cursor', page_size: '5', cursor, search: 'ab' } });
}, SIX);
add('cursor forged', () => call(H.listController, { query: { pagination: 'cursor', cursor: 'eyJ2IjoxfQ.forged' } }));
add('cursor malformed', () => call(H.listController, { query: { pagination: 'cursor', cursor: 'a.b.c' } }));
add('cursor platform', () => call(H.listController, { user: { role: 'superadmin' }, query: { pagination: 'cursor', scope: 'platform' } }));
add('detail missing', () => call(H.detailController), noRowsWhen(/LIMIT 1/));
add('detail bad id', () => call(H.detailController, { params: { id: 'nope' } }));
add('detail platform', () => call(H.detailController, { user: { role: 'superadmin', tenantId: null }, query: { scope: 'platform' } }));
add('detail filtered', () => call(H.detailController, { query: { action: 'LOGIN', date_from: '2026-10-01' } }));

registerCharacterization({
  title: 'audit logs characterization',
  goldenPath: path.join(path.dirname(fileURLToPath(import.meta.url)), 'audit-logs-sql.characterization.golden.json'),
  writeEnv: 'AUDIT_LOGS_SQL_GOLDEN_WRITE',
  fullOutEnv: 'AUDIT_LOGS_SQL_FULL_OUT',
  pool,
  defaultRow: ROW,
  cases,
  fixedIds: [TENANT, USER, LOG, LOG_2],
  now: Date.parse('2026-10-18T03:04:05.000Z'),
});
