import { query } from '../../config/database.js';
import { uploadFile, deleteFileByUrl, buildStoragePath } from '../../config/storage.js';

export async function getTenantBadgeSettings(tenantId: string) {
  const result = await query<any>(
    `SELECT b.id, b.name, b.description, b.image_key,
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
}

export async function updateAllTenantBadgeSettings(tenantId: string, badgeStatuses: { badge_id: string; is_active: boolean }[]) {
  if (badgeStatuses.length === 0) return;

  const values = badgeStatuses.map((_, i) => `($1, $${i * 2 + 2}, $${i * 2 + 3})`).join(', ');
  const params: unknown[] = [tenantId];
  for (const status of badgeStatuses) {
    params.push(status.badge_id, status.is_active);
  }

  await query(
    `INSERT INTO tenant_badge_settings (tenant_id, badge_id, is_active)
     VALUES ${values}
     ON CONFLICT (tenant_id, badge_id)
     DO UPDATE SET is_active = EXCLUDED.is_active, updated_at = now()`,
    params
  );
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
