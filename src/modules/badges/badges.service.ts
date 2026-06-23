import { query } from '../../config/database.js';
import { uploadFile, deleteFileByUrl, buildStoragePath } from '../../config/storage.js';

export async function getTenantBadgeSettings(tenantId: string) {
  const result = await query<any>(
    `SELECT b.id, b.name, b.description, b.image_key,
            tbs.card_image_url, tbs.icon_image_url,
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
  
  // Using multiple inserts or a transaction
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

// ── Badge Image Upload ──

/**
 * Upload badge card image (ảnh lớn, tỉ lệ 4:6.5) cho từng tenant.
 */
export async function uploadBadgeCardImage(
  tenantId: string,
  badgeId: string,
  file: { buffer: Buffer; mimetype: string; originalname: string },
) {
  // Ensure tenant setting exists
  await query(
    `INSERT INTO tenant_badge_settings (tenant_id, badge_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [tenantId, badgeId]
  );

  const badge = await query<any>('SELECT card_image_url FROM tenant_badge_settings WHERE tenant_id = $1 AND badge_id = $2', [tenantId, badgeId]);

  // Delete old image if exists
  const oldPath = badge.rows[0]?.card_image_url;
  if (oldPath) {
    await deleteFileByUrl(oldPath).catch(() => {});
  }

  const ext = file.originalname.split('.').pop()?.toLowerCase() || 'png';
  const fileName = `card.${ext}`;
  const subFolder = `badges/${badgeId}`;
  const storagePath = buildStoragePath(tenantId, 'branding', fileName, subFolder);

  await uploadFile(storagePath, file.buffer, file.mimetype, true);

  await query(
    'UPDATE tenant_badge_settings SET card_image_url = $1 WHERE tenant_id = $2 AND badge_id = $3', 
    [storagePath, tenantId, badgeId]
  );

  return { card_image_url: storagePath };
}

/**
 * Upload badge icon image (ảnh nhỏ, square) cho từng tenant.
 */
export async function uploadBadgeIconImage(
  tenantId: string,
  badgeId: string,
  file: { buffer: Buffer; mimetype: string; originalname: string },
) {
  // Ensure tenant setting exists
  await query(
    `INSERT INTO tenant_badge_settings (tenant_id, badge_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [tenantId, badgeId]
  );

  const badge = await query<any>('SELECT icon_image_url FROM tenant_badge_settings WHERE tenant_id = $1 AND badge_id = $2', [tenantId, badgeId]);

  const oldPath = badge.rows[0]?.icon_image_url;
  if (oldPath) {
    await deleteFileByUrl(oldPath).catch(() => {});
  }

  const ext = file.originalname.split('.').pop()?.toLowerCase() || 'png';
  const fileName = `icon.${ext}`;
  const subFolder = `badges/${badgeId}`;
  const storagePath = buildStoragePath(tenantId, 'branding', fileName, subFolder);

  await uploadFile(storagePath, file.buffer, file.mimetype, true);

  await query(
    'UPDATE tenant_badge_settings SET icon_image_url = $1 WHERE tenant_id = $2 AND badge_id = $3', 
    [storagePath, tenantId, badgeId]
  );

  return { icon_image_url: storagePath };
}
