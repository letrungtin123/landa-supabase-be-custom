import { getClient, query } from '../../config/database.js';
import { appendAuditLog, type TransactionalAuditEntry } from '../../middleware/audit-log.js';
import { cacheJson, bumpCacheVersion, getCacheVersion } from '../../config/cache.js';
import { CACHE_TTL, cacheKeys, cacheVersions } from '../../config/cache-keys.js';
import { invalidateTenantPublicDomainCaches } from '../../config/cache-invalidation.js';
import { AppError } from '../../middleware/error-handler.js';
import { calcOffset, calcTotalPages, parsePagination } from '../../utils/query-helpers.js';
import { generateOTT } from '../auth/auth.service.js';
import type { ReplaceDemoLoginAccountsInput, UpdateDemoLoginConfigInput } from './demo-login.validator.js';

type TimestampLike = Date | string | null;

interface TenantRow {
  id: string;
  name: string;
  domain_learner: string | null;
  is_active: boolean;
}

interface SettingsRow {
  tenant_id: string;
  is_enabled: boolean;
  max_demo_accounts: number;
  reservation_ttl_seconds: number;
  updated_by: string | null;
  created_at: TimestampLike;
  updated_at: TimestampLike;
}

interface AdminAccountRow {
  public_id: string;
  user_id: string;
  label: string | null;
  sort_order: number;
  reserved_until: TimestampLike;
  username: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  is_active: boolean;
  role: string;
  created_at: TimestampLike;
  updated_at: TimestampLike;
}

interface PublicAccountRow {
  public_id: string;
  label: string | null;
  username: string;
  full_name: string | null;
  avatar_url: string | null;
}

function normalizeDomain(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '');
}

function iso(value: TimestampLike): string | null {
  return value ? new Date(value).toISOString() : null;
}

function displayLabel(row: { label?: string | null; full_name?: string | null; username: string }): string {
  return row.label?.trim() || row.full_name?.trim() || row.username;
}

