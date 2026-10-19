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

// Characterization of the tenant routes (/api/tenants): every SQL statement
// (text without whitespace differences, parameters, pool or transaction
// client) and the answer (status, body, or the error passed to next) of the
// tenant, module, label, SMTP, course component and user-tenant handlers,
// plus the tenant helpers other modules call (checkQuota, component checks,
// SMTP config for sending). The golden file was written by the code before
// the tenant repositories existed; moving SQL into repositories must keep
// every entry equal. The data quota code has its own, byte-exact file
// (tenant-data-quota-sql.characterization.test.ts).
//
// No database, Redis or network: a pg double answers every statement with one
// fixed row (or none, or an error, per case). Rewrite the golden file only for
// an intended change:
//   TENANTS_SQL_GOLDEN_WRITE=1 npx tsx --test src/modules/tenants/tenants-sql.characterization.test.ts
// TENANTS_SQL_FULL_OUT=<file> also writes every outcome in full.

process.env.TZ = 'Asia/Ho_Chi_Minh';
process.env.REDIS_URL = 'redis://127.0.0.1:1';
process.env.GEMINI_CHAT_MODEL = 'chat-model-test';
process.env.GEMINI_LESSON_AUTHOR_MODEL = 'lesson-model-test';
// The Gemini key fingerprint is an HMAC with JWT_SECRET: the CI value, whatever .env says.
process.env.JWT_SECRET = 'ci-placeholder-not-a-secret';

const redis = await import('../../config/redis.js');
const { pool } = await import('../../config/database.js');
const ctrl = await import('./tenants.controller.js');
const tenants = await import('./tenants.service.js');
const components = await import('./tenant-course-components.service.js');
const smtp = await import('./tenant-smtp.service.js');
const groupLabels = await import('./tenant-group-labels.service.js');
const roleLabels = await import('./tenant-role-labels.service.js');

redis.installRedisClient(null);

const { after } = await import('node:test');
after(async () => {
  await pool.end();
});

const TENANT = '11111111-1111-4111-8111-111111111111';
const TENANT_2 = '22222222-2222-4222-8222-222222222222';
const USER = 'a0000000-0000-4000-8000-000000000001';
const TARGET_USER = 'a0000000-0000-4000-8000-000000000002';
const MODULE = 'c0000000-0000-4000-8000-000000000001';
const MODULE_2 = 'c0000000-0000-4000-8000-000000000002';

/** One row with every column a tenant statement reads. */
const ROW = {
  id: TENANT,
  name: 'Doanh nghiệp A',
  slug: 'doanh-nghiep-a',
  domain_learner: 'https://learn.a.test',
  domain_admin: 'https://admin.a.test',
  is_active: true,
  settings: {
    gemini_api_key: 'old-key',
    google_ai_studio_api_key: 'secret',
    theme: 'blue',
    course_authoring: { allowed_component_types: ['video', 'quiz', 'unknown'] },
  },
  max_users: 10,
  max_courses: 5,
  data_limit_bytes: '1000000000',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-02-01T00:00:00.000Z',
  database_used_bytes: '100',
  storage_used_bytes: '200',
  storage_reserved_bytes: '0',
  data_quota_state: 'enforced',
  state: 'enforced',
  last_verified_at: new Date('2026-10-01T00:00:00.000Z'),
  ai_active_engine: 'gemini_file_search',
  full_count: '3',
  ready: true,
  current_users: '2',
  current_courses: '1',
  quota: 3,
  current_count: '1',
  module_id: MODULE,
  code: 'courses',
  icon: 'book',
  sort_order: 1,
  tenant_id: TENANT,
  tenant_name: 'Doanh nghiệp A',
  username: 'learner01',
  full_name: 'Người Dùng',
  email: 'user@a.test',
  label_key: 'group',
  label: 'Công ty mẹ',
  role: 'staff',
  is_enabled: true,
  host: 'smtp.a.test',
  port: 465,
  secure: true,
  from_email: 'noreply@a.test',
  from_name: 'A',
  reply_to_email: null,
  copy_to_sender: true,
  copy_to_email: null,
  password_ciphertext: 'cipher',
  password_iv: 'iv',
  password_auth_tag: 'tag',
};

const ADMIN = { id: USER, tenantId: TENANT, role: 'superadmin', username: 'root', sessionMode: 'normal' };

