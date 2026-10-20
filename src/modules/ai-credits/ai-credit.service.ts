// AI points: tenant usage view, AI ID run admission, and the superadmin
// settings (plans, plan per tenant, top-ups, FX, overview, reconciliation).
// Plan AI-ID PLAN/AI_CREDIT_LIMIT_PLAN_2026-10-17.md.
import { query } from '../../config/database.js';
import { AppError } from '../../utils/errors.js';
import { currentAiUsagePeriodStart, getTenantAiRuntimeSettings } from '../ai-chatbot/ai-platform/ai-settings.service.js';
import {
  AI_CREDIT_INSUFFICIENT_FOR_RUN_CODE, aiCreditState, availableMonths, buildUsageBreakdown, monthKey, monthStart, nextMonthStart, pointsFromUsd,
} from './ai-credit.logic.js';
import { AI_CREDIT_DEFAULT_PLAN_CODE, ensureCreditMonth, recomputeCreditMonth } from './ai-credit.repository.js';

// Defined in the logic file so the AI ID launch controller can name it without loading the database.
export { AI_CREDIT_INSUFFICIENT_FOR_RUN_CODE };
/** A past month without a credit row: it is not created from today's plan to answer a request. */
export const AI_CREDIT_MONTH_NOT_FOUND_CODE = 'AI_CREDIT_MONTH_NOT_FOUND';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DEFAULT_TIMEZONE = 'Asia/Ho_Chi_Minh';

function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableNum(value: unknown): number | null {
  return value === null || value === undefined ? null : num(value);
}

export function periodOfMonth(month: string | undefined, fallbackPeriod: string): string {
  if (month === undefined || month === '') return fallbackPeriod;
  if (!MONTH.test(month)) throw new AppError('Tháng không hợp lệ (định dạng YYYY-MM).', 400, 'AI_CREDIT_MONTH_INVALID');
  return `${month}-01`;
}

interface CreditMonthRow {
  plan_id: string | null;
  plan_code: string | null;
  plan_name: string | null;
  plan_points: string | null;
  topup_points: string;
  is_unlimited: boolean;
  fx_vnd_per_usd: string | null;
  point_value_usd: string | null;
  budget_usd: string | null;
  used_usd: string;
  reserved_usd: string;
  revenue_vnd: string;
  warned_80_at: string | null;
  warned_100_at: string | null;
}

async function loadCreditMonth(tenantId: string, periodStart: string): Promise<CreditMonthRow | null> {
  const result = await query<CreditMonthRow>(
    `SELECT m.plan_id::text, p.code AS plan_code, p.name AS plan_name, m.plan_points::text, m.topup_points::text,
            m.is_unlimited, m.fx_vnd_per_usd::text, m.point_value_usd::text, m.budget_usd::text,
            m.used_usd::text, m.reserved_usd::text, m.revenue_vnd::text,
            m.warned_80_at::text, m.warned_100_at::text
     FROM ai_credit_monthly m LEFT JOIN ai_credit_plans p ON p.id = m.plan_id
     WHERE m.tenant_id = $1::uuid AND m.period_start = $2::date`,
    [tenantId, periodStart],
  );
  return result.rows[0] ?? null;
}

// --- AI ID run admission -------------------------------------------------------------------------

const RUN_ESTIMATE_TTL_MS = 10 * 60_000;
const RUN_ESTIMATE_MARGIN = 1.3;
const RUN_ESTIMATE_FALLBACK_USD = 1.5;
const runEstimateCache = new Map<string, { at: number; usd: number }>();

/**
 * What one AI ID run is expected to cost: the median of this tenant's last
 * runs (60 days, at least 3), else of every tenant's, else a fixed fallback;
 * plus a 30% margin. Cached 10 minutes per tenant.
 */
