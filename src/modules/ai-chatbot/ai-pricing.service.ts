import { query } from '../../config/database.js';
import type { AiProvider, AiUsage } from './ai-engine.types.js';

export type AiCostStatus = 'estimated' | 'unpriced' | 'reconciled';

/**
 * A rate card as stored. USD columns are the provider's published prices (per
 * 1M tokens); the VND columns are the legacy card, kept for old reports.
 */
export interface AiPricingRateCardRow {
  id: string;
  provider: AiProvider;
  model: string;
  billed_model: string | null;
  input_usd_per_1m: string;
  cached_input_usd_per_1m: string;
  output_usd_per_1m: string;
  embedding_usd_per_1m: string;
  input_vnd_per_1m: string;
  output_vnd_per_1m: string;
  embedding_vnd_per_1m: string;
  effective_from: string;
  effective_to: string | null;
  source_url: string | null;
  source_note: string | null;
}

export interface AiUsageCost {
  /** Provider cost in USD, rounded to the micro-dollar. */
  amountUsd: number;
  /** Legacy VND card amount (0 when only USD prices are set). */
  amountVnd: number;
  status: Exclude<AiCostStatus, 'reconciled'>;
  pricingSnapshot: Record<string, unknown>;
}

function numeric(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function roundVnd(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** 1 token at X USD per 1M tokens costs X micro-dollars: sum in micro-dollars, round once. */
function usdFromMicro(micro: number): number {
  if (!Number.isFinite(micro) || micro <= 0) return 0;
  return Math.round(micro) / 1_000_000;
}

function toSnapshot(card: AiPricingRateCardRow | null): Record<string, unknown> | null {
  if (!card) return null;
  return {
    rate_card_id: card.id,
    provider: card.provider,
    model: card.model,
    billed_model: card.billed_model,
    input_usd_per_1m: card.input_usd_per_1m,
    cached_input_usd_per_1m: card.cached_input_usd_per_1m,
    output_usd_per_1m: card.output_usd_per_1m,
    embedding_usd_per_1m: card.embedding_usd_per_1m,
    effective_from: card.effective_from,
    effective_to: card.effective_to,
    source_url: card.source_url,
    source_note: card.source_note,
  };
}

/** The card in force at `at`, from all active cards of one model. */
export function selectRateCard(cards: readonly AiPricingRateCardRow[], at: Date): AiPricingRateCardRow | null {
  const time = at.getTime();
  let best: AiPricingRateCardRow | null = null;
  for (const card of cards) {
    const from = Date.parse(card.effective_from);
    const to = card.effective_to ? Date.parse(card.effective_to) : Number.POSITIVE_INFINITY;
    if (!(from <= time && time < to)) continue;
    if (!best || from > Date.parse(best.effective_from)) best = card;
  }
  return best;
}

/**
 * Cost of one call as the provider bills it: uncached input, cached input
 * (cache rate), output (thinking included) and embedding tokens, each at the
 * price of its card.
 */
export function costOfAiUsage(
  usage: AiUsage,
  generationCard: AiPricingRateCardRow | null,
  embeddingCard: AiPricingRateCardRow | null,
): { amountUsd: number; amountVnd: number } {
  const cached = Math.min(usage.inputTokens, usage.cachedInputTokens ?? 0);
  const uncached = usage.inputTokens - cached;
  const micro = uncached * numeric(generationCard?.input_usd_per_1m)
    + cached * numeric(generationCard?.cached_input_usd_per_1m)
    + usage.outputTokens * numeric(generationCard?.output_usd_per_1m)
    + usage.embeddingTokens * numeric(embeddingCard?.embedding_usd_per_1m);
  const vnd = (usage.inputTokens / 1_000_000) * numeric(generationCard?.input_vnd_per_1m)
    + (usage.outputTokens / 1_000_000) * numeric(generationCard?.output_vnd_per_1m)
    + (usage.embeddingTokens / 1_000_000) * numeric(embeddingCard?.embedding_vnd_per_1m);
  return { amountUsd: usdFromMicro(micro), amountVnd: roundVnd(vnd) };
}

// Every settled call prices itself: the active cards of a model are read once
// per minute per process instead of on every call. A card edit applies within
// that minute; the snapshot stored with each call records the card it used.
const RATE_CARD_CACHE_TTL_MS = 60_000;
const rateCardCache = new Map<string, { loadedAt: number; cards: Promise<AiPricingRateCardRow[]> }>();

export type RateCardLoader = (provider: AiProvider, model: string) => Promise<AiPricingRateCardRow[]>;

async function loadActiveRateCards(provider: AiProvider, model: string): Promise<AiPricingRateCardRow[]> {
  const result = await query<AiPricingRateCardRow>(
    `SELECT id::text, provider, model, billed_model,
            input_usd_per_1m::text, cached_input_usd_per_1m::text, output_usd_per_1m::text, embedding_usd_per_1m::text,
            input_vnd_per_1m::text, output_vnd_per_1m::text, embedding_vnd_per_1m::text,
            to_json(effective_from) #>> '{}' AS effective_from, to_json(effective_to) #>> '{}' AS effective_to,
            source_url, source_note
     FROM ai_pricing_rate_cards
     WHERE provider = $1 AND model = $2 AND status = 'active'
     ORDER BY effective_from DESC, created_at DESC`,
    [provider, model],
  );
  return result.rows;
}

function cachedRateCards(provider: AiProvider, model: string, load: RateCardLoader, now: number): Promise<AiPricingRateCardRow[]> {
  const key = `${provider}\u0000${model}`;
  const hit = rateCardCache.get(key);
  if (hit && now - hit.loadedAt < RATE_CARD_CACHE_TTL_MS) return hit.cards;
  const cards = load(provider, model);
  rateCardCache.set(key, { loadedAt: now, cards });
  // A failed read is not cached: the next call asks again.
  cards.catch(() => { if (rateCardCache.get(key)?.cards === cards) rateCardCache.delete(key); });
  return cards;
}

/** Test hook: forget the cached cards. */
export function clearAiRateCardCache(): void {
  rateCardCache.clear();
}

/**
 * Prices one call with the card in force when it was made and returns the
 * exact inputs used. The caller stores this snapshot beside the usage so
 * historical reports never change when a rate card is edited later.
 */
export async function calculateAiUsageCost(input: {
  provider: AiProvider;
  model: string;
  embeddingModel?: string | null;
  usage: AiUsage;
  at?: Date;
}, load: RateCardLoader = loadActiveRateCards): Promise<AiUsageCost> {
  const at = input.at ?? new Date();
  const needsGenerationRate = input.usage.inputTokens > 0 || input.usage.outputTokens > 0;
  const generationModel = input.model.trim();
  const embeddingModel = input.embeddingModel?.trim() || generationModel;
  const needsEmbeddingRate = input.usage.embeddingTokens > 0;
  const cards = async (model: string, needed: boolean) => needed && model
    ? selectRateCard(await cachedRateCards(input.provider, model, load, Date.now()), at)
    : null;
  const [generationCard, embeddingCard] = await Promise.all([
    cards(generationModel, needsGenerationRate),
    cards(embeddingModel, needsEmbeddingRate),
  ]);
  const allRequiredCardsFound = (!needsGenerationRate || Boolean(generationCard))
    && (!needsEmbeddingRate || Boolean(embeddingCard));
  const cost = costOfAiUsage(input.usage, generationCard, embeddingCard);
  return {
    ...cost,
    status: allRequiredCardsFound ? 'estimated' : 'unpriced',
    pricingSnapshot: {
      version: 2,
      currency: 'USD',
      calculated_at: new Date().toISOString(),
      priced_at: at.toISOString(),
      generation: { requested_model: generationModel, rate_card: toSnapshot(generationCard) },
      embedding: { requested_model: embeddingModel, rate_card: toSnapshot(embeddingCard) },
    },
  };
}