const cases: Case[] = [];
const add = (name: string, run: () => Promise<unknown>, answer?: Answer) => cases.push({ name, run, answer });
const call = (handler: Handler, options: CallOptions = {}) =>
  callHandler(handler, { originalUrl: '/api/tenants', params: { id: TENANT }, ...options }, ADMIN);
const H = ctrl;
const SMTP_BODY = {
  is_enabled: true,
  host: 'smtp.a.test',
  port: 465,
  secure: true,
  username: 'mailer@a.test',
  from_email: 'noreply@a.test',
  from_name: 'Doanh nghiệp A',
  reply_to_email: 'reply@a.test',
  copy_to_sender: false,
};

// ── Tenants ──
add('list', () => call(H.listController));
add('list search', () => call(H.listController, { query: { search: 'nesso', page: '2', page_size: '5' } }));
add('list empty', () => call(H.listController), rowsWhen(/FROM tenants t/, []));
add('list ledger missing', () => call(H.listController), rowsWhen(/AS ready/, [{ ready: false }]));
add('list odd query', () => call(H.listController, { query: { search: ['a'], page: 'x', page_size: '-3' } }));
add('get', () => call(H.getByIdController));
add('get missing', () => call(H.getByIdController), noRowsWhen(/FROM tenants t/));
add('get no settings', () => call(H.getByIdController), rowsWhen(/FROM tenants t/, [{ ...ROW, settings: null }]));
add('create', () =>
  call(H.createController, {
    method: 'POST',
    body: {
      name: 'Doanh nghiệp B',
      slug: 'doanh-nghiep-b',
      domain_learner: ' https://learn.b.test/ ',
      domain_admin: null,
      max_users: 20,
      max_courses: null,
      data_limit_bytes: '5000000000',
      settings: { theme: 'red' },
    },
  }),
  noRowsWhen(/SELECT id FROM tenants WHERE slug/),
);
add(
  'create minimal',
  () => call(H.createController, { method: 'POST', body: { name: 'B', slug: 'b' } }),
  noRowsWhen(/SELECT id FROM tenants WHERE slug/),
);
add('create slug taken', () => call(H.createController, { method: 'POST', body: { name: 'B', slug: 'b' } }));
add(
  'create slug free',
  () => call(H.createController, { method: 'POST', body: { name: 'B', slug: 'b' } }),
  noRowsWhen(/SELECT id FROM tenants WHERE slug/),
);
add('create invalid', () => call(H.createController, { method: 'POST', body: { name: '', slug: 'B C' } }));
add('create bad domain', () =>
  call(H.createController, { method: 'POST', body: { name: 'B', slug: 'b', domain_admin: 'admin.b.test' } }),
);
add(
  'create insert fails',
  () => call(H.createController, { method: 'POST', body: { name: 'B', slug: 'b' } }),
  answers(noRowsWhen(/SELECT id FROM tenants WHERE slug/), failWhen(/INSERT INTO tenant_modules/, { code: '23505', message: 'duplicate' })),
);
add('update', () =>
  call(H.updateController, {
    method: 'PUT',
    body: { name: 'Tên mới', is_active: false, data_limit_bytes: '2000000000', domain_admin: 'https://admin2.a.test' },
  }),
);
add('update settings same key', () =>
  call(H.updateController, { method: 'PUT', body: { settings: { gemini_api_key: ' old-key ', theme: 'x' } } }),
);
add('update settings new key', () =>
  call(H.updateController, { method: 'PUT', body: { settings: { gemini_api_key: 'new-key' } } }),
);
add('update settings no key', () => call(H.updateController, { method: 'PUT', body: { settings: {} } }));
add(
  'update settings missing tenant',
  () => call(H.updateController, { method: 'PUT', body: { settings: {} } }),
  noRowsWhen(/SELECT settings FROM tenants/),
);
add('update every field', () =>
  call(H.updateController, {
    method: 'PUT',
    body: {
      name: 'N',
      slug: 'n',
      domain_learner: null,
      domain_admin: null,
      max_users: 1,
      max_courses: 2,
      data_limit_bytes: null,
      is_active: true,
      settings: { a: 1 },
    },
  }),
);
add('update nothing', () => call(H.updateController, { method: 'PUT', body: {} }));
add('update invalid', () => call(H.updateController, { method: 'PUT', body: { max_users: -1 } }));
add('update missing', () => call(H.updateController, { method: 'PUT', body: { name: 'x' } }), noRowsWhen(/FOR UPDATE/));
add('update vanished', () => call(H.updateController, { method: 'PUT', body: { name: 'x' } }), noRowsWhen(/^UPDATE tenants/));
add('update same values', () => call(H.updateController, { method: 'PUT', body: { name: 'Doanh nghiệp A' } }));
add(
  'update unlimited data',
  () => call(H.updateController, { method: 'PUT', body: { data_limit_bytes: null } }),
  rowsWhen(/^UPDATE tenants/, [{ ...ROW, data_limit_bytes: null }]),
);
add('update no domains', () => call(H.updateController, { method: 'PUT', body: { name: 'x' } }), noRowsWhen(/SELECT domain_admin, domain_learner/));
add('delete', () => call(H.deleteController, { method: 'DELETE' }));
add('delete missing', () => call(H.deleteController, { method: 'DELETE' }), noRowsWhen(/^DELETE FROM tenants/));

