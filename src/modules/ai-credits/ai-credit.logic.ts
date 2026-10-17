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

/** Newest-first "YYYY-MM" list of months that have data, always with the current month, at most `limit`. */
export function availableMonths(periodStarts: readonly string[], currentPeriodStart: string, limit = 24): string[] {
  const current = monthKey(currentPeriodStart);
  const months = new Set([current, ...periodStarts.map(monthKey)].filter(month => month <= current));
  return [...months].sort().reverse().slice(0, limit);
}

/** A ledger day of the month: a day outside it (time zone changed later) counts on the nearest day of the month. */
export function clampDayToMonth(day: string, periodStart: string): string {
  const first = monthStart(periodStart);
  const [year, month] = first.split('-').map(Number) as [number, number];
  const last = `${first.slice(0, 8)}${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, '0')}`;
  return day < first ? first : day > last ? last : day;
}

/**
 * Splits a total of points (one decimal) over parts in proportion to their
 * USD, by largest remainder in tenths of a point, so the shown parts always
 * add up to the shown total. Null total (points cannot be valued) gives nulls.
 */
export function apportionPoints(totalPoints: number | null, weightsUsd: readonly number[]): Array<number | null> {
  if (totalPoints === null) return weightsUsd.map(() => null);
  if (weightsUsd.length === 0) return [];
  const units = Math.max(0, Math.round(totalPoints * 10));
  const weights = weightsUsd.map(weight => (Number.isFinite(weight) && weight > 0 ? weight : 0));
  const sum = weights.reduce((total, weight) => total + weight, 0);
  if (sum <= 0) return weights.map((_, index) => (index === 0 ? units / 10 : 0));
  const exact = weights.map(weight => (units * weight) / sum);
  const parts = exact.map(value => Math.floor(value));
  let rest = units - parts.reduce((total, part) => total + part, 0);
  const order = exact.map((value, index) => ({ index, remainder: value - parts[index]! }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (let index = 0; rest > 0 && index < order.length; index += 1, rest -= 1) parts[order[index]!.index]! += 1;
  return parts.map(part => part / 10);
}

export interface UsageLedgerRows {
  periodStart: string;
  pointValueUsd: number | null;
  features: Array<{ feature: string; calls: number; usd: number }>;
  daily: Array<{ day: string; feature: string; usd: number }>;
  users: Array<{ user_key: string; name: string | null; email: string | null; deleted: boolean; system: boolean; calls: number; usd: number }>;
  userFeatures: Array<{ user_key: string; feature: string; usd: number }>;
  userDaily: Array<{ day: string; user_key: string; usd: number }>;
}

export interface UsageBreakdown {
  features: Array<{ feature: string; points: number | null; calls: number }>;
  daily: Array<{ date: string; feature: string; points: number | null }>;
  users: Array<{ user_key: string; name: string | null; email: string | null; deleted: boolean; system: boolean;
    points: number | null; calls: number; features: Record<string, number | null> }>;
  user_daily: Array<{ date: string; user_key: string; points: number | null }>;
}

/** Sums USD per (group, key): group = feature or person, key = day or feature. */
function groupCells<T>(rows: readonly T[], group: (row: T) => string, key: (row: T) => string, usd: (row: T) => number): Map<string, Map<string, number>> {
  const groups = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const cells = groups.get(group(row)) ?? new Map<string, number>();
    cells.set(key(row), (cells.get(key(row)) ?? 0) + Math.max(0, usd(row)));
    groups.set(group(row), cells);
  }
  return groups;
}

/**
 * Points of the usage page from the month's ledger sums. Each total (a
 * feature, a person) is converted once; its days and features are its share
 * of that total, so a person's daily points add up to the person's points
 * (all from the same ledger rows).
 */
export function buildUsageBreakdown(rows: UsageLedgerRows): UsageBreakdown {
  const toPoints = (usd: number) => pointsFromUsd(usd, rows.pointValueUsd);
  const split = <T>(total: number | null, cells: Map<string, number>, make: (key: string, points: number | null) => T): T[] => {
    const keys = [...cells.keys()].sort();
    const parts = apportionPoints(total, keys.map(key => cells.get(key)!));
    return keys.map((key, index) => make(key, parts[index] ?? null));
  };
  const day = (value: string) => clampDayToMonth(value, rows.periodStart);
  const features = rows.features.map(item => ({ feature: item.feature, points: toPoints(item.usd), calls: item.calls }));
  const featureTotals = new Map(features.map(item => [item.feature, item.points]));
  const dailyCells = groupCells(rows.daily, item => item.feature, item => day(item.day), item => item.usd);
  const daily = [...dailyCells].flatMap(([feature, cells]) => {
    const total = featureTotals.has(feature) ? featureTotals.get(feature)! : toPoints([...cells.values()].reduce((sum, usd) => sum + usd, 0));
    return split(total, cells, (date, points) => ({ date, feature, points }));
  }).sort((a, b) => a.date.localeCompare(b.date) || a.feature.localeCompare(b.feature));
  const featureCells = groupCells(rows.userFeatures, item => item.user_key, item => item.feature, item => item.usd);
  const users = rows.users.map(user => {
    const points = toPoints(user.usd);
    const cells = featureCells.get(user.user_key) ?? new Map<string, number>();
    return { user_key: user.user_key, name: user.name, email: user.email, deleted: user.deleted, system: user.system, points, calls: user.calls,
      features: Object.fromEntries(split(points, cells, (feature, value) => [feature, value] as const)) };
  });
  const userPoints = new Map(users.map(user => [user.user_key, user.points]));
  const userDayCells = groupCells(rows.userDaily, item => item.user_key, item => day(item.day), item => item.usd);
  const userDaily = [...userDayCells].filter(([userKey]) => userPoints.has(userKey))
    .flatMap(([userKey, cells]) => split(userPoints.get(userKey)!, cells, (date, points) => ({ date, user_key: userKey, points })))
    .sort((a, b) => a.date.localeCompare(b.date) || a.user_key.localeCompare(b.user_key));
  return { features, daily, users, user_daily: userDaily };
}
