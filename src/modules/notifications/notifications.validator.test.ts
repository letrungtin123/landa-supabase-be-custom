import assert from 'node:assert/strict';
import test from 'node:test';
import { notificationListQuerySchema } from './notifications.validator.js';

// The notification list query schema never rejects: what the service read
// before is what it reads now, keys it does not read are dropped.

test('the notification list query keeps the raw values the service reads', () => {
  const odd = { page: ['1', '2'], page_size: 'x', search: { a: 1 }, course_id: [' c '], other: 'dropped' };
  const { other: _other, ...kept } = odd;
  assert.deepStrictEqual(notificationListQuerySchema.parse(odd), kept);
  assert.deepStrictEqual(notificationListQuerySchema.parse({}), {});
});
