import { getClient, query } from '../../config/database.js';
import { appendAuditLog, type TransactionalAuditEntry } from '../../middleware/audit-log.js';
import { cacheJson, bumpCacheVersion, getCacheVersion } from '../../config/cache.js';
import { CACHE_TTL, cacheKeys, cacheVersions } from '../../config/cache-keys.js';
import { invalidateTenantPublicDomainCaches } from '../../config/cache-invalidation.js';
import { AppError } from '../../utils/errors.js';
import { calcOffset, calcTotalPages, parsePagination } from '../../utils/query-helpers.js';
import { generateOTT } from '../auth/auth.service.js';
import type { ReplaceDemoLoginAccountsInput, UpdateDemoLoginConfigInput } from './demo-login.validator.js';
import {
  createDemoLoginRepository,
  type DemoAdminAccountRow as AdminAccountRow,
  type DemoLoginDb,
  type DemoLoginSettingsRow as SettingsRow,
  type DemoTenantRow as TenantRow,
  type TimestampLike,
} from './demo-login.repository.js';

// query() joins the caller's current transaction (withDatabaseTransaction) when there is one.
const poolDb: DemoLoginDb = { query };
const demoLoginRepository = createDemoLoginRepository(poolDb);

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
  const tenant = await demoLoginRepository.selectTenantById(tenantId);
  if (!tenant) throw new AppError('Tenant không tồn tại', 404);
  return tenant;
}

async function getTenantByLearnerDomain(domain: string): Promise<TenantRow> {
  const normalized = normalizeDomain(domain);
  if (!normalized) throw new AppError('Domain không hợp lệ', 400);

  const tenant = await demoLoginRepository.selectActiveTenantByLearnerDomain(normalized);
  if (!tenant) throw new AppError('Không tìm thấy tenant cho domain này', 404);
  return tenant;
}

async function ensureSettings(tenantId: string): Promise<SettingsRow> {
  await getTenantById(tenantId);
  await demoLoginRepository.insertSettingsIfMissing(tenantId);
  return (await demoLoginRepository.selectSettings(tenantId))!;
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

  const accounts = await demoLoginRepository.selectAdminAccounts(tenantId);

  return {
    tenant: {
      id: tenant.id,
      name: tenant.name,
      domain_learner: tenant.domain_learner,
      is_active: tenant.is_active,
    },
    settings: formatSettings(settings),
    accounts: accounts.map(formatAdminAccount),
  };
}

export async function updateDemoLoginConfig(
  tenantId: string,
  input: UpdateDemoLoginConfigInput,
  actorId: string | null,
) {
  await ensureSettings(tenantId);

  if (input.max_demo_accounts !== undefined) {
    const countRow = await demoLoginRepository.countAccounts(tenantId);
    const currentCount = Number.parseInt(countRow.count, 10);
    if (currentCount > input.max_demo_accounts) {
      throw new AppError(`Tenant đang có ${currentCount} tài khoản demo, không thể giảm giới hạn xuống ${input.max_demo_accounts}`, 400);
    }
  }

  const columns: Array<readonly [string, unknown]> = [];

  if (input.is_enabled !== undefined) {
    columns.push(['is_enabled', input.is_enabled]);
  }
  if (input.max_demo_accounts !== undefined) {
    columns.push(['max_demo_accounts', input.max_demo_accounts]);
  }
  if (input.reservation_ttl_seconds !== undefined) {
    columns.push(['reservation_ttl_seconds', input.reservation_ttl_seconds]);
  }

  await demoLoginRepository.updateSettings(tenantId, columns, actorId);
  await invalidateTenantPublicDomainCaches(tenantId, ['demo-login']);

  return getDemoLoginConfig(tenantId);
}

export async function searchEligibleLearners(tenantId: string, queryParams: Record<string, unknown>) {
  await getTenantById(tenantId);
  const { page, pageSize, search } = parsePagination(queryParams);
  const offset = calcOffset(page, pageSize);
  const [countResult, dataResult] = await demoLoginRepository.searchEligibleLearners({
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
    const validUserCount = await demoLoginRepository.countEligibleUsers(tenantId, uniqueUserIds);
    if (validUserCount !== uniqueUserIds.length) {
      throw new AppError('Chỉ được chọn tài khoản learner đang hoạt động của tenant này', 400);
    }
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');
    const transactionRepository = createDemoLoginRepository(client);

    if (uniqueUserIds.length === 0) {
      await transactionRepository.deleteAllAccounts(tenantId);
    } else {
      await transactionRepository.deleteAccountsNotIn(tenantId, uniqueUserIds);
    }

    for (let index = 0; index < input.accounts.length; index += 1) {
      const account = input.accounts[index];
      const label = account.label?.trim() || null;
      await transactionRepository.upsertAccount(tenantId, account.user_id, label, index, actorId);
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
  const deleted = await demoLoginRepository.deleteAccount(tenantId, publicId);
  if (!deleted) throw new AppError('Tài khoản demo không tồn tại', 404);
  await invalidateTenantPublicDomainCaches(tenantId, ['demo-login']);
  return deleted;
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
  const setting = await demoLoginRepository.selectSettings(tenant.id);
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

  const [accounts, lock] = await Promise.all([
    demoLoginRepository.selectPublicAccounts(tenant.id, setting.max_demo_accounts),
    demoLoginRepository.selectLockSummary(tenant.id),
  ]);

  return {
    tenant: { id: tenant.id, name: tenant.name },
    is_enabled: true,
    ttl_seconds: setting.reservation_ttl_seconds,
    accounts: accounts.map((row) => ({
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
  const claimed = await demoLoginRepository.claimAccount(tenant.id, accountId);
  if (!claimed) throw new AppError('Tài khoản demo không còn khả dụng', 409);

  const ott = await generateOTT(claimed.user_id);
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
    const tenantId = await demoLoginRepository.selectAccountTenantId(userId);
    await demoLoginRepository.deleteAccountsOfUser(userId);
    if (tenantId) await invalidateTenantPublicDomainCaches(tenantId, ['demo-login']);
  } catch (err) {
    if ((err as { code?: string }).code === '42P01') return;
    throw err;
  }
}
