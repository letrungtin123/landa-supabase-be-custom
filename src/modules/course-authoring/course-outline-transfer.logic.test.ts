import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCourseOutlineTransferStoragePath } from './course-outline-transfer.service.js';

const sourcePath = '4c8ebffd-c9e3-4c2f-bbef-adb45fa13ee3/courses/course-v1:Nesso+EXECUTIVE_TRANSFORMATION_SHOWCASE+2026/1790045168357_NESSO_Pitching_Deck_Intro_Video_V2.mp4';

test('duplicate transfer recognizes a raw course asset path with colon and plus in its course ID', () => {
  assert.equal(normalizeCourseOutlineTransferStoragePath(sourcePath), sourcePath);
});

test('duplicate transfer normalizes an encoded public Storage URL to the same path', () => {
  const url = 'https://storage.example.test/storage/v1/object/public/landa-storage/4c8ebffd-c9e3-4c2f-bbef-adb45fa13ee3/courses/course-v1%3ANesso%2BEXECUTIVE_TRANSFORMATION_SHOWCASE%2B2026/1790045168357_NESSO_Pitching_Deck_Intro_Video_V2.mp4?download=1';
  assert.equal(normalizeCourseOutlineTransferStoragePath(url), sourcePath);
});

test('duplicate transfer rejects unsafe paths before matching an asset record', () => {
  assert.equal(
    normalizeCourseOutlineTransferStoragePath('4c8ebffd-c9e3-4c2f-bbef-adb45fa13ee3/courses/course-v1:Nesso+EXECUTIVE_TRANSFORMATION_SHOWCASE+2026/../other.mp4'),
    null,
  );
});
