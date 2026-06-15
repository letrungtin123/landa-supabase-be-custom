import { query } from '../../config/database.js';
import { AppError } from '../../middleware/error-handler.js';
import { issueSessionForUserId } from '../auth/auth.service.js';
import { randomBytes } from 'crypto';
import { hashPassword } from '../../utils/password.js';
import { decryptSecret, encryptSecret } from './sso.crypto.js';
import type { ExchangeSsoCodeInput, UpdateSsoConfigInput } from './sso.validator.js';
import { SSO_PROVIDERS, type PublicSsoProvider, type SsoConfigRow, type SsoProvider } from './sso.types.js';

const PUBLIC_CACHE_TTL_MS = 60_000;
const publicConfigCache = new Map<string, { expires: number; data: PublicSsoResponse }>();

interface PublicSsoResponse {
  tenant_id: string | null;
  tenant_name: string | null;
  providers: PublicSsoProvider[];
}

interface ProviderProfile {
  sub: string;
  email: string;
  email_verified?: boolean | string;
  name?: string;
}

const PROVIDER_LABELS: Record<SsoProvider, string> = {
  google: 'Google',
  keycloak: 'Keycloak',
  microsoft365: 'Microsoft 365',
};

const DEFAULT_SCOPES: Record<SsoProvider, string[]> = {
  google: ['openid', 'email', 'profile'],
  keycloak: ['openid', 'email', 'profile'],
  microsoft365: ['openid', 'email', 'profile'],
};

function normalizeDomain(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '');
}

function compactConfig(row?: SsoConfigRow | null) {
  return {
    provider: row?.provider,
    is_enabled: row?.is_enabled ?? false,
    client_id: row?.client_id || '',
    has_secret: !!row?.client_secret_enc,
    issuer_url: row?.issuer_url || '',
    authorization_url: row?.authorization_url || '',
    token_url: row?.token_url || '',
    userinfo_url: row?.userinfo_url || '',
    scopes: row?.scopes || [],
    extra_config: row?.extra_config || {},
    created_at: row?.created_at || null,
    updated_at: row?.updated_at || null,
  };
}

function resolveAuthorizationUrl(row: SsoConfigRow): string {
  if (row.authorization_url) return row.authorization_url;
  if (row.provider === 'google') return 'https://accounts.google.com/o/oauth2/v2/auth';
  if (row.provider === 'microsoft365' && row.issuer_url) return `${row.issuer_url.replace(/\/+$/, '')}/oauth2/v2.0/authorize`;
  if (row.provider === 'keycloak' && row.issuer_url) return `${row.issuer_url.replace(/\/+$/, '')}/protocol/openid-connect/auth`;
  return '';
}

function resolveTokenUrl(row: SsoConfigRow): string {
  if (row.token_url) return row.token_url;
  if (row.provider === 'google') return 'https://oauth2.googleapis.com/token';
  if (row.provider === 'microsoft365' && row.issuer_url) return `${row.issuer_url.replace(/\/+$/, '')}/oauth2/v2.0/token`;
  if (row.provider === 'keycloak' && row.issuer_url) return `${row.issuer_url.replace(/\/+$/, '')}/protocol/openid-connect/token`;
  return '';
}

function resolveUserinfoUrl(row: SsoConfigRow): string {
  if (row.userinfo_url) return row.userinfo_url;
  if (row.provider === 'google') return 'https://www.googleapis.com/oauth2/v3/userinfo';
  if (row.provider === 'microsoft365') return 'https://graph.microsoft.com/oidc/userinfo';
  if (row.provider === 'keycloak' && row.issuer_url) return `${row.issuer_url.replace(/\/+$/, '')}/protocol/openid-connect/userinfo`;
  return '';
}

function toPublicProvider(row: SsoConfigRow): PublicSsoProvider | null {
  if (!row.is_enabled || !row.client_id) return null;
  const authorizationUrl = resolveAuthorizationUrl(row);
  if (!authorizationUrl) return null;

  return {
    provider: row.provider,
    label: PROVIDER_LABELS[row.provider],
    client_id: row.client_id,
    authorization_url: authorizationUrl,
    scopes: row.scopes?.length ? row.scopes : DEFAULT_SCOPES[row.provider],
    callback_path: '/sso-callback.html',
  };
}

