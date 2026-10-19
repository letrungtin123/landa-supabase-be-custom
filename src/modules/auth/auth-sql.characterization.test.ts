import { createHash } from 'node:crypto';
import path from 'node:path';
import { mock, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { RedisClientType } from '@redis/client';
import type { Request } from 'express';
import {
  CHARACTERIZATION_NOW as NOW,
  call,
  describeRouter,
  fakeRequest,
  rowsWhen,
  runCharacterization,
  settle,
  type Answer,
  type Case,
} from '../../test-support/sql-characterization.js';

// Characterization of sign-in and sessions: login (every refusal and its
// order), refresh rotation (reuse grace, family revoke, demo iframe modes,
// the context-unavailable handoff), logout, /me and the label reads, password
// change, profile update, one-time tokens, issueSessionForUserId, the
// authenticate / optionalAuth middleware, the durable revocation with its
// Redis mirror, the rate-limit keys and the /api/auth route table (where each
// limiter stands). Each case records its SQL, Redis commands, bcrypt calls,
// audit rows and answer (see test-support/sql-characterization.ts).
//
// The golden file was written by the code before the auth repositories
// existed. Rewrite it only for an intended change:
//   AUTH_SQL_GOLDEN_WRITE=1 npx tsx --test src/modules/auth/auth-sql.characterization.test.ts
// AUTH_SQL_FULL_OUT=<file> also writes every outcome in full.

process.env.TZ = 'Asia/Ho_Chi_Minh';
process.env.REDIS_URL = 'redis://127.0.0.1:1';

const bcrypt = (await import('bcrypt')).default;
const redis = await import('../../config/redis.js');
const { pool } = await import('../../config/database.js');
const { env } = await import('../../config/env.js');
const { signAccessToken, verifyAccessToken } = await import('../../utils/jwt.js');
const { compareAgainstDummyPassword } = await import('../../utils/password.js');
const ctrl = await import('./auth.controller.js');
const authService = await import('./auth.service.js');
const revocation = await import('./auth-revocation.service.js');
const { authenticate, optionalAuth, blacklistUser } = await import('../../middleware/authenticate.js');
const { tenantContext } = await import('../../middleware/tenant-context.js');
const limits = await import('../../middleware/auth-rate-limit.js');
const { authenticatedUserOrIpRateLimitKey } = await import('../../middleware/rate-limit-key.js');
const { default: authRouter } = await import('./auth.routes.js');

redis.installRedisClient(null);

const TENANT = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const USER = 'a0000000-0000-4000-8000-000000000001';
const LEARNER = 'a0000000-0000-4000-8000-000000000002';
const BLACK_USER = 'a0000000-0000-4000-8000-000000000003';
const DEMO_LEARNER = 'a0000000-0000-4000-8000-000000000004';
const OTHER_USER = 'a0000000-0000-4000-8000-000000000005';
const ORG = 'e0000000-0000-4000-8000-000000000001';
const SESSION = 'c0000000-0000-4000-8000-000000000001';
const RT_ID = 'd0000000-0000-4000-8000-000000000001';
const RT_ID_2 = 'd0000000-0000-4000-8000-000000000002';
const FIXED_IDS = new Set([TENANT, TENANT_B, USER, LEARNER, BLACK_USER, DEMO_LEARNER, OTHER_USER, ORG, SESSION, RT_ID, RT_ID_2]);

// ── bcrypt double: compare accepts "stored:<password>"; hash keeps known test passwords readable ──
const KNOWN_PASSWORDS = new Set(['Right#2026', 'Wrong#2026', 'NewPass#2026', 'short']);
const bcryptCalls: unknown[] = [];
mock.method(bcrypt, 'hash', (async (plaintext: string, rounds: number) => {
  const shown = KNOWN_PASSWORDS.has(plaintext) ? plaintext : `<random ${plaintext.length} chars>`;
  bcryptCalls.push(['hash', shown, rounds]);
  return `bcrypt-cost-${rounds}:${shown}`;
}) as never);
mock.method(bcrypt, 'compare', (async (plaintext: unknown, hash: unknown) => {
  if (typeof plaintext !== 'string' || typeof hash !== 'string') throw new Error('data and hash must be strings');
  bcryptCalls.push(['compare', plaintext, hash]);
  return hash === `stored:${plaintext}`;
}) as never);
// The dummy hash of unknown sign-in names is made once per process.
await compareAgainstDummyPassword('prewarm');

// ── Redis double (one case installs it) ──
const redisCalls: unknown[] = [];

const USER_ROW = {
  id: USER,
  username: 'staff01',
  email: 'staff01@example.test',
  full_name: 'Nhân viên A',
  phone: '0900000001',
  avatar_url: null,
  role: 'staff',
  is_active: true,
  tenant_id: TENANT,
  password_hash: 'stored:Right#2026',
  tenant_name: 'Công ty A',
  tenant_active: true,
  bio: null,
  gender: null,
  country: 'VN',
  language: 'vi',
  level_of_education: null,
  year_of_birth: 1990,
};

const TOKEN_ROW = {
  ...USER_ROW,
  rt_id: RT_ID,
  user_id: USER,
  revoked: false,
  expires_at: new Date(NOW + 7 * 86_400_000),
  revoked_at: null as Date | null,
  session_id: null as string | null,
  session_mode: 'normal',
  session_revoked_at: null as Date | null,
};

/** The rows each statement family answers unless a case says otherwise. */
function fallback(text: string): unknown[] {
  if (/tenant_demo_iframe_settings/.test(text)) return [];
  if (/FROM auth_revocations/.test(text)) return [];
  if (/FROM refresh_tokens rt/.test(text)) return [TOKEN_ROW];
  if (/FROM tenant_modules/.test(text)) return [{ code: 'courses' }, { code: 'reports' }];
  if (/bool_or\(/.test(text)) return [{ code: 'courses', can_view: true, can_add: false, can_edit: true, can_delete: false }];
  if (/FROM modules/.test(text)) return [{ code: 'courses' }, { code: 'reports' }, { code: 'users' }];
  if (/FROM tenants WHERE is_active = true ORDER BY name/.test(text)) {
    return [
      { id: TENANT, name: 'Công ty A' },
      { id: TENANT_B, name: 'Công ty B' },
    ];
  }
  if (/SELECT id, name FROM tenants WHERE id = \$1/.test(text)) return [{ id: TENANT, name: 'Công ty A' }];
  if (/SELECT id FROM tenants/.test(text)) return [{ id: TENANT }];
  if (/FROM team_members/.test(text)) return [{ id: ORG, name: 'Khối A' }];
  if (/COUNT\(\*\)/.test(text)) return [{ count: '2' }];
  if (/tenant_role_labels/.test(text)) return [{ role: 'staff', label: 'Nhân sự' }];
  if (/tenant_group_labels/.test(text)) return [{ label_key: 'org_group', label: 'Khối' }];
  if (/^\s*(INSERT|UPDATE|DELETE)/.test(text) && !/RETURNING/.test(text)) return [];
  return [USER_ROW];
}

const userIs = (overrides: Record<string, unknown>): Answer => rowsWhen([/FROM users u/, [{ ...USER_ROW, ...overrides }]]);
const tokenIs = (overrides: Record<string, unknown>, ...more: Array<[RegExp, unknown[] | Error]>): Answer =>
  rowsWhen([/FROM refresh_tokens rt/, [{ ...TOKEN_ROW, ...overrides }]], ...more);
const demoLocked: [RegExp, unknown[]] = [/tenant_demo_iframe_settings/, [{ exists: true }]];
const ago = (ms: number) => new Date(NOW - ms);

const reqUser = (overrides: Record<string, unknown> = {}) => ({
  id: USER,
  tenantId: TENANT,
  role: 'staff',
  username: 'staff01',
  sessionMode: 'normal',
  ...overrides,
});

const bearer = (payload: Partial<Parameters<typeof signAccessToken>[0]> = {}) =>
  `Bearer ${signAccessToken({ sub: USER, tid: TENANT, role: 'staff', username: 'staff01', session_mode: 'normal', ...payload })}`;

const cases: Case[] = [];
const add = (name: string, run: (t: TestContext) => Promise<unknown>, answer?: Answer) =>
  cases.push({ name, run, answer });

// ── Route table and rate-limit keys ──
const NAMES = new Map<unknown, string>([
  [authenticate, 'authenticate'],
  [optionalAuth, 'optionalAuth'],
  [tenantContext, 'tenantContext'],
  [limits.loginIpLimiter, 'loginIpLimiter'],
  [limits.loginAccountLimiter, 'loginAccountLimiter'],
  [limits.refreshIpLimiter, 'refreshIpLimiter'],
  [limits.refreshTokenLimiter, 'refreshTokenLimiter'],
  [limits.passwordChangeLimiter, 'passwordChangeLimiter'],
  [limits.accountActionLimiter, 'accountActionLimiter'],
  ...Object.entries(ctrl).map(([name, fn]) => [fn, name] as [unknown, string]),
]);
add('routes: /api/auth', async () => describeRouter(authRouter, NAMES));
add('rate limit keys and budgets', async () => {
  const login = (body: unknown, ip?: string) => limits.loginAccountRateLimitKey(fakeRequest({ body, ip }));
  const refresh = (body: unknown) => limits.refreshTokenRateLimitKey(fakeRequest({ body }));
  const userOrIp = (authorization?: string) =>
    authenticatedUserOrIpRateLimitKey(fakeRequest(authorization ? { headers: { authorization } } : {}));
  const refusal = (statusCode: number) => limits.isNotClientRefusal({} as Request, { statusCode } as never);
  return {
    login: [
      login({ username: ' Staff01@Example.TEST ' }),
      login({ username: 'staff01' }),
      login({ username: '   ' }),
      login({}),
      login({ username: 5 }),
      login({}, '2001:db8::1'),
      login(undefined, '198.51.100.9'),
    ],
    refresh: [refresh({ refresh_token: ' token-1 ' }), refresh({ refresh_token: '' }), refresh({})],
    user_or_ip: [userOrIp(bearer()), userOrIp('Bearer not-a-token'), userOrIp()],
    counts_as_refusal: [200, 302, 400, 401, 429, 500, 503].map(code => [code, !refusal(code)]),
    window_ms: limits.AUTH_RATE_LIMIT_WINDOW_MS,
    budgets: {
      login_ip: env.AUTH_LOGIN_IP_MAX_FAILURES,
      login_account: env.AUTH_LOGIN_ACCOUNT_MAX_FAILURES,
      refresh_token: env.AUTH_REFRESH_TOKEN_MAX_ATTEMPTS,
      refresh_ip: env.AUTH_REFRESH_IP_MAX_FAILURES,
      password_change: env.AUTH_PASSWORD_CHANGE_MAX_ATTEMPTS,
      account_action: env.AUTH_ACCOUNT_ACTION_MAX_ATTEMPTS,
    },
  };
});

// ── Login ──
const PASSWORD = 'Right#2026';
const login = (body: Record<string, unknown>, headers?: Record<string, string>) =>
  call(ctrl.loginController, { body: { password: PASSWORD, ...body }, headers });
add('login staff by username', () => login({ username: 'staff01' }));
add('login by email', () => login({ username: ' Staff01@Example.TEST ' }));
add(
  'login by email not found falls back to username',
  () => login({ username: 'staff01@example.test' }),
  rowsWhen([/lower\(btrim\(u\.email\)\)/, []]),
);
add('login unknown user', () => login({ username: 'nobody' }), rowsWhen([/FROM users u/, []]));
add(
  'login unknown user english',
  () => login({ username: 'nobody' }, { 'X-UI-Locale': 'en' }),
  rowsWhen([/FROM users u/, []]),
);
add('login wrong password', () => login({ username: 'staff01', password: 'Wrong#2026' }));
add('login account without password hash', () => login({ username: 'staff01' }), userIs({ password_hash: null }));
add('login disabled account', () => login({ username: 'staff01' }), userIs({ is_active: false }));
add(
  'login disabled account wrong password',
  () => login({ username: 'staff01', password: 'Wrong#2026' }),
  userIs({ is_active: false }),
);
add(
  'login learner on admin site',
  () => login({ username: 'learner01', client_app: 'admin' }),
  userIs({ id: LEARNER, role: 'learner' }),
);
add('login learner', () => login({ username: 'learner01', client_app: 'learner' }), userIs({ id: LEARNER, role: 'learner' }));
add(
  'login learner_plus on admin with permission groups',
  () => login({ username: 'lp01', client_app: 'admin' }),
  userIs({ id: LEARNER, role: 'learner_plus' }),
);
add(
  'login learner_plus on admin without permission groups',
  () => login({ username: 'lp01', client_app: 'admin' }),
  rowsWhen([/FROM users u/, [{ ...USER_ROW, id: LEARNER, role: 'learner_plus' }]], [/COUNT\(\*\)/, [{ count: '0' }]]),
);
add(
  'login learner without organization',
  () => login({ username: 'learner01' }),
  userIs({ id: LEARNER, role: 'learner', tenant_id: null, tenant_name: null, tenant_active: null }),
);
add(
  'login learner organization disabled',
  () => login({ username: 'learner01' }),
  userIs({ id: LEARNER, role: 'learner', tenant_active: false }),
);
add('login superuser', () => login({ username: 'su01' }), userIs({ role: 'superuser' }));
add(
  'login superuser without managed or primary tenant',
  () => login({ username: 'su01' }),
  rowsWhen(
    [/FROM users u/, [{ ...USER_ROW, role: 'superuser', tenant_id: null, tenant_name: null, tenant_active: null }]],
    [/COUNT\(\*\)/, [{ count: '0' }]],
  ),
);
add(
  'login superuser with managed tenant only',
  () => login({ username: 'su01' }),
  userIs({ role: 'superuser', tenant_id: null, tenant_name: null, tenant_active: null }),
);
add(
  'login staff without tenant',
  () => login({ username: 'staff01' }),
  userIs({ tenant_id: null, tenant_name: null, tenant_active: null }),
);
add('login staff tenant disabled', () => login({ username: 'staff01' }), userIs({ tenant_active: false }));
add(
  'login superadmin',
  () => login({ username: 'root', origin: 'https://superadmin.example.test' }),
  userIs({ role: 'superadmin', tenant_id: null, tenant_name: null, tenant_active: null }),
);
add('login origin of own tenant', () => login({ username: 'staff01', origin: 'https://a.example.test/' }));
add(
  'login origin of another tenant',
  () => login({ username: 'staff01', origin: 'https://b.example.test' }),
  rowsWhen([/SELECT id FROM tenants/, [{ id: TENANT_B }]]),
);
add(
  'login origin of another tenant wrong password',
  () => login({ username: 'staff01', password: 'Wrong#2026', origin: 'https://b2.example.test' }),
  rowsWhen([/SELECT id FROM tenants/, [{ id: TENANT_B }]]),
);
add(
  'login origin of another tenant disabled account',
  () => login({ username: 'staff01', origin: 'https://b3.example.test' }),
  rowsWhen([/SELECT id FROM tenants/, [{ id: TENANT_B }]], [/FROM users u/, [{ ...USER_ROW, is_active: false }]]),
);
add('login origin header', () => login({ username: 'staff01' }, { origin: 'https://header.example.test' }));
add(
  'login origin unknown',
  () => login({ username: 'staff01', origin: 'http://localhost:5274' }),
  rowsWhen([/SELECT id FROM tenants/, []]),
);
add(
  'login demo iframe account locked',
  () => login({ username: 'learner01' }),
  rowsWhen([/FROM users u/, [{ ...USER_ROW, id: LEARNER, role: 'learner' }]], demoLocked),
);
add('login empty body', () => call(ctrl.loginController, { body: {} }));
add('login missing password', () => call(ctrl.loginController, { body: { username: 'staff01' } }));
add('login unknown client app', () => login({ username: 'staff01', client_app: 'mobile' }));
add(
  'login audit write fails',
  () => login({ username: 'staff01' }),
  rowsWhen([/INSERT INTO audit_logs/, new Error('quota exceeded')]),
);
add('login database error', () => login({ username: 'staff01' }), rowsWhen([/FROM users u/, new Error('db down')]));

// ── Refresh ──
// The stored hash of a refresh token the case sent is shown as the hash of that token.
const knownTokens = new Map<string, string>();
const known = (token: unknown) => {
  if (typeof token === 'string') knownTokens.set(createHash('sha256').update(token).digest('hex'), token);
};
known('rt-out');
const refresh = (body: Record<string, unknown>) => {
  known(body.refresh_token);
  return call(ctrl.refreshController, { body });
};
add('refresh', () => refresh({ refresh_token: 'rt-normal' }));
add(
  'refresh superadmin with a selected tenant',
  () => refresh({ refresh_token: 'rt-sa', tenant_id: TENANT_B }),
  tokenIs({ role: 'superadmin', tenant_id: null, tenant_name: null, tenant_active: null, session_id: SESSION }),
);
add(
  'refresh superadmin legacy row without session id',
  () => refresh({ refresh_token: 'rt-sa-legacy' }),
  tokenIs({ role: 'superadmin', tenant_id: null, tenant_name: null, tenant_active: null }),
);
add('refresh unknown token', () => refresh({ refresh_token: 'rt-unknown' }), rowsWhen([/FROM refresh_tokens rt/, []]));
add(
  'refresh reuse within grace',
  () => refresh({ refresh_token: 'rt-grace' }),
  tokenIs({ revoked: true, revoked_at: ago(5_000) }),
);
add(
  'refresh reuse after grace revokes every session',
  () => refresh({ refresh_token: 'rt-stolen' }),
  tokenIs({ revoked: true, revoked_at: ago(60_000) }),
);
add(
  'refresh reuse without revoked_at',
  () => refresh({ refresh_token: 'rt-stolen-2' }),
  tokenIs({ revoked: true, revoked_at: null }),
);
add(
  'refresh superadmin reuse revokes its session family',
  () => refresh({ refresh_token: 'rt-sa-stolen' }),
  tokenIs({ role: 'superadmin', tenant_id: null, session_id: SESSION, revoked: true, revoked_at: ago(60_000) }),
);
add(
  'refresh superadmin reuse without session id',
  () => refresh({ refresh_token: 'rt-sa-stolen-2' }),
  tokenIs({ role: 'superadmin', tenant_id: null, revoked: true, revoked_at: ago(60_000) }),
);
add(
  'refresh token of an ended session',
  () => refresh({ refresh_token: 'rt-ended' }),
  tokenIs({ revoked: true, revoked_at: ago(60_000), session_revoked_at: ago(60_000) }),
);
add(
  'refresh expired',
  () => refresh({ refresh_token: 'rt-expired' }),
  tokenIs({ expires_at: ago(1_000) }),
);
add('refresh disabled account', () => refresh({ refresh_token: 'rt-disabled' }), tokenIs({ is_active: false }));
add('refresh organization disabled', () => refresh({ refresh_token: 'rt-org' }), tokenIs({ tenant_active: false }));
add(
  'refresh superadmin with a disabled tenant',
  () => refresh({ refresh_token: 'rt-sa-org' }),
  tokenIs({ role: 'superadmin', tenant_active: false, session_id: SESSION }),
);
add(
  'refresh demo iframe learner with a normal session',
  () => refresh({ refresh_token: 'rt-demo-normal' }),
  tokenIs({ user_id: LEARNER, id: LEARNER, role: 'learner' }, demoLocked),
);
add(
  'refresh demo iframe session no longer demo',
  () => refresh({ refresh_token: 'rt-demo-gone' }),
  tokenIs({ user_id: LEARNER, id: LEARNER, role: 'learner', session_mode: 'demo_iframe' }),
);
add(
  'refresh demo iframe session',
  () => refresh({ refresh_token: 'rt-demo' }),
  tokenIs({ user_id: LEARNER, id: LEARNER, role: 'learner', session_mode: 'demo_iframe' }, demoLocked),
);
add('refresh empty body', () => refresh({}));
add('refresh tenant id not a uuid', () => refresh({ refresh_token: 'rt-x', tenant_id: 'abc' }));
add(
  'refresh lock fails',
  () => refresh({ refresh_token: 'rt-db' }),
  rowsWhen([/FROM refresh_tokens rt/, new Error('db down')]),
);
{
  // The session context cannot be read after the rotation: 503, then the
  // retry of the same token within the grace period rotates the successor.
  let phase = 1;
  const HANDOFF_TOKEN_HASH = createHash('sha256').update('rt-handoff').digest('hex');
  add(
    'refresh context unavailable then the retry takes the handoff',
    async () => {
      const first = await refresh({ refresh_token: 'rt-handoff' });
      phase = 2;
      const second = await refresh({ refresh_token: 'rt-handoff' });
      return { first, second };
    },
    (text, index, params) => {
      if (/FROM refresh_tokens rt/.test(text)) {
        if (phase === 1) return { rows: [TOKEN_ROW] };
        // The retried token was rotated 2 s ago; the successor is valid.
        return params[0] === HANDOFF_TOKEN_HASH
          ? { rows: [{ ...TOKEN_ROW, revoked: true, revoked_at: ago(2_000) }] }
          : { rows: [{ ...TOKEN_ROW, rt_id: RT_ID_2 }] };
      }
      if (phase === 1 && /FROM modules|bool_or\(/.test(text)) return new Error(`context read ${index} failed`);
      return undefined;
    },
  );
}

// ── Logout, /me, labels ──
add('logout staff', () => call(ctrl.logoutController, { body: { refresh_token: 'rt-out' }, user: reqUser() }));
add('logout learner', () =>
  call(ctrl.logoutController, { body: { refresh_token: 'rt-out' }, user: reqUser({ id: LEARNER, role: 'learner' }) }),
);
add('logout superadmin', () =>
  call(ctrl.logoutController, { body: { refresh_token: 'rt-out' }, user: reqUser({ role: 'superadmin', tenantId: TENANT_B }) }),
);
add('logout without session or token', () => call(ctrl.logoutController, { body: {} }));
add('logout token only', () => call(ctrl.logoutController, { body: { refresh_token: 'rt-out' } }));

add('me staff', () => call(ctrl.getMeController, { user: reqUser() }));
add(
  'me learner_plus',
  () => call(ctrl.getMeController, { user: reqUser({ role: 'learner_plus' }) }),
  userIs({ role: 'learner_plus', bio: 'Giới thiệu', gender: 'male', level_of_education: 'bachelor' }),
);
add('me superuser', () => call(ctrl.getMeController, { user: reqUser({ role: 'superuser' }) }), userIs({ role: 'superuser' }));
add(
  'me superadmin with a selected tenant',
  () => call(ctrl.getMeController, { user: reqUser({ role: 'superadmin', tenantId: TENANT_B }) }),
  userIs({ role: 'superadmin', tenant_id: null, tenant_name: null }),
);
add(
  'me superadmin with an unmanaged tenant',
  () => call(ctrl.getMeController, { user: reqUser({ role: 'superadmin', tenantId: ORG }) }),
  userIs({ role: 'superadmin', tenant_id: null, tenant_name: null }),
);
add(
  'me demo iframe session',
  () => call(ctrl.getMeController, { user: reqUser({ id: LEARNER, role: 'learner', sessionMode: 'demo_iframe' }) }),
  userIs({ id: LEARNER, role: 'learner', country: null, language: null, year_of_birth: null }),
);
add('me unknown user', () => call(ctrl.getMeController, { user: reqUser() }), rowsWhen([/FROM users u/, []]));
add('me without user', () => call(ctrl.getMeController, {}));
add('role labels', () => call(ctrl.getRoleLabelsController, { user: reqUser() }));
add('role labels without user', () => call(ctrl.getRoleLabelsController, {}));
add('group labels', () => call(ctrl.getGroupLabelsController, { user: reqUser() }));
add('group labels without tenant', () => call(ctrl.getGroupLabelsController, { user: reqUser({ role: 'superadmin', tenantId: null }) }));
add('group labels without user', () => call(ctrl.getGroupLabelsController, {}));

// ── Password change and profile ──
const changePassword = (body: unknown, user: Record<string, unknown> | null = reqUser()) =>
  call(ctrl.changePasswordController, { body, user });
add('change password', () => changePassword({ current_password: PASSWORD, new_password: 'NewPass#2026' }));
add('change password wrong current', () => changePassword({ current_password: 'Wrong#2026', new_password: 'NewPass#2026' }));
add('change password too short', () => changePassword({ current_password: PASSWORD, new_password: 'short' }));
add('change password missing fields', () => changePassword({ current_password: PASSWORD }));
add('change password demo iframe', () =>
  changePassword({ current_password: PASSWORD, new_password: 'NewPass#2026' }, reqUser({ sessionMode: 'demo_iframe' })),
);
add(
  'change password unknown user',
  () => changePassword({ current_password: PASSWORD, new_password: 'NewPass#2026' }),
  rowsWhen([/SELECT password_hash FROM users/, []]),
);
add(
  'change password account without hash',
  () => changePassword({ current_password: PASSWORD, new_password: 'NewPass#2026' }),
  rowsWhen([/SELECT password_hash FROM users/, [{ password_hash: null }]]),
);
add('change password without user', () => changePassword({ current_password: PASSWORD, new_password: 'NewPass#2026' }, null));

const profile = (body: unknown, user: Record<string, unknown> | null = reqUser()) =>
  call(ctrl.updateProfileController, { body, user });
add('profile update', () =>
  profile({ full_name: 'Tên mới', phone: '0911', gender: '', level_of_education: '', year_of_birth: 1991, role: 'superadmin' }),
);
add('profile enum values', () => profile({ gender: 'female', level_of_education: 'master', bio: 'Xin chào', country: 'VN', language: 'en' }));
add('profile avatar refused', () => profile({ avatar_url: 'https://x.example.test/a.png' }));
add('profile avatar cleared', () => profile({ avatar_url: null }));
add('profile nothing to update', () => profile({ email: 'x@example.test' }));
add('profile demo iframe', () => profile({ full_name: 'X' }, reqUser({ sessionMode: 'demo_iframe' })));
add('profile unknown user', () => profile({ full_name: 'X' }), rowsWhen([/^\s*UPDATE users SET/, []]));
add('profile without user', () => profile({ full_name: 'X' }, null));

// ── One-time tokens ──
const generate = (user: Record<string, unknown>) => call(ctrl.generateOTTController, { user });
const exchange = (body: unknown) => call(ctrl.exchangeOTTController, { body });
const ottOf = (answer: unknown) => ((answer as { body?: { data?: { ott?: string } } }).body?.data?.ott ?? '') as string;
add('ott generate staff', () => generate(reqUser()));
add('ott generate learner refused', () => generate(reqUser({ id: LEARNER, role: 'learner' })));
add('ott generate learner_plus', () => generate(reqUser({ id: LEARNER, role: 'learner_plus' })));
add('ott generate without user', () => call(ctrl.generateOTTController, {}));
add('ott generate then exchange twice', async () => {
  const issued = await generate(reqUser());
  const first = await exchange({ ott: ottOf(issued) });
  const again = await exchange({ ott: ottOf(issued) });
  return { issued, first, again };
});
add(
  'ott exchange learner',
  async () => exchange({ ott: ottOf(await generate(reqUser({ id: LEARNER, role: 'learner_plus' }))) }),
  userIs({ id: LEARNER, role: 'learner' }),
);
add(
  'ott exchange superadmin',
  async () => exchange({ ott: ottOf(await generate(reqUser({ role: 'superadmin' }))) }),
  userIs({ role: 'superadmin', tenant_id: null, tenant_name: null, tenant_active: null }),
);
add('ott exchange expired', async t => {
  const issued = await generate(reqUser());
  t.mock.timers.tick(31_000);
  return { issued, exchanged: await exchange({ ott: ottOf(issued) }) };
});
add('ott exchange unknown', () => exchange({ ott: 'c9b7a0f2-0000-4000-8000-00000000dead' }));
add('ott exchange missing', () => exchange({}));
add('ott exchange not a string', () => exchange({ ott: 42 }));
add(
  'ott exchange disabled user',
  async () => exchange({ ott: ottOf(await generate(reqUser())) }),
  userIs({ is_active: false }),
);
add(
  'ott exchange unknown user',
  async () => exchange({ ott: ottOf(await generate(reqUser())) }),
  rowsWhen([/FROM users u/, []]),
);

// ── issueSessionForUserId (SSO and demo iframe sign-in) ──
const issue = (userId: string, options?: Parameters<typeof authService.issueSessionForUserId>[1]) =>
  settle(() => authService.issueSessionForUserId(userId, options));
add('issue session', () => issue(USER));
add('issue session without last login', () => issue(USER, { updateLastLogin: false }));
add(
  'issue session demo iframe',
  () => issue(DEMO_LEARNER, { sessionMode: 'demo_iframe', updateLastLogin: false }),
  userIs({ id: DEMO_LEARNER, role: 'learner' }),
);
add('issue session demo iframe for staff', () => issue(USER, { sessionMode: 'demo_iframe' }));
add(
  'issue session for a locked demo learner',
  () => issue(LEARNER),
  rowsWhen([/FROM users u/, [{ ...USER_ROW, id: LEARNER, role: 'learner' }]], demoLocked),
);
add('issue session unknown user', () => issue(USER), rowsWhen([/FROM users u/, []]));
add('issue session disabled user', () => issue(USER), userIs({ is_active: false }));
add('issue session organization disabled', () => issue(USER), userIs({ tenant_active: false }));
add(
  'issue session superadmin with a disabled tenant',
  () => issue(USER),
  userIs({ role: 'superadmin', tenant_active: false }),
);

// ── authenticate / optionalAuth ──
const auth = (authorization?: string, headers: Record<string, string> = {}) =>
  call(authenticate, { headers: authorization ? { authorization, ...headers } : headers });
const optional = (authorization?: string, headers: Record<string, string> = {}) =>
  call(optionalAuth, { headers: authorization ? { authorization, ...headers } : headers });
const revokedAt = (reason: string, at: Date): Answer =>
  rowsWhen([/FROM auth_revocations/, [{ reason, revoked_at: at }]]);
add('authenticate', () => auth(bearer()));
add('authenticate missing header', () => auth());
add('authenticate not a bearer', () => auth('Basic abc'));
add('authenticate malformed token', () => auth('Bearer abc.def.ghi'));
add('authenticate expired token', async t => {
  const token = bearer();
  t.mock.timers.tick(16 * 60 * 1000);
  return auth(token);
});
add('authenticate revoked before the token', () => auth(bearer()), revokedAt('password_changed', new Date(NOW + 5_000)));
add('authenticate token issued after the revocation', () => auth(bearer()), revokedAt('role_changed', ago(60_000)));
add('authenticate permanently deleted user', () => auth(bearer()), revokedAt('permanent_user_deletion', ago(60_000)));
add('authenticate revocation lookup fails', () => auth(bearer()), rowsWhen([/FROM auth_revocations/, new Error('db down')]));
add('authenticate superadmin tenant header', () =>
  auth(bearer({ role: 'superadmin', tid: null as unknown as string }), { 'x-tenant-id': TENANT_B }),
);
add('authenticate staff tenant header ignored', () => auth(bearer(), { 'x-tenant-id': TENANT_B }));
add('authenticate demo iframe token', () => auth(bearer({ sub: LEARNER, role: 'learner', session_mode: 'demo_iframe' })));
add('authenticate blacklisted user', async t => {
  const normal = bearer({ sub: BLACK_USER });
  const demo = bearer({ sub: BLACK_USER, session_mode: 'demo_iframe' });
  t.mock.timers.tick(2_000);
  blacklistUser(BLACK_USER, 'demo_iframe');
  const afterDemoScope = { normal: await auth(normal), demo: await auth(demo) };
  blacklistUser(BLACK_USER);
  const afterAll = { normal: await auth(normal), fresh: await auth(bearer({ sub: BLACK_USER })) };
  return { afterDemoScope, afterAll, optional: await optional(normal) };
});
add('optional auth', () => optional(bearer()));
add('optional auth without token', () => optional());
add('optional auth malformed token', () => optional('Bearer nope'));
add('optional auth revoked', () => optional(bearer()), revokedAt('password_changed', new Date(NOW + 5_000)));
add('optional auth superadmin tenant header', () =>
  optional(bearer({ role: 'superadmin', tid: null as unknown as string }), { 'x-tenant-id': TENANT_B }),
);

// ── Durable revocation and its Redis mirror ──
add('record session revocation', () => settle(() => revocation.recordUserSessionRevocation(USER, 'password_reset_by_admin')));
add('cleanup expired tokens and revocations', async () => ({
  tokens: await settle(() => authService.cleanupExpiredTokens()),
  revocations: await settle(() => revocation.cleanupExpiredAuthRevocations()),
  revocationsLimited: await settle(() => revocation.cleanupExpiredAuthRevocations(5)),
}), rowsWhen([/^\s*DELETE FROM refresh_tokens/, [{}, {}, {}]], [/WITH doomed AS/, [{}, {}]]));
add(
  'revocation mirror in redis',
  async () => {
    const values = new Map<string, string>();
    let failReads = false;
    const client = {
      isOpen: true,
      isReady: true,
      async get(key: string) {
        redisCalls.push(['get', key]);
        if (failReads) throw new Error('ECONNRESET');
        return values.get(key) ?? null;
      },
      async set(key: string, value: string, options: unknown) {
        redisCalls.push(['set', key, value, options]);
        values.set(key, value);
        return 'OK';
      },
      async del(key: string) {
        redisCalls.push(['del', key]);
        return values.delete(key) ? 1 : 0;
      },
    };
    redis.installRedisClient(client as unknown as RedisClientType);
    try {
      const iat = Math.floor(NOW / 1000);
      const steps: Record<string, unknown> = {};
      steps.untrusted = await revocation.isAccessTokenRevoked(USER, iat);
      steps.resync = await revocation.resyncAccessRevocationMirror();
      steps.trusted = revocation.isAccessRevocationMirrorTrusted();
      steps.fromRedis = await revocation.isAccessTokenRevoked(USER, iat);
      values.set(`auth:revoked:${LEARNER}`, '1');
      steps.full = await revocation.isAccessTokenRevoked(LEARNER, iat);
      values.set(`auth:revoked:${OTHER_USER}`, 'not-a-number');
      steps.unreadable = await revocation.isAccessTokenRevoked(OTHER_USER, iat);
      steps.absent = await revocation.isAccessTokenRevoked(DEMO_LEARNER, iat);
      steps.sync = await settle(() => revocation.syncUserAccessRevocationCache(USER));
      steps.cache = await settle(() => revocation.cacheUserAccessRevocation(LEARNER, new Date(NOW + 3_600_000)));
      steps.probe = await settle(() => revocation.assertAuthRevocationRedisReady());
      failReads = true;
      steps.readFails = await revocation.isAccessTokenRevoked(USER, iat);
      return steps;
    } finally {
      redis.installRedisClient(null);
    }
  },
  rowsWhen([
    /FROM auth_revocations/,
    [{ user_id: USER, reason: 'password_changed', revoked_at: ago(1_000), expires_at: new Date(NOW + 86_400_000) }],
  ]),
);

runCharacterization(cases, {
  label: 'auth characterization',
  goldenPath: path.join(path.dirname(fileURLToPath(import.meta.url)), 'auth-sql.characterization.golden.json'),
  envPrefix: 'AUTH_SQL',
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
  transform: text => (knownTokens.has(text) ? `<sha256 "${knownTokens.get(text)}">` : text),
  records: () => ({ bcrypt: [...bcryptCalls], redis: [...redisCalls] }),
  reset: () => {
    bcryptCalls.length = 0;
    redisCalls.length = 0;
  },
});
