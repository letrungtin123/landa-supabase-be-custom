import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeLessonAuthorMediaReview } from './lesson-author-media-review.logic.js';

const placements = [
  { unit_path: 'chapter_1.lesson_1.unit_1', has_media_plan: true },
  { unit_path: 'chapter_1.lesson_1.unit_2', has_media_plan: false },
  { unit_path: 'chapter_1.lesson_1.unit_3', has_media_plan: false },
  { unit_path: 'chapter_1.lesson_1.unit_4', has_media_plan: false },
  { unit_path: 'chapter_1.lesson_1.unit_5', has_media_plan: false },
] as const;

test('media review preserves each explicit decision status', () => {
  const review = normalizeLessonAuthorMediaReview({
    version: 'media-review-v1',
    decisions: [
      { unit_path: placements[0].unit_path, status: 'PROPOSED', reason_code: 'PROCEDURE_VISUAL_CANDIDATE' },
      { unit_path: placements[1].unit_path, status: 'NOT_NEEDED', reason_code: 'NO_SOURCE_BACKED_VISUAL_CANDIDATE' },
      { unit_path: placements[2].unit_path, status: 'SOURCE_GAP', reason_code: 'MEDIA_CANDIDATE_EVIDENCE_UNRESOLVED' },
      { unit_path: placements[3].unit_path, status: 'FAILED', reason_code: 'MEDIA_RECOMMENDATION_CAPACITY_EXCEEDED' },
      { unit_path: placements[4].unit_path, status: 'NOT_EVALUATED', reason_code: 'LEGACY_BLUEPRINT' },
    ],
  }, placements);
  assert.deepEqual(review?.decisions.map(decision => decision.status), [
    'PROPOSED', 'NOT_NEEDED', 'SOURCE_GAP', 'FAILED', 'NOT_EVALUATED',
  ]);
});

test('media review rejects a partial evaluation and false not-needed decision', () => {
  assert.throws(
    () => normalizeLessonAuthorMediaReview({
      version: 'media-review-v1',
      decisions: [{ unit_path: placements[0].unit_path, status: 'PROPOSED', reason_code: 'PROCEDURE_VISUAL_CANDIDATE' }],
    }, placements),
    /one decision for every unit/,
  );
  assert.throws(
    () => normalizeLessonAuthorMediaReview({
      version: 'media-review-v1',
      decisions: [
        { unit_path: placements[0].unit_path, status: 'NOT_NEEDED', reason_code: 'NO_SOURCE_BACKED_VISUAL_CANDIDATE' },
        ...placements.slice(1).map(placement => ({ unit_path: placement.unit_path, status: 'NOT_NEEDED', reason_code: 'NO_SOURCE_BACKED_VISUAL_CANDIDATE' })),
      ],
    }, placements),
    /cannot retain a media_plan/,
  );
});
