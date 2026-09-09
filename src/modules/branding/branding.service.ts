// ═══════════════════════════════════════════════════════════════
// Branding Service — Business logic
// Lưu branding config trong tenants.settings JSONB
// Ảnh upload vào Supabase Storage: {tenantId}/branding/{key}.ext
// ═══════════════════════════════════════════════════════════════

import { getClient, query } from '../../config/database.js';
import { appendAuditLog, type TransactionalAuditEntry } from '../../middleware/audit-log.js';
import { cacheJson, bumpCacheVersion, getCacheVersion } from '../../config/cache.js';
import { CACHE_TTL, cacheKeys, cacheVersions, normalizeCacheDomain } from '../../config/cache-keys.js';
import { invalidateTenantPublicDomainCaches } from '../../config/cache-invalidation.js';
import { uploadFile, deleteFile, buildFileName } from '../../config/storage.js';
import { AppError } from '../../middleware/error-handler.js';
import { SINGLE_IMAGE_KEYS, IMAGE_SIZE_HINTS, MAX_CAROUSEL } from './branding.validator.js';

// ── Types ──

export interface BrandingConfig {
  [key: string]: string | string[] | undefined;
  left_panel_bg?: string;
  register_bg?: string;
  white_logo?: string;
  square_icon?: string;
  header_logo?: string;
  header_logo_dark?: string;
  person_1?: string;
  person_2?: string;
  person_3?: string;
  person_4?: string;
  carousels?: string[];
}

interface BrandingResponse {
  tenant_id: string;
  tenant_name: string;
  domain_admin: string | null;
  domain_learner: string | null;
  images: Record<string, string | null>;
  carousels: string[];
  size_hints: Record<string, string>;
}

// ── Helpers ──

/** Đọc branding config từ tenants.settings */
async function readBrandingSettings(tenantId: string): Promise<BrandingConfig> {
  const result = await query<{ settings: Record<string, unknown> }>(
    'SELECT settings FROM tenants WHERE id = $1',
    [tenantId],
  );
  if (result.rowCount === 0) throw new AppError('Tenant không tồn tại', 404);
  const settings = result.rows[0].settings || {};
  return (settings as any).branding || {};
}

/** Ghi branding config vào tenants.settings.branding */
async function writeBrandingSettings(tenantId: string, branding: BrandingConfig): Promise<void> {
  // Sử dụng jsonb_set để chỉ cập nhật key 'branding' trong settings
  await query(
    `UPDATE tenants SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{branding}', $1::jsonb) WHERE id = $2`,
    [JSON.stringify(branding), tenantId],
  );
}

// ── Public API ──

/**
 * Lấy branding theo domain — PUBLIC (không cần auth).
 * FE 5173 gọi trước khi user login.
 */
export async function getBrandingByDomain(domain: string): Promise<BrandingResponse | null> {
  const normalizedDomain = normalizeCacheDomain(domain);
  const version = await getCacheVersion(...cacheVersions.publicDomain(normalizedDomain, 'branding'));
  return cacheJson(
    cacheKeys.publicDomain(normalizedDomain, 'branding', version),
    CACHE_TTL.publicConfig,
    async () => {
      const result = await query<{ id: string; name: string; domain_admin: string | null; domain_learner: string | null; settings: Record<string, unknown> }>(
        `SELECT id, name, domain_admin, domain_learner, settings FROM tenants
         WHERE (
           regexp_replace(regexp_replace(domain_learner, '^https?://', ''), ':[0-9]+$', '') = $1
           OR regexp_replace(regexp_replace(domain_admin, '^https?://', ''), ':[0-9]+$', '') = $1
         ) AND is_active = true`,
        [normalizedDomain],
      );

      if (result.rowCount === 0) return null;

      const tenant = result.rows[0];
      const branding: BrandingConfig = (tenant.settings as any)?.branding || {};

      return formatBrandingResponse(tenant.id, tenant.name, branding, tenant.domain_admin, tenant.domain_learner);
    },
  );
}

/**
 * Lấy branding theo tenant ID — PROTECTED (admin dashboard).
 */
export async function getBrandingByTenantId(tenantId: string): Promise<BrandingResponse> {
  const version = await getCacheVersion(...cacheVersions.tenantResource(tenantId, 'branding'));
  return cacheJson(
    cacheKeys.tenantResource(tenantId, 'branding', version),
    CACHE_TTL.publicConfig,
    () => getBrandingByTenantIdFromDb(tenantId),
  );
}

async function getBrandingByTenantIdFromDb(tenantId: string): Promise<BrandingResponse> {
  const result = await query<{ id: string; name: string; domain_admin: string | null; domain_learner: string | null; settings: Record<string, unknown> }>(
    'SELECT id, name, domain_admin, domain_learner, settings FROM tenants WHERE id = $1',
    [tenantId],
  );

  if (result.rowCount === 0) throw new AppError('Tenant không tồn tại', 404);

  const tenant = result.rows[0];
  const branding: BrandingConfig = (tenant.settings as any)?.branding || {};

  return formatBrandingResponse(tenant.id, tenant.name, branding, tenant.domain_admin, tenant.domain_learner);
}

