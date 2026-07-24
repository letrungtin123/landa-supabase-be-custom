import { query } from '../../config/database.js';
import { env } from '../../config/env.js';
import { blacklistUser } from '../../middleware/authenticate.js';
import { AppError } from '../../middleware/error-handler.js';
import { calcOffset, calcTotalPages, parsePagination } from '../../utils/query-helpers.js';

export type DemoIframeSessionMode = 'normal' | 'demo_iframe';

type TimestampLike = Date | string | null;

interface TenantRow {
  id: string;
  name: string;
  domain_learner: string | null;
  is_active: boolean;
}

interface DemoIframeSettingsRow {
  tenant_id: string;
  is_enabled: boolean;
  allowed_origin: string | null;
  demo_user_id: string | null;
  public_embed_id: string;
  updated_by: string | null;
  created_at: TimestampLike;
  updated_at: TimestampLike;
  tenant_name: string;
  tenant_domain_learner: string | null;
  tenant_is_active: boolean;
  learner_username: string | null;
  learner_email: string | null;
  learner_full_name: string | null;
  learner_avatar_url: string | null;
  learner_is_active: boolean | null;
  learner_role: string | null;
}

export interface DemoIframeConfigInput {
  is_enabled?: boolean;
  allowed_origin?: string | null;
  demo_user_id?: string | null;
}

function iso(value: TimestampLike): string | null {
  return value ? new Date(value).toISOString() : null;
}

function isObjectWithSessionMode(value: unknown): value is { sessionMode?: string | null } {
  return typeof value === 'object' && value !== null && 'sessionMode' in value;
}

export function isDemoIframeSession(value: unknown): boolean {
  return isObjectWithSessionMode(value) && value.sessionMode === 'demo_iframe';
}

export function normalizeSessionMode(value: unknown): DemoIframeSessionMode {
  return value === 'demo_iframe' ? 'demo_iframe' : 'normal';
}

export function normalizeAllowedOrigin(raw: string | null | undefined): string | null {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return null;
  if (trimmed.includes('*')) {
    throw new AppError('Domain demo iframe không được chứa wildcard', 400);
  }

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withProtocol);
  } catch {
    throw new AppError('Domain demo iframe không hợp lệ', 400);
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new AppError('Domain demo iframe chỉ hỗ trợ http(s)', 400);
  }
  if (url.username || url.password) {
    throw new AppError('Domain demo iframe không được chứa thông tin đăng nhập', 400);
  }
  if (url.search || url.hash || (url.pathname && url.pathname !== '/')) {
    throw new AppError('Domain demo iframe phải là origin, không kèm path/query/hash', 400);
  }
  return url.origin.toLowerCase();
}

function buildOrigin(raw: string | null | undefined): string | null {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return null;
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withProtocol);
    return url.origin;
  } catch {
    return null;
  }
}

const DEMO_IFRAME_STRIPPED_PUBLIC_PORTS = new Set(['80', '5173', '5273']);

function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '::1'
    || normalized.endsWith('.localhost');
}

function buildConfiguredDemoIframePublicOrigin(): string | null {
  if (!env.DEMO_IFRAME_PUBLIC_ORIGIN) return null;
  const origin = buildOrigin(env.DEMO_IFRAME_PUBLIC_ORIGIN);
  if (!origin) throw new AppError('DEMO_IFRAME_PUBLIC_ORIGIN không hợp lệ', 500);
  const url = new URL(origin);
  if (url.protocol !== 'https:') {
    throw new AppError('DEMO_IFRAME_PUBLIC_ORIGIN phải dùng HTTPS', 500);
  }
  return url.origin.toLowerCase();
}

function buildDemoIframePublicOrigin(domainLearner: string | null | undefined): string | null {
  const configuredOrigin = buildConfiguredDemoIframePublicOrigin();
  if (configuredOrigin) return configuredOrigin;

  const origin = buildOrigin(domainLearner);
  if (!origin) return null;
  const url = new URL(origin);
  if (!isLocalHostname(url.hostname)) {
    url.protocol = 'https:';
    if (DEMO_IFRAME_STRIPPED_PUBLIC_PORTS.has(url.port)) {
      url.port = '';
    }
  }
  return url.origin.toLowerCase();
}

