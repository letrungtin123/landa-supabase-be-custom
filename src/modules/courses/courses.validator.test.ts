import assert from 'node:assert/strict';
import test from 'node:test';
import {
  courseListQuerySchema,
  mentorCandidatesQuerySchema,
  mentorHistoryQuerySchema,
  sectionModalQuerySchema,
} from './courses.validator.js';

// The course query schemas never reject: what the services read before is
// what they read now, keys they do not read are dropped.

const ODD = { page: ['1', '2'], page_size: 'x', search: { a: 1 }, visibility: 7, date_from: '', date_to: ['a'], section_id: ['s1', 's2'], other: 'dropped' };

test('the course list query keeps the raw values the service reads', () => {
  assert.deepStrictEqual(courseListQuerySchema.parse(ODD), { page: ['1', '2'], page_size: 'x', search: { a: 1 }, visibility: 7 });
  assert.deepStrictEqual(courseListQuerySchema.parse({}), {});
});

test('the mentor candidate and history queries keep their raw values', () => {
  assert.deepStrictEqual(mentorCandidatesQuerySchema.parse(ODD), { page: ['1', '2'], page_size: 'x', search: { a: 1 } });
  assert.deepStrictEqual(mentorHistoryQuerySchema.parse(ODD), {
    page: ['1', '2'],
    page_size: 'x',
    search: { a: 1 },
    date_from: '',
    date_to: ['a'],
  });
});

test('the section modal query keeps section_id as sent, absent stays undefined', () => {
  assert.deepStrictEqual(sectionModalQuerySchema.parse(ODD).section_id, ['s1', 's2']);
  assert.equal(sectionModalQuerySchema.parse({}).section_id, undefined);
});
