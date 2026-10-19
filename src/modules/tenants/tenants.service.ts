// ═══════════════════════════════════════════════════════════════
// Tenants Service — CRUD tenants + toggle modules
// Chỉ superadmin mới gọi được
// ═══════════════════════════════════════════════════════════════

import { query, getClient, withDatabaseTransaction } from '../../config/database.js';
import { appendAuditLog, type TransactionalAuditEntry } from '../../middleware/audit-log.js';
import { cacheJson, bumpCacheVersion, getCacheVersion } from '../../config/cache.js';
import { CACHE_TTL, cacheKeys, cacheVersions } from '../../config/cache-keys.js';
import {
  invalidatePublicDomainCachesForDomains,
  invalidateTenantAiCaches,
  invalidateTenantBadgeCaches,
  invalidateTenantModuleCaches,
  invalidateUserMembershipCaches,
} from '../../config/cache-invalidation.js';
import { AppError } from '../../utils/errors.js';
import { parsePagination, calcOffset, calcTotalPages } from '../../utils/query-helpers.js';
import type { CreateTenantInput, UpdateTenantInput } from './tenants.validator.js';
import { fingerprintGeminiApiKey, markTenantGeminiStoresKeyChanged } from '../ai-chatbot/ai-platform/gemini.service.js';
import { getTenantDataQuota } from './tenant-data-quota.service.js';
import { readWithPendingDatabaseBytes } from './tenant-data-quota-ledger.service.js';
import { removeAiSecretsFromTenantSettings } from '../ai-chatbot/ai-platform/ai-settings.service.js';
import {
  createTenantsRepository,
  tenantDetailSql,
  tenantPageStatement,
  tenantUpdateAssignments,
  type TenantDetailRow,
  type TenantPageRow,
  type TenantSnapshotRow,
  type TenantsDb,
} from './tenants.repository.js';

const TENANT_PUBLIC_CACHE_RESOURCES = ['branding', 'dashboard-content', 'sso-public', 'demo-login'] as const;

const tenantsRepository = createTenantsRepository({ query } satisfies TenantsDb);

export type TenantAuditSnapshot = TenantSnapshotRow;

