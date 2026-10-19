import assert from 'node:assert/strict';
import test from 'node:test';

// The reports query schemas coerce the query string the way the controller
// always read it and never reject a request: odd values read as the old
// defaults. (The HTTP answers themselves are pinned by
// reports-sql.characterization.test.ts.)

const validator = await import('./reports.validator.js');

const SCHEMAS = {
  summary: validator.reportSummaryQuerySchema,
  chart: validator.reportChartQuerySchema,
  topCourses: validator.reportTopCoursesQuerySchema,
  ranking: validator.reportCourseRankingQuerySchema,
  courseLearners: validator.reportCourseLearnersQuerySchema,
  learners: validator.reportLearnersQuerySchema,
  export: validator.reportExportQuerySchema,
  learnerDetail: validator.reportLearnerDetailQuerySchema,
  badges: validator.reportUserBadgesQuerySchema,
  studyTime: validator.reportUserStudyTimeQuerySchema,
};

const ODD_VALUES: unknown[] = ['', '  ', 'abc', '-3', '0', '1e3', '2.5', ['1', '2'], [], { a: '1' }, undefined];
const KEYS = [
  'month', 'year', 'date_from', 'date_to', 'group_id', 'subgroup_id', 'team_id', 'page', 'page_size', 'search',
  'status', 'metric', 'group_by_org', 'grouped', 'granularity', 'mode', 'direction', 'anchor_bucket',
  'limit_buckets', 'series_limit', 'locale', 'username', 'data_scope', 'from', 'to',
];

test('no query string is ever rejected', () => {
  for (const [name, schema] of Object.entries(SCHEMAS)) {
    for (const value of ODD_VALUES) {
      const query = Object.fromEntries(KEYS.map(key => [key, value]));
      assert.equal(schema.safeParse(query).success, true, `${name} with ${JSON.stringify(value)}`);
    }
    assert.equal(schema.safeParse({}).success, true, `${name} with no parameter`);
  }
});

test('pages and page sizes read as before', () => {
  const ranking = validator.reportCourseRankingQuerySchema;
  assert.deepEqual(pick(ranking.parse({}), ['page', 'page_size']), { page: 1, page_size: 10 });
  assert.deepEqual(pick(ranking.parse({ page: '-4', page_size: '1000' }), ['page', 'page_size']), { page: 1, page_size: 100 });
  assert.deepEqual(pick(ranking.parse({ page: '2.9', page_size: ['5', '6'] }), ['page', 'page_size']), { page: 2, page_size: 5 });

  const top = validator.reportTopCoursesQuerySchema;
  // Top courses: a negative page or size reads as the default (its service
  // does not clamp, so it used to reach LIMIT / OFFSET).
  assert.deepEqual(pick(top.parse({ page: '-4', page_size: '-9' }), ['page', 'page_size']), { page: 1, page_size: 10 });
  assert.deepEqual(pick(top.parse({ page: 'x', page_size: '0' }), ['page', 'page_size']), { page: 1, page_size: 10 });
  assert.deepEqual(pick(top.parse({ page: '3', page_size: '1000' }), ['page', 'page_size']), { page: 3, page_size: 100 });
  // The learners list keeps no lower bound here: its service clamps to 1.
  const learners = validator.reportLearnersQuerySchema;
  assert.deepEqual(pick(learners.parse({ page: '-4', page_size: '-9' }), ['page', 'page_size']), { page: -4, page_size: -9 });
});

test('period, scope and filters read as before', () => {
  const query = validator.reportCourseLearnersQuerySchema.parse({
    month: '0', year: 'abc', date_from: ' 2025-03-01 ', group_id: ' all ', subgroup_id: ' b1 ', status: 'bogus', search: ['a', 'b'],
  });
  assert.equal(query.month, 0);
  assert.ok(Number.isNaN(query.year));
  assert.equal(query.date_from, '2025-03-01');
  assert.equal(query.date_to, undefined);
  assert.equal(query.group_id, undefined);
  assert.equal(query.subgroup_id, 'b1');
  assert.equal(query.status, 'all');
  assert.deepEqual(query.search, ['a', 'b'], 'a repeated search stays a list, as before');

  const chart = validator.reportChartQuerySchema.parse({ grouped: 'no', group_by_org: 'TRUE', direction: '', limit_buckets: '0' });
  assert.equal(chart.grouped, true);
  assert.equal(chart.group_by_org, false);
  assert.equal(chart.direction, '');
  assert.equal(chart.limit_buckets, undefined);
  assert.equal(chart.metric, 'total_enrollments');
  assert.equal(chart.granularity, 'auto');
  assert.equal(chart.mode, 'range');

  const learners = validator.reportLearnersQuerySchema.parse({ status: ' learning ' });
  assert.deepEqual(learners.status, { present: true, value: ' learning ' });
  assert.equal(validator.reportLearnersQuerySchema.parse({ status: ['all'] }).status.present, false);
});

function pick<T extends object, K extends keyof T>(value: T, keys: K[]): Pick<T, K> {
  return Object.fromEntries(keys.map(key => [key, value[key]])) as Pick<T, K>;
}
