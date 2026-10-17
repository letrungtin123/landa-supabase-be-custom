// AI points: customers see points; inside, every AI call is priced in USD on
// the provider's real cost (ai-pricing.service). A plan fixes what one point
// is worth in provider USD, so the margin holds whatever features a tenant
// uses (plan AI_CREDIT_LIMIT_PLAN_2026-10-17.md §4, §8-§9).

export interface AiCreditPlanPricing {
  monthlyPriceVnd: number;
  monthlyPoints: number;
  /** Share of the price that may go to the provider (0.5 = half). */
  providerCostRatio: number;
  /** Kept back for FX moves, card fees and estimate drift (0.10 = 10%). */
  safetyBufferRatio: number;
}

const USD_DECIMALS = 1_000_000;

export function roundUsd(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value * USD_DECIMALS) / USD_DECIMALS;
}

/**
 * Provider USD covered by one point:
 * price x cost ratio x (1 - buffer) / FX / points. Null when there is no FX
 * rate or the plan is free (points cannot be valued, limits are not enforced).
 */
export function pointValueUsd(plan: AiCreditPlanPricing, fxVndPerUsd: number | null): number | null {
  if (!fxVndPerUsd || !(fxVndPerUsd > 0) || !(plan.monthlyPriceVnd > 0) || !(plan.monthlyPoints > 0)) return null;
  const value = plan.monthlyPriceVnd * plan.providerCostRatio * (1 - plan.safetyBufferRatio) / fxVndPerUsd / plan.monthlyPoints;
  return Number.isFinite(value) && value > 0 ? Math.round(value * 1e10) / 1e10 : null;
}

/** The month's spendable USD, or null when nothing is enforced. */
export function monthBudgetUsd(input: {
  isUnlimited: boolean;
  pointValueUsd: number | null;
  planPoints: number;
  topupPoints: number;
}): number | null {
  if (input.isUnlimited || input.pointValueUsd === null) return null;
  return roundUsd(input.pointValueUsd * (input.planPoints + input.topupPoints));
}

/** Points shown to the customer for an amount of provider USD (one decimal, never negative). */
export function pointsFromUsd(usd: number, pointValue: number | null): number | null {
  if (pointValue === null || !(pointValue > 0)) return null;
  const points = Math.max(0, usd) / pointValue;
  return Math.round(points * 10) / 10;
}

export type AiCreditState = 'unlimited' | 'unvalued' | 'ok' | 'warning' | 'exhausted';

/** How full the month is: warning from 80%, exhausted when nothing is left to reserve. */
export function aiCreditState(input: {
  isUnlimited: boolean;
  pointValueUsd: number | null;
  budgetUsd: number | null;
  usedUsd: number;
  reservedUsd: number;
}): { state: AiCreditState; percent: number | null } {
  if (input.isUnlimited) return { state: 'unlimited', percent: null };
  if (input.pointValueUsd === null || input.budgetUsd === null) return { state: 'unvalued', percent: null };
  if (input.budgetUsd <= 0) return { state: 'exhausted', percent: 100 };
  const percent = Math.min(100, Math.round(((input.usedUsd + input.reservedUsd) / input.budgetUsd) * 1000) / 10);
  if (input.usedUsd + input.reservedUsd >= input.budgetUsd) return { state: 'exhausted', percent: 100 };
  return { state: percent >= 80 ? 'warning' : 'ok', percent };
}

/** First day of the month of a date, as YYYY-MM-DD (UTC calendar of the caller's period). */
export function monthStart(period: string): string {
  const match = /^(\d{4})-(\d{2})/.exec(period);
  if (!match) throw new Error('AI_CREDIT_PERIOD_INVALID');
  return `${match[1]}-${match[2]}-01`;
}

/** "2026-10" for a period start. */
export function monthKey(periodStart: string): string {
  return monthStart(periodStart).slice(0, 7);
}

/** The first day of the next month (when the points renew). */
export function nextMonthStart(periodStart: string): string {
  const [year, month] = monthStart(periodStart).split('-').map(Number) as [number, number];
  const next = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
  return `${next.year}-${String(next.month).padStart(2, '0')}-01`;
}
