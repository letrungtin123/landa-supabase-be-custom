import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LESSON_AUTHOR_TRANSCRIPT_MIME_TYPE,
  formatLessonAuthorTranscriptMessage,
  isSupportedLessonAuthorVideo,
  normalizeTranscriptText,
  transcriptFileName,
} from './lesson-author-transcription.logic.js';

test('uses the canonical text MIME type accepted by private storage', () => {
  assert.equal(LESSON_AUTHOR_TRANSCRIPT_MIME_TYPE, 'text/plain');
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