export function clearSsoPublicCache(): void {
  publicConfigCache.clear();
}

export async function listConfigs(tenantId: string) {
  const result = await query<SsoConfigRow>(
    `SELECT id, tenant_id, provider, is_enabled, client_id, client_secret_enc,
            issuer_url, authorization_url, token_url, userinfo_url, scopes,
            extra_config, created_at, updated_at
     FROM tenant_sso_configs
     WHERE tenant_id = $1`,
    [tenantId],
  );

  const rowsByProvider = new Map<SsoProvider, SsoConfigRow>();
  for (const row of result.rows) rowsByProvider.set(row.provider, row);

  return SSO_PROVIDERS.map((provider) => ({
    ...compactConfig(rowsByProvider.get(provider)),
    provider,
    label: PROVIDER_LABELS[provider],
  }));
}

export async function updateConfig(tenantId: string, provider: SsoProvider, input: UpdateSsoConfigInput) {
  const existing = await query<SsoConfigRow>(
    'SELECT * FROM tenant_sso_configs WHERE tenant_id = $1 AND provider = $2 LIMIT 1',
    [tenantId, provider],
  );

  const current = existing.rows[0];
  let encryptedSecret = current?.client_secret_enc || null;
  if (input.clear_client_secret) encryptedSecret = null;
  if (input.client_secret && input.client_secret.trim()) encryptedSecret = encryptSecret(input.client_secret.trim());

  const scopes = input.scopes ?? current?.scopes ?? DEFAULT_SCOPES[provider];
  const currentExtraConfig = current?.extra_config && typeof current.extra_config === 'object' && !Array.isArray(current.extra_config)
    ? current.extra_config
    : {};
  const inputExtraConfig = input.extra_config && typeof input.extra_config === 'object' && !Array.isArray(input.extra_config)
    ? input.extra_config
    : {};
  const extraConfig = input.extra_config ? { ...currentExtraConfig, ...inputExtraConfig } : currentExtraConfig;

  const result = await query<SsoConfigRow>(
    `INSERT INTO tenant_sso_configs (
       tenant_id, provider, is_enabled, client_id, client_secret_enc,
       issuer_url, authorization_url, token_url, userinfo_url, scopes, extra_config
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (tenant_id, provider) DO UPDATE SET
       is_enabled = EXCLUDED.is_enabled,
       client_id = EXCLUDED.client_id,
       client_secret_enc = EXCLUDED.client_secret_enc,
       issuer_url = EXCLUDED.issuer_url,
       authorization_url = EXCLUDED.authorization_url,
       token_url = EXCLUDED.token_url,
       userinfo_url = EXCLUDED.userinfo_url,
       scopes = EXCLUDED.scopes,
       extra_config = EXCLUDED.extra_config,
       updated_at = now()
     RETURNING *`,
    [
      tenantId,
      provider,
      input.is_enabled ?? current?.is_enabled ?? false,
      input.client_id ?? current?.client_id ?? null,
      encryptedSecret,
      input.issuer_url ?? current?.issuer_url ?? null,
      input.authorization_url ?? current?.authorization_url ?? null,
      input.token_url ?? current?.token_url ?? null,
      input.userinfo_url ?? current?.userinfo_url ?? null,
      scopes,
      JSON.stringify(extraConfig),
    ],
  );

  clearSsoPublicCache();
  return {
    ...compactConfig(result.rows[0]),
    provider,
    label: PROVIDER_LABELS[provider],
  };
}

export async function deleteConfig(tenantId: string, provider: SsoProvider): Promise<void> {
  await query('DELETE FROM tenant_sso_configs WHERE tenant_id = $1 AND provider = $2', [tenantId, provider]);
  clearSsoPublicCache();
}

