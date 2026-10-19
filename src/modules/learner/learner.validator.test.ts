import assert from 'node:assert/strict';
import test from 'node:test';

// The learner query schemas coerce the query string the way the controller
// always read it and never reject a request. (The HTTP answers themselves are
// pinned by learner-sql.characterization.test.ts.)

const validator = await import('./learner.validator.js');

const SCHEMAS = [
  validator.learnerCoursesQuerySchema,
  validator.learnerLibraryDocumentsQuerySchema,
  validator.learnerNotificationsQuerySchema,
  validator.learnerBatchProgressQuerySchema,
];
const KEYS = ['search', 'category_id', 'page', 'page_size', 'category', 'extension', 'ordering', 'courseIds'];

test('no query string is ever rejected', () => {
  for (const schema of SCHEMAS) {
    for (const value of ['', 'x', '0', '-1', ['a', 'b'], { a: 1 }, undefined]) {
      assert.equal(schema.safeParse(Object.fromEntries(KEYS.map(key => [key, value]))).success, true);
    }
  }
});

test('pages read as parseInt of the raw value, absent when empty or not a number', () => {
  const schema = validator.learnerNotificationsQuerySchema;
  const empty = schema.parse({});
  assert.equal(empty.page, undefined);
  assert.equal(empty.page_size, undefined);
  assert.deepEqual(schema.parse({ page: '2.7', page_size: ['5', '6'] }), { page: 2, page_size: 5 });
  assert.equal(schema.parse({ page: '' }).page, undefined);
  assert.equal(schema.parse({ page: '0' }).page, 0);
  // Not a number: absent, so the service default applies (it read as NaN, a NaN OFFSET and a 500).
  assert.equal(schema.parse({ page: 'abc' }).page, undefined);
  assert.equal(schema.parse({ page_size: 'y' }).page_size, undefined);
});

test('text filters pass through unchanged', () => {
  const query = validator.learnerLibraryDocumentsQuerySchema.parse({ search: ' hợp đồng ', category: ['a', 'b'] });
  assert.equal(query.search, ' hợp đồng ');
  assert.deepEqual(query.category, ['a', 'b'], 'a repeated parameter keeps its old reading');
});
