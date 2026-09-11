import { query, withDatabaseTransaction } from '../../config/database.js';
import { env } from '../../config/env.js';
import { AppError } from '../../middleware/error-handler.js';
import {
  AI_ENGINES,
  AI_PROVIDER_GOOGLE,
  type AiEngine,
  type AiProvider,
  type TenantAiRuntimeSettings,
} from './ai-engine.types.js';
import {
  decryptAiProviderKey,
  encryptAiProviderKey,
  fingerprintAiProviderKey,
} from './ai-secret.service.js';

type TransitionState = TenantAiRuntimeSettings['transitionState'];
const DEFAULT_EMBEDDING_MODEL = 'gemini-embedding-001';
const LEGACY_EMBEDDING_MODEL_ALIASES = new Map<string, string>([
  ['text-embedding-004', DEFAULT_EMBEDDING_MODEL],
]);

interface TenantAiSettingsRow {
  tenant_id: string;
  active_engine: AiEngine;
  provider: AiProvider;
  monthly_token_limit: string | null;
  token_timezone: string;
  chat_model: string;
  lesson_author_model: string;
  embedding_model: string;
  embedding_dimensions: number;
  transition_state: TransitionState;
  active_transition_job_id: string | null;
  encrypted_api_key: string | null;
  api_key_fingerprint: string | null;
}

interface TenantAiUsageRow {
  period_start: string;
  input_tokens: string;
  output_tokens: string;
  embedding_tokens: string;
  total_tokens: string;
  reserved_tokens: string;
  estimated_cost_vnd: string;
}

export interface TenantAiAdminSettings extends TenantAiRuntimeSettings {
  tokenPeriodStart: string;
  tokenInputUsed: string;
  tokenOutputUsed: string;
  tokenEmbeddingUsed: string;
  tokenTotalUsed: string;
  tokenReserved: string;
  tokenRemaining: string | null;
  estimatedCostVnd: string;
  pendingEngine: AiEngine | null;
}

export interface UpdateTenantAiSettingsInput {
  activeEngine?: AiEngine;
  monthlyTokenLimit?: string | null;
  googleAiStudioApiKey?: string | null;
  clearGoogleAiStudioApiKey?: boolean;
  chatModel?: string;
  lessonAuthorModel?: string;
  embeddingModel?: string;
  embeddingDimensions?: number;
  requestedBy?: string | null;
}

function normalizeAiEngine(value: unknown): AiEngine | null {
  return typeof value === 'string' && (AI_ENGINES as readonly string[]).includes(value)
    ? value as AiEngine
    : null;
}

function normalizeEmbeddingModel(value: string): string {
  const model = value.trim();
  return LEGACY_EMBEDDING_MODEL_ALIASES.get(model) ?? model;
}

