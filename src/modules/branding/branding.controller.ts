// ═══════════════════════════════════════════════════════════════
// Branding Controller — Express request handlers
// ═══════════════════════════════════════════════════════════════

import type { Request, Response, NextFunction } from 'express';
import { createTransactionalAuditEntry } from '../../middleware/audit-log.js';
import * as brandingService from './branding.service.js';
import { uploadBrandingSchema, ACCEPTED_MIME_TYPES, MAX_FILE_SIZE } from './branding.validator.js';
import { sendSuccess, sendError } from '../../utils/response.js';

/**
 * GET /api/branding/by-domain/:domain — PUBLIC (no auth)
 * FE 5173 gọi trước khi user login để lấy branding images.
 */
export async function getByDomainController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { domain } = req.params;
    if (!domain) { sendError(res, 'Domain không được để trống', 400); return; }

    const result = await brandingService.getBrandingByDomain(domain);
    if (!result) {
      // Domain không match → trả empty branding (FE sẽ dùng fallback)
      sendSuccess(res, { tenant_id: null, tenant_name: null, images: {}, carousels: [], size_hints: {} });
      return;
    }

    sendSuccess(res, result);
  } catch (err) { next(err); }
}

/**
 * GET /api/branding — PROTECTED (admin)
 * Lấy branding cho tenant đang active (từ X-Tenant-Id header).
 */
export async function getByTenantController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) { sendError(res, 'Không xác định được tenant', 400); return; }

    const result = await brandingService.getBrandingByTenantId(tenantId);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

/**
 * POST /api/branding/upload — PROTECTED (admin)
 * Upload ảnh branding cho tenant. Multipart form data.
 * Body: image_key (string), file (multipart)
 */
export async function uploadController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) { sendError(res, 'Không xác định được tenant', 400); return; }

    // Validate image_key
    const parsed = uploadBrandingSchema.safeParse({ image_key: req.body.image_key });
    if (!parsed.success) {
      sendError(res, parsed.error.errors[0].message, 400);
      return;
    }

    // Validate file
    const file = req.file;
    if (!file) { sendError(res, 'Chưa chọn file', 400); return; }
    if (file.size > MAX_FILE_SIZE) {
      sendError(res, `File quá lớn. Tối đa ${MAX_FILE_SIZE / 1024 / 1024}MB`, 400);
      return;
    }
    if (!ACCEPTED_MIME_TYPES.includes(file.mimetype)) {
      sendError(res, `Định dạng file không hỗ trợ. Chấp nhận: ${ACCEPTED_MIME_TYPES.join(', ')}`, 400);
      return;
    }

    const result = await brandingService.uploadBrandingImage(
      tenantId, parsed.data.image_key, file.buffer, file.originalname, file.mimetype,
      createTransactionalAuditEntry(
        req, 'UPDATE', 'branding_image',
        { code: 'branding.image.updated', context: { related_entity_name: parsed.data.image_key, related_entity_type: 'branding_image' } }, tenantId, parsed.data.image_key,
      ),
    );
    sendSuccess(res, result, 'Upload thành công');
  } catch (err) { next(err); }
}

/**
 * DELETE /api/branding/:imageKey — PROTECTED (admin)
 * Xóa ảnh branding cho tenant.
 */
export async function deleteController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) { sendError(res, 'Không xác định được tenant', 400); return; }

    const { imageKey } = req.params;
    if (!imageKey) { sendError(res, 'imageKey không được để trống', 400); return; }

    await brandingService.deleteBrandingImage(
      tenantId, imageKey,
      createTransactionalAuditEntry(
        req, 'DELETE', 'branding_image',
        { code: 'branding.image.deleted', context: { related_entity_name: imageKey, related_entity_type: 'branding_image' } }, tenantId, imageKey,
      ),
    );
    sendSuccess(res, null, 'Xóa thành công');
  } catch (err) { next(err); }
}


