import assert from 'node:assert/strict';
import test from 'node:test';
import {
  libraryCategoriesQuerySchema,
  libraryDocumentsQuerySchema,
  libraryPublicImpactQuerySchema,
} from './library.validator.js';

// The library query schemas never reject: what the service read before is
// what it reads now, keys it does not read are dropped.

const ODD = { page: ['1', '2'], page_size: 'x', search: { a: 1 }, assigned_team_id: [' t '], category_id: 7, extension: '', other: 1 };

test('the category list query keeps the raw values the service reads', () => {
  assert.deepStrictEqual(libraryCategoriesQuerySchema.parse(ODD), {
    page: ['1', '2'],
    page_size: 'x',
    search: { a: 1 },
    assigned_team_id: [' t '],
  });
});

test('the document list query keeps the raw values the service reads', () => {
  assert.deepStrictEqual(libraryDocumentsQuerySchema.parse(ODD), {
    page: ['1', '2'],
    page_size: 'x',
    search: { a: 1 },
    category_id: 7,
    extension: '',
  });
});

test('the public impact limit is read as Number() of a present value, as before', () => {
  assert.equal(libraryPublicImpactQuerySchema.parse({ limit: '5' }).limit, 5);
  assert.equal(libraryPublicImpactQuerySchema.parse({ limit: '' }).limit, undefined);
  assert.equal(libraryPublicImpactQuerySchema.parse({}).limit, undefined);
  assert.ok(Number.isNaN(libraryPublicImpactQuerySchema.parse({ limit: 'abc' }).limit));
  assert.ok(Number.isNaN(libraryPublicImpactQuerySchema.parse({ limit: ['1', '2'] }).limit));
  assert.equal(libraryPublicImpactQuerySchema.parse({ limit: ['7'] }).limit, 7);
});
