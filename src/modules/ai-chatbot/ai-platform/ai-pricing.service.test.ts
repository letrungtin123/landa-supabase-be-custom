import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateAiUsageCost,
  clearAiRateCardCache,
  costOfAiUsage,
  estimateMaxAiCallCostUsd,
  selectRateCard,
  type AiPricingRateCardRow,
} from './ai-pricing.service.js';
import { aiLedgerFeature } from './ai-usage.logic.js';

// The prices the owner approved on 2026-10-17 (plan §9), as seeded by 20261017_1700_ai_credit_p0b.
function card(model: string, from: string, to: string | null, prices: Partial<Record<'in' | 'cached' | 'out' | 'emb', string>>, billed = model): AiPricingRateCardRow {
  return {
    id: `${model}-${from}`, provider: 'google_ai_studio', model, billed_model: billed,
    input_usd_per_1m: prices.in ?? '0', cached_input_usd_per_1m: prices.cached ?? '0',
    output_usd_per_1m: prices.out ?? '0', embedding_usd_per_1m: prices.emb ?? '0',
    input_vnd_per_1m: '0', output_vnd_per_1m: '0', embedding_vnd_per_1m: '0',
    effective_from: from, effective_to: to, source_url: null, source_note: 'ai-credit-p0b approved prices 2026-10-17',
  };
}
const FLASH_2026 = card('gemini-3.8-flash', '2026-01-01T00:00:00+00:00', '2027-01-01T00:00:00+00:00', { in: '0.750000', cached: '0.075000', out: '3.750000' });
const FLASH_2027 = card('gemini-3.8-flash', '2027-01-01T00:00:00+00:00', null, { in: '1.500000', cached: '0.150000', out: '7.500000' });
const LEGACY_35 = card('gemini-3.5-flash', '2026-01-01T00:00:00+00:00', '2027-01-01T00:00:00+00:00', { in: '0.75', cached: '0.075', out: '3.75' }, 'gemini-3.6-flash');
const EMBEDDING = card('gemini-embedding-001', '2025-01-01T00:00:00+00:00', null, { emb: '0.150000' });

test('one AI ID task costs input + output (thinking included) at the card in force', () => {
  const usage = { inputTokens: 470_000, outputTokens: 230_000, embeddingTokens: 0, totalTokens: 700_000 };
  assert.equal(costOfAiUsage(usage, FLASH_2026, null).amountUsd, 1.215);
  assert.equal(costOfAiUsage(usage, FLASH_2027, null).amountUsd, 2.43);
});

test('cached input is billed at the cache rate, the rest of the input at the input rate', () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 0, embeddingTokens: 0, totalTokens: 1_000_000, cachedInputTokens: 800_000 };
  // 200k x 0.75 + 800k x 0.075 = 0.15 + 0.06
  assert.equal(costOfAiUsage(usage, FLASH_2026, null).amountUsd, 0.21);
});

test('embedding tokens use the embedding card; micro-dollar rounding is exact', () => {
  assert.equal(costOfAiUsage({ inputTokens: 0, outputTokens: 0, embeddingTokens: 2_000_000, totalTokens: 2_000_000 }, null, EMBEDDING).amountUsd, 0.3);
  assert.equal(costOfAiUsage({ inputTokens: 3, outputTokens: 0, embeddingTokens: 0, totalTokens: 3, cachedInputTokens: 3 }, FLASH_2026, null).amountUsd, 0);
  assert.equal(costOfAiUsage({ inputTokens: 5_000, outputTokens: 500, embeddingTokens: 0, totalTokens: 5_500 }, FLASH_2026, null).amountUsd, 0.005625);
});

test('the card is chosen by the time of the call, the 2027 price from 1 January 2027 UTC', () => {
  const cards = [FLASH_2027, FLASH_2026];
  assert.equal(selectRateCard(cards, new Date('2026-12-31T23:59:59Z'))?.id, FLASH_2026.id);
  assert.equal(selectRateCard(cards, new Date('2027-01-01T00:00:00Z'))?.id, FLASH_2027.id);
  assert.equal(selectRateCard(cards, new Date('2025-06-01T00:00:00Z')), null);
});

