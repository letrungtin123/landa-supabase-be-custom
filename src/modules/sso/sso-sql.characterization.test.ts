import path from 'node:path';
import { mock, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  call,
  describeRouter,
  rowsWhen,
  runCharacterization,
  type Answer,
  type Case,
} from '../../test-support/auth-sql-characterization.js';

// Characterization of SSO: the admin config routes (list, update, delete with
// their audit rows), the public provider list by domain, and the code
// exchange with every account-policy path (linked identity, linking an
// existing account by email, a new learner, the refusals, provider failures
// and timeout, admin-site checks) down to the session it issues. Each case
// records its SQL, outbound provider requests and answer (see
// test-support/auth-sql-characterization.ts).
//
// The golden file was written by the code before the SSO repository existed.
// Rewrite it only for an intended change:
//   SSO_SQL_GOLDEN_WRITE=1 npx tsx --test src/modules/sso/sso-sql.characterization.test.ts
// SSO_SQL_FULL_OUT=<file> also writes every outcome in full.

process.env.TZ = 'Asia/Ho_Chi_Minh';
process.env.REDIS_URL = 'redis://127.0.0.1:1';
process.env.SSO_CONFIG_ENCRYPTION_KEY ||= 'sso-characterization-test-only-key';

const bcrypt = (await import('bcrypt')).default;
const redis = await import('../../config/redis.js');
const { pool } = await import('../../config/database.js');
const { verifyAccessToken } = await import('../../utils/jwt.js');
const { encryptSecret, decryptSecret } = await import('./sso.crypto.js');
const ctrl = await import('./sso.controller.js');
const { authenticate } = await import('../../middleware/authenticate.js');
const { tenantContext } = await import('../../middleware/tenant-context.js');
const { ssoExchangeIpLimiter } = await import('../../middleware/auth-rate-limit.js');
const { default: ssoRouter } = await import('./sso.routes.js');

redis.installRedisClient(null);

const TENANT = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const USER = 'a0000000-0000-4000-8000-000000000001';
const NEW_USER = 'a0000000-0000-4000-8000-000000000006';
const OTHER_USER = 'a0000000-0000-4000-8000-000000000005';
const CONFIG = 'f1000000-0000-4000-8000-000000000001';
const FIXED_IDS = new Set([TENANT, TENANT_B, USER, NEW_USER, OTHER_USER, CONFIG]);

// The random password of a new SSO learner is hashed; the hash keeps only its length.
mock.method(bcrypt, 'hash', (async (plaintext: string, rounds: number) => `bcrypt-cost-${rounds}:<${plaintext.length} chars>`) as never);

// ── Provider double ──
interface ProviderAnswer {
  status: number;
  body: unknown;
}
let provider: { token: ProviderAnswer; userinfo: ProviderAnswer; hang?: boolean } = defaultProvider();
const providerRequests: unknown[] = [];
let fetchCalls = 0;

function defaultProvider() {
  return {
    token: { status: 200, body: { access_token: 'provider-access-token' } },
    userinfo: { status: 200, body: { sub: 'google-sub-1', email: 'Learner@Example.TEST', email_verified: true, name: 'Học viên SSO' } },
  };
}

