import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildBadgeAwardCandidates,
  evaluateBadgeRule,
  type CompletedCourseFact,
  type EvaluatableBadgeRule,
  type MappedCourse,
} from './badge-evaluation.logic.js';

function mapped(courseId: string | null, isDeleted = false): MappedCourse {
  return { course_id: courseId, course_name: courseId || '', is_deleted: isDeleted };
}

function completed(
  courseId: string,
  enrolledAt = '2026-08-24T00:00:00.000Z',
  completedAt = '2026-08-24T01:00:00.000Z',
): CompletedCourseFact {
  return { course_id: courseId, enrolled_at: enrolledAt, completed_at: completedAt };
}

test('profile_any ignores blank values and accepts a configured profile value', () => {
  const rule: EvaluatableBadgeRule = {
    criteria: { version: 1, type: 'profile_any', profile_fields: ['bio', 'avatar_url'] },
    mapped_courses: [],
  };

  const incomplete = evaluateBadgeRule(rule, [], { bio: '   ', avatar_url: null });
  const complete = evaluateBadgeRule(rule, [], { bio: '', avatar_url: '/avatars/user.png' });

  assert.equal(incomplete.achieved, false);
  assert.deepEqual(incomplete.progress, { current: 0, target: 1, percent: 0, unit_label: 'hồ sơ' });
  assert.equal(complete.achieved, true);
  assert.equal(complete.progress.percent, 100);
});

test('completed_selected_courses counts distinct active mapped courses only', () => {
  const result = evaluateBadgeRule({
    criteria: {
      version: 1,
      type: 'completed_selected_courses',
      threshold: 2,
      requires_courses: true,
    },
    mapped_courses: [mapped('course-a'), mapped('course-b'), mapped('course-deleted', true)],
  }, [
    completed('course-a'),
    completed('course-a'),
    completed('course-b'),
    completed('course-deleted'),
  ], {});

  assert.equal(result.achieved, true);
  assert.deepEqual(result.progress, { current: 2, target: 2, percent: 100, unit_label: 'khóa' });
});

test('selected plus other requires distinct remaining courses without caring about their mapping', () => {
  const rule = {
    criteria: {
      version: 1 as const,
      type: 'completed_selected_plus_other' as const,
      selected_threshold: 2,
      other_threshold: 1,
      requires_courses: true as const,
    },
    mapped_courses: [mapped('course-a'), mapped('course-b'), mapped('course-c')],
  };

  const onlySelected = evaluateBadgeRule(rule, [completed('course-a'), completed('course-b')], {});
  const extraMapped = evaluateBadgeRule(rule, [completed('course-a'), completed('course-b'), completed('course-c')], {});
  const extraUnmapped = evaluateBadgeRule(rule, [completed('course-a'), completed('course-b'), completed('course-x')], {});

  assert.equal(onlySelected.achieved, false);
  assert.deepEqual(onlySelected.progress, { current: 2, target: 3, percent: 67, unit_label: 'khóa' });
  assert.equal(extraMapped.achieved, true);
  assert.equal(extraUnmapped.achieved, true);
});

test('completed_any_courses counts distinct completed courses', () => {
  const result = evaluateBadgeRule({
    criteria: { version: 1, type: 'completed_any_courses', threshold: 2 },
    mapped_courses: [],
  }, [completed('course-a'), completed('course-a'), completed('course-b')], {});

  assert.equal(result.achieved, true);
  assert.equal(result.progress.current, 2);
});

test('completion_within_minutes uses enrolled_at through completed_at inclusively', () => {
  const rule = {
    criteria: { version: 1 as const, type: 'completion_within_minutes' as const, minutes: 30 },
    mapped_courses: [],
  };
  const atBoundary = completed(
    'course-fast',
    '2026-08-24T00:00:00.000Z',
    '2026-08-24T00:30:00.000Z',
  );
  const negativeDuration = completed(
    'course-invalid',
    '2026-08-24T01:00:00.000Z',
    '2026-08-24T00:30:00.000Z',
  );

  assert.equal(evaluateBadgeRule(rule, [atBoundary], {}).achieved, true);
  assert.equal(evaluateBadgeRule(rule, [negativeDuration], {}).achieved, false);
  assert.equal(evaluateBadgeRule(rule, [completed('course-bad', 'invalid', 'invalid')], {}).achieved, false);
});

test('award candidates contain a sorted snapshot of valid mapped course ids', () => {
  const criteria = {
    version: 1 as const,
    type: 'completed_selected_courses' as const,
    threshold: 1,
    requires_courses: true as const,
  };

  assert.deepEqual(buildBadgeAwardCandidates([{
    id: 'badge-1',
    rule_version: '2026-08-24 12:00:00+00',
    criteria,
    mapped_courses: [mapped('course-b'), mapped(null), mapped('course-deleted', true), mapped('course-a')],
  }]), [{
    badge_id: 'badge-1',
    rule_version: '2026-08-24 12:00:00+00',
    criteria,
    mapped_course_ids: ['course-a', 'course-b'],
  }]);
});