function buildEmbedUrl(domainLearner: string | null, embedId: string): string | null {
  const origin = buildDemoIframePublicOrigin(domainLearner);
  if (!origin) return null;
  const url = new URL('/demo-embed', origin);
  url.searchParams.set('embed', embedId);
  return url.toString();
}

function buildIframeCode(embedUrl: string | null, allowedOrigin: string | null): string | null {
  if (!embedUrl || !allowedOrigin) return null;
  return `<iframe src="${embedUrl}" style="width:100%;height:100vh;border:0;" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads" allow="fullscreen" title="LANDA demo"></iframe>`;
}

function buildComparableOrigin(raw: string | null | undefined): string | null {
  return buildDemoIframePublicOrigin(raw);
}

function formatSettings(row: DemoIframeSettingsRow) {
  const embedUrl = buildEmbedUrl(row.tenant_domain_learner, row.public_embed_id);
  return {
    tenant: {
      id: row.tenant_id,
      name: row.tenant_name,
      domain_learner: row.tenant_domain_learner,
      is_active: row.tenant_is_active,
    },
    settings: {
      tenant_id: row.tenant_id,
      is_enabled: row.is_enabled,
      allowed_origin: row.allowed_origin,
      demo_user_id: row.demo_user_id,
      public_embed_id: row.public_embed_id,
      embed_url: embedUrl,
      iframe_code: buildIframeCode(embedUrl, row.allowed_origin),
      updated_by: row.updated_by,
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at),
    },
    learner: row.demo_user_id ? {
      id: row.demo_user_id,
      username: row.learner_username,
      email: row.learner_email,
      full_name: row.learner_full_name,
      avatar_url: row.learner_avatar_url,
      is_active: row.learner_is_active,
      role: row.learner_role,
      is_locked: row.is_enabled,
    } : null,
  };
}

async function getTenantById(tenantId: string): Promise<TenantRow> {
  const result = await query<TenantRow>(
    'SELECT id, name, domain_learner, is_active FROM tenants WHERE id = $1',
    [tenantId],
  );
  const tenant = result.rows[0];
  if (!tenant) throw new AppError('Tenant không tồn tại', 404);
  return tenant;
}

async function ensureDemoIframeSettings(tenantId: string): Promise<void> {
  await getTenantById(tenantId);
  await query(
    `INSERT INTO tenant_demo_iframe_settings (tenant_id)
     VALUES ($1)
     ON CONFLICT (tenant_id) DO NOTHING`,
    [tenantId],
  );
}

async function getSettingsRow(tenantId: string): Promise<DemoIframeSettingsRow> {
  const result = await query<DemoIframeSettingsRow>(
    `SELECT s.tenant_id, s.is_enabled, s.allowed_origin, s.demo_user_id,
            s.public_embed_id, s.updated_by, s.created_at, s.updated_at,
            t.name AS tenant_name, t.domain_learner AS tenant_domain_learner,
            t.is_active AS tenant_is_active,
            u.username AS learner_username, u.email AS learner_email,
            u.full_name AS learner_full_name, u.avatar_url AS learner_avatar_url,
            u.is_active AS learner_is_active, u.role::text AS learner_role
     FROM tenant_demo_iframe_settings s
     JOIN tenants t ON t.id = s.tenant_id
     LEFT JOIN users u ON u.id = s.demo_user_id
     WHERE s.tenant_id = $1`,
    [tenantId],
  );
  const row = result.rows[0];
  if (!row) throw new AppError('Cấu hình demo iframe không tồn tại', 404);
  return row;
}

async function validateDemoLearner(tenantId: string, userId: string): Promise<void> {
  const result = await query<{ id: string }>(
    `SELECT id
     FROM users
     WHERE id = $1
       AND tenant_id = $2
       AND role = 'learner'
       AND is_active = true`,
    [userId, tenantId],
  );
  if (result.rowCount === 0) {
    throw new AppError('Chỉ được chọn tài khoản learner đang hoạt động của tenant này', 400);
  }
}

async function revokeRefreshTokens(userId: string, mode?: DemoIframeSessionMode): Promise<void> {
  const params: unknown[] = [userId];
  let modeClause = '';
  if (mode) {
    params.push(mode);
    modeClause = ` AND session_mode = $${params.length}`;
  }
  await query(
    `UPDATE refresh_tokens
     SET revoked = true, revoked_at = COALESCE(revoked_at, now())
     WHERE user_id = $1
       AND revoked = false${modeClause}`,
    params,
  );
}