export async function estimateAiIdRunCostUsd(tenantId: string): Promise<number> {
  const hit = runEstimateCache.get(tenantId);
  if (hit && Date.now() - hit.at < RUN_ESTIMATE_TTL_MS) return hit.usd;
  const result = await query<{ tenant_median: string | null; tenant_runs: number; global_median: string | null; global_runs: number }>(
    `WITH runs AS (
       SELECT l.tenant_id, l.metadata ->> 'orchestration_run_id' AS run_id, sum(l.estimated_cost_usd) AS cost
       FROM ai_token_usage_ledger l
       WHERE l.operation = 'lesson_author' AND l.metadata ? 'orchestration_run_id'
         AND l.created_at > now() - interval '60 days'
       GROUP BY 1, 2
     )
     SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY cost) FILTER (WHERE tenant_id = $1::uuid) AS tenant_median,
            (count(*) FILTER (WHERE tenant_id = $1::uuid))::int AS tenant_runs,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY cost) AS global_median,
            count(*)::int AS global_runs
     FROM runs`,
    [tenantId],
  );
  const row = result.rows[0];
  const base = row && row.tenant_runs >= 3 && num(row.tenant_median) > 0 ? num(row.tenant_median)
    : row && row.global_runs >= 3 && num(row.global_median) > 0 ? num(row.global_median)
      : RUN_ESTIMATE_FALLBACK_USD;
  const usd = Math.round(base * RUN_ESTIMATE_MARGIN * 1e6) / 1e6;
  runEstimateCache.set(tenantId, { at: Date.now(), usd });
  return usd;
}

/**
 * USD still available in the tenant's current credit month (budget - used -
 * reserved; may be negative after an allowed overdraft), or null when the month
 * is unlimited or not valued in points. Creates the month row like admission.
 */
export async function availableAiCreditUsd(tenantId: string): Promise<number | null> {
  const settings = await getTenantAiRuntimeSettings(tenantId);
  const periodStart = currentAiUsagePeriodStart(settings.tokenTimezone);
  await ensureCreditMonth(tenantId, periodStart);
  const month = await loadCreditMonth(tenantId, periodStart);
  if (!month || month.is_unlimited || month.budget_usd === null) return null;
  return num(month.budget_usd) - num(month.used_usd) - num(month.reserved_usd);
}

/**
 * Refuses a new AI ID run when the month's remaining points do not cover its
 * estimated cost (owner: "only block when the estimate says not enough", no
 * number shown). Admitted runs then finish even past the budget.
 */
export async function assertAiCreditForAiIdRun(tenantId: string): Promise<void> {
  const available = await availableAiCreditUsd(tenantId);
  if (available === null || available >= await estimateAiIdRunCostUsd(tenantId)) return;
  throw new AppError('Không đủ điểm AI để tạo khoá học. Liên hệ quản trị viên để mua thêm điểm.', 429,
    AI_CREDIT_INSUFFICIENT_FOR_RUN_CODE);
}

/**
 * True when the tenant's current credit month is spent, by the rule of
 * aiCreditState (used + reserved >= budget). An unlimited or unvalued month,
 * or a month without a credit row yet, is not. Read-only: no row is created
 * and nothing is reserved (owner: report PDF export is refused while spent).
 */
export async function isAiCreditMonthExhausted(tenantId: string): Promise<boolean> {
  const settings = await query<{ token_timezone: string | null }>(
    'SELECT token_timezone FROM tenant_ai_settings WHERE tenant_id = $1', [tenantId]);
  const periodStart = currentAiUsagePeriodStart(settings.rows[0]?.token_timezone || DEFAULT_TIMEZONE);
  const month = await loadCreditMonth(tenantId, periodStart);
  if (!month) return false;
  return aiCreditState({
    isUnlimited: month.is_unlimited, pointValueUsd: nullableNum(month.point_value_usd), budgetUsd: nullableNum(month.budget_usd),
    usedUsd: num(month.used_usd), reservedUsd: num(month.reserved_usd),
  }).state === 'exhausted';
}

// --- Tenant usage view ---------------------------------------------------------------------------

export interface AiUsageUser {
  user_key: string;
  name: string | null;
  email: string | null;
  deleted: boolean;
  system: boolean;
  points: number | null;
  calls: number;
  features: Record<string, number | null>;
}