/**
 * Upload ảnh branding.
 * - Single image keys: overwrite (upsert)
 * - Carousel: append tới list, tối đa MAX_CAROUSEL
 */
export async function uploadBrandingImage(
  tenantId: string,
  imageKey: string,
  fileBuffer: Buffer,
  originalName: string,
  mimeType: string,
  auditEntry?: TransactionalAuditEntry,
): Promise<{ storage_path: string }> {
  const isCarousel = imageKey.startsWith('carousel_');
  const ext = originalName.substring(originalName.lastIndexOf('.')) || '.png';
  // Thêm timestamp để path luôn unique → tránh browser/CDN cache
  const ts = Date.now();
  const storagePath = `${tenantId}/branding/${imageKey}_${ts}${ext}`;

  // Upload first. The new object is deleted again if the DB/audit transaction
  // cannot commit, while the existing public image remains untouched.
  await uploadFile(storagePath, fileBuffer, mimeType, true);
  const client = await getClient();
  let pathsToDelete: string[] = [];
  try {
    await client.query('BEGIN');
    const tenant = await client.query<{ settings: Record<string, unknown> }>(
      'SELECT settings FROM tenants WHERE id = $1 FOR UPDATE',
      [tenantId],
    );
    if (tenant.rowCount === 0) throw new AppError('Tenant không tồn tại', 404);
    const branding = ((tenant.rows[0].settings || {}) as { branding?: BrandingConfig }).branding || {};

    if (isCarousel) {
      const carousels = [...(branding.carousels || [])];
      const idx = parseInt(imageKey.split('_')[1]) - 1;
      if (carousels[idx]) pathsToDelete.push(carousels[idx]);
      carousels[idx] = storagePath;
      branding.carousels = carousels;
    } else {
      const oldPath = branding[imageKey];
      if (typeof oldPath === 'string' && oldPath) pathsToDelete.push(oldPath);
      branding[imageKey] = storagePath;
    }

    await client.query(
      `UPDATE tenants
       SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{branding}', $1::jsonb), updated_at = now()
       WHERE id = $2`,
      [JSON.stringify(branding), tenantId],
    );
    if (auditEntry) await appendAuditLog(client, auditEntry);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    await deleteFile(storagePath).catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  await Promise.allSettled(pathsToDelete.filter((path) => path !== storagePath).map((path) => deleteFile(path)));
  await Promise.all([
    bumpCacheVersion(...cacheVersions.tenantResource(tenantId, 'branding')),
    invalidateTenantPublicDomainCaches(tenantId, ['branding']),
  ]);

  return {
    storage_path: storagePath,
  };
}

/**
 * Xóa ảnh branding.
 */
export async function deleteBrandingImage(
  tenantId: string,
  imageKey: string,
  auditEntry?: TransactionalAuditEntry,
): Promise<void> {
  const isCarousel = imageKey.startsWith('carousel_');
  const client = await getClient();
  let pathsToDelete: string[] = [];
  try {
    await client.query('BEGIN');
    const tenant = await client.query<{ settings: Record<string, unknown> }>(
      'SELECT settings FROM tenants WHERE id = $1 FOR UPDATE',
      [tenantId],
    );
    if (tenant.rowCount === 0) throw new AppError('Tenant không tồn tại', 404);
    const branding = ((tenant.rows[0].settings || {}) as { branding?: BrandingConfig }).branding || {};

    if (isCarousel) {
      const carousels = [...(branding.carousels || [])];
      const idx = parseInt(imageKey.split('_')[1]) - 1;
      if (carousels[idx]) pathsToDelete.push(carousels[idx]);
      carousels.splice(idx, 1);
      branding.carousels = carousels;
    } else {
      const path = branding[imageKey];
      if (typeof path === 'string' && path) pathsToDelete.push(path);
      delete branding[imageKey];
    }

    await client.query(
      `UPDATE tenants
       SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{branding}', $1::jsonb), updated_at = now()
       WHERE id = $2`,
      [JSON.stringify(branding), tenantId],
    );
    if (auditEntry) await appendAuditLog(client, auditEntry);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  await Promise.allSettled(pathsToDelete.map((path) => deleteFile(path)));
  await Promise.all([
    bumpCacheVersion(...cacheVersions.tenantResource(tenantId, 'branding')),
    invalidateTenantPublicDomainCaches(tenantId, ['branding']),
  ]);
}

// ── Helpers ──

function formatBrandingResponse(
  tenantId: string,
  tenantName: string,
  branding: BrandingConfig,
  domainAdmin: string | null,
  domainLearner: string | null = null,
): BrandingResponse {
  const images: Record<string, string | null> = {};

  for (const key of SINGLE_IMAGE_KEYS) {
    const path = branding[key] as string | undefined;
    // Trả về raw storage path — FE dùng storageUrl() để build proxy URL
    images[key] = path || null;
  }

  const carouselPaths = (branding.carousels || []).filter(Boolean);

  return {
    tenant_id: tenantId,
    tenant_name: tenantName,
    domain_admin: domainAdmin,
    domain_learner: domainLearner,
    images,
    carousels: carouselPaths,
    size_hints: { ...IMAGE_SIZE_HINTS },
  };
}
