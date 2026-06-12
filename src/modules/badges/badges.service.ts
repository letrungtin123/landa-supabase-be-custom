import { query } from '../../config/database.js';

export async function getTenantBadgeSettings(tenantId: string) {
  const result = await query<any>(
    `SELECT b.id, b.name, b.description, b.image_key, 
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
