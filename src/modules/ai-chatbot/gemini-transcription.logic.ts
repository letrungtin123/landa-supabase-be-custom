type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function firstCandidateParts(response: unknown): UnknownRecord[] {
  if (!isRecord(response) || !Array.isArray(response.candidates)) return [];
  const candidate = response.candidates[0];
  if (!isRecord(candidate) || !isRecord(candidate.content) || !Array.isArray(candidate.content.parts)) return [];
  return candidate.content.parts.filter(isRecord);
}

/**
 * Gemini transcription models return audioTranscription as a non-text response
 * part. Do not use the SDK's response.text getter here: it intentionally omits
 * non-text parts and emits a warning instead of returning the transcript.
 */
export function extractGeminiAudioTranscriptionText(response: unknown): string | null {
  const parts = firstCandidateParts(response);
  const transcription = parts
    .map(part => isRecord(part.audioTranscription) ? stringValue(part.audioTranscription.text) : null)
    .filter((value): value is string => Boolean(value));
  if (transcription.length > 0) return transcription.join('\n');

  // Preserve compatibility with providers that return a conventional text part.
  const text = parts
    .map(part => stringValue(part.text))
    .filter((value): value is string => Boolean(value));
  return text.length > 0 ? text.join('\n') : null;
}

/** Return structural diagnostics only; transcript content must never enter logs. */
export function summarizeGeminiTranscriptionResponse(response: unknown): {
  candidate_count: number;
  first_candidate_part_kinds: string[];
} {
  const candidateCount = isRecord(response) && Array.isArray(response.candidates)
    ? response.candidates.length
    : 0;
  const partKinds = firstCandidateParts(response)
    .flatMap(part => Object.keys(part).filter(key => key !== 'text' && key !== 'thought' && key !== 'thoughtSignature'));
  return {
    candidate_count: candidateCount,
    first_candidate_part_kinds: [...new Set(partKinds)].sort(),
  };
}
