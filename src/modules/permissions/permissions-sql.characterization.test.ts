import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  answers,
  callHandler,
  failWhen,
  noRowsWhen,
  registerCharacterization,
  rowsWhen,
  type Answer,
  type Case,
  type CallOptions,
  type Handler,
} from '../../test-support/sql-characterization.js';

// Characterization of the permission group routes (/api/permission-groups)
// and of replaceUserPermissionGroup (the users module's path): every SQL
// statement (text without whitespace differences, parameters, pool or
// transaction client, client releases) and the answer of every handler. The
// golden file was written by the code before the permission group
// repository existed; moving SQL into repositories must keep every entry equal.
//
// No database, Redis or network: a pg double answers every statement with one
// fixed row (or none, or an error, per case); the demo iframe lookups find no
// locked demo learner unless a case says so. Rewrite the golden file only for
// an intended change:
//   PERMISSIONS_SQL_GOLDEN_WRITE=1 npx tsx --test src/modules/permissions/permissions-sql.characterization.test.ts
// PERMISSIONS_SQL_FULL_OUT=<file> also writes every outcome in full.

process.env.TZ = 'Asia/Ho_Chi_Minh';
process.env.REDIS_URL = 'redis://127.0.0.1:1';
// History cursors are signed with JWT_SECRET: the CI value, whatever .env says.
process.env.JWT_SECRET = 'ci-placeholder-not-a-secret';

const redis = await import('../../config/redis.js');
const { pool } = await import('../../config/database.js');
const ctrl = await import('./permissions.controller.js');
const service = await import('./permissions.service.js');

redis.installRedisClient(null);

const { after } = await import('node:test');
after(async () => {
  await pool.end();
});

const TENANT = '11111111-1111-4111-8111-111111111111';
const ACTOR = 'a0000000-0000-4000-8000-000000000001';
const MEMBER = 'a0000000-0000-4000-8000-000000000002';
const MEMBER_2 = 'a0000000-0000-4000-8000-000000000003';
const GROUP = 'c0000000-0000-4000-8000-000000000001';
const GROUP_2 = 'c0000000-0000-4000-8000-000000000002';
const HISTORY = 'd0000000-0000-4000-8000-000000000001';
const MODULE = 'e0000000-0000-4000-8000-000000000001';

/** One row with every column a permission group statement reads. */
const ROW = {
  id: GROUP,
  name: 'Nhóm A',
  description: 'Mô tả',
  tenant_id: TENANT,
  tenant_name: 'Doanh nghiệp A',
  created_at: '2026-03-01T00:00:00.000Z',
  updated_at: '2026-03-02T00:00:00.000Z',
  member_count: '2',
  count: '3',
  total: '5',
  module_code: 'courses',
  module_name: 'Khóa học',
  module_icon: 'book',
  module_id: MODULE,
  code: 'courses',
  icon: 'book',
  sort_order: 1,
  can_view: true,
  can_add: false,
  can_edit: false,
  can_delete: false,
  username: 'staff01',
  full_name: 'Nhân Viên',
  email: 'staff@a.test',
  role: 'staff',
  avatar_url: null,
  previous_group_id: null,
  previous_group_name: null,
  permission_group_id: GROUP,
  permission_group_name: 'Nhóm A',
  action: 'created',
  actor_id: ACTOR,
  actor_username: 'admin',
  actor_display_name: 'Quản Trị',
  actor_email: 'admin@a.test',
  actor_role: 'superuser',
  before_state: null,
  after_state: { group: { id: GROUP } },
  participants: [],
};

const ADMIN = { id: ACTOR, tenantId: TENANT, role: 'superuser', username: 'admin', sessionMode: 'normal' };
const NO_DEMO: Answer = noRowsWhen(/SELECT demo_user_id/);

const cases: Case[] = [];
const add = (name: string, run: () => Promise<unknown>, answer?: Answer) =>
  cases.push({ name, run, answer: answer ? answers(answer, NO_DEMO) : NO_DEMO });
const call = (handler: Handler, options: CallOptions = {}) =>
  callHandler(handler, { originalUrl: '/api/permission-groups', params: { id: GROUP }, ...options }, ADMIN);