export async function getPublicConfigByDomain(domain: string): Promise<PublicSsoResponse> {
  const normalizedDomain = normalizeDomain(domain);
  const cached = publicConfigCache.get(normalizedDomain);
  if (cached && cached.expires > Date.now()) return cached.data;

  const tenantResult = await query<{ id: string; name: string }>(
    `SELECT id, name FROM tenants
     WHERE (
       lower(regexp_replace(regexp_replace(regexp_replace(domain_learner, '^https?://', ''), '/.*$', ''), ':[0-9]+$', '')) = $1
       OR lower(regexp_replace(regexp_replace(regexp_replace(domain_admin, '^https?://', ''), '/.*$', ''), ':[0-9]+$', '')) = $1
     ) AND is_active = true
     LIMIT 1`,
    [normalizedDomain],
  );

  if (tenantResult.rowCount === 0) {
    return { tenant_id: null, tenant_name: null, providers: [] };
  }

  const tenant = tenantResult.rows[0];
  const configs = await query<SsoConfigRow>(
    `SELECT * FROM tenant_sso_configs
     WHERE tenant_id = $1 AND is_enabled = true`,
    [tenant.id],
  );

  const providers = configs.rows
    .map(toPublicProvider)
    .filter((item): item is PublicSsoProvider => !!item);

  const data = { tenant_id: tenant.id, tenant_name: tenant.name, providers };
  publicConfigCache.set(normalizedDomain, { data, expires: Date.now() + PUBLIC_CACHE_TTL_MS });
  return data;
}

async function getEnabledConfig(tenantId: string, provider: SsoProvider): Promise<SsoConfigRow> {
  const result = await query<SsoConfigRow>(
    `SELECT * FROM tenant_sso_configs
     WHERE tenant_id = $1 AND provider = $2 AND is_enabled = true
     LIMIT 1`,
    [tenantId, provider],
  );
  if (result.rowCount === 0) throw new AppError('SSO provider chưa được bật cho tenant này', 403);
  return result.rows[0];
}

async function exchangeCodeForProfile(row: SsoConfigRow, input: ExchangeSsoCodeInput): Promise<ProviderProfile> {
  const tokenUrl = resolveTokenUrl(row);
  const userinfoUrl = resolveUserinfoUrl(row);
  const clientSecret = decryptSecret(row.client_secret_enc);

  if (!row.client_id || !clientSecret || !tokenUrl || !userinfoUrl) {
    throw new AppError('SSO provider chưa được cấu hình đầy đủ', 400);
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirect_uri,
    client_id: row.client_id,
    client_secret: clientSecret,
  });
  if (input.code_verifier) body.set('code_verifier', input.code_verifier);

  const tokenResponse = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!tokenResponse.ok) throw new AppError('Không thể xác thực SSO code', 401);

  const tokenJson = await tokenResponse.json() as { access_token?: string };
  if (!tokenJson.access_token) throw new AppError('SSO provider không trả access token', 401);

  const profileResponse = await fetch(userinfoUrl, {
    headers: { Authorization: `Bearer ${tokenJson.access_token}` },
  });
  if (!profileResponse.ok) throw new AppError('Không thể lấy thông tin SSO user', 401);

  const profile = await profileResponse.json() as ProviderProfile;
  if (!profile.sub || !profile.email) throw new AppError('SSO profile thiếu email hoặc subject', 401);
  if (profile.email_verified === false || profile.email_verified === 'false') {
    throw new AppError('Email SSO chưa được xác minh', 403);
  }
  return profile;
}

function isAutoRegisterEnabled(row: SsoConfigRow): boolean {
  return row.extra_config?.auto_register_enabled === true;
}

function buildUsernameBase(email: string): string {
  const localPart = email.split('@')[0]?.toLowerCase() || 'sso-user';
  const safe = localPart
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 120);
  return safe.length >= 3 ? safe : `sso-${safe || 'user'}`;
}

