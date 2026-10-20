import assert from 'node:assert/strict';
import test from 'node:test';
import { getNextBlueprintChapterIndex } from './lesson-author-blueprint-sequencing.logic.js';

test('requires the first unapplied Blueprint chapter even when later chapters are already applied', () => {
  assert.equal(getNextBlueprintChapterIndex(6, [1, 2]), 0);
  assert.equal(getNextBlueprintChapterIndex(6, [0, 1, 3]), 2);
});

test('returns null once every Blueprint chapter is applied', () => {
  assert.equal(getNextBlueprintChapterIndex(3, [0, 1, 2]), null);
});

test('ignores invalid or duplicate persisted chapter indexes', () => {
  assert.equal(getNextBlueprintChapterIndex(2, [-1, 0, 0, 9]), 1);
});