const H = ctrl;
const MATRIX = [{ module_code: 'courses', can_view: true, can_add: true, can_edit: false, can_delete: false }];
const SAME_MATRIX = [{ module_code: 'courses', can_view: true, can_add: false, can_edit: false, can_delete: false }];
const actor = { id: ACTOR, username: 'admin', role: 'superuser' };

// ── Groups ──
add('list', () => call(H.listController));
add('list search', () => call(H.listController, { query: { search: 'Nhóm', page: '2', page_size: '5' } }));
add('list no tenant', () => call(H.listController, { user: { tenantId: null } }));
add('list odd query', () => call(H.listController, { query: { search: ['x'], page: 'abc' } }));
add('get', () => call(H.getByIdController));
add('get missing', () => call(H.getByIdController), noRowsWhen(/WHERE pg.id = \$1::uuid AND pg.tenant_id/));
add('get bad id', () => call(H.getByIdController, { params: { id: 'nope' } }));
add('get no tenant', () => call(H.getByIdController, { user: { tenantId: null } }));
add('create', () => call(H.createController, { method: 'POST', body: { name: 'Nhóm B', description: 'Mới' } }), noRowsWhen(/SELECT id FROM permission_groups WHERE tenant_id/));
add('create no description', () => call(H.createController, { method: 'POST', body: { name: 'Nhóm B' } }), noRowsWhen(/SELECT id FROM permission_groups WHERE tenant_id/));
add('create duplicate', () => call(H.createController, { method: 'POST', body: { name: 'Nhóm A' } }));
add('create invalid', () => call(H.createController, { method: 'POST', body: { name: '' } }));
add('create no tenant', () => call(H.createController, { method: 'POST', body: { name: 'x' }, user: { tenantId: null } }));
add('update rename', () => call(H.updateController, { method: 'PUT', body: { name: 'Nhóm C' } }), noRowsWhen(/AND id <> \$3::uuid/));
add('update rename duplicate', () => call(H.updateController, { method: 'PUT', body: { name: 'Nhóm C' } }));
add('update description', () => call(H.updateController, { method: 'PUT', body: { description: 'Khác' } }));
add('update unchanged', () => call(H.updateController, { method: 'PUT', body: { name: 'Nhóm A', description: 'Mô tả' } }));
add('update empty', () => call(H.updateController, { method: 'PUT', body: {} }));
add('update missing', () => call(H.updateController, { method: 'PUT', body: { description: 'x' } }), noRowsWhen(/FOR UPDATE/));
add('update invalid', () => call(H.updateController, { method: 'PUT', body: { name: 'x'.repeat(101) } }));
add('update bad id', () => call(H.updateController, { method: 'PUT', params: { id: '1' }, body: { name: 'x' } }));
add('delete', () => call(H.deleteController, { method: 'DELETE' }));
add('delete missing', () => call(H.deleteController, { method: 'DELETE' }), noRowsWhen(/FOR UPDATE/));
add('delete no tenant', () => call(H.deleteController, { method: 'DELETE', user: { tenantId: null } }));

// ── Matrix ──
add('matrix', () => call(H.updateMatrixController, { method: 'PUT', body: { permissions: MATRIX } }));
add('matrix unchanged', () => call(H.updateMatrixController, { method: 'PUT', body: { permissions: SAME_MATRIX } }));
add('matrix incomplete', () =>
  call(H.updateMatrixController, {
    method: 'PUT',
    body: { permissions: [...MATRIX, { module_code: 'news', can_view: true, can_add: false, can_edit: false, can_delete: false }] },
  }),
);
add('matrix protected', () =>
  call(H.updateMatrixController, {
    method: 'PUT',
    body: { permissions: [{ module_code: 'permission_groups', can_view: true, can_add: true, can_edit: true, can_delete: true }] },
  }),
);
add('matrix duplicate', () => call(H.updateMatrixController, { method: 'PUT', body: { permissions: [...MATRIX, ...MATRIX] } }));
add('matrix invalid', () => call(H.updateMatrixController, { method: 'PUT', body: { permissions: [{ module_code: 'x' }] } }));
add('matrix missing group', () => call(H.updateMatrixController, { method: 'PUT', body: { permissions: MATRIX } }), noRowsWhen(/FOR UPDATE/));
add('matrix no modules', () => call(H.updateMatrixController, { method: 'PUT', body: { permissions: [] } }), noRowsWhen(/^SELECT m.code\s/));

