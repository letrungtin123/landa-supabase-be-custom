import assert from 'node:assert/strict';
import test from 'node:test';
import { userListQuerySchema } from './users.validator.js';

// The user list query schema never rejects: what listUsers read before is
// what it reads now, keys it does not read are dropped.

test('the user list query keeps the raw values the service reads', () => {
  const odd = {
    page: ['1', '2'],
    page_size: 'x',
    search: { a: 1 },
    role: ['staff'],
    is_active: 'maybe',
    permission_group_id: 7,
    include_team_assignments: true,
    current_team_id: ' t ',
    other: 'dropped',
  };
  const { other: _other, ...kept } = odd;
  assert.deepStrictEqual(userListQuerySchema.parse(odd), kept);
  assert.deepStrictEqual(userListQuerySchema.parse({}), {});
});
