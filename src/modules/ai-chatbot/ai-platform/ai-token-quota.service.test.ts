import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { type TestContext } from 'node:test';

// The reservation every AI call makes, run for real against a faked database:
// only the tenant's AI points can refuse or shorten a call. The old monthly
// token limit is retired: a value still stored for a tenant has no effect.
// Tokens are still counted (reserved tokens, monthly usage) for reconciliation.

const TENANT = '31111111-1111-4111-8111-111111111111';
const STORED_TOKEN_LIMIT = '1000';
const TOKENS_USED_THIS_MONTH = '5000';

interface FakeDb {
  sql: string[];
  /** USD still available in the tenant's AI points budget of the month. */
  pointsLeftUsd: number;
  reservations: number;
}

const result = (rows: Record<string, unknown>[]) => ({ rows, rowCount: rows.length });

const rateCard = (provider: unknown, model: unknown) => ({
  id: 'card', provider, model, billed_model: model,
  input_usd_per_1m: '0.30', cached_input_usd_per_1m: '0.03', output_usd_per_1m: '2.50', embedding_usd_per_1m: '0.15',
  input_vnd_per_1m: '0', output_vnd_per_1m: '0', embedding_vnd_per_1m: '0',
  effective_from: '2020-01-01T00:00:00.000Z', effective_to: null, source_url: null, source_note: null,
});

async function installFakeDb(t: TestContext, pointsLeftUsd: number): Promise<FakeDb> {
  const fake: FakeDb = { sql: [], pointsLeftUsd, reservations: 0 };
  const answer = async (text: string, params: unknown[] = []) => {
    const sql = String(text);
    fake.sql.push(sql);
    if (sql.includes('FROM tenant_ai_settings s')) {
      return result([{ tenant_id: TENANT, active_engine: 'self_built_rag', provider: 'google_ai_studio',
        monthly_token_limit: STORED_TOKEN_LIMIT, token_timezone: 'Asia/Saigon', chat_model: 'gemini-3.8-flash',
        lesson_author_model: 'gemini-3.8-flash', embedding_model: 'gemini-embedding-001', embedding_dimensions: 768,
        transition_state: 'idle', active_transition_job_id: null, encrypted_api_key: 'opaque', api_key_fingerprint: 'fp' }]);
    }
    if (sql.includes('FROM ai_pricing_rate_cards')) return result([rateCard(params[0], params[1])]);
    // The month already used far more tokens than the stored (retired) limit.
    const usageRow = { period_start: params[1], total_tokens: TOKENS_USED_THIS_MONTH, reserved_tokens: '0',
      monthly_token_limit: STORED_TOKEN_LIMIT, input_tokens: '4000', output_tokens: '1000', embedding_tokens: '0',
      estimated_cost_vnd: '0' };
    if (/FROM ai_token_monthly_usage usage[\s\S]*FOR UPDATE OF usage/.test(sql)) return result([usageRow]);
    if (/^\s*SELECT[\s\S]*FROM ai_token_monthly_usage/.test(sql)) return result([usageRow]);
    if (sql.includes('WITH held AS')) {
      const cost = Number(params[2]);
      const held = params[3] === true || fake.pointsLeftUsd >= cost;
      if (held) fake.pointsLeftUsd -= cost;
      return result([{ updated: held ? 1 : 0, present: true }]);
    }
    if (sql.includes('INSERT INTO ai_token_reservations')) {
      fake.reservations += 1;
      return result([{ id: `reservation-${fake.reservations}` }]);
    }
    return result([]);
  };
  const pg = await import('pg');
  t.mock.method(pg.default.Pool.prototype, 'query', answer);
  t.mock.method(pg.default.Pool.prototype, 'connect', async () => ({ query: answer, release() {} }));
  return fake;
}

async function reserve(overrides: Record<string, unknown> = {}) {
  const { reserveTenantAiTokens } = await import('./ai-token-quota.service.js');
  return reserveTenantAiTokens({
    tenantId: TENANT, userId: null, conversationId: null, target: 'admin', engine: 'self_built_rag',
    provider: 'google_ai_studio', model: 'gemini-3.8-flash', operation: 'chat',
    minimumTokens: 1_000, maximumTokens: 10_000, ...overrides,
  });
}

test('a token limit still stored for the tenant no longer refuses or shortens a call', async (t) => {
  const fake = await installFakeDb(t, 100);
  const grant = await reserve();
  assert.equal(grant.reservedTokens, 10_000, 'the full call, although the month is past the stored token limit');
  assert.equal(grant.isPartialGrant, false);
  assert.equal(grant.remainingTokens, null, 'tokens are counted, never limited');
  assert.equal(fake.reservations, 1);
  assert.ok(fake.sql.every(sql => !sql.includes('monthly_token_limit')), 'the retired limit is never read');
  // Token counting is unchanged: the grant is still added to the month's reserved tokens.
  assert.ok(fake.sql.some(sql => /UPDATE ai_token_monthly_usage\s+SET reserved_tokens = reserved_tokens \+ \$3::bigint/.test(sql)));
});

test('used-up AI points still refuse the call (plain message, code, 429) and nothing is reserved', async (t) => {
  const fake = await installFakeDb(t, 0);
  await assert.rejects(reserve(), (error: { code?: string; statusCode?: number; message?: string }) => {
    assert.equal(error.code, 'AI_CREDIT_LIMIT_REACHED');
    assert.equal(error.statusCode, 429);
    assert.match(String(error.message), /Đã dùng hết điểm AI của tháng này/);
    return true;
  });
  assert.equal(fake.reservations, 0);
});

test('points that fit only the minimum give a shorter answer: the only partial grant left', async (t) => {
  // 10 000 output tokens cost 0.025 USD at this card, 1 000 cost 0.0025 USD.
  const fake = await installFakeDb(t, 0.01);
  const grant = await reserve();
  assert.equal(grant.reservedTokens, 1_000);
  assert.equal(grant.isPartialGrant, true);
  assert.equal(fake.reservations, 1);
});

test('a running AI ID task admitted with enough points is never refused (overdraft), token limit or not', async (t) => {
  await installFakeDb(t, 0);
  const grant = await reserve({ allowOverdraft: true });
  assert.equal(grant.reservedTokens, 10_000);
});

test('tenant AI settings: no token limit is reported, token counts are; old dashboards may still send the limit', async (t) => {
  await installFakeDb(t, 100);
  const { getTenantAiAdminSettings } = await import('./ai-settings.service.js');
  const settings = await getTenantAiAdminSettings(TENANT);
  assert.equal(settings.monthlyTokenLimit, null);
  assert.equal(settings.tokenRemaining, null);
  assert.equal(settings.tokenTotalUsed, TOKENS_USED_THIS_MONTH);

  const { updateTenantAiSettingsSchema } = await import('../../tenants/tenants.validator.js');
  assert.equal(updateTenantAiSettingsSchema.safeParse({ monthly_token_limit: '250000' }).success, true, 'still accepted');
  assert.equal(updateTenantAiSettingsSchema.safeParse({ monthly_token_limit: null }).success, true);
  const controller = readFileSync(new URL('../../tenants/tenants.controller.ts', import.meta.url), 'utf8');
  const service = readFileSync(new URL('./ai-settings.service.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(controller, /monthlyTokenLimit/, 'the value is not passed on');
  assert.doesNotMatch(service, /monthly_token_limit\s*=/, 'and never written');
});
