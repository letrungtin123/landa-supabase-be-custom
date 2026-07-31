import { getClient, query } from '../../config/database.js';
import { cacheJson, getCacheVersion } from '../../config/cache.js';
import { CACHE_TTL, cacheKeys, cacheVersions } from '../../config/cache-keys.js';
import { invalidateTenantBadgeCaches } from '../../config/cache-invalidation.js';
import { uploadFile, deleteFileByUrl, buildStoragePath } from '../../config/storage.js';
import { AppError } from '../../middleware/error-handler.js';

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

type BadgeDefaults = {
  id: string;
  name: string;
  description: string | null;
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

export async function getTenantBadgeSettings(tenantId: string) {
  const version = await getCacheVersion(...cacheVersions.tenantBadges(tenantId));
  return cacheJson(
    cacheKeys.tenantResource(tenantId, 'badge-settings', version),
    CACHE_TTL.badges,
    () => getTenantBadgeSettingsFromDb(tenantId),
  );
}

async function getTenantBadgeSettingsFromDb(tenantId: string) {
  const result = await query<any>(
    `SELECT b.id,
            COALESCE(NULLIF(BTRIM(tbs.name_override), ''), b.name) AS name,
            COALESCE(NULLIF(BTRIM(tbs.name_override), ''), b.name) AS title,
            COALESCE(NULLIF(BTRIM(tbs.description_override), ''), b.description) AS description,
            COALESCE(NULLIF(BTRIM(tbs.description_override), ''), b.description) AS desc,
            b.name AS default_name,
            b.description AS default_description,
            tbs.name_override,
            tbs.description_override,
            b.image_key,
            tbs.card_image_url, tbs.icon_image_url, tbs.mobile_card_image_url,
            COALESCE(tbs.is_active, true) AS is_active
     FROM badge_definitions b
     LEFT JOIN tenant_badge_settings tbs ON tbs.badge_id = b.id AND tbs.tenant_id = $1
     ORDER BY b.sort_order, b.id`,
    [tenantId]
  );
  return result.rows;
}

export async function updateTenantBadgeSetting(tenantId: string, badgeId: string, isActive: boolean) {
  await query(
    `INSERT INTO tenant_badge_settings (tenant_id, badge_id, is_active)
     VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, badge_id)
     DO UPDATE SET is_active = $3, updated_at = now()`,
    [tenantId, badgeId, isActive]
  );
  await invalidateTenantBadgeCaches(tenantId);
}

export async function updateAllTenantBadgeSettings(tenantId: string, badgeStatuses: TenantBadgeStatusUpdate[]) {
  if (badgeStatuses.length === 0) return;

  const badgeIds = [...new Set(badgeStatuses.map((status) => status.badge_id).filter(Boolean))];
  if (badgeIds.length !== badgeStatuses.length) {
    throw new AppError('Danh sach badge khong hop le', 400);
  }

  const defaultsResult = await query<BadgeDefaults>(
    `SELECT id, name, description FROM badge_definitions WHERE id = ANY($1::varchar[])`,
    [badgeIds],
  );
  const defaultMap = new Map(defaultsResult.rows.map((row) => [row.id, row]));
  const missingBadgeIds = badgeIds.filter((id) => !defaultMap.has(id));
  if (missingBadgeIds.length > 0) {
    throw new AppError(`Badge khong ton tai: ${missingBadgeIds.join(', ')}`, 400);
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');

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

      const columns = ['tenant_id', 'badge_id', 'is_active'];
      const placeholders = ['$1', '$2', '$3'];
      const params: unknown[] = [tenantId, status.badge_id, status.is_active];
      const updateSets = ['is_active = EXCLUDED.is_active'];

      if (shouldUpdateName) {
        params.push(normalizeBadgeTextOverride(nameInput, defaults.name, 'Ten badge', MAX_BADGE_NAME_LENGTH));
        columns.push('name_override');
        placeholders.push(`$${params.length}`);
        updateSets.push('name_override = EXCLUDED.name_override');
      }

      if (shouldUpdateDescription) {
        params.push(normalizeBadgeTextOverride(descriptionInput, defaults.description, 'Mo ta badge', MAX_BADGE_DESCRIPTION_LENGTH));
        columns.push('description_override');
        placeholders.push(`$${params.length}`);
        updateSets.push('description_override = EXCLUDED.description_override');
      }

      await client.query(
        `INSERT INTO tenant_badge_settings (${columns.join(', ')})
         VALUES (${placeholders.join(', ')})
         ON CONFLICT (tenant_id, badge_id)
         DO UPDATE SET ${updateSets.join(', ')}, updated_at = now()`,
        params,
      );
    }

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

type BadgeImageColumn = 'card_image_url' | 'icon_image_url' | 'mobile_card_image_url';

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
) {
  await query(
    `INSERT INTO tenant_badge_settings (tenant_id, badge_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [tenantId, badgeId]
  );

  const badge = await query<any>(
    `SELECT ${column} AS image_url FROM tenant_badge_settings WHERE tenant_id = $1 AND badge_id = $2`,
    [tenantId, badgeId]
  );

  const oldPath = badge.rows[0]?.image_url;
  if (oldPath) {
    await deleteFileByUrl(oldPath).catch(() => {});
  }

  const ext = getBadgeImageExtension(file.mimetype);
  const fileName = `${fileBaseName}.${ext}`;
  const subFolder = `badges/${badgeId}`;
  const storagePath = buildStoragePath(tenantId, 'branding', fileName, subFolder);

  await uploadFile(storagePath, file.buffer, file.mimetype, true);

  await query(
    `UPDATE tenant_badge_settings SET ${column} = $1, updated_at = now() WHERE tenant_id = $2 AND badge_id = $3`,
    [storagePath, tenantId, badgeId]
  );
  await invalidateTenantBadgeCaches(tenantId);

  return storagePath;
}

export async function uploadBadgeCardImage(
  tenantId: string,
  badgeId: string,
  file: { buffer: Buffer; mimetype: string; originalname: string },
) {
  const storagePath = await uploadTenantBadgeImage(tenantId, badgeId, file, 'card_image_url', 'card');
  return { card_image_url: storagePath };
}

export async function uploadBadgeIconImage(
  tenantId: string,
  badgeId: string,
  file: { buffer: Buffer; mimetype: string; originalname: string },
) {
  const storagePath = await uploadTenantBadgeImage(tenantId, badgeId, file, 'icon_image_url', 'icon');
  return { icon_image_url: storagePath };
}

export async function uploadBadgeMobileCardImage(
  tenantId: string,
  badgeId: string,
  file: { buffer: Buffer; mimetype: string; originalname: string },
) {
  const storagePath = await uploadTenantBadgeImage(tenantId, badgeId, file, 'mobile_card_image_url', 'mobile-card');
  return { mobile_card_image_url: storagePath };
}
