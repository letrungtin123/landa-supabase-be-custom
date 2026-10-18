import assert from 'node:assert/strict';
import test from 'node:test';
import { addAiUsage, aiUsageFromGeminiMetadata, createStreamUsageTracker } from './ai-usage.logic.js';
import { normalizeAiUsage } from './ai-token-quota.service.js';

test('Gemini usage is read as billed: thinking is output, tool-use prompt is input', () => {
  assert.deepEqual(aiUsageFromGeminiMetadata({
    promptTokenCount: 1_000, toolUsePromptTokenCount: 300, candidatesTokenCount: 200,
    thoughtsTokenCount: 150, totalTokenCount: 1_650,
  }), { inputTokens: 1_300, outputTokens: 350, embeddingTokens: 0, totalTokens: 1_650 });
});

test('cached input is kept apart, never more than the input', () => {
  assert.deepEqual(aiUsageFromGeminiMetadata({
    promptTokenCount: 2_000, cachedContentTokenCount: 1_500, candidatesTokenCount: 100, totalTokenCount: 2_100,
  }), { inputTokens: 2_000, outputTokens: 100, embeddingTokens: 0, totalTokens: 2_100, cachedInputTokens: 1_500 });
  assert.equal(aiUsageFromGeminiMetadata({ promptTokenCount: 10, cachedContentTokenCount: 50 })?.cachedInputTokens, 10);
});

test('a total below input + output (provider omitted thinking from it) is raised to the billed sum', () => {
  assert.equal(aiUsageFromGeminiMetadata({ promptTokenCount: 100, candidatesTokenCount: 10, thoughtsTokenCount: 40, totalTokenCount: 110 })?.totalTokens, 150);
});

test('no usage from the provider means null (the caller estimates), never a zero-cost call', () => {
  assert.equal(aiUsageFromGeminiMetadata(null), null);
  assert.equal(aiUsageFromGeminiMetadata(undefined), null);
  assert.equal(aiUsageFromGeminiMetadata({}), null);
  assert.equal(aiUsageFromGeminiMetadata({ cachedContentTokenCount: 5 }), null);
});

test('calls of one turn add up, cached input included', () => {
  const first = aiUsageFromGeminiMetadata({ promptTokenCount: 100, candidatesTokenCount: 5, totalTokenCount: 105 });
  const second = aiUsageFromGeminiMetadata({ promptTokenCount: 400, cachedContentTokenCount: 80, candidatesTokenCount: 50, thoughtsTokenCount: 20, totalTokenCount: 470 });
  assert.deepEqual(addAiUsage(addAiUsage(null, first), second),
    { inputTokens: 500, outputTokens: 75, embeddingTokens: 0, totalTokens: 575, cachedInputTokens: 80 });
  assert.equal(addAiUsage(null, null), null);
  assert.deepEqual(addAiUsage(first, null), first);
});

test('a stream reports the usage of its last chunk that carries one', () => {
  const tracker = createStreamUsageTracker();
  tracker.observe({});
  tracker.observe({ usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 3, totalTokenCount: 103 } });
  tracker.observe({ usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 40, thoughtsTokenCount: 10, totalTokenCount: 150 } });
  tracker.observe({ usageMetadata: null });
  assert.deepEqual(tracker.usage(), { inputTokens: 100, outputTokens: 50, embeddingTokens: 0, totalTokens: 150 });
  assert.equal(createStreamUsageTracker().usage(), null);
});

test('normalized usage keeps a bounded cached part and omits it when zero', () => {
  assert.deepEqual(normalizeAiUsage({ inputTokens: 100, outputTokens: 10, embeddingTokens: 0, totalTokens: 110, cachedInputTokens: 30 }),
    { inputTokens: 100, outputTokens: 10, embeddingTokens: 0, totalTokens: 110, cachedInputTokens: 30 });
  assert.equal(normalizeAiUsage({ inputTokens: 10, cachedInputTokens: 99 }).cachedInputTokens, 10);
  assert.equal('cachedInputTokens' in normalizeAiUsage({ inputTokens: 10, outputTokens: 1 }), false);
});
