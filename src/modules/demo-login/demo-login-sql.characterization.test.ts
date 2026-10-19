import path from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  call,
  describeRouter,
  rowsWhen,
  runCharacterization,
  settle,
  type Answer,
  type Case,
} from '../../test-support/sql-characterization.js';

// Characterization of the demo QR login and the demo iframe: the admin routes
// (config, eligible learners, account list replace/delete, iframe settings,
// embed id regeneration) with their audit rows and session revocations, the
// public account list and claim (one-time token), the iframe bootstrap down
// to the demo_iframe session, and the demo iframe helpers other modules call.
// Each case records its SQL and answer (see
// test-support/sql-characterization.ts).
//
// The golden file was written by the code before the demo-login repositories
// existed. Rewrite it only for an intended change:
//   DEMO_LOGIN_SQL_GOLDEN_WRITE=1 npx tsx --test src/modules/demo-login/demo-login-sql.characterization.test.ts
// DEMO_LOGIN_SQL_FULL_OUT=<file> also writes every outcome in full.

process.env.TZ = 'Asia/Ho_Chi_Minh';
process.env.REDIS_URL = 'redis://127.0.0.1:1';

const redis = await import('../../config/redis.js');
const { pool } = await import('../../config/database.js');
const { verifyAccessToken } = await import('../../utils/jwt.js');
const ctrl = await import('./demo-login.controller.js');
const demoLogin = await import('./demo-login.service.js');
const demoIframe = await import('./demo-iframe.service.js');
const { authenticate } = await import('../../middleware/authenticate.js');
const { default: demoRouter } = await import('./demo-login.routes.js');

redis.installRedisClient(null);

const TENANT = '11111111-1111-4111-8111-111111111111';
const ADMIN = 'a0000000-0000-4000-8000-000000000005';
const LEARNER_1 = 'a0000000-0000-4000-8000-000000000011';
const LEARNER_2 = 'a0000000-0000-4000-8000-000000000012';
const DEMO_LEARNER = 'a0000000-0000-4000-8000-000000000004';
const OLD_DEMO_LEARNER = 'a0000000-0000-4000-8000-000000000013';
const PUBLIC_ID = 'b1000000-0000-4000-8000-000000000001';
const EMBED = 'b2000000-0000-4000-8000-000000000001';
const FIXED_IDS = new Set([TENANT, ADMIN, LEARNER_1, LEARNER_2, DEMO_LEARNER, OLD_DEMO_LEARNER, PUBLIC_ID, EMBED]);

const TENANT_ROW = { id: TENANT, name: 'Công ty A', domain_learner: 'https://learn.a.example.test', is_active: true };
const SETTINGS_ROW = {
  tenant_id: TENANT,
  is_enabled: true,
  max_demo_accounts: 3,
  reservation_ttl_seconds: 300,
  updated_by: ADMIN,
  created_at: new Date('2026-01-01T00:00:00.000Z'),
  updated_at: '2026-02-01T00:00:00.000Z',
};
const ACCOUNT_ROW = {
  public_id: PUBLIC_ID,
  user_id: LEARNER_1,
  label: null,
  sort_order: 0,
  reserved_until: null,
  username: 'demo01',
  email: 'demo01@example.test',
  full_name: '  ',
  avatar_url: null,
  is_active: true,
  role: 'learner',
  created_at: '2026-03-01T00:00:00.000Z',
  updated_at: '2026-03-02T00:00:00.000Z',
};
const IFRAME_ROW = {
  tenant_id: TENANT,
  is_enabled: true,
  allowed_origin: 'https://partner.example.test',
  demo_user_id: DEMO_LEARNER,
  public_embed_id: EMBED,
  updated_by: ADMIN,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-02-01T00:00:00.000Z',
  tenant_name: 'Công ty A',
  tenant_domain_learner: 'learn.a.example.test:5273',
  tenant_is_active: true,
  learner_username: 'demo-iframe',
  learner_email: 'iframe@example.test',
  learner_full_name: 'Học viên demo',
  learner_avatar_url: null,
  learner_is_active: true,
  learner_role: 'learner',
};
const BOOTSTRAP_ROW = {
  tenant_id: TENANT,
  tenant_name: 'Công ty A',
  tenant_domain_learner: 'learn.a.example.test:5273',
  allowed_origin: 'https://partner.example.test',
  demo_user_id: DEMO_LEARNER,
  username: 'demo-iframe',
  full_name: null,
};
const SESSION_USER = {
  id: DEMO_LEARNER,
  username: 'demo-iframe',
  email: 'iframe@example.test',
  full_name: 'Học viên demo',
  phone: '',
  avatar_url: null,
  role: 'learner',
  is_active: true,
  tenant_id: TENANT,
  tenant_name: 'Công ty A',
  tenant_active: true,
};