// ── Modules ──
add('modules', () => call(H.getModulesController));
add('modules update', () =>
  call(H.updateModulesController, {
    method: 'PUT',
    body: {
      modules: [
        { module_id: MODULE, is_enabled: true },
        { module_id: MODULE_2, is_enabled: false },
      ],
    },
  }),
);
add('modules update empty', () => call(H.updateModulesController, { method: 'PUT', body: { modules: [] } }));
add('modules update invalid', () => call(H.updateModulesController, { method: 'PUT', body: { modules: [{ module_id: 'x' }] } }));
add(
  'modules update missing tenant',
  () => call(H.updateModulesController, { method: 'PUT', body: { modules: [] } }),
  noRowsWhen(/FROM tenants t/),
);
add(
  'modules update unnamed tenant',
  () => call(H.updateModulesController, { method: 'PUT', body: { modules: [{ module_id: MODULE, is_enabled: true }] } }),
  rowsWhen(/FROM tenants t/, [{ ...ROW, name: '  ' }]),
);
add(
  'modules update fails',
  () => call(H.updateModulesController, { method: 'PUT', body: { modules: [{ module_id: MODULE, is_enabled: true }] } }),
  failWhen(/INSERT INTO tenant_modules/, { code: '23503', message: 'fk' }),
);

// ── Course component permissions ──
add('components', () => call(H.getCourseComponentPermissionsController));
add('components missing', () => call(H.getCourseComponentPermissionsController), noRowsWhen(/SELECT settings FROM tenants/));
add(
  'components no settings',
  () => call(H.getCourseComponentPermissionsController),
  rowsWhen(/SELECT settings FROM tenants/, [{ settings: { course_authoring: 'x' } }]),
);
add('components update', () =>
  call(H.updateCourseComponentPermissionsController, {
    method: 'PUT',
    body: { allowed_component_types: ['problem', 'video', 'problem'] },
  }),
);
add('components update invalid', () =>
  call(H.updateCourseComponentPermissionsController, { method: 'PUT', body: { allowed_component_types: ['nope'] } }),
);
add(
  'components update missing',
  () => call(H.updateCourseComponentPermissionsController, { method: 'PUT', body: { allowed_component_types: [] } }),
  noRowsWhen(/^UPDATE tenants/),
);
let deadlocks = 0;
add(
  'components update deadlock retried',
  () => {
    deadlocks = 0;
    return call(H.updateCourseComponentPermissionsController, { method: 'PUT', body: { allowed_component_types: ['video'] } });
  },
  text => (/^UPDATE tenants/.test(text) && deadlocks++ < 2 ? { error: { code: '40P01', message: 'deadlock' } } : undefined),
);
add(
  'components update deadlock gives up',
  () => call(H.updateCourseComponentPermissionsController, { method: 'PUT', body: { allowed_component_types: ['video'] } }),
  failWhen(/^UPDATE tenants/, { code: '40001', message: 'serialization' }),
);
add('component type set', async () => [...(await components.getTenantAllowedCourseComponentTypeSet(TENANT))]);
add('component type set missing', async () => [...(await components.getTenantAllowedCourseComponentTypeSet(TENANT))], noRowsWhen(/SELECT settings/));
add('component allowed', () => components.assertTenantCanAddCourseComponent(TENANT, 'video'));
add('component not allowed', () => components.assertTenantCanAddCourseComponent(TENANT, 'html'));
add('component not a component', () => components.assertTenantCanAddCourseComponent(TENANT, 'chapter'));