test('pricing reads the cards once per minute and records the card it used', async () => {
  clearAiRateCardCache();
  let loads = 0;
  const load = async (_provider: string, model: string) => { loads += 1; return model === 'gemini-3.5-flash' ? [LEGACY_35] : []; };
  const usage = { inputTokens: 100_000, outputTokens: 10_000, embeddingTokens: 0, totalTokens: 110_000 };
  const first = await calculateAiUsageCost({ provider: 'google_ai_studio', model: 'gemini-3.5-flash', usage, at: new Date('2026-10-11T03:00:00Z') }, load);
  const second = await calculateAiUsageCost({ provider: 'google_ai_studio', model: 'gemini-3.5-flash', usage, at: new Date('2026-10-12T03:00:00Z') }, load);
  assert.equal(loads, 1);
  assert.equal(first.amountUsd, 0.1125);
  assert.equal(second.amountUsd, 0.1125);
  assert.equal(first.status, 'estimated');
  const snapshot = first.pricingSnapshot as any;
  assert.equal(snapshot.currency, 'USD');
  assert.equal(snapshot.generation.rate_card.billed_model, 'gemini-3.6-flash');
  clearAiRateCardCache();
});

test('a model without a card is priced with the proxy card (never free), unpriced only without any card', async () => {
  clearAiRateCardCache();
  const usage = { inputTokens: 500_000, outputTokens: 5_000, embeddingTokens: 0, totalTokens: 505_000 };
  const proxied = await calculateAiUsageCost({ provider: 'google_ai_studio', model: 'gemini-3.5-transcribe', usage,
    at: new Date('2026-10-17T00:00:00Z') }, async (_provider, model) => model === 'gemini-3.8-flash' ? [FLASH_2026] : []);
  assert.equal(proxied.status, 'estimated');
  assert.equal(proxied.amountUsd, 0.39375);
  assert.equal((proxied.pricingSnapshot as any).generation.proxy_card, true);
  clearAiRateCardCache();
  const none = await calculateAiUsageCost({ provider: 'google_ai_studio', model: 'gemini-3.5-transcribe', usage }, async () => []);
  assert.equal(none.status, 'unpriced');
  assert.equal(none.amountUsd, 0);
  clearAiRateCardCache();
});

test('a reservation holds the most a call can cost, without the cache discount', async () => {
  clearAiRateCardCache();
  const load = async (_provider: string, model: string) => model === 'gemini-3.8-flash' ? [FLASH_2026] : model === 'gemini-embedding-001' ? [EMBEDDING] : [];
  const cost = await estimateMaxAiCallCostUsd({ provider: 'google_ai_studio', model: 'gemini-3.8-flash', embeddingModel: 'gemini-embedding-001',
    inputTokens: 100_000, outputTokens: 20_000, embeddingTokens: 1_000_000, at: new Date('2026-10-17T00:00:00Z') }, load);
  // 0.075 + 0.075 + 0.15
  assert.equal(cost, 0.3);
  clearAiRateCardCache();
});

test('a failed card read is not cached', async () => {
  clearAiRateCardCache();
  let calls = 0;
  const load = async () => { calls += 1; if (calls === 1) throw new Error('db down'); return [FLASH_2026]; };
  const usage = { inputTokens: 1_000, outputTokens: 0, embeddingTokens: 0, totalTokens: 1_000 };
  await assert.rejects(calculateAiUsageCost({ provider: 'google_ai_studio', model: 'gemini-3.8-flash', usage, at: new Date('2026-10-17T00:00:00Z') }, load));
  await new Promise(resolve => setImmediate(resolve));
  const retry = await calculateAiUsageCost({ provider: 'google_ai_studio', model: 'gemini-3.8-flash', usage, at: new Date('2026-10-17T00:00:00Z') }, load);
  assert.equal(retry.amountUsd, 0.00075);
  clearAiRateCardCache();
});

test('the ledger feature comes from the caller label, else from the call type', () => {
  assert.equal(aiLedgerFeature({ feature: 'report_chat_router' }, 'chat'), 'report_chat_router');
  assert.equal(aiLedgerFeature({ feature: 'Bad Label!' }, 'chat'), 'chat');
  assert.equal(aiLedgerFeature({ report_pdf: true }, 'chat'), 'report_pdf_narrative');
  assert.equal(aiLedgerFeature({}, 'lesson_author'), 'ai_id');
  assert.equal(aiLedgerFeature(undefined, 'indexing'), 'document_indexing');
  assert.equal(aiLedgerFeature(null, 'chat'), 'chat');
});
