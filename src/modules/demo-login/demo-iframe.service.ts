import { query } from '../../config/database.js';
import { env } from '../../config/env.js';
import { blacklistUser } from '../../middleware/authenticate.js';
import { AppError } from '../../utils/errors.js';
import { calcOffset, calcTotalPages, parsePagination } from '../../utils/query-helpers.js';
import {
  createDemoIframeRepository,
  type DemoIframeDb,
  type DemoIframeSettingsRow,
} from './demo-iframe.repository.js';
import type { DemoTenantRow as TenantRow, TimestampLike } from './demo-login.repository.js';

export type DemoIframeSessionMode = 'normal' | 'demo_iframe';

// query() joins the caller's current transaction (withDatabaseTransaction) when there is one.
const poolDb: DemoIframeDb = { query };
const demoIframeRepository = createDemoIframeRepository(poolDb);

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
  const tenant = await demoIframeRepository.selectTenantById(tenantId);
  if (!tenant) throw new AppError('Tenant không tồn tại', 404);
  return tenant;
}

async function ensureDemoIframeSettings(tenantId: string): Promise<void> {
  await getTenantById(tenantId);
  await demoIframeRepository.insertSettingsIfMissing(tenantId);
}

async function getSettingsRow(tenantId: string): Promise<DemoIframeSettingsRow> {
  const row = await demoIframeRepository.selectSettingsRow(tenantId);
  if (!row) throw new AppError('Cấu hình demo iframe không tồn tại', 404);
  return row;
}

async function validateDemoLearner(tenantId: string, userId: string): Promise<void> {
  if (!(await demoIframeRepository.isActiveLearnerOfTenant(tenantId, userId))) {
    throw new AppError('Chỉ được chọn tài khoản learner đang hoạt động của tenant này', 400);
  }
}

async function revokeRefreshTokens(userId: string, mode?: DemoIframeSessionMode): Promise<void> {
  await demoIframeRepository.revokeRefreshTokens(userId, mode);
}

export async function revokeNormalSessionsForDemoIframeAccount(userId: string): Promise<void> {
  await demoIframeRepository.revokeNormalRefreshTokens(userId);
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

  await demoIframeRepository.updateSettings({
    tenantId,
    isEnabled: nextEnabled,
    allowedOrigin: nextAllowedOrigin,
    demoUserId: nextDemoUserId,
    actorId,
  });

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
  await demoIframeRepository.regenerateEmbedId(tenantId, actorId);
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
  const [countResult, dataResult] = await demoIframeRepository.searchEligibleLearners({
    tenantId,
    search,
    pageSize,
    offset,
  });

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

  const row = await demoIframeRepository.selectBootstrap(embedId);
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
    return await demoIframeRepository.isEnabledDemoLearner(userId);
  } catch (err) {
    if ((err as { code?: string }).code === '42P01' || (err as { code?: string }).code === '42703') return false;
    throw err;
  }
}

export async function getActiveDemoIframeUserIds(userIds: string[]): Promise<Set<string>> {
  const unique = [...new Set(userIds)].filter(Boolean);
  if (unique.length === 0) return new Set();
  try {
    return new Set(await demoIframeRepository.selectEnabledDemoLearnerIds(unique));
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
