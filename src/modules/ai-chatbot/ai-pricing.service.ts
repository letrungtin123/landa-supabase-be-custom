import { query } from '../../config/database.js';
import type { AiProvider, AiUsage } from './ai-engine.types.js';

export type AiCostStatus = 'estimated' | 'unpriced' | 'reconciled';

interface AiPricingRateCardRow {
  id: string;
  provider: AiProvider;
  model: string;
  input_vnd_per_1m: string;
  output_vnd_per_1m: string;
  embedding_vnd_per_1m: string;
  effective_from: string;
  effective_to: string | null;
  source_url: string | null;
  source_note: string | null;
}

export interface AiUsageCostVnd {
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

function toSnapshot(card: AiPricingRateCardRow | null): Record<string, unknown> | null {
  if (!card) return null;
  return {
    rate_card_id: card.id,
    provider: card.provider,
    model: card.model,
    input_vnd_per_1m: card.input_vnd_per_1m,
    output_vnd_per_1m: card.output_vnd_per_1m,
    embedding_vnd_per_1m: card.embedding_vnd_per_1m,
    effective_from: card.effective_from,
    effective_to: card.effective_to,
    source_url: card.source_url,
    source_note: card.source_note,
  };
}

async function getEffectiveRateCard(provider: AiProvider, model: string): Promise<AiPricingRateCardRow | null> {
  const normalizedModel = model.trim();
  if (!normalizedModel) return null;
  const result = await query<AiPricingRateCardRow>(
    `SELECT id::text, provider, model,
            input_vnd_per_1m::text, output_vnd_per_1m::text, embedding_vnd_per_1m::text,
            effective_from::text, effective_to::text, source_url, source_note
     FROM ai_pricing_rate_cards
     WHERE provider = $1
       AND model = $2
       AND status = 'active'
       AND effective_from <= now()
       AND (effective_to IS NULL OR effective_to > now())
     ORDER BY effective_from DESC, created_at DESC
     LIMIT 1`,
    [provider, normalizedModel],
  );
  return result.rows[0] ?? null;
}

/**
 * Calculates VND from the active approved rate card and returns the exact
 * pricing inputs used. The caller persists this snapshot beside the usage so
 * historical reports never change when a rate card is edited later.
 */
export async function calculateAiUsageCostVnd(input: {
  provider: AiProvider;
  model: string;
  embeddingModel?: string | null;
  usage: AiUsage;
}): Promise<AiUsageCostVnd> {
  const needsGenerationRate = input.usage.inputTokens > 0 || input.usage.outputTokens > 0;
  const effectiveEmbeddingModel = input.embeddingModel?.trim() || input.model;
  const needsEmbeddingRate = input.usage.embeddingTokens > 0;

  const [generationCard, embeddingCard] = await Promise.all([
    needsGenerationRate ? getEffectiveRateCard(input.provider, input.model) : Promise.resolve(null),
    needsEmbeddingRate ? getEffectiveRateCard(input.provider, effectiveEmbeddingModel) : Promise.resolve(null),
  ]);

  const inputCost = (input.usage.inputTokens / 1_000_000) * numeric(generationCard?.input_vnd_per_1m);
  const outputCost = (input.usage.outputTokens / 1_000_000) * numeric(generationCard?.output_vnd_per_1m);
  const embeddingCost = (input.usage.embeddingTokens / 1_000_000) * numeric(embeddingCard?.embedding_vnd_per_1m);
  const allRequiredCardsFound = (!needsGenerationRate || Boolean(generationCard))
    && (!needsEmbeddingRate || Boolean(embeddingCard));

  return {
    amountVnd: roundVnd(inputCost + outputCost + embeddingCost),
    status: allRequiredCardsFound ? 'estimated' : 'unpriced',
    pricingSnapshot: {
      version: 1,
      currency: 'VND',
      calculated_at: new Date().toISOString(),
      generation: {
        requested_model: input.model,
        rate_card: toSnapshot(generationCard),
      },
      embedding: {
        requested_model: effectiveEmbeddingModel,
        rate_card: toSnapshot(embeddingCard),
      },
    },
  };
}