globalThis.fetch = (async (input: string | URL | globalThis.Request, init?: RequestInit) => {
  fetchCalls += 1;
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  providerRequests.push({
    method: init?.method ?? 'GET',
    url,
    headers: init?.headers ?? null,
    body: init?.body === undefined ? null : String(init.body),
  });
  if (provider.hang) {
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
  }
  const answer = /token/.test(url) && !/userinfo/.test(url) ? provider.token : provider.userinfo;
  return new globalThis.Response(JSON.stringify(answer.body), {
    status: answer.status,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;

const CONFIG_ROW = {
  id: CONFIG,
  tenant_id: TENANT,
  provider: 'google',
  is_enabled: true,
  client_id: 'client-123',
  client_secret_enc: encryptSecret('sso-client-secret'),
  issuer_url: null,
  authorization_url: null,
  token_url: null,
  userinfo_url: null,
  scopes: null,
  extra_config: { auto_register_enabled: true },
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-02-01T00:00:00.000Z',
};

const SESSION_USER = {
  id: USER,
  username: 'learner01',
  email: 'learner@example.test',
  full_name: 'Học viên A',
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
  if (/tenant_demo_iframe_settings/.test(text)) return [];
  if (/FROM tenant_sso_configs/.test(text) || /INSERT INTO tenant_sso_configs/.test(text)) return [CONFIG_ROW];
  if (/FROM sso_user_identities i/.test(text)) return [{ user_id: USER, role: 'learner', is_active: true, tenant_id: TENANT }];
  if (/FROM sso_user_identities/.test(text)) return [];
  if (/SELECT domain_admin, domain_learner FROM tenants/.test(text)) {
    return [{ domain_admin: 'https://admin.a.example.test', domain_learner: 'learn.a.example.test:5273' }];
  }
  if (/FROM tenants WHERE \( lower/.test(text.replace(/\s+/g, ' '))) return [{ id: TENANT, name: 'Công ty A' }];
  if (/lower\(btrim\(email\)\) = \$1/.test(text)) return [{ id: USER, tenant_id: TENANT, role: 'learner', is_active: true }];
  if (/SELECT id FROM users WHERE username/.test(text)) return [];
  if (/max_users AS quota/.test(text)) return [{ quota: 100, current_count: '10' }];
  if (/INSERT INTO users/.test(text)) return [{ id: NEW_USER }];
  if (/FROM tenant_modules/.test(text)) return [{ code: 'courses' }];
  if (/bool_or\(/.test(text)) return [{ code: 'courses', can_view: true, can_add: false, can_edit: false, can_delete: false }];
  if (/FROM modules/.test(text)) return [{ code: 'courses' }, { code: 'reports' }];
  if (/FROM tenants WHERE is_active = true ORDER BY name/.test(text)) return [{ id: TENANT, name: 'Công ty A' }];
  if (/SELECT id, name FROM tenants WHERE id = \$1/.test(text)) return [{ id: TENANT, name: 'Công ty A' }];
  if (/FROM team_members/.test(text)) return [];
  if (/COUNT\(\*\)/.test(text)) return [{ count: '1' }];
  if (/tenant_role_labels|tenant_group_labels/.test(text)) return [];
  if (/^\s*(INSERT|UPDATE|DELETE)/.test(text) && !/RETURNING/.test(text)) return [];
  return [SESSION_USER];
}

const pgError = (code: string, constraint?: string) => Object.assign(new Error(`pg ${code}`), { code, constraint });
const configIs = (overrides: Record<string, unknown>, ...more: Array<[RegExp, unknown[] | Error]>): Answer =>
  rowsWhen([/FROM tenant_sso_configs/, [{ ...CONFIG_ROW, ...overrides }]], ...more);
const linked = (row: Record<string, unknown>): [RegExp, unknown[]] => [
  /FROM sso_user_identities i/,
  [{ user_id: USER, role: 'learner', is_active: true, tenant_id: TENANT, ...row }],
];
const notLinked: [RegExp, unknown[]] = [/FROM sso_user_identities i/, []];
const emailUser = (row: Record<string, unknown> | null): [RegExp, unknown[]] => [
  /lower\(btrim\(email\)\) = \$1/,
  row ? [{ id: USER, tenant_id: TENANT, role: 'learner', is_active: true, ...row }] : [],
];
const sessionUser = (row: Record<string, unknown>): [RegExp, unknown[]] => [/FROM users u/, [{ ...SESSION_USER, ...row }]];

const admin = { id: OTHER_USER, tenantId: TENANT, role: 'superadmin', username: 'root', sessionMode: 'normal' };

const cases: Case[] = [];
const add = (name: string, run: (t: TestContext) => Promise<unknown>, answer?: Answer, setup?: () => void) =>
  cases.push({
    name,
    run: async t => {
      provider = defaultProvider();
      providerRequests.length = 0;
      fetchCalls = 0;
      setup?.();
      return run(t);
    },
    answer,
  });

// ── Route table ──
const NAMES = new Map<unknown, string>([
  [authenticate, 'authenticate'],
  [tenantContext, 'tenantContext'],
  [ssoExchangeIpLimiter, 'ssoExchangeIpLimiter'],
  ...Object.entries(ctrl).map(([name, fn]) => [fn, name] as [unknown, string]),
]);
add('routes: /api/sso', async () => describeRouter(ssoRouter, NAMES));

// ── Admin config ──
const update = (provider: string, body: unknown) =>
  call(ctrl.updateConfigController, { user: admin, params: { provider }, body });
add('list configs', () => call(ctrl.listConfigsController, { user: admin }));
add('list configs without tenant', () => call(ctrl.listConfigsController, { user: { ...admin, tenantId: null } }));
add('update config', () =>
  update('google', {
    is_enabled: true,
    client_id: 'client-456',
    client_secret: ' new-secret ',
    scopes: ['openid', 'email'],
    extra_config: { auto_register_enabled: false, allowed_email_domains: ['example.test'] },
  }),
);
add('update config clears the secret', () => update('google', { is_enabled: false, clear_client_secret: true }));
add('update config keeps unspecified fields', () => update('google', { token_url: null }), configIs({ extra_config: [] }));
add(
  'update config of a new provider',
  () => update('keycloak', { client_id: 'kc', issuer_url: 'https://kc.example.test/realms/a' }),
  rowsWhen([/SELECT \* FROM tenant_sso_configs/, []], [/SELECT is_enabled, client_secret_enc/, []]),
);
add('update config invalid provider', () => update('github', { is_enabled: true }));
add('update config secret and clear together', () => update('google', { client_secret: 'x', clear_client_secret: true }));
add('update config plain http url', () => update('google', { token_url: 'http://idp.example.test/token' }));
add('update config invalid email domains', () => update('google', { extra_config: { allowed_email_domains: ['not a domain'] } }));
add('update config without tenant', () =>
  call(ctrl.updateConfigController, { user: { ...admin, tenantId: null }, params: { provider: 'google' }, body: {} }),
);
add('delete config', () => call(ctrl.deleteConfigController, { user: admin, params: { provider: 'microsoft365' } }));
add('delete config invalid provider', () => call(ctrl.deleteConfigController, { user: admin, params: { provider: 'x' } }));
add('delete config without tenant', () =>
  call(ctrl.deleteConfigController, { user: { ...admin, tenantId: null }, params: { provider: 'google' } }),
);

// ── Public providers by domain ──
const byDomain = (domain: string) => call(ctrl.getPublicByDomainController, { params: { domain } });
add('public providers by domain', () => byDomain('HTTPS://Learn.A.example.test:5273/login'), (text) =>
  /FROM tenant_sso_configs/.test(text)
    ? {
        rows: [
          CONFIG_ROW,
          { ...CONFIG_ROW, provider: 'keycloak', issuer_url: null },
          { ...CONFIG_ROW, provider: 'microsoft365', issuer_url: 'https://login.example.test/tenant-a/v2.0/', scopes: [] },
          { ...CONFIG_ROW, provider: 'keycloak', client_id: null },
          { ...CONFIG_ROW, provider: 'keycloak', authorization_url: 'https://kc.example.test/auth', scopes: ['openid'] },
        ],
      }
    : undefined,
);
add('public providers of an unknown domain', () => byDomain('unknown.example.test'), rowsWhen([/FROM tenants/, []]));
add('public providers without domain', () => byDomain(''));

// ── Code exchange ──
const REDIRECT = 'https://learn.a.example.test/sso-callback.html';
const exchange = (body: Record<string, unknown> = {}, providerName = 'google', headers?: Record<string, string>) =>
  call(ctrl.exchangeController, {
    params: { provider: providerName },
    body: { tenant_id: TENANT, code: 'auth-code-123', redirect_uri: REDIRECT, ...body },
    headers,
  });
add('exchange linked identity', () => exchange());
add('exchange linked identity staff', () => exchange(), rowsWhen(linked({ role: 'staff' }), sessionUser({ role: 'staff' })));
add('exchange linked identity of another tenant', () => exchange(), rowsWhen(linked({ tenant_id: TENANT_B })));
add('exchange linked identity without tenant', () => exchange(), rowsWhen(linked({ tenant_id: null, role: 'superadmin' })));
add('exchange linked identity inactive', () => exchange(), rowsWhen(linked({ is_active: false })));
add('exchange links an existing account', () => exchange(), rowsWhen(notLinked, emailUser({ role: 'staff' }), sessionUser({ role: 'staff' })));
add(
  'exchange links an existing account with a string claim',
  () => exchange(),
  rowsWhen(notLinked, emailUser({})),
  () => {
    provider.userinfo.body = { sub: 'google-sub-1', email: 'learner@example.test', email_verified: 'true' };
  },
);
add(
  'exchange existing account email not verified',
  () => exchange(),
  rowsWhen(notLinked, emailUser({})),
  () => {
    provider.userinfo.body = { sub: 'google-sub-1', email: 'learner@example.test' };
  },
);
add('exchange existing account of another tenant', () => exchange(), rowsWhen(notLinked, emailUser({ tenant_id: TENANT_B })));
add('exchange existing superadmin account', () => exchange(), rowsWhen(notLinked, emailUser({ tenant_id: null, role: 'superadmin' })));
add('exchange existing account inactive', () => exchange(), rowsWhen(notLinked, emailUser({ is_active: false })));
add(
  'exchange subject linked to another user',
  () => exchange(),
  rowsWhen(notLinked, emailUser({}), [/SELECT user_id\s+FROM sso_user_identities/, [{ user_id: OTHER_USER }]]),
);
add(
  'exchange identity insert conflict',
  () => exchange(),
  rowsWhen(notLinked, emailUser({}), [/INSERT INTO sso_user_identities/, pgError('23505')]),
);
add(
  'exchange new learner',
  () => exchange(),
  rowsWhen(notLinked, emailUser(null), sessionUser({ id: NEW_USER, username: 'learner' })),
);
add(
  'exchange new learner waiting for approval',
  () => exchange(),
  rowsWhen([/FROM tenant_sso_configs/, [{ ...CONFIG_ROW, extra_config: {} }]], notLinked, emailUser(null)),
);
add(
  'exchange new learner over the user quota',
  () => exchange(),
  rowsWhen(notLinked, emailUser(null), [/max_users AS quota/, [{ quota: 10, current_count: '10' }]]),
);
add(
  'exchange new learner username taken',
  () => exchange(),
  (text, _index, params) => {
    if (/FROM sso_user_identities i/.test(text) || /lower\(btrim\(email\)\) = \$1/.test(text)) return { rows: [] };
    if (/SELECT id FROM users WHERE username/.test(text)) return { rows: params[0] === 'learner-2' ? [] : [{ id: OTHER_USER }] };
    return undefined;
  },
);
{
  let inserts = 0;
  add(
    'exchange new learner username race',
    () => {
      inserts = 0;
      return exchange();
    },
    text => {
      if (/FROM sso_user_identities i/.test(text) || /lower\(btrim\(email\)\) = \$1/.test(text)) return { rows: [] };
      if (/INSERT INTO users/.test(text) && inserts++ === 0) return pgError('23505', 'users_username_key');
      return undefined;
    },
  );
}
{
  let emailReads = 0;
  add(
    'exchange new learner email race',
    () => {
      emailReads = 0;
      return exchange();
    },
    text => {
      if (/FROM sso_user_identities i/.test(text)) return { rows: [] };
      if (/lower\(btrim\(email\)\) = \$1/.test(text)) {
        return { rows: emailReads++ === 0 ? [] : [{ id: OTHER_USER, tenant_id: TENANT, role: 'learner', is_active: true }] };
      }
      if (/INSERT INTO users/.test(text)) return pgError('23505', 'users_email_key');
      return undefined;
    },
  );
}
add(
  'exchange email domain not allowed',
  () => exchange(),
  configIs({ extra_config: { auto_register_enabled: true, allowed_email_domains: ['other.test'] } }),
);
add(
  'exchange email domain allowed',
  () => exchange(),
  configIs({ extra_config: { auto_register_enabled: true, allowed_email_domains: ['@Example.TEST.'] } }),
);
add(
  'exchange allowed domains invalid',
  () => exchange(),
  configIs({ extra_config: { allowed_email_domains: 'example.test' } }),
);
add('exchange provider not enabled', () => exchange(), rowsWhen([/FROM tenant_sso_configs/, []]));
add('exchange provider without secret', () => exchange(), configIs({ client_secret_enc: null }));
add('exchange token request refused', () => exchange(), undefined, () => {
  provider.token = { status: 400, body: { error: 'invalid_grant' } };
});
add('exchange token without access token', () => exchange(), undefined, () => {
  provider.token = { status: 200, body: { id_token: 'x' } };
});
add('exchange userinfo refused', () => exchange(), undefined, () => {
  provider.userinfo = { status: 401, body: {} };
});
add('exchange profile without email', () => exchange(), undefined, () => {
  provider.userinfo.body = { sub: 'google-sub-1' };
});
add('exchange profile email invalid', () => exchange(), undefined, () => {
  provider.userinfo.body = { sub: 'google-sub-1', email: 'not-an-email' };
});
add('exchange profile email unverified', () => exchange(), undefined, () => {
  provider.userinfo.body = { sub: 'google-sub-1', email: 'learner@example.test', email_verified: 'false' };
});
add('exchange provider timeout', async t => {
  provider.hang = true;
  t.mock.timers.reset();
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.parse('2026-10-18T03:04:05.000Z') });
  const pending = exchange();
  while (fetchCalls === 0) await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(15_000);
  return pending;
});
add('exchange admin site learner', () => exchange({ client_app: 'admin' }));
add(
  'exchange admin site learner_plus without groups',
  () => exchange({ client_app: 'admin' }),
  rowsWhen(linked({ role: 'learner_plus' }), [/COUNT\(\*\)/, [{ count: '0' }]]),
);
add(
  'exchange admin site learner_plus with groups',
  () => exchange({ client_app: 'admin' }),
  rowsWhen(linked({ role: 'learner_plus' }), sessionUser({ role: 'learner_plus' })),
);
add('exchange admin site inferred from the redirect host', () => exchange({ redirect_uri: 'https://ADMIN.a.example.test/cb' }));
add('exchange learner site inferred from the redirect host', () =>
  exchange({ redirect_uri: 'http://learn.a.example.test:5273/sso-callback.html' }),
);
add('exchange redirect host of no site', () => exchange({ redirect_uri: 'https://elsewhere.example.test/cb' }), rowsWhen([/SELECT domain_admin/, []]));
add('exchange with code verifier', () => exchange({ code_verifier: 'v'.repeat(43), client_app: 'learner' }));
add(
  'exchange keycloak endpoints from the issuer',
  () => exchange({}, 'keycloak'),
  configIs({ provider: 'keycloak', issuer_url: 'https://kc.example.test/realms/a/' }),
);
add(
  'exchange microsoft365 endpoints',
  () => exchange({}, 'microsoft365'),
  configIs({ provider: 'microsoft365', issuer_url: 'https://login.example.test/tenant-a/v2.0' }),
);
add(
  'exchange configured endpoints',
  () => exchange(),
  configIs({ token_url: 'https://idp.example.test/t', userinfo_url: 'https://idp.example.test/me' }),
);
add('exchange session refused for a disabled organization', () => exchange(), rowsWhen(sessionUser({ tenant_active: false })));
add('exchange invalid provider', () => exchange({}, 'github'));
add('exchange invalid body', () => exchange({ code: 'short' }));
add('exchange refusal in english', () => exchange({}, 'google', { 'X-UI-Locale': 'en' }), rowsWhen(linked({ tenant_id: TENANT_B })));

runCharacterization(cases, {
  label: 'sso characterization',
  goldenPath: path.join(path.dirname(fileURLToPath(import.meta.url)), 'sso-sql.characterization.golden.json'),
  envPrefix: 'SSO_SQL',
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
  // A secret is encrypted with a random IV: shown decrypted.
  transform: text => (/^v1:[^:]+:[^:]+:[^:]+$/.test(text) ? `<encrypted "${decryptSecret(text)}">` : text),
  records: () => ({ provider_requests: [...providerRequests] }),
  reset: () => {
    providerRequests.length = 0;
  },
});