export interface AiUsageSummary {
  month: string;
  months: string[];
  /** Months that have usage or a credit row, newest first, always with the current month. */
  available_months: string[];
  /** False for a past month without a credit row: points cannot be counted (nothing is created to show it). */
  has_month: boolean;
  resets_on: string;
  plan: { code: string | null; name: string | null; is_unlimited: boolean };
  state: ReturnType<typeof aiCreditState>['state'];
  percent: number | null;
  points: { plan: number | null; topup: number; total: number | null; used: number | null; reserved: number | null; remaining: number | null };
  features: Array<{ feature: string; points: number | null; calls: number }>;
  daily: Array<{ date: string; feature: string; points: number | null }>;
  users: AiUsageUser[];
  user_daily: Array<{ date: string; user_key: string; points: number | null }>;
  /** Superadmin view only: the VND per USD rate of the month and the month it was set for. */
  fx_vnd_per_usd?: number | null;
  fx_rate_month?: string | null;
}

const SYSTEM_USER_KEY = 'system';
const TOP_USERS_IN_CHART = 8;

/** The latest FX rate set for a month or before it, and that rate's own month. */
async function fxRateOf(periodStart: string): Promise<{ vndPerUsd: number | null; month: string | null }> {
  const result = await query<{ month: string; vnd_per_usd: string }>(
    `SELECT to_char(month, 'YYYY-MM') AS month, vnd_per_usd::text FROM ai_fx_rates
     WHERE month <= $1::date ORDER BY month DESC LIMIT 1`, [periodStart]);
  const row = result.rows[0];
  return row ? { vndPerUsd: num(row.vnd_per_usd), month: row.month } : { vndPerUsd: null, month: null };
}

/**
 * The AI usage page of a tenant: one month, in points (never USD or tokens).
 * Only the current month is created when missing; another month is read as
 * it is (a month without a credit row has no points). `includeFx` adds the
 * month's exchange rate for the superadmin view.
 */
