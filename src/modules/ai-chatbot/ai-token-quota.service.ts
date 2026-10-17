import { query, withDatabaseTransaction } from '../../config/database.js';
import { env } from '../../config/env.js';
import { AppError } from '../../middleware/error-handler.js';
import type { AiChatTarget, AiEngine, AiOperation, AiProvider, AiUsage } from './ai-engine.types.js';
import { calculateAiUsageCost } from './ai-pricing.service.js';
import { aiLedgerFeature } from './ai-usage.logic.js';
import { currentAiUsagePeriodStart, getTenantAiRuntimeSettings } from './ai-settings.service.js';

export const AI_TOKEN_LIMIT_REACHED_CODE = 'AI_TOKEN_LIMIT_REACHED';

interface ReservationBudget {
  inputTokens?: number;
  outputTokens?: number;
  embeddingTokens?: number;
  maxOutputTokens?: number;
  metadata?: Record<string, unknown>;
}

interface ReservationInput {
  tenantId: string;
  userId: string | null;
  conversationId: string | null;
  target: AiChatTarget;
  engine: AiEngine;
  provider: AiProvider;
  model: string;
  operation: AiOperation;
  /** Legacy single reservation value. New callers should provide min/max. */
  estimatedTokens?: number;
  minimumTokens?: number;
  maximumTokens?: number;
  budget?: ReservationBudget;
}

