import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { CHARACTERIZATION_NOW as NOW, installDb } from '../../test-support/auth-sql-characterization.js';

// A one-time token (cross-app sign-in) is exchanged for a session with the
// same checks and the same session context as the other sign-ins that issue a
// session for a known user (issueSessionForUserId): a disabled organization
// and a learner account locked for the demo iframe are refused; learner_plus
// gets its member groups. No database: a pg double answers every statement.

process.env.REDIS_URL = 'redis://127.0.0.1:1';

const redis = await import('../../config/redis.js');
const { pool } = await import('../../config/database.js');
const authService = await import('./auth.service.js');

redis.installRedisClient(null);

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = 'a0000000-0000-4000-8000-000000000001';
const ORG = 'e0000000-0000-4000-8000-000000000001';
const USER_ROW = {
  id: USER,
  username: 'staff01',
  email: 'staff01@example.test',
  full_name: 'Nhân viên A',
  phone: null,
  avatar_url: null,
  role: 'staff',
  is_active: true,
  tenant_id: TENANT,
  tenant_name: 'Công ty A',
  tenant_active: true,
};

async function exchange(t: TestContext, user: Record<string, unknown>, demoLocked = false) {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const statements = installDb(t, pool, text => {
    if (/FROM users u/.test(text)) return [{ ...USER_ROW, ...user }];
    if (/tenant_demo_iframe_settings/.test(text)) return demoLocked ? [{ exists: true }] : [];
    if (/FROM team_members/.test(text)) return [{ id: ORG, name: 'Khối A' }];
    return [];
  });
  const token = await authService.generateOTT(USER);
  try {
    return { session: await authService.exchangeOTT(token), statements };
  } catch (error) {
    const { message, statusCode } = error as { message: string; statusCode?: number };
    return { refused: { message, statusCode }, statements };
  }
}

const sessionWrites = (statements: Array<{ text: string }>) =>
  statements.filter(statement => /INSERT INTO refresh_tokens/.test(statement.text)).length;

test('one-time token: a user of a disabled organization is refused, as at every other sign-in', async t => {
  const result = await exchange(t, { tenant_active: false });
  assert.deepEqual(result.refused, { message: 'Tổ chức đã bị vô hiệu hóa', statusCode: 403 });
  assert.equal(sessionWrites(result.statements), 0);
});

test('one-time token: a learner account locked for the demo iframe is refused', async t => {
  const result = await exchange(t, { role: 'learner' }, true);
  assert.deepEqual(result.refused, { message: 'Tài khoản đang được khóa cho demo iframe', statusCode: 403 });
  assert.equal(sessionWrites(result.statements), 0);
});

test('one-time token: learner_plus gets its member groups; staff gets none', async t => {
  const learnerPlus = await exchange(t, { role: 'learner_plus' });
  assert.deepEqual(learnerPlus.session?.member_groups, [{ id: ORG, name: 'Khối A' }]);
  assert.equal(learnerPlus.session?.session_mode, 'normal');
  assert.equal(sessionWrites(learnerPlus.statements), 1);
  t.mock.restoreAll();
  t.mock.timers.reset();

  const staff = await exchange(t, {});
  assert.deepEqual(staff.session?.member_groups, []);
  assert.equal(staff.session?.user.id, USER);
});

test('one-time token: a superadmin is not refused for a disabled tenant; last sign-in time is not written', async t => {
  const result = await exchange(t, { role: 'superadmin', tenant_active: false });
  assert.equal(result.session?.user.role, 'superadmin');
  assert.equal(result.statements.filter(statement => /last_login_at/.test(statement.text)).length, 0);
});