export async function getTenantAiUsage(tenantId: string, month?: string, options: { includeFx?: boolean } = {}): Promise<AiUsageSummary> {
  const settings = await getTenantAiRuntimeSettings(tenantId);
  const currentPeriod = currentAiUsagePeriodStart(settings.tokenTimezone);
  const periodStart = periodOfMonth(month, currentPeriod);
  if (periodStart > currentPeriod) throw new AppError('Tháng này chưa có dữ liệu.', 400, 'AI_CREDIT_MONTH_INVALID');
  if (periodStart === currentPeriod) await ensureCreditMonth(tenantId, periodStart);
  const timezone = settings.tokenTimezone || DEFAULT_TIMEZONE;
  const [row, months, creditMonths, features, daily, users, userFeatures, fx] = await Promise.all([
    loadCreditMonth(tenantId, periodStart),
    query<{ period_start: string }>(
      `SELECT DISTINCT period_start::text FROM (
         SELECT period_start FROM ai_token_usage_ledger WHERE tenant_id = $1::uuid
         UNION SELECT $2::date
       ) months ORDER BY 1 DESC LIMIT 24`, [tenantId, currentPeriod]),
    query<{ period_start: string }>(
      `SELECT period_start::text FROM ai_credit_monthly
       WHERE tenant_id = $1::uuid AND period_start <= $2::date ORDER BY period_start DESC LIMIT 24`, [tenantId, currentPeriod]),
    query<{ feature: string; calls: number; cost: string }>(
      `SELECT coalesce(feature, 'chat') AS feature, count(*)::int AS calls, sum(estimated_cost_usd)::text AS cost
       FROM ai_token_usage_ledger WHERE tenant_id = $1::uuid AND period_start = $2::date
       GROUP BY 1 ORDER BY sum(estimated_cost_usd) DESC`, [tenantId, periodStart]),
    query<{ day: string; feature: string; cost: string }>(
      `SELECT (created_at AT TIME ZONE $3::text)::date::text AS day, coalesce(feature, 'chat') AS feature,
              sum(estimated_cost_usd)::text AS cost
       FROM ai_token_usage_ledger WHERE tenant_id = $1::uuid AND period_start = $2::date
       GROUP BY 1, 2 ORDER BY 1, 2`, [tenantId, periodStart, timezone]),
    query<{ user_key: string; name: string | null; email: string | null; deleted: boolean; system: boolean; calls: number; cost: string }>(
      `SELECT coalesce(l.actor_user_id::text, $3::text) AS user_key,
              max(coalesce(u.full_name, l.actor_name)) AS name, max(coalesce(u.email, l.actor_email)) AS email,
              (l.actor_user_id IS NOT NULL AND bool_and(u.id IS NULL)) AS deleted,
              (l.actor_user_id IS NULL) AS system,
              count(*)::int AS calls, sum(l.estimated_cost_usd)::text AS cost
       FROM ai_token_usage_ledger l LEFT JOIN users u ON u.id = l.actor_user_id
       WHERE l.tenant_id = $1::uuid AND l.period_start = $2::date
       GROUP BY l.actor_user_id ORDER BY sum(l.estimated_cost_usd) DESC LIMIT 100`, [tenantId, periodStart, SYSTEM_USER_KEY]),
    query<{ user_key: string; feature: string; cost: string }>(
      `SELECT coalesce(actor_user_id::text, $3::text) AS user_key, coalesce(feature, 'chat') AS feature,
              sum(estimated_cost_usd)::text AS cost
       FROM ai_token_usage_ledger WHERE tenant_id = $1::uuid AND period_start = $2::date
       GROUP BY 1, 2`, [tenantId, periodStart, SYSTEM_USER_KEY]),
    options.includeFx ? fxRateOf(periodStart) : Promise.resolve(null),
  ]);
  const topUsers = users.rows.slice(0, TOP_USERS_IN_CHART).map(user => user.user_key);
  // The same ledger rows as the user list, per day: a person's days add up to the person's points.
  const userDaily = topUsers.length === 0 ? [] : (await query<{ day: string; user_key: string; cost: string }>(
    `SELECT (created_at AT TIME ZONE $3::text)::date::text AS day, coalesce(actor_user_id::text, $5::text) AS user_key,
            sum(estimated_cost_usd)::text AS cost
     FROM ai_token_usage_ledger
     WHERE tenant_id = $1::uuid AND period_start = $2::date AND coalesce(actor_user_id::text, $5::text) = ANY($4::text[])
     GROUP BY 1, 2 ORDER BY 1, 2`, [tenantId, periodStart, timezone, topUsers, SYSTEM_USER_KEY])).rows;
  const hasMonth = row !== null;
  const pointValue = nullableNum(row?.point_value_usd);
  const breakdown = buildUsageBreakdown({
    periodStart,
    pointValueUsd: pointValue,
    features: features.rows.map(item => ({ feature: item.feature, calls: item.calls, usd: num(item.cost) })),
    daily: daily.rows.map(item => ({ day: item.day, feature: item.feature, usd: num(item.cost) })),
    users: users.rows.map(user => ({ user_key: user.user_key, name: user.system ? null : user.name, email: user.system ? null : user.email,
      deleted: user.deleted, system: user.system, calls: user.calls, usd: num(user.cost) })),
    userFeatures: userFeatures.rows.map(item => ({ user_key: item.user_key, feature: item.feature, usd: num(item.cost) })),
    userDaily: userDaily.map(item => ({ day: item.day, user_key: item.user_key, usd: num(item.cost) })),
  });
  const toPoints = (usd: number) => pointsFromUsd(usd, pointValue);
  const budgetUsd = nullableNum(row?.budget_usd);
  const usedUsd = num(row?.used_usd);
  const reservedUsd = num(row?.reserved_usd);
  // No credit row (a month before AI points, never created afterwards): nothing could be valued or enforced.
  const state = hasMonth
    ? aiCreditState({ isUnlimited: row.is_unlimited, pointValueUsd: pointValue, budgetUsd, usedUsd, reservedUsd })
    : { state: 'unvalued' as const, percent: null };
  const planPoints = nullableNum(row?.plan_points);
  const topupPoints = num(row?.topup_points);
  const total = planPoints === null ? null : planPoints + topupPoints;
  const used = hasMonth ? toPoints(usedUsd) : null;
  const reserved = hasMonth ? toPoints(reservedUsd) : null;
  const fxVndPerUsd = fx ? (row ? nullableNum(row.fx_vnd_per_usd) : fx.vndPerUsd) : null;
  return {
    month: monthKey(periodStart),
    months: months.rows.map(item => monthKey(item.period_start)),
    available_months: availableMonths([...months.rows, ...creditMonths.rows].map(item => item.period_start), currentPeriod),
    has_month: hasMonth,
    resets_on: nextMonthStart(periodStart),
    plan: { code: row?.plan_code ?? null, name: row?.plan_name ?? null, is_unlimited: row?.is_unlimited ?? false },
    state: state.state,
    percent: state.percent,
    points: {
      plan: planPoints, topup: topupPoints, total, used, reserved,
      remaining: total === null || used === null || row?.is_unlimited ? null
        : Math.max(0, Math.round((total - used - (reserved ?? 0)) * 10) / 10),
    },
    ...breakdown,
    ...(fx ? { fx_vnd_per_usd: fxVndPerUsd, fx_rate_month: fxVndPerUsd === null ? null : fx.month } : {}),
  };
}