export async function revokeNormalSessionsForDemoIframeAccount(userId: string): Promise<void> {
  await query(
    `UPDATE refresh_tokens
     SET revoked = true, revoked_at = COALESCE(revoked_at, now())
     WHERE user_id = $1
       AND revoked = false
       AND COALESCE(session_mode, 'normal') = 'normal'`,
    [userId],
  );
  blacklistUser(userId, 'normal');
}

export async function getDemoIframeConfig(tenantId: string) {
  await ensureDemoIframeSettings(tenantId);
  return formatSettings(await getSettingsRow(tenantId));
}

export async function updateDemoIframeConfig(
  tenantId: string,
  input: DemoIframeConfigInput,
  actorId: string | null,
) {
  await ensureDemoIframeSettings(tenantId);
  const current = await getSettingsRow(tenantId);
  const nextEnabled = input.is_enabled ?? current.is_enabled;
  const nextAllowedOrigin = input.allowed_origin !== undefined
    ? normalizeAllowedOrigin(input.allowed_origin)
    : current.allowed_origin;
  const nextDemoUserId = input.demo_user_id !== undefined
    ? input.demo_user_id
    : current.demo_user_id;

  if (nextEnabled && (!nextAllowedOrigin || !nextDemoUserId)) {
    throw new AppError('Bật demo iframe cần có domain và learner demo', 400);
  }

  if (nextDemoUserId) {
    await validateDemoLearner(tenantId, nextDemoUserId);
  }

  await query(
    `UPDATE tenant_demo_iframe_settings
     SET is_enabled = $2,
         allowed_origin = $3,
         demo_user_id = $4,
         updated_by = $5,
         updated_at = now()
     WHERE tenant_id = $1`,
    [tenantId, nextEnabled, nextAllowedOrigin, nextDemoUserId, actorId],
  );

  const currentDemoUserId = current.demo_user_id;
  if (currentDemoUserId && (!nextEnabled || currentDemoUserId !== nextDemoUserId)) {
    await revokeRefreshTokens(currentDemoUserId, 'demo_iframe');
    blacklistUser(currentDemoUserId, 'demo_iframe');
  }
  if (nextEnabled && nextDemoUserId) {
    await revokeNormalSessionsForDemoIframeAccount(nextDemoUserId);
  }

  return getDemoIframeConfig(tenantId);
}

export async function regenerateDemoIframeEmbedId(tenantId: string, actorId: string | null) {
  await ensureDemoIframeSettings(tenantId);
  const current = await getSettingsRow(tenantId);
  await query(
    `UPDATE tenant_demo_iframe_settings
     SET public_embed_id = gen_random_uuid(),
         updated_by = $2,
         updated_at = now()
     WHERE tenant_id = $1`,
    [tenantId, actorId],
  );
  if (current.demo_user_id) {
    await revokeRefreshTokens(current.demo_user_id, 'demo_iframe');
    blacklistUser(current.demo_user_id, 'demo_iframe');
  }
  return getDemoIframeConfig(tenantId);
}

export async function searchEligibleIframeLearners(tenantId: string, queryParams: Record<string, unknown>) {
  await getTenantById(tenantId);
  const { page, pageSize, search } = parsePagination(queryParams);
  const offset = calcOffset(page, pageSize);
  const params: unknown[] = [tenantId];
  const conditions = [
    'u.tenant_id = $1',
    "u.role = 'learner'",
    'u.is_active = true',
  ];

  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(u.username ILIKE $${params.length} OR u.email ILIKE $${params.length} OR u.full_name ILIKE $${params.length})`);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;
  const [countResult, dataResult] = await Promise.all([
    query<{ count: string }>(`SELECT COUNT(*) AS count FROM users u ${where}`, params),
    query<{
      id: string;
      username: string;
      email: string;
      full_name: string | null;
      avatar_url: string | null;
      created_at: TimestampLike;
      is_demo_iframe_active: boolean;
    }>(
      `SELECT u.id, u.username, u.email, u.full_name, u.avatar_url, u.created_at,
              EXISTS (
                SELECT 1
                FROM tenant_demo_iframe_settings s
                WHERE s.demo_user_id = u.id
                  AND s.is_enabled = true
              ) AS is_demo_iframe_active
       FROM users u
       ${where}
       ORDER BY u.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset],
    ),
  ]);

  const total = Number.parseInt(countResult.rows[0].count, 10);
  return {
    data: dataResult.rows.map((row) => ({
      id: row.id,
      username: row.username,
      email: row.email,
      full_name: row.full_name,
      avatar_url: row.avatar_url,
      created_at: iso(row.created_at),
      is_demo_iframe_active: row.is_demo_iframe_active,
    })),
    total,
    page,
    pageSize,
    totalPages: calcTotalPages(total, pageSize),
  };
}

