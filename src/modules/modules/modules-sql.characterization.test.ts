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

// Characterization of the system module routes (/api/modules): every SQL
// statement (text without whitespace differences, parameters, pool or
// transaction client) and the answer of every handler. The golden file was
// written by the code before the modules repository existed; moving SQL into
// repositories must keep every entry equal.
//
// No database, Redis or network: a pg double answers every statement with one
// fixed row (or none, per case). Rewrite the golden file only for an intended
// change:
//   MODULES_SQL_GOLDEN_WRITE=1 npx tsx --test src/modules/modules/modules-sql.characterization.test.ts
// MODULES_SQL_FULL_OUT=<file> also writes every outcome in full.

process.env.TZ = 'Asia/Ho_Chi_Minh';
process.env.REDIS_URL = 'redis://127.0.0.1:1';

const redis = await import('../../config/redis.js');
const { pool } = await import('../../config/database.js');
const ctrl = await import('./modules.controller.js');

redis.installRedisClient(null);

const { after } = await import('node:test');
after(async () => {
  await pool.end();
});

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = 'a0000000-0000-4000-8000-000000000001';
const MODULE = 'c0000000-0000-4000-8000-000000000001';

const ROW = {
  id: MODULE,
  code: 'news',
  name: 'Bảng tin',
  description: 'Tin tức',
  icon: 'Newspaper',
  sort_order: 4,
  is_active: true,
  created_at: '2026-01-01T00:00:00.000Z',
  full_name: 'Quản Trị',
  email: 'root@a.test',
};

const ROOT = { id: USER, tenantId: TENANT, role: 'superadmin', username: 'root', sessionMode: 'normal' };

const cases: Case[] = [];
const add = (name: string, run: () => Promise<unknown>, answer?: Answer) => cases.push({ name, run, answer });
const call = (handler: Handler, options: CallOptions = {}) =>
  callHandler(handler, { originalUrl: '/api/modules', params: { id: MODULE }, ...options }, ROOT);
const H = ctrl;
const FREE_CODE = noRowsWhen(/SELECT id FROM modules WHERE code/);

add('list', () => call(H.listController));
add('list empty', () => call(H.listController), noRowsWhen(/FROM modules/));
add('create', () => call(H.createController, { method: 'POST', body: { code: 'quiz_bank', name: 'Ngân hàng câu hỏi', description: 'x', icon: 'Box', sort_order: 9 } }), FREE_CODE);
add('create minimal', () => call(H.createController, { method: 'POST', body: { code: 'faq', name: 'FAQ' } }), FREE_CODE);
add('create taken', () => call(H.createController, { method: 'POST', body: { code: 'news', name: 'x' } }));
add('create invalid', () => call(H.createController, { method: 'POST', body: { code: 'Bad-Code', name: '' } }));
add('create no tenant', () => call(H.createController, { method: 'POST', body: { code: 'faq', name: 'FAQ' }, user: { tenantId: null } }), FREE_CODE);
add('update', () => call(H.updateController, { method: 'PUT', body: { name: 'Tin', description: 'd', icon: 'i', sort_order: 1, is_active: false } }));
add('update unchanged', () => call(H.updateController, { method: 'PUT', body: { name: 'Bảng tin' } }));
add('update nothing', () => call(H.updateController, { method: 'PUT', body: {} }));
add('update missing', () => call(H.updateController, { method: 'PUT', body: { name: 'x' } }), noRowsWhen(/FOR UPDATE/));
add('update vanished', () => call(H.updateController, { method: 'PUT', body: { name: 'x' } }), noRowsWhen(/^UPDATE modules/));
add('update changes', () =>
  call(H.updateController, { method: 'PUT', body: { sort_order: 2 } }),
  rowsWhen(/FOR UPDATE/, [{ name: 'Cũ', sort_order: 1, is_active: false }]),
);
add('update invalid', () => call(H.updateController, { method: 'PUT', body: { sort_order: 'x' } }));

registerCharacterization({
  title: 'modules characterization',
  goldenPath: path.join(path.dirname(fileURLToPath(import.meta.url)), 'modules-sql.characterization.golden.json'),
  writeEnv: 'MODULES_SQL_GOLDEN_WRITE',
  fullOutEnv: 'MODULES_SQL_FULL_OUT',
  pool,
  defaultRow: ROW,
  cases,
  fixedIds: [TENANT, USER, MODULE],
  now: Date.parse('2026-10-18T03:04:05.000Z'),
});
