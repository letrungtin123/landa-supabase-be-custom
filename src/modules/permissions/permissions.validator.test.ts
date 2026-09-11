import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addPermissionGroupMembersSchema,
  savePermGroupConfigurationSchema,
  updatePermissionsMatrixSchema,
} from './permissions.validator.js';

const userA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const userB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const modulePermission = {
  module_code: 'courses',
  can_view: true,
  can_add: false,
  can_edit: false,
  can_delete: false,
};

test('permission matrix refuses the protected Permission Groups module', () => {
  const result = updatePermissionsMatrixSchema.safeParse({
    permissions: [{ ...modulePermission, module_code: 'permission_groups' }],
  });
  assert.equal(result.success, false);
});

test('permission matrix refuses duplicate module entries', () => {
  const result = updatePermissionsMatrixSchema.safeParse({
    permissions: [modulePermission, modulePermission],
  });
  assert.equal(result.success, false);
});

test('atomic configuration permits a tenant with no enabled modules', () => {
  const result = savePermGroupConfigurationSchema.safeParse({
    permissions: [],
    add_user_ids: [userA],
    remove_user_ids: [],
  });
  assert.equal(result.success, true);
});

test('atomic configuration refuses duplicate or conflicting members', () => {
  const duplicate = savePermGroupConfigurationSchema.safeParse({
    permissions: [],
    add_user_ids: [userA, userA],
    remove_user_ids: [],
  });
  const conflict = savePermGroupConfigurationSchema.safeParse({
    permissions: [],
    add_user_ids: [userA],
    remove_user_ids: [userA, userB],
  });
  assert.equal(duplicate.success, false);
  assert.equal(conflict.success, false);
});

test('compatibility member endpoint is bounded to one hundred UUIDs', () => {
  const ids = Array.from({ length: 101 }, (_, index) =>
    `${String(index).padStart(8, '0')}-0000-4000-8000-000000000000`,
  );
  assert.equal(addPermissionGroupMembersSchema.safeParse(ids).success, false);
});
