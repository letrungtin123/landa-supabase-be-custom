import { getClient, query } from '../../config/database.js';
import { appendAuditLog, type TransactionalAuditEntry } from '../../middleware/audit-log.js';
import { cacheJson, getCacheVersion } from '../../config/cache.js';
import { CACHE_TTL, cacheKeys, cacheVersions } from '../../config/cache-keys.js';
import { invalidateTenantBadgeCaches } from '../../config/cache-invalidation.js';
import { uploadFile, deleteFileByUrl, buildStoragePath } from '../../config/storage.js';
import { AppError } from '../../utils/errors.js';
import { swallowAndLog } from '../../utils/best-effort.js';
import { createBadgesRepository, type BadgeImageColumn, type BadgesDb } from './badges.repository.js';

// query() joins the caller's current transaction when there is one; the
// transaction blocks below use the repository over their own client.
const poolDb: BadgesDb = { query };
const badgesRepository = createBadgesRepository(poolDb);

type TenantBadgeStatusUpdate = {
  badge_id: string;
  is_active: boolean;
  name?: unknown;
  title?: unknown;
  description?: unknown;
  desc?: unknown;
  name_override?: unknown;
  description_override?: unknown;
};

const MAX_BADGE_NAME_LENGTH = 200;
const MAX_BADGE_DESCRIPTION_LENGTH = 2000;

function hasOwn(input: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, key);
}

function normalizeBadgeTextOverride(
  rawValue: unknown,
  defaultValue: string | null | undefined,
  fieldName: string,
  maxLength: number,
): string | null {
  if (rawValue == null) return null;
  if (typeof rawValue !== 'string') {
    throw new AppError(`${fieldName} phai la chuoi`, 400);
  }

  const value = rawValue.trim();
  if (!value) return null;
  if (value.length > maxLength) {
    throw new AppError(`${fieldName} toi da ${maxLength} ky tu`, 400);
  }

  const defaultText = (defaultValue || '').trim();
  return value === defaultText ? null : value;
}

async function assertBadgeAccessibleToTenant(tenantId: string, badgeId: string): Promise<void> {
  if (!(await badgesRepository.badgeAccessibleToTenant(tenantId, badgeId))) {
    throw new AppError('Badge không tồn tại hoặc không thuộc tenant', 404);
  }
}

export async function getTenantBadgeSettings(tenantId: string) {
  const version = await getCacheVersion(...cacheVersions.tenantBadges(tenantId));
  return cacheJson(
    cacheKeys.tenantResource(tenantId, 'badge-settings', version),
    CACHE_TTL.badges,
    () => getTenantBadgeSettingsFromDb(tenantId),
  );
}

async function getTenantBadgeSettingsFromDb(tenantId: string) {
  return badgesRepository.selectTenantBadgeSettings(tenantId);
}

export async function updateTenantBadgeSetting(tenantId: string, badgeId: string, isActive: boolean) {
  await assertBadgeAccessibleToTenant(tenantId, badgeId);
  await badgesRepository.upsertBadgeStatus(tenantId, badgeId, isActive);
  await invalidateTenantBadgeCaches(tenantId);
}