export async function resolveDemoIframeBootstrap(
  embedId: string,
  parentOriginRaw: string | null | undefined,
  requestOriginRaw: string | null | undefined,
) {
  const parentOrigin = normalizeAllowedOrigin(parentOriginRaw);
  if (!parentOrigin) throw new AppError('Không xác định được domain nhúng iframe', 400);
  const requestOrigin = normalizeAllowedOrigin(requestOriginRaw);
  if (!requestOrigin) throw new AppError('Không xác định được origin khởi tạo demo iframe', 403);

  const result = await query<{
    tenant_id: string;
    tenant_name: string;
    tenant_domain_learner: string | null;
    allowed_origin: string;
    demo_user_id: string;
    username: string;
    full_name: string | null;
  }>(
    `SELECT s.tenant_id, t.name AS tenant_name, t.domain_learner AS tenant_domain_learner,
            s.allowed_origin, s.demo_user_id, u.username, u.full_name
     FROM tenant_demo_iframe_settings s
     JOIN tenants t ON t.id = s.tenant_id
     JOIN users u ON u.id = s.demo_user_id
     WHERE s.public_embed_id = $1
       AND s.is_enabled = true
       AND s.allowed_origin IS NOT NULL
       AND s.demo_user_id IS NOT NULL
       AND t.is_active = true
       AND u.role = 'learner'
       AND u.is_active = true
     LIMIT 1`,
    [embedId],
  );

  const row = result.rows[0];
  if (!row) throw new AppError('Demo iframe không khả dụng', 404);
  const learnerOrigin = buildComparableOrigin(row.tenant_domain_learner);
  if (!learnerOrigin) {
    throw new AppError('Tenant chưa cấu hình domain learner hợp lệ', 409);
  }
  if (requestOrigin !== learnerOrigin) {
    throw new AppError('Origin khởi tạo demo iframe không được phép', 403);
  }
  if (row.allowed_origin !== parentOrigin) {
    throw new AppError('Domain nhúng iframe không được phép', 403);
  }

  return {
    tenant: {
      id: row.tenant_id,
      name: row.tenant_name,
      domain_learner: row.tenant_domain_learner,
    },
    user_id: row.demo_user_id,
    parent_origin: parentOrigin,
    request_origin: requestOrigin,
    learner_label: row.full_name || row.username,
  };
}

export async function isActiveDemoIframeAccount(userId: string): Promise<boolean> {
  try {
    const result = await query<{ exists: boolean }>(
      `SELECT EXISTS (
        SELECT 1
        FROM tenant_demo_iframe_settings
        WHERE demo_user_id = $1
          AND is_enabled = true
      ) AS exists`,
      [userId],
    );
    return result.rows[0]?.exists === true;
  } catch (err) {
    if ((err as { code?: string }).code === '42P01' || (err as { code?: string }).code === '42703') return false;
    throw err;
  }
}

export async function getActiveDemoIframeUserIds(userIds: string[]): Promise<Set<string>> {
  const unique = [...new Set(userIds)].filter(Boolean);
  if (unique.length === 0) return new Set();
  try {
    const result = await query<{ demo_user_id: string }>(
      `SELECT demo_user_id
       FROM tenant_demo_iframe_settings
       WHERE demo_user_id = ANY($1::uuid[])
         AND is_enabled = true`,
      [unique],
    );
    return new Set(result.rows.map((row) => row.demo_user_id));
  } catch (err) {
    if ((err as { code?: string }).code === '42P01' || (err as { code?: string }).code === '42703') return new Set();
    throw err;
  }
}

export async function assertUserNotActiveDemoIframeAccount(userId: string, message?: string): Promise<void> {
  if (await isActiveDemoIframeAccount(userId)) {
    throw new AppError(message || 'Tài khoản learner demo iframe đang được khóa', 403);
  }
}
