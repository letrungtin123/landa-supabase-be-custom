import assert from 'node:assert/strict';
import test from 'node:test';
import {
  USER_AUTHORITY_ERRORS,
  USER_ROLES,
  UserAuthorityError,
  assertCanCreateUser,
  assertCanDeleteUser,
  assertCanUpdateUser,
  assignableUserRoles,
  checkAssignPermissionGroup,
  checkCreateUser,
  checkDeleteUser,
  checkManageTarget,
  checkUpdateUser,
  removesActiveSuperadmin,
  requestUiLocale,
  type UserAuthorityActor,
  type UserAuthorityTarget,
} from './user-authority.logic.js';
import type { UserRole } from '../../types/index.js';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const ACTOR_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TARGET_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function actor(role: UserRole, tenantId: string | null = TENANT_A): UserAuthorityActor {
  return { id: ACTOR_ID, role, tenantId };
}

function target(role: UserRole, overrides: Partial<UserAuthorityTarget> = {}): UserAuthorityTarget {
  return { id: TARGET_ID, role, tenantId: TENANT_A, isActive: true, ...overrides };
}

/** Who may manage (edit / status / password / delete) another account of a role, same tenant. */
const MANAGE_MATRIX: Record<UserRole, Record<UserRole, boolean>> = {
  superadmin: { superadmin: true, superuser: true, staff: true, learner_plus: true, learner: true },
  superuser: { superadmin: false, superuser: false, staff: true, learner_plus: true, learner: true },
  staff: { superadmin: false, superuser: false, staff: false, learner_plus: true, learner: true },
  learner_plus: { superadmin: false, superuser: false, staff: false, learner_plus: false, learner: false },
  learner: { superadmin: false, superuser: false, staff: false, learner_plus: false, learner: false },
};

const ASSIGNABLE: Record<UserRole, UserRole[]> = {
  superadmin: ['learner', 'learner_plus', 'staff', 'superuser', 'superadmin'],
  superuser: ['learner', 'learner_plus', 'staff'],
  staff: ['learner', 'learner_plus'],
  learner_plus: [],
  learner: [],
};

test('every authority error has a 4xx status and distinct vi/en copy', () => {
  for (const [code, [status, vi, en]] of Object.entries(USER_AUTHORITY_ERRORS) as [string, readonly [number, string, string]][]) {
    assert.ok(status === 403 || status === 409, code);
    assert.ok(vi.trim() && en.trim() && vi !== en, code);
  }
  const error = new UserAuthorityError('SELF_DELETE');
  assert.equal(error.statusCode, 403);
  assert.equal(error.code, 'USER_AUTHORITY_SELF_DELETE');
  assert.equal(error.localizedMessage('en'), 'You cannot delete your own account.');
  assert.equal(error.localizedMessage('vi'), error.message);
  assert.equal(requestUiLocale(' EN '), 'en');
  assert.equal(requestUiLocale(undefined), 'vi');
});

test('assignable roles are strictly below the actor level; only superadmin assigns superadmin', () => {
  for (const role of USER_ROLES) {
    assert.deepEqual(assignableUserRoles(role).sort(), [...ASSIGNABLE[role]].sort(), role);
  }
  assert.deepEqual(assignableUserRoles('unknown-role'), []);
});

test('manage matrix: actor role x target role inside one tenant', () => {
  for (const actorRole of USER_ROLES) {
    for (const targetRole of USER_ROLES) {
      const error = checkManageTarget(actor(actorRole), target(targetRole));
      assert.equal(error === null, MANAGE_MATRIX[actorRole][targetRole], `${actorRole} -> ${targetRole}: ${error}`);
      // update (no role change), deactivate, activate and delete follow the same matrix
      const others = actorRole === 'superadmin' && targetRole === 'superadmin' ? 2 : undefined;
      assert.equal(checkUpdateUser(actor(actorRole), target(targetRole), { password: true }, others) === null, MANAGE_MATRIX[actorRole][targetRole]);
      assert.equal(checkUpdateUser(actor(actorRole), target(targetRole), { isActive: false }, others) === null, MANAGE_MATRIX[actorRole][targetRole]);
      assert.equal(checkUpdateUser(actor(actorRole), target(targetRole, { isActive: false }), { isActive: true }) === null, MANAGE_MATRIX[actorRole][targetRole]);
      assert.equal(checkDeleteUser(actor(actorRole), target(targetRole), others) === null, MANAGE_MATRIX[actorRole][targetRole]);
    }
  }
});

