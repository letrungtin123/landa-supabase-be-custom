import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LESSON_AUTHOR_TRANSCRIPT_MIME_TYPE,
  formatLessonAuthorTranscriptMessage,
  isLessonAuthorTranscriptSourceReady,
  isSupportedLessonAuthorVideo,
  normalizeLessonAuthorKbDocumentStatus,
  normalizeLessonAuthorUploadAttemptId,
  normalizeTranscriptText,
  transcriptFileName,
} from './lesson-author-transcription.logic.js';

test('uses the canonical text MIME type accepted by private storage', () => {
  assert.equal(LESSON_AUTHOR_TRANSCRIPT_MIME_TYPE, 'text/plain');
});

test('accepts only a UUID-shaped browser upload attempt for diagnostics', () => {
  assert.equal(
    normalizeLessonAuthorUploadAttemptId('11111111-1111-4111-8111-111111111111'),
    '11111111-1111-4111-8111-111111111111',
  );
  assert.equal(normalizeLessonAuthorUploadAttemptId('customer-file-name.mp4'), null);
  assert.equal(normalizeLessonAuthorUploadAttemptId(''), null);
});

test('accepts only MP4 video uploads', () => {
  assert.equal(isSupportedLessonAuthorVideo('training.MP4', 'video/mp4'), true);
  assert.equal(isSupportedLessonAuthorVideo('training.mov', 'video/quicktime'), false);
  assert.equal(isSupportedLessonAuthorVideo('training.mp4', 'text/plain'), false);
});

test('creates a stable transcript filename', () => {
  assert.equal(transcriptFileName('Safety briefing.mp4'), 'Safety briefing.transcript.txt');
});

test('normalizes transcript whitespace and rejects unusable output', () => {
  const longTranscript = ` A\r\n\r\n\r\nB${'x'.repeat(40)} `;
  assert.equal(normalizeTranscriptText(longTranscript, 100), `A\n\nB${'x'.repeat(40)}`);
  assert.throws(() => normalizeTranscriptText('too short', 100));
});

test('formats assistant transcript state in the requested locale', () => {
  assert.match(formatLessonAuthorTranscriptMessage('running', 'video.mp4', 'en'), /knowledge base/i);
  assert.match(formatLessonAuthorTranscriptMessage('succeeded', 'video.mp4', 'en'), /ready/i);
  assert.match(formatLessonAuthorTranscriptMessage('committed', 'video.mp4', 'vi'), /Kho tri thức/);
});

test('marks a committed transcript source ready only after KB learning completes', () => {
  assert.equal(normalizeLessonAuthorKbDocumentStatus('learning'), 'learning');
  assert.equal(normalizeLessonAuthorKbDocumentStatus('unexpected'), null);
  assert.equal(isLessonAuthorTranscriptSourceReady('committed', 'learning'), false);
  assert.equal(isLessonAuthorTranscriptSourceReady('committed', 'error'), false);
  assert.equal(isLessonAuthorTranscriptSourceReady('committed', 'learned'), true);
  assert.equal(isLessonAuthorTranscriptSourceReady('succeeded', 'learned'), false);
});
