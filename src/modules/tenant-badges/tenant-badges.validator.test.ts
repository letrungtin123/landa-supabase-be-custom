import assert from 'node:assert/strict';
import test from 'node:test';
import { selectableCoursesQuerySchema } from './tenant-badges.validator.js';

// The selectable course query schema never rejects: what the service read
// before is what it reads now, keys it does not read are dropped.

test('the selectable course query keeps the raw values the service reads', () => {
  const odd = { page: ['1', '2'], page_size: 'x', search: { a: 1 }, other: 'dropped' };
  assert.deepStrictEqual(selectableCoursesQuerySchema.parse(odd), { page: ['1', '2'], page_size: 'x', search: { a: 1 } });
  assert.deepStrictEqual(selectableCoursesQuerySchema.parse({}), {});
});
