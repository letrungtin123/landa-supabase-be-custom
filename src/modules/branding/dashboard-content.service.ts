// ═══════════════════════════════════════════════════════════════
// Dashboard Content Service — Business logic
// Lưu dashboard content (hero card + tips) trong tenants.settings JSONB
// Key: tenants.settings.dashboard_content
// ═══════════════════════════════════════════════════════════════

import { query } from '../../config/database.js';
import { cacheJson, bumpCacheVersion, getCacheVersion } from '../../config/cache.js';
import { CACHE_TTL, cacheKeys, cacheVersions, normalizeCacheDomain } from '../../config/cache-keys.js';
import { invalidateTenantPublicDomainCaches } from '../../config/cache-invalidation.js';
import { AppError } from '../../utils/errors.js';
import type { DashboardContentData, UpsertDashboardContentInput } from './dashboard-content.validator.js';
import { createBrandingRepository, type BrandingDb } from './branding.repository.js';

const brandingRepository = createBrandingRepository({ query } satisfies BrandingDb);

// ── Types ──

interface DashboardContentResponse {
  tenant_id: string;
  hero_badge: string | null;
  hero_title: string | null;
  tips: Array<{ title: string; desc: string }> | null;
  explore_hero_badge: string | null;
  explore_hero_title: string | null;
}

// ── Helpers ──

/** Đọc dashboard_content từ tenants.settings */
async function readDashboardContent(tenantId: string): Promise<DashboardContentData | null> {
  const result = await brandingRepository.selectSettings(tenantId);
  if (result.rowCount === 0) throw new AppError('Tenant không tồn tại', 404);
  const settings = result.rows[0].settings || {};
  return (settings as any).dashboard_content || null;
}

/** Ghi dashboard_content vào tenants.settings */
async function writeDashboardContent(tenantId: string, data: DashboardContentData): Promise<void> {
  await brandingRepository.writeDashboardContent(tenantId, JSON.stringify(data));
}

// ── Public API ──

/**
 * Lấy dashboard content theo tenant ID — PROTECTED (admin dashboard).
 */
export async function getDashboardContentByTenantId(tenantId: string): Promise<DashboardContentResponse> {
  const version = await getCacheVersion(...cacheVersions.tenantResource(tenantId, 'dashboard-content'));
  return cacheJson(
    cacheKeys.tenantResource(tenantId, 'dashboard-content', version),
    CACHE_TTL.publicConfig,
    () => getDashboardContentByTenantIdFromDb(tenantId),
  );
}

async function getDashboardContentByTenantIdFromDb(tenantId: string): Promise<DashboardContentResponse> {
  const content = await readDashboardContent(tenantId);

  return {
    tenant_id: tenantId,
    hero_badge: content?.hero_badge || null,
    hero_title: content?.hero_title || null,
    tips: content?.tips || null,
    explore_hero_badge: content?.explore_hero_badge || null,
    explore_hero_title: content?.explore_hero_title || null,
  };
}

/**
 * Lấy dashboard content theo domain — PUBLIC (FE 5173).
 * Trả về null nếu domain không match hoặc chưa có content.
 */
export async function getDashboardContentByDomain(domain: string): Promise<DashboardContentResponse | null> {
  const normalizedDomain = normalizeCacheDomain(domain);
  const version = await getCacheVersion(...cacheVersions.publicDomain(normalizedDomain, 'dashboard-content'));
  return cacheJson(
    cacheKeys.publicDomain(normalizedDomain, 'dashboard-content', version),
    CACHE_TTL.publicConfig,
    async () => {
      const result = await brandingRepository.selectSettingsByDomain(normalizedDomain);

      if (result.rowCount === 0) return null;

      const tenant = result.rows[0];
      const content: DashboardContentData | null = (tenant.settings as any)?.dashboard_content || null;

      return {
        tenant_id: tenant.id,
        hero_badge: content?.hero_badge || null,
        hero_title: content?.hero_title || null,
        tips: content?.tips || null,
        explore_hero_badge: content?.explore_hero_badge || null,
        explore_hero_title: content?.explore_hero_title || null,
      };
    },
  );
}

/**
 * Cập nhật dashboard content cho tenant.
 */
export async function upsertDashboardContent(
  tenantId: string,
  input: UpsertDashboardContentInput,
): Promise<DashboardContentResponse> {
  // Verify tenant exists
  if (!await brandingRepository.tenantExists(tenantId)) throw new AppError('Tenant không tồn tại', 404);

  const data: DashboardContentData = {
    hero_badge: input.hero_badge || null,
    hero_title: input.hero_title || null,
    tips: input.tips || null,
    explore_hero_badge: input.explore_hero_badge || null,
    explore_hero_title: input.explore_hero_title || null,
  };

  await writeDashboardContent(tenantId, data);
  await Promise.all([
    bumpCacheVersion(...cacheVersions.tenantResource(tenantId, 'dashboard-content')),
    invalidateTenantPublicDomainCaches(tenantId, ['dashboard-content']),
  ]);

  return {
    tenant_id: tenantId,
    ...data,
  };
}
