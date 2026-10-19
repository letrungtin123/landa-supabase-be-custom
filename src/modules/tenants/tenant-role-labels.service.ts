import { getClient, query } from '../../config/database.js';
import { appendAuditLog, type TransactionalAuditEntry } from '../../middleware/audit-log.js';
import { cacheJson, bumpCacheVersion, getCacheVersion } from '../../config/cache.js';
import { CACHE_TTL, cacheKeys, cacheVersions } from '../../config/cache-keys.js';
import { AppError } from '../../utils/errors.js';
import { createTenantSettingsRepository, type TenantSettingsDb } from './tenant-settings.repository.js';
import type { UserRole } from '../../types/index.js';

export type RoleLabelMap = Partial<Record<UserRole, string>>;

export const SYSTEM_ROLES = [
  'superadmin',
  'superuser',
  'staff',
  'learner',
  'learner_plus',
] as const satisfies readonly UserRole[];

const ROLE_SET = new Set<string>(SYSTEM_ROLES);
const MAX_LABEL_LENGTH = 64;

const settingsRepository = createTenantSettingsRepository({ query } satisfies TenantSettingsDb);

function isUndefinedTableError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '42P01';
}

export function sanitizeRoleLabels(input: unknown): RoleLabelMap {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError('role_labels phai la object', 400);
  }

  const source = input as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    if (!ROLE_SET.has(key)) {
      throw new AppError(`Role khong hop le: ${key}`, 400);
    }
  }

  const labels: RoleLabelMap = {};
  for (const role of SYSTEM_ROLES) {
    const raw = source[role];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== 'string') {
      throw new AppError(`Label cua role ${role} phai la chuoi`, 400);
    }

    const label = raw.trim();
    if (!label) continue;
    if (label.length > MAX_LABEL_LENGTH) {
      throw new AppError(`Label cua role ${role} toi da ${MAX_LABEL_LENGTH} ky tu`, 400);
    }
    labels[role] = label;
  }
  return labels;
}

export async function invalidateTenantRoleLabelsCache(tenantId?: string | null): Promise<void> {
  if (!tenantId) return;
  await bumpCacheVersion(...cacheVersions.tenantLabels(tenantId, 'role'));
}

export async function getTenantRoleLabels(tenantId: string | null | undefined): Promise<RoleLabelMap> {
  if (!tenantId) return {};

  const version = await getCacheVersion(...cacheVersions.tenantLabels(tenantId, 'role'));
  return cacheJson(
    cacheKeys.tenantResource(tenantId, 'role-labels', version),
    CACHE_TTL.tenantLabels,
    () => getTenantRoleLabelsFromDb(tenantId),
  );
}

async function getTenantRoleLabelsFromDb(tenantId: string): Promise<RoleLabelMap> {
  try {
    const rows = await settingsRepository.selectRoleLabels(tenantId);

    const labels: RoleLabelMap = {};
    for (const row of rows) {
      if (ROLE_SET.has(row.role)) labels[row.role] = row.label;
    }

    return labels;
  } catch (err) {
    if (isUndefinedTableError(err)) return {};
    throw err;
  }
}

export async function replaceTenantRoleLabels(
  tenantId: string,
  input: unknown,
  actorId: string | null,
  auditEntry?: TransactionalAuditEntry,
): Promise<RoleLabelMap> {
  const labels = sanitizeRoleLabels(input);
  const entries = Object.entries(labels) as [UserRole, string][];

  const client = await getClient();
  try {
    await client.query('BEGIN');
    const repository = createTenantSettingsRepository(client);

    if (!await repository.tenantExists(tenantId)) throw new AppError('Tenant khong ton tai', 404);

    await repository.deleteRoleLabels(tenantId);

    for (const [role, label] of entries) {
      await repository.insertRoleLabel(tenantId, role, label, actorId);
    }

    if (auditEntry) await appendAuditLog(client, auditEntry);
    await client.query('COMMIT');
    await invalidateTenantRoleLabelsCache(tenantId);
    return labels;
  } catch (err) {
    await client.query('ROLLBACK');
    if (isUndefinedTableError(err)) {
      throw new AppError('Bang tenant_role_labels chua duoc tao. Hay chay manual SQL truoc.', 500);
    }
    throw err;
  } finally {
    client.release();
  }
}