test('superadmin accounts answer SUPERADMIN_ONLY to every non-superadmin', () => {
  for (const actorRole of ['superuser', 'staff', 'learner_plus', 'learner'] as const) {
    assert.equal(checkManageTarget(actor(actorRole), target('superadmin')), 'SUPERADMIN_ONLY');
    assert.equal(checkDeleteUser(actor(actorRole), target('superadmin')), 'SUPERADMIN_ONLY');
    assert.equal(checkUpdateUser(actor(actorRole), target('learner'), { role: 'superadmin' }),
      MANAGE_MATRIX[actorRole].learner ? 'SUPERADMIN_ONLY' : 'TARGET_NOT_MANAGEABLE');
    assert.deepEqual(checkCreateUser(actor(actorRole), { role: 'superadmin' }), { error: 'SUPERADMIN_ONLY' });
  }
});

test('role changes: a manageable target can only receive an assignable role', () => {
  // Privilege escalation of another account.
  assert.equal(checkUpdateUser(actor('staff'), target('learner'), { role: 'staff' }), 'ROLE_NOT_ASSIGNABLE');
  assert.equal(checkUpdateUser(actor('staff'), target('learner'), { role: 'superuser' }), 'ROLE_NOT_ASSIGNABLE');
  assert.equal(checkUpdateUser(actor('superuser'), target('staff'), { role: 'superuser' }), 'ROLE_NOT_ASSIGNABLE');
  assert.equal(checkUpdateUser(actor('staff'), target('learner'), { role: 'learner_plus' }), null);
  assert.equal(checkUpdateUser(actor('superuser'), target('learner'), { role: 'staff' }), null);
  assert.equal(checkUpdateUser(actor('superuser'), target('staff'), { role: 'learner' }), null);
  // Resending the current role (the edit form always sends it) is not a change.
  assert.equal(checkUpdateUser(actor('staff'), target('learner_plus'), { role: 'learner_plus', isActive: true }), null);
  // A superuser may not demote another superuser: it cannot manage that account at all.
  assert.equal(checkUpdateUser(actor('superuser'), target('superuser'), { role: 'staff' }), 'TARGET_NOT_MANAGEABLE');
  assert.equal(checkUpdateUser(actor('superadmin'), target('staff'), { role: 'superadmin' }), null);
  assert.equal(checkUpdateUser(actor('superadmin'), target('staff'), { role: 'not-a-role' }), 'ROLE_NOT_ASSIGNABLE');
});

test('self: role, status and password are refused; other own fields stay editable for every role', () => {
  for (const role of USER_ROLES) {
    const self = { ...target(role), id: ACTOR_ID };
    assert.equal(checkUpdateUser(actor(role), self, { role: role === 'superadmin' ? 'superuser' : 'superadmin' }), 'SELF_ROLE_CHANGE', role);
    assert.equal(checkUpdateUser(actor(role), self, { isActive: false }), 'SELF_STATUS_CHANGE', role);
    assert.equal(checkUpdateUser(actor(role), self, { password: true }), 'SELF_PASSWORD_CHANGE', role);
    assert.equal(checkDeleteUser(actor(role), self, 5), 'SELF_DELETE', role);
    // The admin edit form resends the unchanged role and status with a name/email edit.
    assert.equal(checkUpdateUser(actor(role), self, { role, isActive: true }), null, role);
    assert.equal(checkUpdateUser(actor(role), self, {}), null, role);
  }
  // Self escalation (the reported staff -> superadmin case).
  assert.equal(checkUpdateUser(actor('staff'), { ...target('staff'), id: ACTOR_ID }, { role: 'superadmin' }), 'SELF_ROLE_CHANGE');
  // Self deactivation (the reported superuser case).
  assert.throws(() => assertCanUpdateUser(actor('superuser'), { ...target('superuser'), id: ACTOR_ID }, { isActive: false }),
    (error: unknown) => error instanceof UserAuthorityError && error.code === 'USER_AUTHORITY_SELF_STATUS_CHANGE' && error.statusCode === 403);
  assert.throws(() => assertCanDeleteUser(actor('superadmin'), { ...target('superadmin'), id: ACTOR_ID }, 3),
    (error: unknown) => error instanceof UserAuthorityError && error.authorityCode === 'SELF_DELETE');
});

