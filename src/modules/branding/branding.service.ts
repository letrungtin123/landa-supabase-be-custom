// ═══════════════════════════════════════════════════════════════
// Branding Service — Business logic
// Lưu branding config trong tenants.settings JSONB
// Ảnh upload vào Supabase Storage: {tenantId}/branding/{key}.ext
// ═══════════════════════════════════════════════════════════════

import { query } from '../../config/database.js';
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
  const result = await query<{ id: string; name: string; domain_admin: string | null; settings: Record<string, unknown> }>(
    "SELECT id, name, domain_admin, settings FROM tenants WHERE (domain_learner = $1 OR domain_admin ILIKE '%' || $1 || '%') AND is_active = true",
    [domain],
  );

  if (result.rowCount === 0) return null;

  const tenant = result.rows[0];
  const branding: BrandingConfig = (tenant.settings as any)?.branding || {};

  return formatBrandingResponse(tenant.id, tenant.name, branding, tenant.domain_admin);
}

/**
 * Lấy branding theo tenant ID — PROTECTED (admin dashboard).
 */
export async function getBrandingByTenantId(tenantId: string): Promise<BrandingResponse> {
  const result = await query<{ id: string; name: string; settings: Record<string, unknown> }>(
    'SELECT id, name, settings FROM tenants WHERE id = $1',
    [tenantId],
  );

  if (result.rowCount === 0) throw new AppError('Tenant không tồn tại', 404);

  const tenant = result.rows[0];
  const branding: BrandingConfig = (tenant.settings as any)?.branding || {};

  return formatBrandingResponse(tenant.id, tenant.name, branding, null);
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
): Promise<{ storage_path: string }> {
  const branding = await readBrandingSettings(tenantId);

  const isCarousel = imageKey.startsWith('carousel_');
  const ext = originalName.substring(originalName.lastIndexOf('.')) || '.png';
  // Thêm timestamp để path luôn unique → tránh browser/CDN cache
  const ts = Date.now();
  const storagePath = `${tenantId}/branding/${imageKey}_${ts}${ext}`;

  // Xóa file cũ nếu là single image key
  if (!isCarousel && branding[imageKey]) {
    try { await deleteFile(branding[imageKey] as string); } catch { /* ignore */ }
  }

  // Upload file mới (upsert)
  await uploadFile(storagePath, fileBuffer, mimeType, true);

  // Cập nhật settings
  if (isCarousel) {
    const carousels = branding.carousels || [];
    // Tìm index từ key (carousel_1 → index 0)
    const idx = parseInt(imageKey.split('_')[1]) - 1;
    // Xóa file cũ tại vị trí này nếu có
    if (carousels[idx]) {
      try { await deleteFile(carousels[idx]); } catch { /* ignore */ }
    }
    carousels[idx] = storagePath;
    branding.carousels = carousels;
  } else {
    branding[imageKey] = storagePath;
  }

  await writeBrandingSettings(tenantId, branding);

  return {
    storage_path: storagePath,
  };
}

/**
 * Xóa ảnh branding.
 */
export async function deleteBrandingImage(tenantId: string, imageKey: string): Promise<void> {
  const branding = await readBrandingSettings(tenantId);

  const isCarousel = imageKey.startsWith('carousel_');

  if (isCarousel) {
    const carousels = branding.carousels || [];
    const idx = parseInt(imageKey.split('_')[1]) - 1;
    if (carousels[idx]) {
      try { await deleteFile(carousels[idx]); } catch { /* ignore */ }
      carousels.splice(idx, 1);
      branding.carousels = carousels;
    }
  } else {
    const path = branding[imageKey] as string | undefined;
    if (path) {
      try { await deleteFile(path); } catch { /* ignore */ }
      delete branding[imageKey];
    }
  }

  await writeBrandingSettings(tenantId, branding);
}

// ── Helpers ──

function formatBrandingResponse(
  tenantId: string,
  tenantName: string,
  branding: BrandingConfig,
  domainAdmin: string | null,
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
    images,
    carousels: carouselPaths,
    size_hints: { ...IMAGE_SIZE_HINTS },
  };
}