function buildLearnerTargetUrl(tenant: Pick<TenantRow, 'domain_learner'>, domain: string, ott: string): string {
  const normalizedDomain = normalizeDomain(domain);
  const raw = tenant.domain_learner?.trim() || normalizedDomain;
  const hasProtocol = /^https?:\/\//i.test(raw);
  const protocol = normalizedDomain === 'localhost' || normalizedDomain.startsWith('127.') ? 'http://' : 'https://';
  const target = new URL(hasProtocol ? raw : `${protocol}${raw}`);
  target.pathname = '/';
  target.search = '';
  target.hash = '';
  target.searchParams.set('ott', ott);
  return target.toString();
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

async function getTenantByLearnerDomain(domain: string): Promise<TenantRow> {
  const normalized = normalizeDomain(domain);
  if (!normalized) throw new AppError('Domain không hợp lệ', 400);

  const result = await query<TenantRow>(
    `SELECT id, name, domain_learner, is_active
     FROM tenants
     WHERE lower(regexp_replace(regexp_replace(regexp_replace(domain_learner, '^https?://', ''), '/.*$', ''), ':[0-9]+$', '')) = $1
       AND is_active = true
     LIMIT 1`,
    [normalized],
  );

  const tenant = result.rows[0];
  if (!tenant) throw new AppError('Không tìm thấy tenant cho domain này', 404);
  return tenant;
}

async function ensureSettings(tenantId: string): Promise<SettingsRow> {
  await getTenantById(tenantId);
  await query(
    `INSERT INTO tenant_demo_login_settings (tenant_id)
     VALUES ($1)
     ON CONFLICT (tenant_id) DO NOTHING`,
    [tenantId],
  );
  const result = await query<SettingsRow>(
    `SELECT tenant_id, is_enabled, max_demo_accounts, reservation_ttl_seconds,
            updated_by, created_at, updated_at
     FROM tenant_demo_login_settings
     WHERE tenant_id = $1`,
    [tenantId],
  );
  return result.rows[0];
}

function formatSettings(row: SettingsRow) {
  return {
    tenant_id: row.tenant_id,
    is_enabled: row.is_enabled,
    max_demo_accounts: row.max_demo_accounts,
    reservation_ttl_seconds: row.reservation_ttl_seconds,
    updated_by: row.updated_by,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

function formatAdminAccount(row: AdminAccountRow) {
  return {
    id: row.public_id,
    user_id: row.user_id,
    label: displayLabel(row),
    custom_label: row.label,
    sort_order: row.sort_order,
    reserved_until: iso(row.reserved_until),
    username: row.username,
    email: row.email,
    full_name: row.full_name,
    avatar_url: row.avatar_url,
    is_active: row.is_active,
    role: row.role,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

export async function getDemoLoginConfig(tenantId: string) {
  const [tenant, settings] = await Promise.all([
    getTenantById(tenantId),
    ensureSettings(tenantId),
  ]);

  const accounts = await query<AdminAccountRow>(
    `SELECT a.public_id, a.user_id, a.label, a.sort_order, a.reserved_until,
            a.created_at, a.updated_at,
            u.username, u.email, u.full_name, u.avatar_url, u.is_active, u.role
     FROM tenant_demo_login_accounts a
     JOIN users u ON u.id = a.user_id
     WHERE a.tenant_id = $1
     ORDER BY a.sort_order ASC, a.created_at ASC`,
    [tenantId],
  );

  return {
    tenant: {
      id: tenant.id,
      name: tenant.name,
      domain_learner: tenant.domain_learner,
      is_active: tenant.is_active,
    },
    settings: formatSettings(settings),
    accounts: accounts.rows.map(formatAdminAccount),
  };
}

export async function updateDemoLoginConfig(
  tenantId: string,
  input: UpdateDemoLoginConfigInput,
  actorId: string | null,
) {
  await ensureSettings(tenantId);

  if (input.max_demo_accounts !== undefined) {
    const countResult = await query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM tenant_demo_login_accounts WHERE tenant_id = $1',
      [tenantId],
    );
    const currentCount = Number.parseInt(countResult.rows[0].count, 10);
    if (currentCount > input.max_demo_accounts) {
      throw new AppError(`Tenant đang có ${currentCount} tài khoản demo, không thể giảm giới hạn xuống ${input.max_demo_accounts}`, 400);
    }
  }

  const sets: string[] = [];
  const params: unknown[] = [tenantId];
  let idx = 2;

  if (input.is_enabled !== undefined) {
    sets.push(`is_enabled = $${idx++}`);
    params.push(input.is_enabled);
  }
  if (input.max_demo_accounts !== undefined) {
    sets.push(`max_demo_accounts = $${idx++}`);
    params.push(input.max_demo_accounts);
  }
  if (input.reservation_ttl_seconds !== undefined) {
    sets.push(`reservation_ttl_seconds = $${idx++}`);
    params.push(input.reservation_ttl_seconds);
  }

  sets.push(`updated_by = $${idx++}`);
  params.push(actorId);

  await query(
    `UPDATE tenant_demo_login_settings
     SET ${sets.join(', ')}
     WHERE tenant_id = $1`,
    params,
  );
  await invalidateTenantPublicDomainCaches(tenantId, ['demo-login']);

  return getDemoLoginConfig(tenantId);
}

export async function searchEligibleLearners(tenantId: string, queryParams: Record<string, unknown>) {
  await getTenantById(tenantId);
  const { page, pageSize, search } = parsePagination(queryParams);
  const offset = calcOffset(page, pageSize);
  const params: unknown[] = [tenantId];
  const conditions = [
    'u.tenant_id = $1',
    "u.role = 'learner'",
    'u.is_active = true',
    'NOT EXISTS (SELECT 1 FROM tenant_demo_login_accounts a WHERE a.user_id = u.id)',
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
    }>(
      `SELECT u.id, u.username, u.email, u.full_name, u.avatar_url, u.created_at
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
    })),
    total,
    page,
    pageSize,
    totalPages: calcTotalPages(total, pageSize),
  };
}

export async function replaceDemoLoginAccounts(
  tenantId: string,
  input: ReplaceDemoLoginAccountsInput,
  actorId: string | null,
  auditEntry?: TransactionalAuditEntry,
) {
  const settings = await ensureSettings(tenantId);
  const uniqueUserIds = [...new Set(input.accounts.map((account) => account.user_id))];
  if (uniqueUserIds.length !== input.accounts.length) {
    throw new AppError('Danh sách tài khoản demo bị trùng', 400);
  }
  if (uniqueUserIds.length > settings.max_demo_accounts) {
    throw new AppError(`Chỉ được chọn tối đa ${settings.max_demo_accounts} tài khoản demo`, 400);
  }

  if (uniqueUserIds.length > 0) {
    const validUsers = await query<{ id: string }>(
      `SELECT id
       FROM users
       WHERE tenant_id = $1
         AND role = 'learner'
         AND is_active = true
         AND id = ANY($2::uuid[])`,
      [tenantId, uniqueUserIds],
    );
    if (validUsers.rowCount !== uniqueUserIds.length) {
      throw new AppError('Chỉ được chọn tài khoản learner đang hoạt động của tenant này', 400);
    }
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');

    if (uniqueUserIds.length === 0) {
      await client.query('DELETE FROM tenant_demo_login_accounts WHERE tenant_id = $1', [tenantId]);
    } else {
      await client.query(
        'DELETE FROM tenant_demo_login_accounts WHERE tenant_id = $1 AND NOT (user_id = ANY($2::uuid[]))',
        [tenantId, uniqueUserIds],
      );
    }

    for (let index = 0; index < input.accounts.length; index += 1) {
      const account = input.accounts[index];
      const label = account.label?.trim() || null;
      await client.query(
        `INSERT INTO tenant_demo_login_accounts (tenant_id, user_id, label, sort_order, created_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, user_id)
         DO UPDATE SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order, updated_at = now()`,
        [tenantId, account.user_id, label, index, actorId],
      );
    }

    if (auditEntry) await appendAuditLog(client, auditEntry);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  await invalidateTenantPublicDomainCaches(tenantId, ['demo-login']);

  return getDemoLoginConfig(tenantId);
}

export async function deleteDemoLoginAccount(tenantId: string, publicId: string): Promise<{ username: string }> {
  const result = await query<{ username: string }>(
    `DELETE FROM tenant_demo_login_accounts a
     USING users u
     WHERE a.user_id = u.id AND a.tenant_id = $1 AND a.public_id = $2
     RETURNING u.username`,
    [tenantId, publicId],
  );
  if (result.rowCount === 0) throw new AppError('Tài khoản demo không tồn tại', 404);
  await invalidateTenantPublicDomainCaches(tenantId, ['demo-login']);
  return result.rows[0];
}

export async function listPublicDemoLoginAccounts(domain: string) {
  const normalizedDomain = normalizeDomain(domain);
  const version = await getCacheVersion(...cacheVersions.publicDomain(normalizedDomain, 'demo-login'));
  return cacheJson(
    cacheKeys.publicDomain(normalizedDomain, 'demo-login', version),
    CACHE_TTL.demoPublic,
    () => listPublicDemoLoginAccountsFromDb(normalizedDomain),
  );
}

async function listPublicDemoLoginAccountsFromDb(domain: string) {
  const tenant = await getTenantByLearnerDomain(domain);
  const settings = await query<SettingsRow>(
    `SELECT tenant_id, is_enabled, max_demo_accounts, reservation_ttl_seconds,
            updated_by, created_at, updated_at
     FROM tenant_demo_login_settings
     WHERE tenant_id = $1`,
    [tenant.id],
  );

  const setting = settings.rows[0];
  if (!setting || !setting.is_enabled) {
    return {
      tenant: { id: tenant.id, name: tenant.name },
      is_enabled: false,
      ttl_seconds: setting?.reservation_ttl_seconds ?? 300,
      accounts: [],
      locked_count: 0,
      next_reset_at: null,
      next_reset_in_seconds: 0,
    };
  }

  const [accounts, locks] = await Promise.all([
    query<PublicAccountRow>(
      `SELECT a.public_id, a.label, u.username, u.full_name, u.avatar_url
       FROM tenant_demo_login_accounts a
       JOIN users u ON u.id = a.user_id
       WHERE a.tenant_id = $1
         AND u.role = 'learner'
         AND u.is_active = true
         AND (a.reserved_until IS NULL OR a.reserved_until <= now())
       ORDER BY a.sort_order ASC, a.created_at ASC
       LIMIT $2`,
      [tenant.id, setting.max_demo_accounts],
    ),
    query<{ locked_count: string; next_reset_at: TimestampLike; next_reset_in_seconds: number | null }>(
      `SELECT COUNT(*)::text AS locked_count,
              MIN(a.reserved_until) AS next_reset_at,
              GREATEST(0, CEIL(EXTRACT(EPOCH FROM (MIN(a.reserved_until) - now()))))::int AS next_reset_in_seconds
       FROM tenant_demo_login_accounts a
       JOIN users u ON u.id = a.user_id
       WHERE a.tenant_id = $1
         AND u.role = 'learner'
         AND u.is_active = true
         AND a.reserved_until > now()`,
      [tenant.id],
    ),
  ]);

  const lock = locks.rows[0];
  return {
    tenant: { id: tenant.id, name: tenant.name },
    is_enabled: true,
    ttl_seconds: setting.reservation_ttl_seconds,
    accounts: accounts.rows.map((row) => ({
      id: row.public_id,
      label: displayLabel(row),
      avatar_url: row.avatar_url,
    })),
    locked_count: Number.parseInt(lock?.locked_count || '0', 10),
    next_reset_at: iso(lock?.next_reset_at || null),
    next_reset_in_seconds: lock?.next_reset_in_seconds ?? 0,
  };
}

export async function claimPublicDemoLoginAccount(domain: string, accountId: string) {
  const tenant = await getTenantByLearnerDomain(domain);
  const result = await query<{ user_id: string; reserved_until: TimestampLike; reservation_ttl_seconds: number }>(
    `WITH target AS (
       SELECT a.public_id, a.user_id, s.reservation_ttl_seconds
       FROM tenant_demo_login_accounts a
       JOIN tenant_demo_login_settings s ON s.tenant_id = a.tenant_id
       JOIN users u ON u.id = a.user_id
       WHERE a.tenant_id = $1
         AND a.public_id = $2
         AND s.is_enabled = true
         AND u.role = 'learner'
         AND u.is_active = true
         AND (a.reserved_until IS NULL OR a.reserved_until <= now())
       LIMIT 1
     )
     UPDATE tenant_demo_login_accounts a
     SET reserved_until = now() + (target.reservation_ttl_seconds * interval '1 second'),
         updated_at = now()
     FROM target
     WHERE a.public_id = target.public_id
     RETURNING a.user_id, a.reserved_until, target.reservation_ttl_seconds`,
    [tenant.id, accountId],
  );

  const claimed = result.rows[0];
  if (!claimed) throw new AppError('Tài khoản demo không còn khả dụng', 409);

  const ott = generateOTT(claimed.user_id);
  await bumpCacheVersion(...cacheVersions.publicDomain(domain, 'demo-login'));
  return {
    redirect_url: buildLearnerTargetUrl(tenant, domain, ott),
    expires_in: 30,
    reserved_until: iso(claimed.reserved_until),
    ttl_seconds: claimed.reservation_ttl_seconds,
  };
}

export async function removeUserFromDemoLogin(userId: string): Promise<void> {
  try {
    const tenantResult = await query<{ tenant_id: string }>(
      'SELECT tenant_id FROM tenant_demo_login_accounts WHERE user_id = $1 LIMIT 1',
      [userId],
    );
    await query('DELETE FROM tenant_demo_login_accounts WHERE user_id = $1', [userId]);
    const tenantId = tenantResult.rows[0]?.tenant_id;
    if (tenantId) await invalidateTenantPublicDomainCaches(tenantId, ['demo-login']);
  } catch (err) {
    if ((err as { code?: string }).code === '42P01') return;
    throw err;
  }
}
