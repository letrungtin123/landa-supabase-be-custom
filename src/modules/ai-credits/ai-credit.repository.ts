// SQL of the AI credit month (ai_credit_monthly). Every function runs inside
// the caller's transaction when there is one (config/database `query`).
// Lock order: the tenant's monthly token row (ai_token_monthly_usage) is
// always locked before its credit row, in every path (reserve, settle,
// release, expire), so no new lock cycle is created.
import { query } from '../../config/database.js';

/** Plan of a tenant without an account row (a tenant created after 20261017_2030). */
export const AI_CREDIT_DEFAULT_PLAN_CODE = 'demo_unlimited';

const ensured = new Set<string>();

/** Test hook. */
export function forgetEnsuredCreditMonths(): void {
  ensured.clear();
}

/**
 * Creates the tenant's credit row of a month from its current plan and the
 * latest FX rate of that month or before (a no-op when the row exists).
 * Remembered per process so the hot path pays for it once a month.
 */
export async function ensureCreditMonth(tenantId: string, periodStart: string): Promise<void> {
  const key = `${tenantId}\u0000${periodStart}`;
  if (ensured.has(key)) return;
  await query(
    `INSERT INTO ai_credit_monthly (tenant_id, period_start, plan_id, plan_points, topup_points, is_unlimited,
       fx_vnd_per_usd, point_value_usd, budget_usd, revenue_vnd)
     SELECT $1::uuid, $2::date, p.id, p.monthly_points, coalesce(t.points, 0), p.is_unlimited,
            fx.vnd_per_usd, v.point_value,
            CASE WHEN p.is_unlimited OR v.point_value IS NULL THEN NULL
                 ELSE round(v.point_value * (p.monthly_points + coalesce(t.points, 0)), 6) END,
            p.monthly_price_vnd + coalesce(t.price_vnd, 0)
     FROM ai_credit_plans p
     LEFT JOIN LATERAL (SELECT vnd_per_usd FROM ai_fx_rates WHERE month <= $2::date ORDER BY month DESC LIMIT 1) fx ON true
     LEFT JOIN LATERAL (SELECT sum(points)::bigint AS points, sum(coalesce(price_vnd, 0)) AS price_vnd
                        FROM ai_credit_topups WHERE tenant_id = $1::uuid AND period_start = $2::date) t ON true
     CROSS JOIN LATERAL (SELECT CASE WHEN fx.vnd_per_usd IS NULL OR p.monthly_price_vnd = 0 THEN NULL
       ELSE round(p.monthly_price_vnd * p.provider_cost_ratio * (1 - p.safety_buffer_ratio) / fx.vnd_per_usd / p.monthly_points, 10)
       END AS point_value) v
     WHERE p.id = coalesce(
       (SELECT plan_id FROM ai_credit_accounts WHERE tenant_id = $1::uuid),
       (SELECT id FROM ai_credit_plans WHERE code = $3::text))
     ON CONFLICT (tenant_id, period_start) DO NOTHING`,
    [tenantId, periodStart, AI_CREDIT_DEFAULT_PLAN_CODE],
  );
  ensured.add(key);
}

/**
 * Re-derives a month from the tenant's current plan, top-ups and FX rate
 * (after the superadmin changes one of them). Usage and reservations are kept.
 */
export async function recomputeCreditMonth(tenantId: string, periodStart: string): Promise<void> {
  await ensureCreditMonth(tenantId, periodStart);
  await query(
    `UPDATE ai_credit_monthly m
     SET plan_id = p.id, plan_points = p.monthly_points, topup_points = coalesce(t.points, 0),
         is_unlimited = p.is_unlimited, fx_vnd_per_usd = fx.vnd_per_usd, point_value_usd = v.point_value,
         budget_usd = CASE WHEN p.is_unlimited OR v.point_value IS NULL THEN NULL
                           ELSE round(v.point_value * (p.monthly_points + coalesce(t.points, 0)), 6) END,
         revenue_vnd = p.monthly_price_vnd + coalesce(t.price_vnd, 0),
         revision = m.revision + 1
     FROM ai_credit_plans p
     LEFT JOIN LATERAL (SELECT vnd_per_usd FROM ai_fx_rates WHERE month <= $2::date ORDER BY month DESC LIMIT 1) fx ON true
     LEFT JOIN LATERAL (SELECT sum(points)::bigint AS points, sum(coalesce(price_vnd, 0)) AS price_vnd
                        FROM ai_credit_topups WHERE tenant_id = $1::uuid AND period_start = $2::date) t ON true
     CROSS JOIN LATERAL (SELECT CASE WHEN fx.vnd_per_usd IS NULL OR p.monthly_price_vnd = 0 THEN NULL
       ELSE round(p.monthly_price_vnd * p.provider_cost_ratio * (1 - p.safety_buffer_ratio) / fx.vnd_per_usd / p.monthly_points, 10)
       END AS point_value) v
     WHERE m.tenant_id = $1::uuid AND m.period_start = $2::date
       AND p.id = coalesce((SELECT plan_id FROM ai_credit_accounts WHERE tenant_id = $1::uuid),
                           (SELECT id FROM ai_credit_plans WHERE code = $3::text))`,
    [tenantId, periodStart, AI_CREDIT_DEFAULT_PLAN_CODE],
  );
}

