import assert from 'node:assert/strict';
import test from 'node:test';
import { getLessonAuthorBlueprintReviewNotes } from './lesson-author-blueprint-quality.logic.js';

test('renders English quality notes for an inferred source structure', () => {
  const notes = getLessonAuthorBlueprintReviewNotes(
    [
      { key: 'source_structure', passed: false },
      { key: 'source_coverage', passed: false },
    ],
    'heading_inferred',
    true,
    'en',
  );

  assert.deepEqual(notes, [
    'No authoritative table of contents was found; the structure was inferred from headings and must be reviewed before detailed authoring.',
    'Retrieved source coverage does not yet cover the document structure sufficiently; verify it before applying the blueprint.',
    'Confirm the design assumptions before drafting each chapter in detail.',
  ]);
});

test('renders Vietnamese quality notes for a Vietnamese Blueprint', () => {
  const notes = getLessonAuthorBlueprintReviewNotes(
    [{ key: 'learning_outcomes', passed: false }],
    null,
    false,
    'vi',
  );

  assert.deepEqual(notes, ['Cần bổ sung ít nhất ba kết quả học tập có thể đo lường.']);
});