// --- Superadmin ------------------------------------------------------------------------------------

export interface AiCreditPlanInput {
  code: string;
  name: string;
  description?: string | null;
  monthly_price_vnd: number;
  monthly_points: number;
  provider_cost_ratio: number;
  safety_buffer_ratio: number;
  is_unlimited: boolean;
  is_active: boolean;
  sort_order: number;
}

export async function listAiCreditPlans() {
  const result = await query(
    `SELECT p.id::text, p.code, p.name, p.description, p.monthly_price_vnd::text, p.monthly_points::text,
            p.provider_cost_ratio::text, p.safety_buffer_ratio::text, p.is_unlimited, p.is_active, p.sort_order,
            (SELECT count(*)::int FROM ai_credit_accounts a WHERE a.plan_id = p.id) AS tenant_count
     FROM ai_credit_plans p ORDER BY p.sort_order, p.monthly_price_vnd, p.name`,
  );
  return result.rows;
}

async function recomputeCurrentMonthOfPlanTenants(planId: string): Promise<void> {
  const tenants = await query<{ tenant_id: string }>(`SELECT tenant_id::text FROM ai_credit_accounts WHERE plan_id = $1::uuid`, [planId]);
  for (const tenant of tenants.rows) {
    const settings = await getTenantAiRuntimeSettings(tenant.tenant_id);
    await recomputeCreditMonth(tenant.tenant_id, currentAiUsagePeriodStart(settings.tokenTimezone));
  }
}

export async function createAiCreditPlan(input: AiCreditPlanInput, actorId: string) {
  const result = await query<{ id: string }>(
    `INSERT INTO ai_credit_plans (code, name, description, monthly_price_vnd, monthly_points, provider_cost_ratio,
       safety_buffer_ratio, is_unlimited, is_active, sort_order, created_by)
     VALUES ($1::text, $2::text, $3::text, $4::numeric, $5::bigint, $6::numeric, $7::numeric, $8::boolean, $9::boolean, $10::int, $11::uuid)
     ON CONFLICT (code) DO NOTHING RETURNING id::text`,
    [input.code, input.name, input.description ?? null, input.monthly_price_vnd, input.monthly_points,
      input.provider_cost_ratio, input.safety_buffer_ratio, input.is_unlimited, input.is_active, input.sort_order, actorId],
  );
  if (!result.rows[0]) throw new AppError('Mã gói đã tồn tại.', 409, 'AI_CREDIT_PLAN_CODE_TAKEN');
  return result.rows[0];
}

export async function updateAiCreditPlan(planId: string, input: Omit<AiCreditPlanInput, 'code'>) {
  const result = await query<{ id: string }>(
    `UPDATE ai_credit_plans SET name = $2::text, description = $3::text, monthly_price_vnd = $4::numeric,
       monthly_points = $5::bigint, provider_cost_ratio = $6::numeric, safety_buffer_ratio = $7::numeric,
       is_unlimited = $8::boolean, is_active = $9::boolean, sort_order = $10::int
     WHERE id = $1::uuid RETURNING id::text`,
    [planId, input.name, input.description ?? null, input.monthly_price_vnd, input.monthly_points,
      input.provider_cost_ratio, input.safety_buffer_ratio, input.is_unlimited, input.is_active, input.sort_order],
  );
  if (!result.rows[0]) throw new AppError('Không tìm thấy gói.', 404, 'AI_CREDIT_PLAN_NOT_FOUND');
  // A plan edit applies to the current month of its tenants; past months keep their snapshot.
  await recomputeCurrentMonthOfPlanTenants(planId);
  return result.rows[0];
}