export function currentAiUsagePeriodStart(timeZone = 'Asia/Saigon', now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const year = parts.find(part => part.type === 'year')?.value ?? String(now.getUTCFullYear());
  const month = parts.find(part => part.type === 'month')?.value ?? String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}-01`;
}

async function ensureSettingsRow(tenantId: string): Promise<void> {
  await query(
    `INSERT INTO tenant_ai_settings (tenant_id, chat_model, lesson_author_model, embedding_model, embedding_dimensions)
     VALUES ($1, $2, $2, $3, 768)
     ON CONFLICT (tenant_id) DO NOTHING`,
    [tenantId, env.GEMINI_CHAT_MODEL, DEFAULT_EMBEDDING_MODEL],
  );
}

async function loadSettingsRow(tenantId: string): Promise<TenantAiSettingsRow> {
  await ensureSettingsRow(tenantId);
  const result = await query<TenantAiSettingsRow>(
    `SELECT
       s.tenant_id::text,
       s.active_engine,
       s.provider,
       s.monthly_token_limit::text,
       s.token_timezone,
       s.chat_model,
       s.lesson_author_model,
       s.embedding_model,
       s.embedding_dimensions,
       s.transition_state,
       s.active_transition_job_id::text,
       secret.encrypted_api_key,
       secret.api_key_fingerprint
     FROM tenant_ai_settings s
     LEFT JOIN tenant_ai_provider_secrets secret
       ON secret.tenant_id = s.tenant_id
      AND secret.provider = s.provider
     WHERE s.tenant_id = $1`,
    [tenantId],
  );
  const row = result.rows[0];
  if (!row) throw new AppError('Không tìm thấy cấu hình AI của doanh nghiệp', 404, 'AI_SETTINGS_NOT_FOUND');
  return row;
}

async function getLegacyGeminiApiKey(tenantId: string): Promise<string | null> {
  const result = await query<{ api_key: string | null }>(
    `SELECT settings->>'gemini_api_key' AS api_key FROM tenants WHERE id = $1`,
    [tenantId],
  );
  const key = result.rows[0]?.api_key?.trim();
  return key || null;
}

/**
 * One-time compatibility path for keys stored in tenants.settings by the old
 * integration. A present secret row with a null key means an administrator
 * explicitly cleared it, so legacy plaintext must never be revived.
 */
async function migrateLegacyGoogleAiStudioApiKey(tenantId: string): Promise<string | null> {
  return withDatabaseTransaction(async () => {
    const existing = await query<{ encrypted_api_key: string | null }>(
      `SELECT encrypted_api_key
       FROM tenant_ai_provider_secrets
       WHERE tenant_id = $1 AND provider = $2`,
      [tenantId, AI_PROVIDER_GOOGLE],
    );
    if (existing.rowCount) {
      const encrypted = existing.rows[0]?.encrypted_api_key;
      return encrypted ? decryptAiProviderKey(encrypted) : null;
    }

    const legacyKey = await getLegacyGeminiApiKey(tenantId);
    if (!legacyKey) return null;

    const encrypted = encryptAiProviderKey(legacyKey);
    const fingerprint = fingerprintAiProviderKey(legacyKey);
    const inserted = await query<{ encrypted_api_key: string | null }>(
      `INSERT INTO tenant_ai_provider_secrets
         (tenant_id, provider, encrypted_api_key, api_key_fingerprint)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, provider) DO NOTHING
       RETURNING encrypted_api_key`,
      [tenantId, AI_PROVIDER_GOOGLE, encrypted, fingerprint],
    );

    if (inserted.rowCount) {
      await query(
        `UPDATE tenants
         SET settings = COALESCE(settings, '{}'::jsonb) - 'gemini_api_key'
         WHERE id = $1`,
        [tenantId],
      );
      return legacyKey;
    }

    // A concurrent CMS update won the insert. Read the committed current key
    // instead of allowing this request to use stale plaintext.
    const concurrent = await query<{ encrypted_api_key: string | null }>(
      `SELECT encrypted_api_key
       FROM tenant_ai_provider_secrets
       WHERE tenant_id = $1 AND provider = $2`,
      [tenantId, AI_PROVIDER_GOOGLE],
    );
    const current = concurrent.rows[0]?.encrypted_api_key;
    return current ? decryptAiProviderKey(current) : null;
  });
}

export async function getGoogleAiStudioApiKey(tenantId: string): Promise<string> {
  const row = await loadSettingsRow(tenantId);
  if (row.encrypted_api_key) return decryptAiProviderKey(row.encrypted_api_key);

  const migratedKey = await migrateLegacyGoogleAiStudioApiKey(tenantId);
  if (migratedKey) return migratedKey;

  throw new AppError(
    'Chưa cấu hình API key Google AI Studio cho doanh nghiệp này.',
    400,
    'AI_PROVIDER_KEY_MISSING',
  );
}

export async function getOptionalGoogleAiStudioApiKeyFingerprint(tenantId: string): Promise<string | null> {
  const row = await loadSettingsRow(tenantId);
  if (row.api_key_fingerprint) return row.api_key_fingerprint;
  const legacyKey = await getLegacyGeminiApiKey(tenantId);
  return legacyKey ? fingerprintAiProviderKey(legacyKey) : null;
}

export async function getTenantAiRuntimeSettings(tenantId: string): Promise<TenantAiRuntimeSettings> {
  const row = await loadSettingsRow(tenantId);
  const hasNewKey = Boolean(row.encrypted_api_key);
  const legacyKey = hasNewKey ? null : await getLegacyGeminiApiKey(tenantId);
  return {
    tenantId,
    activeEngine: row.active_engine,
    provider: row.provider,
    monthlyTokenLimit: row.monthly_token_limit,
    tokenTimezone: row.token_timezone,
    chatModel: row.chat_model,
    lessonAuthorModel: row.lesson_author_model,
    embeddingModel: normalizeEmbeddingModel(row.embedding_model),
    embeddingDimensions: row.embedding_dimensions,
    transitionState: row.transition_state,
    activeTransitionJobId: row.active_transition_job_id,
    hasGoogleAiStudioKey: hasNewKey || Boolean(legacyKey),
    apiKeyFingerprint: row.api_key_fingerprint ?? (legacyKey ? fingerprintAiProviderKey(legacyKey) : null),
  };
}

export async function getTenantAiAdminSettings(tenantId: string): Promise<TenantAiAdminSettings> {
  const runtime = await getTenantAiRuntimeSettings(tenantId);
  const periodStart = currentAiUsagePeriodStart(runtime.tokenTimezone);
  await query(
    `INSERT INTO ai_token_monthly_usage (tenant_id, period_start)
     VALUES ($1, $2::date)
     ON CONFLICT (tenant_id, period_start) DO NOTHING`,
    [tenantId, periodStart],
  );
  const usage = await query<TenantAiUsageRow>(
    `SELECT period_start::text, input_tokens::text, output_tokens::text,
            embedding_tokens::text, total_tokens::text, reserved_tokens::text,
            estimated_cost_vnd::text
     FROM ai_token_monthly_usage
     WHERE tenant_id = $1 AND period_start = $2::date`,
    [tenantId, periodStart],
  );
  const row = usage.rows[0] ?? {
    period_start: periodStart,
    input_tokens: '0',
    output_tokens: '0',
    embedding_tokens: '0',
    total_tokens: '0',
    reserved_tokens: '0',
    estimated_cost_vnd: '0',
  };
  const transition = runtime.activeTransitionJobId
    ? await query<{ to_engine: AiEngine }>(
        `SELECT to_engine FROM ai_engine_transition_jobs WHERE id = $1 AND tenant_id = $2`,
        [runtime.activeTransitionJobId, tenantId],
      )
    : null;
  const used = BigInt(row.total_tokens);
  const reserved = BigInt(row.reserved_tokens);
  const limit = runtime.monthlyTokenLimit === null ? null : BigInt(runtime.monthlyTokenLimit);
  const remaining = limit === null ? null : String(limit - used - reserved > 0n ? limit - used - reserved : 0n);
  return {
    ...runtime,
    tokenPeriodStart: row.period_start.slice(0, 10),
    tokenInputUsed: row.input_tokens,
    tokenOutputUsed: row.output_tokens,
    tokenEmbeddingUsed: row.embedding_tokens,
    tokenTotalUsed: row.total_tokens,
    tokenReserved: row.reserved_tokens,
    tokenRemaining: remaining,
    estimatedCostVnd: row.estimated_cost_vnd,
    pendingEngine: transition?.rows[0]?.to_engine ?? null,
  };
}

async function hasTenantKnowledgeDocuments(tenantId: string): Promise<boolean> {
  const result = await query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM kb_documents
       WHERE tenant_id = $1
       LIMIT 1
     ) AS exists`,
    [tenantId],
  );
  return result.rows[0]?.exists === true;
}