// ── Labels ──
add('role labels', () => call(H.getRoleLabelsController));
add(
  'role labels rows',
  () => call(H.getRoleLabelsController),
  rowsWhen(/FROM tenant_role_labels/, [
    { role: 'staff', label: 'Nhân viên' },
    { role: 'ghost', label: 'x' },
  ]),
);
add('role labels no table', () => call(H.getRoleLabelsController), failWhen(/FROM tenant_role_labels/, { code: '42P01', message: 'no table' }));
add('role labels other error', () => call(H.getRoleLabelsController), failWhen(/FROM tenant_role_labels/, { code: '57014', message: 'canceled' }));
add('role labels update', () =>
  call(H.updateRoleLabelsController, { method: 'PUT', body: { labels: { staff: ' Nhân viên ', learner: '', superadmin: null } } }),
);
add('role labels update alias', () => call(H.updateRoleLabelsController, { method: 'PUT', body: { role_labels: { learner: 'Học viên' } } }));
add('role labels update empty', () => call(H.updateRoleLabelsController, { method: 'PUT', body: undefined }));
add('role labels update bad key', () => call(H.updateRoleLabelsController, { method: 'PUT', body: { labels: { admin: 'x' } } }));
add('role labels update not object', () => call(H.updateRoleLabelsController, { method: 'PUT', body: { labels: ['x'] } }));
add('role labels update not text', () => call(H.updateRoleLabelsController, { method: 'PUT', body: { labels: { staff: 1 } } }));
add('role labels update too long', () => call(H.updateRoleLabelsController, { method: 'PUT', body: { labels: { staff: 'x'.repeat(65) } } }));
add(
  'role labels update missing',
  () => call(H.updateRoleLabelsController, { method: 'PUT', body: { labels: { staff: 'x' } } }),
  noRowsWhen(/SELECT id FROM tenants WHERE id/),
);
add(
  'role labels update no table',
  () => call(H.updateRoleLabelsController, { method: 'PUT', body: { labels: { staff: 'x' } } }),
  failWhen(/DELETE FROM tenant_role_labels/, { code: '42P01', message: 'no table' }),
);
add('group labels', () => call(H.getGroupLabelsController));
add(
  'group labels rows',
  () => call(H.getGroupLabelsController),
  rowsWhen(/FROM tenant_group_labels/, [
    { label_key: 'team', label: 'Tổ' },
    { label_key: 'ghost', label: 'x' },
  ]),
);
add('group labels no table', () => call(H.getGroupLabelsController), failWhen(/FROM tenant_group_labels/, { code: '42P01', message: 'no table' }));
add('group labels update', () =>
  call(H.updateGroupLabelsController, { method: 'PUT', body: { labels: { group: ' Tập đoàn ', team: '' } } }),
);
add('group labels update alias', () => call(H.updateGroupLabelsController, { method: 'PUT', body: { group_labels: { subgroup: 'Khối' } } }));
add('group labels update bad key', () => call(H.updateGroupLabelsController, { method: 'PUT', body: { labels: { division: 'x' } } }));
add('group labels update not text', () => call(H.updateGroupLabelsController, { method: 'PUT', body: { labels: { team: true } } }));
add('group labels update too long', () => call(H.updateGroupLabelsController, { method: 'PUT', body: { labels: { team: 'x'.repeat(65) } } }));
add(
  'group labels update missing',
  () => call(H.updateGroupLabelsController, { method: 'PUT', body: { labels: { team: 'x' } } }),
  noRowsWhen(/SELECT id FROM tenants WHERE id/),
);
add(
  'group labels update no table',
  () => call(H.updateGroupLabelsController, { method: 'PUT', body: { labels: { team: 'x' } } }),
  failWhen(/INSERT INTO tenant_group_labels/, { code: '42P01', message: 'no table' }),
);
add('group labels no tenant', () => groupLabels.getTenantGroupLabels(null));
add('role labels no tenant', () => roleLabels.getTenantRoleLabels(undefined));