async function assertTenant(tenantId: string): Promise<string> {
  const result = await query<{ name: string }>(`SELECT name FROM tenants WHERE id = $1::uuid`, [tenantId]);
  if (!result.rows[0]) throw new AppError('Không tìm thấy tenant.', 404, 'TENANT_NOT_FOUND');
  return result.rows[0].name;
}

export async function setTenantAiCreditPlan(tenantId: string, planId: string, actorId: string) {
  const tenantName = await assertTenant(tenantId);
  const plan = await query<{ name: string; is_active: boolean }>(`SELECT name, is_active FROM ai_credit_plans WHERE id = $1::uuid`, [planId]);
  if (!plan.rows[0]) throw new AppError('Không tìm thấy gói.', 404, 'AI_CREDIT_PLAN_NOT_FOUND');
  if (!plan.rows[0].is_active) throw new AppError('Gói này đang tắt, không gán được.', 400, 'AI_CREDIT_PLAN_INACTIVE');
  await query(
    `INSERT INTO ai_credit_accounts (tenant_id, plan_id, updated_by) VALUES ($1::uuid, $2::uuid, $3::uuid)
     ON CONFLICT (tenant_id) DO UPDATE SET plan_id = EXCLUDED.plan_id, updated_by = EXCLUDED.updated_by`,
    [tenantId, planId, actorId],
  );
  const settings = await getTenantAiRuntimeSettings(tenantId);
  await recomputeCreditMonth(tenantId, currentAiUsagePeriodStart(settings.tokenTimezone));
  return { tenantName, planName: plan.rows[0].name };
}

export async function addTenantAiCreditTopup(tenantId: string, input: { points: number; price_vnd?: number | null; reason?: string | null }, actorId: string) {
  const tenantName = await assertTenant(tenantId);
  const settings = await getTenantAiRuntimeSettings(tenantId);
  const periodStart = currentAiUsagePeriodStart(settings.tokenTimezone);
  const result = await query<{ id: string }>(
    `INSERT INTO ai_credit_topups (tenant_id, period_start, points, price_vnd, reason, created_by)
     VALUES ($1::uuid, $2::date, $3::bigint, $4::numeric, $5::text, $6::uuid) RETURNING id::text`,
    [tenantId, periodStart, input.points, input.price_vnd ?? null, input.reason ?? null, actorId],
  );
  await recomputeCreditMonth(tenantId, periodStart);
  return { id: result.rows[0]!.id, tenantName, month: monthKey(periodStart) };
}

export async function listAiFxRates() {
  const result = await query(`SELECT to_char(month, 'YYYY-MM') AS month, vnd_per_usd::text, source_note, updated_at
                              FROM ai_fx_rates ORDER BY month DESC LIMIT 36`);
  return result.rows;
}

export async function setAiFxRate(month: string, vndPerUsd: number, note: string | null, actorId: string) {
  const periodStart = periodOfMonth(month, month);
  await query(
    `INSERT INTO ai_fx_rates (month, vnd_per_usd, source_note, created_by) VALUES ($1::date, $2::numeric, $3::text, $4::uuid)
     ON CONFLICT (month) DO UPDATE SET vnd_per_usd = EXCLUDED.vnd_per_usd, source_note = EXCLUDED.source_note`,
    [periodStart, vndPerUsd, note, actorId],
  );
  // Months from this one on take it when they have no rate of their own.
  const rows = await query<{ tenant_id: string; period_start: string }>(
    `SELECT tenant_id::text, period_start::text FROM ai_credit_monthly m
     WHERE period_start >= $1::date AND NOT EXISTS (
       SELECT 1 FROM ai_fx_rates f WHERE f.month > $1::date AND f.month <= m.period_start)`,
    [periodStart],
  );
  for (const row of rows.rows) await recomputeCreditMonth(row.tenant_id, row.period_start);
  return { month: monthKey(periodStart), recomputed: rows.rows.length };
}

