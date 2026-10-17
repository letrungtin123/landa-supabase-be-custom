import type { AiUsage } from './ai-engine.types.js';

/** The Gemini `usageMetadata` fields that decide what a call costs. */
export interface GeminiUsageMetadata {
  promptTokenCount?: number | null;
  toolUsePromptTokenCount?: number | null;
  candidatesTokenCount?: number | null;
  thoughtsTokenCount?: number | null;
  cachedContentTokenCount?: number | null;
  totalTokenCount?: number | null;
}

function count(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Usage as Google bills it, or null when the response carried no usage (the
 * caller then estimates). Input includes tool-use prompt tokens (File Search
 * retrieval, function results); output includes thinking tokens, which are
 * billed at the output rate but are not part of the candidate count.
 */
export function aiUsageFromGeminiMetadata(meta: GeminiUsageMetadata | null | undefined): AiUsage | null {
  if (!meta) return null;
  const known = [meta.promptTokenCount, meta.candidatesTokenCount, meta.thoughtsTokenCount, meta.totalTokenCount]
    .some(value => typeof value === 'number');
  if (!known) return null;
  const inputTokens = count(meta.promptTokenCount) + count(meta.toolUsePromptTokenCount);
  const outputTokens = count(meta.candidatesTokenCount) + count(meta.thoughtsTokenCount);
  const totalTokens = Math.max(count(meta.totalTokenCount), inputTokens + outputTokens);
  const cachedInputTokens = Math.min(count(meta.cachedContentTokenCount), inputTokens);
  return { inputTokens, outputTokens, embeddingTokens: 0, totalTokens, ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}) };
}

/** Sum of several calls of one turn (router call + streamed answer, retries that reached the provider). */
export function addAiUsage(total: AiUsage | null, next: AiUsage | null): AiUsage | null {
  if (!next) return total;
  if (!total) return { ...next };
  const cachedInputTokens = (total.cachedInputTokens ?? 0) + (next.cachedInputTokens ?? 0);
  return {
    inputTokens: total.inputTokens + next.inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
    embeddingTokens: total.embeddingTokens + next.embeddingTokens,
    totalTokens: total.totalTokens + next.totalTokens,
    ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
  };
}

/**
 * A streamed answer reports usage on its chunks; the last chunk that has it
 * carries the totals of the whole stream. Collect it while relaying the text.
 */
export function createStreamUsageTracker(): { observe: (chunk: { usageMetadata?: GeminiUsageMetadata | null }) => void; usage: () => AiUsage | null } {
  let last: AiUsage | null = null;
  return {
    observe: chunk => { last = aiUsageFromGeminiMetadata(chunk.usageMetadata) ?? last; },
    usage: () => last,
  };
}