interface FinalizeInput {
  reservationId: string;
  tenantId: string;
  usage: AiUsage;
  embeddingModel?: string | null;
  source?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

interface ReservationRow {
  id: string;
  period_start: string;
  estimated_tokens: string;
  user_id: string | null;
  conversation_id: string | null;
  target: AiChatTarget;
  engine: AiEngine;
  provider: AiProvider;
  model: string;
  operation: AiOperation;
}

export interface AiTokenReservationGrant {
  id: string;
  reservedTokens: number;
  minimumTokens: number;
  maximumTokens: number;
  remainingTokens: string | null;
  isPartialGrant: boolean;
}

function toSafePositiveInteger(value: number | null | undefined): number {
  if (!Number.isFinite(value ?? NaN)) return 1;
  return Math.max(1, Math.min(2_000_000, Math.ceil(value ?? 1)));
}

function toSafeNonNegativeInteger(value: number | null | undefined): number {
  if (!Number.isFinite(value ?? NaN)) return 0;
  return Math.max(0, Math.min(2_000_000, Math.ceil(value ?? 0)));
}

/**
 * This remains deliberately conservative. Provider-side usage metadata is the
 * source of truth at finalization, while this budget prevents concurrent calls
 * from consuming the tenant's remaining monthly quota first.
 */
export function estimateTokensFromText(...parts: Array<string | null | undefined>): number {
  const chars = parts.reduce((total, part) => total + (part?.length ?? 0), 0);
  return toSafePositiveInteger(chars / 3);
}

export function normalizeAiUsage(input: Partial<AiUsage> | null | undefined): AiUsage {
  const inputTokens = toSafeNonNegativeInteger(input?.inputTokens);
  const outputTokens = toSafeNonNegativeInteger(input?.outputTokens);
  const embeddingTokens = toSafeNonNegativeInteger(input?.embeddingTokens);
  const totalTokens = Math.max(
    0,
    toSafeNonNegativeInteger(input?.totalTokens ?? inputTokens + outputTokens + embeddingTokens),
  );
  const cachedInputTokens = Math.min(inputTokens, toSafeNonNegativeInteger(input?.cachedInputTokens));
  return {
    inputTokens,
    outputTokens,
    embeddingTokens,
    totalTokens,
    ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
  };
}

function tokenLimitError(): AppError {
  return new AppError(
    'Hạn mức dùng AI đã chạm ngưỡng, vui lòng liên hệ quản trị viên.',
    429,
    AI_TOKEN_LIMIT_REACHED_CODE,
  );
}

function reservationBounds(input: ReservationInput): { minimumTokens: number; maximumTokens: number } {
  const fallback = input.estimatedTokens ?? input.maximumTokens ?? input.minimumTokens;
  const minimumTokens = toSafePositiveInteger(input.minimumTokens ?? fallback);
  const maximumTokens = Math.max(
    minimumTokens,
    toSafePositiveInteger(input.maximumTokens ?? input.estimatedTokens ?? minimumTokens),
  );
  return { minimumTokens, maximumTokens };
}

export async function expireTenantAiTokenReservations(batchSize = 500): Promise<number> {
  const safeBatchSize = Math.max(1, Math.min(Math.floor(batchSize), 5_000));
  const result = await query<{ expired_count: string }>(
    `WITH expired AS (
       SELECT id
       FROM ai_token_reservations
       WHERE status = 'reserved'
         AND expires_at <= now()
         -- Durable jobs settle or release explicitly. An uncertain paid call
         -- remains held for reconciliation, even if its job is later deleted.
         AND budget_metadata ->> 'durable_generation' IS DISTINCT FROM 'true'
       ORDER BY expires_at ASC, id ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     ),
     updated_reservations AS (
       UPDATE ai_token_reservations reservation
       SET status = 'expired'
       FROM expired
       WHERE reservation.id = expired.id
       RETURNING reservation.tenant_id, reservation.period_start, reservation.estimated_tokens
     ),
     summed AS (
       SELECT tenant_id, period_start, SUM(estimated_tokens)::bigint AS estimated_tokens
       FROM updated_reservations
       GROUP BY tenant_id, period_start
     ),
     updated_usage AS (
       UPDATE ai_token_monthly_usage usage
       SET reserved_tokens = GREATEST(0, usage.reserved_tokens - summed.estimated_tokens),
           revision = revision + 1
       FROM summed
       WHERE usage.tenant_id = summed.tenant_id
         AND usage.period_start = summed.period_start
       RETURNING usage.tenant_id
     )
     SELECT COUNT(*)::bigint::text AS expired_count
     FROM updated_reservations`,
    [safeBatchSize],
  );
  return Number(result.rows[0]?.expired_count ?? 0);
}

/**
 * Atomically grants up to maximumTokens but never below minimumTokens. This is
 * what enables a concise answer when a tenant has a small usable balance left.
 */
export async function reserveTenantAiTokens(input: ReservationInput): Promise<AiTokenReservationGrant> {
  const { minimumTokens, maximumTokens } = reservationBounds(input);
  await expireTenantAiTokenReservations().catch((error) => {
    console.warn('[AI Token Quota] Failed to expire stale reservations before reserve:', error instanceof Error ? error.message : String(error));
  });
  const settings = await getTenantAiRuntimeSettings(input.tenantId);
  const periodStart = currentAiUsagePeriodStart(settings.tokenTimezone);
  return withDatabaseTransaction(async () => {
    await query(
      `INSERT INTO ai_token_monthly_usage (tenant_id, period_start)
       VALUES ($1, $2::date)
       ON CONFLICT (tenant_id, period_start) DO NOTHING`,
      [input.tenantId, periodStart],
    );
    const usage = await query<{
      total_tokens: string;
      reserved_tokens: string;
      monthly_token_limit: string | null;
    }>(
      `SELECT usage.total_tokens::text, usage.reserved_tokens::text, settings.monthly_token_limit::text
       FROM ai_token_monthly_usage usage
       JOIN tenant_ai_settings settings ON settings.tenant_id = usage.tenant_id
       WHERE usage.tenant_id = $1 AND usage.period_start = $2::date
       FOR UPDATE OF usage, settings`,
      [input.tenantId, periodStart],
    );
    const row = usage.rows[0];
    if (!row) throw new AppError('Không tìm thấy thống kê token AI', 404, 'AI_TOKEN_USAGE_NOT_FOUND');

    let grantedTokens = maximumTokens;
    let remainingTokens: string | null = null;
    if (row.monthly_token_limit !== null) {
      const limit = BigInt(row.monthly_token_limit);
      const consumed = BigInt(row.total_tokens) + BigInt(row.reserved_tokens);
      const available = limit > consumed ? limit - consumed : 0n;
      if (available < BigInt(minimumTokens)) throw tokenLimitError();
      const maximum = BigInt(maximumTokens);
      const granted = available < maximum ? available : maximum;
      grantedTokens = Number(granted);
      remainingTokens = String(available - granted);
    }

    const budget = input.budget ?? {};
    const fixedBudgetTokens = toSafeNonNegativeInteger(budget.inputTokens)
      + toSafeNonNegativeInteger(budget.embeddingTokens);
    const requestedOutputBudget = toSafeNonNegativeInteger(budget.outputTokens);
    const grantedOutputBudget = Math.max(0, Math.min(
      requestedOutputBudget,
      grantedTokens - fixedBudgetTokens,
    ));
    const grantedMaxOutputTokens = budget.maxOutputTokens === undefined
      ? null
      : Math.max(0, Math.min(toSafeNonNegativeInteger(budget.maxOutputTokens), grantedOutputBudget));
    const inserted = await query<{ id: string }>(
      `INSERT INTO ai_token_reservations (
         tenant_id, user_id, conversation_id, target, engine, provider, model,
         operation, period_start, estimated_tokens,
         budget_input_tokens, budget_output_tokens, budget_embedding_tokens,
         max_output_tokens, budget_metadata, expires_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::date, $10::bigint,
               $11::bigint, $12::bigint, $13::bigint, $14::int, $15::jsonb,
               now() + ($16::int * interval '1 second'))
       RETURNING id::text AS id`,
      [
        input.tenantId,
        input.userId,
        input.conversationId,
        input.target,
        input.engine,
        input.provider,
        input.model,
        input.operation,
        periodStart,
        grantedTokens,
        toSafeNonNegativeInteger(budget.inputTokens),
        grantedOutputBudget,
        toSafeNonNegativeInteger(budget.embeddingTokens),
        grantedMaxOutputTokens,
        JSON.stringify(budget.metadata ?? {}),
        env.AI_TOKEN_RESERVATION_SECONDS,
      ],
    );
    await query(
      `UPDATE ai_token_monthly_usage
       SET reserved_tokens = reserved_tokens + $3::bigint,
           revision = revision + 1
       WHERE tenant_id = $1 AND period_start = $2::date`,
      [input.tenantId, periodStart, grantedTokens],
    );
    return {
      id: inserted.rows[0].id,
      reservedTokens: grantedTokens,
      minimumTokens,
      maximumTokens,
      remainingTokens,
      isPartialGrant: grantedTokens < maximumTokens,
    };
  });
}

export async function finalizeTenantAiTokens(input: FinalizeInput): Promise<void> {
  const usage = normalizeAiUsage(input.usage);
  await withDatabaseTransaction(async () => {
    const reservation = await query<ReservationRow>(
      `SELECT id::text, period_start::text, estimated_tokens::text, user_id::text,
              conversation_id::text, target, engine, provider, model, operation
       FROM ai_token_reservations
       WHERE id = $1 AND tenant_id = $2 AND status = 'reserved'
       FOR UPDATE`,
      [input.reservationId, input.tenantId],
    );
    const row = reservation.rows[0];
    if (!row) return;

    const pricing = await calculateAiUsageCost({
      provider: row.provider,
      model: row.model,
      embeddingModel: input.embeddingModel,
      usage,
    }).catch((error) => {
      console.warn('[AI Token Quota] Unable to resolve the price card:', error instanceof Error ? error.message : String(error));
      return fallbackUnpricedCost();
    });
    const reservedTokens = Number(row.estimated_tokens);
    const budgetOverageTokens = Math.max(0, usage.totalTokens - reservedTokens);
    if (budgetOverageTokens > 0) {
      console.error('[AI Token Quota] Provider usage exceeded its reservation budget', {
        tenant_id: input.tenantId,
        reservation_id: input.reservationId,
        reserved_tokens: reservedTokens,
        actual_tokens: usage.totalTokens,
      });
    }
    const metadata = {
      ...(input.metadata ?? {}),
      quota: {
        reserved_tokens: reservedTokens,
        ...(budgetOverageTokens > 0 ? { budget_overage_tokens: budgetOverageTokens } : {}),
      },
    };
    const cachedInputTokens = usage.cachedInputTokens ?? 0;
    const feature = aiLedgerFeature(input.metadata, row.operation);

    await query(
      `UPDATE ai_token_reservations
       SET status = 'finalized',
           actual_input_tokens = $3::bigint,
           actual_output_tokens = $4::bigint,
           actual_embedding_tokens = $5::bigint,
           actual_total_tokens = $6::bigint,
           finalized_at = now()
       WHERE id = $1 AND tenant_id = $2`,
      [
        input.reservationId,
        input.tenantId,
        usage.inputTokens,
        usage.outputTokens,
        usage.embeddingTokens,
        usage.totalTokens,
      ],
    );
    await query(
      `UPDATE ai_token_monthly_usage
       SET input_tokens = input_tokens + $3::bigint,
           output_tokens = output_tokens + $4::bigint,
           embedding_tokens = embedding_tokens + $5::bigint,
           total_tokens = total_tokens + $6::bigint,
           reserved_tokens = GREATEST(0, reserved_tokens - $7::bigint),
           estimated_cost_vnd = estimated_cost_vnd + $8::numeric,
           estimated_cost_usd = estimated_cost_usd + $9::numeric,
           cached_input_tokens = cached_input_tokens + $10::bigint,
           revision = revision + 1
       WHERE tenant_id = $1 AND period_start = $2::date`,
      [
        input.tenantId,
        row.period_start,
        usage.inputTokens,
        usage.outputTokens,
        usage.embeddingTokens,
        usage.totalTokens,
        row.estimated_tokens,
        pricing.amountVnd,
        pricing.amountUsd,
        cachedInputTokens,
      ],
    );
    // The acting user is copied into the row (actor_*): usage charts keep the
    // name after the user is deleted (user_id is then set to NULL).
    await query(
      `INSERT INTO ai_token_usage_ledger (
         reservation_id, tenant_id, user_id, conversation_id, target, engine,
         provider, model, operation, period_start, input_tokens, output_tokens,
         embedding_tokens, total_tokens, estimated_cost_usd, estimated_cost_vnd,
         source, metadata, pricing_snapshot, cost_status,
         cached_input_tokens, feature, actor_user_id, actor_name, actor_email
       )
       SELECT $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text, $6::text, $7::text, $8::text, $9::text, $10::date,
              $11::bigint, $12::bigint, $13::bigint, $14::bigint, $20::numeric,
              $15::numeric, $16::jsonb, $17::jsonb, $18::jsonb, $19::text,
              $21::bigint, $22::text, $3::uuid,
              left(coalesce(nullif(btrim(u.full_name), ''), nullif(btrim(u.username), '')), 255),
              left(nullif(btrim(u.email), ''), 320)
       FROM (SELECT 1) AS one
       LEFT JOIN users u ON u.id = $3::uuid`,
      [
        input.reservationId,
        input.tenantId,
        row.user_id,
        row.conversation_id,
        row.target,
        row.engine,
        row.provider,
        row.model,
        row.operation,
        row.period_start,
        usage.inputTokens,
        usage.outputTokens,
        usage.embeddingTokens,
        usage.totalTokens,
        pricing.amountVnd,
        JSON.stringify(input.source ?? {}),
        JSON.stringify(metadata),
        JSON.stringify(pricing.pricingSnapshot),
        pricing.status,
        pricing.amountUsd,
        cachedInputTokens,
        feature,
      ],
    );
  });
}

function fallbackUnpricedCost(): {
  amountUsd: number;
  amountVnd: number;
  status: 'unpriced';
  pricingSnapshot: Record<string, unknown>;
} {
  return {
    amountUsd: 0,
    amountVnd: 0,
    status: 'unpriced',
    pricingSnapshot: {
      version: 1,
      currency: 'VND',
      calculated_at: new Date().toISOString(),
      error: 'pricing_rate_card_unavailable',
    },
  };
}

export async function releaseTenantAiTokenReservation(
  reservationId: string | null | undefined,
  tenantId: string,
): Promise<void> {
  if (!reservationId) return;
  await withDatabaseTransaction(async () => {
    const reservation = await query<{ estimated_tokens: string; period_start: string }>(
      `SELECT estimated_tokens::text, period_start::text
       FROM ai_token_reservations
       WHERE id = $1 AND tenant_id = $2 AND status = 'reserved'
       FOR UPDATE`,
      [reservationId, tenantId],
    );
    const row = reservation.rows[0];
    if (!row) return;
    await query(
      `UPDATE ai_token_reservations
       SET status = 'released'
       WHERE id = $1 AND tenant_id = $2`,
      [reservationId, tenantId],
    );
    await query(
      `UPDATE ai_token_monthly_usage
       SET reserved_tokens = GREATEST(0, reserved_tokens - $3::bigint),
           revision = revision + 1
       WHERE tenant_id = $1 AND period_start = $2::date`,
      [tenantId, row.period_start, row.estimated_tokens],
    );
  });
}