/**
 * Money view of one month for every tenant. Only the current month is
 * created when missing; another month is read as it is: a tenant without a
 * credit row that month has `has_month: false` (no plan, points or revenue;
 * its provider cost comes from the ledger).
 */
export async function getAiCreditOverview(month?: string) {
  const currentPeriod = currentAiUsagePeriodStart(DEFAULT_TIMEZONE);
  const periodStart = periodOfMonth(month, currentPeriod);
  if (periodStart === currentPeriod) {
    const tenants = await query<{ id: string }>(`SELECT id::text FROM tenants ORDER BY name`);
    for (const tenant of tenants.rows) await ensureCreditMonth(tenant.id, periodStart);
  }
  const [result, fx, creditMonths] = await Promise.all([
    query<{
      tenant_id: string; tenant_name: string; has_month: boolean; plan_id: string | null; plan_name: string | null; is_unlimited: boolean | null;
      plan_points: string | null; topup_points: string | null; point_value_usd: string | null; budget_usd: string | null;
      used_usd: string | null; reserved_usd: string | null; fx_vnd_per_usd: string | null; revenue_vnd: string | null;
      reconciled_cost_vnd: string | null; reconciled_note: string | null; current_plan_id: string | null; ledger_usd: string | null;
    }>(
      `SELECT t.id::text AS tenant_id, t.name AS tenant_name, (m.tenant_id IS NOT NULL) AS has_month,
              m.plan_id::text, p.name AS plan_name, m.is_unlimited,
              m.plan_points::text, m.topup_points::text, m.point_value_usd::text, m.budget_usd::text,
              m.used_usd::text, m.reserved_usd::text, m.fx_vnd_per_usd::text, m.revenue_vnd::text,
              m.reconciled_cost_vnd::text, m.reconciled_note, a.plan_id::text AS current_plan_id,
              CASE WHEN m.tenant_id IS NULL THEN (
                SELECT sum(l.estimated_cost_usd) FROM ai_token_usage_ledger l
                WHERE l.tenant_id = t.id AND l.period_start = $1::date)::text END AS ledger_usd
       FROM tenants t
       LEFT JOIN ai_credit_monthly m ON m.tenant_id = t.id AND m.period_start = $1::date
       LEFT JOIN ai_credit_plans p ON p.id = m.plan_id
       LEFT JOIN ai_credit_accounts a ON a.tenant_id = t.id
       ORDER BY coalesce(m.used_usd, 0) DESC, t.name`,
      [periodStart],
    ),
    fxRateOf(periodStart),
    query<{ period_start: string }>(
      `SELECT DISTINCT period_start::text FROM ai_credit_monthly WHERE period_start <= $1::date ORDER BY 1 DESC LIMIT 24`,
      [currentPeriod]),
  ]);
  const rows = result.rows.map(row => {
    if (!row.has_month) {
      // Nothing to value: no plan snapshot, points or revenue. The provider cost still happened.
      const costUsd = num(row.ledger_usd);
      const costVnd = fx.vndPerUsd === null ? null : Math.round(costUsd * fx.vndPerUsd);
      return {
        tenant_id: row.tenant_id, tenant_name: row.tenant_name, has_month: false, plan_id: null, current_plan_id: row.current_plan_id,
        plan_name: null, is_unlimited: false, state: 'unvalued' as const, percent: null,
        points_total: null, points_used: null, topup_points: 0,
        cost_usd: costUsd, fx_vnd_per_usd: fx.vndPerUsd, cost_vnd: costVnd, revenue_vnd: 0, margin_vnd: null, margin_percent: null,
        reconciled_cost_vnd: null, reconciled_note: null, reconciled_diff_percent: null,
      };
    }
    const pointValue = nullableNum(row.point_value_usd);
    const rowFx = nullableNum(row.fx_vnd_per_usd);
    const usedUsd = num(row.used_usd);
    const costVnd = rowFx === null ? null : Math.round(usedUsd * rowFx);
    const revenueVnd = num(row.revenue_vnd);
    const reconciled = nullableNum(row.reconciled_cost_vnd);
    const planPoints = nullableNum(row.plan_points);
    const total = planPoints === null ? null : planPoints + num(row.topup_points);
    const state = aiCreditState({ isUnlimited: row.is_unlimited ?? false, pointValueUsd: pointValue, budgetUsd: nullableNum(row.budget_usd),
      usedUsd, reservedUsd: num(row.reserved_usd) });
    return {
      tenant_id: row.tenant_id, tenant_name: row.tenant_name, has_month: true, plan_id: row.plan_id, current_plan_id: row.current_plan_id,
      plan_name: row.plan_name, is_unlimited: row.is_unlimited ?? false, state: state.state, percent: state.percent,
      points_total: total, points_used: pointsFromUsd(usedUsd, pointValue), topup_points: num(row.topup_points),
      cost_usd: usedUsd, fx_vnd_per_usd: rowFx, cost_vnd: costVnd, revenue_vnd: revenueVnd,
      margin_vnd: costVnd === null ? null : revenueVnd - costVnd,
      margin_percent: costVnd === null || revenueVnd <= 0 ? null : Math.round(((revenueVnd - costVnd) / revenueVnd) * 1000) / 10,
      reconciled_cost_vnd: reconciled, reconciled_note: row.reconciled_note,
      reconciled_diff_percent: reconciled === null || costVnd === null || reconciled === 0 ? null
        : Math.round(((costVnd - reconciled) / reconciled) * 1000) / 10,
    };
  });
  return {
    month: monthKey(periodStart),
    available_months: availableMonths(creditMonths.rows.map(item => item.period_start), currentPeriod),
    fx_vnd_per_usd: fx.vndPerUsd,
    /** Month the rate was set for; earlier than `month` when this month has no rate of its own. */
    fx_rate_month: fx.month,
    tenants: rows,
  };
}

