import assert from 'node:assert/strict';
import test from 'node:test';
import { submissionListQuerySchema } from './assignments.validator.js';

// The submission list query schema never rejects: what the service read
// before is what it reads now, keys it does not read are dropped.

test('the submission list query keeps the raw values the service reads', () => {
  const odd = { page: ['1', '2'], page_size: 'x', search: { a: 1 }, status: 7, assignment_id: ['a'], other: 'dropped' };
  const { other: _other, ...kept } = odd;
  assert.deepStrictEqual(submissionListQuerySchema.parse(odd), kept);
  assert.deepStrictEqual(submissionListQuerySchema.parse({}), {});
});