test('tenant scope: non-superadmin manages and creates only inside its own tenant', () => {
  assert.equal(checkManageTarget(actor('superuser'), target('learner', { tenantId: TENANT_B })), 'CROSS_TENANT');
  assert.equal(checkManageTarget(actor('staff'), target('learner', { tenantId: null })), 'CROSS_TENANT');
  assert.equal(checkManageTarget(actor('staff', null), target('learner')), 'TENANT_REQUIRED');
  assert.equal(checkDeleteUser(actor('superuser'), target('staff', { tenantId: TENANT_B })), 'CROSS_TENANT');
  assert.equal(checkManageTarget(actor('superadmin', TENANT_A), target('superuser', { tenantId: TENANT_B })), null);

  assert.deepEqual(checkCreateUser(actor('superuser'), { role: 'staff' }), { tenantId: TENANT_A });
  assert.deepEqual(checkCreateUser(actor('superuser'), { role: 'staff', tenantId: TENANT_A }), { tenantId: TENANT_A });
  assert.deepEqual(checkCreateUser(actor('superuser'), { role: 'staff', tenantId: TENANT_B }), { error: 'CROSS_TENANT' });
  assert.deepEqual(checkCreateUser(actor('staff'), { role: 'learner', tenantId: TENANT_B }), { error: 'CROSS_TENANT' });
  assert.deepEqual(checkCreateUser(actor('staff', null), { role: 'learner' }), { error: 'TENANT_REQUIRED' });
  assert.deepEqual(checkCreateUser(actor('superadmin', TENANT_A), { role: 'staff', tenantId: TENANT_B }), { tenantId: TENANT_B });
  assert.deepEqual(checkCreateUser(actor('superadmin', TENANT_A), { role: 'learner' }), { tenantId: TENANT_A });
  assert.equal(assertCanCreateUser(actor('staff'), { role: 'learner_plus', tenantId: null }), TENANT_A);
});

test('create matrix follows the assignable roles', () => {
  for (const actorRole of USER_ROLES) {
    for (const role of USER_ROLES) {
      const decision = checkCreateUser(actor(actorRole), { role });
      assert.equal('tenantId' in decision, ASSIGNABLE[actorRole].includes(role), `${actorRole} creates ${role}`);
    }
  }
});

test('last active superadmin cannot be deactivated, demoted or deleted', () => {
  const other = target('superadmin');
  assert.equal(removesActiveSuperadmin(other, { isActive: false }), true);
  assert.equal(removesActiveSuperadmin(other, { role: 'superuser' }), true);
  assert.equal(removesActiveSuperadmin(other, { role: 'superadmin', isActive: true }), false);
  assert.equal(removesActiveSuperadmin(other, 'delete'), true);
  assert.equal(removesActiveSuperadmin(target('superadmin', { isActive: false }), 'delete'), false);
  assert.equal(removesActiveSuperadmin(target('superuser'), 'delete'), false);

  assert.equal(checkUpdateUser(actor('superadmin'), other, { isActive: false }, 1), 'LAST_SUPERADMIN');
  assert.equal(checkUpdateUser(actor('superadmin'), other, { role: 'staff' }, 1), 'LAST_SUPERADMIN');
  assert.equal(checkDeleteUser(actor('superadmin'), other, 1), 'LAST_SUPERADMIN');
  // Missing count fails closed.
  assert.equal(checkUpdateUser(actor('superadmin'), other, { isActive: false }), 'LAST_SUPERADMIN');
  assert.equal(checkDeleteUser(actor('superadmin'), other), 'LAST_SUPERADMIN');
  // With another active superadmin the same writes are allowed.
  assert.equal(checkUpdateUser(actor('superadmin'), other, { isActive: false }, 2), null);
  assert.equal(checkUpdateUser(actor('superadmin'), other, { role: 'superuser' }, 2), null);
  assert.equal(checkDeleteUser(actor('superadmin'), other, 2), null);
  // An inactive superadmin can be deleted or kept inactive without a count.
  assert.equal(checkDeleteUser(actor('superadmin'), target('superadmin', { isActive: false })), null);
  assert.equal(checkUpdateUser(actor('superadmin'), other, { role: 'superadmin', isActive: true }), null);
});

test('permission-group membership: superuser/superadmin only, never self, only manageable targets', () => {
  const groupMatrix: Record<UserRole, Record<UserRole, boolean>> = {
    superadmin: { superadmin: true, superuser: true, staff: true, learner_plus: true, learner: true },
    superuser: { superadmin: false, superuser: false, staff: true, learner_plus: true, learner: true },
    staff: { superadmin: false, superuser: false, staff: false, learner_plus: false, learner: false },
    learner_plus: { superadmin: false, superuser: false, staff: false, learner_plus: false, learner: false },
    learner: { superadmin: false, superuser: false, staff: false, learner_plus: false, learner: false },
  };
  for (const actorRole of USER_ROLES) {
    for (const targetRole of USER_ROLES) {
      assert.equal(checkAssignPermissionGroup(actor(actorRole), target(targetRole)) === null,
        groupMatrix[actorRole][targetRole], `${actorRole} -> ${targetRole}`);
    }
    assert.equal(checkAssignPermissionGroup(actor(actorRole), { ...target(actorRole), id: ACTOR_ID }), 'SELF_PERMISSION_GROUP_CHANGE');
  }
  assert.equal(checkAssignPermissionGroup(actor('superuser'), target('staff', { tenantId: TENANT_B })), 'CROSS_TENANT');
  assert.equal(checkAssignPermissionGroup(actor('superadmin'), target('staff', { tenantId: TENANT_B })), null);
});
