import assert from 'node:assert/strict';
import test from 'node:test';
import {
  criteriaRequiresCourses,
  minimumMappedCourses,
  parseBadgeCriteria,
} from './badge-criteria.js';

test('parseBadgeCriteria accepts supported versioned criteria', () => {
  assert.deepEqual(parseBadgeCriteria({
    version: 1,
    type: 'completed_selected_courses',
    threshold: 2,
    requires_courses: true,
  }), {
    version: 1,
    type: 'completed_selected_courses',
    threshold: 2,
    requires_courses: true,
  });

  assert.deepEqual(parseBadgeCriteria({
    version: 1,
    type: 'completion_within_minutes',
    minutes: 1440,
  }), {
    version: 1,
    type: 'completion_within_minutes',
    minutes: 1440,
  });
});

test('parseBadgeCriteria rejects invalid thresholds and unsupported payloads', () => {
  const invalidCriteria = [
    { version: 2, type: 'completed_any_courses', threshold: 1 },
    { version: 1, type: 'completed_any_courses', threshold: 0 },
    { version: 1, type: 'completed_selected_courses', threshold: 1, requires_courses: false },
    { version: 1, type: 'completed_selected_plus_other', selected_threshold: 1, other_threshold: -1, requires_courses: true },
    { version: 1, type: 'profile_any', profile_fields: [] },
    { version: 1, type: 'completion_within_minutes', minutes: 1441 },
    { version: 1, type: 'unknown' },
  ];

  for (const criteria of invalidCriteria) {
    assert.equal(parseBadgeCriteria(criteria), null);
  }
});

test('course requirements expose the exact minimum mapping threshold', () => {
  const selected = parseBadgeCriteria({
    version: 1,
    type: 'completed_selected_courses',
    threshold: 3,
    requires_courses: true,
  });
  const selectedPlusOther = parseBadgeCriteria({
    version: 1,
    type: 'completed_selected_plus_other',
    selected_threshold: 2,
    other_threshold: 4,
    requires_courses: true,
  });
  const anyCourse = parseBadgeCriteria({
    version: 1,
    type: 'completed_any_courses',
    threshold: 5,
  });

  assert.ok(selected);
  assert.ok(selectedPlusOther);
  assert.ok(anyCourse);
  assert.equal(criteriaRequiresCourses(selected), true);
  assert.equal(minimumMappedCourses(selected), 3);
  assert.equal(criteriaRequiresCourses(selectedPlusOther), true);
  assert.equal(minimumMappedCourses(selectedPlusOther), 2);
  assert.equal(criteriaRequiresCourses(anyCourse), false);
  assert.equal(minimumMappedCourses(anyCourse), 0);
});
