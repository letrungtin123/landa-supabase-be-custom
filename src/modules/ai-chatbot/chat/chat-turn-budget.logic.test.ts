import assert from 'node:assert/strict';
import test from 'node:test';

// The token budget of a chat turn (buildAiTurnTokenBudget). A self-built RAG
// chat answer reserves its retrieval context plus a full answer (the 2048
// output tokens a Gemini chat answer gets), whatever AI_CHAT_TOKEN_RESERVE_ESTIMATE
// says; only nearly spent AI points shorten it (the minimum hold). Gemini chat
// is unchanged. No database, network or provider.

const { env } = await import('../../../config/env.js');
const logic = await import('./chat-turn.logic.js');
const constants = await import('./chat.constants.js');

const PROMPT = ['Bạn là trợ lý học tập của doanh nghiệp.', 'Lắng nghe chủ động là gì?'];

function withChatEstimate<T>(estimate: number, run: () => T): T {
  const previous = env.AI_CHAT_TOKEN_RESERVE_ESTIMATE;
  Object.assign(env as unknown as Record<string, unknown>, { AI_CHAT_TOKEN_RESERVE_ESTIMATE: estimate });
  try {
    return run();
  } finally {
    Object.assign(env as unknown as Record<string, unknown>, { AI_CHAT_TOKEN_RESERVE_ESTIMATE: previous });
  }
}

test('a self-built RAG chat answer reserves the retrieval context and a full answer, even under a low estimate', () => {
  for (const estimate of [500, 8_000, 10_000]) {
    const budget = withChatEstimate(estimate, () => logic.buildAiTurnTokenBudget({ engine: 'self_built_rag', operation: 'chat', promptParts: PROMPT }));
    assert.ok(budget.fixedInputTokens >= constants.RAG_RETRIEVAL_CONTEXT_TOKEN_BUDGET, 'the retrieval context is part of the input');
    assert.ok(
      budget.maximumTokens >= budget.fixedInputTokens + budget.embeddingTokens + constants.RAG_CHAT_MAX_OUTPUT_TOKENS,
      `estimate ${estimate}: the reservation covers the retrieval context and a full answer`,
    );
    assert.equal(logic.grantedOutputTokenLimit(budget, budget.maximumTokens, 1), constants.RAG_CHAT_MAX_OUTPUT_TOKENS, `estimate ${estimate}: a full answer`);
    // Nearly spent AI points: only the minimum hold fits, the answer is shorter (unchanged).
    assert.equal(logic.grantedOutputTokenLimit(budget, budget.minimumTokens, 1), constants.RAG_CHAT_MIN_OUTPUT_TOKENS);
  }
});

test('a Gemini chat budget is unchanged: the configured estimate still bounds it', () => {
  for (const estimate of [500, 2_000, 8_000, 16_000]) {
    const budget = withChatEstimate(estimate, () => logic.buildAiTurnTokenBudget({ engine: 'gemini_file_search', operation: 'chat', promptParts: PROMPT }));
    const modelBudget = budget.fixedInputTokens + budget.targetOutputTokens;
    assert.equal(budget.embeddingTokens, 0);
    assert.equal(budget.maximumTokens, Math.max(budget.minimumTokens, Math.min(estimate, modelBudget)), `estimate ${estimate}`);
  }
});

test('one startup warning when the chat estimate is below the retrieval context plus a full answer', () => {
  const floor = constants.RAG_RETRIEVAL_CONTEXT_TOKEN_BUDGET + constants.RAG_CHAT_MAX_OUTPUT_TOKENS;
  assert.equal(typeof logic.chatReserveEstimateWarning, 'function');
  const warning = logic.chatReserveEstimateWarning(8_000);
  assert.ok(warning);
  assert.deepEqual(JSON.parse(warning), {
    event: 'ai_chat_reserve_estimate_below_rag_floor',
    configured_tokens: 8_000,
    rag_floor_tokens: floor,
  });
  assert.equal(logic.chatReserveEstimateWarning(floor - 1) === null, false);
  assert.equal(logic.chatReserveEstimateWarning(floor), null);
  assert.equal(logic.chatReserveEstimateWarning(16_000), null, 'the code default and .env.example');
});