async function buildUniqueUsername(email: string): Promise<string> {
  const base = buildUsernameBase(email);
  for (let i = 0; i < 20; i += 1) {
    const suffix = i === 0 ? '' : `-${i}`;
    const username = `${base}${suffix}`.slice(0, 150);
    const existing = await query('SELECT id FROM users WHERE username = $1 LIMIT 1', [username]);
    if (existing.rowCount === 0) return username;
  }
  return `${base.slice(0, 140)}-${randomBytes(4).toString('hex')}`;
}

async function createLearnerFromProfile(
  tenantId: string,
  provider: SsoProvider,
  profile: ProviderProfile,
  autoActivate: boolean,
): Promise<string> {
  const { checkQuota } = await import('../tenants/tenants.service.js');
  await checkQuota(tenantId, 'users');

  const username = await buildUniqueUsername(profile.email);
  const randomPassword = randomBytes(48).toString('base64url');
  const passwordHash = await hashPassword(randomPassword);
  const fullName = (profile.name || profile.email.split('@')[0] || username).trim();

  const user = await query<{ id: string }>(
    `INSERT INTO users (username, email, password_hash, full_name, phone, role, tenant_id, is_active)
     VALUES ($1, $2, $3, $4, '', 'learner', $5, $6)
     RETURNING id`,
    [username, profile.email, passwordHash, fullName, tenantId, autoActivate],
  );

  const userId = user.rows[0].id;
  await query(
    `INSERT INTO sso_user_identities (tenant_id, user_id, provider, provider_subject, email)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, provider, provider_subject)
     DO UPDATE SET user_id = EXCLUDED.user_id, email = EXCLUDED.email, updated_at = now()`,
    [tenantId, userId, provider, profile.sub, profile.email],
  );

  if (!autoActivate) {
    throw new AppError('Tài khoản SSO đã được tạo và đang chờ staff/superuser duyệt', 403);
  }

  return userId;
}

async function resolveUserForProfile(tenantId: string, provider: SsoProvider, profile: ProviderProfile, config: SsoConfigRow): Promise<string> {
  const identity = await query<{ user_id: string; is_active: boolean }>(
    `SELECT i.user_id, u.is_active
     FROM sso_user_identities i
     JOIN users u ON u.id = i.user_id
     WHERE i.tenant_id = $1 AND i.provider = $2 AND i.provider_subject = $3
     LIMIT 1`,
    [tenantId, provider, profile.sub],
  );
  if (identity.rowCount && identity.rows[0]?.user_id) {
    if (!identity.rows[0].is_active) {
      throw new AppError('Tài khoản SSO đang chờ duyệt hoặc đã bị vô hiệu hóa', 403);
    }
    return identity.rows[0].user_id;
  }

  const user = await query<{ id: string; tenant_id: string | null; role: string; is_active: boolean }>(
    `SELECT id, tenant_id, role, is_active
     FROM users
     WHERE lower(email) = lower($1)
     LIMIT 1`,
    [profile.email],
  );

  if (user.rowCount === 0) {
    return createLearnerFromProfile(tenantId, provider, profile, isAutoRegisterEnabled(config));
  }

  const existingUser = user.rows[0];
  if (existingUser.tenant_id !== tenantId && existingUser.role !== 'superadmin') {
    throw new AppError('Email SSO đã thuộc tenant khác', 403);
  }
  if (!existingUser.is_active) {
    throw new AppError('Tài khoản SSO đang chờ duyệt hoặc đã bị vô hiệu hóa', 403);
  }

  const userId = existingUser.id;
  await query(
    `INSERT INTO sso_user_identities (tenant_id, user_id, provider, provider_subject, email)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, provider, provider_subject)
     DO UPDATE SET user_id = EXCLUDED.user_id, email = EXCLUDED.email, updated_at = now()`,
    [tenantId, userId, provider, profile.sub, profile.email],
  );
  return userId;
}

export async function exchangeSsoCode(provider: SsoProvider, input: ExchangeSsoCodeInput) {
  const config = await getEnabledConfig(input.tenant_id, provider);
  const profile = await exchangeCodeForProfile(config, input);
  const userId = await resolveUserForProfile(input.tenant_id, provider, profile, config);
  return issueSessionForUserId(userId);
}
