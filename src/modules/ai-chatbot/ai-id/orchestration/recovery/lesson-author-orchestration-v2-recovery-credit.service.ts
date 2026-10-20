// AI points check before an author rewrite of missing lessons. Admission-style:
// the rewrite is refused only when the estimate says the month cannot cover it;
// the real charge stays the normal reserve/settle/release (upper bound for an
// unknown outcome) of every reopened lesson, and a rewrite that fails again is
// charged by its actual usage.
//
// Estimate = median cost of one generate_unit task over the last 60 days (this
// tenant with >= 3 measured lessons, else every tenant, else the configured
// fallback) x 1.3 x lessons. The per-lesson median is cached in Redis for 10
// minutes per tenant (TTL is its only invalidation: it is a statistic, and an
// admitted rewrite never depends on it being fresh).

import { query as defaultQuery } from '../../../../../config/database.js';
import { cacheJson, cacheKey } from '../../../../../config/cache.js';
import { availableAiCreditUsd } from '../../../../ai-credits/ai-credit.service.js';
import { OrchestrationV2RecoveryError } from './lesson-author-orchestration-v2-recovery.logic.js';

export const ORCHESTRATION_V2_RECOVERY_COST_MARGIN = 1.3;
export const ORCHESTRATION_V2_RECOVERY_COST_TTL_SECONDS = 600;
const MIN_SAMPLES = 3;
const UUID_TEXT = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

type Query = <T extends Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;

export interface OrchestrationV2RecoveryCreditDependencies {
  query?: Query;
  cache?: <T>(key: string, ttlSeconds: number, loader: () => Promise<T>) => Promise<T>;
  /** Remaining USD of the current credit month; null when unlimited or not valued. */
  available?: (tenantId: string) => Promise<number | null>;
  fallbackUnitCostUsd(): number;
}

/** Per-lesson base cost (before margin) from measured generate_unit ledger rows. */
export function orchestrationV2UnitCostBase(row: { tenant_median: unknown; tenant_units: unknown;
  global_median: unknown; global_units: unknown } | undefined, fallbackUsd: number): number {
  const positive = (value: unknown) => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
  };
  const tenant = row && Number(row.tenant_units) >= MIN_SAMPLES ? positive(row.tenant_median) : null;
  const global = row && Number(row.global_units) >= MIN_SAMPLES ? positive(row.global_median) : null;
  return tenant ?? global ?? fallbackUsd;
}

export function orchestrationV2RecoveryEstimateUsd(baseUnitUsd: number, unitCount: number): number {
  if (!Number.isSafeInteger(unitCount) || unitCount < 0 || !Number.isFinite(baseUnitUsd) || baseUnitUsd < 0) {
    throw new OrchestrationV2RecoveryError('RECOVERY_UNAVAILABLE');
  }
  return Math.round(baseUnitUsd * ORCHESTRATION_V2_RECOVERY_COST_MARGIN * unitCount * 1e6) / 1e6;
}

export function createOrchestrationV2RecoveryCredit(deps: OrchestrationV2RecoveryCreditDependencies) {
  const query = deps.query ?? (defaultQuery as unknown as Query);
  const cache = deps.cache ?? cacheJson;
  const available = deps.available ?? availableAiCreditUsd;

  async function unitCostUsd(tenantId: string): Promise<number> {
    const cached = await cache(cacheKey('lesson-author-recovery', 'unit-cost-usd', tenantId),
      ORCHESTRATION_V2_RECOVERY_COST_TTL_SECONDS, async () => {
        const result = await query<{ tenant_median: string | null; tenant_units: number;
          global_median: string | null; global_units: number }>(`WITH units AS (
            SELECT ledger.tenant_id,task.id AS task_id,sum(ledger.estimated_cost_usd) AS cost
            FROM ai_token_usage_ledger ledger
            JOIN lesson_author_workspace_v2_tasks task ON task.id=(CASE
                WHEN ledger.metadata->>'orchestration_task_id' ~ $2
                THEN (ledger.metadata->>'orchestration_task_id')::uuid END)
              AND task.tenant_id=ledger.tenant_id AND task.kind='generate_unit'
            WHERE ledger.operation='lesson_author' AND ledger.metadata ? 'orchestration_task_id'
              AND ledger.created_at>now()-interval '60 days'
            GROUP BY ledger.tenant_id,task.id
          )
          SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY cost) FILTER (WHERE tenant_id=$1::uuid) AS tenant_median,
            (count(*) FILTER (WHERE tenant_id=$1::uuid))::int AS tenant_units,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY cost) AS global_median,
            count(*)::int AS global_units
          FROM units`, [tenantId, UUID_TEXT]);
        return { base_usd: orchestrationV2UnitCostBase(result.rows[0], deps.fallbackUnitCostUsd()) };
      });
    return cached.base_usd;
  }

  /** Estimated USD of rewriting `unitCount` lessons; refuses (429) when the month cannot cover it. */
  async function assertAffordable(tenantId: string, unitCount: number): Promise<number> {
    const estimate = orchestrationV2RecoveryEstimateUsd(await unitCostUsd(tenantId), unitCount);
    const remaining = await available(tenantId);
    if (remaining !== null && remaining < estimate) {
      throw new OrchestrationV2RecoveryError('AI_CREDIT_INSUFFICIENT_FOR_RECOVERY');
    }
    return estimate;
  }

  return { unitCostUsd, assertAffordable };
}
