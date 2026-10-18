import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractGeminiAudioTranscriptionText,
  summarizeGeminiTranscriptionResponse,
} from './gemini-transcription.logic.js';

test('reads native Gemini audioTranscription response parts', () => {
  const response = {
    candidates: [{
      content: {
        parts: [
          { audioTranscription: { text: 'Safety briefing starts now.', finished: false, languageCode: 'en' } },
          { audioTranscription: { text: 'Wear protective equipment.', finished: true, languageCode: 'en' } },
        ],
      },
    }],
  };

  assert.equal(
    extractGeminiAudioTranscriptionText(response),
    'Safety briefing starts now.\nWear protective equipment.',
  );
});

test('falls back to conventional text response parts', () => {
  assert.equal(
    extractGeminiAudioTranscriptionText({
      candidates: [{ content: { parts: [{ text: 'A standard text transcript.' }] } }],
    }),
    'A standard text transcript.',
  );
});

test('does not treat response metadata as a transcript', () => {
  const response = {
    candidates: [{ content: { parts: [{ audioTranscription: { finished: true, languageCode: 'vi' } }] } }],
  };
  assert.equal(extractGeminiAudioTranscriptionText(response), null);
  assert.deepEqual(summarizeGeminiTranscriptionResponse(response), {
    candidate_count: 1,
    first_candidate_part_kinds: ['audioTranscription'],
  });
});
