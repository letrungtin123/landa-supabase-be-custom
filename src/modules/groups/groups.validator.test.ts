import assert from 'node:assert/strict';
import test from 'node:test';
import { groupAuditLogsQuerySchema, groupPageQuerySchema, groupSearchQuerySchema } from './groups.validator.js';

// The group query schemas never reject: what the service read before is what
// it reads now, keys it does not read are dropped.

const ODD = { page: ['1', '2'], page_size: 'x', search: { a: 1 }, action: 7, date_from: '', date_to: ['a'], other: 'dropped' };

test('the page query keeps the raw values the service reads', () => {
  assert.deepStrictEqual(groupPageQuerySchema.parse(ODD), { page: ['1', '2'], page_size: 'x', search: { a: 1 } });
  assert.deepStrictEqual(groupPageQuerySchema.parse({}), {});
});

test('the search query keeps only search, as sent', () => {
  assert.deepStrictEqual(groupSearchQuerySchema.parse(ODD), { search: { a: 1 } });
});

test('the audit log query keeps its raw values', () => {
  assert.deepStrictEqual(groupAuditLogsQuerySchema.parse(ODD), {
    page: ['1', '2'],
    page_size: 'x',
    search: { a: 1 },
    action: 7,
    date_from: '',
    date_to: ['a'],
  });
});
