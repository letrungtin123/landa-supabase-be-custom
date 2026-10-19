import assert from 'node:assert/strict';
import test from 'node:test';
import {
  courseEnrollmentsQuerySchema,
  studyTimeQuerySchema,
  userEnrollmentsQuerySchema,
} from './enrollments.validator.js';

// The enrollment query schemas never reject: what the controller read before
// is what it reads now, keys it does not read are dropped.

const ODD = { page: ['1', '2'], page_size: 'x', search: { a: 1 }, status: 7, from: '', to: ['a'], granularity: 'week', other: 'dropped' };

test('the study time query keeps the raw values the controller reads', () => {
  assert.deepStrictEqual(studyTimeQuerySchema.parse(ODD), { from: '', to: ['a'], granularity: 'week' });
  assert.deepStrictEqual(studyTimeQuerySchema.parse({}), {});
});

test('the enrollment list queries keep their raw values', () => {
  assert.deepStrictEqual(userEnrollmentsQuerySchema.parse(ODD), { page: ['1', '2'], page_size: 'x', search: { a: 1 } });
  assert.deepStrictEqual(courseEnrollmentsQuerySchema.parse(ODD), {
    page: ['1', '2'],
    page_size: 'x',
    search: { a: 1 },
    status: 7,
  });
});
