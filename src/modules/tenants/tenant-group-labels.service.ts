import { getClient, query } from '../../config/database.js';
import { appendAuditLog, type TransactionalAuditEntry } from '../../middleware/audit-log.js';
import { cacheJson, bumpCacheVersion, getCacheVersion } from '../../config/cache.js';
import { CACHE_TTL, cacheKeys, cacheVersions } from '../../config/cache-keys.js';
import { AppError } from '../../utils/errors.js';
import { createTenantSettingsRepository, type TenantSettingsDb } from './tenant-settings.repository.js';

export type GroupLabelKey = 'group' | 'subgroup' | 'team';
export type GroupLabelMap = Partial<Record<GroupLabelKey, string>>;

export const SYSTEM_GROUP_LABEL_KEYS = ['group', 'subgroup', 'team'] as const satisfies readonly GroupLabelKey[];

export const DEFAULT_GROUP_LABELS: Record<GroupLabelKey, string> = {
  group: 'Công ty',
  subgroup: 'Chi nhánh',
  team: 'Phòng ban',
};

const GROUP_LABEL_KEY_SET = new Set<string>(SYSTEM_GROUP_LABEL_KEYS);
const MAX_LABEL_LENGTH = 64;

const settingsRepository = createTenantSettingsRepository({ query } satisfies TenantSettingsDb);

function isUndefinedTableError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '42P01';
}

export function sanitizeGroupLabels(input: unknown): GroupLabelMap {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError('group_labels phai la object', 400);
  }

  const source = input as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    if (!GROUP_LABEL_KEY_SET.has(key)) {
      throw new AppError(`Group label key khong hop le: ${key}`, 400);
    }
  }

  const labels: GroupLabelMap = {};
  for (const key of SYSTEM_GROUP_LABEL_KEYS) {
    const raw = source[key];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== 'string') {
      throw new AppError(`Label cua ${key} phai la chuoi`, 400);
    }

    const label = raw.trim();
    if (!label) continue;
    if (label.length > MAX_LABEL_LENGTH) {
      throw new AppError(`Label cua ${key} toi da ${MAX_LABEL_LENGTH} ky tu`, 400);
    }
    labels[key] = label;
  }
  return labels;
}

export function normalizeGroupLabels(input?: GroupLabelMap | null): GroupLabelMap {
  return sanitizeGroupLabels(input);
}

export function getGroupLabel(
  key: GroupLabelKey,
  labels?: GroupLabelMap | null,
  fallback?: string,
): string {
  const custom = labels?.[key]?.trim();
  if (custom) return custom;
  return fallback || DEFAULT_GROUP_LABELS[key];
}

export function getGroupLabelSet(labels?: GroupLabelMap | null): Record<GroupLabelKey, string> {
  return {
    group: getGroupLabel('group', labels),
    subgroup: getGroupLabel('subgroup', labels),
    team: getGroupLabel('team', labels),
  };
}

export function lowerGroupLabel(value: string): string {
  return value.toLocaleLowerCase('vi-VN');
}

export async function invalidateTenantGroupLabelsCache(tenantId?: string | null): Promise<void> {
  if (!tenantId) return;
  await bumpCacheVersion(...cacheVersions.tenantLabels(tenantId, 'group'));
}

export async function getTenantGroupLabels(tenantId: string | null | undefined): Promise<GroupLabelMap> {
  if (!tenantId) return {};

  const version = await getCacheVersion(...cacheVersions.tenantLabels(tenantId, 'group'));
  return cacheJson(
    cacheKeys.tenantResource(tenantId, 'group-labels', version),
    CACHE_TTL.tenantLabels,
    () => getTenantGroupLabelsFromDb(tenantId),
  );
}

async function getTenantGroupLabelsFromDb(tenantId: string): Promise<GroupLabelMap> {
  try {
    const rows = await settingsRepository.selectGroupLabels<GroupLabelKey>(tenantId);

    const labels: GroupLabelMap = {};
    for (const row of rows) {
      if (GROUP_LABEL_KEY_SET.has(row.label_key)) labels[row.label_key] = row.label;
    }

    return labels;
  } catch (err) {
    if (isUndefinedTableError(err)) return {};
    throw err;
  }
}

export async function replaceTenantGroupLabels(
  tenantId: string,
  input: unknown,
  actorId: string | null,
  auditEntry?: TransactionalAuditEntry,
): Promise<GroupLabelMap> {
  const labels = sanitizeGroupLabels(input);
  const entries = Object.entries(labels) as [GroupLabelKey, string][];

  const client = await getClient();
  try {
    await client.query('BEGIN');
    const repository = createTenantSettingsRepository(client);

    if (!await repository.tenantExists(tenantId)) throw new AppError('Tenant khong ton tai', 404);

    await repository.deleteGroupLabels(tenantId);

    for (const [labelKey, label] of entries) {
      await repository.insertGroupLabel(tenantId, labelKey, label, actorId);
    }

    if (auditEntry) await appendAuditLog(client, auditEntry);
    await client.query('COMMIT');
    await invalidateTenantGroupLabelsCache(tenantId);
    return labels;
  } catch (err) {
    await client.query('ROLLBACK');
    if (isUndefinedTableError(err)) {
      throw new AppError('Bang tenant_group_labels chua duoc tao. Hay chay manual SQL truoc.', 500);
    }
    throw err;
  } finally {
    client.release();
  }
}