// ── Lists, quota, user tenants ──
add('simple superadmin', () => call(H.listSimpleController));
add('simple superuser', () => call(H.listSimpleController, { user: { role: 'superuser' } }));
add('quota', () => call(H.getQuotaController));
add('quota missing', () => call(H.getQuotaController), noRowsWhen(/AS current_users/));
add('quota no data quota', () => call(H.getQuotaController), noRowsWhen(/LEFT JOIN tenant_data_quota_usage usage/));
add('current data quota', () => call(H.getCurrentDataQuotaController));
add('current data quota missing', () => call(H.getCurrentDataQuotaController), noRowsWhen(/FROM tenants t/));
add('current data quota no tenant', () => call(H.getCurrentDataQuotaController, { user: { tenantId: null } }));
add('user tenants', () => call(H.getUserTenantsController, { params: { userId: TARGET_USER } }));
add('user tenants set', () =>
  call(H.setUserTenantsController, { method: 'PUT', params: { userId: TARGET_USER }, body: { tenant_ids: [TENANT, TENANT_2] } }),
);
add('user tenants set empty', () =>
  call(H.setUserTenantsController, { method: 'PUT', params: { userId: TARGET_USER }, body: { tenant_ids: [] } }),
);
add('user tenants set not a list', () =>
  call(H.setUserTenantsController, { method: 'PUT', params: { userId: TARGET_USER }, body: { tenant_ids: TENANT } }),
);
add(
  'user tenants set missing user',
  () => call(H.setUserTenantsController, { method: 'PUT', params: { userId: TARGET_USER }, body: { tenant_ids: [TENANT] } }),
  noRowsWhen(/SELECT username FROM users/),
);
add('check quota', () => tenants.checkQuota(TENANT, 'users'));
add('check quota courses', () => tenants.checkQuota(TENANT, 'courses'));
add('check quota reached', () => tenants.checkQuota(TENANT, 'users'), rowsWhen(/AS quota/, [{ quota: 1, current_count: '1' }]));
add('check quota unlimited', () => tenants.checkQuota(TENANT, 'courses'), rowsWhen(/AS quota/, [{ quota: null, current_count: '99' }]));
add('check quota missing', () => tenants.checkQuota(TENANT, 'users'), noRowsWhen(/AS quota/));
add('check quota in transaction', async () => {
  const client = await pool.connect();
  try {
    await tenants.checkQuota(TENANT, 'courses', client);
    return 'ok';
  } finally {
    client.release();
  }
});

// ── SMTP ──
add('smtp', () => call(H.getSmtpController));
add('smtp none', () => call(H.getSmtpController), noRowsWhen(/FROM tenant_smtp_configs/));
add('smtp short username', () => call(H.getSmtpController), rowsWhen(/FROM tenant_smtp_configs/, [{ ...ROW, username: 'nodomain', from_name: null }]));
add('smtp update', () => call(H.updateSmtpController, { method: 'PUT', body: SMTP_BODY }));
add('smtp update defaults', () =>
  call(H.updateSmtpController, { method: 'PUT', body: { is_enabled: false, username: 'm@a.test', from_email: 'n@a.test' } }),
);
add('smtp update invalid', () => call(H.updateSmtpController, { method: 'PUT', body: { is_enabled: true, username: 'x' } }));
add(
  'smtp update no password',
  () => call(H.updateSmtpController, { method: 'PUT', body: SMTP_BODY }),
  rowsWhen(/SELECT password_ciphertext/, [{ password_ciphertext: null }]),
);
add('smtp update missing tenant', () => call(H.updateSmtpController, { method: 'PUT', body: SMTP_BODY }), noRowsWhen(/FROM tenants t/));
add(
  'smtp update tenant gone',
  () => call(H.updateSmtpController, { method: 'PUT', body: SMTP_BODY }),
  noRowsWhen(/SELECT id FROM tenants WHERE id/),
);
add('smtp update nothing returned', () => call(H.updateSmtpController, { method: 'PUT', body: SMTP_BODY }), noRowsWhen(/INSERT INTO tenant_smtp_configs/));
add('smtp for send', () => smtp.getTenantSmtpConfigForSend(TENANT));
add('smtp for send none', () => smtp.getTenantSmtpConfigForSend(TENANT), noRowsWhen(/FROM tenant_smtp_configs/));

registerCharacterization({
  title: 'tenants characterization',
  goldenPath: path.join(path.dirname(fileURLToPath(import.meta.url)), 'tenants-sql.characterization.golden.json'),
  writeEnv: 'TENANTS_SQL_GOLDEN_WRITE',
  fullOutEnv: 'TENANTS_SQL_FULL_OUT',
  pool,
  defaultRow: ROW,
  cases,
  fixedIds: [TENANT, TENANT_2, USER, TARGET_USER, MODULE, MODULE_2],
  now: Date.parse('2026-10-18T03:04:05.000Z'),
});