async function markTenantFileSearchStoresKeyChanged(
  tenantId: string,
  currentFingerprint: string | null,
): Promise<void> {
  await query(
    `UPDATE kb_google_store kgs
     SET remote_status = 'key_changed',
         remote_error_code = 'KEY_CHANGED',
         remote_error_reason = 'Tenant Google AI Studio API key was changed; restore this KB to rebuild a store for the current key.',
         last_checked_at = now()
     FROM knowledgebases kb
     WHERE kb.id = kgs.kb_id
       AND kb.tenant_id = $1
       AND kgs.remote_status IN ('active', 'permission_denied')
       AND (
         kgs.api_key_fingerprint IS NULL
         OR $2::text IS NULL
         OR kgs.api_key_fingerprint <> $2::text
       )`,
    [tenantId, currentFingerprint],
  );
}

export async function updateTenantAiSettings(
  tenantId: string,
  input: UpdateTenantAiSettingsInput,
): Promise<TenantAiAdminSettings> {
  const nextEngine = input.activeEngine === undefined ? undefined : normalizeAiEngine(input.activeEngine);
  if (input.activeEngine !== undefined && !nextEngine) {
    throw new AppError('Loại AI không hợp lệ', 400, 'AI_ENGINE_INVALID');
  }
  if (input.embeddingDimensions !== undefined && input.embeddingDimensions !== 768) {
    throw new AppError('Số chiều embedding hiện chỉ hỗ trợ 768', 400, 'AI_EMBEDDING_DIMENSION_INVALID');
  }
  const normalizedLimit = input.monthlyTokenLimit === undefined
    ? undefined
    : input.monthlyTokenLimit === null || input.monthlyTokenLimit.trim() === ''
      ? null
      : input.monthlyTokenLimit.trim();
  if (normalizedLimit !== undefined && normalizedLimit !== null && !/^\d+$/.test(normalizedLimit)) {
    throw new AppError('Hạn mức token phải là số nguyên không âm', 400, 'AI_TOKEN_LIMIT_INVALID');
  }

  await withDatabaseTransaction(async () => {
    await ensureSettingsRow(tenantId);
    const current = await query<{
      active_engine: AiEngine;
      active_transition_job_id: string | null;
      transition_state: TransitionState;
    }>(
      `SELECT active_engine, active_transition_job_id::text, transition_state
       FROM tenant_ai_settings
       WHERE tenant_id = $1
       FOR UPDATE`,
      [tenantId],
    );
    const currentRow = current.rows[0];
    if (!currentRow) throw new AppError('Không tìm thấy cấu hình AI của doanh nghiệp', 404, 'AI_SETTINGS_NOT_FOUND');

    const transitionActive = currentRow.transition_state === 'queued' || currentRow.transition_state === 'running';
    const activeTransition = transitionActive && currentRow.active_transition_job_id
      ? await query<{ to_engine: AiEngine }>(
          `SELECT to_engine
           FROM ai_engine_transition_jobs
           WHERE id = $1
             AND tenant_id = $2
             AND status IN ('queued', 'running')
           FOR UPDATE`,
          [currentRow.active_transition_job_id, tenantId],
        )
      : null;
    const pendingEngine = activeTransition?.rows[0]?.to_engine ?? null;
    if (
      transitionActive
      && nextEngine !== undefined
      && nextEngine !== currentRow.active_engine
      && nextEngine !== pendingEngine
    ) {
      throw new AppError('Doanh nghiệp đang chuyển loại AI. Vui lòng đợi job hiện tại hoàn tất.', 409, 'AI_ENGINE_TRANSITION_ACTIVE');
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    let index = 1;
    const addSet = (sql: string, value: unknown) => {
      sets.push(sql.replace('?', `$${index++}`));
      params.push(value);
    };

    if (normalizedLimit !== undefined) addSet('monthly_token_limit = ?::bigint', normalizedLimit);
    if (input.chatModel !== undefined && input.chatModel.trim()) addSet('chat_model = ?', input.chatModel.trim());
    if (input.lessonAuthorModel !== undefined && input.lessonAuthorModel.trim()) addSet('lesson_author_model = ?', input.lessonAuthorModel.trim());
    if (input.embeddingModel !== undefined && input.embeddingModel.trim()) addSet('embedding_model = ?', normalizeEmbeddingModel(input.embeddingModel));
    if (input.embeddingDimensions !== undefined) addSet('embedding_dimensions = ?::int', input.embeddingDimensions);

    const targetEngine = nextEngine ?? currentRow.active_engine;
    if (!transitionActive && targetEngine !== currentRow.active_engine) {
      if (await hasTenantKnowledgeDocuments(tenantId)) {
        const job = await query<{ id: string }>(
          `INSERT INTO ai_engine_transition_jobs (tenant_id, from_engine, to_engine, requested_by)
           VALUES ($1, $2, $3, $4)
           RETURNING id::text AS id`,
          [tenantId, currentRow.active_engine, targetEngine, input.requestedBy ?? null],
        );
        addSet('transition_state = ?', 'queued');
        addSet('active_transition_job_id = ?::uuid', job.rows[0].id);
      } else {
        addSet('active_engine = ?', targetEngine);
        addSet('transition_state = ?', 'idle');
        addSet('active_transition_job_id = ?::uuid', null);
      }
    }

    if (sets.length > 0) {
      params.push(tenantId);
      await query(
        `UPDATE tenant_ai_settings SET ${sets.join(', ')} WHERE tenant_id = $${index}`,
        params,
      );
    }

    const rawKey = input.googleAiStudioApiKey?.trim();
    const shouldClearKey = input.clearGoogleAiStudioApiKey === true;
    if (rawKey || shouldClearKey) {
      const encrypted = rawKey ? encryptAiProviderKey(rawKey) : null;
      const fingerprint = rawKey ? fingerprintAiProviderKey(rawKey) : null;
      await query(
        `INSERT INTO tenant_ai_provider_secrets
           (tenant_id, provider, encrypted_api_key, api_key_fingerprint)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, provider) DO UPDATE
           SET encrypted_api_key = EXCLUDED.encrypted_api_key,
               api_key_fingerprint = EXCLUDED.api_key_fingerprint,
               updated_at = now()`,
        [tenantId, AI_PROVIDER_GOOGLE, encrypted, fingerprint],
      );
      await query(
        `UPDATE tenants
         SET settings = COALESCE(settings, '{}'::jsonb) - 'gemini_api_key'
         WHERE id = $1`,
        [tenantId],
      );
      await markTenantFileSearchStoresKeyChanged(tenantId, fingerprint);
    }

    const transitionSettingUpdated = transitionActive && (
      Boolean(rawKey)
      || shouldClearKey
      || input.chatModel !== undefined
      || input.lessonAuthorModel !== undefined
      || input.embeddingModel !== undefined
      || input.embeddingDimensions !== undefined
    );
    if (transitionSettingUpdated && currentRow.active_transition_job_id) {
      await query(
        `UPDATE ai_engine_transition_jobs
         SET next_attempt_at = now(),
             last_error = NULL,
             updated_at = now()
         WHERE id = $1
           AND tenant_id = $2
           AND status = 'queued'`,
        [currentRow.active_transition_job_id, tenantId],
      );
    }
  });

  return getTenantAiAdminSettings(tenantId);
}

export function removeAiSecretsFromTenantSettings(settings: unknown): Record<string, unknown> {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return {};
  const clone = { ...(settings as Record<string, unknown>) };
  delete clone.gemini_api_key;
  return clone;
}