/**
 * What the provider invoice says a tenant's own key cost in a month. Only a
 * month that exists (or the current one) can be checked: a past month is
 * never created from today's plan.
 */
export async function reconcileTenantAiMonth(tenantId: string, month: string, costVnd: number, note: string | null, actorId: string) {
  const tenantName = await assertTenant(tenantId);
  const periodStart = periodOfMonth(month, month);
  const settings = await getTenantAiRuntimeSettings(tenantId);
  if (periodStart === currentAiUsagePeriodStart(settings.tokenTimezone)) await ensureCreditMonth(tenantId, periodStart);
  const result = await query<{ ok: number }>(
    `UPDATE ai_credit_monthly SET reconciled_cost_vnd = $3::numeric, reconciled_note = $4::text,
       reconciled_by = $5::uuid, reconciled_at = now(), revision = revision + 1
     WHERE tenant_id = $1::uuid AND period_start = $2::date
     RETURNING 1 AS ok`,
    [tenantId, periodStart, costVnd, note, actorId],
  );
  if (result.rows.length === 0) {
    throw new AppError('Tháng này chưa có dữ liệu điểm AI của đơn vị nên chưa đối soát được.', 404, AI_CREDIT_MONTH_NOT_FOUND_CODE);
  }
  return { tenantName, month: monthKey(periodStart) };
}

/** The plan a tenant has now (its account, else the default plan), without the month's usage. */
export async function getTenantAiCreditPlan(tenantId: string) {
  await assertTenant(tenantId);
  const result = await query<{ id: string; code: string; name: string; is_unlimited: boolean; monthly_points: string;
    monthly_price_vnd: string; assigned: boolean }>(
    `SELECT p.id::text, p.code, p.name, p.is_unlimited, p.monthly_points::text, p.monthly_price_vnd::text,
            EXISTS (SELECT 1 FROM ai_credit_accounts a WHERE a.tenant_id = $1::uuid) AS assigned
     FROM ai_credit_plans p
     WHERE p.id = coalesce((SELECT plan_id FROM ai_credit_accounts WHERE tenant_id = $1::uuid),
                           (SELECT id FROM ai_credit_plans WHERE code = $2::text))`,
    [tenantId, AI_CREDIT_DEFAULT_PLAN_CODE],
  );
  return result.rows[0] ?? null;
}

export { monthStart };
