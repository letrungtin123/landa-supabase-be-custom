import { query, withDatabaseTransaction } from '../../config/database.js';
import { AppError } from '../../middleware/error-handler.js';
import type { AiOperation, AiProvider } from './ai-engine.types.js';
import { currentAiUsagePeriodStart, getTenantAiRuntimeSettings } from './ai-settings.service.js';

export type AiCostStatus = 'estimated' | 'unpriced' | 'reconciled';

interface UsageRow {
  period_start: string;
  input_tokens: string;
  output_tokens: string;
  embedding_tokens: string;
  total_tokens: string;
  reserved_tokens: string;
  estimated_cost_vnd: string;
}

interface BreakdownRow {
  operation: AiOperation;
  total_tokens: string;
  estimated_cost_vnd: string;
  event_count: string;
  unpriced_event_count: string;
}

interface DailyRow {
  day: string;
  total_tokens: string;
  estimated_cost_vnd: string;
  event_count: string;
}

interface PricingRateCardRow {
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
  status: 'draft' | 'active' | 'retired';
  created_at: string;
  updated_at: string;
}

export interface AiPricingRateCardInput {
  provider: AiProvider;
  model: string;
  inputVndPer1M: string;
  outputVndPer1M: string;
  embeddingVndPer1M: string;
  sourceUrl?: string | null;
  sourceNote?: string | null;
}

function toDecimalString(value: string, field: string): string {
  const trimmed = value.trim();
  if (!/^\d+(?:\.\d{1,4})?$/.test(trimmed)) {
    throw new AppError(`${field} phải là số tiền VND không âm, tối đa 4 chữ số thập phân.`, 400, 'AI_PRICING_RATE_INVALID');
  }
  return trimmed;
}