// ── Members ──
add('add members', () => call(H.addMembersController, { method: 'POST', body: { user_ids: [MEMBER] } }));
add('add members already in group', () =>
  call(H.addMembersController, { method: 'POST', body: { user_ids: [MEMBER] } }),
  rowsWhen(/AS previous_group_id/, [{ ...ROW, id: MEMBER, previous_group_id: GROUP, previous_group_name: 'Nhóm A' }]),
);
add('add members from other group', () =>
  call(H.addMembersController, { method: 'POST', body: { user_ids: [MEMBER] } }),
  rowsWhen(/AS previous_group_id/, [{ ...ROW, id: MEMBER, previous_group_id: GROUP_2, previous_group_name: 'Nhóm B' }]),
);
add('add members not eligible', () => call(H.addMembersController, { method: 'POST', body: { user_ids: [MEMBER, MEMBER_2] } }));
add('add members demo locked', () =>
  call(H.addMembersController, { method: 'POST', body: { user_ids: [MEMBER] } }),
  rowsWhen(/SELECT demo_user_id/, [{ demo_user_id: MEMBER }]),
);
add('add members empty', () => call(H.addMembersController, { method: 'POST', body: { user_ids: [] } }));
add('add members duplicate', () => call(H.addMembersController, { method: 'POST', body: { user_ids: [MEMBER, MEMBER] } }));
add('add members no body', () => call(H.addMembersController, { method: 'POST', body: {} }));
add('add members missing group', () => call(H.addMembersController, { method: 'POST', body: { user_ids: [MEMBER] } }), noRowsWhen(/FROM permission_groups\s+WHERE id = \$1::uuid AND tenant_id = \$2::uuid\s+FOR UPDATE/));
add('remove member', () => call(H.removeMemberController, { method: 'DELETE', params: { id: GROUP, userId: MEMBER } }));
add('remove member not in group', () =>
  call(H.removeMemberController, { method: 'DELETE', params: { id: GROUP, userId: MEMBER } }),
  noRowsWhen(/AND u.id = ANY\(\$3::uuid\[\]\)/),
);
add('remove self', () => call(H.removeMemberController, { method: 'DELETE', params: { id: GROUP, userId: ACTOR } }));
add('remove member bad id', () => call(H.removeMemberController, { method: 'DELETE', params: { id: GROUP, userId: 'x' } }));
add('remove member demo locked', () =>
  call(H.removeMemberController, { method: 'DELETE', params: { id: GROUP, userId: MEMBER } }),
  rowsWhen(/AS exists/, [{ exists: true }]),
);

// ── Configuration ──
add('configuration', () =>
  call(H.saveConfigurationController, { method: 'PUT', body: { permissions: MATRIX, add_user_ids: [MEMBER], remove_user_ids: [MEMBER_2] } }),
  rowsWhen(/AND u.id = ANY\(\$3::uuid\[\]\)/, [{ ...ROW, id: MEMBER_2 }]),
);
add('configuration matrix only', () => call(H.saveConfigurationController, { method: 'PUT', body: { permissions: MATRIX } }));
add('configuration unchanged', () => call(H.saveConfigurationController, { method: 'PUT', body: { permissions: SAME_MATRIX } }));
add('configuration members only', () =>
  call(H.saveConfigurationController, { method: 'PUT', body: { permissions: SAME_MATRIX, add_user_ids: [MEMBER] } }),
);
add('configuration remove self', () =>
  call(H.saveConfigurationController, { method: 'PUT', body: { permissions: SAME_MATRIX, remove_user_ids: [ACTOR] } }),
);
add('configuration add and remove same', () =>
  call(H.saveConfigurationController, { method: 'PUT', body: { permissions: SAME_MATRIX, add_user_ids: [MEMBER], remove_user_ids: [MEMBER] } }),
);
add('configuration invalid', () => call(H.saveConfigurationController, { method: 'PUT', body: { permissions: 'x' } }));