function getGeminiKeyFromSettings(settings: unknown): string | null {
  if (!settings || typeof settings !== 'object') return null;
  const value = (settings as Record<string, unknown>).gemini_api_key;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

async function getTenantPublicDomains(tenantId: string): Promise<string[]> {
  const row = await tenantsRepository.selectPublicDomains(tenantId);
  return [row?.domain_admin ?? null, row?.domain_learner ?? null].filter((domain): domain is string => !!domain);
}

/**
 * Danh sách tenants — phân trang + search.
 */
export async function listTenants(queryParams: Record<string, unknown>) {
  const { page, pageSize, search } = parsePagination(queryParams);
  const offset = calcOffset(page, pageSize);
  const statement = tenantPageStatement(search, pageSize, offset);
  const result = await readWithPendingDatabaseBytes<TenantPageRow>(statement.sql, statement.params);

  const total = parseInt(result.rows[0]?.full_count ?? '0');

  return {
    data: result.rows.map((r) => {
      const { full_count, ...rest } = r;
      rest.settings = removeAiSecretsFromTenantSettings(rest.settings);
      return rest;
    }),
    total,
    page,
    pageSize,
    totalPages: calcTotalPages(total, pageSize),
  };
}

/**
 * Chi tiết tenant theo ID.
 */
export async function getTenantById(id: string) {
  const result = await readWithPendingDatabaseBytes<TenantDetailRow>(tenantDetailSql, [id]);
  if (result.rowCount === 0) throw new AppError('Tenant không tồn tại', 404);
  const tenant = result.rows[0] as Record<string, unknown>;
  tenant.settings = removeAiSecretsFromTenantSettings(tenant.settings);
  return tenant;
}

/**
 * Tạo tenant mới + tự động bật tất cả modules (trừ tenant_management).
 */
export async function createTenant(
  input: CreateTenantInput,
  auditEntry?: (tenant: TenantAuditSnapshot) => TransactionalAuditEntry,
) {
  // Kiểm tra slug trùng
  if (await tenantsRepository.slugExists(input.slug)) throw new AppError('Slug đã tồn tại', 409);

  const client = await getClient();
  try {
    await client.query('BEGIN');
    const repository = createTenantsRepository(client);

    const tenant = await repository.insertTenant({
      name: input.name,
      slug: input.slug,
      domainLearner: input.domain_learner ?? null,
      domainAdmin: input.domain_admin ?? null,
      maxUsers: input.max_users ?? null,
      maxCourses: input.max_courses ?? null,
      dataLimitBytes: input.data_limit_bytes ?? null,
      settings: JSON.stringify(input.settings || {}),
    });

    await repository.insertAiSettings(
      tenant.id,
      process.env.GEMINI_CHAT_MODEL?.trim() || 'gemini-3.8-flash',
      process.env.GEMINI_LESSON_AUTHOR_MODEL?.trim() || 'gemini-3.8-flash',
    );

    // Tenant management, badge management và news cần được superadmin cấp riêng.
    await repository.enableDefaultModules(tenant.id);

    if (auditEntry) await appendAuditLog(client, auditEntry(tenant));

    await client.query('COMMIT');
    await Promise.all([
      bumpCacheVersion(...cacheVersions.tenantResource('system', 'tenants-simple')),
      invalidatePublicDomainCachesForDomains(
        [tenant.domain_admin, tenant.domain_learner],
        TENANT_PUBLIC_CACHE_RESOURCES,
      ),
    ]);
    return tenant;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Cập nhật tenant.
 */
export async function updateTenant(id: string, input: UpdateTenantInput) {
  const oldDomains = await getTenantPublicDomains(id);
  let geminiKeyChanged = false;
  let nextGeminiFingerprint: string | null = null;

  if (input.settings !== undefined) {
    const currentSettings = await tenantsRepository.selectSettings(id);
    if (currentSettings.rowCount === 0) throw new AppError('Tenant khong ton tai', 404);
    const oldKey = getGeminiKeyFromSettings(currentSettings.rows[0]?.settings);
    const nextKey = getGeminiKeyFromSettings(input.settings);
    geminiKeyChanged = oldKey !== nextKey;
    nextGeminiFingerprint = nextKey ? fingerprintGeminiApiKey(nextKey) : null;
  }

  const update = await updateTenantFromDb(id, input);
  const tenant = update.tenant;
  await Promise.all([
    bumpCacheVersion(...cacheVersions.tenantResource('system', 'tenants-simple')),
    bumpCacheVersion(...cacheVersions.tenantResource(id, 'branding')),
    bumpCacheVersion(...cacheVersions.tenantResource(id, 'dashboard-content')),
    ...(input.settings !== undefined ? [invalidateTenantAiCaches(id)] : []),
    ...(geminiKeyChanged ? [markTenantGeminiStoresKeyChanged(id, nextGeminiFingerprint)] : []),
    invalidatePublicDomainCachesForDomains(
      [...oldDomains, tenant.domain_admin, tenant.domain_learner],
      TENANT_PUBLIC_CACHE_RESOURCES,
    ),
  ]);
  return update;
}

async function updateTenantFromDb(id: string, input: UpdateTenantInput) {
  // SET clause động
  const assignments = tenantUpdateAssignments(input);
  if (assignments.sets.length === 0) throw new AppError('Không có dữ liệu cần cập nhật', 400);

  return withDatabaseTransaction(async () => {
    const current = await tenantsRepository.lockSnapshot(id);
    if (current.rowCount === 0) throw new AppError('Tenant không tồn tại', 404);

    const result = await tenantsRepository.updateTenant(id, assignments);
    if (result.rowCount === 0) throw new AppError('Tenant không tồn tại', 404);

    const tenant = result.rows[0];
    return {
      tenant,
      previousTenant: current.rows[0],
      previousDataLimitBytes: current.rows[0].data_limit_bytes === null
        ? null
        : String(current.rows[0].data_limit_bytes),
    };
  });
}

/**
 * Xóa tenant.
 */
export async function deleteTenant(id: string) {
  const oldDomains = await getTenantPublicDomains(id);
  const deletedTenant = await deleteTenantFromDb(id);
  await Promise.all([
    bumpCacheVersion(...cacheVersions.tenantResource('system', 'tenants-simple')),
    invalidatePublicDomainCachesForDomains(oldDomains, TENANT_PUBLIC_CACHE_RESOURCES),
  ]);
  return deletedTenant;
}

async function deleteTenantFromDb(id: string) {
  const deleted = await tenantsRepository.deleteTenant(id);
  if (!deleted) throw new AppError('Tenant không tồn tại', 404);
  return deleted;
}

/**
 * Lấy cấu hình modules của tenant (ma trận bật/tắt).
 */
export async function getTenantModules(tenantId: string) {
  return tenantsRepository.selectModules(tenantId);
}

/**
 * Cập nhật ma trận modules cho tenant (bulk upsert).
 */
export async function updateTenantModules(
  tenantId: string,
  modules: { module_id: string; is_enabled: boolean }[],
  auditEntry?: TransactionalAuditEntry,
) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const repository = createTenantsRepository(client);

    for (const mod of modules) {
      await repository.upsertModule(tenantId, mod.module_id, mod.is_enabled);
    }

    if (auditEntry) await appendAuditLog(client, auditEntry);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await Promise.all([
    invalidateTenantBadgeCaches(tenantId),
    invalidateTenantAiCaches(tenantId),
    invalidateTenantModuleCaches(tenantId),
  ]);
}

/**
 * Danh sách tenant nhẹ (chỉ id + name) — dùng cho dropdown filter.
 * Trả ALL tenants cho superadmin, chỉ assigned tenants cho superuser.
 */
export async function listSimpleTenants(userId: string, role: string) {
  const [systemVersion, userVersion] = await Promise.all([
    getCacheVersion(...cacheVersions.tenantResource('system', 'tenants-simple')),
    getCacheVersion(...cacheVersions.userMembership(userId)),
  ]);
  return cacheJson(
    cacheKeys.tenantResource('system', 'tenants-simple', `${systemVersion}:${userVersion}`, { userId, role }),
    CACHE_TTL.tenantList,
    () => listSimpleTenantsFromDb(userId, role),
  );
}

async function listSimpleTenantsFromDb(userId: string, role: string) {
  if (role === 'superadmin') {
    return tenantsRepository.selectActiveTenants();
  }

  // superuser: chỉ lấy tenants được phân quyền qua user_tenants
  return tenantsRepository.selectActiveTenantsOfUser(userId);
}

/**
 * Lấy danh sách tenant IDs mà user được quản lý.
 */
export async function getUserTenants(userId: string) {
  return tenantsRepository.selectUserTenants(userId);
}

/**
 * Gán user quản lý nhiều tenants (superadmin gọi).
 * Thay thế toàn bộ — xóa cũ + insert mới.
 */
export async function setUserTenants(
  userId: string,
  tenantIds: string[],
  createAuditEntry?: (user: { username: string }) => TransactionalAuditEntry,
) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const repository = createTenantsRepository(client);

    const user = await repository.lockUsername(userId);
    if (!user) throw new AppError('Người dùng không tồn tại', 404);

    // Xóa tất cả assign cũ
    await repository.deleteUserTenants(userId);

    // Insert mới
    for (const tid of tenantIds) {
      await repository.insertUserTenant(userId, tid);
    }

    const auditEntry = createAuditEntry?.(user);
    if (auditEntry) await appendAuditLog(client, auditEntry);
    await client.query('COMMIT');
    await invalidateUserMembershipCaches([userId]);
    return { updated: tenantIds.length };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Lấy quota usage hiện tại của tenant — dùng cho UI hiển thị.
 */
export async function getTenantQuotaUsage(tenantId: string) {
  const result = await tenantsRepository.selectCounts(tenantId);
  if (result.rowCount === 0) throw new AppError('Tenant không tồn tại', 404);
  const row = result.rows[0];
  const dataQuota = await getTenantDataQuota(tenantId);
  return {
    max_users: row.max_users,
    max_courses: row.max_courses,
    current_users: parseInt(row.current_users, 10),
    current_courses: parseInt(row.current_courses, 10),
    data_quota: dataQuota,
  };
}

/** Quota dữ liệu duy nhất cần cho header; tránh COUNT users/courses trên mọi page load. */
export async function getCurrentTenantDataQuota(tenantId: string) {
  const quota = await getTenantDataQuota(tenantId);
  if (!quota) throw new AppError('Tenant không tồn tại', 404);
  return quota;
}

/**
 * Kiểm tra quota trước khi tạo user/course — race-condition safe.
 * Dùng SELECT FOR UPDATE để lock row tenant trong transaction.
 * @throws AppError nếu vượt quota
 */
export async function checkQuota(
  tenantId: string,
  resource: 'users' | 'courses',
  client?: import('pg').PoolClient,
): Promise<void> {
  // Dùng subquery atomic — không cần lock nếu không truyền client
  const rows = await createTenantsRepository(client || { query }).selectQuotaCount(resource, !!client, tenantId);

  if (rows.length === 0) throw new AppError('Tenant không tồn tại', 404);

  const { quota, current_count } = rows[0];
  if (quota !== null && parseInt(current_count, 10) >= quota) {
    const label = resource === 'users' ? 'user' : 'course';
    throw new AppError(`Đã đạt mức giới hạn của ${label}`, 403);
  }
}