function mapRateCard(row: PricingRateCardRow) {
  return {
    id: row.id,
    provider: row.provider,
    model: row.model,
    inputVndPer1M: row.input_vnd_per_1m,
    outputVndPer1M: row.output_vnd_per_1m,
    embeddingVndPer1M: row.embedding_vnd_per_1m,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    sourceUrl: row.source_url,
    sourceNote: row.source_note,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getTenantAiOverview(tenantId: string) {
  const runtime = await getTenantAiRuntimeSettings(tenantId);
  const periodStart = currentAiUsagePeriodStart(runtime.tokenTimezone);
  await query(
    `INSERT INTO ai_token_monthly_usage (tenant_id, period_start)
     VALUES ($1, $2::date)
     ON CONFLICT (tenant_id, period_start) DO NOTHING`,
    [tenantId, periodStart],
  );

  const [usageResult, breakdownResult, dailyResult] = await Promise.all([
    query<UsageRow>(
      `SELECT period_start::text, input_tokens::text, output_tokens::text,
              embedding_tokens::text, total_tokens::text, reserved_tokens::text,
              estimated_cost_vnd::text
       FROM ai_token_monthly_usage
       WHERE tenant_id = $1 AND period_start = $2::date`,
      [tenantId, periodStart],
    ),
    query<BreakdownRow>(
      `SELECT operation,
              SUM(total_tokens)::bigint::text AS total_tokens,
              SUM(estimated_cost_vnd)::numeric::text AS estimated_cost_vnd,
              COUNT(*)::bigint::text AS event_count,
              COUNT(*) FILTER (WHERE cost_status = 'unpriced')::bigint::text AS unpriced_event_count
       FROM ai_token_usage_ledger
       WHERE tenant_id = $1 AND period_start = $2::date
       GROUP BY operation
       ORDER BY operation ASC`,
      [tenantId, periodStart],
    ),
    query<DailyRow>(
      `SELECT to_char(created_at AT TIME ZONE $3, 'YYYY-MM-DD') AS day,
              SUM(total_tokens)::bigint::text AS total_tokens,
              SUM(estimated_cost_vnd)::numeric::text AS estimated_cost_vnd,
              COUNT(*)::bigint::text AS event_count
       FROM ai_token_usage_ledger
       WHERE tenant_id = $1 AND period_start = $2::date
       GROUP BY to_char(created_at AT TIME ZONE $3, 'YYYY-MM-DD')
       ORDER BY day ASC`,
      [tenantId, periodStart, runtime.tokenTimezone],
    ),
  ]);
  const usage = usageResult.rows[0] ?? {
    period_start: periodStart,
    input_tokens: '0',
    output_tokens: '0',
    embedding_tokens: '0',
    total_tokens: '0',
    reserved_tokens: '0',
    estimated_cost_vnd: '0',
  };
  const limit = runtime.monthlyTokenLimit === null ? null : BigInt(runtime.monthlyTokenLimit);
  const used = BigInt(usage.total_tokens);
  const reserved = BigInt(usage.reserved_tokens);
  const remaining = limit === null ? null : String(limit > used + reserved ? limit - used - reserved : 0n);
  const unpricedEvents = breakdownResult.rows.reduce(
    (sum, row) => sum + Number(row.unpriced_event_count ?? 0),
    0,
  );

  return {
    periodStart: usage.period_start.slice(0, 10),
    tokenTimezone: runtime.tokenTimezone,
    quota: {
      monthlyLimit: runtime.monthlyTokenLimit,
      inputUsed: usage.input_tokens,
      outputUsed: usage.output_tokens,
      embeddingUsed: usage.embedding_tokens,
      totalUsed: usage.total_tokens,
      reserved: usage.reserved_tokens,
      remaining,
    },
    cost: {
      currency: 'VND' as const,
      estimatedVnd: usage.estimated_cost_vnd,
      hasUnpricedUsage: unpricedEvents > 0,
      unpricedEventCount: String(unpricedEvents),
    },
    breakdown: breakdownResult.rows.map((row) => ({
      operation: row.operation,
      totalTokens: row.total_tokens,
      estimatedVnd: row.estimated_cost_vnd,
      eventCount: row.event_count,
      unpricedEventCount: row.unpriced_event_count,
    })),
    daily: dailyResult.rows.map((row) => ({
      day: row.day,
      totalTokens: row.total_tokens,
      estimatedVnd: row.estimated_cost_vnd,
      eventCount: row.event_count,
    })),
  };
}

export async function listAiPricingRateCards(options: { activeOnly?: boolean } = {}) {
  const result = await query<PricingRateCardRow>(
    `SELECT id::text, provider, model,
            input_vnd_per_1m::text, output_vnd_per_1m::text, embedding_vnd_per_1m::text,
            effective_from::text, effective_to::text, source_url, source_note, status,
            created_at::text, updated_at::text
     FROM ai_pricing_rate_cards
     ${options.activeOnly ? "WHERE status = 'active'" : ''}
     ORDER BY provider ASC, model ASC, effective_from DESC, created_at DESC`,
  );
  return result.rows.map(mapRateCard);
}

/**
 * Rate cards are append-only from the UI. An immediately active replacement
 * retires the previous active card for the same provider/model before insert.
 */
export async function createAiPricingRateCard(input: AiPricingRateCardInput, createdBy: string) {
  const model = input.model.trim();
  if (!model || model.length > 100) {
    throw new AppError('Tên model không hợp lệ.', 400, 'AI_PRICING_MODEL_INVALID');
  }
  const sourceUrl = input.sourceUrl?.trim() || null;
  if (sourceUrl && !/^https:\/\//i.test(sourceUrl)) {
    throw new AppError('Nguồn bảng giá phải là URL HTTPS hợp lệ.', 400, 'AI_PRICING_SOURCE_URL_INVALID');
  }
  const sourceNote = input.sourceNote?.trim() || null;
  if (sourceNote && sourceNote.length > 500) {
    throw new AppError('Ghi chú bảng giá tối đa 500 ký tự.', 400, 'AI_PRICING_SOURCE_NOTE_INVALID');
  }

  return withDatabaseTransaction(async () => {
    // Serialize replacements for one provider/model so the rate-card history
    // remains unambiguous even when two superadmins save concurrently.
    await query(
      `SELECT pg_advisory_xact_lock(hashtext($1))`,
      [`ai_pricing_rate_card:${input.provider}:${model}`],
    );
    await query(
      `UPDATE ai_pricing_rate_cards
       SET status = 'retired', effective_to = now()
       WHERE provider = $1
         AND model = $2
         AND status = 'active'
         AND effective_from <= now()
         AND (effective_to IS NULL OR effective_to > now())`,
      [input.provider, model],
    );
    const result = await query<PricingRateCardRow>(
      `INSERT INTO ai_pricing_rate_cards (
         provider, model, input_vnd_per_1m, output_vnd_per_1m, embedding_vnd_per_1m,
         source_url, source_note, status, created_by
       )
       VALUES ($1, $2, $3::numeric, $4::numeric, $5::numeric, $6, $7, 'active', $8)
       RETURNING id::text, provider, model,
                 input_vnd_per_1m::text, output_vnd_per_1m::text, embedding_vnd_per_1m::text,
                 effective_from::text, effective_to::text, source_url, source_note, status,
                 created_at::text, updated_at::text`,
      [
        input.provider,
        model,
        toDecimalString(input.inputVndPer1M, 'Giá input'),
        toDecimalString(input.outputVndPer1M, 'Giá output'),
        toDecimalString(input.embeddingVndPer1M, 'Giá embedding'),
        sourceUrl,
        sourceNote,
        createdBy,
      ],
    );
    return mapRateCard(result.rows[0]);
  });
}
