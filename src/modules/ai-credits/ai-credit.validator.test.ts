import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  AI_CREDIT_INVALID_INPUT_CODE, createPlanSchema, fxSchema, idParam, invalidInputBody, monthParam, topupSchema,
} from './ai-credit.validator.js';

function refusal(schema: { safeParse: (value: unknown) => { success: boolean; error?: unknown } }, value: unknown, field?: string) {
  const parsed = schema.safeParse(value);
  assert.equal(parsed.success, false);
  return invalidInputBody(parsed.error as Parameters<typeof invalidInputBody>[0], field);
}

test('a refused input answers a stable code and the first refused field', () => {
  const plan = { code: 'pro', name: 'Pro', monthly_price_vnd: 1000, monthly_points: 0, provider_cost_ratio: 0.5,
    safety_buffer_ratio: 0.1, is_unlimited: false, is_active: true, sort_order: 0 };
  assert.deepEqual(refusal(createPlanSchema, plan), { success: false, code: AI_CREDIT_INVALID_INPUT_CODE, field: 'monthly_points',
    message: 'Số điểm phải lớn hơn 0' });
  assert.equal(refusal(createPlanSchema, { ...plan, code: 'Gói A', monthly_points: 10 }).field, 'code');
  assert.equal(refusal(topupSchema, { points: 1.5 }).field, 'points');
  assert.equal(refusal(fxSchema, { vnd_per_usd: 0 }).field, 'vnd_per_usd');
  assert.equal(refusal(createPlanSchema, null).field, undefined, 'a missing body names no field');
  assert.equal(refusal(createPlanSchema, null).code, AI_CREDIT_INVALID_INPUT_CODE);
});

test('route parameters are checked before any SQL cast and name themselves', () => {
  assert.deepEqual(refusal(monthParam, '2026-13', 'month'), { success: false, code: AI_CREDIT_INVALID_INPUT_CODE, field: 'month',
    message: 'Tháng không hợp lệ (YYYY-MM)' });
  assert.equal(refusal(idParam, 'not-a-uuid', 'tenantId').field, 'tenantId');
  assert.equal(idParam.safeParse('3f2504e0-4f89-41d3-9a0c-0305e82c3301').success, true);
});

test('only the current month is ever created by a read; other months are read as they are', () => {
  const source = readFileSync(new URL('./ai-credit.service.ts', import.meta.url), 'utf8');
  const body = (name: string) => {
    const start = source.indexOf(`export async function ${name}(`);
    assert.ok(start >= 0, name);
    const next = source.indexOf('\nexport ', start + 1);
    return source.slice(start, next < 0 ? undefined : next);
  };
  const usage = body('getTenantAiUsage');
  assert.equal(usage.match(/ensureCreditMonth\(/g)?.length, 1);
  assert.match(usage, /if \(periodStart === currentPeriod\) await ensureCreditMonth\(tenantId, periodStart\);/);
  const overview = body('getAiCreditOverview');
  assert.equal(overview.match(/ensureCreditMonth\(/g)?.length, 1);
  assert.match(overview, /if \(periodStart === currentPeriod\) \{\s*const tenants = [^]*?await ensureCreditMonth\(tenant\.id, periodStart\);\s*\}/);
  assert.match(overview, /LEFT JOIN ai_credit_monthly m ON m\.tenant_id = t\.id AND m\.period_start = \$1::date/);
  const reconcile = body('reconcileTenantAiMonth');
  assert.match(reconcile, /if \(periodStart === currentAiUsagePeriodStart\(settings\.tokenTimezone\)\) await ensureCreditMonth\(tenantId, periodStart\);/);
  assert.match(reconcile, /AI_CREDIT_MONTH_NOT_FOUND_CODE/);
  // Every parameter of the new reads carries an explicit cast.
  for (const fn of ['getTenantAiUsage', 'getAiCreditOverview', 'getTenantAiCreditPlan']) {
    const sql = body(fn).match(/`[^`]*`/g)?.join('\n') ?? '';
    for (const param of sql.match(/\$\d+(?:::[a-z[\]]+)?/g) ?? []) assert.match(param, /::/, `${fn}: ${param} has a cast`);
  }
});