export async function updateAllTenantBadgeSettings(
  tenantId: string,
  badgeStatuses: TenantBadgeStatusUpdate[],
  auditEntry?: TransactionalAuditEntry,
) {
  if (badgeStatuses.length === 0) return;

  const badgeIds = [...new Set(badgeStatuses.map((status) => status.badge_id).filter(Boolean))];
  if (badgeIds.length !== badgeStatuses.length) {
    throw new AppError('Danh sach badge khong hop le', 400);
  }

  const defaults = await badgesRepository.selectBadgeDefaults(badgeIds, tenantId);
  const defaultMap = new Map(defaults.map((row) => [row.id, row]));
  const missingBadgeIds = badgeIds.filter((id) => !defaultMap.has(id));
  if (missingBadgeIds.length > 0) {
    throw new AppError(`Badge khong ton tai: ${missingBadgeIds.join(', ')}`, 400);
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');
    const tx = createBadgesRepository(client);

    for (const status of badgeStatuses) {
      if (typeof status.is_active !== 'boolean') {
        throw new AppError('Trang thai badge khong hop le', 400);
      }

      const defaults = defaultMap.get(status.badge_id)!;
      const shouldUpdateName = hasOwn(status, 'name') || hasOwn(status, 'title') || hasOwn(status, 'name_override');
      const shouldUpdateDescription = hasOwn(status, 'description') || hasOwn(status, 'desc') || hasOwn(status, 'description_override');
      const nameInput = hasOwn(status, 'name_override')
        ? status.name_override
        : hasOwn(status, 'title')
          ? status.title
          : status.name;
      const descriptionInput = hasOwn(status, 'description_override')
        ? status.description_override
        : hasOwn(status, 'desc')
          ? status.desc
          : status.description;

      await tx.upsertBadgeSetting({
        tenantId,
        badgeId: status.badge_id,
        isActive: status.is_active,
        ...(shouldUpdateName
          ? { nameOverride: normalizeBadgeTextOverride(nameInput, defaults.name, 'Ten badge', MAX_BADGE_NAME_LENGTH) }
          : {}),
        ...(shouldUpdateDescription
          ? {
            descriptionOverride: normalizeBadgeTextOverride(
              descriptionInput,
              defaults.description,
              'Mo ta badge',
              MAX_BADGE_DESCRIPTION_LENGTH,
            ),
          }
          : {}),
      });
    }

    if (auditEntry) await appendAuditLog(client, auditEntry);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await invalidateTenantBadgeCaches(tenantId);
}

const BADGE_IMAGE_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

function getBadgeImageExtension(mimetype: string): string {
  const ext = BADGE_IMAGE_EXTENSIONS[mimetype];
  if (!ext) {
    throw new Error(`Unsupported badge image type: ${mimetype}`);
  }
  return ext;
}

async function uploadTenantBadgeImage(
  tenantId: string,
  badgeId: string,
  file: { buffer: Buffer; mimetype: string },
  column: BadgeImageColumn,
  fileBaseName: string,
  auditEntry?: TransactionalAuditEntry,
) {
  await assertBadgeAccessibleToTenant(tenantId, badgeId);
  const ext = getBadgeImageExtension(file.mimetype);
  // A new immutable object key lets us preserve the currently visible image
  // until the DB update and its audit record have committed successfully.
  const fileName = `${fileBaseName}-${Date.now()}.${ext}`;
  const subFolder = `badges/${badgeId}`;
  const storagePath = buildStoragePath(tenantId, 'branding', fileName, subFolder);
  await uploadFile(storagePath, file.buffer, file.mimetype, true);

  const client = await getClient();
  let oldPath: string | null = null;
  try {
    await client.query('BEGIN');
    const tx = createBadgesRepository(client);
    await tx.ensureBadgeSettingRow(tenantId, badgeId);
    oldPath = await tx.lockBadgeImage(tenantId, badgeId, column);
    await tx.updateBadgeImage(tenantId, badgeId, column, storagePath);
    if (auditEntry) await appendAuditLog(client, auditEntry);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined); // fails only on a broken connection, which pg-pool discards
    await deleteFileByUrl(storagePath).catch(swallowAndLog('badges.image_cleanup'));
    throw error;
  } finally {
    client.release();
  }

  if (oldPath && oldPath !== storagePath) await deleteFileByUrl(oldPath).catch(swallowAndLog('badges.image_cleanup'));
  await invalidateTenantBadgeCaches(tenantId);

  return storagePath;
}

export async function uploadBadgeCardImage(
  tenantId: string,
  badgeId: string,
  file: { buffer: Buffer; mimetype: string; originalname: string },
  auditEntry?: TransactionalAuditEntry,
) {
  const storagePath = await uploadTenantBadgeImage(tenantId, badgeId, file, 'card_image_url', 'card', auditEntry);
  return { card_image_url: storagePath };
}

export async function uploadBadgeIconImage(
  tenantId: string,
  badgeId: string,
  file: { buffer: Buffer; mimetype: string; originalname: string },
  auditEntry?: TransactionalAuditEntry,
) {
  const storagePath = await uploadTenantBadgeImage(tenantId, badgeId, file, 'icon_image_url', 'icon', auditEntry);
  return { icon_image_url: storagePath };
}

export async function uploadBadgeMobileCardImage(
  tenantId: string,
  badgeId: string,
  file: { buffer: Buffer; mimetype: string; originalname: string },
  auditEntry?: TransactionalAuditEntry,
) {
  const storagePath = await uploadTenantBadgeImage(tenantId, badgeId, file, 'mobile_card_image_url', 'mobile-card', auditEntry);
  return { mobile_card_image_url: storagePath };
}