// ── History ──
add('history', () => call(H.listHistoryController));
add('history filtered', () =>
  call(H.listHistoryController, { query: { search: ' Nhân Viên ', from: '2026-01-01', to: '2026-02-01', page_size: '5' } }),
);
add('history more pages', () =>
  call(H.listHistoryController, { query: { page_size: '1' } }),
  rowsWhen(/ORDER BY h.created_at DESC, h.id DESC/, Array.from({ length: 11 }, (_v, i) => ({ ...ROW, id: `d0000000-0000-4000-8000-0000000000${String(i + 10)}` }))),
);
add('history bad cursor', () => call(H.listHistoryController, { query: { cursor: 'abc' } }));
add('history bad dates', () => call(H.listHistoryController, { query: { from: '2026-02-30' } }));
add('history reversed dates', () => call(H.listHistoryController, { query: { from: '2026-03-01', to: '2026-02-01' } }));
add('history bad count', () => call(H.listHistoryController), rowsWhen(/AS total/, [{ total: '-1' }]));
add('history no tenant', () => call(H.listHistoryController, { user: { tenantId: null } }));
add('history detail', () => call(H.getHistoryDetailController, { params: { historyId: HISTORY } }));
add('history detail missing', () => call(H.getHistoryDetailController, { params: { historyId: HISTORY } }), noRowsWhen(/FROM permission_group_history h/));
add('history detail bad id', () => call(H.getHistoryDetailController, { params: { historyId: 'x' } }));

// ── Users module path ──
const TARGET_LOCK = /FROM permission_groups\s+WHERE id = \$1::uuid AND tenant_id = \$2::uuid\s+FOR UPDATE/;
const target: Answer = rowsWhen(TARGET_LOCK, [{ ...ROW, id: GROUP_2, name: 'Nhóm B' }]);
add('replace group move', () => service.replaceUserPermissionGroup(MEMBER, GROUP_2, TENANT, actor), target);
add('replace group same', () => service.replaceUserPermissionGroup(MEMBER, GROUP, TENANT, actor));
add('replace group clear', () => service.replaceUserPermissionGroup(MEMBER, null, TENANT, actor));
add('replace group first', () =>
  service.replaceUserPermissionGroup(MEMBER, GROUP_2, TENANT, actor),
  noRowsWhen(/ORDER BY upg.created_at DESC, upg.id DESC\s+FOR UPDATE/),
);
add('replace group nothing', () =>
  service.replaceUserPermissionGroup(MEMBER, null, TENANT, actor),
  noRowsWhen(/ORDER BY upg.created_at DESC, upg.id DESC\s+FOR UPDATE/),
);
add('replace group two current', () =>
  service.replaceUserPermissionGroup(MEMBER, GROUP_2, TENANT, actor),
  rowsWhen(/ORDER BY upg.created_at DESC, upg.id DESC\s+FOR UPDATE/, [ROW, { ...ROW, id: GROUP_2 }]),
);
add('replace group learner', () =>
  service.replaceUserPermissionGroup(MEMBER, GROUP_2, TENANT, actor),
  rowsWhen(/AND deletion_requested_at IS NULL/, [{ ...ROW, id: MEMBER, role: 'learner' }]),
);
add('replace group missing user', () =>
  service.replaceUserPermissionGroup(MEMBER, GROUP_2, TENANT, actor),
  noRowsWhen(/AND deletion_requested_at IS NULL/),
);
add('replace group demo', () =>
  service.replaceUserPermissionGroup(MEMBER, GROUP_2, TENANT, actor),
  rowsWhen(/AS exists/, [{ exists: true }]),
);
add('replace group demo table missing', () =>
  service.replaceUserPermissionGroup(MEMBER, GROUP_2, TENANT, actor),
  answers(target, failWhen(/AS exists/, { code: '42P01', message: 'no table' })),
);

registerCharacterization({
  title: 'permissions characterization',
  goldenPath: path.join(path.dirname(fileURLToPath(import.meta.url)), 'permissions-sql.characterization.golden.json'),
  writeEnv: 'PERMISSIONS_SQL_GOLDEN_WRITE',
  fullOutEnv: 'PERMISSIONS_SQL_FULL_OUT',
  pool,
  defaultRow: ROW,
  cases,
  fixedIds: [TENANT, ACTOR, MEMBER, MEMBER_2, GROUP, GROUP_2, HISTORY, MODULE],
  now: Date.parse('2026-10-18T03:04:05.000Z'),
});
