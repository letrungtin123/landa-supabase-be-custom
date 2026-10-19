import assert from 'node:assert/strict';
import test from 'node:test';
import { courseCategoryListQuerySchema, publicImpactQuerySchema } from './course-categories.validator.js';

// The course category query schemas never reject: what was read before is
// what is read now, keys nobody reads are dropped and absent keys stay
// absent (the list answers every category when none of its keys is sent).

test('the course category list query keeps the raw values the service reads', () => {
  const odd = { page: ['1', '2'], page_size: 'x', search: { a: 1 }, assigned_team_id: [' t '], other: 'dropped' };
  const { other: _other, ...kept } = odd;
  assert.deepStrictEqual(courseCategoryListQuerySchema.parse(odd), kept);
  const none = courseCategoryListQuerySchema.parse({ other: 'x' });
  assert.deepStrictEqual(none, {});
  assert.equal('page' in none, false);
});

test('the public impact query keeps limit as sent', () => {
  assert.deepStrictEqual(publicImpactQuerySchema.parse({ limit: ['5'], other: 1 }), { limit: ['5'] });
  assert.equal(publicImpactQuerySchema.parse({}).limit, undefined);
});