export type CreditReservation = 'reserved' | 'insufficient' | 'missing';

/**
 * Holds USD against the month's budget in one conditional UPDATE: concurrent
 * calls can never hold more than the budget. `allowOverdraft` (tasks of an AI
 * ID run admitted with enough points) always succeeds. 'missing' means the
 * month row does not exist (e.g. its creation was rolled back): ensure it again.
 */
export async function reserveCreditUsd(tenantId: string, periodStart: string, costUsd: number, allowOverdraft: boolean): Promise<CreditReservation> {
  const result = await query<{ updated: number; present: boolean }>(
    `WITH held AS (
       UPDATE ai_credit_monthly
       SET reserved_usd = reserved_usd + $3::numeric, revision = revision + 1
       WHERE tenant_id = $1::uuid AND period_start = $2::date
         AND ($4::boolean OR budget_usd IS NULL OR budget_usd - used_usd - reserved_usd >= $3::numeric)
       RETURNING 1
     )
     SELECT (SELECT count(*) FROM held)::int AS updated,
            EXISTS (SELECT 1 FROM ai_credit_monthly WHERE tenant_id = $1::uuid AND period_start = $2::date) AS present`,
    [tenantId, periodStart, costUsd, allowOverdraft],
  );
  const row = result.rows[0];
  if (row && row.updated === 1) return 'reserved';
  return row?.present ? 'insufficient' : 'missing';
}

/** Forget that a month was ensured (its creation may have been rolled back). */
export function forgetEnsuredCreditMonth(tenantId: string, periodStart: string): void {
  ensured.delete(`${tenantId}\u0000${periodStart}`);
}

export interface CreditSettlement {
  budgetUsd: number | null;
  usedUsd: number;
  warned80: boolean;
  warned100: boolean;
}

/** Moves a reservation's hold to used USD (the call's real cost). */
export async function settleCreditUsd(tenantId: string, periodStart: string, reservedUsd: number, actualUsd: number): Promise<CreditSettlement | null> {
  const result = await query<{ budget_usd: string | null; used_usd: string; warned_80: boolean; warned_100: boolean }>(
    `UPDATE ai_credit_monthly
     SET used_usd = used_usd + $4::numeric, reserved_usd = GREATEST(0, reserved_usd - $3::numeric), revision = revision + 1
     WHERE tenant_id = $1::uuid AND period_start = $2::date
     RETURNING budget_usd::text, used_usd::text, warned_80_at IS NOT NULL AS warned_80, warned_100_at IS NOT NULL AS warned_100`,
    [tenantId, periodStart, reservedUsd, actualUsd],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { budgetUsd: row.budget_usd === null ? null : Number(row.budget_usd), usedUsd: Number(row.used_usd),
    warned80: row.warned_80, warned100: row.warned_100 };
}

/** Returns a reservation's hold (the call did not happen or did not finish). */
export async function releaseCreditUsd(tenantId: string, periodStart: string, reservedUsd: number): Promise<void> {
  if (!(reservedUsd > 0)) return;
  await query(
    `UPDATE ai_credit_monthly
     SET reserved_usd = GREATEST(0, reserved_usd - $3::numeric), revision = revision + 1
     WHERE tenant_id = $1::uuid AND period_start = $2::date`,
    [tenantId, periodStart, reservedUsd],
  );
}

/** Records once per month that the 80% / 100% mark was crossed; true for the first caller only. */
export async function markCreditThreshold(tenantId: string, periodStart: string, level: 80 | 100): Promise<boolean> {
  const column = level === 100 ? 'warned_100_at' : 'warned_80_at';
  const result = await query<{ ok: number }>(
    `UPDATE ai_credit_monthly SET ${column} = now() WHERE tenant_id = $1::uuid AND period_start = $2::date AND ${column} IS NULL RETURNING 1 AS ok`,
    [tenantId, periodStart],
  );
  return result.rows.length === 1;
}