/** The rows each statement family answers unless a case says otherwise. */
function fallback(text: string): unknown[] {
  const flat = text.replace(/\s+/g, ' ');
  if (/^SELECT EXISTS/.test(flat.trim())) return [{ exists: false }];
  if (/FROM tenant_demo_iframe_settings s JOIN tenants t ON t.id = s.tenant_id JOIN users u/.test(flat)) return [BOOTSTRAP_ROW];
  if (/FROM tenant_demo_iframe_settings s/.test(flat)) return [IFRAME_ROW];
  if (/SELECT demo_user_id FROM tenant_demo_iframe_settings/.test(flat)) return [{ demo_user_id: LEARNER_1 }];
  if (/FROM tenants/.test(flat)) return [TENANT_ROW];
  if (/FROM tenant_demo_login_settings/.test(flat)) return [SETTINGS_ROW];
  if (/COUNT\(\*\)::text AS locked_count/.test(flat)) {
    return [{ locked_count: '1', next_reset_at: new Date('2026-10-18T03:08:05.000Z'), next_reset_in_seconds: 240 }];
  }
  if (/COUNT\(\*\)/.test(flat)) return [{ count: '2' }];
  if (/WITH target AS/.test(flat)) {
    return [{ user_id: LEARNER_1, reserved_until: new Date('2026-10-18T03:09:05.000Z'), reservation_ttl_seconds: 300 }];
  }
  if (/RETURNING u.username/.test(flat)) return [{ username: 'demo01' }];
  if (/FROM tenant_demo_login_accounts a JOIN users u/.test(flat)) return [ACCOUNT_ROW, { ...ACCOUNT_ROW, label: 'Bàn 2', sort_order: 1 }];
  if (/SELECT tenant_id FROM tenant_demo_login_accounts/.test(flat)) return [{ tenant_id: TENANT }];
  if (/AND id = ANY\(\$2::uuid\[\]\)/.test(flat)) return [{ id: LEARNER_1 }, { id: LEARNER_2 }];
  if (/FROM users u .*ORDER BY u.created_at DESC/.test(flat)) {
    return [
      {
        id: LEARNER_1,
        username: 'demo01',
        email: 'demo01@example.test',
        full_name: 'Học viên 1',
        avatar_url: null,
        created_at: new Date('2026-03-01T00:00:00.000Z'),
        is_demo_iframe_active: false,
      },
    ];
  }
  if (/FROM tenant_modules/.test(flat)) return [{ code: 'courses' }];
  if (/bool_or\(/.test(flat)) return [];
  if (/FROM team_members/.test(flat)) return [];
  if (/tenant_role_labels|tenant_group_labels/.test(flat)) return [];
  if (/^\s*(INSERT|UPDATE|DELETE)/.test(text) && !/RETURNING/.test(text)) return [];
  if (/FROM users u LEFT JOIN tenants t/.test(flat)) return [SESSION_USER];
  return [{ id: DEMO_LEARNER }];
}

const pgError = (code: string) => Object.assign(new Error(`pg ${code}`), { code });
const admin = { id: ADMIN, tenantId: null, role: 'superadmin', username: 'root', sessionMode: 'normal' };
const tenantParams = { tenantId: TENANT };

const cases: Case[] = [];
const add = (name: string, run: (t: TestContext) => Promise<unknown>, answer?: Answer) => cases.push({ name, run, answer });

// ── Route table ──
const NAMES = new Map<unknown, string>([
  [authenticate, 'authenticate'],
  ...Object.entries(ctrl).map(([name, fn]) => [fn, name] as [unknown, string]),
]);
add('routes: /api/demo-login', async () => describeRouter(demoRouter, NAMES));

// ── Demo QR login: admin ──
const adminCall = (handler: Parameters<typeof call>[0], options: Parameters<typeof call>[1] = {}) =>
  call(handler, { user: admin, params: tenantParams, ...options });
add('admin config', () => adminCall(ctrl.getAdminConfigController));
add('admin config invalid tenant id', () => adminCall(ctrl.getAdminConfigController, { params: { tenantId: 'x' } }));
add('admin config unknown tenant', () => adminCall(ctrl.getAdminConfigController), rowsWhen([/FROM tenants/, []]));
add('update config', () =>
  adminCall(ctrl.updateAdminConfigController, { body: { is_enabled: true, max_demo_accounts: 5, reservation_ttl_seconds: 600 } }),
);
add('update config only the actor', () => adminCall(ctrl.updateAdminConfigController, { body: {} }));
add(
  'update config limit below the accounts',
  () => adminCall(ctrl.updateAdminConfigController, { body: { max_demo_accounts: 1 } }),
);
add('update config invalid ttl', () => adminCall(ctrl.updateAdminConfigController, { body: { reservation_ttl_seconds: 10 } }));
add('eligible learners', () =>
  adminCall(ctrl.searchEligibleLearnersController, { query: { search: 'an', page: '2', pageSize: '5' } }),
);
add('eligible learners without search', () => adminCall(ctrl.searchEligibleLearnersController));
add('replace accounts', () =>
  adminCall(ctrl.replaceAccountsController, {
    body: { accounts: [{ user_id: LEARNER_1, label: ' Bàn 1 ' }, { user_id: LEARNER_2, label: '   ' }] },
  }),
);
add('replace accounts with none', () => adminCall(ctrl.replaceAccountsController, { body: { accounts: [] } }));
add('replace accounts duplicate', () =>
  adminCall(ctrl.replaceAccountsController, { body: { accounts: [{ user_id: LEARNER_1 }, { user_id: LEARNER_1 }] } }),
);
add(
  'replace accounts over the limit',
  () => adminCall(ctrl.replaceAccountsController, { body: { accounts: [{ user_id: LEARNER_1 }, { user_id: LEARNER_2 }] } }),
  rowsWhen([/FROM tenant_demo_login_settings/, [{ ...SETTINGS_ROW, max_demo_accounts: 1 }]]),
);
add(
  'replace accounts not eligible',
  () => adminCall(ctrl.replaceAccountsController, { body: { accounts: [{ user_id: LEARNER_1 }, { user_id: LEARNER_2 }] } }),
  rowsWhen([/AND id = ANY/, [{ id: LEARNER_1 }]]),
);
add(
  'replace accounts insert fails',
  () => adminCall(ctrl.replaceAccountsController, { body: { accounts: [{ user_id: LEARNER_1 }, { user_id: LEARNER_2 }] } }),
  rowsWhen([/INSERT INTO tenant_demo_login_accounts/, new Error('db down')]),
);
add('replace accounts invalid body', () => adminCall(ctrl.replaceAccountsController, { body: { accounts: [{ user_id: 'x' }] } }));
add('delete account', () => adminCall(ctrl.deleteAccountController, { params: { tenantId: TENANT, publicId: PUBLIC_ID } }));
add(
  'delete account unknown',
  () => adminCall(ctrl.deleteAccountController, { params: { tenantId: TENANT, publicId: PUBLIC_ID } }),
  rowsWhen([/RETURNING u.username/, []]),
);
add('delete account invalid params', () => adminCall(ctrl.deleteAccountController, { params: { tenantId: TENANT, publicId: 'x' } }));

// ── Demo QR login: public ──
const publicCall = (handler: Parameters<typeof call>[0], domain: string, body?: unknown) =>
  call(handler, { params: { domain }, body: body ?? {} });
add('public accounts', () => publicCall(ctrl.listPublicAccountsController, ' Learn.A.example.test '));
add(
  'public accounts disabled',
  () => publicCall(ctrl.listPublicAccountsController, 'learn.a.example.test'),
  rowsWhen([/FROM tenant_demo_login_settings/, [{ ...SETTINGS_ROW, is_enabled: false, reservation_ttl_seconds: 900 }]]),
);
add(
  'public accounts without settings',
  () => publicCall(ctrl.listPublicAccountsController, 'learn.a.example.test'),
  rowsWhen([/FROM tenant_demo_login_settings/, []]),
);
add(
  'public accounts none locked',
  () => publicCall(ctrl.listPublicAccountsController, 'learn.a.example.test'),
  rowsWhen([/locked_count/, [{ locked_count: '0', next_reset_at: null, next_reset_in_seconds: null }]]),
);
add(
  'public accounts unknown domain',
  () => publicCall(ctrl.listPublicAccountsController, 'nowhere.example.test'),
  rowsWhen([/FROM tenants/, []]),
);
add('public accounts blank domain', () => publicCall(ctrl.listPublicAccountsController, '  '));
add('public accounts domain that normalizes to nothing', () => publicCall(ctrl.listPublicAccountsController, 'https:///x'));
add('claim account', () => publicCall(ctrl.claimPublicAccountController, 'learn.a.example.test', { account_id: PUBLIC_ID }));
add(
  'claim account unavailable',
  () => publicCall(ctrl.claimPublicAccountController, 'learn.a.example.test', { account_id: PUBLIC_ID }),
  rowsWhen([/WITH target AS/, []]),
);
add(
  'claim account on localhost',
  () => publicCall(ctrl.claimPublicAccountController, 'localhost:5273', { account_id: PUBLIC_ID }),
  rowsWhen([/FROM tenants/, [{ ...TENANT_ROW, domain_learner: null }]]),
);
add(
  'claim account learner domain without protocol',
  () => publicCall(ctrl.claimPublicAccountController, 'learn.a.example.test', { account_id: PUBLIC_ID }),
  rowsWhen([/FROM tenants/, [{ ...TENANT_ROW, domain_learner: 'learn.a.example.test/path?x=1' }]]),
);
add('claim account invalid id', () => publicCall(ctrl.claimPublicAccountController, 'learn.a.example.test', { account_id: 'x' }));
add('remove user from demo login', () => settle(() => demoLogin.removeUserFromDemoLogin(LEARNER_1)));
add(
  'remove user from demo login without account',
  () => settle(() => demoLogin.removeUserFromDemoLogin(LEARNER_1)),
  rowsWhen([/SELECT tenant_id FROM tenant_demo_login_accounts/, []]),
);
add(
  'remove user from demo login table missing',
  () => settle(() => demoLogin.removeUserFromDemoLogin(LEARNER_1)),
  rowsWhen([/SELECT tenant_id FROM tenant_demo_login_accounts/, pgError('42P01')]),
);
add(
  'remove user from demo login fails',
  () => settle(() => demoLogin.removeUserFromDemoLogin(LEARNER_1)),
  rowsWhen([/DELETE FROM tenant_demo_login_accounts/, pgError('57014')]),
);

// ── Demo iframe: admin ──
const iframeUpdate = (body: unknown) => adminCall(ctrl.updateAdminIframeConfigController, { body });
const currentIframe = (row: Record<string, unknown>) => rowsWhen([/FROM tenant_demo_iframe_settings s/, [{ ...IFRAME_ROW, ...row }]]);
add('iframe config', () => adminCall(ctrl.getAdminIframeConfigController));
add(
  'iframe config without learner',
  () => adminCall(ctrl.getAdminIframeConfigController),
  currentIframe({ demo_user_id: null, allowed_origin: null, is_enabled: false, tenant_domain_learner: 'http://localhost:5273' }),
);
add('iframe config unknown tenant', () => adminCall(ctrl.getAdminIframeConfigController), rowsWhen([/FROM tenants/, []]));
add(
  'iframe config missing settings row',
  () => adminCall(ctrl.getAdminIframeConfigController),
  rowsWhen([/FROM tenant_demo_iframe_settings s/, []]),
);
add('iframe enable', () =>
  iframeUpdate({ is_enabled: true, allowed_origin: ' https://Partner.example.test/ ', demo_user_id: DEMO_LEARNER }),
);
add('iframe switch learner', () => iframeUpdate({ demo_user_id: LEARNER_1 }), currentIframe({ demo_user_id: OLD_DEMO_LEARNER }));
add('iframe disable', () => iframeUpdate({ is_enabled: false }));
add(
  'iframe enable without origin',
  () => iframeUpdate({ is_enabled: true }),
  currentIframe({ is_enabled: false, allowed_origin: null }),
);
add('iframe origin with wildcard', () => iframeUpdate({ allowed_origin: 'https://*.example.test' }));
add('iframe origin with path', () => iframeUpdate({ allowed_origin: 'https://partner.example.test/app' }));
add('iframe origin with credentials', () => iframeUpdate({ allowed_origin: 'https://u:p@partner.example.test' }));
add('iframe origin not a url', () => iframeUpdate({ allowed_origin: 'https://exa mple' }));
add('iframe origin cleared while disabled', () => iframeUpdate({ is_enabled: false, allowed_origin: '', demo_user_id: null }));
add(
  'iframe learner not eligible',
  () => iframeUpdate({ demo_user_id: LEARNER_2 }),
  rowsWhen([/WHERE id = \$1\s+AND tenant_id = \$2/, []]),
);
add('iframe regenerate embed id', () => adminCall(ctrl.regenerateAdminIframeEmbedController));
add(
  'iframe regenerate embed id without learner',
  () => adminCall(ctrl.regenerateAdminIframeEmbedController),
  currentIframe({ demo_user_id: null }),
);
add('iframe eligible learners', () =>
  adminCall(ctrl.searchEligibleIframeLearnersController, { query: { search: 'demo', page: '1', pageSize: '20' } }),
);

// ── Demo iframe: public bootstrap ──
const bootstrap = (parentOrigin: unknown, origin?: string, embedId = EMBED) =>
  call(ctrl.bootstrapPublicIframeController, {
    params: { embedId },
    body: parentOrigin === undefined ? {} : { parent_origin: parentOrigin },
    headers: origin ? { origin } : {},
  });
const bootstrapRow = (row: Record<string, unknown>) =>
  rowsWhen([/FROM tenant_demo_iframe_settings s\s+JOIN tenants t ON t.id = s.tenant_id\s+JOIN users u/, [{ ...BOOTSTRAP_ROW, ...row }]]);
add('iframe bootstrap', () => bootstrap('https://partner.example.test', 'https://learn.a.example.test'));
add('iframe bootstrap request origin of another site', () =>
  bootstrap('https://partner.example.test', 'https://evil.example.test'),
);
add('iframe bootstrap parent origin not allowed', () => bootstrap('https://other.example.test', 'https://learn.a.example.test'));
add('iframe bootstrap without request origin', () => bootstrap('https://partner.example.test'));
add('iframe bootstrap without parent origin', () => bootstrap(undefined, 'https://learn.a.example.test'));
add('iframe bootstrap parent origin with wildcard', () => bootstrap('https://*.example.test', 'https://learn.a.example.test'));
add(
  'iframe bootstrap unknown embed',
  () => bootstrap('https://partner.example.test', 'https://learn.a.example.test'),
  rowsWhen([/FROM tenant_demo_iframe_settings s/, []]),
);
add(
  'iframe bootstrap tenant without learner domain',
  () => bootstrap('https://partner.example.test', 'https://learn.a.example.test'),
  bootstrapRow({ tenant_domain_learner: null }),
);
add(
  'iframe bootstrap localhost learner site',
  () => bootstrap('https://partner.example.test', 'http://localhost:5273'),
  bootstrapRow({ tenant_domain_learner: 'http://localhost:5273', full_name: 'Học viên demo' }),
);
add('iframe bootstrap invalid embed id', () => bootstrap('https://partner.example.test', 'https://learn.a.example.test', 'x'));
add(
  'iframe bootstrap learner disabled meanwhile',
  () => bootstrap('https://partner.example.test', 'https://learn.a.example.test'),
  rowsWhen([/FROM users u\s+LEFT JOIN tenants t/, [{ ...SESSION_USER, is_active: false }]]),
);

// ── Demo iframe helpers other modules call ──
add('demo iframe helpers', async () => ({
  active: await settle(() => demoIframe.isActiveDemoIframeAccount(DEMO_LEARNER)),
  ids: await settle(() => demoIframe.getActiveDemoIframeUserIds([LEARNER_1, LEARNER_1, '', LEARNER_2])),
  noIds: await settle(() => demoIframe.getActiveDemoIframeUserIds([])),
  assertDefault: await settle(() => demoIframe.assertUserNotActiveDemoIframeAccount(LEARNER_1)),
  revoke: await settle(() => demoIframe.revokeNormalSessionsForDemoIframeAccount(OLD_DEMO_LEARNER)),
  session: [demoIframe.isDemoIframeSession({ sessionMode: 'demo_iframe' }), demoIframe.isDemoIframeSession({}), demoIframe.normalizeSessionMode('x')],
}));
add(
  'demo iframe helpers on an active account',
  async () => ({
    active: await settle(() => demoIframe.isActiveDemoIframeAccount(DEMO_LEARNER)),
    assertDefault: await settle(() => demoIframe.assertUserNotActiveDemoIframeAccount(DEMO_LEARNER)),
    assertCustom: await settle(() => demoIframe.assertUserNotActiveDemoIframeAccount(DEMO_LEARNER, 'Không thể sửa')),
  }),
  rowsWhen([/SELECT EXISTS/, [{ exists: true }]]),
);
for (const code of ['42P01', '42703', '57014']) {
  add(
    `demo iframe helpers when the read fails with ${code}`,
    async () => ({
      active: await settle(() => demoIframe.isActiveDemoIframeAccount(DEMO_LEARNER)),
      ids: await settle(() => demoIframe.getActiveDemoIframeUserIds([LEARNER_1])),
    }),
    rowsWhen([/tenant_demo_iframe_settings/, pgError(code)]),
  );
}

runCharacterization(cases, {
  label: 'demo-login characterization',
  goldenPath: path.join(path.dirname(fileURLToPath(import.meta.url)), 'demo-login-sql.characterization.golden.json'),
  envPrefix: 'DEMO_LOGIN_SQL',
  pool,
  fallback,
  fixedIds: FIXED_IDS,
  verifyJwt: token => {
    try {
      verifyAccessToken(token);
      return true;
    } catch {
      return false;
    }
  },
  records: () => ({}),
  reset: () => undefined,
});
